import test from "node:test";
import assert from "node:assert/strict";
import {
  createPurchaseHistoryService,
  PURCHASES_QUERY,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
} from "./purchases.mjs";

const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const BOB = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const CHAIN_ID = 10143;
const CONTRACT = "0x7324a2678e74052a4e9a244c0d57b56b23fee6ad";
const DEPLOY_BLOCK = 70191614;

function syncedMeta(chainId = CHAIN_ID, overrides = {}) {
  return {
    chainId,
    progressBlock: 70193000,
    sourceBlock: 70193000,
    isReady: true,
    startBlock: DEPLOY_BLOCK,
    endBlock: null,
    eventsProcessed: 2,
    ...overrides,
  };
}

function validPurchase(overrides = {}) {
  return {
    id: `10143:0x7324a2678e74052a4e9a244c0d57b56b23fee6ad:0x${"a".repeat(64)}:1`,
    wallet: ALICE.toLowerCase(),
    packageId: 1,
    includedMinutes: 60,
    expiresAt: 1760345000,
    amountPaid: "4937500",
    transactionHash: `0x${"a".repeat(64)}`,
    blockNumber: 70192000,
    logIndex: 1,
    timestamp: 1760341400,
    ...overrides,
  };
}

test("purchase history: query uses documented _meta array shape for chain 10143", async () => {
  assert.match(PURCHASES_QUERY, /_meta\s*\(\s*where:\s*\{\s*chainId:\s*\{\s*_eq:\s*\$chainId/);
  assert.match(PURCHASES_QUERY, /chainId/);
  assert.match(PURCHASES_QUERY, /progressBlock/);
  assert.match(PURCHASES_QUERY, /sourceBlock/);
  assert.match(PURCHASES_QUERY, /isReady/);
  assert.match(PURCHASES_QUERY, /AccessRented/);
  // Old incorrect shape must be gone.
  assert.doesNotMatch(PURCHASES_QUERY, /status\s*\{\s*chains/);
  assert.doesNotMatch(PURCHASES_QUERY, /numBlocksBehind/);
  assert.doesNotMatch(PURCHASES_QUERY, /latestBlock/);

  let captured = null;
  const mockFetch = async (_url, options) => {
    captured = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ data: { AccessRented: [], _meta: [syncedMeta()] } }),
    };
  };
  const service = createPurchaseHistoryService({
    envioUrl: "https://indexer.example.com/graphql",
    fetchImpl: mockFetch,
  });
  await service.getPurchases({ wallet: ALICE });
  assert.equal(captured.variables.chainId, CHAIN_ID);
  assert.equal(typeof captured.variables.wallet, "string");
});

test("purchase history: rejects invalid or missing wallet addresses", async () => {
  const service = createPurchaseHistoryService({ envioUrl: "https://indexer.example.com/v1/graphql" });

  const cases = [null, undefined, "", "not-an-address", "0x123", "0xG324a2678e74052a4e9a244c0d57b56b23fee6ad"];
  for (const wallet of cases) {
    const result = await service.getPurchases({ wallet });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 400);
    assert.match(result.error, /Invalid or missing wallet address/i);
  }
});

test("purchase history: clamps limit and offset bounds safely", async () => {
  let capturedVariables = null;
  const mockFetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    capturedVariables = body.variables;
    return {
      ok: true,
      json: async () => ({
        data: {
          AccessRented: [],
          _meta: [syncedMeta()],
        },
      }),
    };
  };

  const service = createPurchaseHistoryService({
    envioUrl: "https://indexer.example.com/graphql",
    fetchImpl: mockFetch,
  });

  const validWallet = ALICE;

  // Test limit overflow (> 50) and negative offset
  await service.getPurchases({ wallet: validWallet, limit: 1000, offset: -5 });
  assert.equal(capturedVariables.limit, MAX_PAGE_LIMIT);
  assert.equal(capturedVariables.offset, 0);

  // Test limit underflow (< 1)
  await service.getPurchases({ wallet: validWallet, limit: 0, offset: 10 });
  assert.equal(capturedVariables.limit, DEFAULT_PAGE_LIMIT);
  assert.equal(capturedVariables.offset, 10);
});

test("purchase history: gracefully returns unavailable when ENVIO_GRAPHQL_URL is unset", async () => {
  const service = createPurchaseHistoryService({ envioUrl: "" });
  const result = await service.getPurchases({ wallet: ALICE });

  assert.equal(result.ok, true);
  assert.equal(result.status, "unavailable");
  assert.equal(result.purchases.length, 0);
  assert.equal(result.sync.status, "unavailable");
  assert.match(result.sync.message, /ENVIO_GRAPHQL_URL is not configured/i);
});

