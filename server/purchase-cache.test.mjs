import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPurchaseCache,
  createPurchaseScanner,
  validateScope,
  buildEventKey,
  RecoverableScanError,
} from "./purchase-cache.mjs";

const MONAD_SCOPE = {
  deploymentId: "archava-monad",
  chainId: 10143,
  rentalContract: "0x7324a2678e74052a4e9a244c0d57b56b23fee6ad",
  paymentToken: "0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c",
};

const ALICE = "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC";
const BOB = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";

async function withCache(run) {
  const dir = await mkdtemp(join(process.cwd(), "archava-cache-"));
  const path = join(dir, "purchase-cache.json");
  try {
    return await run({ dir, path });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("validateScope asserts all deployment identity fields", () => {
  // Valid matching scope
  assert.doesNotThrow(() => validateScope(MONAD_SCOPE, MONAD_SCOPE));

  // Mismatched deploymentId
  assert.throws(
    () => validateScope({ ...MONAD_SCOPE, deploymentId: "archava-bnb" }, MONAD_SCOPE),
    /Deployment ID mismatch/
  );

  // Mismatched chainId
  assert.throws(
    () => validateScope({ ...MONAD_SCOPE, chainId: 97 }, MONAD_SCOPE),
    /Chain ID mismatch/
  );

  // Mismatched rentalContract
  assert.throws(
    () => validateScope(
      { ...MONAD_SCOPE, rentalContract: "0x1111111111111111111111111111111111111111" },
      MONAD_SCOPE
    ),
    /Rental contract mismatch/
  );

  // Mismatched paymentToken
  assert.throws(
    () => validateScope(
      { ...MONAD_SCOPE, paymentToken: "0x2222222222222222222222222222222222222222" },
      MONAD_SCOPE
    ),
    /Payment token mismatch/
  );
});

test("purchase cache creates scoped state and survives restarts", async () => {
  await withCache(async ({ path }) => {
    const cache = createPurchaseCache({ path, scope: MONAD_SCOPE });
    await cache.commitBatch({
      lastFinalizedBlock: 70191700,
      lastFinalizedBlockHash: "0xabc123",
      newEvents: ["10143:0x7324a2678e74052a4e9a244c0d57b56b23fee6ad:0xdeadbeef:0"],
      newTotals: { [ALICE]: 60 },
    });

    assert.equal(await cache.getPurchasedMinutes(ALICE), 60);
    assert.equal(await cache.getPurchasedMinutes(BOB), 0);

    const cursor = await cache.getCursor();
    assert.equal(cursor.lastFinalizedBlock, 70191700);
    assert.equal(cursor.lastFinalizedBlockHash, "0xabc123");

    // Check disk content
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.equal(raw.schemaVersion, 1);
    assert.equal(raw.scope.deploymentId, "archava-monad");
    assert.equal(raw.scope.chainId, 10143);
    assert.equal(raw.totals[ALICE], 60);

    // Restart with same scope
    const restarted = createPurchaseCache({ path, scope: MONAD_SCOPE });
    assert.equal(await restarted.getPurchasedMinutes(ALICE), 60);
    assert.equal((await restarted.getCursor()).lastFinalizedBlock, 70191700);
  });
});

test("purchase cache rejects legacy unscoped or foreign state without overwriting it", async () => {
  await withCache(async ({ path }) => {
    // Write legacy unscoped state
    await writeFile(path, JSON.stringify({ totals: { [ALICE]: 300 } }), "utf8");

    const cache = createPurchaseCache({ path, scope: MONAD_SCOPE });
    await assert.rejects(
      async () => cache.load(),
      /unsupported schemaVersion/
    );

    // Write state for foreign deployment
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        scope: { ...MONAD_SCOPE, deploymentId: "archava-other" },
        totals: { [ALICE]: 300 },
      }),
      "utf8"
    );

    const foreignCache = createPurchaseCache({ path, scope: MONAD_SCOPE });
    await assert.rejects(
      async () => foreignCache.load(),
      /Deployment ID mismatch/
    );

    // File content remains foreign and was not overwritten
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.equal(raw.scope.deploymentId, "archava-other");
  });
});

