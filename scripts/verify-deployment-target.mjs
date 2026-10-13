#!/usr/bin/env node
/**
 * Deployment target guard for Archava Monad.
 * 
 * Validates that operations targeting external services (push, deploy, broadcast, runtime)
 * are directed to the correct Monad deployment, not the legacy BNB production deployment.
 * 
 * Usage:
 *   node scripts/verify-deployment-target.mjs [mode]
 * 
 * Modes:
 *   local     - Basic validation for local development (default)
 *   push      - Validates Git remote before push operations
 *   deploy    - Validates both hosting targets and actual linkage before deployment
 *   vercel    - Validates Vercel hosting target and actual .vercel linkage
 *   railway   - Validates Railway hosting target and actual Railway context
 *   runtime   - Validates runtime configuration before starting services
 *   contracts - Validates contract deployment targets and foundry configuration
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

export const MONAD_CHAIN_ID = 10143;
export const BNB_CHAIN_ID = 97;
export const KNOWN_BNB_PROJECT_IDS = new Set(["prj_archava_bnb", "archava-onchain"]);
export const KNOWN_BNB_SERVICES = new Set(["archava-production", "archava-backend"]);

export class DeploymentGuardError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DeploymentGuardError";
    this.details = details;
  }
}

/**
 * Mask sensitive credentials, auth tokens, or API keys in an RPC URL for safe logging/errors.
 */
export function maskRpcUrl(url) {
  if (!url || typeof url !== "string") return "";
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    if (parsed.username) parsed.username = "***";

    const secretParamNames = ["key", "apikey", "api_key", "token", "auth", "secret", "appid", "app_id"];
    for (const [k, v] of parsed.searchParams.entries()) {
      if (secretParamNames.includes(k.toLowerCase()) || v.length >= 16) {
        parsed.searchParams.set(k, "***");
      }
    }

    const pathParts = parsed.pathname.split("/");
    const maskedParts = pathParts.map(part => {
      if (part.length >= 24 && !["monadTestnet", "monad-testnet"].includes(part)) {
        return "***";
      }
      return part;
    });
    parsed.pathname = maskedParts.join("/");
    return parsed.toString();
  } catch {
    return url.replace(/([?&][a-zA-Z0-9_-]+=)[^&]+/g, "$1***");
  }
}

/**
 * Check if a URL or text references BNB/BSC RPC endpoints.
 * Explicitly allows Monad endpoints with API keys containing '97'.
 */
