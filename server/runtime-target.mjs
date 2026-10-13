/**
 * Runtime target validation and startup lock for Archava Monad API.
 * 
 * This module ensures the API does not start with inherited BNB configuration
 * or create provider clients before validating that all configuration points
 * to the Monad deployment.
 * 
 * The startup lock prevents:
 * - Creating LiveKit clients with BNB project credentials
 * - Starting sweepers that process BNB rooms
 * - Reading state from BNB deployment directory
 * - Making RPC calls to BNB Testnet
 * 
 * Environment variable ARCHAVA_RUNTIME_ENABLED must be explicitly set to "true"
 * AND all configuration must pass validation before the API can start real
 * provider clients and background jobs.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export class RuntimeValidationError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = "RuntimeValidationError";
    this.context = context;
  }
}

/**
 * Load and validate deployment target configuration.
 */
export function loadDeploymentTargets(cwd = process.cwd()) {
  const configPath = resolve(cwd, "config/deployment-targets.monad.json");
  
  if (!existsSync(configPath)) {
    throw new RuntimeValidationError(
      "Deployment target configuration not found",
      { configPath, resolution: "Ensure config/deployment-targets.monad.json exists" }
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
      throw new Error("livekit.projectScope is required for room isolation");
    }
    if (!config.livekit.agentName || typeof config.livekit.agentName !== "string" || !config.livekit.agentName.trim()) {
      throw new Error("livekit.agentName is required");
    }
    if (!config.state || typeof config.state !== "object") {
      throw new Error("Missing or invalid required field: state");
    }
    if (!config.state.scope || typeof config.state.scope !== "string" || !config.state.scope.trim()) {
      throw new Error("state.scope is required");
    }
    
    return config;
  } catch (error) {
    throw new RuntimeValidationError(
      "Failed to parse or validate deployment targets",
      { configPath, error: error.message }
    );
  }
}

/**
 * Load and validate network configuration.
 */
export function loadNetworkConfig(cwd = process.cwd()) {
  const configPath = resolve(cwd, "config/networks.json");
  
  if (!existsSync(configPath)) {
    throw new RuntimeValidationError(
      "Network configuration not found",
      { configPath, resolution: "Ensure config/networks.json exists" }
    );
  }
  
  try {
    const content = readFileSync(configPath, "utf8");
    const config = JSON.parse(content);
    
    // Validate required structure
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
    
    return config;
  } catch (error) {
    throw new RuntimeValidationError(
      "Failed to parse or validate network configuration",
      { configPath, error: error.message }
    );
  }
}

/**
 * Validate that environment configuration matches Monad deployment.
 * This is a reusable validation function that throws typed errors.
 */
