import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getAddress, isAddress } from "ethers";
import {
  isRateLimitError,
  isTimeoutError,
  isRangeTooLargeError,
  runtimeErrorMessage,
  positiveInteger,
} from "./rpc-budget.mjs";

/**
 * Normalizes a wallet address to checksum format.
 */
function normalizeAddress(value) {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`Invalid address: ${value}`);
  }
  return getAddress(value);
}

export function isValidBlockHash(hash) {
  return typeof hash === "string" && hash.startsWith("0x") && hash.length >= 3;
}

/**
 * Validates that an object satisfies the minimum deployment scope.
 */
export function validateScope(actual, expected) {
  if (!actual || typeof actual !== "object") {
    throw new Error("Missing or invalid deployment scope");
  }
  if (!expected || typeof expected !== "object") {
    throw new Error("Missing expected deployment scope for validation");
  }

  if (actual.deploymentId !== expected.deploymentId) {
    throw new Error(
      `Deployment ID mismatch: cache has "${actual.deploymentId}", expected "${expected.deploymentId}"`
    );
  }
  if (Number(actual.chainId) !== Number(expected.chainId)) {
    throw new Error(
      `Chain ID mismatch: cache has ${actual.chainId}, expected ${expected.chainId}`
    );
  }
  if (normalizeAddress(actual.rentalContract) !== normalizeAddress(expected.rentalContract)) {
    throw new Error(
      `Rental contract mismatch: cache has ${actual.rentalContract}, expected ${expected.rentalContract}`
    );
  }
  if (normalizeAddress(actual.paymentToken) !== normalizeAddress(expected.paymentToken)) {
    throw new Error(
      `Payment token mismatch: cache has ${actual.paymentToken}, expected ${expected.paymentToken}`
    );
  }
}

/**
 * Formulates a unique deduplication key for an onchain event.
 */
export function buildEventKey(chainId, rentalAddress, txHash, logIndex) {
  return `${Number(chainId)}:${normalizeAddress(rentalAddress)}:${String(txHash).toLowerCase()}:${Number(logIndex)}`;
}

export class RecoverableScanError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = "RecoverableScanError";
    this.context = context;
    this.code = context.code || "credit_sync_unavailable";
    this.status = context.status || 503;
    this.recoverable = true;
  }
}

/**
 * Durable incremental purchase cache stored as JSON.
 * Single-writer constraint: designed for one Node process instance.
 */
