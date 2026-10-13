import assert from "node:assert/strict";
import test from "node:test";
import { Interface, TransactionResponse } from "ethers";
import {
  MONAD_CHAIN_ID_HEX,
  CANONICAL_CONTRACTS,
  normalizeChainId,
  createOperationContext,
  assertActiveContext,
  ensureMonadChain,
  ContextAbortedError,
  type EthereumProvider,
} from "./wallet.ts";
import {
  buyMinutePack,
  waitForCreditSync,
  savePendingPurchase,
  getPendingPurchase,
  updatePendingPurchaseStage,
  updatePendingPurchaseHash,
  clearPendingPurchase,
  matchesOperationIdentity,
  hasActivePendingPurchase,
  recoverPendingPurchase,
  abortableSleep,
  RENTAL_ABI,
  PAYMENT_TOKEN_ABI,
} from "./rental.ts";
import { OperationController } from "./operationLock.ts";
import { ApiError } from "./apiError.ts";

const VALID_CONFIG = {
  chainId: 10143,
  contractAddress: "0x7324a2678e74052a4e9a244c0d57b56b23fee6ad",
  paymentTokenAddress: "0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c",
  packMinutes: [60, 300],
};

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";

const rentalInterface = new Interface(RENTAL_ABI);
const tokenInterface = new Interface(PAYMENT_TOKEN_ABI);

function createMockEthereum(initial: {
  chainId?: string;
  accounts?: string[];
  handlers?: Record<string, (params?: any) => Promise<any> | any>;
}) {
  let currentChainId = initial.chainId || MONAD_CHAIN_ID_HEX;
  let currentAccounts = initial.accounts ? [...initial.accounts] : [ALICE];
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};
  const customHandlers = initial.handlers || {};

  const eth: EthereumProvider & {
    setChainId: (hex: string) => void;
    setAccounts: (accs: string[]) => void;
    _emit: (event: string, ...args: any[]) => void;
    callCount: Record<string, number>;
  } = {
    callCount: {},
    setChainId(hex: string) {
      currentChainId = hex;
      eth._emit("chainChanged", hex);
    },
    setAccounts(accs: string[]) {
      currentAccounts = [...accs];
      eth._emit("accountsChanged", accs);
    },
    async request({ method, params }: { method: string; params?: any }) {
      eth.callCount[method] = (eth.callCount[method] || 0) + 1;

      if (customHandlers[method]) {
        return customHandlers[method](params);
      }

      switch (method) {
        case "eth_chainId":
          return currentChainId;
        case "eth_accounts":
          return currentAccounts;
        case "eth_requestAccounts":
          return currentAccounts;
        case "eth_getBalance":
          // Return 10 MON in hex
          return "0x8ac7230489e80000";
        case "eth_estimateGas":
          return "0x5208";
        case "eth_gasPrice":
          return "0x3b9aca00";
        case "eth_call": {
          const to = params?.[0]?.to?.toLowerCase();
          const data = params?.[0]?.data;
          if (!data) return "0x";

          // Payment Token calls
          if (to === CANONICAL_CONTRACTS.mockUsdt.toLowerCase()) {
            const parsed = tokenInterface.parseTransaction({ data });
            if (parsed?.name === "balanceOf") {
              return tokenInterface.encodeFunctionResult("balanceOf", [100000000n]); // 100 USDT
            }
            if (parsed?.name === "allowance") {
              return tokenInterface.encodeFunctionResult("allowance", [0n]); // 0 allowance initially
            }
            if (parsed?.name === "hasClaimed") {
              return tokenInterface.encodeFunctionResult("hasClaimed", [false]);
            }
          }

          // Rental Contract calls
          if (to === CANONICAL_CONTRACTS.rentalV2.toLowerCase()) {
            const parsed = rentalInterface.parseTransaction({ data });
            if (parsed?.name === "quoteRent") {
              return rentalInterface.encodeFunctionResult("quoteRent", [10000000n]); // 10 USDT
            }
          }
          return "0x";
        }
        case "eth_sendTransaction":
          return "0x1111111111111111111111111111111111111111111111111111111111111111";
        case "eth_getTransactionByHash": {
          const hash = params?.[0] || "0x1111111111111111111111111111111111111111111111111111111111111111";
          return {
            hash,
            from: ALICE,
            to: CANONICAL_CONTRACTS.rentalV2,
            gas: "0x5208",
            gasLimit: "0x5208",
            gasPrice: "0x3b9aca00",
            maxFeePerGas: "0x3b9aca00",
            maxPriorityFeePerGas: "0x3b9aca00",
            value: "0x0",
            nonce: "0x0",
            input: "0x",
            data: "0x",
            type: "0x2",
            chainId: MONAD_CHAIN_ID_HEX,
            r: "0x1111111111111111111111111111111111111111111111111111111111111111",
            s: "0x2222222222222222222222222222222222222222222222222222222222222222",
            v: 0,
            yParity: 0,
            blockHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
            blockNumber: "0x42f0d0e",
            transactionIndex: "0x0",
          };
        }
        case "eth_getTransactionReceipt": {
          const hash = params?.[0] || "0x1111111111111111111111111111111111111111111111111111111111111111";
          return {
            status: "0x1",
            transactionHash: hash,
            from: ALICE,
            to: CANONICAL_CONTRACTS.rentalV2,
            contractAddress: null,
            transactionIndex: "0x0",
            gasUsed: "0x5208",
            cumulativeGasUsed: "0x5208",
            effectiveGasPrice: "0x3b9aca00",
            logs: [],
            logsBloom: "0x" + "00".repeat(256),
            blockNumber: "0x42f0d0e",
            blockHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
            type: "0x2",
          };
        }
        case "eth_blockNumber":
          return "0x42f0d0e";
        case "eth_getBlockByHash":
        case "eth_getBlockByNumber":
          return {
            number: "0x42f0d0e",
            hash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
          };
        case "wallet_switchEthereumChain":
          currentChainId = params?.[0]?.chainId || MONAD_CHAIN_ID_HEX;
          return null;
        default:
          throw new Error(`Unhandled mock RPC method: ${method}`);
      }
    },
    on(event: string, listener: (...args: any[]) => void) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(listener);
    },
    removeListener(event: string, listener: (...args: any[]) => void) {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((l) => l !== listener);
      }
    },
    _emit(event: string, ...args: any[]) {
      for (const listener of listeners[event] || []) {
        listener(...args);
      }
    },
  };

  (globalThis as any).window = { ethereum: eth };
  return eth;
}

