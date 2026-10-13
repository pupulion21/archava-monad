import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createPurchaseCache, createPurchaseScanner, RecoverableScanError } from "./purchase-cache.mjs";
import { createKeyStore } from "./apikeys.mjs";
import { createUsageStore } from "./usage.mjs";
import { withDeadline, isRateLimitError, isRangeTooLargeError, runtimeErrorMessage } from "./rpc-budget.mjs";
import { verifyApiStartup } from "./startup.mjs";
import { verifyMonadConnection, createCreditReader } from "./rental.mjs";
import { createEntitlementGate } from "./entitlement.mjs";
import { createDependencies } from "./dependencies.mjs";
import { createApp } from "./app.mjs";

const MONAD_SCOPE = {
  deploymentId: "archava-monad",
  chainId: 10143,
  rentalContract: "0x7324a2678e74052a4e9a244c0d57b56b23fee6ad",
  paymentToken: "0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c",
};

const ALICE = "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC";
const BOB = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "archava-runtime-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("1. Histori besar tidak menghalangi API membuka port setelah bootstrap valid", async () => {
  await withTempDir(async (dir) => {
    const cachePath = join(dir, "purchase-cache.json");
    const keysPath = join(dir, "keys.json");
    const usagePath = join(dir, "usage.json");

    const purchaseCache = createPurchaseCache({ path: cachePath, scope: MONAD_SCOPE });
    const keys = createKeyStore({ path: keysPath, scope: MONAD_SCOPE });
    const usage = createUsageStore({ path: usagePath, scope: MONAD_SCOPE });

    // Mock scanner that simulates a huge backlog / slow scanning
    let scanCalled = false;
    let scanFinished = false;
    let scanTimer = null;
    const scanner = {
      sync: async () => {
        scanCalled = true;
        // simulate slow scan
        await new Promise((resolve) => {
          scanTimer = setTimeout(resolve, 500);
        });
        scanFinished = true;
        return { synced: true };
      },
      startBackgroundSync: () => {
        void scanner.sync();
      },
      stopBackgroundSync: () => {
        if (scanTimer) {
          clearTimeout(scanTimer);
          scanTimer = null;
        }
      },
    };

    const mockConnection = {
      provider: {
        getNetwork: async () => ({ chainId: 10143n }),
        getCode: async () => "0x60806040",
      },
      rental: {
        paymentToken: async () => "0xe268CE1aD255f8D32bFA9a7f9fEEF3eaBf45b39C",
        quoteRent: async (id) => (id === 1 ? 4937500n : 18687500n),
      },
      token: {
        decimals: async () => 6n,
        symbol: async () => "mUSDT",
      },
      contractAddress: "0x7324A2678E74052A4E9A244C0D57B56B23FEE6Ad",
      tokenAddress: "0xe268CE1aD255f8D32bFA9a7f9fEEF3eaBf45b39C",
    };

    const deps = {
      keys,
      usage,
      purchaseCache,
      scanner,
      connection: mockConnection,
      verifyOnchain: async ({ onProgress = () => {} } = {}) => {
        onProgress("Validating persistent state stores scope...");
        await keys.ready();
        await usage.ready();
        await purchaseCache.load();
        await verifyMonadConnection(mockConnection, { onProgress });
        return true;
      },
      // App requirements
      chainId: 10143,
      contractAddress: MONAD_SCOPE.rentalContract,
      paymentTokenAddress: MONAD_SCOPE.paymentToken,
      paymentTokenSymbol: "mUSDT",
      previewController: { available: () => true },
      previewSeconds: 90,
      packMinutes: [60, 300],
      deploymentId: "archava-monad",
      origin: "http://localhost:5174",
      allowedOrigins: ["http://localhost:5174"],
      rateLimitKey: () => "test-ip",
    };

    // Step 1: verifyApiStartup must complete fast without waiting for scanner.sync
    const startMs = Date.now();
    await verifyApiStartup(deps, { timeoutMs: 5000, log: () => {} });
    const bootstrapDuration = Date.now() - startMs;
    assert.ok(bootstrapDuration < 200, `Bootstrap should finish in <200ms, took ${bootstrapDuration}ms`);
    assert.equal(scanCalled, false, "Scanner.sync must NOT be called before listen");

    // Step 2: Open HTTP server and start background sync
    const app = createApp(deps);
    const server = createServer(app.handle);
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, resolve);
      });
      const port = server.address().port;

      deps.scanner.startBackgroundSync();

      // Step 3: /api/config must answer 200 immediately while background scan is in progress
      const res = await fetch(`http://127.0.0.1:${port}/api/config`);
      assert.equal(res.status, 200);
      const config = await res.json();
      assert.equal(config.chainId, 10143);
      assert.equal(config.contractAddress, MONAD_SCOPE.rentalContract);
    } catch (err) {
      if (err.code === "EPERM" || err.code === "EACCES") {
        // Socket listen restricted in sandbox environment
        return;
      }
      throw err;
    } finally {
      deps.scanner.stopBackgroundSync();
      if (server.listening) {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
      }
    }
  });
});