export function createPurchaseCache({ path, scope, now = Date.now } = {}) {
  let loaded = false;
  let loadPromise = null;
  let tail = Promise.resolve();

  // Internal state
  let state = {
    schemaVersion: 1,
    scope: scope ? {
      deploymentId: scope.deploymentId,
      chainId: Number(scope.chainId),
      rentalContract: normalizeAddress(scope.rentalContract),
      paymentToken: normalizeAddress(scope.paymentToken),
    } : null,
    cursor: {
      lastFinalizedBlock: null,
      lastFinalizedBlockHash: null,
    },
    totals: {}, // wallet -> purchasedMinutes (number)
    processedEvents: [], // Array of string event keys
    eventDetails: {}, // eventKey -> { wallet, txHash, logIndex, chainId, rentalContract, includedMinutes, blockNumber }
    lastSyncedAt: null,
    lastSuccessfulFullSyncAt: null,
  };

  async function load() {
    if (loaded) return state;
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
      let raw;
      try {
        raw = await readFile(path, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") {
          loaded = true;
          return state;
        }
        throw error;
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("Purchase cache is corrupt; paid access is paused");
      }

      // Check schema version and deployment scope
      if (!parsed.schemaVersion || parsed.schemaVersion !== 1) {
        throw new Error("Purchase cache has unsupported schemaVersion; paid access is paused");
      }

      if (!parsed.scope) {
        throw new Error("Purchase cache has no deployment scope; legacy state cannot be used");
      }

      if (scope) {
        validateScope(parsed.scope, scope);
      }

      if (parsed.cursor) {
        const blk = parsed.cursor.lastFinalizedBlock;
        const hash = parsed.cursor.lastFinalizedBlockHash;
        if (blk != null) {
          if (!Number.isSafeInteger(Number(blk)) || Number(blk) < 0) {
            throw new Error("Purchase cache cursor has invalid lastFinalizedBlock; paid access is paused");
          }
          if (!isValidBlockHash(hash)) {
            throw new Error("Purchase cache cursor has missing or invalid lastFinalizedBlockHash; paid access is paused");
          }
        }
      }

      state = {
        schemaVersion: parsed.schemaVersion,
        scope: parsed.scope,
        cursor: {
          lastFinalizedBlock: parsed.cursor?.lastFinalizedBlock != null ? Number(parsed.cursor.lastFinalizedBlock) : null,
          lastFinalizedBlockHash: parsed.cursor?.lastFinalizedBlockHash || null,
        },
        totals: parsed.totals && typeof parsed.totals === "object" ? parsed.totals : {},
        processedEvents: Array.isArray(parsed.processedEvents) ? parsed.processedEvents : [],
        eventDetails: parsed.eventDetails && typeof parsed.eventDetails === "object" ? parsed.eventDetails : {},
        lastSyncedAt: parsed.lastSyncedAt || null,
        lastSuccessfulFullSyncAt: parsed.lastSuccessfulFullSyncAt || null,
      };

      loaded = true;
      return state;
    })();

    return loadPromise;
  }

  async function flush() {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await rename(tmp, path);
  }

  function mutate(action) {
    const run = tail.then(async () => {
      await load();
      const previous = structuredClone(state);
      try {
        const result = action();
        await flush();
        return result;
      } catch (error) {
        state = previous;
        throw error;
      }
    });
    tail = run.catch(() => {});
    return run;
  }

  async function read(action) {
    await tail;
    await load();
    return action();
  }

  function getPurchasedMinutes(walletInput) {
    const wallet = normalizeAddress(walletInput);
    return state.totals[wallet] || 0;
  }

  function getCursor() {
    return { ...state.cursor };
  }

  function hasEvent(eventKey) {
    return state.processedEvents.includes(eventKey);
  }

  function hasTx(txHash, expectedWallet) {
    if (typeof txHash !== "string") return false;
    const cleanHash = txHash.toLowerCase();
    const needle = `:${cleanHash}:`;
    const matching = state.processedEvents.filter((key) => key.toLowerCase().includes(needle));
    if (matching.length === 0) return false;
    if (!expectedWallet) return true;
    try {
      const targetWallet = normalizeAddress(expectedWallet);
      return matching.some((key) => state.eventDetails?.[key]?.wallet === targetWallet);
    } catch {
      return false;
    }
  }

  async function isTxCreditedForWallet(txHash, expectedWallet, { provider, rentalContract } = {}) {
    await load();
    if (typeof txHash !== "string" || !isAddress(expectedWallet)) return false;
    const cleanHash = txHash.toLowerCase();
    const needle = `:${cleanHash}:`;

    const matchingKeys = state.processedEvents.filter((key) => key.toLowerCase().includes(needle));
    if (matchingKeys.length === 0) {
      return false; // Not yet indexed in finalized cache
    }

    const targetWallet = normalizeAddress(expectedWallet);

    // 1. Check in verified eventDetails in state
    for (const key of matchingKeys) {
      const detail = state.eventDetails?.[key];
      if (detail && detail.wallet === targetWallet) {
        return true;
      }
    }

    const allHaveDetails = matchingKeys.every((k) => state.eventDetails?.[k]);
    if (allHaveDetails && matchingKeys.length > 0) {
      return false; // All processed events for this tx belong to other wallets
    }

    // 2. Bounded receipt/event verification if provider and rentalContract are supplied
    if (provider && rentalContract) {
      const canonicalRental = normalizeAddress(
        rentalContract.target || rentalContract.address || state.scope?.rentalContract
      );

      let receipt;
      try {
        receipt = await provider.getTransactionReceipt(cleanHash);
      } catch (err) {
        throw new RecoverableScanError(
          `RPC error querying transaction receipt: ${err.message || String(err)}`,
          { code: "credit_sync_unavailable", cause: err }
        );
      }

      if (!receipt || receipt.status !== 1) {
        return false;
      }

      // Must be finalized!
      if (state.cursor.lastFinalizedBlock != null && Number(receipt.blockNumber) > state.cursor.lastFinalizedBlock) {
        return false;
      }

      let matched = false;
      for (const log of receipt.logs || []) {
        if (normalizeAddress(log.address) !== canonicalRental) continue;
        let parsed;
        try {
          parsed = rentalContract.interface.parseLog(log);
        } catch {
          continue;
        }
        if (!parsed || parsed.name !== "AccessRented") continue;

        const logWallet = normalizeAddress(parsed.args.wallet);
        const eventKey = buildEventKey(
          state.scope?.chainId || 10143,
          canonicalRental,
          cleanHash,
          log.index
        );

        if (!state.eventDetails) state.eventDetails = {};
        state.eventDetails[eventKey] = {
          wallet: logWallet,
          txHash: cleanHash,
          logIndex: Number(log.index),
          chainId: Number(state.scope?.chainId || 10143),
          rentalContract: canonicalRental,
          includedMinutes: Number(parsed.args.includedMinutes),
          blockNumber: Number(receipt.blockNumber),
        };

        if (logWallet === targetWallet && state.processedEvents.includes(eventKey)) {
          matched = true;
        }
      }

      return matched;
    }

    return false;
  }

  async function commitBatch({
    lastFinalizedBlock,
    lastFinalizedBlockHash,
    newEvents = [],
    newTotals = {},
    isFullSync = false,
    eventDetails = [],
  }) {
    if (lastFinalizedBlock != null) {
      if (!Number.isSafeInteger(Number(lastFinalizedBlock)) || Number(lastFinalizedBlock) < 0) {
        throw new Error("commitBatch requires a positive integer lastFinalizedBlock");
      }
      if (!isValidBlockHash(lastFinalizedBlockHash)) {
        throw new Error("commitBatch requires a valid lastFinalizedBlockHash");
      }
    }
    return mutate(() => {
      if (lastFinalizedBlock != null) {
        state.cursor.lastFinalizedBlock = Number(lastFinalizedBlock);
        state.cursor.lastFinalizedBlockHash = String(lastFinalizedBlockHash);
      }
      for (const [wallet, minutes] of Object.entries(newTotals)) {
        state.totals[wallet] = (state.totals[wallet] || 0) + Number(minutes);
      }
      for (const key of newEvents) {
        if (!state.processedEvents.includes(key)) {
          state.processedEvents.push(key);
        }
      }
      if (!state.eventDetails) state.eventDetails = {};
      for (const item of eventDetails) {
        if (item && item.eventKey) {
          state.eventDetails[item.eventKey] = {
            wallet: normalizeAddress(item.wallet),
            txHash: String(item.txHash).toLowerCase(),
            logIndex: Number(item.logIndex),
            chainId: Number(item.chainId),
            rentalContract: normalizeAddress(item.rentalAddress || item.rentalContract),
            includedMinutes: Number(item.includedMinutes),
            blockNumber: item.blockNumber != null ? Number(item.blockNumber) : undefined,
          };
        }
      }
      state.lastSyncedAt = new Date(now()).toISOString();
      if (isFullSync) {
        state.lastSuccessfulFullSyncAt = state.lastSyncedAt;
      }
      return {
        lastFinalizedBlock: state.cursor.lastFinalizedBlock,
        lastFinalizedBlockHash: state.cursor.lastFinalizedBlockHash,
        lastSyncedAt: state.lastSyncedAt,
        lastSuccessfulFullSyncAt: state.lastSuccessfulFullSyncAt,
      };
    });
  }

  async function recordSuccessfulSync() {
    return mutate(() => {
      state.lastSyncedAt = new Date(now()).toISOString();
      state.lastSuccessfulFullSyncAt = state.lastSyncedAt;
      return {
        lastSyncedAt: state.lastSyncedAt,
        lastSuccessfulFullSyncAt: state.lastSuccessfulFullSyncAt,
      };
    });
  }

  function isFresh(maxStalenessMs = 60_000, currentTime = now()) {
    if (!state.lastSuccessfulFullSyncAt) return false;
    const syncTime = new Date(state.lastSuccessfulFullSyncAt).getTime();
    if (!Number.isFinite(syncTime)) return false;
    const elapsed = currentTime - syncTime;
    return elapsed >= 0 && elapsed <= maxStalenessMs;
  }

  return {
    load,
    flush,
    read,
    getPurchasedMinutes: (wallet) => read(() => getPurchasedMinutes(wallet)),
    getCursor: () => read(() => getCursor()),
    hasEvent: (key) => read(() => hasEvent(key)),
    hasTx: (txHash, expectedWallet) => read(() => hasTx(txHash, expectedWallet)),
    isTxCreditedForWallet: (txHash, expectedWallet, opts) => isTxCreditedForWallet(txHash, expectedWallet, opts),
    commitBatch,
    recordSuccessfulSync,
    getLastSuccessfulFullSyncAt: () => read(() => state.lastSuccessfulFullSyncAt),
    isFresh: (maxStalenessMs, currentTime) => read(() => isFresh(maxStalenessMs, currentTime)),
    getState: () => read(() => structuredClone(state)),
  };
}