function setupMockLocalStorage() {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) || null,
    setItem: (key: string, val: string) => store.set(key, val),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  };
  return store;
}

// ============================================================================
// TEMUAN 1: APPROVAL / SIDE-EFFECT ON WRONG CHAIN OR MISMATCHED CONTEXT (P1)
// ============================================================================

test("Temuan 1: assertActiveContext rejects when chain switches to BSC 97 before approval", async () => {
  setupMockLocalStorage();
  const eth = createMockEthereum({ chainId: MONAD_CHAIN_ID_HEX, accounts: [ALICE] });
  const context = await createOperationContext(ALICE);

  // User changes network in wallet before approval step
  eth.setChainId("0x61"); // BSC Testnet 97

  await assert.rejects(
    async () => assertActiveContext(context),
    (err: any) =>
      err instanceof ContextAbortedError &&
      /Network changed during operation \(expected chain 10143, current is 97\)/.test(err.message)
  );
});

test("Temuan 1: buyMinutePack aborts before approve() if network changes to chain 97", async () => {
  setupMockLocalStorage();
  let approveSent = false;

  const eth = createMockEthereum({
    chainId: MONAD_CHAIN_ID_HEX,
    accounts: [ALICE],
    handlers: {
      eth_sendTransaction: async (_params: any) => {
        approveSent = true;
        return "0x1111111111111111111111111111111111111111111111111111111111111111";
      },
    },
  });

  let stageChanges: string[] = [];
  const callbacks = {
    onStageChange: (stage: string) => {
      stageChanges.push(stage);
      if (stage === "approving") {
        // Network switch happens mid-flow right before assertActiveContext for approval
        eth.setChainId("0x61"); // 97
      }
    },
  };

  await assert.rejects(
    async () => buyMinutePack(VALID_CONFIG as any, 60, ALICE, callbacks),
    (err: any) =>
      err instanceof ContextAbortedError &&
      /Network changed during operation \(expected chain 10143, current is 97\)/.test(err.message)
  );

  // Prove token.approve was NEVER sent
  assert.equal(approveSent, false, "approve transaction must not be sent on wrong chain");
});

test("Temuan 1: assertActiveContext rejects if account switches from ALICE to BOB", async () => {
  setupMockLocalStorage();
  const eth = createMockEthereum({ chainId: MONAD_CHAIN_ID_HEX, accounts: [ALICE] });
  const context = await createOperationContext(ALICE);

  // User switches active account in wallet mid-flow
  eth.setAccounts([BOB]);

  await assert.rejects(
    async () => assertActiveContext(context),
    (err: any) =>
      err instanceof ContextAbortedError &&
      /Active account changed during operation/.test(err.message)
  );
});

test("Temuan 1: assertActiveContext rejects if window.ethereum provider is swapped mid-flow", async () => {
  setupMockLocalStorage();
  createMockEthereum({ chainId: MONAD_CHAIN_ID_HEX, accounts: [ALICE] });
  const context = await createOperationContext(ALICE);

  // Provider object replaced (e.g. extension conflict or wallet switch)
  (globalThis as any).window = {
    ethereum: createMockEthereum({ chainId: MONAD_CHAIN_ID_HEX, accounts: [ALICE] }),
  };

  await assert.rejects(
    async () => assertActiveContext(context),
    (err: any) =>
      err instanceof ContextAbortedError &&
      /Wallet provider instance changed during operation/.test(err.message)
  );
});