export function isBnbRpc(url) {
  if (!url || typeof url !== "string") return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    const lower = url.toLowerCase();
    return (
      lower.includes("binance") ||
      lower.includes("bsc") ||
      lower.includes("bscscan") ||
      lower.includes("bnbchain") ||
      lower.includes("data-seed-prebsc")
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();

  // If host explicitly belongs to Monad, it is not BNB/BSC even if key contains '97'
  if (hostname.endsWith("monad.xyz") || hostname.includes("monad")) {
    return false;
  }

  // Check BNB/BSC domains or hostnames
  if (
    hostname.includes("binance.org") ||
    hostname.includes("bscscan.com") ||
    hostname.includes("bsc.nodereal.io") ||
    hostname.includes("bnbchain.org") ||
    hostname.includes("data-seed-prebsc") ||
    hostname.includes("bsc-dataseed") ||
    hostname === "bsc-testnet.public.blastapi.io" ||
    hostname.includes("bsc") ||
    hostname.startsWith("bnb.") ||
    hostname.includes(".bnb.")
  ) {
    return true;
  }

  // Check explicit BNB/BSC path segments or substring in pathname
  if (
    pathname.includes("/bsc") ||
    pathname.includes("bsc_") ||
    pathname.includes("bsc-") ||
    pathname.includes("/binance") ||
    pathname.includes("/bnb")
  ) {
    return true;
  }

  const pathSegments = pathname.split("/").filter(Boolean);
  if (pathSegments.some(seg => seg === "bsc" || seg.startsWith("bsc_") || seg.startsWith("bsc-"))) {
    return true;
  }

  // Check explicit chain ID 97 (not an arbitrary key containing '97')
  if (pathSegments.includes("97")) {
    return true;
  }
  const chainParam = parsed.searchParams.get("chain") || 
                     parsed.searchParams.get("chainId") || 
                     parsed.searchParams.get("chain_id");
  if (chainParam === "97") {
    return true;
  }

  return false;
}

/**
 * Validate that an RPC URL is defined, non-empty, and does not point to BNB/BSC.
 */
export function validateRpcUrl(url, source = "RPC endpoint") {
  if (!url || typeof url !== "string" || !url.trim()) {
    throw new DeploymentGuardError(`${source} is missing or empty`);
  }
  if (isBnbRpc(url)) {
    const masked = maskRpcUrl(url);
    throw new DeploymentGuardError(
      `${source} points to BNB/BSC RPC endpoint ("${masked}"). Monad deployment must use Monad RPC.`
    );
  }
  return true;
}

/**
 * Extract array of RPC URLs from network configuration object.
 */
export function getNetworkRpcUrls(network) {
  if (!network || typeof network !== "object") return [];
  const urls = [];
  if (network.rpcUrls && typeof network.rpcUrls === "object") {
    if (Array.isArray(network.rpcUrls.default?.http)) {
      urls.push(...network.rpcUrls.default.http);
    }
    if (Array.isArray(network.rpcUrls.public?.http)) {
      urls.push(...network.rpcUrls.public.http);
    }
  }
  if (typeof network.rpcUrl === "string" && network.rpcUrl.trim()) {
    urls.push(network.rpcUrl.trim());
  }
  return [...new Set(urls.filter(Boolean))];
}

/**
 * Determine single operational RPC URL explicitly from configuration and environment.
 */
export function resolveOperationalRpc(targetConfig, networkConfig, options = {}) {
  const env = options.env || process.env;
  let candidate = options.rpcUrl || env.MONAD_TESTNET_RPC_URL || env.RPC_URL || env.MONAD_RPC_URL;

  if (!candidate) {
    const activeKey = networkConfig?.active || "monadTestnet";
    const activeNetwork = networkConfig?.networks?.[activeKey];
    const networkUrls = getNetworkRpcUrls(activeNetwork);
    if (networkUrls.length > 0) {
      candidate = networkUrls[0];
    }
  }

  if (!candidate) {
    candidate = targetConfig?.network?.rpc?.public;
  }

  if (!candidate || typeof candidate !== "string" || !candidate.trim()) {
    throw new DeploymentGuardError("No Monad Testnet RPC URL configured or provided");
  }

  validateRpcUrl(candidate, "Operational RPC endpoint");
  return candidate.trim();
}

/**
 * Verify online RPC chain ID via JSON-RPC eth_chainId.
 * Completely eliminates shell interpolation: uses native fetch with timeout.
 * Validates strict response and masks sensitive URL parameters in logs/errors.
 */
export async function verifyRpcChainId(rpcUrl, options = {}) {
  if (!rpcUrl || typeof rpcUrl !== "string" || !rpcUrl.trim()) {
    throw new DeploymentGuardError("Cannot verify RPC chain ID: RPC URL is missing or empty");
  }
  validateRpcUrl(rpcUrl, "RPC endpoint");
  const masked = maskRpcUrl(rpcUrl);

  // Hermetic testing override
  if (options.rpcChainId !== undefined) {
    const chainId = Number(options.rpcChainId);
    if (chainId !== MONAD_CHAIN_ID) {
      throw new DeploymentGuardError(
        `RPC endpoint (${masked}) returned chain ID ${chainId}, expected Monad Testnet (${MONAD_CHAIN_ID})`
      );
    }
    return chainId;
  }

  const timeoutMs = options.timeoutMs || 5000;
  const fetchFn = options.fetch || globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new DeploymentGuardError("fetch API is not available to verify RPC chain ID");
  }

  let response;
  try {
    response = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    const msg = err.name === "TimeoutError" || err.message?.includes("aborted")
      ? `RPC connection timed out after ${timeoutMs}ms`
      : `Network error connecting to RPC (${masked}): ${err.message}`;
    throw new DeploymentGuardError(msg, { rpcUrl: masked });
  }

  if (!response.ok) {
    throw new DeploymentGuardError(
      `RPC endpoint (${masked}) responded with HTTP ${response.status}: ${response.statusText}`,
      { status: response.status, rpcUrl: masked }
    );
  }

  let json;
  try {
    json = await response.json();
  } catch (err) {
    throw new DeploymentGuardError(
      `RPC endpoint (${masked}) returned invalid JSON: ${err.message}`,
      { rpcUrl: masked }
    );
  }

  if (!json || typeof json !== "object") {
    throw new DeploymentGuardError(
      `RPC endpoint (${masked}) returned malformed JSON-RPC response (not an object)`,
      { rpcUrl: masked }
    );
  }

  if (json.error) {
    const errMessage = json.error.message || JSON.stringify(json.error);
    throw new DeploymentGuardError(
      `RPC endpoint (${masked}) returned JSON-RPC error: ${errMessage}`,
      { rpcUrl: masked, rpcError: json.error }
    );
  }

  if (typeof json.result !== "string" || !json.result.startsWith("0x")) {
    throw new DeploymentGuardError(
      `RPC endpoint (${masked}) returned malformed result for eth_chainId: ${JSON.stringify(json.result)}`,
      { rpcUrl: masked, result: json.result }
    );
  }

  const chainId = parseInt(json.result, 16);
  if (isNaN(chainId)) {
    throw new DeploymentGuardError(
      `RPC endpoint (${masked}) returned unparseable chain ID hex: "${json.result}"`,
      { rpcUrl: masked, result: json.result }
    );
  }

  if (chainId !== MONAD_CHAIN_ID) {
    throw new DeploymentGuardError(
      `RPC endpoint (${masked}) returned chain ID ${chainId} (hex: ${json.result}), expected Monad Testnet (${MONAD_CHAIN_ID})`,
      { rpcUrl: masked, chainId, expected: MONAD_CHAIN_ID }
    );
  }

  return chainId;
}