/**
 * Incremental RPC scanner for Monad Testnet AccessRented events.
 */
class ScanBudgetExceededError extends Error {
  constructor(reason) {
    super(`Purchase scan ${reason} budget reached`);
    this.name = "ScanBudgetExceededError";
  }
}

export function createPurchaseScanner({
  provider,
  rentalContract,
  rentalAddress: rawRentalAddress,
  paymentTokenAddress,
  chainId,
  deploymentBlock = 70191614,
  purchaseCache,
  pageSize = 100,
  maxPagesPerSync = 20,
  maxRequestsPerSync = 50,
  maxDurationMsPerSync = 10_000,
  maxRetries = 3,
  retryDelayMs = 500,
  now = Date.now,
  log = console.log,
} = {}) {
  const rentalAddress = normalizeAddress(
    rawRentalAddress || rentalContract?.target || rentalContract?.address
  );
  let activeSyncPromise = null;
  let activeSyncContext = null;
  let backgroundTimer = null;
  let lastError = null;
  // Remember a smaller range learned from this provider for subsequent passes.
  let effectivePageSize = positiveInteger(pageSize, 100, "ARCHAVA_SCANNER_PAGE_SIZE");

  /**
   * Determine the current finalized block number.
   * Monad Testnet natively supports "finalized" block tag.
   */
  async function getFinalizedBlockInfo(context) {
    let block;
    try {
      block = await context.request(() => provider.getBlock("finalized"));
    } catch (err) {
      if (err instanceof ScanBudgetExceededError) throw err;
      throw new RecoverableScanError(
        `RPC error querying finalized block: ${err.message || String(err)}`,
        { code: "credit_sync_unavailable", cause: err }
      );
    }

    if (
      !block ||
      !Number.isSafeInteger(Number(block.number)) ||
      !isValidBlockHash(block.hash)
    ) {
      throw new RecoverableScanError(
        "RPC returned invalid or malformed finalized block",
        { code: "credit_sync_unavailable" }
      );
    }

    return { number: Number(block.number), hash: block.hash };
  }

  /**
   * Fetch logs in a specific range with bounded retry on rate-limit (429)
   * and adaptive recursive splitting strictly on block range / response-size errors.
   */
  async function fetchLogsAdaptive(fromBlock, toBlock, depth = 0, context) {
    if (fromBlock > toBlock) return [];
    if (context.isAborted?.()) {
      throw new RecoverableScanError("Sync operation was aborted");
    }

    const eventTopic =
      rentalContract?.interface?.getEvent?.("AccessRented")?.topicHash ||
      rentalContract?.filters?.AccessRented?.fragment?.topicHash ||
      "0xb4054fd02cbdc36fc1dba2c1f9c83337e36f34f42048985882b46e04960496a8";

    let attempt = 0;
    while (true) {
      if (context.isAborted?.()) {
        throw new RecoverableScanError("Sync operation was aborted");
      }
      attempt++;

      try {
        const logs = await context.request(() => provider.getLogs({
          address: rentalAddress,
          topics: [eventTopic],
          fromBlock,
          toBlock,
        }));
        return logs;
      } catch (error) {
        if (error instanceof ScanBudgetExceededError) throw error;
        if (context.isAborted?.()) {
          throw new RecoverableScanError("Sync operation was aborted");
        }

        // 1. Rate-limit (429): bounded retry with exponential backoff; DO NOT split range into more requests
        if (isRateLimitError(error)) {
          if (attempt <= maxRetries) {
            const delay = retryDelayMs * Math.pow(2, attempt - 1);
            await context.sleep(delay);
            continue;
          }
          throw error;
        }

        // 2. Timeout: fail boundedly without splitting
        if (isTimeoutError(error)) {
          throw error;
        }

        // 3. Range too large / response size: bounded adaptive splitting
        if (isRangeTooLargeError(error) && fromBlock < toBlock && depth < 6) {
          effectivePageSize = Math.min(effectivePageSize, Math.max(1, Math.floor((toBlock - fromBlock + 1) / 2)));
          const mid = Math.floor((fromBlock + toBlock) / 2);
          const leftLogs = await fetchLogsAdaptive(fromBlock, mid, depth + 1, context);
          const rightLogs = await fetchLogsAdaptive(mid + 1, toBlock, depth + 1, context);
          return [...leftLogs, ...rightLogs];
        }

        throw error;
      }
    }
  }

  /**
   * Perform single-flight incremental sync up to current finalized block with budget constraints.
   */
  async function sync(options = {}) {
    if (activeSyncPromise) {
      return activeSyncPromise;
    }

    const maxPages = positiveInteger(options.maxPages, maxPagesPerSync, "ARCHAVA_SCANNER_MAX_PAGES");
    const maxRequests = positiveInteger(options.maxRequests, maxRequestsPerSync, "ARCHAVA_SCANNER_MAX_REQUESTS");
    const maxDurationMs = positiveInteger(options.maxDurationMs, maxDurationMsPerSync, "ARCHAVA_SCANNER_MAX_DURATION_MS");
    const startTime = now();
    const deadline = startTime + maxDurationMs;
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const progress = { fromBlock: null, toBlock: null, finalizedHead: null, newEventsCount: 0 };
    const context = {
      requestCount: 0,
      isAborted: () => signal.aborted,
      assertRunning() {
        if (signal.aborted) throw new RecoverableScanError("Sync operation was aborted");
        if (now() >= deadline) throw new ScanBudgetExceededError("time");
      },
      assertCanRequest() {
        this.assertRunning();
        if (this.requestCount >= maxRequests) throw new ScanBudgetExceededError("request");
      },
      async wait(work) {
        this.assertRunning();
        let timer;
        let onAbort;
        try {
          const value = await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new ScanBudgetExceededError("time")), deadline - now());
            onAbort = () => reject(new RecoverableScanError("Sync operation was aborted"));
            signal.addEventListener("abort", onAbort, { once: true });
            Promise.resolve().then(work).then(resolve, reject);
          });
          this.assertRunning();
          return value;
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
        }
      },
      async request(work) {
        this.assertCanRequest();
        this.requestCount++;
        return this.wait(work);
      },
      async sleep(delay) {
        this.assertCanRequest();
        let retryTimer;
        try {
          await this.wait(() => new Promise((resolve) => {
            retryTimer = setTimeout(resolve, delay);
          }));
        } finally {
          clearTimeout(retryTimer);
        }
      },
    };
    activeSyncContext = { abort: () => controller.abort() };

    activeSyncPromise = (async () => {
      try {
        await purchaseCache.load();
        const cursor = await purchaseCache.getCursor();
        progress.fromBlock = cursor.lastFinalizedBlock != null ? cursor.lastFinalizedBlock + 1 : Number(deploymentBlock);
        progress.toBlock = progress.fromBlock - 1;
        const finalized = await getFinalizedBlockInfo(context);
        progress.finalizedHead = finalized.number;

        if (context.isAborted()) {
          throw new RecoverableScanError("Sync operation was aborted");
        }

        // 1. Invariant: Cursor block cannot be ahead of finalized head
        if (cursor.lastFinalizedBlock != null && cursor.lastFinalizedBlock > finalized.number) {
          throw new RecoverableScanError(
            `Cursor block (${cursor.lastFinalizedBlock}) is ahead of finalized head (${finalized.number}); RPC node may be lagging or state invalid`,
            {
              code: "credit_sync_unavailable",
              cursorBlock: cursor.lastFinalizedBlock,
              finalizedBlock: finalized.number,
            }
          );
        }

        // 2. Invariant: Cursor block hash verification against RPC
        if (cursor.lastFinalizedBlock != null && cursor.lastFinalizedBlockHash != null) {
          let cursorBlockOnchain;
          try {
            cursorBlockOnchain = await context.request(() => provider.getBlock(cursor.lastFinalizedBlock));
          } catch (err) {
            if (err instanceof ScanBudgetExceededError) throw err;
            throw new RecoverableScanError(
              `Failed to fetch cursor block ${cursor.lastFinalizedBlock} for hash verification: ${err.message || String(err)}`,
              { code: "credit_sync_unavailable", cause: err }
            );
          }

          if (!cursorBlockOnchain || cursorBlockOnchain.hash !== cursor.lastFinalizedBlockHash) {
            throw new RecoverableScanError(
              `Cursor block hash mismatch at block ${cursor.lastFinalizedBlock}: expected ${cursor.lastFinalizedBlockHash}, got ${cursorBlockOnchain?.hash}`,
              {
                code: "credit_sync_unavailable",
                blockNumber: cursor.lastFinalizedBlock,
                expectedHash: cursor.lastFinalizedBlockHash,
                actualHash: cursorBlockOnchain?.hash,
              }
            );
          }
        }

        const fromBlock = cursor.lastFinalizedBlock != null
          ? cursor.lastFinalizedBlock + 1
          : Number(deploymentBlock);

        if (fromBlock > finalized.number) {
          // Already fully synced to finalized block
          context.assertRunning();
          await purchaseCache.recordSuccessfulSync();
          lastError = null;
          return {
            synced: true,
            fromBlock,
            toBlock: finalized.number,
            newEventsCount: 0,
          };
        }

        let currentFrom = fromBlock;
        let totalNewEvents = 0;
        let pagesDone = 0;

        while (currentFrom <= finalized.number) {
          if (context.isAborted()) {
            throw new RecoverableScanError("Sync operation was aborted before page commit");
          }

          context.assertRunning();
          if (pagesDone >= maxPages) throw new ScanBudgetExceededError("page");
          const pageFrom = currentFrom;
          const currentTo = Math.min(currentFrom + effectivePageSize - 1, finalized.number);
          const logs = await fetchLogsAdaptive(currentFrom, currentTo, 0, context);

          if (context.isAborted()) {
            throw new RecoverableScanError("Sync operation was aborted; refusing late commit");
          }

          const newEvents = [];
          const newTotals = {};
          const eventDetails = [];

          for (const logItem of logs) {
            let parsed;
            try {
              parsed = rentalContract?.interface?.parseLog(logItem);
            } catch {
              continue;
            }

            if (!parsed || parsed.name !== "AccessRented") continue;

            const wallet = normalizeAddress(parsed.args.wallet);
            const includedMinutes = Number(parsed.args.includedMinutes);
            const eventKey = buildEventKey(chainId, rentalAddress, logItem.transactionHash, logItem.index);

            // Deduplication check
            const alreadyProcessed = await purchaseCache.hasEvent(eventKey);
            if (alreadyProcessed || newEvents.includes(eventKey)) {
              continue;
            }

            newEvents.push(eventKey);
            newTotals[wallet] = (newTotals[wallet] || 0) + includedMinutes;
            eventDetails.push({
              eventKey,
              wallet,
              txHash: logItem.transactionHash,
              logIndex: logItem.index,
              chainId,
              rentalAddress,
              includedMinutes,
              blockNumber: logItem.blockNumber,
            });
          }

          let toBlockHash;
          if (currentTo === finalized.number) {
            toBlockHash = finalized.hash;
          } else {
            let pageBlock;
            try {
              pageBlock = await context.request(() => provider.getBlock(currentTo));
            } catch (err) {
              if (err instanceof ScanBudgetExceededError) throw err;
              throw new RecoverableScanError(
                `Failed to fetch block ${currentTo} for page commit: ${err.message || String(err)}`,
                { code: "credit_sync_unavailable", cause: err }
              );
            }
            if (!pageBlock || !isValidBlockHash(pageBlock.hash)) {
              throw new RecoverableScanError(
                `Invalid or missing hash for block ${currentTo}`,
                { code: "credit_sync_unavailable" }
              );
            }
            toBlockHash = pageBlock.hash;
          }

          context.assertRunning();

          const isFullSync = currentTo === finalized.number;

          // Advance cursor atomically for this page
          await purchaseCache.commitBatch({
            lastFinalizedBlock: currentTo,
            lastFinalizedBlockHash: toBlockHash,
            newEvents,
            newTotals,
            isFullSync,
            eventDetails,
          });

          pagesDone++;
          totalNewEvents += newEvents.length;
          currentFrom = currentTo + 1;
          progress.toBlock = currentTo;
          progress.newEventsCount = totalNewEvents;

          log(
            `[Scanner] Processed blocks ${pageFrom}-${currentTo}/${finalized.number} (+${newEvents.length} events, cursor: ${currentTo})`
          );
        }

        // The final atomic page commit already recorded the successful full sync.
        lastError = null;
        log(`[Scanner] Caught up to finalized head ${finalized.number} (+${totalNewEvents} total events).`);
        return {
          synced: true,
          fromBlock,
          toBlock: finalized.number,
          newEventsCount: totalNewEvents,
        };
      } catch (err) {
        if (err instanceof ScanBudgetExceededError) {
          lastError = null;
          log(`[Scanner] ${err.message} (${context.requestCount} requests). Cursor: ${progress.toBlock}, Finalized head: ${progress.finalizedHead}. Will resume on next cycle.`);
          return { synced: false, partial: true, ...progress };
        }
        lastError = runtimeErrorMessage(err);
        if (err instanceof RecoverableScanError) {
          throw err;
        }
        throw new RecoverableScanError(
          `Failed to sync onchain purchase events: ${lastError}`,
          { code: "credit_sync_unavailable", error: lastError }
        );
      } finally {
        activeSyncPromise = null;
        activeSyncContext = null;
      }
    })();

    return activeSyncPromise;
  }

  function startBackgroundSync(intervalMs = 15_000) {
    if (backgroundTimer) return;
    // Immediate initial sync pass
    void sync().catch((err) => {
      console.warn(`[Background Scanner] Initial sync pass: ${runtimeErrorMessage(err)}`);
    });
    backgroundTimer = setInterval(() => {
      void sync().catch((err) => {
        console.warn(`[Background Scanner] Periodic sync pass: ${runtimeErrorMessage(err)}`);
      });
    }, intervalMs);
    backgroundTimer.unref();
  }

  function stopBackgroundSync() {
    if (backgroundTimer) {
      clearInterval(backgroundTimer);
      backgroundTimer = null;
    }
    if (activeSyncContext) {
      activeSyncContext.abort();
    }
  }

  return {
    sync,
    startBackgroundSync,
    stopBackgroundSync,
    getLastError: () => lastError,
    isSyncing: () => activeSyncPromise !== null,
    isFresh: async (maxStalenessMs = 60_000) => {
      if (lastError) return false;
      return await purchaseCache.isFresh(maxStalenessMs);
    },
    provider,
    rentalContract,
  };
}
