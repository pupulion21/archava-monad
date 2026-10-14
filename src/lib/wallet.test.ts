import assert from "node:assert/strict";
import test from "node:test";
import {
  MONAD_CHAIN_ID,
  MONAD_CHAIN_ID_HEX,
  MONAD_EXPLORER_URL,
  MONAD_RPC_URL,
  CANONICAL_CONTRACTS,
  normalizeChainId,
  validateDeploymentConfig,
  connectExternalWallet,
  ensureMonadChain,
  subscribeWalletEvents,
  getWalletEpoch,
  setSelectedWallet,
  getSelectedWallet,
  getSelectedWalletProvider,
  disconnectWallet,
  getEthereumProvider,
  onSelectedWalletChange,
  ContextAbortedError,
  canRestoreWallet,
  allowWalletRestoration,
} from "./wallet.ts";
import {
  waitForCreditSync,
  savePendingPurchase,
  getPendingPurchase,
  clearPendingPurchase,
  packageIdForMinutes,
} from "./rental.ts";
import { ApiError } from "./apiError.ts";

const VALID_CONFIG = {
  chainId: 10143,
  contractAddress: "0x7324a2678e74052a4e9a244c0d57b56b23fee6ad",
  paymentTokenAddress: "0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c",
};

const TEST_WALLET = "0x1111111111111111111111111111111111111111";

// Helper to stub window.ethereum
function setupMockEthereum(handlers: Record<string, (params?: any) => Promise<any> | any>) {
  disconnectWallet();
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};

  const ethereum = {
    async request({ method, params }: { method: string; params?: any }) {
      if (handlers[method]) {
        return handlers[method](params);
      }
      throw new Error(`Unhandled RPC method: ${method}`);
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
    _listeners: listeners,
  };

  (globalThis as any).window = { ethereum };
  return ethereum;
}

test("normalizeChainId parses hex, decimal, and string representations correctly", () => {
  assert.equal(normalizeChainId(10143), 10143);
  assert.equal(normalizeChainId("0x279f"), 10143);
  assert.equal(normalizeChainId("0x279F"), 10143);
  assert.equal(normalizeChainId("10143"), 10143);
  assert.equal(normalizeChainId(97), 97);
  assert.equal(normalizeChainId("0x61"), 97);
  assert.throws(() => normalizeChainId({}), /Invalid chain ID/);
});

test("validateDeploymentConfig validates Monad Testnet and canonical addresses strictly", () => {
  assert.equal(MONAD_CHAIN_ID, 10143);
  assert.equal(CANONICAL_CONTRACTS.rentalV2.toLowerCase(), VALID_CONFIG.contractAddress.toLowerCase());
  assert.equal(CANONICAL_CONTRACTS.mockUsdt.toLowerCase(), VALID_CONFIG.paymentTokenAddress.toLowerCase());

  // Valid Monad Testnet configuration
  assert.deepEqual(validateDeploymentConfig(VALID_CONFIG), { valid: true });

  // Chain ID mismatch (e.g. BNB 97)
  const bnbConfig = { ...VALID_CONFIG, chainId: 97 };
  const bnbRes = validateDeploymentConfig(bnbConfig);
  assert.equal(bnbRes.valid, false);
  assert.match(bnbRes.error || "", /Chain ID mismatch: expected 10143/);

  // Wrong rental contract
  const wrongRental = { ...VALID_CONFIG, contractAddress: "0x2222222222222222222222222222222222222222" };
  const rentalRes = validateDeploymentConfig(wrongRental);
  assert.equal(rentalRes.valid, false);
  assert.match(rentalRes.error || "", /Rental contract address/);

  // Wrong payment token
  const wrongToken = { ...VALID_CONFIG, paymentTokenAddress: "0x3333333333333333333333333333333333333333" };
  const tokenRes = validateDeploymentConfig(wrongToken);
  assert.equal(tokenRes.valid, false);
  assert.match(tokenRes.error || "", /Payment token address/);
});

test("connectExternalWallet succeeds when authorized and rejects on user cancellation", async () => {
  setupMockEthereum({
    eth_requestAccounts: () => [TEST_WALLET],
    eth_chainId: () => MONAD_CHAIN_ID_HEX,
  });

  const res = await connectExternalWallet();
  assert.equal(res.address.toLowerCase(), TEST_WALLET.toLowerCase());
  assert.equal(res.chainId, 10143);

  // User rejection (code 4001)
  setupMockEthereum({
    eth_requestAccounts: () => {
      const err = new Error("User rejected");
      (err as any).code = 4001;
      throw err;
    },
  });

  await assert.rejects(
    () => connectExternalWallet(),
    /Wallet connection request was rejected by the user/
  );
});

