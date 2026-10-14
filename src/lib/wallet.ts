import { BrowserProvider, Contract, JsonRpcSigner, formatEther, formatUnits, getAddress, isAddress } from "ethers";

export const MONAD_CHAIN_ID = 10143;
export const MONAD_CHAIN_ID_HEX = "0x279f";
export const MONAD_NETWORK_NAME = "Monad Testnet";
export const MONAD_RPC_URL = "https://testnet-rpc.monad.xyz";
export const MONAD_EXPLORER_URL = "https://testnet.monadscan.com";
export const MONAD_NATIVE_CURRENCY = {
  name: "MON",
  symbol: "MON",
  decimals: 18,
};

export const CANONICAL_CONTRACTS = {
  rentalV2: "0x7324a2678e74052a4e9a244c0d57b56b23fee6ad",
  mockUsdt: "0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c",
  deploymentBlock: 70191614,
} as const;

export interface EthereumProvider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

export interface WalletState {
  address: string | null;
  chainId: number | null;
  isConnected: boolean;
  isCorrectChain: boolean;
}

export interface WalletSubscriptionCallbacks {
  onAccountsChanged?: (accounts: string[]) => void;
  onChainChanged?: (chainId: number) => void;
  onDisconnect?: () => void;
}

export interface OperationContext {
  readonly ethereum: EthereumProvider;
  readonly provider: BrowserProvider;
  readonly wallet: string;
  readonly chainId: number;
  readonly rentalContract: string;
  readonly paymentToken: string;
  readonly deploymentId: string;
  readonly epochAtCreation?: number;
}

export class ContextAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextAbortedError";
  }
}

const TOKEN_VIEW_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function hasClaimed(address account) view returns (bool)",
  "function decimals() view returns (uint8)",
];

export type WalletProviderType = "injected" | "privy";

export interface SelectedWalletInfo {
  provider: EthereumProvider;
  address: string;
  type: WalletProviderType;
  chainId?: number;
}

let activeSelectedWallet: SelectedWalletInfo | null = null;
let walletEpoch = 0;
let connectionGeneration = 0;
let restorationAllowed = true;
const DISCONNECTED_STORAGE_KEY = "archava_wallet_disconnected_v1";
const walletChangeListeners = new Set<(wallet: SelectedWalletInfo | null) => void>();

/** A manual sign-out must survive a reload even if an extension stays authorized. */
export function canRestoreWallet(): boolean {
  if (!restorationAllowed) return false;
  try {
    return typeof window === "undefined" || window.sessionStorage.getItem(DISCONNECTED_STORAGE_KEY) !== "true";
  } catch {
    return restorationAllowed;
  }
}

export function allowWalletRestoration(): void {
  restorationAllowed = true;
  try { window.sessionStorage.removeItem(DISCONNECTED_STORAGE_KEY); } catch { /* Storage may be unavailable. */ }
}

export function getWalletEpoch(): number {
  return walletEpoch;
}

export function onSelectedWalletChange(listener: (wallet: SelectedWalletInfo | null) => void): () => void {
  walletChangeListeners.add(listener);
  return () => {
    walletChangeListeners.delete(listener);
  };
}

export function setSelectedWallet(wallet: SelectedWalletInfo | null): void {
  const previousWallet = activeSelectedWallet;
  activeSelectedWallet = wallet;
  const changed = (
    (!previousWallet && wallet) ||
    (previousWallet && !wallet) ||
    (previousWallet && wallet && (
      previousWallet.address.toLowerCase() !== wallet.address.toLowerCase() ||
      previousWallet.provider !== wallet.provider
    ))
  );
  if (changed) {
    walletEpoch++;
    for (const listener of walletChangeListeners) {
      try {
        listener(wallet);
      } catch (err) {
        console.warn("[Wallet] Listener error on wallet change:", err);
      }
    }
  }
}

export function getSelectedWallet(): SelectedWalletInfo | null {
  return activeSelectedWallet;
}