/**
 * Load and validate deployment target configuration.
 */
export function loadDeploymentTargets(options = {}) {
  const root = options.cwd || ROOT;
  const configPath = options.deploymentTargetsPath || resolve(root, "config/deployment-targets.monad.json");
  
  if (!existsSync(configPath)) {
    throw new DeploymentGuardError(
      "Deployment target configuration not found",
      { path: configPath }
    );
  }
  
  try {
    const content = readFileSync(configPath, "utf8");
    const config = JSON.parse(content);
    
    // Validate required structure
    if (!config.version) {
      throw new Error("Missing required field: version");
    }
    
    if (!config.deployment) {
      throw new Error("Missing required field: deployment");
    }
    
    if (!config.network || typeof config.network !== "object") {
      throw new Error("Missing or invalid required field: network");
    }
    
    if (typeof config.network.chainId !== "number") {
      throw new Error("network.chainId must be a number");
    }
    
    if (!config.hosting || typeof config.hosting !== "object") {
      throw new Error("Missing or invalid required field: hosting");
    }
    
    if (!config.livekit || typeof config.livekit !== "object") {
      throw new Error("Missing or invalid required field: livekit");
    }

    if (!config.livekit.projectScope || typeof config.livekit.projectScope !== "string" || !config.livekit.projectScope.trim()) {
      throw new Error("livekit.projectScope is required and cannot be empty");
    }

    if (!config.livekit.agentName || typeof config.livekit.agentName !== "string" || !config.livekit.agentName.trim()) {
      throw new Error("livekit.agentName is required and cannot be empty");
    }
    
    if (!config.state || typeof config.state !== "object") {
      throw new Error("Missing or invalid required field: state");
    }
    
    if (!config.state.scope || typeof config.state.scope !== "string" || !config.state.scope.trim()) {
      throw new Error("state.scope is required and cannot be empty");
    }
    
    return config;
  } catch (error) {
    throw new DeploymentGuardError(
      "Failed to parse or validate deployment target configuration",
      { path: configPath, error: error.message }
    );
  }
}

/**
 * Load and validate network configuration.
 */
export function loadNetworkConfig(options = {}) {
  const root = options.cwd || ROOT;
  const configPath = options.networkConfigPath || resolve(root, "config/networks.json");
  
  if (!existsSync(configPath)) {
    throw new DeploymentGuardError(
      "Network configuration not found",
      { path: configPath }
    );
  }
  
  try {
    const content = readFileSync(configPath, "utf8");
    const config = JSON.parse(content);
    
    if (!config.networks || typeof config.networks !== "object") {
      throw new Error("Missing or invalid required field: networks");
    }
    
    if (!config.active) {
      throw new Error("Missing required field: active");
    }
    
    const activeNetwork = config.networks[config.active];
    if (!activeNetwork) {
      throw new Error(`Active network "${config.active}" not found in networks`);
    }
    
    if (typeof activeNetwork.chainId !== "number") {
      throw new Error(`networks.${config.active}.chainId must be a number`);
    }
    
    if (!activeNetwork.name) {
      throw new Error(`networks.${config.active}.name is required`);
    }
    
    if (!activeNetwork.nativeCurrency || typeof activeNetwork.nativeCurrency !== "object") {
      throw new Error(`networks.${config.active}.nativeCurrency is required`);
    }
    
    if (!activeNetwork.blockExplorer || typeof activeNetwork.blockExplorer !== "object") {
      throw new Error(`networks.${config.active}.blockExplorer is required`);
    }
    
    return config;
  } catch (error) {
    throw new DeploymentGuardError(
      "Failed to parse or validate network configuration",
      { path: configPath, error: error.message }
    );
  }
}