test("Temuan 1: normalizeChainId strictly parses valid chain IDs and rejects malformed/unsafe inputs", () => {
  assert.equal(normalizeChainId(10143), 10143);
  assert.equal(normalizeChainId("0x279f"), 10143);
  assert.equal(normalizeChainId("0x279F"), 10143);
  assert.equal(normalizeChainId("10143"), 10143);
  assert.equal(normalizeChainId(97), 97);
  assert.equal(normalizeChainId("0x61"), 97);

  // Must reject zero, negative, floats, unsafe, and malformed
  assert.throws(() => normalizeChainId(0), /must be a positive safe integer/);
  assert.throws(() => normalizeChainId(-1), /must be a positive safe integer/);
  assert.throws(() => normalizeChainId(10143.5), /must be a positive safe integer/);
  assert.throws(() => normalizeChainId("0x"), /Invalid chain ID/);
  assert.throws(() => normalizeChainId("0xggg"), /Invalid chain ID/);
  assert.throws(() => normalizeChainId(""), /Invalid chain ID/);
  assert.throws(() => normalizeChainId("not-a-chain"), /Invalid chain ID/);
  assert.throws(() => normalizeChainId({ chainId: 10143 }), /Invalid chain ID/);
});

// ============================================================================
// TEMUAN 2: PENDING PURCHASE SAVED IMMEDIATELY ON BROADCAST & RECOVERY (P1)
// ============================================================================