export function validateEnvironmentConfig(env, deploymentTargets, networkConfig) {
  const errors = [];
  const warnings = [];
  
  // Get the active network configuration
  const activeNetworkKey = networkConfig.active;
  if (!activeNetworkKey) {
    errors.push("No active network specified in network configuration");
  }
  
  const activeNetwork = networkConfig.networks?.[activeNetworkKey];
  if (!activeNetwork) {
    errors.push(`Active network "${activeNetworkKey}" not found in networks configuration`);
  }
  
  // Chain ID validation - must match across env, network config, and deployment target
  const envChainId = Number(env.CHAIN_ID);
  const networkChainId = activeNetwork?.chainId;
  const targetChainId = deploymentTargets.network?.chainId;
  
  if (!envChainId) {
    errors.push("CHAIN_ID environment variable not set");
  } else if (envChainId !== 10143) {
    errors.push(
      `CHAIN_ID is ${envChainId}, expected 10143 (Monad Testnet)` +
      (envChainId === 97 ? " - This is BNB Testnet!" : "")
    );
  }
  
  // Validate network config chain ID matches expected
  if (networkChainId !== 10143) {
    errors.push(
      `Network configuration chainId is ${networkChainId}, expected 10143 (Monad Testnet)` +
      (networkChainId === 97 ? " - This is BNB Testnet configuration!" : "")
    );
  }
  
  // Validate deployment target chain ID
  if (targetChainId !== 10143) {
    errors.push(
      `Deployment target chainId is ${targetChainId}, expected 10143 (Monad Testnet)`
    );
  }
  
  // All three must match each other
  if (envChainId && networkChainId && envChainId !== networkChainId) {
    errors.push(
      `CHAIN_ID (${envChainId}) does not match network config chainId (${networkChainId})`
    );
  }
  
  if (envChainId && targetChainId && envChainId !== targetChainId) {
    errors.push(
      `CHAIN_ID (${envChainId}) does not match deployment target chainId (${targetChainId})`
    );
  }
  
  // RPC URL must be configured (we don't validate the actual URL here to avoid
  // making network calls during startup validation)
  if (!env.RPC_URL || env.RPC_URL.trim() === "") {
    errors.push("RPC_URL environment variable not set");
  } else {
    // Check for known BNB RPC patterns
    const rpcUrl = env.RPC_URL.toLowerCase();
    if (rpcUrl.includes("bnb") || rpcUrl.includes("bsc")) {
      errors.push(
        "RPC_URL appears to point to BNB/BSC network. " +
        "Monad RPC should be used for this deployment."
      );
    }
    
    // Warn if using public RPC for production
    if (rpcUrl.includes("testnet-rpc.monad.xyz")) {
      warnings.push(
        "Using public Monad RPC. Consider using a dedicated provider " +
        "endpoint for better rate limits and reliability."
      );
    }
  }
  
  // LiveKit URL must match deployment target - REQUIRED
  const livekitUrl = env.LIVEKIT_URL || "";
  const targetLivekitUrl = deploymentTargets.livekit?.url || "";
  
  if (!livekitUrl) {
    errors.push("LIVEKIT_URL environment variable not set");
  }
  
  if (!targetLivekitUrl) {
    errors.push("LiveKit URL not configured in deployment targets");
  }
  
  if (livekitUrl && targetLivekitUrl && livekitUrl !== targetLivekitUrl) {
    errors.push(
      `LIVEKIT_URL does not match deployment target.\n` +
      `  Environment: ${livekitUrl}\n` +
      `  Target:      ${targetLivekitUrl}`
    );
  }

  // LiveKit project scope (deploymentId) is strictly required for room isolation
  const targetScope = deploymentTargets.livekit?.projectScope || "";
  if (!targetScope) {
    errors.push("LiveKit projectScope not configured in deployment targets");
  }
  
  // Agent name must match deployment - REQUIRED for worker
  const agentName = env.ARCHAVA_AGENT_NAME || "";
  const targetAgentName = deploymentTargets.livekit?.agentName || "";
  
  if (!targetAgentName) {
    errors.push("Agent name not configured in deployment targets");
  }
  
  if (!agentName) {
    errors.push("ARCHAVA_AGENT_NAME environment variable not set");
  }
  
  if (agentName && targetAgentName && agentName !== targetAgentName) {
    errors.push(
      `ARCHAVA_AGENT_NAME (${agentName}) does not match deployment target (${targetAgentName}). ` +
      "Agent name must be deployment-specific to prevent processing wrong rooms."
    );
  }
  
  // Check for BNB legacy contract addresses
  const rentalContract = env.RENTAL_CONTRACT || "";
  const tokenContract = env.PAYMENT_TOKEN_CONTRACT || "";
  
  // These are the known BNB Testnet addresses from the original deployment
  const BNB_RENTAL = "0xefaacd259136d40cd26a8672697b591c1f84200c";
  const BNB_TOKEN = "0xd63574ac426169cda5495e1e196bf64d124267d0";
  
  if (rentalContract.toLowerCase() === BNB_RENTAL.toLowerCase()) {
    errors.push(
      "RENTAL_CONTRACT is set to BNB Testnet address. " +
      "Monad deployment must use different contract addresses."
    );
  }
  
  if (tokenContract.toLowerCase() === BNB_TOKEN.toLowerCase()) {
    errors.push(
      "PAYMENT_TOKEN_CONTRACT is set to BNB Testnet address. " +
      "Monad deployment must use different contract addresses."
    );
  }
  
  // State directory scope
  const stateDir = env.ARCHAVA_STATE_DIR || "./data";
  const targetStateScope = deploymentTargets.state?.scope || "";
  
  if (!targetStateScope) {
    errors.push("state.scope not configured in deployment targets");
  }
  
  if (stateDir.toLowerCase().includes("bnb") || stateDir.toLowerCase().includes("bsc")) {
    errors.push(
      `ARCHAVA_STATE_DIR (${stateDir}) appears to point to BNB state. ` +
      "Monad deployment must use separate state directory."
    );
  }
  
  return { errors, warnings };
}