export function getGitRemote(remoteName = "origin", options = {}) {
  const root = options.cwd || ROOT;
  const runner = options.exec || execSync;
  try {
    const remoteUrl = runner(`git remote get-url ${remoteName}`, {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
    return remoteUrl;
  } catch {
    return null;
  }
}

export function validateGitRemote(targetConfig, options = {}) {
  const expectedRemote = targetConfig.git?.remoteUrl;
  
  if (!expectedRemote || expectedRemote.trim() === "") {
    throw new DeploymentGuardError(
      "Git remote URL not configured in deployment targets",
      { 
        reason: "Remote URL is empty in config/deployment-targets.monad.json",
        action: "Set git.remoteUrl after creating the Monad repository"
      }
    );
  }
  
  const remoteName = targetConfig.git?.remoteName || "origin";
  const actualRemote = getGitRemote(remoteName, options);
  
  if (!actualRemote) {
    throw new DeploymentGuardError(
      "Git remote not configured",
      {
        expected: expectedRemote,
        action: `Run: git remote add ${remoteName} <url>`
      }
    );
  }
  
  const normalizeUrl = (url) => url.replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
  const normalizedExpected = normalizeUrl(expectedRemote);
  const normalizedActual = normalizeUrl(actualRemote);
  
  if (normalizedActual !== normalizedExpected) {
    const isBnbRemote = (normalizedActual.includes("archava") && !normalizedActual.includes("monad")) ||
                        normalizedActual.includes("archava-onchain");
    
    throw new DeploymentGuardError(
      "Git remote does not match Monad deployment target",
      {
        expected: expectedRemote,
        actual: actualRemote,
        warning: isBnbRemote ? "This appears to be the legacy BNB production remote" : undefined,
        action: "Update remote or deployment target configuration"
      }
    );
  }
  
  return true;
}

/**
 * Inspect actual Vercel linkage from .vercel/project.json or environment.
 */
export function getVercelLinkage(options = {}) {
  const root = options.cwd || ROOT;
  const env = options.env || process.env;
  const vercelPath = resolve(root, ".vercel/project.json");

  let fromFile = null;
  if (existsSync(vercelPath)) {
    try {
      const content = readFileSync(vercelPath, "utf8");
      fromFile = JSON.parse(content);
    } catch {
      // unparseable or corrupted
    }
  }

  const projectId = env.VERCEL_PROJECT_ID || fromFile?.projectId || null;
  const orgId = env.VERCEL_ORG_ID || fromFile?.orgId || null;
  const projectName = fromFile?.projectName || null;

  if (!projectId && !orgId && !projectName) {
    return null;
  }

  return {
    projectId,
    orgId,
    projectName,
    source: fromFile ? (env.VERCEL_PROJECT_ID ? "env+file" : "file") : "env"
  };
}

/**
 * Validate Vercel deployment target and actual linkage.
 */
export function validateVercelTarget(targetConfig, options = {}) {
  const frontend = targetConfig.hosting?.frontend;
  const expectedProjectId = frontend?.projectId;

  if (!expectedProjectId || expectedProjectId.trim() === "") {
    throw new DeploymentGuardError(
      "hosting.frontend.projectId is empty in deployment targets",
      { action: "Set hosting.frontend.projectId after provisioning Monad Vercel project" }
    );
  }

  if (frontend?.provider !== "vercel") {
    throw new DeploymentGuardError(
      `Frontend provider is "${frontend?.provider}", expected "vercel"`
    );
  }

  // Reject BNB production indicators in expected target
  if (KNOWN_BNB_PROJECT_IDS.has(expectedProjectId.toLowerCase()) || 
      (frontend.projectName && frontend.projectName.includes("onchain") && !frontend.projectName.includes("monad"))) {
    throw new DeploymentGuardError(
      `Vercel project ID "${expectedProjectId}" belongs to legacy BNB deployment. Monad must use a separate project.`,
      { expectedProjectId }
    );
  }

  const actualLinkage = getVercelLinkage(options);
  if (!actualLinkage) {
    throw new DeploymentGuardError(
      "Vercel linkage not found: .vercel/project.json is missing and VERCEL_PROJECT_ID is unset. Deploy operation would use unverified context.",
      { action: "Link project using Vercel CLI to Monad project or set VERCEL_PROJECT_ID" }
    );
  }

  if (actualLinkage.projectId !== expectedProjectId) {
    const isBnbLinkage = KNOWN_BNB_PROJECT_IDS.has(actualLinkage.projectId?.toLowerCase()) ||
                         (actualLinkage.projectName && actualLinkage.projectName.includes("onchain") && !actualLinkage.projectName.includes("monad"));

    throw new DeploymentGuardError(
      `Actual Vercel project linkage ("${actualLinkage.projectId}") does not match expected Monad deployment target ("${expectedProjectId}")`,
      {
        expected: expectedProjectId,
        actual: actualLinkage.projectId,
        warning: isBnbLinkage ? "Actual linkage points to legacy BNB production project!" : undefined,
        action: "Relink Vercel using 'vercel link' to Monad project before deploying"
      }
    );
  }

  return true;
}

/**
 * Inspect actual Railway context from CLI status, .railway/config.json, or environment.
 */
export function getRailwayContext(options = {}) {
  const root = options.cwd || ROOT;
  const env = options.env || process.env;
  const runner = options.exec || execSync;

  // 1. Check Railway CLI status command if railway is available
  try {
    const statusOutput = runner("railway status --json", {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000
    }).trim();
    if (statusOutput) {
      const data = JSON.parse(statusOutput);
      if (data && (data.id || data.projectId || data.project)) {
        return {
          projectId: data.id || data.projectId || data.project,
          environmentId: data.environment?.id || data.environmentId,
          serviceId: data.service?.id || data.serviceId,
          serviceName: data.service?.name || data.serviceName,
          source: "cli"
        };
      }
    }
  } catch {
    // Railway CLI not installed or not logged in, fall back to file / env
  }

  // 2. Check .railway/config.json
  const railwayConfigFile = resolve(root, ".railway/config.json");
  if (existsSync(railwayConfigFile)) {
    try {
      const content = readFileSync(railwayConfigFile, "utf8");
      const cfg = JSON.parse(content);
      // Flat format: { project: "...", environment: "...", service: "..." }
      if (cfg.project || cfg.projectId) {
        return {
          projectId: cfg.project || cfg.projectId,
          environmentId: cfg.environment || cfg.environmentId,
          serviceId: cfg.service || cfg.serviceId,
          serviceName: cfg.serviceName,
          source: "file"
        };
      }
      // Workspace map format: { projects: { "<path>": { project: "..." } } }
      if (cfg.projects && typeof cfg.projects === "object") {
        const resolvedRoot = resolve(root);
        let activeProj = null;
        for (const [projectPath, proj] of Object.entries(cfg.projects)) {
          if (proj && typeof proj === "object") {
            if (resolve(projectPath) === resolvedRoot) {
              activeProj = proj;
              break;
            }
          }
        }
        if (activeProj) {
          return {
            projectId: activeProj.project || activeProj.projectId || null,
            environmentId: activeProj.environment || activeProj.environmentId || null,
            serviceId: activeProj.service || activeProj.serviceId || null,
            serviceName: activeProj.serviceName || null,
            source: "file"
          };
        }
      }
    } catch {
      // unparseable
    }
  }

  // 3. Check environment variables
  const envProjectId = env.RAILWAY_PROJECT_ID || env.PROJECT_ID;
  const envEnvId = env.RAILWAY_ENVIRONMENT_ID || env.ENVIRONMENT_ID;
  const envServiceId = env.RAILWAY_SERVICE_ID || env.SERVICE_ID;
  const envServiceName = env.RAILWAY_SERVICE_NAME;

  if (envProjectId || envEnvId || envServiceId) {
    return {
      projectId: envProjectId || null,
      environmentId: envEnvId || null,
      serviceId: envServiceId || null,
      serviceName: envServiceName || null,
      source: "env"
    };
  }

  return null;
}

/**
 * Validate Railway deployment target and actual context.
 */
export function validateRailwayTarget(targetConfig, options = {}) {
  const backend = targetConfig.hosting?.backend;
  const expectedProjectId = backend?.projectId?.trim();
  const expectedEnvId = backend?.environmentId?.trim();
  const expectedServiceId = backend?.serviceId?.trim();
  const expectedServiceName = backend?.serviceName || "";

  const errors = [];

  if (!expectedProjectId) {
    errors.push("hosting.backend.projectId is empty");
  }
  if (!expectedEnvId) {
    errors.push("hosting.backend.environmentId is empty");
  }
  if (!expectedServiceId) {
    errors.push("hosting.backend.serviceId is empty");
  }
  if (backend?.provider !== "railway") {
    errors.push(`hosting.backend.provider is "${backend?.provider}", expected "railway"`);
  }

  if (expectedServiceName.includes("production") && !expectedServiceName.includes("monad")) {
    errors.push(`hosting.backend.serviceName "${expectedServiceName}" suggests BNB production deployment`);
  }

  if (errors.length > 0) {
    throw new DeploymentGuardError(
      "Railway target configuration is incomplete or invalid:\n" + errors.map(e => `  - ${e}`).join("\n"),
      { errors }
    );
  }

  const actualContext = getRailwayContext(options);
  if (!actualContext) {
    throw new DeploymentGuardError(
      "Railway context not found: neither Railway CLI status, .railway/config.json, nor RAILWAY_* environment variables are configured.",
      { action: "Link Railway service or provide RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, and RAILWAY_SERVICE_ID" }
    );
  }

  // Wajibkan projectId, environmentId, dan serviceId aktual sebagai string nonempty.
  // Bandingkan masing-masing dengan expected IDs.
  // Jangan melewati pemeriksaan karena field aktual kosong.
  const contextMismatches = [];

  const actualProjectId = typeof actualContext.projectId === "string" ? actualContext.projectId.trim() : "";
  const actualEnvId = typeof actualContext.environmentId === "string" ? actualContext.environmentId.trim() : "";
  const actualServiceId = typeof actualContext.serviceId === "string" ? actualContext.serviceId.trim() : "";

  if (!actualProjectId) {
    contextMismatches.push("actual projectId is missing or empty in Railway context");
  } else if (actualProjectId !== expectedProjectId) {
    contextMismatches.push(`projectId mismatch: actual "${actualProjectId}" !== expected "${expectedProjectId}"`);
  }

  if (!actualEnvId) {
    contextMismatches.push("actual environmentId is missing or empty in Railway context");
  } else if (actualEnvId !== expectedEnvId) {
    contextMismatches.push(`environmentId mismatch: actual "${actualEnvId}" !== expected "${expectedEnvId}"`);
  }

  if (!actualServiceId) {
    contextMismatches.push("actual serviceId is missing or empty in Railway context");
  } else if (actualServiceId !== expectedServiceId) {
    contextMismatches.push(`serviceId mismatch: actual "${actualServiceId}" !== expected "${expectedServiceId}"`);
  }

  // Also check if actual points to BNB production
  if (actualContext.serviceName && KNOWN_BNB_SERVICES.has(actualContext.serviceName.trim())) {
    contextMismatches.push(`Actual Railway service "${actualContext.serviceName}" is the legacy BNB service!`);
  }
  if (actualProjectId && KNOWN_BNB_PROJECT_IDS.has(actualProjectId.toLowerCase())) {
    contextMismatches.push(`Actual Railway project "${actualProjectId}" is a legacy BNB project!`);
  }

  if (contextMismatches.length > 0) {
    throw new DeploymentGuardError(
      "Railway context mismatch with Monad deployment target:\n" + contextMismatches.map(m => `  - ${m}`).join("\n"),
      { mismatches: contextMismatches, actual: actualContext, expected: backend }
    );
  }

  return true;
}

/**
 * Validate hosting targets and actual linkages for deploy mode.
 */
export function validateHostingTargets(targetConfig, options = {}) {
  validateVercelTarget(targetConfig, options);
  validateRailwayTarget(targetConfig, options);
  return true;
}

/**
 * Validate runtime configuration.
 */
export function validateRuntimeConfig(targetConfig, networkConfig) {
  const { chainId } = targetConfig.network || {};
  const { url: livekitUrl, agentName, projectScope } = targetConfig.livekit || {};
  const { scope: stateScope } = targetConfig.state || {};
  
  if (chainId !== MONAD_CHAIN_ID) {
    throw new DeploymentGuardError(
      "Runtime chain ID does not match Monad Testnet (10143)",
      {
        expected: MONAD_CHAIN_ID,
        actual: chainId,
        warning: chainId === BNB_CHAIN_ID ? "This is BNB Testnet chain ID" : undefined
      }
    );
  }
  
  const activeNetwork = networkConfig.networks?.[networkConfig.active];
  if (!activeNetwork) {
    throw new DeploymentGuardError(
      "Active network not found in network configuration",
      { activeNetwork: networkConfig.active }
    );
  }
  
  if (activeNetwork.chainId !== chainId) {
    throw new DeploymentGuardError(
      "Network configuration chain ID mismatch",
      {
        targetChainId: chainId,
        networkChainId: activeNetwork.chainId
      }
    );
  }
  
  if (!livekitUrl || livekitUrl.trim() === "") {
    throw new DeploymentGuardError(
      "LiveKit URL not configured in deployment targets",
      { action: "Set livekit.url after creating LiveKit project for Monad" }
    );
  }

  if (!projectScope || projectScope.trim() === "") {
    throw new DeploymentGuardError(
      "livekit.projectScope not configured in deployment targets",
      { action: "Must be set for room isolation" }
    );
  }
  
  if (!agentName || agentName.trim() === "") {
    throw new DeploymentGuardError(
      "livekit.agentName not configured in deployment targets",
      { action: "Must be set to unique Monad agent name" }
    );
  }

  if (!agentName.includes("monad")) {
    throw new DeploymentGuardError(
      `Agent name "${agentName}" does not include "monad". Must be scoped to Monad deployment to prevent room collision.`
    );
  }
  
  if (!stateScope || stateScope.trim() === "") {
    throw new DeploymentGuardError(
      "State scope not configured",
      { action: "Must be set to separate Monad state from BNB" }
    );
  }

  if (stateScope.toLowerCase().includes("bnb") || stateScope.toLowerCase().includes("bsc")) {
    throw new DeploymentGuardError(
      `State scope "${stateScope}" points to BNB/BSC. Monad deployment must use isolated state.`
    );
  }
  
  return true;
}

/**
 * Validate contract deployment target (foundry configuration).
 */
export async function validateContractsTarget(targetConfig, networkConfig, options = {}) {
  const root = options.cwd || ROOT;
  const env = options.env || process.env;
  const foundryPath = resolve(root, "packages/contracts/foundry.toml");

  // 1. Target chainId validation
  if (targetConfig.network?.chainId !== MONAD_CHAIN_ID) {
    throw new DeploymentGuardError(
      `Contract target chain ID is ${targetConfig.network?.chainId}, expected ${MONAD_CHAIN_ID}`
    );
  }

  // 2. Active network and networkConfig chainId validation
  if (!networkConfig.active) {
    throw new DeploymentGuardError("Active network not specified in network configuration");
  }

  if (networkConfig.active !== "monadTestnet") {
    throw new DeploymentGuardError(
      `Active network is "${networkConfig.active}", expected "monadTestnet"`
    );
  }

  const activeNetwork = networkConfig.networks?.[networkConfig.active];
  if (!activeNetwork) {
    throw new DeploymentGuardError(
      `Active network "${networkConfig.active}" not found in network configuration`
    );
  }

  if (activeNetwork.chainId !== MONAD_CHAIN_ID) {
    throw new DeploymentGuardError(
      `Active network "${networkConfig.active}" chain ID is ${activeNetwork.chainId}, expected ${MONAD_CHAIN_ID}`
    );
  }

  // 3. Validate CHAIN_ID if provided in env or operation options
  if (env.CHAIN_ID !== undefined && env.CHAIN_ID !== "") {
    const envChainId = Number(env.CHAIN_ID);
    if (envChainId !== MONAD_CHAIN_ID) {
      throw new DeploymentGuardError(
        `CHAIN_ID from environment (${env.CHAIN_ID}) does not match Monad Testnet (${MONAD_CHAIN_ID})`
      );
    }
  }

  if (options.chainId !== undefined && options.chainId !== "") {
    const opChainId = Number(options.chainId);
    if (opChainId !== MONAD_CHAIN_ID) {
      throw new DeploymentGuardError(
        `Operation chain ID (${options.chainId}) does not match Monad Testnet (${MONAD_CHAIN_ID})`
      );
    }
  }

  // 4. Validate active network and env RPC endpoints
  const networkRpcUrls = getNetworkRpcUrls(activeNetwork);
  if (networkRpcUrls.length === 0 && !activeNetwork.rpcUrl) {
    throw new DeploymentGuardError(
      `Active network "${networkConfig.active}" has no RPC URLs configured`
    );
  }
  for (const url of networkRpcUrls) {
    validateRpcUrl(url, `networkConfig.networks.${networkConfig.active}.rpcUrls`);
  }
  if (activeNetwork.rpcUrl) {
    validateRpcUrl(activeNetwork.rpcUrl, "networkConfig.active rpcUrl");
  }
  if (targetConfig.network?.rpc?.public) {
    validateRpcUrl(targetConfig.network.rpc.public, "targetConfig.network.rpc.public");
  }

  // Check common RPC environment variables used by foundry / deployment scripts
  const rpcEnvVars = ["MONAD_TESTNET_RPC_URL", "RPC_URL", "MONAD_RPC_URL", "ETH_RPC_URL"];
  for (const varName of rpcEnvVars) {
    if (env[varName]) {
      validateRpcUrl(env[varName], `${varName} environment variable`);
    }
  }

  // 5. Inspect foundry.toml and resolve env variables in rpc_endpoints
  if (existsSync(foundryPath)) {
    const content = readFileSync(foundryPath, "utf8");
    if (content.includes("bsc_testnet") || content.includes("bsc-dataseed") || content.includes("data-seed-prebsc") || isBnbRpc(content)) {
      throw new DeploymentGuardError(
        "foundry.toml contains BSC testnet endpoints. Contracts must be configured for Monad testnet only."
      );
    }

    // Parse [rpc_endpoints] section
    const rpcSectionMatch = content.match(/\[rpc_endpoints\]([\s\S]*?)(?:\[|$)/);
    if (rpcSectionMatch) {
      const rpcLines = rpcSectionMatch[1].split("\n");
      for (const line of rpcLines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx !== -1) {
          const endpointName = trimmed.slice(0, eqIdx).trim();
          let endpointVal = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
          const envMatch = endpointVal.match(/\$\{?([A-Z0-9_]+)\}?/);
          if (envMatch) {
            const envVarName = envMatch[1];
            const resolvedVal = env[envVarName];
            if (resolvedVal) {
              validateRpcUrl(resolvedVal, `foundry.toml [rpc_endpoints].${endpointName} (via ${envVarName})`);
            }
          } else if (endpointVal) {
            validateRpcUrl(endpointVal, `foundry.toml [rpc_endpoints].${endpointName}`);
          }
        }
      }
    }
  }

  // 6. Online RPC verification helper: eth_chainId === 10143
  let resolvedRpc = null;
  if (options.verifyRpcOnline) {
    resolvedRpc = resolveOperationalRpc(targetConfig, networkConfig, options);
    await verifyRpcChainId(resolvedRpc, options);
  }

  return { valid: true, rpcUrl: resolvedRpc };
}

/**
 * Validate local development configuration.
 */
export function validateLocalMode(targetConfig, networkConfig, options = {}) {
  const env = options.env || process.env;

  if (!targetConfig.deployment) {
    throw new DeploymentGuardError("Deployment identifier missing");
  }
  
  if (!networkConfig.active) {
    throw new DeploymentGuardError("Active network not specified in network configuration");
  }

  if (networkConfig.active !== "monadTestnet") {
    throw new DeploymentGuardError(
      `Active network is "${networkConfig.active}", expected "monadTestnet"`
    );
  }

  const activeNetwork = networkConfig.networks?.[networkConfig.active];
  if (!activeNetwork) {
    throw new DeploymentGuardError(
      `Active network "${networkConfig.active}" not found in network configuration`
    );
  }

  if (activeNetwork.chainId !== MONAD_CHAIN_ID) {
    throw new DeploymentGuardError(
      `Active network "${networkConfig.active}" chain ID is ${activeNetwork.chainId}, expected ${MONAD_CHAIN_ID}`
    );
  }
  
  if (targetConfig.network?.chainId !== MONAD_CHAIN_ID) {
    throw new DeploymentGuardError(
      "Target chain ID is not Monad Testnet (10143)",
      { actual: targetConfig.network?.chainId }
    );
  }

  if (env.CHAIN_ID !== undefined && env.CHAIN_ID !== "") {
    const envChainId = Number(env.CHAIN_ID);
    if (envChainId !== MONAD_CHAIN_ID) {
      throw new DeploymentGuardError(
        `CHAIN_ID from environment (${env.CHAIN_ID}) does not match Monad Testnet (${MONAD_CHAIN_ID})`
      );
    }
  }

  // Validate active network RPC URLs (including actual rpcUrls.default.http)
  const localRpcUrls = getNetworkRpcUrls(activeNetwork);
  for (const url of localRpcUrls) {
    validateRpcUrl(url, `active network "${networkConfig.active}" rpcUrls`);
  }
  if (activeNetwork.rpcUrl) {
    validateRpcUrl(activeNetwork.rpcUrl, "active network rpcUrl");
  }
  if (targetConfig.network?.rpc?.public) {
    validateRpcUrl(targetConfig.network.rpc.public, "targetConfig.network.rpc.public");
  }
  if (env.RPC_URL) {
    validateRpcUrl(env.RPC_URL, "RPC_URL environment variable");
  }
  if (env.MONAD_TESTNET_RPC_URL) {
    validateRpcUrl(env.MONAD_TESTNET_RPC_URL, "MONAD_TESTNET_RPC_URL environment variable");
  }

  // Check for dangerous legacy BNB linkage in local environment
  const vercelLinkage = getVercelLinkage(options);
  if (vercelLinkage && KNOWN_BNB_PROJECT_IDS.has(vercelLinkage.projectId?.toLowerCase())) {
    throw new DeploymentGuardError(
      `Local .vercel linkage points to BNB production project ("${vercelLinkage.projectId}"). Unlink immediately.`
    );
  }

  const railwayContext = getRailwayContext(options);
  if (railwayContext && (KNOWN_BNB_SERVICES.has(railwayContext.serviceName) || KNOWN_BNB_PROJECT_IDS.has(railwayContext.projectId?.toLowerCase()))) {
    throw new DeploymentGuardError(
      `Local Railway context points to BNB production service ("${railwayContext.serviceName}"). Disconnect immediately.`
    );
  }
  
  const warnings = [];
  if (!targetConfig.git?.remoteUrl) warnings.push("Git remote URL not configured");
  if (!targetConfig.hosting?.frontend?.projectId) warnings.push("Frontend hosting not provisioned");
  if (!targetConfig.hosting?.backend?.projectId || 
      !targetConfig.hosting?.backend?.environmentId ||
      !targetConfig.hosting?.backend?.serviceId) {
    warnings.push("Backend hosting not fully provisioned");
  }
  if (!targetConfig.livekit?.url) warnings.push("LiveKit project URL not configured");
  
  return { valid: true, warnings };
}

/**
 * Main verify function for programmatic and CLI execution.
 */
export async function verifyDeploymentTarget(mode = "local", options = {}) {
  const targetConfig = loadDeploymentTargets(options);
  const networkConfig = loadNetworkConfig(options);

  switch (mode) {
    case "local":
      return validateLocalMode(targetConfig, networkConfig, options);

    case "push":
      validateGitRemote(targetConfig, options);
      return { valid: true, remote: targetConfig.git?.remoteUrl };

    case "deploy":
      validateHostingTargets(targetConfig, options);
      return { valid: true };

    case "vercel":
      validateVercelTarget(targetConfig, options);
      return { valid: true };

    case "railway":
      validateRailwayTarget(targetConfig, options);
      return { valid: true };

    case "runtime":
      validateRuntimeConfig(targetConfig, networkConfig);
      return { valid: true };

    case "contracts":
      return await validateContractsTarget(targetConfig, networkConfig, options);

    default:
      throw new DeploymentGuardError(`Invalid mode: ${mode}`);
  }
}

async function main() {
  const mode = process.argv[2] || "local";
  const validModes = ["local", "push", "deploy", "vercel", "railway", "runtime", "contracts"];
  
  if (!validModes.includes(mode)) {
    console.error(`Invalid mode: ${mode}`);
    console.error(`Valid modes: ${validModes.join(", ")}`);
    process.exit(1);
  }
  
  try {
    const result = await verifyDeploymentTarget(mode);
    console.log(`✓ ${mode.toUpperCase()} validation passed`);
    if (result.warnings && result.warnings.length > 0) {
      console.log("\n⚠️  Warnings:");
      result.warnings.forEach(w => console.log(`  - ${w}`));
    }
    process.exit(0);
  } catch (error) {
    if (error instanceof DeploymentGuardError) {
      console.error(`\n❌ Deployment Guard Error: ${error.message}\n`);
      if (error.details && Object.keys(error.details).length > 0) {
        console.error("Details:", JSON.stringify(error.details, null, 2));
      }
      process.exit(1);
    }
    console.error(`\n❌ Unexpected error: ${error.message}\n`);
    if (error.stack) console.error(error.stack);
    process.exit(1);
  }
}

// Only execute CLI main if called directly
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
