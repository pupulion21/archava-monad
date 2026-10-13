import { withDeadline, runtimeErrorMessage } from "./rpc-budget.mjs";

export async function verifyApiStartup(dependencies, { timeoutMs = 20_000, log = console.log } = {}) {
  if (!dependencies.verifyOnchain) return;
  log("[Startup] Step 1: Validating saved state and Monad contracts...");
  try {
    await withDeadline(
      () => dependencies.verifyOnchain({ onProgress: (message) => log(`[Startup] ${message}`) }),
      timeoutMs,
      "Monad startup verification",
    );
    log("[Startup] Step 2: Onchain verification passed. HTTP API ready to listen.");
  } catch (error) {
    const safeMsg = runtimeErrorMessage(error);
    log(`[Startup] Verification failed: ${safeMsg}`);
    throw error;
  }
}
