import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPurchaseCache, createPurchaseScanner } from "./purchase-cache.mjs";

const scope = {
  deploymentId: "archava-monad",
  chainId: 10143,
  rentalContract: "0x7324a2678e74052a4e9a244c0d57b56b23fee6ad",
  paymentToken: "0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c",
};
const wallet = "0x1111111111111111111111111111111111111111";
const hash = (block) => "0x" + Number(block).toString(16).padStart(64, "0");
const purchase = { transactionHash: hash(999), index: 0, blockNumber: 1 };
const rental = {
  interface: { parseLog: () => ({ name: "AccessRented", args: { wallet, includedMinutes: 60n } }) },
};

async function fixture(t, { head = 8, getLogs = async () => [] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "archava-scanner-budget-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "purchase-cache.json");
  const cache = createPurchaseCache({ path, scope });
  const requests = [];
  const provider = {
    async getBlock(tag) {
      requests.push({ method: "getBlock", tag });
      const number = tag === "finalized" ? head : Number(tag);
      return { number, hash: hash(number) };
    },
    async getLogs(filter) {
      requests.push({ method: "getLogs", ...filter });
      return getLogs(filter);
    },
  };
  const scanner = (options = {}) => createPurchaseScanner({
    provider, purchaseCache: cache, rentalContract: rental,
    rentalAddress: scope.rentalContract, chainId: 10143, deploymentBlock: 1,
    pageSize: 2, log: () => {}, ...options,
  });
  return { path, cache, requests, scanner };
}

test("request budget stops recursive range splitting before another RPC", async (t) => {
  const f = await fixture(t, {
    head: 64,
    getLogs: async ({ fromBlock, toBlock }) => {
      if (toBlock > fromBlock) throw new Error("block range too large");
      return [];
    },
  });
  const scanner = f.scanner({ pageSize: 64, maxRequestsPerSync: 2 });
  const result = await scanner.sync();
  assert.equal(result.synced, false);
  assert.equal(result.partial, true);
  assert.equal(f.requests.length, 2);
  assert.equal((await f.cache.getCursor()).lastFinalizedBlock, null);
  assert.equal(await f.cache.isFresh(), false);

  // A later pass can continue with a smaller learned range instead of getting stuck.
  const resumed = await scanner.sync({ maxRequests: 300, maxPages: 100 });
  assert.equal(resumed.synced, true);
  assert.equal((await f.cache.getCursor()).lastFinalizedBlock, 64);
});

test("request budget counts page hashes, preserves committed credit, and resumes after restart", async (t) => {
  const f = await fixture(t, {
    getLogs: async ({ fromBlock, toBlock }) => fromBlock <= 1 && toBlock >= 1 ? [purchase] : [],
  });
  const partial = await f.scanner({ maxRequestsPerSync: 4 }).sync();
  assert.equal(partial.synced, false);
  assert.equal(partial.toBlock, 2);
  assert.equal(f.requests.length, 4);
  assert.equal(await f.cache.getPurchasedMinutes(wallet), 60);
  assert.equal(await f.cache.isFresh(), false);

  const persisted = createPurchaseCache({ path: f.path, scope });
  assert.deepEqual(await persisted.getCursor(), {
    lastFinalizedBlock: 2, lastFinalizedBlockHash: hash(2),
  });
  const complete = await f.scanner().sync();
  assert.equal(complete.synced, true);
  assert.equal(complete.fromBlock, 3);
  assert.equal(await f.cache.getPurchasedMinutes(wallet), 60);
  assert.equal(await f.cache.isFresh(), true);
});

test("rate-limit retries consume the same request budget without splitting", async (t) => {
  const f = await fixture(t, { getLogs: async () => { throw new Error("429 Too Many Requests"); } });
  const result = await f.scanner({ maxRequestsPerSync: 3, maxRetries: 10, retryDelayMs: 1 }).sync();
  assert.equal(result.synced, false);
  assert.equal(f.requests.length, 3);
  const attempts = f.requests.filter((request) => request.method === "getLogs");
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map(({ fromBlock, toBlock }) => [fromBlock, toBlock]), [[1, 2], [1, 2]]);
  assert.equal((await f.cache.getCursor()).lastFinalizedBlock, null);
});

test("overall deadline bounds a slow RPC and rejects its late credit commit", async (t) => {
  const f = await fixture(t, {
    head: 2,
    getLogs: () => new Promise((resolve) => setTimeout(() => resolve([purchase]), 200)),
  });
  const start = Date.now();
  const result = await f.scanner({ maxDurationMsPerSync: 25 }).sync();
  assert.equal(result.synced, false);
  assert.ok(Date.now() - start < 150, "Scanner must return before the delayed RPC finishes");
  await new Promise((resolve) => setTimeout(resolve, 230));
  assert.equal((await f.cache.getCursor()).lastFinalizedBlock, null);
  assert.equal(await f.cache.getPurchasedMinutes(wallet), 0);
  assert.equal(await f.cache.isFresh(), false);
});

test("overall deadline interrupts rate-limit backoff before another attempt", async (t) => {
  const f = await fixture(t, { getLogs: async () => { throw new Error("429 Too Many Requests"); } });
  const start = Date.now();
  const result = await f.scanner({ maxDurationMsPerSync: 25, retryDelayMs: 1000 }).sync();
  assert.equal(result.synced, false);
  assert.ok(Date.now() - start < 150, "Backoff must obey the overall sync deadline");
  assert.equal(f.requests.length, 2);
});

test("a valid final page may commit using the last allowed request", async (t) => {
  const f = await fixture(t, { head: 2, getLogs: async () => [purchase] });
  const result = await f.scanner({ maxRequestsPerSync: 2 }).sync();
  assert.equal(result.synced, true);
  assert.equal(f.requests.length, 2);
  assert.equal(await f.cache.getPurchasedMinutes(wallet), 60);
  assert.equal(await f.cache.isFresh(), true);
});

test("invalid scanner budgets fail before any RPC is sent", async (t) => {
  const f = await fixture(t);
  for (const maxRequests of [0, -1, NaN, 1.5]) {
    await assert.rejects(() => f.scanner().sync({ maxRequests }), /ARCHAVA_SCANNER_MAX_REQUESTS must be a positive integer/);
  }
  assert.equal(f.requests.length, 0);
});
