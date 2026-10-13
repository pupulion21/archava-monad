import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.mjs";
import { createPurchaseHistoryService } from "./purchases.mjs";

test("Envio isolation: indexer failure does not grant or remove paid access", async () => {
  // Mock credit reader returns active entitlement
  const mockCredits = {
    active: true,
    purchasedMinutes: 60,
    usedSeconds: 120,
    reservedSeconds: 0,
    remainingSeconds: 3480,
  };
  const readCredits = async (_wallet) => ({ purchasedMinutes: 60 });
  const usage = {
    balance: async (_wallet, purchasedMinutes) => ({
      active: true,
      purchasedMinutes,
      usedSeconds: 120,
      reservedSeconds: 0,
      remainingSeconds: 3480,
    }),
  };

  // Mock Envio service is failing (e.g. 503 unavailable)
  const failingEnvioService = createPurchaseHistoryService({
    envioUrl: "https://indexer.invalid/v1/graphql",
    fetchImpl: async () => ({
      ok: false,
      status: 503,
    }),
  });

  const app = createApp({
    now: () => 1760340000000,
    origin: "http://localhost:5174",
    chainId: 10143,
    contractAddress: "0x7324a2678e74052a4e9a244c0d57b56b23fee6ad",
    paymentTokenAddress: "0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c",
    previewController: { available: () => true },
    readCredits,
    usage,
    purchases: failingEnvioService,
  });

  const wallet = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

  // 1. Authoritative access remains 200 OK with full balance
  const accessReq = {
    method: "GET",
    url: `/api/access?wallet=${wallet}`,
    headers: { host: "localhost" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  let accessStatusCode = 0;
  let accessBody = "";
  const accessRes = {
    writeHead(status, _headers) { accessStatusCode = status; },
    end(body) { accessBody = body; },
  };
  await app.handle(accessReq, accessRes);

  assert.equal(accessStatusCode, 200);
  const parsedAccess = JSON.parse(accessBody);
  assert.equal(parsedAccess.active, true);
  assert.equal(parsedAccess.remainingSeconds, 3480);

  // 2. Purchases endpoint gracefully returns 503/unavailable without crashing
  const purchasesReq = {
    method: "GET",
    url: `/api/purchases?wallet=${wallet}`,
    headers: { host: "localhost" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  let purchasesStatusCode = 0;
  let purchasesBody = "";
  const purchasesRes = {
    writeHead(status, _headers) { purchasesStatusCode = status; },
    end(body) { purchasesBody = body; },
  };
  await app.handle(purchasesReq, purchasesRes);

  assert.equal(purchasesStatusCode, 503);
  const parsedPurchases = JSON.parse(purchasesBody);
  assert.equal(parsedPurchases.ok, false);
  assert.equal(parsedPurchases.status, "unavailable");
  assert.equal(parsedPurchases.sync.status, "unavailable");
});

test("Envio isolation: returns indexed purchases scoped exactly to the requested wallet", async () => {
  const alice = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
  const bob = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
  const canonicalContract = "0x7324a2678e74052a4e9a244c0d57b56b23fee6ad";
  const aliceTx = `0x${"a".repeat(64)}`;
  const bobTx = `0x${"b".repeat(64)}`;

  const mockDb = {
    [alice]: [
      {
        id: `10143:${canonicalContract}:${aliceTx}:1`,
        wallet: alice,
        packageId: 1,
        includedMinutes: 60,
        expiresAt: 1760350000,
        amountPaid: "4937500",
        transactionHash: aliceTx,
        blockNumber: 70192000,
        logIndex: 1,
        timestamp: 1760340000,
      },
    ],
    [bob]: [
      {
        id: `10143:${canonicalContract}:${bobTx}:2`,
        wallet: bob,
        packageId: 2,
        includedMinutes: 300,
        expiresAt: 1760370000,
        amountPaid: "18687500",
        transactionHash: bobTx,
        blockNumber: 70192500,
        logIndex: 2,
        timestamp: 1760341000,
      },
    ],
  };

  const envioService = createPurchaseHistoryService({
    envioUrl: "https://indexer.example.com/graphql",
    fetchImpl: async (_url, options) => {
      const { variables } = JSON.parse(options.body);
      const userPurchases = mockDb[variables.wallet] || [];
      return {
        ok: true,
        json: async () => ({
          data: {
            AccessRented: userPurchases,
            _meta: [
              {
                chainId: 10143,
                progressBlock: 70195000,
                sourceBlock: 70195000,
                isReady: true,
                startBlock: 70191614,
                endBlock: null,
                eventsProcessed: 2,
              },
            ],
          },
        }),
      };
    },
  });

  const app = createApp({
    now: () => 1760340000000,
    origin: "http://localhost:5174",
    chainId: 10143,
    contractAddress: "0x7324a2678e74052a4e9a244c0d57b56b23fee6ad",
    paymentTokenAddress: "0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c",
    previewController: { available: () => true },
    purchases: envioService,
  });

  // Query Alice's purchases
  const aliceReq = {
    method: "GET",
    url: `/api/purchases?wallet=${alice}`,
    headers: { host: "localhost" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  let aliceStatus = 0;
  let aliceBody = "";
  const aliceRes = {
    writeHead(s) { aliceStatus = s; },
    end(b) { aliceBody = b; },
  };
  await app.handle(aliceReq, aliceRes);

  assert.equal(aliceStatus, 200);
  const aliceData = JSON.parse(aliceBody);
  assert.equal(aliceData.purchases.length, 1);
  assert.equal(aliceData.purchases[0].includedMinutes, 60);
  assert.equal(aliceData.purchases[0].transactionHash, `0x${"a".repeat(64)}`);

  // Query Bob's purchases
  const bobReq = {
    method: "GET",
    url: `/api/purchases?wallet=${bob}`,
    headers: { host: "localhost" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  let bobStatus = 0;
  let bobBody = "";
  const bobRes = {
    writeHead(s) { bobStatus = s; },
    end(b) { bobBody = b; },
  };
  await app.handle(bobReq, bobRes);

  assert.equal(bobStatus, 200);
  const bobData = JSON.parse(bobBody);
  assert.equal(bobData.purchases.length, 1);
  assert.equal(bobData.purchases[0].includedMinutes, 300);
  assert.equal(bobData.purchases[0].transactionHash, `0x${"b".repeat(64)}`);
});