test("purchase scanner deduplicates events and updates cache atomically", async () => {
  await withCache(async ({ path }) => {
    const cache = createPurchaseCache({ path, scope: MONAD_SCOPE });

    let fetchedRanges = [];
    const mockLogs = [
      {
        transactionHash: "0xaaa",
        index: 0,
        topics: ["0x1d1e44f8ea5897087e583c4b9fb3a0c4f83bca9810ad1c59bb79ff737b92bc49"],
      },
      {
        transactionHash: "0xbbb",
        index: 1,
        topics: ["0x1d1e44f8ea5897087e583c4b9fb3a0c4f83bca9810ad1c59bb79ff737b92bc49"],
      },
    ];

    const mockProvider = {
      async getBlock(tag) {
        if (tag === "finalized" || tag === 70191620) return { number: 70191620, hash: "0xfin" };
        return { number: 70191625, hash: "0xlat" };
      },
      async getLogs({ fromBlock, toBlock }) {
        fetchedRanges.push([fromBlock, toBlock]);
        return mockLogs;
      },
    };

    const mockRental = {
      target: MONAD_SCOPE.rentalContract,
      interface: {
        parseLog(log) {
          if (log.transactionHash === "0xaaa") {
            return {
              name: "AccessRented",
              args: { wallet: ALICE, includedMinutes: 60n },
            };
          }
          if (log.transactionHash === "0xbbb") {
            return {
              name: "AccessRented",
              args: { wallet: ALICE, includedMinutes: 300n },
            };
          }
          return null;
        },
      },
    };

    const scanner = createPurchaseScanner({
      provider: mockProvider,
      rentalContract: mockRental,
      rentalAddress: MONAD_SCOPE.rentalContract,
      chainId: 10143,
      deploymentBlock: 70191614,
      purchaseCache: cache,
    });

    const result = await scanner.sync();
    assert.equal(result.synced, true);
    assert.equal(result.newEventsCount, 2);

    // Alice received 60 + 300 = 360 minutes
    assert.equal(await cache.getPurchasedMinutes(ALICE), 360);
    assert.equal((await cache.getCursor()).lastFinalizedBlock, 70191620);

    // Replay / second sync to same block produces 0 new events and does not double credit
    const secondSync = await scanner.sync();
    assert.equal(secondSync.newEventsCount, 0);
    assert.equal(await cache.getPurchasedMinutes(ALICE), 360);
  });
});

test("purchase scanner handles RPC failure with RecoverableScanError without zeroing cache", async () => {
  await withCache(async ({ path }) => {
    const cache = createPurchaseCache({ path, scope: MONAD_SCOPE });
    await cache.commitBatch({
      lastFinalizedBlock: 70191615,
      lastFinalizedBlockHash: "0x111",
      newEvents: [],
      newTotals: { [ALICE]: 60 },
    });

    const failingProvider = {
      async getBlock() {
        throw new Error("RPC network timeout");
      },
      async getBlockNumber() {
        throw new Error("RPC network timeout");
      },
    };

    const scanner = createPurchaseScanner({
      provider: failingProvider,
      rentalAddress: MONAD_SCOPE.rentalContract,
      chainId: 10143,
      deploymentBlock: 70191614,
      purchaseCache: cache,
    });

    await assert.rejects(
      async () => scanner.sync(),
      (err) => err instanceof RecoverableScanError && err.status === 503
    );

    // Alice's existing credit is retained and NOT cleared or zeroed
    assert.equal(await cache.getPurchasedMinutes(ALICE), 60);
  });
});

test("purchase scanner executes single-flight synchronization under concurrent calls", async () => {
  await withCache(async ({ path }) => {
    const cache = createPurchaseCache({ path, scope: MONAD_SCOPE });

    let callCount = 0;
    const mockProvider = {
      async getBlock(tag) {
        callCount++;
        await new Promise((r) => setTimeout(r, 20));
        return { number: 70191615, hash: "0xfin" };
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
      purchaseCache: cache,
    });

    // Run 3 concurrent sync calls
    const [r1, r2, r3] = await Promise.all([
      scanner.sync(),
      scanner.sync(),
      scanner.sync(),
    ]);

    assert.equal(r1.synced, true);
    assert.equal(r2.synced, true);
    assert.equal(r3.synced, true);
    // Provider was queried only once due to single-flight mutex
    assert.equal(callCount, 1);
  });
});