test("ensureMonadChain does nothing if already on Monad Testnet", async () => {
  let switchCalled = false;
  setupMockEthereum({
    eth_chainId: () => MONAD_CHAIN_ID_HEX,
    wallet_switchEthereumChain: () => {
      switchCalled = true;
    },
  });

  await ensureMonadChain();
  assert.equal(switchCalled, false, "should not call switch when already on 10143");
});

test("ensureMonadChain switches network when on another chain and re-verifies", async () => {
  let switched = false;
  setupMockEthereum({
    eth_chainId: () => (switched ? MONAD_CHAIN_ID_HEX : "0x61"),
    wallet_switchEthereumChain: (params) => {
      assert.deepEqual(params, [{ chainId: MONAD_CHAIN_ID_HEX }]);
      switched = true;
    },
  });

  await ensureMonadChain();
  assert.equal(switched, true);
});

test("ensureMonadChain adds Monad Testnet when unrecognized (4902)", async () => {
  let added = false;
  setupMockEthereum({
    eth_chainId: () => (added ? MONAD_CHAIN_ID_HEX : "0x1"),
    wallet_switchEthereumChain: () => {
      const err = new Error("Chain not added");
      (err as any).code = 4902;
      throw err;
    },
    wallet_addEthereumChain: (params) => {
      assert.equal(params[0].chainId, MONAD_CHAIN_ID_HEX);
      assert.equal(params[0].chainName, "Monad Testnet");
      assert.deepEqual(params[0].rpcUrls, [MONAD_RPC_URL]);
      assert.deepEqual(params[0].blockExplorerUrls, [MONAD_EXPLORER_URL]);
      added = true;
    },
  });

  await ensureMonadChain();
  assert.equal(added, true);
});

test("subscribeWalletEvents properly dispatches accountsChanged, chainChanged, and disconnect", () => {
  const eth = setupMockEthereum({});

  let changedAccounts: string[] = [];
  let changedChain: number | null = null;
  let disconnected = false;

  const unsubscribe = subscribeWalletEvents({
    onAccountsChanged: (accs) => {
      changedAccounts = accs;
    },
    onChainChanged: (id) => {
      changedChain = id;
    },
    onDisconnect: () => {
      disconnected = true;
    },
  });

  eth._emit("accountsChanged", [TEST_WALLET]);
  assert.equal(changedAccounts.length, 1);
  assert.equal(changedAccounts[0].toLowerCase(), TEST_WALLET.toLowerCase());

  eth._emit("chainChanged", "0x279f");
  assert.equal(changedChain, 10143);

  eth._emit("disconnect");
  assert.equal(disconnected, true);

  unsubscribe();
  assert.equal(eth._listeners["accountsChanged"].length, 0);
  assert.equal(eth._listeners["chainChanged"].length, 0);
});

test("packageIdForMinutes maps 60 to 1 and 300 to 2", () => {
  assert.equal(packageIdForMinutes(60), 1);
  assert.equal(packageIdForMinutes(300), 2);
  assert.throws(() => packageIdForMinutes(120), /Unsupported minute pack/);
});

test("pending purchase localStorage helpers manage pending purchases properly", () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) || null,
    setItem: (key: string, val: string) => store.set(key, val),
    removeItem: (key: string) => store.delete(key),
  };

  const pending = {
    schemaVersion: 1 as const,
    deploymentId: "archava-monad",
    chainId: 10143,
    wallet: TEST_WALLET,
    rentalContract: CANONICAL_CONTRACTS.rentalV2,
    paymentToken: CANONICAL_CONTRACTS.mockUsdt,
    packageId: 1,
    minutes: 60,
    txHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    stage: "broadcast" as const,
    submittedAt: Date.now(),
  };

  savePendingPurchase(pending);
  assert.deepEqual(getPendingPurchase(TEST_WALLET), pending);
  // Different wallet returns null
  assert.equal(getPendingPurchase("0x2222222222222222222222222222222222222222"), null);

  clearPendingPurchase(TEST_WALLET);
  assert.equal(getPendingPurchase(TEST_WALLET), null);
});