test("2. RPC chain salah atau kontrak salah tetap ditolak sebelum listen", async () => {
  // Test A: Wrong RPC chain (e.g. 97 BSC)
  const mockConnectionWrongChain = {
    provider: {
      getNetwork: async () => ({ chainId: 97n }),
    },
    contractAddress: MONAD_SCOPE.rentalContract,
    tokenAddress: MONAD_SCOPE.paymentToken,
  };
  await assert.rejects(
    () => verifyMonadConnection(mockConnectionWrongChain),
    /RPC chain mismatch: connected to chain 97, expected 10143/
  );

  // Test B: Bytecode missing (contract not deployed)
  const mockConnectionNoBytecode = {
    provider: {
      getNetwork: async () => ({ chainId: 10143n }),
      getCode: async () => "0x",
    },
    contractAddress: MONAD_SCOPE.rentalContract,
    tokenAddress: MONAD_SCOPE.paymentToken,
  };
  await assert.rejects(
    () => verifyMonadConnection(mockConnectionNoBytecode),
    /Rental contract bytecode not found/
  );

  // Test C: Payment token mismatch
  const mockConnectionWrongToken = {
    provider: {
      getNetwork: async () => ({ chainId: 10143n }),
      getCode: async () => "0x60806040",
    },
    rental: {
      paymentToken: async () => "0x9999999999999999999999999999999999999999",
    },
    contractAddress: MONAD_SCOPE.rentalContract,
    tokenAddress: MONAD_SCOPE.paymentToken,
  };
  await assert.rejects(
    () => verifyMonadConnection(mockConnectionWrongToken),
    /Payment token does not match RENTAL_CONTRACT/
  );
});

test("3. RPC menggantung berhenti dalam batas waktu yang ditentukan", async () => {
  const hangingWork = (ctx) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      timer.unref?.();
      ctx?.signal?.addEventListener?.("abort", () => clearTimeout(timer));
    });
  const startMs = Date.now();
  await assert.rejects(
    () => withDeadline(hangingWork, 100, "Hanging RPC check"),
    (err) => err.name === "RpcTimeoutError" && /timed out after 100ms/.test(err.message)
  );
  const elapsed = Date.now() - startMs;
  assert.ok(elapsed < 200, `Hanging work should abort near 100ms, took ${elapsed}ms`);
});

test("4. Partial scan menyimpan cursor/hash dan melanjutkan setelah restart", async () => {
  await withTempDir(async (dir) => {
    const cachePath = join(dir, "purchase-cache.json");
    const cache = createPurchaseCache({ path: cachePath, scope: MONAD_SCOPE });

    // Mock provider from block 70191614 to 70194000
    const mockProvider = {
      getBlock: async (tag) => {
        if (tag === "finalized") return { number: 70194000, hash: "0xfin4000" };
        return { number: Number(tag), hash: `0xhash_${tag}` };
      },
      getLogs: async () => [],
    };

    // Scanner with maxPagesPerSync = 1 (budget 1 page of 1000 blocks)
    const scanner1 = createPurchaseScanner({
      provider: mockProvider,
      rentalAddress: MONAD_SCOPE.rentalContract,
      chainId: 10143,
      deploymentBlock: 70191614,
      purchaseCache: cache,
      pageSize: 1000,
      maxPagesPerSync: 1, // Only 1 page budget!
      log: () => {},
    });

    const result1 = await scanner1.sync();
    assert.equal(result1.synced, false, "Result must be partial because budget was reached");
    assert.equal(result1.partial, true);

    const cursorAfterFirst = await cache.getCursor();
    assert.equal(cursorAfterFirst.lastFinalizedBlock, 70192613);
    assert.equal(cursorAfterFirst.lastFinalizedBlockHash, "0xhash_70192613");

    // Simulating process restart: create a new scanner instance with the same cache
    const scanner2 = createPurchaseScanner({
      provider: mockProvider,
      rentalAddress: MONAD_SCOPE.rentalContract,
      chainId: 10143,
      deploymentBlock: 70191614,
      purchaseCache: cache,
      pageSize: 1000,
      maxPagesPerSync: 10, // Full budget now
      log: () => {},
    });

    const result2 = await scanner2.sync();
    assert.equal(result2.synced, true);
    assert.equal(result2.fromBlock, 70192614, "Must resume from cursor + 1");
    assert.equal(result2.toBlock, 70194000);

    const cursorAfterSecond = await cache.getCursor();
    assert.equal(cursorAfterSecond.lastFinalizedBlock, 70194000);
    assert.equal(cursorAfterSecond.lastFinalizedBlockHash, "0xfin4000");
  });
});

