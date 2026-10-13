import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "./app.mjs";
import { createDependencies, SWEEP_INTERVAL_MS } from "./dependencies.mjs";
import { verifyApiStartup } from "./startup.mjs";
import { runtimeErrorMessage } from "./rpc-budget.mjs";

/**
 * Process bootstrap for the Archava API.
 *
 * Everything about how the service answers a request lives in `app.mjs`; this
 * file only reads the environment once, starts the periodic sweep, and listens.
 * That split is what lets the tests drive the identical handler over a real
 * socket: they call `createApp` with fakes, and they never import this module.
 */

// `process.loadEnvFile` is version-gated (Node 20.12+). The capability is checked
// before the file is, so an older runtime starts with its inherited environment
// instead of throwing a TypeError on a function that does not exist.
if (typeof process.loadEnvFile === "function" && existsSync(resolve(".env"))) {
  process.loadEnvFile(resolve(".env"));
}

const port = Number(process.env.PORT || 5002);
let dependencies;
try {
  dependencies = createDependencies({ env: process.env, cwd: process.cwd() });
} catch (error) {
  if (error.name === "RuntimeValidationError") {
    console.error("\n❌ Runtime Validation Error:", error.message, "\n");
    if (error.context && Object.keys(error.context).length > 0) {
      console.error("Context:", JSON.stringify(error.context, null, 2));
    }
    process.exit(1);
  }
  throw error;
}

if (dependencies.verifyOnchain) {
  try {
    await verifyApiStartup(dependencies);
  } catch (error) {
    console.error("\n❌ Onchain Monad Verification Error:", runtimeErrorMessage(error), "\n");
    process.exit(1);
  }
}

const app = createApp(dependencies);

createServer(app.handle).listen(port, () => {
  console.log(`[Startup] Step 3: Archava API listening on :${port}`);
  if (dependencies.scanner?.startBackgroundSync) {
    console.log("[Startup] Step 4: Starting background purchase history sync...");
    dependencies.scanner.startBackgroundSync();
  }
});

setInterval(() => {
  const nowMs = Date.now();
  // Every collaborator that keeps expiring state prunes itself on the same tick,
  // so an abandoned preview or a paid room at its reserved-time cap both close.
  dependencies.challenges.prune();
  dependencies.dashboardChallenges.prune();
  dependencies.dashboardSessions.prune();
  app.pruneRateBuckets();
  for (const [ticket, session] of dependencies.sessionTickets) {
    if (session.endsAt * 1000 < nowMs) dependencies.sessionTickets.delete(ticket);
  }
  void dependencies.customerSessions.sweep().catch((error) => {
    console.error("Customer session sweep failed:", error);
  });
  void dependencies.closeExpiredRooms().catch((error) => {
    console.error("Room expiry sweep failed:", error);
  });
}, SWEEP_INTERVAL_MS).unref();
