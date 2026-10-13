import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import { TrackSource } from "@livekit/protocol";
import { createChallengeStore } from "./auth.mjs";
import { createCreditReader, createPackQuoter, configuredContracts, verifyMonadConnection, loadDeploymentManifest } from "./rental.mjs";
import { createPurchaseCache, createPurchaseScanner } from "./purchase-cache.mjs";
import { createPurchaseHistoryService } from "./purchases.mjs";
import { createPreviewController } from "./preview.mjs";
import { createKeyStore } from "./apikeys.mjs";
import { createUsageStore } from "./usage.mjs";
import { createEntitlementGate } from "./entitlement.mjs";
import { createCustomerSessions } from "./customer-sessions.mjs";
import { createCustomerApi } from "./customer-api.mjs";
import { createDeveloperApi } from "./developer-api.mjs";
import { createDashboardSessionStore } from "./developer-auth.mjs";
import { createRoomProvider, removeAutomaticAgents } from "./livekit-rooms.mjs";
import { createApp } from "./app.mjs";
import { createReadinessCheck } from "./readiness.mjs";
import { enforceRuntimeGuard } from "./runtime-target.mjs";

/**
 * Builds every collaborator the HTTP application needs, from the environment.
 *
 * This is the only place production values are read, and it returns rather than
 * listens, so `server/index.mjs` stays a bootstrap and the tests can build the
 * same graph with fakes substituted for the room provider and the stores.
 */

const DIST_DIR = "dist";
const STATE_DIR = "data";
const SWEEP_INTERVAL_MS = 10_000;