export function getSelectedWalletProvider(): EthereumProvider | null {
  return activeSelectedWallet?.provider ?? null;
}

export function disconnectWallet(options: { remember?: boolean } = {}): void {
  connectionGeneration++;
  if (options.remember) {
    restorationAllowed = false;
    try { window.sessionStorage.setItem(DISCONNECTED_STORAGE_KEY, "true"); } catch { /* Keep the in-memory preference. */ }
  }
  setSelectedWallet(null);
}

export const MONAD_PRIVY_CHAIN = {
  id: MONAD_CHAIN_ID,
  name: MONAD_NETWORK_NAME,
  network: "monad-testnet",
  nativeCurrency: MONAD_NATIVE_CURRENCY,
  rpcUrls: {
    default: {
      http: [MONAD_RPC_URL],
    },
    public: {
      http: [MONAD_RPC_URL],
    },
  },
  blockExplorers: {
    default: {
      name: "MonadScan",
      url: MONAD_EXPLORER_URL,
    },
  },
  testnet: true,
};

/**
 * Returns the active selected EIP-1193 ethereum provider, or injected fallback.
 * Throws a clean, user-friendly error if not detected.
 */
export function getEthereumProvider(): EthereumProvider {
  if (activeSelectedWallet?.provider) {
    return activeSelectedWallet.provider;
  }
  if (!canRestoreWallet()) {
    throw new ContextAbortedError("Wallet is disconnected from Archava. Connect again to continue.");
  }
  const ethereum = typeof window !== "undefined" ? window.ethereum : undefined;
  if (!ethereum) {
    throw new Error("No Web3 wallet found. Install a wallet such as MetaMask or Rabby, or log in with Privy.");
  }
  return ethereum;
}

/**
 * Creates an ethers BrowserProvider instance from the injected provider.
 */
export function getBrowserProvider(customEthereum?: EthereumProvider): BrowserProvider {
  const ethereum = customEthereum || getEthereumProvider();
  const provider = new BrowserProvider(ethereum as any);
  provider.pollingInterval = 500;
  return provider;
}

/**
 * Normalizes chain ID from hex string or number to a safe positive integer.
 * Strictly rejects malformed, unsafe, zero, or negative values.
 */
export function normalizeChainId(raw: unknown): number {
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw <= 0) {
      throw new Error(`Invalid chain ID: must be a positive safe integer, got ${raw}`);
    }
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^0x[0-9a-fA-F]+$/i.test(trimmed)) {
      const parsed = parseInt(trimmed, 16);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid chain ID: unsafe hex representation ${trimmed}`);
      }
      return parsed;
    }
    if (/^\d+$/.test(trimmed)) {
      const parsed = parseInt(trimmed, 10);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid chain ID: unsafe decimal representation ${trimmed}`);
      }
      return parsed;
    }
  }
  throw new Error(`Invalid chain ID representation: ${String(raw)}`);
}

/**
 * Connects to external wallet via eth_requestAccounts and retrieves account and chain.
 */
export async function connectExternalWallet(): Promise<{ address: string; chainId: number }> {
  const generation = connectionGeneration;
  const ethereum = (typeof window !== "undefined" ? window.ethereum : undefined) || getEthereumProvider();
  if (!ethereum) {
    throw new Error("No Web3 wallet found. Install a wallet such as MetaMask or Rabby.");
  }
  let accounts: unknown;
  try {
    accounts = await ethereum.request({ method: "eth_requestAccounts" });
  } catch (error: any) {
    if (error?.code === 4001) {
      throw new Error("Wallet connection request was rejected by the user.");
    }
    throw new Error(error?.message || "Failed to connect wallet.");
  }

  if (!Array.isArray(accounts) || accounts.length === 0 || typeof accounts[0] !== "string" || !isAddress(accounts[0])) {
    throw new Error("Wallet did not return any authorized accounts.");
  }

  const address = getAddress(accounts[0]);
  const rawChainId = await ethereum.request({ method: "eth_chainId" });
  const chainId = normalizeChainId(rawChainId);

  if (generation !== connectionGeneration) {
    throw new ContextAbortedError("Wallet connection was cancelled. Connect again to continue.");
  }
  allowWalletRestoration();

  setSelectedWallet({
    provider: ethereum,
    address,
    type: "injected",
    chainId,
  });

  return { address, chainId };
}