test("Temuan 2: buyMinutePack persists pending purchase to localStorage immediately upon broadcast", async () => {
  setupMockLocalStorage();
  let rentWaitTriggered = false;

  createMockEthereum({
    chainId: MONAD_CHAIN_ID_HEX,
    accounts: [ALICE],
    handlers: {
      eth_call: async (params: any) => {
        const to = params?.[0]?.to?.toLowerCase();
        const data = params?.[0]?.data;
        if (to === CANONICAL_CONTRACTS.mockUsdt.toLowerCase()) {
          const parsed = tokenInterface.parseTransaction({ data });
          if (parsed?.name === "balanceOf") {
            return tokenInterface.encodeFunctionResult("balanceOf", [100000000n]);
          }
          if (parsed?.name === "allowance") {
            // Already approved so we test the rental broadcast directly
            return tokenInterface.encodeFunctionResult("allowance", [100000000n]);
          }
          if (parsed?.name === "hasClaimed") {
            return tokenInterface.encodeFunctionResult("hasClaimed", [true]);
          }
        }
        if (to === CANONICAL_CONTRACTS.rentalV2.toLowerCase()) {
          const parsed = rentalInterface.parseTransaction({ data });
          if (parsed?.name === "quoteRent") {
            return rentalInterface.encodeFunctionResult("quoteRent", [10000000n]);
          }
        }
        return "0x";
      },
      eth_sendTransaction: async () => {
        return "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      },
      eth_getTransactionReceipt: async () => {
        // While wait() is resolving receipt, we inspect localStorage!
        rentWaitTriggered = true;
        const pending = getPendingPurchase(ALICE);
        assert.ok(pending, "pending purchase MUST exist before receipt is returned!");
        assert.equal(pending.stage, "awaiting_receipt");
        assert.equal(pending.txHash, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert.equal(pending.minutes, 60);
        assert.equal(pending.packageId, 1);
        return {
          status: "0x1",
          transactionHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          from: ALICE,
          to: CANONICAL_CONTRACTS.rentalV2,
          contractAddress: null,
          transactionIndex: "0x0",
          gasUsed: "0x5208",
          cumulativeGasUsed: "0x5208",
          effectiveGasPrice: "0x3b9aca00",
          logs: [],
          logsBloom: "0x" + "00".repeat(256),
          blockNumber: "0x42f0d0e",
          blockHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
          type: "0x2",
        };
      },
    },
  });

  let submittedInfo: any = null;
  const hash = await buyMinutePack(VALID_CONFIG as any, 60, ALICE, {
    onSubmitted: (info) => {
      submittedInfo = info;
    },
  });

  assert.equal(rentWaitTriggered, true);
  assert.equal(hash, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(submittedInfo?.stage, "rental");
  assert.equal(submittedInfo?.txHash, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

  // Post-receipt stage must be awaiting_credit
  const finalPending = getPendingPurchase(ALICE);
  assert.equal(finalPending?.stage, "awaiting_credit");
});

test("Temuan 2: buyMinutePack rejects duplicate checkout while pending purchase is active", async () => {
  setupMockLocalStorage();
  createMockEthereum({ chainId: MONAD_CHAIN_ID_HEX, accounts: [ALICE] });

  // Simulate existing unresolved pending purchase in localStorage
  savePendingPurchase({
    schemaVersion: 1,
    deploymentId: "archava-monad",
    chainId: 10143,
    wallet: ALICE,
    rentalContract: CANONICAL_CONTRACTS.rentalV2,
    paymentToken: CANONICAL_CONTRACTS.mockUsdt,
    packageId: 1,
    minutes: 60,
    txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    stage: "awaiting_receipt",
    submittedAt: Date.now() - 5000,
  });

  assert.equal(hasActivePendingPurchase(ALICE), true);

  await assert.rejects(
    async () => buyMinutePack(VALID_CONFIG as any, 60, ALICE),
    /existing minute-pack purchase is already pending for this wallet/
  );
});

test("Temuan 2: buyMinutePack handles TRANSACTION_REPLACED (repricing vs cancellation)", async () => {
  setupMockLocalStorage();
  const originalWait = TransactionResponse.prototype.wait;

  try {
    // Test 1: User speeds up / reprices transaction
    createMockEthereum({
      chainId: MONAD_CHAIN_ID_HEX,
      accounts: [ALICE],
      handlers: {
        eth_call: async (params: any) => {
          const to = params?.[0]?.to?.toLowerCase();
          const data = params?.[0]?.data;
          if (to === CANONICAL_CONTRACTS.mockUsdt.toLowerCase()) {
            const parsed = tokenInterface.parseTransaction({ data });
            if (parsed?.name === "balanceOf") return tokenInterface.encodeFunctionResult("balanceOf", [100000000n]);
            if (parsed?.name === "allowance") return tokenInterface.encodeFunctionResult("allowance", [100000000n]);
          }
          if (to === CANONICAL_CONTRACTS.rentalV2.toLowerCase()) {
            return rentalInterface.encodeFunctionResult("quoteRent", [10000000n]);
          }
          return "0x";
        },
        eth_sendTransaction: async () => "0x1111111111111111111111111111111111111111111111111111111111111111",
      },
    });

    TransactionResponse.prototype.wait = async function () {
      const replacedErr: any = new Error("transaction replaced");
      replacedErr.code = "TRANSACTION_REPLACED";
      replacedErr.replacement = { hash: "0x2222222222222222222222222222222222222222222222222222222222222222" };
      replacedErr.receipt = {
        status: 1,
        transactionHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
      };
      throw replacedErr;
    };

    const returnedHash = await buyMinutePack(VALID_CONFIG as any, 60, ALICE);
    assert.equal(returnedHash, "0x2222222222222222222222222222222222222222222222222222222222222222");
    const pending = getPendingPurchase(ALICE);
    assert.equal(pending?.txHash, "0x2222222222222222222222222222222222222222222222222222222222222222");

    // Test 2: User cancels transaction in wallet
    clearPendingPurchase(ALICE);
    TransactionResponse.prototype.wait = async function () {
      const cancelledErr: any = new Error("transaction cancelled");
      cancelledErr.code = "TRANSACTION_REPLACED";
      cancelledErr.cancelled = true;
      throw cancelledErr;
    };

    await assert.rejects(
      async () => buyMinutePack(VALID_CONFIG as any, 60, ALICE),
      /Rental transaction was cancelled in the wallet/
    );
    const cancelledPending = getPendingPurchase(ALICE);
    assert.equal(cancelledPending?.stage, "cancelled");
  } finally {
    TransactionResponse.prototype.wait = originalWait;
  }
});

test("Temuan 2: recoverPendingPurchase checks receipt and credit sync without sending new transactions", async () => {
  setupMockLocalStorage();
  let sendCount = 0;

  createMockEthereum({
    chainId: MONAD_CHAIN_ID_HEX,
    accounts: [ALICE],
    handlers: {
      eth_sendTransaction: async () => {
        sendCount++;
        return "0xnever";
      },
      eth_getTransactionReceipt: async () => ({
        status: "0x1",
        transactionHash: "0x4444444444444444444444444444444444444444444444444444444444444444",
        from: ALICE,
        to: CANONICAL_CONTRACTS.rentalV2,
        contractAddress: null,
        transactionIndex: "0x0",
        gasUsed: "0x5208",
        cumulativeGasUsed: "0x5208",
        effectiveGasPrice: "0x3b9aca00",
        logs: [],
        logsBloom: "0x" + "00".repeat(256),
        blockNumber: "0x42f0d0e",
        blockHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        type: "0x2",
      }),
    },
  });

  const txHash = "0x4444444444444444444444444444444444444444444444444444444444444444";
  savePendingPurchase({
    schemaVersion: 1,
    deploymentId: "archava-monad",
    chainId: 10143,
    wallet: ALICE,
    rentalContract: CANONICAL_CONTRACTS.rentalV2,
    paymentToken: CANONICAL_CONTRACTS.mockUsdt,
    packageId: 1,
    minutes: 60,
    txHash,
    stage: "awaiting_receipt",
    submittedAt: Date.now() - 10000,
  });

  (globalThis as any).fetch = async (url: string) => {
    if (url.includes("/api/purchase/status")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, txHash, wallet: ALICE, credited: true, status: "credited" }),
      };
    }
    if (url.includes("/api/access")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          active: true,
          purchasedMinutes: 60,
          usedSeconds: 0,
          reservedSeconds: 0,
          remainingSeconds: 3600,
        }),
      };
    }
    throw new Error(`Unhandled mock fetch: ${url}`);
  };

  const recovered = await recoverPendingPurchase(ALICE);
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.credits?.purchasedMinutes, 60);
  assert.equal(sendCount, 0, "must NEVER re-send transaction during recovery");
  assert.equal(getPendingPurchase(ALICE), null, "cleared on completion");
});