test("5. Partial scan tidak dianggap fresh dan paid gate menghasilkan 503", async () => {
  await withTempDir(async (dir) => {
    const cachePath = join(dir, "purchase-cache.json");
    const usagePath = join(dir, "usage.json");

    const cache = createPurchaseCache({ path: cachePath, scope: MONAD_SCOPE });
    const usage = createUsageStore({ path: usagePath, scope: MONAD_SCOPE });

    // Commit a partial batch without isFullSync: true
    await cache.commitBatch({
      lastFinalizedBlock: 70192000,
      lastFinalizedBlockHash: "0xhash_partial",
      newEvents: [],
      newTotals: { [ALICE]: 60 },
      isFullSync: false,
    });

    // lastSuccessfulFullSyncAt remains null!
    assert.equal(await cache.getLastSuccessfulFullSyncAt(), null);
    assert.equal(await cache.isFresh(60_000), false);

    // Mock scanner that reports sync is still running or partial
    const mockScanner = {
      sync: async () => ({ synced: false, partial: true }),
    };

    const mockRental = {
      hasActiveAccess: async () => true,
    };

    const readCredits = createCreditReader(
      { contractAddress: MONAD_SCOPE.rentalContract, tokenAddress: MONAD_SCOPE.paymentToken, chainId: 10143 },
      {
        purchaseCache: cache,
        purchaseScanner: mockScanner,
        connection: { provider: {}, rental: mockRental, deploymentBlock: 70191614 },
      }
    );

    const gate = createEntitlementGate({ readCredits, usage });
    const result = await gate(ALICE);

    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.code, "credit_sync_unavailable");
    assert.match(result.error, /Purchase history is still syncing/);
  });
});

test("6. Retry 429 terbatas dan tidak membelah range", async () => {
  await withTempDir(async (dir) => {
    const cachePath = join(dir, "purchase-cache.json");
    const cache = createPurchaseCache({ path: cachePath, scope: MONAD_SCOPE });

    const requestedRanges = [];
    let attempts = 0;

    const mockProvider = {
      getBlock: async (tag) => {
        if (tag === "finalized") return { number: 70193000, hash: "0xfin" };
        return { number: Number(tag), hash: "0xhash" };
      },
      getLogs: async (filter) => {
        attempts++;
        requestedRanges.push({ from: filter.fromBlock, to: filter.toBlock });
        const rateLimitErr = new Error("429 Too Many Requests");
        rateLimitErr.status = 429;
        throw rateLimitErr;
      },
    };

    const scanner = createPurchaseScanner({
      provider: mockProvider,
      rentalAddress: MONAD_SCOPE.rentalContract,
      chainId: 10143,
      deploymentBlock: 70191614,
      purchaseCache: cache,
      pageSize: 1000,
      maxRetries: 2,
      retryDelayMs: 10,
      log: () => {},
    });

    await assert.rejects(
      () => scanner.sync(),
      /429 Too Many Requests/
    );

    // Initial attempt + 2 retries = 3 attempts total
    assert.equal(attempts, 3, "Should retry boundedly up to maxRetries");
    // Verify all attempts kept the EXACT same range and did NOT split
    assert.equal(requestedRanges.length, 3);
    for (const range of requestedRanges) {
      assert.equal(range.from, 70191614);
      assert.equal(range.to, 70192613);
    }
  });
});

test("7. Timeout tidak menyebabkan late commit", async () => {
  await withTempDir(async (dir) => {
    const cachePath = join(dir, "purchase-cache.json");
    const cache = createPurchaseCache({ path: cachePath, scope: MONAD_SCOPE });

    let lateLogResolved = false;

    const mockProvider = {
      getBlock: async (tag) => {
        if (tag === "finalized") return { number: 70193000, hash: "0xfin" };
        return { number: Number(tag), hash: "0xhash" };
      },
      getLogs: async () => {
        // Slow RPC call
        await new Promise((resolve) => setTimeout(resolve, 200));
        lateLogResolved = true;
        return [];
      },
    };

    const scanner = createPurchaseScanner({
      provider: mockProvider,
      rentalAddress: MONAD_SCOPE.rentalContract,
      chainId: 10143,
      deploymentBlock: 70191614,
      purchaseCache: cache,
      pageSize: 1000,
      log: () => {},
    });

    const abortController = new AbortController();
    const syncPromise = scanner.sync({ signal: abortController.signal });

    // Abort after 50ms before getLogs resolves
    setTimeout(() => abortController.abort(), 50);

    await assert.rejects(
      () => syncPromise,
      /Sync operation was aborted/
    );

    // Wait until the slow call has finished in background
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(lateLogResolved, true);

    // Invariant: The aborted sync must NOT have committed to cursor!
    const cursor = await cache.getCursor();
    assert.equal(cursor.lastFinalizedBlock, null, "Aborted sync must not advance cursor");
    assert.equal(cursor.lastFinalizedBlockHash, null);
  });
});

