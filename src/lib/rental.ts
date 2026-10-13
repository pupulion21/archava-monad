import { BrowserProvider, Contract, getAddress, isAddress } from "ethers";
import { ApiError } from "./apiError.ts";
import {
  MONAD_CHAIN_ID,
  CANONICAL_CONTRACTS,
  getBrowserProvider,
  ensureMonadChain,
  validateDeploymentConfig,
  getMonBalance,
  getTokenBalanceAndAllowance,
  createOperationContext,
  assertActiveContext,
} from "./wallet.ts";

export interface AppConfig {
  chainId: number;
  contractAddress: string;
  paymentTokenAddress?: string;
  paymentTokenSymbol?: string;
  livekitReady: boolean;
  envioConfigured?: boolean;
  avatarProvider: "tavus" | "spatius";
  spatiusAppId?: string;
  spatiusAvatarId?: string;
  previewEnabled: boolean;
  previewSeconds: number;
  packMinutes: number[];
  deploymentId?: string;
  deploymentBlock?: number;
  network?: {
    chainId: number;
    name: string;
    nativeCurrency: { name: string; symbol: string; decimals: number };
    rpcUrls: string[];
    blockExplorerUrls: string[];
  };
}

export interface CreditStatus {
  active: boolean;
  purchasedMinutes: number;
  usedSeconds: number;
  reservedSeconds: number;
  remainingSeconds: number;
}

export interface AvatarSession {
  serverUrl: string;
  token: string;
  endsAt: number;
  preview: boolean;
  ticket: string;
  avatarProvider: "tavus" | "spatius";
  spatiusAppId?: string;
  spatiusAvatarId?: string;
}

export interface PackQuote {
  wei: string;
  tokenAmount: string;
  symbol: string;
  minutes: number;
}

export type PendingPurchaseStage =
  | "broadcast"
  | "awaiting_receipt"
  | "awaiting_finality"
  | "awaiting_credit"
  | "completed"
  | "reverted"
  | "cancelled";

export interface PendingPurchaseRecord {
  schemaVersion: 1;
  deploymentId: string;
  chainId: number;
  wallet: string;
  rentalContract: string;
  paymentToken: string;
  packageId: number;
  minutes: number;
  txHash: string;
  stage: PendingPurchaseStage;
  submittedAt: number;
  operationId?: string;
  originalTxHash?: string;
  approvalTxHash?: string;
  replacementTxHash?: string;
}

export interface PendingOperationIdentity {
  wallet: string;
  txHash?: string;
  operationId?: string;
  chainId?: number;
  deploymentId?: string;
}

export interface BuyMinutePackCallbacks {
  onStageChange?: (stage: "checking" | "approving" | "renting" | "awaiting_receipt" | "awaiting_credit") => void;
  onSubmitted?: (info: { txHash: string; stage: "approval" | "rental" }) => void;
}

export interface WaitForCreditSyncOptions {
  maxWaitMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  onProgress?: (elapsedMs: number) => void;
  operationId?: string;
}

export const RENTAL_ABI = [
  "function quoteRent(uint8 packageId) view returns (uint256)",
  "function rent(uint8 packageId)",
  "event AccessRented(address indexed wallet, uint8 packageId, uint32 includedMinutes, uint64 expiresAt, uint256 amountPaid)",
];

export const PAYMENT_TOKEN_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function faucet()",
  "function hasClaimed(address wallet) view returns (bool)",
];

function buildPendingStorageKey(wallet: string): string {
  const normalized = getAddress(wallet);
  return `archava_pending_v1_archava-monad_${MONAD_CHAIN_ID}_${normalized.toLowerCase()}`;
}

/**
 * Abortable delay that wakes immediately upon signal abort.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error("Operation was aborted."));
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Operation was aborted."));
    };
    signal?.addEventListener("abort", onAbort);
  });
}

async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, body === undefined ? { signal } : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!response.ok) {
    throw new ApiError(response.status, data.error || "Request failed", data.code);
  }
  return data as T;
}

export async function startAnonymousPreview(): Promise<AvatarSession> {
  return api<AvatarSession>("/api/preview", {});
}

export async function getConfig(signal?: AbortSignal): Promise<AppConfig> {
  return api<AppConfig>("/api/config", undefined, signal);
}

export async function getCreditStatus(wallet: string, signal?: AbortSignal): Promise<CreditStatus> {
  return api<CreditStatus>("/api/access?wallet=" + encodeURIComponent(wallet), undefined, signal);
}

export async function getPackQuote(minutes: number, signal?: AbortSignal): Promise<PackQuote> {
  return api<PackQuote>("/api/quote?minutes=" + encodeURIComponent(minutes), undefined, signal);
}

export async function getPurchaseStatus(
  txHash: string,
  wallet: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; txHash: string; wallet: string; credited: boolean; status: string }> {
  const query = `txHash=${encodeURIComponent(txHash)}&wallet=${encodeURIComponent(wallet)}`;
  return api<{ ok: boolean; txHash: string; wallet: string; credited: boolean; status: string }>(
    `/api/purchase/status?${query}`,
    undefined,
    signal
  );
}

/**
 * Returns BrowserProvider from window.ethereum.
 */