/**
 * Verifies that the connected wallet is on Monad Testnet (Chain ID 10143).
 * Switches network or prompts wallet to add Monad Testnet if not configured.
 */
export async function ensureMonadChain(customEthereum?: EthereumProvider): Promise<void> {
  const ethereum = customEthereum || getEthereumProvider();
  const currentRaw = await ethereum.request({ method: "eth_chainId" });
  const currentChainId = normalizeChainId(currentRaw);

  if (currentChainId === MONAD_CHAIN_ID) {
    return;
  }

  try {
    await ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: MONAD_CHAIN_ID_HEX }],
    });
  } catch (switchError: any) {
    const errorCode = switchError?.code;
    const isUnrecognized = errorCode === 4902 || /unrecognized|unknown|not found|4902/i.test(switchError?.message || "");

    if (errorCode === 4001) {
      throw new Error("Network switch to Monad Testnet was rejected by the user.");
    }

    if (isUnrecognized) {
      try {
        await ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: MONAD_CHAIN_ID_HEX,
              chainName: MONAD_NETWORK_NAME,
              nativeCurrency: MONAD_NATIVE_CURRENCY,
              rpcUrls: [MONAD_RPC_URL],
              blockExplorerUrls: [MONAD_EXPLORER_URL],
            },
          ],
        });
      } catch (addError: any) {
        if (addError?.code === 4001) {
          throw new Error("Request to add Monad Testnet was rejected by the user.");
        }
        throw new Error(addError?.message || "Failed to add Monad Testnet to wallet.");
      }
    } else {
      throw new Error(switchError?.message || "Failed to switch wallet to Monad Testnet.");
    }
  }

  // Re-verify chain after switch or add
  const verifiedRaw = await ethereum.request({ method: "eth_chainId" });
  const verifiedChainId = normalizeChainId(verifiedRaw);
  if (verifiedChainId !== MONAD_CHAIN_ID) {
    throw new Error(`Wallet is connected to chain ${verifiedChainId}, but Monad Testnet (${MONAD_CHAIN_ID}) is required.`);
  }
}

/**
 * Creates an OperationContext capturing provider, wallet, chain, and contract configuration.
 */
export async function createOperationContext(
  expectedWallet: string,
  customEthereum?: EthereumProvider
): Promise<OperationContext> {
  const ethereum = customEthereum || getEthereumProvider();
  const normalizedWallet = getAddress(expectedWallet);

  const rawChain = await ethereum.request({ method: "eth_chainId" });
  const currentChainId = normalizeChainId(rawChain);
  if (currentChainId !== MONAD_CHAIN_ID) {
    throw new ContextAbortedError(
      `Wallet is connected to chain ${currentChainId}, but Monad Testnet (${MONAD_CHAIN_ID}) is required.`
    );
  }

  const accounts = (await ethereum.request({ method: "eth_accounts" })) as unknown;
  if (!Array.isArray(accounts) || accounts.length === 0 || !isAddress(accounts[0])) {
    throw new ContextAbortedError("No active wallet account detected.");
  }
  if (getAddress(accounts[0]) !== normalizedWallet) {
    throw new ContextAbortedError(
      `Active account mismatch (expected ${normalizedWallet}, active is ${getAddress(accounts[0])}).`
    );
  }

  const provider = new BrowserProvider(ethereum as any);
  provider.pollingInterval = 500;
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== MONAD_CHAIN_ID) {
    throw new ContextAbortedError(
      `Provider chain ID ${net.chainId} does not match Monad Testnet (${MONAD_CHAIN_ID}).`
    );
  }

  return {
    ethereum,
    provider,
    wallet: normalizedWallet,
    chainId: MONAD_CHAIN_ID,
    rentalContract: CANONICAL_CONTRACTS.rentalV2,
    paymentToken: CANONICAL_CONTRACTS.mockUsdt,
    deploymentId: "archava-monad",
    epochAtCreation: getWalletEpoch(),
  };
}