test("purchase cache hasTx detects credited transaction hashes correctly", async () => {
  await withCache(async ({ path }) => {
    const cache = createPurchaseCache({ path, scope: MONAD_SCOPE });
    const txHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    // Uncommitted transaction returns false
    assert.equal(await cache.hasTx(txHash), false);

    // Commit event key containing the txHash
    const eventKey = buildEventKey(10143, MONAD_SCOPE.rentalContract, txHash, 0);
    await cache.commitBatch({
      lastFinalizedBlock: 70191620,
      lastFinalizedBlockHash: "0xfin",
      newEvents: [eventKey],
      newTotals: { [ALICE]: 60 },
    });

    // Committed transaction returns true (supports exact, upper, and lowercase)
    assert.equal(await cache.hasTx(txHash), true);
    assert.equal(await cache.hasTx(txHash.toUpperCase()), true);
    assert.equal(await cache.hasTx("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), false);
  });
});

test("isTxCreditedForWallet binds transaction event strictly to buyer wallet", async () => {
  await withCache(async ({ path }) => {
    const cache = createPurchaseCache({ path, scope: MONAD_SCOPE });
    const aliceTx = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const eventKey = buildEventKey(10143, MONAD_SCOPE.rentalContract, aliceTx, 0);

    await cache.commitBatch({
      lastFinalizedBlock: 70191620,
      lastFinalizedBlockHash: "0xfin",
      newEvents: [eventKey],
      newTotals: { [ALICE]: 60 },
      eventDetails: [
        {
          eventKey,
          wallet: ALICE,
          txHash: aliceTx,
          logIndex: 0,
          chainId: 10143,
          rentalAddress: MONAD_SCOPE.rentalContract,
          includedMinutes: 60,
          blockNumber: 70191618,
        },
      ],
    });

    // AliceTx + Alice -> credited
    assert.equal(await cache.isTxCreditedForWallet(aliceTx, ALICE), true);
    // AliceTx + Bob -> NOT credited!
    assert.equal(await cache.isTxCreditedForWallet(aliceTx, BOB), false);
    // hasTx with expected wallet
    assert.equal(await cache.hasTx(aliceTx, ALICE), true);
    assert.equal(await cache.hasTx(aliceTx, BOB), false);
    // Unknown tx
    assert.equal(await cache.isTxCreditedForWallet("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ALICE), false);
  });
});

test("isTxCreditedForWallet performs bounded receipt verification against canonical deployment", async () => {
  await withCache(async ({ path }) => {
    const cache = createPurchaseCache({ path, scope: MONAD_SCOPE });
    const txHash = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const eventKey = buildEventKey(10143, MONAD_SCOPE.rentalContract, txHash, 0);

    // Initial state: eventKey is indexed in processedEvents, but no eventDetails in cache yet
    await cache.commitBatch({
      lastFinalizedBlock: 70191650,
      lastFinalizedBlockHash: "0xfin50",
      newEvents: [eventKey],
      newTotals: { [ALICE]: 60 },
    });

    const mockRentalInterface = {
      parseLog: (log) => {
        if (log.topics?.[0] === "0xevent") {
          return { name: "AccessRented", args: { wallet: ALICE, includedMinutes: 60n } };
        }
        return null;
      },
    };

    const mockRentalContract = {
      address: MONAD_SCOPE.rentalContract,
      target: MONAD_SCOPE.rentalContract,
      interface: mockRentalInterface,
    };

    // 1. Success case: receipt finalized and log matches Alice
    const mockProviderSuccess = {
      getTransactionReceipt: async (h) => ({
        status: 1,
        blockNumber: 70191620,
        logs: [
          {
            address: MONAD_SCOPE.rentalContract,
            topics: ["0xevent"],
            index: 0,
          },
        ],
      }),
    };

    // Alice succeeds
    assert.equal(
      await cache.isTxCreditedForWallet(txHash, ALICE, {
        provider: mockProviderSuccess,
        rentalContract: mockRentalContract,
      }),
      true
    );
    // Bob fails on same tx
    assert.equal(
      await cache.isTxCreditedForWallet(txHash, BOB, {
        provider: mockProviderSuccess,
        rentalContract: mockRentalContract,
      }),
      false
    );

    // 2. Unfinalized block (blockNumber 70191700 > lastFinalizedBlock 70191650) -> returns false
    const mockProviderUnfinalized = {
      getTransactionReceipt: async () => ({
        status: 1,
        blockNumber: 70191700, // ahead of 70191650
        logs: [{ address: MONAD_SCOPE.rentalContract, topics: ["0xevent"], index: 0 }],
      }),
    };
    const txUnfinalized = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    await cache.commitBatch({
      newEvents: [buildEventKey(10143, MONAD_SCOPE.rentalContract, txUnfinalized, 0)],
    });
    assert.equal(
      await cache.isTxCreditedForWallet(txUnfinalized, ALICE, {
        provider: mockProviderUnfinalized,
        rentalContract: mockRentalContract,
      }),
      false
    );

    // 3. Wrong contract address in receipt logs -> returns false
    const mockProviderWrongContract = {
      getTransactionReceipt: async () => ({
        status: 1,
        blockNumber: 70191620,
        logs: [{ address: "0x9999999999999999999999999999999999999999", topics: ["0xevent"], index: 0 }],
      }),
    };
    const txWrong = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    await cache.commitBatch({
      newEvents: [buildEventKey(10143, MONAD_SCOPE.rentalContract, txWrong, 0)],
    });
    assert.equal(
      await cache.isTxCreditedForWallet(txWrong, ALICE, {
        provider: mockProviderWrongContract,
        rentalContract: mockRentalContract,
      }),
      false
    );

    // 4. RPC error on getTransactionReceipt -> throws RecoverableScanError (503)
    const mockProviderError = {
      getTransactionReceipt: async () => {
        throw new Error("RPC timeout");
      },
    };
    const txErr = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    await cache.commitBatch({
      newEvents: [buildEventKey(10143, MONAD_SCOPE.rentalContract, txErr, 0)],
    });
    await assert.rejects(
      async () =>
        cache.isTxCreditedForWallet(txErr, ALICE, {
          provider: mockProviderError,
          rentalContract: mockRentalContract,
        }),
      (err) => err instanceof RecoverableScanError && err.status === 503
    );
  });
});