test("Temuan 2: local storage scoping isolates Wallets and rejects foreign scopes", () => {
  setupMockLocalStorage();

  savePendingPurchase({
    schemaVersion: 1,
    deploymentId: "archava-monad",
    chainId: 10143,
    wallet: ALICE,
    rentalContract: CANONICAL_CONTRACTS.rentalV2,
    paymentToken: CANONICAL_CONTRACTS.mockUsdt,
    packageId: 1,
    minutes: 60,
    txHash: "0x5555555555555555555555555555555555555555555555555555555555555555",
    stage: "broadcast",
    submittedAt: Date.now(),
  });

  // Bob's pending purchase is isolated and null
  assert.equal(getPendingPurchase(BOB), null);

  // Foreign deployment scope fails closed
  const foreignKey = `archava_pending_v1_archava-monad_10143_${BOB.toLowerCase()}`;
  localStorage.setItem(
    foreignKey,
    JSON.stringify({
      schemaVersion: 1,
      deploymentId: "archava-bnb", // Foreign
      chainId: 97, // Foreign
      wallet: BOB,
      rentalContract: CANONICAL_CONTRACTS.rentalV2,
      paymentToken: CANONICAL_CONTRACTS.mockUsdt,
      packageId: 1,
      minutes: 60,
      txHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
      stage: "broadcast",
      submittedAt: Date.now(),
    })
  );
  assert.equal(getPendingPurchase(BOB), null, "must reject foreign deployment scope");
});

// ============================================================================
// TEMUAN 3 / RESIDUAL 1: OPERATION CONTROLLER & LOCK OWNERSHIP (PRODUCTION)
// ============================================================================

test("Residual 1 / Temuan 3: initial wrong network -> auto-switch succeeds -> checkout completes -> lock and loading clean", async () => {
  setupMockLocalStorage();
  const controller = new OperationController();

  let switchedToMonad = false;
  const eth = createMockEthereum({
    chainId: "0x61", // BSC Testnet 97
    accounts: [ALICE],
    handlers: {
      wallet_switchEthereumChain: async (params: any) => {
        if (params?.[0]?.chainId === MONAD_CHAIN_ID_HEX) {
          switchedToMonad = true;
          eth.setChainId(MONAD_CHAIN_ID_HEX);
          controller.invalidate("chainChanged");
          return null;
        }
        throw new Error("Unknown chain");
      },
      eth_sendTransaction: async () => "0x2222222222222222222222222222222222222222222222222222222222222222",
    },
  });

  (globalThis as any).window = { ethereum: eth };

  let uiLoading = "buy";
  let lock = null;
  try {
    // 1. Preparation phase: ensureMonadChain switches network from 97 to Monad 10143
    await ensureMonadChain(eth);
    assert.equal(switchedToMonad, true, "Network switch must have executed");

    // 2. Lock operation after preparation succeeded (captures post-switch epoch)
    lock = controller.acquire("buy", ALICE);
    assert.ok(lock, "Lock must be acquired");
    assert.equal(controller.isLocked(), true);

    // 3. buyMinutePack executes on Monad
    const txHash = await buyMinutePack(VALID_CONFIG as any, 60, ALICE);
    assert.ok(txHash);

    // 4. Verify lock is still active
    assert.equal(lock.isActive(), true, "Lock must remain active because switch happened during preparation");
  } finally {
    if (lock) lock.release();
    if (!controller.isLocked()) {
      uiLoading = "";
    }
  }

  assert.equal(controller.isLocked(), false, "Controller must be unlocked");
  assert.equal(uiLoading, "", "UI loading must be cleared, checkout is not locked!");
});

test("Residual 1 / Temuan 3: user rejects network switch -> lock and loading cleared cleanly", async () => {
  const controller = new OperationController();
  const eth = createMockEthereum({
    chainId: "0x61",
    accounts: [ALICE],
    handlers: {
      wallet_switchEthereumChain: async () => {
        const err: any = new Error("User rejected");
        err.code = 4001;
        throw err;
      },
    },
  });

  (globalThis as any).window = { ethereum: eth };

  let uiLoading = "buy";
  let lock = null;
  let errorCaught = false;

  try {
    await ensureMonadChain(eth);
    lock = controller.acquire("buy", ALICE);
  } catch (err: any) {
    errorCaught = true;
    assert.ok(/rejected/i.test(err.message));
  } finally {
    if (lock) lock.release();
    if (!controller.isLocked()) {
      uiLoading = "";
    }
  }

  assert.equal(errorCaught, true);
  assert.equal(lock, null, "Lock was never acquired");
  assert.equal(controller.isLocked(), false);
  assert.equal(uiLoading, "", "UI loading must be cleared cleanly");
});

test("Residual 1 / Temuan 3: unexpected chain change during approval -> rent not sent and lock released", async () => {
  const controller = new OperationController();
  let rentSent = false;

  const eth = createMockEthereum({
    chainId: MONAD_CHAIN_ID_HEX,
    accounts: [ALICE],
    handlers: {
      eth_sendTransaction: async (params: any) => {
        const to = params?.[0]?.to?.toLowerCase();
        if (to === CANONICAL_CONTRACTS.mockUsdt.toLowerCase()) {
          // While approval is running, network unexpectedly changes to 97!
          eth.setChainId("0x61");
          controller.invalidate("chainChanged");
          return "0x1111111111111111111111111111111111111111111111111111111111111111";
        }
        if (to === CANONICAL_CONTRACTS.rentalV2.toLowerCase()) {
          rentSent = true;
          return "0x2222222222222222222222222222222222222222222222222222222222222222";
        }
        return "0x0";
      },
    },
  });

  (globalThis as any).window = { ethereum: eth };

  let uiLoading = "buy";
  let lock = null;
  let caughtError: any = null;

  try {
    await ensureMonadChain(eth);
    lock = controller.acquire("buy", ALICE);
    assert.ok(lock);

    await buyMinutePack(VALID_CONFIG as any, 60, ALICE);
  } catch (err) {
    caughtError = err;
  } finally {
    if (lock) lock.release();
    if (!controller.isLocked()) {
      uiLoading = "";
    }
  }

  assert.ok(caughtError, "Must catch network changed error");
  assert.equal(rentSent, false, "Rental transaction must NOT be sent after unexpected network change");
  assert.equal(controller.isLocked(), false, "Lock must be released");
  assert.equal(uiLoading, "", "UI loading must be cleared");
});