/**
 * Validate runtime configuration before allowing API startup.
 * 
 * Reusable validation function that returns validated configuration
 * or throws typed RuntimeValidationError. It does not perform process.exit().
 * 
 * @param {object} env - Environment variables (defaults to process.env)
 * @param {object} options - Optional dependency injection { deploymentTargets, networkConfig, cwd }
 * @returns {object} Validated configuration with resolved values
 * @throws {RuntimeValidationError} If validation fails
 */
export function validateRuntimeStartup(env = process.env, options = {}) {
  const runtimeEnabled = env.ARCHAVA_RUNTIME_ENABLED === "true";
  
  if (!runtimeEnabled) {
    throw new RuntimeValidationError(
      "Runtime startup is locked. Set ARCHAVA_RUNTIME_ENABLED=true after validating configuration.",
      {
        reason: "Startup lock prevents accidental use of wrong configuration",
        action: "Validation alone is insufficient - full S03 validation requirements must be met",
        note: "ARCHAVA_RUNTIME_ENABLED=true does not establish readiness"
      }
    );
  }
  
  // Load configurations with dependency injection support
  const cwd = options.cwd || process.cwd();
  const deploymentTargets = options.deploymentTargets || loadDeploymentTargets(cwd);
  const networkConfig = options.networkConfig || loadNetworkConfig(cwd);
  
  // Validate deployment is for Monad
  if (deploymentTargets.deployment !== "monad") {
    throw new RuntimeValidationError(
      `Deployment target is "${deploymentTargets.deployment}", expected "monad"`,
      { deploymentTargets }
    );
  }
  
  // Validate active network
  if (networkConfig.active !== "monadTestnet") {
    throw new RuntimeValidationError(
      `Active network is "${networkConfig.active}", expected "monadTestnet"`,
      { activeNetwork: networkConfig.active }
    );
  }
  
  // Get active network for validation
  const activeNetwork = networkConfig.networks?.[networkConfig.active];
  if (!activeNetwork) {
    throw new RuntimeValidationError(
      `Active network "${networkConfig.active}" not found in network configuration`
    );
  }
  
  // Validate environment configuration (throws on error)
  const { errors, warnings } = validateEnvironmentConfig(
    env,
    deploymentTargets,
    networkConfig
  );
  
  // Report warnings
  if (warnings.length > 0) {
    console.warn("\n⚠️  Runtime Validation Warnings:");
    for (const warning of warnings) {
      console.warn(`  - ${warning}`);
    }
    console.warn();
  }
  
  // Fail on errors
  if (errors.length > 0) {
    const errorMessage = 
      "Runtime validation failed. Configuration does not match Monad deployment:\n" +
      errors.map(e => `  - ${e}`).join("\n");
    
    throw new RuntimeValidationError(errorMessage, {
      errors,
      deployment: deploymentTargets.deployment,
      network: networkConfig.active,
      chainId: activeNetwork.chainId,
      resolution: "Fix environment configuration to match Monad deployment targets"
    });
  }
  
  // Return validated configuration that consumers can use
  // Mandatory deploymentId without fallback
  const deploymentId = deploymentTargets.livekit?.projectScope;
  if (!deploymentId) {
    throw new RuntimeValidationError("Missing livekit.projectScope in deployment targets");
  }

  return {
    valid: true,
    deployment: deploymentTargets.deployment,
    network: networkConfig.active,
    chainId: activeNetwork.chainId,
    networkConfig: activeNetwork,
    deploymentTargets,
    livekitUrl: env.LIVEKIT_URL,
    agentName: env.ARCHAVA_AGENT_NAME,
    deploymentId,
    warnings: warnings.length > 0 ? warnings : undefined
  };
}

/**
 * Guard function that must be called before creating any provider clients,
 * sweepers, or background jobs in the API.
 * 
 * Throws RuntimeValidationError on failure. Does not call process.exit().
 */
export function enforceRuntimeGuard(env = process.env, options = {}) {
  const result = validateRuntimeStartup(env, options);
  
  console.log("✓ Runtime validation passed");
  console.log(`  Deployment: ${result.deployment}`);
  console.log(`  Network: ${result.network} (chain ${result.chainId})`);
  
  return result;
}

/**
 * Check if runtime is enabled without throwing.
 * Useful for conditional features that should gracefully degrade.
 */
export function isRuntimeEnabled(env = process.env) {
  return env.ARCHAVA_RUNTIME_ENABLED === "true";
}