/**
 * Asserts that the operation context is still active, valid, and unchanged.
 * Re-queries eth_accounts and eth_chainId directly from the context provider.
 * Throws ContextAbortedError if any discrepancy is detected.
 */
export async function assertActiveContext(context: OperationContext): Promise<{ signer: JsonRpcSigner }> {
  if (typeof context.epochAtCreation === "number" && getWalletEpoch() !== context.epochAtCreation) {
    throw new ContextAbortedError("Wallet provider instance changed during operation.");
  }

  const currentProvider = activeSelectedWallet?.provider || (typeof window !== "undefined" ? window.ethereum : undefined);
  if (currentProvider && currentProvider !== context.ethereum) {
    throw new ContextAbortedError("Wallet provider instance changed during operation.");
  }

  const rawChain = await context.ethereum.request({ method: "eth_chainId" });
  const currentChainId = normalizeChainId(rawChain);
  if (currentChainId !== context.chainId) {
    throw new ContextAbortedError(
      `Network changed during operation (expected chain ${context.chainId}, current is ${currentChainId}).`
    );
  }

  const accounts = (await context.ethereum.request({ method: "eth_accounts" })) as unknown;
  if (!Array.isArray(accounts) || accounts.length === 0 || !isAddress(accounts[0])) {
    throw new ContextAbortedError("Wallet disconnected or no accounts authorized.");
  }
  if (getAddress(accounts[0]) !== context.wallet) {
    throw new ContextAbortedError(
      `Active account changed during operation (expected ${context.wallet}, active is ${getAddress(accounts[0])}).`
    );
  }

  const signer = await context.provider.getSigner();
  const signerAddress = getAddress(await signer.getAddress());
  if (signerAddress !== context.wallet) {
    throw new ContextAbortedError(
      `Signer address changed (expected ${context.wallet}, active is ${signerAddress}).`
    );
  }

  return { signer };
}

/**
 * Returns a JsonRpcSigner, strictly asserting that chain is Monad Testnet (10143)
 * and account matches expected address.
 */
export async function getSigner(expectedAddress?: string): Promise<JsonRpcSigner> {
  const ethereum = getEthereumProvider();
  const rawChain = await ethereum.request({ method: "eth_chainId" });
  const currentChainId = normalizeChainId(rawChain);
  if (currentChainId !== MONAD_CHAIN_ID) {
    throw new ContextAbortedError(
      `Signer rejected: wallet is on chain ${currentChainId}, but Monad Testnet (${MONAD_CHAIN_ID}) is required.`
    );
  }

  const provider = getBrowserProvider(ethereum);
  const signer = await provider.getSigner();
  const actualAddress = getAddress(await signer.getAddress());

  if (expectedAddress) {
    const expected = getAddress(expectedAddress);
    if (actualAddress !== expected) {
      throw new ContextAbortedError(
        `Connected wallet changed (expected ${expected}, active is ${actualAddress}). Connect again.`
      );
    }
  }

  return signer;
}

/**
 * Subscribes to EIP-1193 events and returns an unsubscribe cleanup function.
 */