test("waitForCreditSync treats 503 credit_sync_unavailable as transient and succeeds on next poll", async () => {
  let callCount = 0;
  (globalThis as any).fetch = async (_url: string) => {
    callCount++;
    if (callCount === 1) {
      return {
        ok: false,
        status: 503,
        json: async () => ({ error: "Syncing finalized blocks", code: "credit_sync_unavailable" }),
      };
    }
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
  };

  const status = await waitForCreditSync(TEST_WALLET, 60, { intervalMs: 10, maxWaitMs: 1000 });
  assert.equal(status.purchasedMinutes, 60);
  assert.equal(callCount, 2, "must have polled again after 503");
});

test("waitForCreditSync fails fast on non-transient API error (e.g. 400 or 500)", async () => {
  (globalThis as any).fetch = async () => {
    return {
      ok: false,
      status: 400,
      json: async () => ({ error: "Invalid address format" }),
    };
  };

  await assert.rejects(
    () => waitForCreditSync(TEST_WALLET, 60, { intervalMs: 10, maxWaitMs: 500 }),
    (err: any) => err instanceof ApiError && err.status === 400
  );
});

test("waitForCreditSync throws clear timeout error if sync does not complete in time", async () => {
  (globalThis as any).fetch = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        active: true,
        purchasedMinutes: 0, // not yet reaching targetMinutes: 60
        usedSeconds: 0,
        reservedSeconds: 0,
        remainingSeconds: 0,
      }),
    };
  };

  await assert.rejects(
    () => waitForCreditSync(TEST_WALLET, 60, { intervalMs: 10, maxWaitMs: 50 }),
    /credit indexing is taking longer than expected/
  );
});

test("setSelectedWallet and getSelectedWallet manage active wallet and provider cleanly", () => {
  const dummyProvider1 = { request: async () => {} } as any;
  const initialEpoch = getWalletEpoch();

  setSelectedWallet({
    provider: dummyProvider1,
    address: TEST_WALLET,
    type: "privy",
    chainId: 10143,
  });

  const selected = getSelectedWallet();
  assert.ok(selected);
  assert.equal(selected.address.toLowerCase(), TEST_WALLET.toLowerCase());
  assert.equal(selected.type, "privy");
  assert.equal(selected.chainId, 10143);
  assert.equal(selected.provider, dummyProvider1);
  assert.equal(getSelectedWalletProvider(), dummyProvider1);
  assert.equal(getWalletEpoch(), initialEpoch + 1);

  // Overriding getEthereumProvider
  assert.equal(getEthereumProvider(), dummyProvider1);

  // Address switch increments epoch
  const NEW_WALLET = "0x2222222222222222222222222222222222222222";
  setSelectedWallet({
    provider: dummyProvider1,
    address: NEW_WALLET,
    type: "privy",
    chainId: 10143,
  });
  assert.equal(getWalletEpoch(), initialEpoch + 2);

  // Disconnect cleans up
  disconnectWallet();
  assert.equal(getSelectedWallet(), null);
  assert.equal(getSelectedWalletProvider(), null);
  assert.equal(getWalletEpoch(), initialEpoch + 3);
});

test("manual disconnect stays signed out until an explicit successful connection", async () => {
  const previousWindow = (globalThis as any).window;
  const storage = new Map<string, string>();
  setupMockEthereum({ eth_requestAccounts: () => [TEST_WALLET], eth_chainId: () => "0x279f" });
  (globalThis as any).window.sessionStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  };
  try {
    allowWalletRestoration();
    await connectExternalWallet();
    disconnectWallet({ remember: true });
    assert.equal(getSelectedWallet(), null);
    assert.equal(canRestoreWallet(), false);
    assert.equal(storage.get("archava_wallet_disconnected_v1"), "true");
    assert.throws(() => getEthereumProvider(), /Wallet is disconnected from Archava/);
    await connectExternalWallet();
    assert.equal(getSelectedWallet()?.address, TEST_WALLET);
    assert.equal(canRestoreWallet(), true);
    assert.equal(storage.size, 0);
  } finally {
    allowWalletRestoration();
    disconnectWallet();
    (globalThis as any).window = previousWindow;
  }
});