test("purchase history: parses purchases and deduplicates duplicate event entries", async () => {
  const txA = `0x${"a".repeat(64)}`;
  const txB = `0x${"b".repeat(64)}`;
  const mockPurchases = [
    {
      id: `10143:${CONTRACT}:${txA}:1`,
      wallet: ALICE.toLowerCase(),
      packageId: 1,
      includedMinutes: 60,
      expiresAt: 1760345000,
      amountPaid: "4937500",
      transactionHash: txA,
      blockNumber: 70192000,
      logIndex: 1,
      timestamp: 1760341400,
    },
    // Duplicate id should be filtered out
    {
      id: `10143:${CONTRACT}:${txA}:1`,
      wallet: ALICE.toLowerCase(),
      packageId: 1,
      includedMinutes: 60,
      expiresAt: 1760345000,
      amountPaid: "4937500",
      transactionHash: txA,
      blockNumber: 70192000,
      logIndex: 1,
      timestamp: 1760341400,
    },
    {
      id: `10143:${CONTRACT}:${txB}:2`,
      wallet: ALICE.toLowerCase(),
      packageId: 2,
      includedMinutes: 300,
      expiresAt: 1760360000,
      amountPaid: "18687500",
      transactionHash: txB,
      blockNumber: 70192500,
      logIndex: 2,
      timestamp: 1760342000,
    },
  ];

  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      data: {
        AccessRented: mockPurchases,
        _meta: [syncedMeta()],
      },
    }),
  });

  const service = createPurchaseHistoryService({
    envioUrl: "https://indexer.example.com/graphql",
    fetchImpl: mockFetch,
  });

  const result = await service.getPurchases({ wallet: ALICE });
  assert.equal(result.ok, true);
  assert.equal(result.status, "synced");
  assert.equal(result.purchases.length, 2); // Deduped from 3 to 2
  assert.equal(result.purchases[0].id, mockPurchases[0].id);
  assert.equal(result.purchases[0].includedMinutes, 60);
  assert.equal(result.purchases[1].id, mockPurchases[2].id);
  assert.equal(result.purchases[1].includedMinutes, 300);
  assert.equal(result.sync.isReady, true);
  assert.equal(result.sync.ready, true);
  assert.equal(result.sync.numBlocksBehind, 0);
  assert.equal(result.sync.progressBlock, 70193000);
  assert.equal(result.sync.sourceBlock, 70193000);
});

test("purchase history: derives synced status from correct-chain metadata", async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      data: { AccessRented: [], _meta: [syncedMeta()] },
    }),
  });
  const service = createPurchaseHistoryService({
    envioUrl: "https://indexer.example.com/graphql",
    fetchImpl: mockFetch,
  });
  const result = await service.getPurchases({ wallet: ALICE });
  assert.equal(result.ok, true);
  assert.equal(result.status, "synced");
  assert.equal(result.sync.status, "synced");
  assert.equal(result.sync.chainId, CHAIN_ID);
  assert.equal(result.sync.isReady, true);
});

test("purchase history: never falls back to another chain's metadata", async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      data: {
        AccessRented: [],
        _meta: [syncedMeta(1), syncedMeta(10)],
      },
    }),
  });
  const service = createPurchaseHistoryService({
    envioUrl: "https://indexer.example.com/graphql",
    fetchImpl: mockFetch,
  });
  const result = await service.getPurchases({ wallet: ALICE });
  assert.equal(result.ok, true);
  assert.notEqual(result.status, "synced");
  assert.equal(result.sync.status, "unknown");
  assert.equal(result.sync.chainId, CHAIN_ID);
});

test("purchase history: missing metadata never reports synced", async () => {
  for (const metaPayload of [
    { AccessRented: [], _meta: [] },
    { AccessRented: [] },
    { AccessRented: [], _meta: null },
    { AccessRented: [], _meta: { status: { chains: [{ chainId: 10143 }] } } },
  ]) {
    const mockFetch = async () => ({ ok: true, json: async () => ({ data: metaPayload }) });
    const service = createPurchaseHistoryService({
      envioUrl: "https://indexer.example.com/graphql",
      fetchImpl: mockFetch,
    });
    const result = await service.getPurchases({ wallet: ALICE });
    assert.notEqual(result.status, "synced", `payload ${JSON.stringify(metaPayload)} must not be synced`);
    assert.equal(result.sync.status, "unknown");
  }
});

test("purchase history: malformed metadata never reports synced", async () => {
  const badMetas = [
    [{ chainId: 10143, progressBlock: "not-a-number", sourceBlock: 70193000, isReady: true }],
    [{ chainId: 10143, progressBlock: 70193000, sourceBlock: null, isReady: true }],
    [{ chainId: 10143, progressBlock: 70193000, sourceBlock: 70193000, isReady: "yes" }],
    [{ progressBlock: 70193000, sourceBlock: 70193000, isReady: true }],
  ];
  for (const bad of badMetas) {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ data: { AccessRented: [], _meta: bad } }),
    });
    const service = createPurchaseHistoryService({
      envioUrl: "https://indexer.example.com/graphql",
      fetchImpl: mockFetch,
    });
    const result = await service.getPurchases({ wallet: ALICE });
    assert.notEqual(result.status, "synced");
    assert.equal(result.sync.status, "unknown");
  }
});