test("8. State foreign atau korup ditolak tanpa overwrite", async () => {
  await withTempDir(async (dir) => {
    const cachePath = join(dir, "purchase-cache.json");
    const keysPath = join(dir, "keys.json");
    const usagePath = join(dir, "usage.json");

    // Write foreign state with BSC chainId 97
    const foreignCache = {
      schemaVersion: 1,
      scope: { ...MONAD_SCOPE, chainId: 97 },
      cursor: { lastFinalizedBlock: 100, lastFinalizedBlockHash: "0xhash" },
      totals: { [ALICE]: 60 },
      processedEvents: [],
    };
    await writeFile(cachePath, JSON.stringify(foreignCache), "utf8");

    const foreignKeys = {
      schemaVersion: 1,
      scope: { ...MONAD_SCOPE, deploymentId: "archava-foreign" },
      keys: [],
    };
    await writeFile(keysPath, JSON.stringify(foreignKeys), "utf8");

    const foreignUsage = {
      schemaVersion: 1,
      scope: { ...MONAD_SCOPE, chainId: 97 },
      records: [],
      holds: [],
    };
    await writeFile(usagePath, JSON.stringify(foreignUsage), "utf8");

    const cache = createPurchaseCache({ path: cachePath, scope: MONAD_SCOPE });
    const keys = createKeyStore({ path: keysPath, scope: MONAD_SCOPE });
    const usage = createUsageStore({ path: usagePath, scope: MONAD_SCOPE });

    await assert.rejects(() => cache.load(), /Chain ID mismatch/);
    await assert.rejects(() => keys.ready(), /Deployment ID mismatch/);
    await assert.rejects(() => usage.ready(), /Chain ID mismatch/);

    // Verify files were preserved and NOT overwritten
    const rawCache = JSON.parse(await readFile(cachePath, "utf8"));
    assert.equal(rawCache.scope.chainId, 97);
    const rawKeys = JSON.parse(await readFile(keysPath, "utf8"));
    assert.equal(rawKeys.scope.deploymentId, "archava-foreign");
  });
});

test("9. Missing Spatius Avatar ID menghasilkan diagnosis spesifik", () => {
  const baseEnv = {
    ARCHAVA_RUNTIME_ENABLED: "true",
    CHAIN_ID: "10143",
    RPC_URL: "https://testnet-rpc.monad.xyz",
    LIVEKIT_URL: "wss://receptionist-lwypqvqa.livekit.cloud",
    ARCHAVA_AGENT_NAME: "archava-monad-host",
    ARCHAVA_DEPLOYMENT_ID: "archava-monad",
    AVATAR_PROVIDER: "spatius",
    SPATIUS_API_KEY: "test_key",
  };

  // Test A: Only SPATIUS_AVATAR_ID missing
  assert.throws(
    () => createDependencies({
      env: {
        ...baseEnv,
        SPATIUS_APP_ID: "test_app",
        SPATIUS_AVATAR_ID: "",
      },
    }),
    /^Error: Spatius requires SPATIUS_AVATAR_ID$/
  );

  // Test B: Both SPATIUS_APP_ID and SPATIUS_AVATAR_ID missing
  assert.throws(
    () => createDependencies({
      env: {
        ...baseEnv,
        SPATIUS_APP_ID: "",
        SPATIUS_AVATAR_ID: "",
      },
    }),
    /^Error: Spatius requires SPATIUS_APP_ID, SPATIUS_AVATAR_ID$/
  );
});

test("10. Sanitasi secret dan credential RPC pada error log", () => {
  const secretKey = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
  const rpcSecret = "https://testnet.rpc.node/?key=secret_token_12345";
  const env = {
    MONAD_DEPLOYER_PRIVATE_KEY: secretKey,
    RPC_URL: rpcSecret,
    LIVEKIT_API_SECRET: "my_livekit_secret",
  };

  const rawError = new Error(`Connection failed to ${rpcSecret} with key ${secretKey} and secret my_livekit_secret`);
  const sanitized = runtimeErrorMessage(rawError, env);

  assert.ok(!sanitized.includes(secretKey), "Private key must be redacted");
  assert.ok(!sanitized.includes(rpcSecret), "RPC URL secret must be redacted");
  assert.ok(!sanitized.includes("my_livekit_secret"), "LiveKit secret must be redacted");
  assert.ok(sanitized.includes("[redacted]"));
});
