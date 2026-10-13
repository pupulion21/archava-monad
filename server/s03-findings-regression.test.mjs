import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createKeyStore } from "./apikeys.mjs";
import {
  createPurchaseCache,
  createPurchaseScanner,
  RecoverableScanError,
} from "./purchase-cache.mjs";
import { createCreditReader } from "./rental.mjs";
import { createEntitlementGate } from "./entitlement.mjs";
import { createUsageStore } from "./usage.mjs";

const MONAD_SCOPE = {
  deploymentId: "archava-monad",
  chainId: 10143,
  rentalContract: "0x7324a2678e74052a4e9a244c0d57b56b23fee6ad",
  paymentToken: "0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c",
};

const FOREIGN_SCOPE = {
  deploymentId: "archava-foreign",
  chainId: 10143,
  rentalContract: "0x7324a2678e74052a4e9a244c0d57b56b23fee6ad",
  paymentToken: "0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c",
};

const ALICE = "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC";
const BOB = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";

async function withTmp(run) {
  const dir = await mkdtemp(join(process.cwd(), "s03-repro-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// TEMUAN 1 REGRESSION TESTS: Key Store Validation Bypass After Error
// ---------------------------------------------------------------------------

test("Temuan 1: foreign scope failure prevents subsequent issue() from overwriting keys.json", async () => {
  await withTmp(async (dir) => {
    const path = join(dir, "keys.json");
    const foreignData = {
      schemaVersion: 1,
      scope: FOREIGN_SCOPE,
      keys: [],
    };
    await writeFile(path, JSON.stringify(foreignData, null, 2), "utf8");

    const store = createKeyStore({ path, scope: MONAD_SCOPE });

    // Step 1: list() fails due to scope mismatch
    await assert.rejects(
      async () => store.list(ALICE),
      /Deployment ID mismatch/
    );

    // Step 2: on the SAME store instance, issue() must ALSO reject!
    await assert.rejects(
      async () => store.issue(ALICE, { label: "exploit" }),
      /Deployment ID mismatch|unvalidated/
    );

    // Step 3: verify file on disk was NOT overwritten with MONAD_SCOPE
    const diskContent = JSON.parse(await readFile(path, "utf8"));
    assert.equal(diskContent.scope.deploymentId, "archava-foreign");
    assert.equal(diskContent.keys.length, 0);
  });
});

test("Temuan 1: corrupt keys.json does not turn into empty store or allow overwrite", async () => {
  await withTmp(async (dir) => {
    const path = join(dir, "keys.json");
    const corruptText = "{ this is not valid json";
    await writeFile(path, corruptText, "utf8");

    const store = createKeyStore({ path, scope: MONAD_SCOPE });

    // First operation fails
    await assert.rejects(
      async () => store.list(ALICE),
      /corrupt|syntax/i
    );

    // Subsequent operation on same instance must also fail
    await assert.rejects(
      async () => store.issue(ALICE, { label: "exploit" }),
      /corrupt|syntax|unvalidated/i
    );

    // File on disk remains corruptText and was not overwritten or wiped
    const currentOnDisk = await readFile(path, "utf8");
    assert.equal(currentOnDisk, corruptText);
  });
});

test("Temuan 1: concurrent load calls do not bypass validation on invalid keys store", async () => {
  await withTmp(async (dir) => {
    const path = join(dir, "keys.json");
    const foreignData = {
      schemaVersion: 1,
      scope: FOREIGN_SCOPE,
      keys: [],
    };
    await writeFile(path, JSON.stringify(foreignData, null, 2), "utf8");

    const store = createKeyStore({ path, scope: MONAD_SCOPE });

    // Call load concurrently
    const [r1, r2, r3] = await Promise.allSettled([
      store.list(ALICE),
      store.issue(ALICE, { label: "concurrent" }),
      store.list(ALICE),
    ]);

    assert.equal(r1.status, "rejected");
    assert.equal(r2.status, "rejected");
    assert.equal(r3.status, "rejected");

    // File remains unmodified
    const diskContent = JSON.parse(await readFile(path, "utf8"));
    assert.equal(diskContent.scope.deploymentId, "archava-foreign");
  });
});

test("Temuan 1: valid store properly supports issue, lookup, revoke, and persistence", async () => {
  await withTmp(async (dir) => {
    const path = join(dir, "keys.json");
    const store = createKeyStore({ path, scope: MONAD_SCOPE });

    const key = await store.issue(ALICE, { label: "test key" });
    assert.ok(key.apiKey);
    assert.ok(key.id);

    const found = await store.findBySecret(key.apiKey);
    assert.equal(found.id, key.id);
    assert.equal(found.wallet, ALICE);

    const list1 = await store.list(ALICE);
    assert.equal(list1.length, 1);

    const revoked = await store.revoke(key.id, ALICE);
    assert.ok(revoked.revokedAt);

    // After restart
    const restarted = createKeyStore({ path, scope: MONAD_SCOPE });
    const listAfter = await restarted.list(ALICE);
    assert.equal(listAfter.length, 1);
    assert.ok(listAfter[0].revokedAt);
  });
});

// ---------------------------------------------------------------------------
// TEMUAN 2 REGRESSION TESTS: Fallback Finality Crediting
// ---------------------------------------------------------------------------

test("Temuan 2: scanner rejects sync and credits nothing if finalized head is unavailable", async () => {
  await withTmp(async (dir) => {
    const path = join(dir, "cache.json");
    const cache = createPurchaseCache({ path, scope: MONAD_SCOPE });

    let logsQueried = false;
    const failingFinalizedProvider = {
      async getBlock(tag) {
        if (tag === "finalized") {
          throw new Error("RPC error: finalized tag unavailable");
        }
        return { number: 70191650, hash: "0xlat123" };
      },
      async getBlockNumber() {
        return 70191650;
      },
      async getLogs() {
        logsQueried = true;
        return [];
      },
    };

    const scanner = createPurchaseScanner({
      provider: failingFinalizedProvider,
      rentalAddress: MONAD_SCOPE.rentalContract,
      chainId: 10143,
      deploymentBlock: 70191614,
      purchaseCache: cache,
    });

    await assert.rejects(
      async () => scanner.sync(),
      (err) => err instanceof RecoverableScanError && /finalized/i.test(err.message)
    );

    // getLogs must NOT have been called on fallback block range
    assert.equal(logsQueried, false);

    // Cursor must NOT have moved
    const cursor = await cache.getCursor();
    assert.equal(cursor.lastFinalizedBlock, null);
  });
});

test("Temuan 2: direct credit reader does not fall back to latest if finalized is unavailable", async () => {
  const failingProvider = {
    async getBlock(tag) {
      if (tag === "finalized") throw new Error("finalized unavailable");
      return { number: 70191650, hash: "0xlat123" };
    },
    async getBlockNumber() {
      return 70191650;
    },
    async getNetwork() {
      return { chainId: 10143n };
    },
    async getLogs() {
      return [];
    },
  };

  const fakeRental = {
    target: MONAD_SCOPE.rentalContract,
    filters: { AccessRented: () => ({ topics: [] }) },
    async hasActiveAccess() { return true; },
  };

  const reader = createCreditReader({}, {
    connection: {
      provider: failingProvider,
      rental: fakeRental,
      contractAddress: MONAD_SCOPE.rentalContract,
      deploymentBlock: 70191614,
    },
  });

  // Calling direct reader with a provider whose finalized block fails must reject
  await assert.rejects(
    async () => reader(ALICE),
    /finalized|credit_sync_unavailable/i
  );
});

// ---------------------------------------------------------------------------
// TEMUAN 3 REGRESSION TESTS: Swallowed Sync Errors & Stale Cache Gate
// ---------------------------------------------------------------------------

test("Temuan 3: failed sync with 0-minute cache produces 503 instead of 403 no-minutes", async () => {
  await withTmp(async (dir) => {
    const cachePath = join(dir, "cache.json");
    const usagePath = join(dir, "usage.json");
    const cache = createPurchaseCache({ path: cachePath, scope: MONAD_SCOPE });
    const usage = createUsageStore({ path: usagePath, scope: MONAD_SCOPE });

    // Mock scanner that fails
    const failingScanner = {
      async sync() {
        throw new RecoverableScanError("RPC down", { error: "RPC down", code: "credit_sync_unavailable" });
      },
      getLastError() {
        return "RPC down";
      },
      async isFresh() {
        return false;
      },
    };

    // Custom reader mimicking createCreditReader behavior
    const customReader = async (wallet) => {
      await cache.load();
      let minutes = await cache.getPurchasedMinutes(wallet);
      if (minutes === 0) {
        await failingScanner.sync();
        minutes = await cache.getPurchasedMinutes(wallet);
      }
      return { purchasedMinutes: minutes };
    };

    const gate = createEntitlementGate({ readCredits: customReader, usage });
    const result = await gate(ALICE);

    assert.equal(result.ok, false);
    // Must be 503 credit_sync_unavailable, NOT 403 No Ava minutes!
    assert.equal(result.status, 503);
    assert.equal(result.code, "credit_sync_unavailable");
  });
});

test("Temuan 3: stale positive cache with failing scanner rejects paid gate", async () => {
  await withTmp(async (dir) => {
    const cachePath = join(dir, "cache.json");
    const usagePath = join(dir, "usage.json");
    let fakeNow = 100_000;
    const cache = createPurchaseCache({ path: cachePath, scope: MONAD_SCOPE, now: () => fakeNow });
    const usage = createUsageStore({ path: usagePath, scope: MONAD_SCOPE, now: () => fakeNow });

    // Seed cache with 60 minutes committed at t=100_000 (fresh full sync)
    await cache.commitBatch({
      lastFinalizedBlock: 70191620,
      lastFinalizedBlockHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      newEvents: ["10143:0x7324a2678e74052a4e9a244c0d57b56b23fee6ad:0xaaa:0"],
      newTotals: { [ALICE]: 60 },
      isFullSync: true,
    });

    // Advance time by 10 minutes (stale!)
    fakeNow += 600_000;

    const failingScanner = {
      async sync() {
        throw new RecoverableScanError("RPC timeout", { error: "RPC timeout", code: "credit_sync_unavailable" });
      },
      getLastError() {
        return "RPC timeout";
      },
      async isFresh(maxStalenessMs) {
        return await cache.isFresh(maxStalenessMs, fakeNow);
      },
    };

    const fakeRental = {
      async hasActiveAccess() {
        return true;
      },
    };

    const reader = async (wallet) => {
      const active = await fakeRental.hasActiveAccess(wallet, { blockTag: "finalized" });
      if (!active) return { purchasedMinutes: 0 };
      const isFresh = await cache.isFresh(60_000, fakeNow);
      if (!isFresh) {
        await failingScanner.sync();
      }
      return { purchasedMinutes: await cache.getPurchasedMinutes(wallet) };
    };

    const gate = createEntitlementGate({ readCredits: reader, usage });
    const result = await gate(ALICE);

    // Stale positive cache MUST NOT pass gate when scanner fails to sync!
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.code, "credit_sync_unavailable");
  });
});

test("Temuan 3: fresh positive cache allows gate to succeed", async () => {
  await withTmp(async (dir) => {
    const cachePath = join(dir, "cache.json");
    const usagePath = join(dir, "usage.json");
    let fakeNow = 100_000;
    const cache = createPurchaseCache({ path: cachePath, scope: MONAD_SCOPE, now: () => fakeNow });
    const usage = createUsageStore({ path: usagePath, scope: MONAD_SCOPE, now: () => fakeNow });

    // Seed cache with 60 minutes committed at t=100_000 with full sync
    await cache.commitBatch({
      lastFinalizedBlock: 70191620,
      lastFinalizedBlockHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      newEvents: ["10143:0x7324a2678e74052a4e9a244c0d57b56b23fee6ad:0xaaa:0"],
      newTotals: { [ALICE]: 60 },
      isFullSync: true,
    });

    // Only 10 seconds later (fresh!)
    fakeNow += 10_000;

    let syncAttempted = false;
    const idleScanner = {
      async sync() {
        syncAttempted = true;
      },
      getLastError() {
        return null;
      },
    };

    const reader = async (wallet) => {
      const isFresh = await cache.isFresh(60_000, fakeNow);
      let minutes = await cache.getPurchasedMinutes(wallet);
      if (!isFresh || minutes === 0) {
        await idleScanner.sync();
        minutes = await cache.getPurchasedMinutes(wallet);
      }
      return { purchasedMinutes: minutes };
    };

    const gate = createEntitlementGate({ readCredits: reader, usage });
    const result = await gate(ALICE);

    assert.equal(result.ok, true);
    assert.equal(result.wallet, ALICE);
    assert.equal(result.remainingSeconds, 60 * 60);
    assert.equal(syncAttempted, false);
  });
});

// ---------------------------------------------------------------------------
// TEMUAN 4 REGRESSION TESTS: Cursor Block Hash Verification
// ---------------------------------------------------------------------------

test("Temuan 4: cursor block hash mismatch is detected and rejects sync without touching disk", async () => {
  await withTmp(async (dir) => {
    const path = join(dir, "cache.json");
    const cache = createPurchaseCache({ path, scope: MONAD_SCOPE });

    // Commit cursor block 70191620 with hash "0x1111...1111"
    const originalHash = "0x1111111111111111111111111111111111111111111111111111111111111111";
    await cache.commitBatch({
      lastFinalizedBlock: 70191620,
      lastFinalizedBlockHash: originalHash,
      newEvents: [],
      newTotals: { [ALICE]: 60 },
    });

    // Mock provider where RPC reports block 70191620 now has hash "0x2222...2222" (reorg/fork)
    const reorgProvider = {
      async getBlock(param) {
        if (param === "finalized") {
          return { number: 70191625, hash: "0x9999999999999999999999999999999999999999999999999999999999999999" };
        }
        if (param === 70191620) {
          // Reorg: block 70191620 has DIFFERENT hash!
          return { number: 70191620, hash: "0x2222222222222222222222222222222222222222222222222222222222222222" };
        }
        return { number: param, hash: "0x3333333333333333333333333333333333333333333333333333333333333333" };
      },
      async getLogs() {
        return [];
      },
    };

    const scanner = createPurchaseScanner({
      provider: reorgProvider,
      rentalAddress: MONAD_SCOPE.rentalContract,
      chainId: 10143,
      deploymentBlock: 70191614,
      purchaseCache: cache,
    });

    // Scanner MUST detect the mismatch and reject!
    await assert.rejects(
      async () => scanner.sync(),
      (err) => err instanceof RecoverableScanError && /hash mismatch/i.test(err.message)
    );

    // Verify cache on disk was NOT modified or corrupted
    const cursor = await cache.getCursor();
    assert.equal(cursor.lastFinalizedBlock, 70191620);
    assert.equal(cursor.lastFinalizedBlockHash, originalHash);
    assert.equal(await cache.getPurchasedMinutes(ALICE), 60);
  });
});

test("Temuan 4: cursor ahead of finalized head is rejected", async () => {
  await withTmp(async (dir) => {
    const path = join(dir, "cache.json");
    const cache = createPurchaseCache({ path, scope: MONAD_SCOPE });

    // Cursor is at block 70191630
    await cache.commitBatch({
      lastFinalizedBlock: 70191630,
      lastFinalizedBlockHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      newEvents: [],
      newTotals: {},
    });

    // RPC reports finalized head is only at 70191620
    const laggedProvider = {
      async getBlock(param) {
        if (param === "finalized") {
          return { number: 70191620, hash: "0xfin123" };
        }
        return null;
      },
    };

    const scanner = createPurchaseScanner({
      provider: laggedProvider,
      rentalAddress: MONAD_SCOPE.rentalContract,
      chainId: 10143,
      deploymentBlock: 70191614,
      purchaseCache: cache,
    });

    await assert.rejects(
      async () => scanner.sync(),
      (err) => err instanceof RecoverableScanError && /ahead of finalized head/i.test(err.message)
    );
  });
});

test("Temuan 4: cursor with missing hash upon file load is rejected", async () => {
  await withTmp(async (dir) => {
    const path = join(dir, "cache.json");
    const invalidCursorState = {
      schemaVersion: 1,
      scope: MONAD_SCOPE,
      cursor: {
        lastFinalizedBlock: 70191620,
        lastFinalizedBlockHash: null, // Invalid!
      },
      totals: {},
      processedEvents: [],
    };
    await writeFile(path, JSON.stringify(invalidCursorState, null, 2), "utf8");

    const cache = createPurchaseCache({ path, scope: MONAD_SCOPE });
    await assert.rejects(
      async () => cache.load(),
      /missing or invalid lastFinalizedBlockHash/
    );
  });
});

test("Temuan 4: multi-page sync commits valid block hash for intermediate pages", async () => {
  await withTmp(async (dir) => {
    const path = join(dir, "cache.json");
    const cache = createPurchaseCache({ path, scope: MONAD_SCOPE });

    const committedBatches = [];
    const origCommit = cache.commitBatch;
    cache.commitBatch = async (batch) => {
      committedBatches.push(batch);
      return origCommit(batch);
    };

    const mockProvider = {
      async getBlock(param) {
        if (param === "finalized") {
          return { number: 70191618, hash: "0xfinalized123" };
        }
        // Intermediate page block
        return { number: param, hash: `0xhash_for_${param}` };
      },
      async getLogs() {
        return [];
      },
    };

    const scanner = createPurchaseScanner({
      provider: mockProvider,
      rentalAddress: MONAD_SCOPE.rentalContract,
      chainId: 10143,
      deploymentBlock: 70191614,
      pageSize: 2, // Forces multiple pages: 70191614..70191615, 70191616..70191617, 70191618
      purchaseCache: cache,
    });

    const result = await scanner.sync();
    assert.equal(result.synced, true);
    assert.equal(committedBatches.length, 3);

    // Every intermediate page must have non-null, valid block hash
    for (const batch of committedBatches) {
      assert.ok(batch.lastFinalizedBlockHash);
      assert.ok(batch.lastFinalizedBlockHash.startsWith("0x"));
    }

    assert.equal(committedBatches[0].lastFinalizedBlock, 70191615);
    assert.equal(committedBatches[0].lastFinalizedBlockHash, "0xhash_for_70191615");
    assert.equal(committedBatches[0].isFullSync, false);

    assert.equal(committedBatches[1].lastFinalizedBlock, 70191617);
    assert.equal(committedBatches[1].lastFinalizedBlockHash, "0xhash_for_70191617");
    assert.equal(committedBatches[1].isFullSync, false);

    assert.equal(committedBatches[2].lastFinalizedBlock, 70191618);
    assert.equal(committedBatches[2].lastFinalizedBlockHash, "0xfinalized123");
    assert.equal(committedBatches[2].isFullSync, true);
  });
});