test("Residual 1 / Temuan 3: old operation finishing after new operation active does not release new lock", async () => {
  const controller = new OperationController();

  // Operation 1 (Alice) starts
  const lock1 = controller.acquire("buy", ALICE);
  assert.ok(lock1);
  assert.equal(lock1.id, controller.getCurrentLock()?.id);

  // User switches account to Bob
  controller.invalidate("accountsChanged");
  lock1.release();

  // Operation 2 (Bob) starts
  const lock2 = controller.acquire("buy", BOB);
  assert.ok(lock2);
  assert.equal(lock2.id, controller.getCurrentLock()?.id);

  // Late finally block from Operation 1 executes
  const op1ReleaseResult = lock1.release();
  assert.equal(op1ReleaseResult, false, "Old operation cannot release active lock of new operation");

  // Bob's lock is still held!
  assert.equal(controller.isLocked(), true);
  assert.equal(controller.getCurrentLock()?.id, lock2.id);

  // Bob finishes
  lock2.release();
  assert.equal(controller.isLocked(), false);
});

test("Residual 1 / Temuan 3: late avatar session for invalidated wallet is discarded and immediately closed on backend", async () => {
  let closedTicket: string | null = null;
  const endAvatarSession = async (ticket: string) => {
    closedTicket = ticket;
  };

  const controller = new OperationController();
  let activeSession: any = null;

  const lock = controller.acquire("session", ALICE);
  assert.ok(lock);

  // Alice starts session
  const startPromise = (async () => {
    await abortableSleep(25);
    return { ticket: "ticket_alice_orphan_123", preview: false };
  })();

  // User switches account to Bob mid-handshake
  controller.invalidate("accountsChanged");

  // Session resolves late
  const sessionResult = await startPromise;
  if (!lock.isActive()) {
    // Production behavior: Discard session and end room on backend to prevent leak
    await endAvatarSession(sessionResult.ticket);
  } else {
    activeSession = sessionResult;
  }

  assert.equal(activeSession, null, "stale session must not be set in UI");
  assert.equal(closedTicket, "ticket_alice_orphan_123", "orphaned session room must be closed on backend");
  lock.release();
});

// ============================================================================
// TEMUAN 4: OLD AGGREGATE BALANCE TREATED AS PROOF OF NEW PURCHASE (P2)
// ============================================================================

test("Temuan 4: waitForCreditSync requires specific txHash confirmation regardless of old aggregate balance", async () => {
  setupMockLocalStorage();
  const targetTx = "0xnew_tx_hash_111111111111111111111111111111111111111111111111111111111";

  // Simulate wallet ALICE already has 300 minutes from yesterday
  let purchaseStatusPolls = 0;
  (globalThis as any).fetch = async (url: string) => {
    if (url.includes("/api/purchase/status")) {
      purchaseStatusPolls++;
      assert.ok(url.includes(`txHash=${encodeURIComponent(targetTx)}`));
      if (purchaseStatusPolls < 3) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, txHash: targetTx, wallet: ALICE, credited: false, status: "awaiting_credit" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, txHash: targetTx, wallet: ALICE, credited: true, status: "credited" }),
      };
    }
    if (url.includes("/api/access")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          active: true,
          purchasedMinutes: purchaseStatusPolls < 3 ? 300 : 360,
          usedSeconds: 0,
          reservedSeconds: 0,
          remainingSeconds: purchaseStatusPolls < 3 ? 18000 : 21600,
        }),
      };
    }
    throw new Error(`Unhandled mock fetch: ${url}`);
  };

  // With the bug: if it checked purchasedMinutes >= 60, it would return on poll 1!
  // With the fix: it must poll until txHash is verified in purchase cache
  const credits = await waitForCreditSync(ALICE, targetTx, { intervalMs: 10, maxWaitMs: 1000 });
  assert.equal(credits.purchasedMinutes, 360);
  assert.equal(purchaseStatusPolls, 3, "must poll until the specific txHash is confirmed credited");
});

// ============================================================================
// TEMUAN 5: POLLING TIMEOUT DID NOT BOUND STUCK FETCH (P2)
// ============================================================================