export function createDependencies({ env = process.env, cwd = process.cwd(), stateDir, runtimeConfig } = {}) {
  // Enforce runtime guard before creating any provider clients or background jobs
  // This prevents the API from starting with BNB configuration or missing Monad setup
  // The validation returns resolved config that we must use consistently.
  // Supports dependency injection for isolated testing fixtures.
  const validatedConfig = runtimeConfig || enforceRuntimeGuard(env);
  
  // Use validated configuration values - not raw env or separate config loads
  const chainId = validatedConfig.chainId;
  const networkConfig = validatedConfig.networkConfig;
  const deploymentTargets = validatedConfig.deploymentTargets;
  const deploymentId = validatedConfig.deploymentId;
  const rawOrigin = env.WEB_ORIGIN || "http://localhost:5174";
  const origins = rawOrigin.split(",").map((s) => s.trim()).filter(Boolean);
  const origin = origins[0] || "http://localhost:5174";
  
  // Build allowed origins strictly from environment origins
  const allowedOrigins = [...origins];
  
  const livekitUrl = validatedConfig.livekitUrl;
  const livekitKey = env.LIVEKIT_API_KEY || "";
  const livekitSecret = env.LIVEKIT_API_SECRET || "";
  const avatarProvider = (env.AVATAR_PROVIDER || "tavus").trim().toLowerCase();
  if (!["tavus", "spatius"].includes(avatarProvider)) {
    throw new Error("AVATAR_PROVIDER must be tavus or spatius");
  }
  const spatiusAppId = env.SPATIUS_APP_ID || "";
  const spatiusAvatarId = env.SPATIUS_AVATAR_ID || "";
  if (avatarProvider === "spatius") {
    const missing = [];
    if (!env.SPATIUS_API_KEY) missing.push("SPATIUS_API_KEY");
    if (!spatiusAppId) missing.push("SPATIUS_APP_ID");
    if (!spatiusAvatarId) missing.push("SPATIUS_AVATAR_ID");
    if (missing.length > 0) {
      throw new Error(`Spatius requires ${missing.join(", ")}`);
    }
  }
  const previewSeconds = Math.min(180, Math.max(30, Number(env.PREVIEW_SECONDS || 90)));
  const packMinutes = [60, 300];
  const agentName = validatedConfig.agentName;

  const livekitConfigured = Boolean(livekitUrl && livekitKey && livekitSecret);
  const livekitHttpUrl = livekitUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  const roomService = livekitConfigured
    ? new RoomServiceClient(livekitHttpUrl, livekitKey, livekitSecret)
    : null;
  const dispatchService = livekitConfigured
    ? new AgentDispatchClient(livekitHttpUrl, livekitKey, livekitSecret)
    : null;
  const rooms = livekitConfigured
    ? createRoomProvider({ 
        rooms: roomService, 
        dispatch: dispatchService, 
        agentName, 
        key: livekitKey, 
        secret: livekitSecret,
        deploymentId 
      })
    : null;

  const rpcUrl = env.RPC_URL || env.MONAD_TESTNET_RPC_URL || "";
  if (env.RPC_URL && env.MONAD_TESTNET_RPC_URL && env.RPC_URL !== env.MONAD_TESTNET_RPC_URL) {
    throw new Error(
      `RPC_URL (${env.RPC_URL}) and MONAD_TESTNET_RPC_URL (${env.MONAD_TESTNET_RPC_URL}) conflict. Specify a single consistent RPC endpoint.`
    );
  }

  const rentalConfig = {
    rpcUrl,
    contractAddress: env.RENTAL_CONTRACT || "",
    tokenAddress: env.PAYMENT_TOKEN_CONTRACT || "",
    chainId,
    deploymentBlock: Number(env.RENTAL_DEPLOYMENT_BLOCK) || 0,
  };
  
  // Validate rental config against expected chain
  if (rentalConfig.chainId !== chainId) {
    throw new Error(
      `Rental contract chain ID mismatch: env has ${rentalConfig.chainId}, ` +
      `network config requires ${chainId}`
    );
  }

  const manifest = rentalConfig.contractAddress ? loadDeploymentManifest(cwd) : null;
  const canonicalRental = env.RENTAL_CONTRACT || manifest?.contracts?.rentalV2?.address || "";
  const canonicalToken = env.PAYMENT_TOKEN_CONTRACT || manifest?.contracts?.mockUsdt?.address || "";

  // The developer-facing product: a key proves a customer, the chain proves the
  // key's wallet purchased minutes, and the ledger checks remaining time. The key
  // store, the ledger, and the rooms all live next to each other in data/.
  const dataDir = stateDir || resolve(cwd, env.ARCHAVA_STATE_DIR || STATE_DIR);
  const scope = {
    deploymentId,
    chainId,
    rentalContract: canonicalRental || "0x7324a2678e74052a4e9a244c0d57b56b23fee6ad",
    paymentToken: canonicalToken || "0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c",
  };

  const keys = createKeyStore({ path: resolve(dataDir, "keys.json"), scope });
  const usage = createUsageStore({ path: resolve(dataDir, "usage.json"), scope });
  const purchaseCache = createPurchaseCache({ path: resolve(dataDir, "purchase-cache.json"), scope });

  let connection = null;
  let scanner = null;
  let readCredits = null;
  let quotePack = null;

  if (rentalConfig.contractAddress) {
    try {
      connection = configuredContracts(rentalConfig);
      if (connection) {
        scanner = createPurchaseScanner({
          provider: connection.provider,
          rentalContract: connection.rental,
          rentalAddress: rentalConfig.contractAddress,
          paymentTokenAddress: rentalConfig.tokenAddress,
          chainId,
          deploymentBlock: rentalConfig.deploymentBlock || 70191614,
          purchaseCache,
          pageSize: Number(env.ARCHAVA_SCANNER_PAGE_SIZE || 100),
          maxPagesPerSync: Number(env.ARCHAVA_SCANNER_MAX_PAGES || 20),
          maxRequestsPerSync: Number(env.ARCHAVA_SCANNER_MAX_REQUESTS || 50),
          maxDurationMsPerSync: Number(env.ARCHAVA_SCANNER_MAX_DURATION_MS || 10_000),
        });
      }
      readCredits = createCreditReader(rentalConfig, { purchaseCache, purchaseScanner: scanner });
      quotePack = createPackQuoter(rentalConfig);
    } catch (error) {
      // A rental misconfiguration disables paid access without taking down the
      // wallet-free preview or the rest of the API.
      console.error("Minute-pack contract configuration is unavailable:", error.message);
    }
  }

  // Customer API and browser sessions share this entitlement gate and ledger.
  const checkEntitlement = createEntitlementGate({ readCredits, usage });
  const customerSessions = createCustomerSessions({
    gate: checkEntitlement,
    keys,
    usage,
    livekit: rooms || {
      // With no LiveKit configured a customer session cannot be honest about its
      // room, so it is refused rather than answered with a room that cannot open.
      async openRoom() { throw new Error("LiveKit is not configured"); },
      async deleteRoom() {},
      issueToken() { throw new Error("LiveKit is not configured"); },
    },
    // The LiveKit URL and the public avatar identifiers a customer's browser
    // needs are read from the server's own public config, never from a request.
    sessionFields: { serverUrl: livekitUrl, avatarProvider, spatiusAppId, spatiusAvatarId },
  });
  const customerApi = createCustomerApi({ gate: checkEntitlement, keys, usage, sessions: customerSessions, readCredits });

  // The dashboard proves a wallet with its own purpose-bound challenge, so a
  // signature collected for a room can never be replayed to mint API keys.
  const challenges = createChallengeStore({
    origin,
    chainId,
    deploymentId,
    contractAddress: rentalConfig.contractAddress,
    purpose: "Archava session access",
  });
  const dashboardChallenges = createChallengeStore({
    origin,
    chainId,
    deploymentId,
    contractAddress: rentalConfig.contractAddress,
    purpose: "Archava developer dashboard access",
  });
  const sessionTickets = new Map();
  const creatingSessions = new Set();
  // A Secure cookie is silently dropped over plain HTTP, so it is set only for an
  // HTTPS origin; local development keeps the insecure cookie on /api/developer.
  const cookieOptions = { secure: false };
  try {
    const site = new URL(origin);
    if (site.protocol === "https:") {
      cookieOptions.secure = true;
    }
  } catch { /* Keep the local HTTP default when WEB_ORIGIN is not a URL. */ }
  const dashboardSessions = createDashboardSessionStore(cookieOptions);
  const developerApi = createDeveloperApi({
    dashboard: {
      resolve(cookieHeader) {
        // A dashboard login is its own short-lived session, not a room ticket: a
        // visitor holding a preview ticket has proved nothing about a wallet.
        const wallet = dashboardSessions.resolve(cookieHeader);
        return wallet ? { wallet } : null;
      },
    },
    keys,
    readCredits,
    usage,
  });

  const previewController = createPreviewController({
    enabled: env.ENABLE_PREVIEW === "true",
    seconds: previewSeconds,
    now: Date.now,
    openRoom: async ({ endsAt }) => {
      if (!rooms) throw new Error("LiveKit is not configured");
      return openPreviewRoom({ 
        endsAt, 
        dispatchService, 
        roomService, 
        rooms, 
        agentName, 
        livekitKey, 
        livekitSecret,
        deploymentId
      });
    },
    sessionFields: { serverUrl: livekitUrl, avatarProvider, spatiusAppId, spatiusAvatarId },
    onSession: (ticket, session) => sessionTickets.set(ticket, session),
  });

  const envioUrl = env.ENVIO_GRAPHQL_URL || "";
  const envioApiKey = env.ENVIO_API_KEY || "";
  const purchases = createPurchaseHistoryService({
    envioUrl,
    envioApiKey,
    chainId,
    contractAddress: canonicalRental || "0x7324a2678e74052a4e9a244c0d57b56b23fee6ad",
    deploymentBlock: rentalConfig.deploymentBlock || 70191614,
    purchaseCache,
  });

  return {
    checkReadiness: createReadinessCheck({ workerHealthUrl: env.ARCHAVA_WORKER_HEALTH_URL }),
    /** Closes LiveKit rooms whose metadata says their time is up. */
    closeExpiredRooms: async () => {
      if (!roomService) return [];
      const listed = await roomService.listRooms();
      const nowSeconds = Math.floor(Date.now() / 1000);
      const closed = [];
      for (const room of listed) {
        let meta;
        try { meta = JSON.parse(room.metadata || "{}"); } catch { continue; }
        
        // Only process Archava rooms with our exact deploymentId
        if (meta.product !== "archava") continue;
        
        // Only process rooms for this deployment - require exact match
        const roomDeploymentId = meta.deploymentId;
        if (!roomDeploymentId) {
          // Missing deploymentId - ignore (could be legacy or foreign room)
          continue;
        }
        if (roomDeploymentId !== deploymentId) {
          // Foreign deployment - ignore
          continue;
        }
        
        if (!Number.isFinite(meta.endsAt)) continue;
        
        if (meta.endsAt <= nowSeconds) {
          await roomService.deleteRoom(room.name).catch((error) => {
            if (error.status === 404 || error.code === "not_found") return;
            console.error("Failed to close expired room:", room.name, error);
          });
          closed.push(room.name);
        }
      }
      return closed;
    },
    networkConfig,
    deploymentTargets,
    deploymentId,
    deploymentBlock: rentalConfig.deploymentBlock || (rentalConfig.contractAddress ? 70191614 : 0),
    origin,
    allowedOrigins,
    distDir: resolve(cwd, DIST_DIR),
    chainId,
    contractAddress: rentalConfig.contractAddress,
    paymentTokenAddress: rentalConfig.tokenAddress,
    paymentTokenSymbol: "mUSDT",
    blockExplorer: networkConfig.blockExplorer,
    livekitUrl,
    avatarProvider,
    spatiusAppId,
    spatiusAvatarId,
    previewSeconds,
    packMinutes,
    rooms,
    roomService,
    challenges,
    dashboardChallenges,
    dashboardSessions,
    developerApi,
    customerApi,
    // The sweep in `index.mjs` closes abandoned paid rooms on its tick, so the
    // instance it must reach has to be on the object `createDependencies`
    // returns — building it internally was not enough.
    customerSessions,
    usage,
    readCredits,
    quotePack,
    previewController,
    sessionTickets,
    creatingSessions,
    scanner,
    purchaseCache,
    purchases,
    connection,
    verifyOnchain: async ({ onProgress = () => {} } = {}) => {
      if (!rentalConfig.contractAddress || !connection) {
        return false;
      }
      onProgress("Validating persistent state stores scope...");
      if (keys?.ready) await keys.ready();
      if (usage?.ready) await usage.ready();
      else if (usage?.load) await usage.load();
      if (purchaseCache?.load) await purchaseCache.load();

      await verifyMonadConnection(connection, { onProgress });
      return true;
    },
    // A shared proxy IP would otherwise cap preview usage for everyone behind it.
    rateLimitKey: (req) => req.socket.remoteAddress || "unknown",
  };
}