test("a delayed external connection cannot restore a wallet after sign-out", async () => {
  const previousWindow = (globalThis as any).window;
  let authorize!: (accounts: string[]) => void;
  setupMockEthereum({
    eth_requestAccounts: () => new Promise<string[]>(resolve => { authorize = resolve; }),
    eth_chainId: () => "0x279f",
  });
  try {
    const connecting = connectExternalWallet();
    disconnectWallet({ remember: true });
    authorize([TEST_WALLET]);
    await assert.rejects(connecting, /Wallet connection was cancelled/);
    assert.equal(getSelectedWallet(), null);
    assert.equal(canRestoreWallet(), false);
  } finally {
    allowWalletRestoration();
    disconnectWallet();
    (globalThis as any).window = previousWindow;
  }
});

test("MONAD_PRIVY_CHAIN adheres to Monad Testnet 10143 specifications", async () => {
  const { MONAD_PRIVY_CHAIN } = await import("./wallet.ts");
  assert.equal(MONAD_PRIVY_CHAIN.id, 10143);
  assert.equal(MONAD_PRIVY_CHAIN.network, "monad-testnet");
  assert.equal(MONAD_PRIVY_CHAIN.nativeCurrency.symbol, "MON");
  assert.equal(MONAD_PRIVY_CHAIN.nativeCurrency.decimals, 18);
  assert.equal(MONAD_PRIVY_CHAIN.rpcUrls.default.http[0], "https://testnet-rpc.monad.xyz");
  assert.equal(MONAD_PRIVY_CHAIN.blockExplorers.default.url, "https://testnet.monadscan.com");
  assert.equal(MONAD_PRIVY_CHAIN.testnet, true);
});

test("createOperationContext and assertActiveContext enforce selected provider and account", async () => {
  const { createOperationContext, assertActiveContext, setSelectedWallet, disconnectWallet } = await import("./wallet.ts");

  const mockProvider = {
    request: async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return "0x279f";
      if (method === "eth_accounts") return [TEST_WALLET];
      throw new Error(`Unhandled method ${method}`);
    },
    on: () => {},
    removeListener: () => {},
  };

  setSelectedWallet({
    provider: mockProvider as any,
    address: TEST_WALLET,
    type: "privy",
    chainId: 10143,
  });

  const ctx = await createOperationContext(TEST_WALLET);
  assert.equal(ctx.wallet.toLowerCase(), TEST_WALLET.toLowerCase());
  assert.equal(ctx.chainId, 10143);
  assert.equal(ctx.ethereum, mockProvider);

  // When selected provider is swapped during operation, assertActiveContext rejects
  const swappedProvider = {
    request: async () => {},
  };
  setSelectedWallet({
    provider: swappedProvider as any,
    address: TEST_WALLET,
    type: "injected",
    chainId: 10143,
  });

  await assert.rejects(
    () => assertActiveContext(ctx),
    /Wallet provider instance changed during operation/
  );

  disconnectWallet();
});

test("onSelectedWalletChange notifies listeners on wallet change and allows clean unsubscription", () => {
  const dummy = { request: async () => {} } as any;
  const calls: (string | null)[] = [];

  const unsubscribe = onSelectedWalletChange((w) => {
    calls.push(w ? w.address : null);
  });

  setSelectedWallet({
    provider: dummy,
    address: TEST_WALLET,
    type: "privy",
    chainId: 10143,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.toLowerCase(), TEST_WALLET.toLowerCase());

  disconnectWallet();
  assert.equal(calls.length, 2);
  assert.equal(calls[1], null);

  unsubscribe();

  // Further updates do not notify unsubscribed listener
  setSelectedWallet({
    provider: dummy,
    address: TEST_WALLET,
    type: "injected",
    chainId: 10143,
  });
  assert.equal(calls.length, 2);

  disconnectWallet();
});

test("assertActiveContext rejects when wallet is disconnected mid-operation", async () => {
  const { createOperationContext, assertActiveContext, setSelectedWallet, disconnectWallet } = await import("./wallet.ts");

  const mockProvider = {
    request: async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return "0x279f";
      if (method === "eth_accounts") return [TEST_WALLET];
      throw new Error(`Unhandled method ${method}`);
    },
    on: () => {},
    removeListener: () => {},
  };

  setSelectedWallet({
    provider: mockProvider as any,
    address: TEST_WALLET,
    type: "privy",
    chainId: 10143,
  });

  const ctx = await createOperationContext(TEST_WALLET);

  // User logs out / disconnects
  disconnectWallet();

  await assert.rejects(
    () => assertActiveContext(ctx),
    (err: any) => err instanceof ContextAbortedError && /Wallet provider instance changed/.test(err.message)
  );
});