test("Temuan 5: external abort signal immediately halts waitForCreditSync", async () => {
  setupMockLocalStorage();
  (globalThis as any).fetch = async (_url: string, opts?: any) => {
    await abortableSleep(1000, opts?.signal);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const controller = new AbortController();
  const startTime = Date.now();

  setTimeout(() => controller.abort(), 20);

  await assert.rejects(
    async () =>
      waitForCreditSync(ALICE, "0xtx", {
        signal: controller.signal,
        intervalMs: 50,
        maxWaitMs: 10_000,
      }),
    /Credit synchronization aborted/
  );

  const elapsed = Date.now() - startTime;
  assert.ok(elapsed < 200, `Abort should terminate promptly, elapsed: ${elapsed}ms`);
});

test("Temuan 5: non-transient API errors fail immediately without retrying until timeout", async () => {
  setupMockLocalStorage();
  let fetchAttempts = 0;

  (globalThis as any).fetch = async (_url: string) => {
    fetchAttempts++;
    return {
      ok: false,
      status: 400,
      json: async () => ({ error: "Malformed transaction hash parameter", code: "bad_request" }),
    };
  };

  const startTime = Date.now();
  await assert.rejects(
    async () =>
      waitForCreditSync(ALICE, "0xinvalid", {
        intervalMs: 10,
        maxWaitMs: 2000,
      }),
    (err: any) => err instanceof ApiError && err.status === 400
  );

  assert.equal(fetchAttempts, 1, "non-transient 400 must fail fast on attempt 1");
  assert.ok(Date.now() - startTime < 100, "must not spin in retry loop on client error");
});

test("Temuan 5: pending purchase record is preserved on timeout for future recovery", async () => {
  setupMockLocalStorage();
  const txHash = "0xtimeout_tx_1111111111111111111111111111111111111111111111111111111111";

  savePendingPurchase({
    schemaVersion: 1,
    deploymentId: "archava-monad",
    chainId: 10143,
    wallet: ALICE,
    rentalContract: CANONICAL_CONTRACTS.rentalV2,
    paymentToken: CANONICAL_CONTRACTS.mockUsdt,
    packageId: 1,
    minutes: 60,
    txHash,
    stage: "awaiting_credit",
    submittedAt: Date.now(),
  });

  (globalThis as any).fetch = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, txHash, wallet: ALICE, credited: false, status: "awaiting_credit" }),
    };
  };

  await assert.rejects(
    async () => waitForCreditSync(ALICE, txHash, { intervalMs: 10, maxWaitMs: 35 }),
    /credit indexing is taking longer than expected/
  );

  // Crucial requirement: pending record MUST still exist in localStorage so recovery works on reload!
  const pending = getPendingPurchase(ALICE);
  assert.ok(pending, "pending purchase must not be wiped when sync times out");
  assert.equal(pending.stage, "awaiting_credit");
  assert.equal(pending.txHash, txHash);
});

// ============================================================================
// RESIDUAL FINDING 3: CAS PENDING TRANSACTION MUTATIONS & IDENTITY SCOPE
// ============================================================================

test("Residual 3: Late completion of txA after pending changed to txB leaves txB untouched", async () => {
  setupMockLocalStorage();
  const txA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const txB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  // 1. txA is initially pending
  savePendingPurchase({
    schemaVersion: 1,
    deploymentId: "archava-monad",
    chainId: 10143,
    wallet: ALICE,
    rentalContract: CANONICAL_CONTRACTS.rentalV2,
    paymentToken: CANONICAL_CONTRACTS.mockUsdt,
    packageId: 1,
    minutes: 60,
    txHash: txA,
    operationId: "op_alice_A",
    stage: "awaiting_credit",
    submittedAt: Date.now() - 5000,
  });

  // 2. State changes: new transaction txB is created for Alice
  savePendingPurchase({
    schemaVersion: 1,
    deploymentId: "archava-monad",
    chainId: 10143,
    wallet: ALICE,
    rentalContract: CANONICAL_CONTRACTS.rentalV2,
    paymentToken: CANONICAL_CONTRACTS.mockUsdt,
    packageId: 2,
    minutes: 300,
    txHash: txB,
    operationId: "op_alice_B",
    stage: "broadcast",
    submittedAt: Date.now(),
  });

  // 3. Late callback for txA attempts CAS update & clear
  const stageUpdated = updatePendingPurchaseStage(
    { wallet: ALICE, txHash: txA, operationId: "op_alice_A" },
    "completed"
  );
  assert.equal(stageUpdated, false, "updatePendingPurchaseStage must reject outdated txA");

  const cleared = clearPendingPurchase({ wallet: ALICE, txHash: txA, operationId: "op_alice_A" });
  assert.equal(cleared, false, "clearPendingPurchase must not delete txB");

  // 4. Verify txB is 100% intact
  const currentPending = getPendingPurchase(ALICE);
  assert.ok(currentPending);
  assert.equal(currentPending.txHash, txB);
  assert.equal(currentPending.packageId, 2);
  assert.equal(currentPending.operationId, "op_alice_B");
  assert.equal(currentPending.stage, "broadcast");
});