export function injectedProvider(): BrowserProvider {
  return getBrowserProvider();
}

/**
 * Connects external wallet and returns the checksummed wallet address.
 */
export async function connectWallet(): Promise<string> {
  const { connectExternalWallet } = await import("./wallet.ts");
  const { address } = await connectExternalWallet();
  return address;
}

/**
 * Ensures wallet is switched to the target chain (defaults to Monad Testnet 10143).
 */
export async function ensureChain(chainId: number): Promise<void> {
  if (chainId === MONAD_CHAIN_ID) {
    await ensureMonadChain();
    return;
  }
  const { getEthereumProvider } = await import("./wallet.ts");
  const ethereum = getEthereumProvider();
  const hexChainId = "0x" + chainId.toString(16);
  await ethereum.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: hexChainId }],
  });
}

export function packageIdForMinutes(minutes: number): number {
  if (minutes === 60) return 1;
  if (minutes === 300) return 2;
  throw new Error("Unsupported minute pack");
}

/**
 * Verifies if an existing pending purchase record matches the expected operation identity.
 */
export function matchesOperationIdentity(
  record: PendingPurchaseRecord | null | undefined,
  identity: PendingOperationIdentity | string,
  expectedTxHash?: string
): boolean {
  if (!record) return false;

  const targetWallet = typeof identity === "string" ? identity : identity.wallet;
  if (!targetWallet || getAddress(record.wallet) !== getAddress(targetWallet)) {
    return false;
  }

  const opId = typeof identity === "object" ? identity.operationId : undefined;
  if (opId && record.operationId && record.operationId !== opId) {
    return false;
  }

  const targetTx = (expectedTxHash || (typeof identity === "object" ? identity.txHash : undefined))?.toLowerCase();
  if (targetTx) {
    const mainHash = record.txHash?.toLowerCase();
    const origHash = record.originalTxHash?.toLowerCase();
    const repHash = record.replacementTxHash?.toLowerCase();
    const hashMatches = mainHash === targetTx || origHash === targetTx || repHash === targetTx;
    if (!hashMatches) {
      return false;
    }
  }

  const chainId = typeof identity === "object" ? identity.chainId : undefined;
  if (chainId !== undefined && record.chainId !== chainId) {
    return false;
  }

  const deploymentId = typeof identity === "object" ? identity.deploymentId : undefined;
  if (deploymentId !== undefined && record.deploymentId !== deploymentId) {
    return false;
  }

  return true;
}

/**
 * Persists pending purchase in local storage scoped to deployment, chain, and wallet.
 */
export function savePendingPurchase(record: PendingPurchaseRecord): boolean {
  try {
    if (record.schemaVersion !== 1) return false;
    if (record.deploymentId !== "archava-monad") return false;
    if (record.chainId !== MONAD_CHAIN_ID) return false;
    if (getAddress(record.rentalContract) !== getAddress(CANONICAL_CONTRACTS.rentalV2)) return false;
    if (getAddress(record.paymentToken) !== getAddress(CANONICAL_CONTRACTS.mockUsdt)) return false;

    const key = buildPendingStorageKey(record.wallet);
    localStorage.setItem(key, JSON.stringify(record));
    return true;
  } catch (err) {
    console.warn("Failed to persist pending purchase to localStorage:", err);
    return false;
  }
}

/**
 * Retrieves and validates pending purchase for wallet.
 * Fails closed on schema version or scope mismatch.
 */