test("purchase history: detects indexing lag from progressBlock/sourceBlock", async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      data: {
        AccessRented: [],
        _meta: [syncedMeta(CHAIN_ID, { progressBlock: 70192958, sourceBlock: 70193000, isReady: true })],
      },
    }),
  });

  const service = createPurchaseHistoryService({
    envioUrl: "https://indexer.example.com/graphql",
    fetchImpl: mockFetch,
  });

  const result = await service.getPurchases({ wallet: ALICE });
  assert.equal(result.ok, true);
  assert.equal(result.status, "indexing_lag");
  assert.equal(result.sync.status, "indexing_lag");
  assert.equal(result.sync.numBlocksBehind, 42);
  assert.equal(result.sync.latestBlock, 70193000);
  assert.equal(result.sync.progressBlock, 70192958);
  assert.equal(result.sync.sourceBlock, 70193000);
});

test("purchase history: not-ready chain reports indexing rather than synced", async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      data: {
        AccessRented: [],
        _meta: [syncedMeta(CHAIN_ID, { progressBlock: 70191000, sourceBlock: 70191000, isReady: false })],
      },
    }),
  });
  const service = createPurchaseHistoryService({
    envioUrl: "https://indexer.example.com/graphql",
    fetchImpl: mockFetch,
  });
  const result = await service.getPurchases({ wallet: ALICE });
  assert.equal(result.sync.isReady, false);
  assert.notEqual(result.status, "synced");
  assert.equal(result.status, "indexing");
});

test("purchase history: drops foreign purchase records outside wallet and deployment scope", async () => {
  const ownTx = `0x${"c".repeat(64)}`;
  const foreignTx = `0x${"d".repeat(64)}`;
  const own = validPurchase({
    id: `10143:${CONTRACT}:${ownTx}:5`,
    transactionHash: ownTx,
    logIndex: 5,
  });
  const foreignWallet = validPurchase({
    id: `10143:${CONTRACT}:${foreignTx}:6`,
    wallet: BOB.toLowerCase(),
    transactionHash: foreignTx,
    logIndex: 6,
  });
  const wrongChainId = validPurchase({
    id: `1:${CONTRACT}:${foreignTx}:7`,
    transactionHash: foreignTx,
    logIndex: 7,
  });
  const preDeploy = validPurchase({
    id: `10143:${CONTRACT}:${foreignTx}:8`,
    transactionHash: foreignTx,
    logIndex: 8,
    blockNumber: DEPLOY_BLOCK - 10,
  });
  const badTxHash = validPurchase({
    id: `10143:${CONTRACT}:not-a-hash:9`,
    transactionHash: "not-a-hash",
    logIndex: 9,
  });

  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      data: { AccessRented: [own, foreignWallet, wrongChainId, preDeploy, badTxHash], _meta: [syncedMeta()] },
    }),
  });
  const service = createPurchaseHistoryService({
    envioUrl: "https://indexer.example.com/graphql",
    fetchImpl: mockFetch,
  });
  const result = await service.getPurchases({ wallet: ALICE });
  assert.equal(result.ok, true);
  assert.equal(result.purchases.length, 1);
  assert.equal(result.purchases[0].id, own.id);
  assert.equal(result.purchases[0].transactionHash, ownTx);
});

test("purchase history: handles GraphQL errors cleanly without leaking credentials", async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      errors: [{ message: "Field 'AccessRented' does not exist" }],
    }),
  });

  const service = createPurchaseHistoryService({
    envioUrl: "https://indexer.example.com/graphql",
    envioApiKey: "super-secret-key-12345",
    fetchImpl: mockFetch,
  });

  const result = await service.getPurchases({ wallet: ALICE });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 503);
  assert.equal(result.status, "unavailable");
  assert.match(result.error, /Envio GraphQL error/);
  // Ensure the secret key is never leaked
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("super-secret-key-12345"), false);
});

test("purchase history: handles HTTP error status from indexer", async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 502,
  });

  const service = createPurchaseHistoryService({
    envioUrl: "https://indexer.example.com/graphql",
    fetchImpl: mockFetch,
  });

  const result = await service.getPurchases({ wallet: ALICE });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 503);
  assert.equal(result.status, "unavailable");
  assert.match(result.error, /Envio HTTP error: 502/);
});

test("purchase history: handles query timeout gracefully", async () => {
  const mockFetch = async (_url, { signal }) => {
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  };

  const service = createPurchaseHistoryService({
    envioUrl: "https://indexer.example.com/graphql",
    timeoutMs: 10,
    fetchImpl: mockFetch,
  });

  const result = await service.getPurchases({ wallet: ALICE });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 503);
  assert.equal(result.status, "unavailable");
  assert.match(result.error, /timed out/i);
});

test("purchase history: stalled response body returns bounded unavailable", async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => new Promise(() => {}), // never resolves
  });
  const service = createPurchaseHistoryService({
    envioUrl: "https://indexer.example.com/graphql",
    envioApiKey: "super-secret-key-12345",
    timeoutMs: 20,
    fetchImpl: mockFetch,
  });
  const started = Date.now();
  const result = await service.getPurchases({ wallet: ALICE });
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.equal(result.status, "unavailable");
  assert.match(result.error, /timed out/i);
  assert.ok(elapsed < 2000, `stalled body must be bounded, took ${elapsed}ms`);
  assert.equal(JSON.stringify(result).includes("super-secret-key-12345"), false);
});