test("Residual 3: Two monitors for txA - first cleanup succeeds, second is safe/idempotent", async () => {
  setupMockLocalStorage();
  const txA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  savePendingPurchase({
    schemaVersion: 1,
    deploymentId: "archava-monad",
    chainId: 10143,
    wallet: ALICE,
    rentalContract: CANONICAL_CONTRACTS.rentalV2,
    paymentToken: CANONICAL_CONTRACTS.mockUsdt,
    packageId: 1,
    minutes: 60,
    txHash: txA,
    operationId: "op_A",
    stage: "awaiting_credit",
    submittedAt: Date.now(),
  });

  // Monitor 1 completes
  const firstClear = clearPendingPurchase({ wallet: ALICE, txHash: txA, operationId: "op_A" });
  assert.equal(firstClear, true, "First clear must succeed");
  assert.equal(getPendingPurchase(ALICE), null);

  // Monitor 2 completes
  const secondClear = clearPendingPurchase({ wallet: ALICE, txHash: txA, operationId: "op_A" });
  assert.equal(secondClear, false, "Second clear is safely idempotent");
  assert.equal(getPendingPurchase(ALICE), null);
});

test("Residual 3: Replacement txA -> txA2 preserves operation identity and updates hash", async () => {
  setupMockLocalStorage();
  const txA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const txA2 = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa22";

  savePendingPurchase({
    schemaVersion: 1,
    deploymentId: "archava-monad",
    chainId: 10143,
    wallet: ALICE,
    rentalContract: CANONICAL_CONTRACTS.rentalV2,
    paymentToken: CANONICAL_CONTRACTS.mockUsdt,
    packageId: 1,
    minutes: 60,
    txHash: txA,
    operationId: "op_replace_test",
    stage: "awaiting_receipt",
    submittedAt: Date.now(),
  });

  // Replace txA with txA2
  const updated = updatePendingPurchaseHash(
    { wallet: ALICE, operationId: "op_replace_test", txHash: txA },
    txA2,
    txA
  );
  assert.equal(updated, true);

  const pending = getPendingPurchase(ALICE);
  assert.ok(pending);
  assert.equal(pending.txHash, txA2);
  assert.equal(pending.originalTxHash, txA);
  assert.equal(pending.replacementTxHash, txA2);
  assert.equal(pending.operationId, "op_replace_test");

  // Cleanup with either txA or txA2 matches the preserved operation identity
  const cleared = clearPendingPurchase({ wallet: ALICE, txHash: txA2, operationId: "op_replace_test" });
  assert.equal(cleared, true);
  assert.equal(getPendingPurchase(ALICE), null);
});

test("Residual 3: Foreign scope cannot be updated or deleted", async () => {
  setupMockLocalStorage();
  const tx = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  savePendingPurchase({
    schemaVersion: 1,
    deploymentId: "archava-monad",
    chainId: 10143,
    wallet: ALICE,
    rentalContract: CANONICAL_CONTRACTS.rentalV2,
    paymentToken: CANONICAL_CONTRACTS.mockUsdt,
    packageId: 1,
    minutes: 60,
    txHash: tx,
    stage: "awaiting_credit",
    submittedAt: Date.now(),
  });

  // Attempt update with foreign deploymentId
  const foreignUpdate = updatePendingPurchaseStage(
    { wallet: ALICE, txHash: tx, deploymentId: "archava-bnb" },
    "completed"
  );
  assert.equal(foreignUpdate, false);

  // Attempt delete with foreign chainId
  const foreignDelete = clearPendingPurchase({ wallet: ALICE, txHash: tx, chainId: 97 });
  assert.equal(foreignDelete, false);

  // Record is still untouched
  const current = getPendingPurchase(ALICE);
  assert.ok(current);
  assert.equal(current.stage, "awaiting_credit");
});

test("Residual 3: matchesOperationIdentity compares deployment, chain, wallet, operationId, and hash strictly", () => {
  const record = {
    schemaVersion: 1 as const,
    deploymentId: "archava-monad",
    chainId: 10143,
    wallet: ALICE,
    rentalContract: CANONICAL_CONTRACTS.rentalV2,
    paymentToken: CANONICAL_CONTRACTS.mockUsdt,
    packageId: 1,
    minutes: 60,
    txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    originalTxHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    replacementTxHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    operationId: "op_match_test",
    stage: "awaiting_credit" as const,
    submittedAt: 1234567,
  };

  // Matching identity
  assert.equal(matchesOperationIdentity(record, { wallet: ALICE, txHash: record.txHash, operationId: "op_match_test" }), true);
  // Matching by original hash
  assert.equal(matchesOperationIdentity(record, { wallet: ALICE, txHash: record.originalTxHash }), true);
  // Mismatched wallet
  assert.equal(matchesOperationIdentity(record, { wallet: BOB, txHash: record.txHash }), false);
  // Mismatched operationId
  assert.equal(matchesOperationIdentity(record, { wallet: ALICE, txHash: record.txHash, operationId: "op_other" }), false);
  // Mismatched hash
  assert.equal(matchesOperationIdentity(record, { wallet: ALICE, txHash: "0x9999999999999999999999999999999999999999999999999999999999999999" }), false);
  // Mismatched chainId
  assert.equal(matchesOperationIdentity(record, { wallet: ALICE, chainId: 97 }), false);
  // Mismatched deploymentId
  assert.equal(matchesOperationIdentity(record, { wallet: ALICE, deploymentId: "foreign" }), false);
});