/**
 * The anonymous preview room: a fresh guest identity, a short token, and the
 * host agent dispatched only once the automatic dispatches are gone.
 */
async function openPreviewRoom({ endsAt, dispatchService, roomService, rooms, agentName, livekitKey, livekitSecret, deploymentId }) {
  if (!deploymentId) {
    throw new Error("deploymentId is required for room isolation");
  }
  
  const roomName = "archava-" + randomBytes(12).toString("hex");
  const nowSec = Math.floor(Date.now() / 1000);
  const token = new AccessToken(livekitKey, livekitSecret, {
    identity: "guest-" + randomBytes(8).toString("hex"),
    name: "Archava guest",
    ttl: Math.max(30, Math.min(300, endsAt - nowSec)),
  });
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canPublishData: true,
    canSubscribe: true,
  });
  const jwt = await token.toJwt();
  await roomService.createRoom({
    name: roomName,
    emptyTimeout: 60,
    departureTimeout: 30,
    maxParticipants: 4,
    metadata: JSON.stringify({ 
      product: "archava", 
      preview: true, 
      endsAt,
      deploymentId 
    }),
  });
  try {
    const automaticDispatches = (await dispatchService.listDispatch(roomName)).filter((dispatch) => !dispatch.agentName);
    for (const dispatch of automaticDispatches) {
      await dispatchService.deleteDispatch(dispatch.id, roomName);
    }
    await dispatchService.createDispatch(roomName, agentName);
    await removeAutomaticAgents(roomName, roomService, automaticDispatches);
  } catch (error) {
    await roomService.deleteRoom(roomName).catch(() => {});
    throw error;
  }
  return { roomName, token: jwt };
}

export { SWEEP_INTERVAL_MS, createApp };