export function getPendingPurchase(wallet: string): PendingPurchaseRecord | null {
  try {
    if (!wallet || !isAddress(wallet)) return null;
    const key = buildPendingStorageKey(wallet);
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingPurchaseRecord>;

    if (parsed.schemaVersion !== 1) return null;
    if (parsed.deploymentId !== "archava-monad") return null;
    if (parsed.chainId !== MONAD_CHAIN_ID) return null;
    if (getAddress(parsed.wallet || "") !== getAddress(wallet)) return null;
    if (getAddress(parsed.rentalContract || "") !== getAddress(CANONICAL_CONTRACTS.rentalV2)) return null;
    if (getAddress(parsed.paymentToken || "") !== getAddress(CANONICAL_CONTRACTS.mockUsdt)) return null;
    if (typeof parsed.txHash !== "string" || !parsed.txHash.startsWith("0x")) return null;

    return parsed as PendingPurchaseRecord;
  } catch {
    return null;
  }
}

/**
 * Updates stage of an active pending purchase using Compare-And-Set (CAS) semantics.
 * Refuses mutation if the record has moved to a different operation or transaction identity.
 */
export function updatePendingPurchaseStage(
  identity: PendingOperationIdentity | string,
  stage: PendingPurchaseStage,
  expectedTxHash?: string
): boolean {
  const wallet = typeof identity === "string" ? identity : identity.wallet;
  const current = getPendingPurchase(wallet);
  if (!current) return false;

  if (!matchesOperationIdentity(current, identity, expectedTxHash)) {
    return false;
  }

  current.stage = stage;
  return savePendingPurchase(current);
}

/**
 * Updates hash of a replaced pending purchase while preserving original operation identity.
 */
export function updatePendingPurchaseHash(
  identity: PendingOperationIdentity | string,
  newHash: string,
  originalHash?: string
): boolean {
  const wallet = typeof identity === "string" ? identity : identity.wallet;
  const current = getPendingPurchase(wallet);
  if (!current) return false;

  if (!matchesOperationIdentity(current, identity, originalHash)) {
    return false;
  }

  current.originalTxHash = current.originalTxHash || current.txHash;
  current.replacementTxHash = newHash;
  current.txHash = newHash;
  return savePendingPurchase(current);
}

/**
 * Clears pending purchase using Compare-And-Set (CAS) semantics.
 * If an expected identity or hash is provided, refuses removal if the record
 * belongs to a different or subsequent transaction.
 */