export function subscribeWalletEvents(
  callbacks: WalletSubscriptionCallbacks,
  customEthereum?: EthereumProvider
): () => void {
  const ethereum = customEthereum || activeSelectedWallet?.provider || (typeof window !== "undefined" ? window.ethereum : undefined);
  if (!ethereum || typeof ethereum.on !== "function") {
    return () => {};
  }

  const handleAccountsChanged = (accountsRaw: unknown) => {
    if (!Array.isArray(accountsRaw)) return;
    const accounts = accountsRaw
      .filter((a): a is string => typeof a === "string" && isAddress(a))
      .map((a) => getAddress(a));
    callbacks.onAccountsChanged?.(accounts);
  };

  const handleChainChanged = (chainIdRaw: unknown) => {
    try {
      const chainId = normalizeChainId(chainIdRaw);
      callbacks.onChainChanged?.(chainId);
    } catch {
      // Ignore malformed chain changes
    }
  };

  const handleDisconnect = () => {
    callbacks.onDisconnect?.();
  };

  ethereum.on("accountsChanged", handleAccountsChanged);
  ethereum.on("chainChanged", handleChainChanged);
  ethereum.on?.("disconnect", handleDisconnect);

  return () => {
    ethereum.removeListener?.("accountsChanged", handleAccountsChanged);
    ethereum.removeListener?.("chainChanged", handleChainChanged);
    ethereum.removeListener?.("disconnect", handleDisconnect);
  };
}

/**
 * Validates that an AppConfig matches Monad Testnet and canonical deployment addresses.
 */
export function validateDeploymentConfig(config: {
  chainId?: number;
  contractAddress?: string;
  paymentTokenAddress?: string;
}): { valid: boolean; error?: string } {
  if (!config) {
    return { valid: false, error: "Configuration missing." };
  }

  if (config.chainId !== MONAD_CHAIN_ID) {
    return {
      valid: false,
      error: `Chain ID mismatch: expected ${MONAD_CHAIN_ID} (Monad Testnet), got ${config.chainId}.`,
    };
  }

  if (!config.contractAddress || !isAddress(config.contractAddress)) {
    return { valid: false, error: "Rental contract address is invalid or missing." };
  }

  if (getAddress(config.contractAddress) !== getAddress(CANONICAL_CONTRACTS.rentalV2)) {
    return {
      valid: false,
      error: `Rental contract address (${config.contractAddress}) does not match canonical Monad deployment (${CANONICAL_CONTRACTS.rentalV2}).`,
    };
  }

  if (!config.paymentTokenAddress || !isAddress(config.paymentTokenAddress)) {
    return { valid: false, error: "Payment token address is invalid or missing." };
  }

  if (getAddress(config.paymentTokenAddress) !== getAddress(CANONICAL_CONTRACTS.mockUsdt)) {
    return {
      valid: false,
      error: `Payment token address (${config.paymentTokenAddress}) does not match canonical Monad deployment (${CANONICAL_CONTRACTS.mockUsdt}).`,
    };
  }

  return { valid: true };
}

/**
 * Queries native MON balance for an address.
 */
export async function getMonBalance(
  address: string,
  customProvider?: BrowserProvider
): Promise<{ raw: bigint; formatted: string }> {
  const provider = customProvider || getBrowserProvider();
  const raw = await provider.getBalance(getAddress(address));
  return {
    raw,
    formatted: formatEther(raw),
  };
}

/**
 * Queries mock USDT balance and allowance for an address.
 */
export async function getTokenBalanceAndAllowance(
  tokenAddress: string,
  walletAddress: string,
  spenderAddress: string,
  customProvider?: BrowserProvider
): Promise<{ balance: bigint; allowance: bigint; formattedBalance: string; hasClaimed: boolean }> {
  const provider = customProvider || getBrowserProvider();
  const token = new Contract(getAddress(tokenAddress), TOKEN_VIEW_ABI, provider);
  const [balance, allowance, hasClaimed] = await Promise.all([
    token.balanceOf(getAddress(walletAddress)) as Promise<bigint>,
    token.allowance(getAddress(walletAddress), getAddress(spenderAddress)) as Promise<bigint>,
    token.hasClaimed(getAddress(walletAddress)) as Promise<boolean>,
  ]);

  return {
    balance,
    allowance,
    formattedBalance: formatUnits(balance, 6),
    hasClaimed,
  };
}