export function clearPendingPurchase(
  identity: PendingOperationIdentity | string,
  expectedTxHash?: string
): boolean {
  try {
    const wallet = typeof identity === "string" ? identity : identity.wallet;
    if (!wallet || !isAddress(wallet)) return false;
    const current = getPendingPurchase(wallet);
    if (!current) return false;

    const hasConstraint =
      typeof identity === "object"
        ? Boolean(identity.txHash || identity.operationId || identity.chainId || identity.deploymentId)
        : Boolean(expectedTxHash);

    if (hasConstraint && !matchesOperationIdentity(current, identity, expectedTxHash)) {
      return false;
    }

    const key = buildPendingStorageKey(wallet);
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks if a wallet has an unresolved active pending purchase.
 */
export function hasActivePendingPurchase(wallet: string): boolean {
  const pending = getPendingPurchase(wallet);
  if (!pending) return false;
  return (
    pending.stage === "broadcast" ||
    pending.stage === "awaiting_receipt" ||
    pending.stage === "awaiting_finality" ||
    pending.stage === "awaiting_credit"
  );
}

/**
 * Claims demo testnet USDT on Monad Testnet with full operation context.
 */
export async function claimDemoUsdt(config: AppConfig, expectedWallet: string): Promise<string> {
  const validation = validateDeploymentConfig(config);
  if (!validation.valid) {
    throw new Error(validation.error || "Invalid Monad Testnet configuration");
  }

  await ensureMonadChain();
  const context = await createOperationContext(expectedWallet);

  const mon = await getMonBalance(context.wallet, context.provider);
  if (mon.raw === 0n) {
    throw new Error("Insufficient MON for gas fees on Monad Testnet. Please fund your wallet with testnet MON.");
  }

  const tokenView = await getTokenBalanceAndAllowance(
    context.paymentToken,
    context.wallet,
    context.rentalContract,
    context.provider
  );
  if (tokenView.hasClaimed) {
    throw new Error("This wallet has already claimed testnet mUSDT. The faucet allows only one claim per address.");
  }

  // Assert context strictly before side effect
  const { signer } = await assertActiveContext(context);
  const token = new Contract(context.paymentToken, PAYMENT_TOKEN_ABI, signer);
  const tx = await token.faucet();
  const receipt = await tx.wait();
  if (receipt?.status !== 1) {
    throw new Error("Mock USDT faucet transaction failed on Monad Testnet");
  }

  return tx.hash as string;
}

/**
 * Purchases minute pack on Monad Testnet.
 * Immediately persists transaction hash upon broadcast before awaiting receipt.
 * Enforces operation context before every side effect.
 */
export async function buyMinutePack(
  config: AppConfig,
  minutes: number,
  expectedWallet: string,
  callbacks?: BuyMinutePackCallbacks
): Promise<string> {
  const validation = validateDeploymentConfig(config);
  if (!validation.valid) {
    throw new Error(validation.error || "Minute-pack contracts not configured properly for Monad Testnet");
  }

  const packageId = packageIdForMinutes(minutes);
  if (!Array.isArray(config.packMinutes) || !config.packMinutes.includes(minutes)) {
    throw new Error("This site needs the minute-pack API. Refresh after the API is updated.");
  }

  if (hasActivePendingPurchase(expectedWallet)) {
    throw new Error(
      "An existing minute-pack purchase is already pending for this wallet. Wait for it to confirm or recover."
    );
  }

  callbacks?.onStageChange?.("checking");
  await ensureMonadChain();
  const context = await createOperationContext(expectedWallet);

  const mon = await getMonBalance(context.wallet, context.provider);
  if (mon.raw === 0n) {
    throw new Error("Insufficient MON for gas fees on Monad Testnet. Please fund your wallet with testnet MON.");
  }

  const rentalRead = new Contract(context.rentalContract, RENTAL_ABI, context.provider);
  const quoteValue: bigint = await rentalRead.quoteRent(packageId);

  const tokenRead = new Contract(context.paymentToken, PAYMENT_TOKEN_ABI, context.provider);
  const tokenBalance: bigint = await tokenRead.balanceOf(context.wallet);

  if (tokenBalance < quoteValue) {
    const claimed: boolean = await tokenRead.hasClaimed(context.wallet);
    throw new Error(
      claimed
        ? "Not enough demo mUSDT. This wallet has already used its one-time test faucet."
        : "Not enough demo mUSDT. Claim test tokens before buying a minute pack."
    );
  }

  const currentAllowance: bigint = await tokenRead.allowance(context.wallet, context.rentalContract);
  if (currentAllowance < quoteValue) {
    callbacks?.onStageChange?.("approving");
    // Assert active context strictly before approve
    const { signer: approveSigner } = await assertActiveContext(context);
    const tokenContract = new Contract(context.paymentToken, PAYMENT_TOKEN_ABI, approveSigner);

    // Exact approval only
    const approval = await tokenContract.approve(context.rentalContract, quoteValue);
    callbacks?.onSubmitted?.({ txHash: approval.hash, stage: "approval" });

    const approvalReceipt = await approval.wait();
    if (approvalReceipt?.status !== 1) {
      throw new Error("Mock USDT approval failed on Monad Testnet");
    }
  }

  callbacks?.onStageChange?.("renting");
  // Assert active context strictly before rental transaction
  const { signer: rentSigner } = await assertActiveContext(context);
  const rentalContract = new Contract(context.rentalContract, RENTAL_ABI, rentSigner);

  const rentTx = await rentalContract.rent(packageId);
  const txHash = rentTx.hash as string;

  const operationId = `op_buy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const opIdentity: PendingOperationIdentity = {
    wallet: context.wallet,
    txHash,
    operationId,
    chainId: context.chainId,
    deploymentId: context.deploymentId,
  };

  // IMMEDIATELY SAVE PENDING PURCHASE UPON BROADCAST BEFORE AWAITING RECEIPT
  const pendingRecord: PendingPurchaseRecord = {
    schemaVersion: 1,
    deploymentId: context.deploymentId,
    chainId: context.chainId,
    wallet: context.wallet,
    rentalContract: context.rentalContract,
    paymentToken: context.paymentToken,
    packageId,
    minutes,
    txHash,
    stage: "broadcast",
    submittedAt: Date.now(),
    operationId,
  };
  savePendingPurchase(pendingRecord);
  callbacks?.onSubmitted?.({ txHash, stage: "rental" });

  callbacks?.onStageChange?.("awaiting_receipt");
  updatePendingPurchaseStage(opIdentity, "awaiting_receipt");

  let receipt;
  let finalTxHash = txHash;
  try {
    receipt = await rentTx.wait();
  } catch (waitErr: any) {
    const isReplaced =
      waitErr?.code === "TRANSACTION_REPLACED" ||
      waitErr?.error?.code === "TRANSACTION_REPLACED" ||
      waitErr?.info?.error?.code === "TRANSACTION_REPLACED";
    const replaced =
      waitErr?.code === "TRANSACTION_REPLACED"
        ? waitErr
        : (waitErr?.error?.code === "TRANSACTION_REPLACED" ? waitErr.error : waitErr?.info?.error);

    if (isReplaced && replaced) {
      if (replaced.cancelled) {
        updatePendingPurchaseStage(opIdentity, "cancelled");
        throw new Error("Rental transaction was cancelled in the wallet.");
      }
      if (replaced.replacement?.hash) {
        finalTxHash = replaced.replacement.hash;
        updatePendingPurchaseHash(opIdentity, replaced.replacement.hash, txHash);
        opIdentity.txHash = finalTxHash;
        receipt = replaced.receipt;
      } else {
        throw waitErr;
      }
    } else {
      // Do not clear pending record on timeout or RPC error!
      throw waitErr;
    }
  }

  if (receipt?.status !== 1) {
    updatePendingPurchaseStage(opIdentity, "reverted");
    throw new Error("Minute-pack purchase transaction failed on Monad Testnet");
  }

  updatePendingPurchaseStage(opIdentity, "awaiting_credit");
  callbacks?.onStageChange?.("awaiting_credit");

  return finalTxHash;
}

/**
 * Polls backend credit status until purchase is finalized and credited.
 * Specifically ties completion to the tracked txHash if provided.
 * Enforces per-request timeout and overall deadline.
 */
export async function waitForCreditSync(
  wallet: string,
  txHashOrTarget?: string | number | WaitForCreditSyncOptions,
  options?: WaitForCreditSyncOptions
): Promise<CreditStatus> {
  const isHash = typeof txHashOrTarget === "string" && txHashOrTarget.startsWith("0x");
  const txHash = isHash ? (txHashOrTarget as string) : undefined;
  const targetMinutes = typeof txHashOrTarget === "number" ? txHashOrTarget : undefined;
  const opts: WaitForCreditSyncOptions =
    typeof txHashOrTarget === "object" && txHashOrTarget !== null
      ? (txHashOrTarget as WaitForCreditSyncOptions)
      : (options || {});

  const maxWaitMs = opts.maxWaitMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      throw new Error("Credit synchronization aborted.");
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    // Combined abort signal for per-request timeout
    const reqTimeoutMs = Math.min(remainingMs, 8_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), reqTimeoutMs);

    const onExternalAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onExternalAbort);

    try {
      if (txHash) {
        // Query tx-specific status first
        let statusRes;
        try {
          statusRes = await getPurchaseStatus(txHash, wallet, controller.signal);
        } catch (statusErr: any) {
          if (opts.signal?.aborted) {
            throw new Error("Credit synchronization aborted.");
          }
          const isTransient =
            statusErr?.status === 503 ||
            statusErr?.code === "credit_sync_unavailable" ||
            statusErr?.status === 429;

          if (!isTransient) {
            throw statusErr;
          }
        }

        if (statusRes?.credited) {
          try {
            // Tx confirmed in cache, fetch final credit status
            const finalCredits = await getCreditStatus(wallet, controller.signal);
            const identity: PendingOperationIdentity = {
              wallet,
              txHash,
              operationId: opts.operationId,
              chainId: MONAD_CHAIN_ID,
              deploymentId: "archava-monad",
            };
            updatePendingPurchaseStage(identity, "completed");
            clearPendingPurchase(identity);
            return finalCredits;
          } catch (creditErr: any) {
            if (opts.signal?.aborted) {
              throw new Error("Credit synchronization aborted.");
            }
            const isTransient =
              creditErr?.status === 503 ||
              creditErr?.code === "credit_sync_unavailable" ||
              creditErr?.status === 429;

            if (!isTransient) {
              throw creditErr;
            }
          }
        }
      } else {
        // Fallback for legacy calls or targetMinutes checks
        let status;
        try {
          status = await getCreditStatus(wallet, controller.signal);
        } catch (statusErr: any) {
          if (opts.signal?.aborted) {
            throw new Error("Credit synchronization aborted.");
          }
          const isTransient =
            statusErr?.status === 503 ||
            statusErr?.code === "credit_sync_unavailable" ||
            statusErr?.status === 429;

          if (!isTransient) {
            throw statusErr;
          }
        }

        if (status) {
          if (targetMinutes === undefined || status.purchasedMinutes >= targetMinutes) {
            return status;
          }
        }
      }
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onExternalAbort);
    }

    opts.onProgress?.(Date.now() - (deadline - maxWaitMs));

    const sleepRemaining = deadline - Date.now();
    if (sleepRemaining <= 0) break;
    try {
      await abortableSleep(Math.min(intervalMs, sleepRemaining), opts.signal);
    } catch {
      throw new Error("Credit synchronization aborted.");
    }
  }

  throw new Error(
    "Payment was confirmed on Monad Testnet, but credit indexing is taking longer than expected. Please wait a moment and refresh."
  );
}

/**
 * Recovers an unconfirmed pending purchase from local storage.
 * Verifies onchain receipt and finalization status.
 */
export async function recoverPendingPurchase(
  wallet: string,
  options: { signal?: AbortSignal; maxWaitMs?: number } = {}
): Promise<{ status: "awaiting_receipt" | "awaiting_credit" | "completed" | "reverted" | "cancelled" | "none"; credits?: CreditStatus }> {
  const pending = getPendingPurchase(wallet);
  if (!pending) return { status: "none" };

  if (pending.stage === "reverted") return { status: "reverted" };
  if (pending.stage === "cancelled") return { status: "cancelled" };

  const identity: PendingOperationIdentity = {
    wallet,
    txHash: pending.txHash,
    operationId: pending.operationId,
    chainId: pending.chainId,
    deploymentId: pending.deploymentId,
  };

  const provider = getBrowserProvider();

  // 1. Check receipt onchain if not yet confirmed
  if (pending.stage === "broadcast" || pending.stage === "awaiting_receipt") {
    let receipt = null;
    try {
      receipt = await provider.getTransactionReceipt(pending.txHash);
    } catch {
      // RPC transient error, leave pending
      return { status: "awaiting_receipt" };
    }

    if (!receipt) {
      return { status: "awaiting_receipt" };
    }

    if (receipt.status !== 1) {
      updatePendingPurchaseStage(identity, "reverted");
      return { status: "reverted" };
    }

    updatePendingPurchaseStage(identity, "awaiting_credit");
  }

  // 2. Poll credit sync for this specific tx
  try {
    const credits = await waitForCreditSync(wallet, pending.txHash, {
      maxWaitMs: options.maxWaitMs ?? 30_000,
      signal: options.signal,
      operationId: pending.operationId,
    });
    return { status: "completed", credits };
  } catch (err: any) {
    if (options.signal?.aborted) throw err;
    return { status: "awaiting_credit" };
  }
}

/**
 * Starts an avatar session with wallet signature verification.
 */
export async function startAvatarSession(wallet: string): Promise<AvatarSession> {
  const context = await createOperationContext(wallet);
  const { signer } = await assertActiveContext(context);

  const challenge = await api<{ nonce: string; message: string }>("/api/challenge", { wallet });
  const signature = await signer.signMessage(challenge.message);
  return api<AvatarSession>("/api/session", { wallet, nonce: challenge.nonce, signature });
}

export async function endAvatarSession(ticket: string): Promise<void> {
  await api<{ ok: true }>("/api/session/end", { ticket });
}

export interface IndexedPurchase {
  id: string;
  wallet: string;
  packageId: number;
  includedMinutes: number;
  expiresAt: number;
  amountPaid: string;
  transactionHash: string;
  blockNumber: number;
  logIndex: number;
  timestamp: number;
}

export interface PurchaseHistorySync {
  status: "synced" | "indexing_lag" | "indexing" | "unavailable" | "unknown";
  ready: boolean;
  numBlocksBehind: number | null;
  latestBlock: number | null;
  message?: string;
}

export interface PurchaseHistoryResponse {
  ok: boolean;
  status: "synced" | "indexing_lag" | "indexing" | "unavailable" | "bad_request";
  purchases: IndexedPurchase[];
  sync: PurchaseHistorySync;
  pagination?: {
    limit: number;
    offset: number;
    count: number;
  };
  error?: string;
}

/**
 * Fetches public purchase history for a wallet indexed by Envio HyperIndex.
 */
export async function getPurchaseHistory(
  wallet: string,
  options?: { limit?: number; offset?: number; signal?: AbortSignal }
): Promise<PurchaseHistoryResponse> {
  const params = new URLSearchParams({ wallet });
  if (options?.limit) params.set("limit", String(options.limit));
  if (options?.offset) params.set("offset", String(options.offset));

  const res = await fetch(`/api/purchases?${params.toString()}`, {
    signal: options?.signal,
    headers: { Accept: "application/json" },
  });

  return res.json();
}
