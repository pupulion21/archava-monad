import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, FetchRequest, JsonRpcProvider, Network, formatUnits, getAddress, isAddress } from "ethers";
import { RecoverableScanError } from "./purchase-cache.mjs";
import { positiveInteger } from "./rpc-budget.mjs";

// V2 packages on Monad Testnet: 1 = 60 minutes, 2 = 300 minutes.
// Purchases are summed from AccessRented events because V2 stores
// access expiry rather than a mutable lifetime-minute counter.
export const RENTAL_ABI = [
  "function paymentToken() view returns (address)",
  "function quoteRent(uint8 packageId) view returns (uint256)",
  "function expiresAt(address wallet) view returns (uint256)",
  "function hasActiveAccess(address wallet) view returns (bool)",
  "event AccessRented(address indexed wallet, uint8 indexed packageId, uint256 includedMinutes, uint256 expiresAt, uint256 amountPaid)",
];

export const TOKEN_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

export const EXPECTED_CHAIN_ID = 10143;
export const EXPECTED_PAYMENT_TOKEN_SYMBOL = "mUSDT";
export const TOKEN_DECIMALS = 6;
export const START_BLOCK = 70191614;

export const STARTER_PACKAGE_ID = 1;
export const PRO_PACKAGE_ID = 2;
export const STARTER_PRICE_BASE_UNITS = 4937500n;
export const PRO_PRICE_BASE_UNITS = 18687500n;
export const STARTER_MINUTES = 60;
export const PRO_MINUTES = 300;

export const PACKAGES = new Map([
  [STARTER_MINUTES, STARTER_PACKAGE_ID],
  [PRO_MINUTES, PRO_PACKAGE_ID],
]);

export function normalizeWallet(value) {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error("Invalid wallet address");
  }
  return getAddress(value);
}

export function purchasedState(minutes) {
  const purchasedMinutes = Number(minutes);
  if (!Number.isSafeInteger(purchasedMinutes) || purchasedMinutes < 0 ||
      !Number.isSafeInteger(purchasedMinutes * 60)) {
    throw new Error("Invalid purchased minutes from contract");
  }
  return { purchasedMinutes };
}

/**
 * Load the canonical Monad deployment manifest.
 */
export function loadDeploymentManifest(cwd = process.cwd()) {
  const candidates = [
    resolve(cwd, "packages/contracts/deployments/monadTestnetV2.json"),
    resolve(fileURLToPath(import.meta.url), "../..", "packages/contracts/deployments/monadTestnetV2.json"),
  ];

  for (const manifestPath of candidates) {
    if (existsSync(manifestPath)) {
      try {
        const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (parsed.chainId === EXPECTED_CHAIN_ID && parsed.contracts?.rentalV2?.address) {
          return parsed;
        }
      } catch {
        // Continue to next candidate
      }
    }
  }

  return null;
}

export function configuredContracts({
  rpcUrl,
  contractAddress,
  tokenAddress,
  chainId,
  deploymentBlock,
  rpcTimeoutMs = 5000,
  manifest: explicitManifest,
  cwd = process.cwd(),
} = {}) {
  if (!contractAddress) return null;
  if (!isAddress(contractAddress)) throw new Error("RENTAL_CONTRACT (formerly PACK_CONTRACT) is invalid");
  if (!isAddress(tokenAddress || "")) throw new Error("PAYMENT_TOKEN_CONTRACT is missing or invalid");
  if (!rpcUrl) throw new Error("RPC_URL is required when RENTAL_CONTRACT is set");
  if (Number(chainId) !== EXPECTED_CHAIN_ID) {
    throw new Error(`Archava Rental V2 is configured for Monad Testnet chain ID ${EXPECTED_CHAIN_ID}`);
  }

  const manifest = explicitManifest !== undefined ? explicitManifest : loadDeploymentManifest(cwd);
  if (manifest) {
    if (Number(manifest.chainId) !== EXPECTED_CHAIN_ID) {
      throw new Error(`Manifest chain ID mismatch: expected ${EXPECTED_CHAIN_ID}, got ${manifest.chainId}`);
    }
    const expectedRental = getAddress(manifest.contracts.rentalV2.address);
    if (getAddress(contractAddress) !== expectedRental) {
      throw new Error(
        `RENTAL_CONTRACT (${getAddress(contractAddress)}) does not match deployment manifest (${expectedRental})`
      );
    }
    const expectedToken = getAddress(manifest.contracts.mockUsdt.address);
    if (getAddress(tokenAddress) !== expectedToken) {
      throw new Error(
        `PAYMENT_TOKEN_CONTRACT (${getAddress(tokenAddress)}) does not match deployment manifest (${expectedToken})`
      );
    }
    const manifestBlock = Number(manifest.contracts.rentalV2.deployBlock);
    if (deploymentBlock && Number(deploymentBlock) !== manifestBlock) {
      throw new Error(
        `RENTAL_DEPLOYMENT_BLOCK (${deploymentBlock}) does not match deployment manifest (${manifestBlock})`
      );
    }
  }

  const effectiveBlock = Number(deploymentBlock || manifest?.contracts?.rentalV2?.deployBlock || START_BLOCK);
  if (!Number.isSafeInteger(effectiveBlock) || effectiveBlock <= 0) {
    throw new Error("RENTAL_DEPLOYMENT_BLOCK must be a positive block number");
  }

  const request = new FetchRequest(rpcUrl);
  request.timeout = positiveInteger(rpcTimeoutMs, 5000, "ARCHAVA_RPC_TIMEOUT_MS");
  request.setThrottleParams({ maxAttempts: 2 });
  const network = Network.from(Number(chainId));
  const provider = new JsonRpcProvider(request, network, { staticNetwork: network });
  const rental = new Contract(contractAddress, RENTAL_ABI, provider);
  const token = new Contract(tokenAddress, TOKEN_ABI, provider);

  return {
    provider,
    rental,
    token,
    contractAddress: getAddress(contractAddress),
    tokenAddress: getAddress(tokenAddress),
    chainId: Number(chainId),
    deploymentBlock: effectiveBlock,
  };
}

/**
 * Onchain read-only checks required at startup for Monad connection.
 */
export async function verifyMonadConnection(connection, { onProgress = () => {} } = {}) {
  onProgress("Checking RPC chain ID (expected 10143)...");
  let actualChainId;
  if (typeof connection.provider.send === "function") {
    const raw = await connection.provider.send("eth_chainId", []);
    actualChainId = Number(raw);
  } else {
    const network = await connection.provider.getNetwork();
    actualChainId = Number(network.chainId);
  }
  if (actualChainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`RPC chain mismatch: connected to chain ${actualChainId}, expected ${EXPECTED_CHAIN_ID}`);
  }

  onProgress("Checking rental and payment-token bytecode...");
  const [rentalCode, tokenCode] = await Promise.all([
    connection.provider.getCode(connection.contractAddress),
    connection.provider.getCode(connection.tokenAddress),
  ]);

  if (!rentalCode || rentalCode === "0x") {
    throw new Error(`Rental contract bytecode not found at ${connection.contractAddress}`);
  }
  if (!tokenCode || tokenCode === "0x") {
    throw new Error(`Payment token bytecode not found at ${connection.tokenAddress}`);
  }

  onProgress("Checking payment token and package prices...");
  const onchainToken = getAddress(await connection.rental.paymentToken());
  if (onchainToken !== getAddress(connection.tokenAddress)) {
    throw new Error(`Payment token does not match RENTAL_CONTRACT: contract has ${onchainToken}, expected ${connection.tokenAddress}`);
  }

  const [decimals, symbol] = await Promise.all([
    connection.token.decimals(),
    connection.token.symbol(),
  ]);

  if (Number(decimals) !== TOKEN_DECIMALS || symbol !== EXPECTED_PAYMENT_TOKEN_SYMBOL) {
    throw new Error(`Configured payment token is not Archava Mock USDT (decimals=${decimals}, symbol="${symbol}")`);
  }

  const [starterQuote, proQuote] = await Promise.all([
    connection.rental.quoteRent(STARTER_PACKAGE_ID),
    connection.rental.quoteRent(PRO_PACKAGE_ID),
  ]);

  if (starterQuote !== STARTER_PRICE_BASE_UNITS) {
    throw new Error(`Starter package quote mismatch: got ${starterQuote}, expected ${STARTER_PRICE_BASE_UNITS}`);
  }
  if (proQuote !== PRO_PRICE_BASE_UNITS) {
    throw new Error(`Pro package quote mismatch: got ${proQuote}, expected ${PRO_PRICE_BASE_UNITS}`);
  }

  return true;
}

export function createCreditReader(config, options = {}) {
  const connection = options.connection || configuredContracts({ ...config, manifest: options.manifest });
  if (!connection) return null;
  const { provider, rental, deploymentBlock } = connection;
  const { purchaseCache, purchaseScanner, maxStalenessMs = 60_000 } = options;

  return async (walletInput) => {
    const wallet = normalizeWallet(walletInput);

    // Gate access on active access onchain, explicitly using finalized block tag
    let active;
    try {
      active = await rental.hasActiveAccess(wallet, { blockTag: "finalized" });
    } catch (err) {
      throw new RecoverableScanError(
        `Failed to verify active access onchain: ${err.message || String(err)}`,
        { code: "credit_sync_unavailable", cause: err }
      );
    }

    if (!active) {
      return purchasedState(0);
    }

    // Incremental purchase cache path
    if (purchaseCache) {
      await purchaseCache.load();
      const isFresh = typeof purchaseCache.isFresh === "function"
        ? await purchaseCache.isFresh(maxStalenessMs)
        : false;

      let minutes = await purchaseCache.getPurchasedMinutes(wallet);

      // If cache is stale or active user has 0 minutes, sync scanner
      if (!isFresh || minutes === 0) {
        if (!purchaseScanner) {
          throw new RecoverableScanError(
            "Purchase cache is stale and no scanner is configured to refresh it",
            { code: "credit_sync_unavailable" }
          );
        }
        const syncResult = await purchaseScanner.sync();
        if (syncResult?.synced === false) {
          throw new RecoverableScanError("Purchase history is still syncing", { code: "credit_sync_unavailable" });
        }
        minutes = await purchaseCache.getPurchasedMinutes(wallet);
      }

      return purchasedState(minutes);
    }

    // Direct event reader fallback (used in unit test fixtures without cache)
    let finalized;
    try {
      finalized = await provider.getBlock("finalized");
    } catch (err) {
      throw new RecoverableScanError(
        `Failed to fetch finalized block for credit reading: ${err.message || String(err)}`,
        { code: "credit_sync_unavailable", cause: err }
      );
    }

    if (!finalized || !Number.isSafeInteger(Number(finalized.number))) {
      throw new RecoverableScanError(
        "Finalized block is unavailable or malformed from RPC provider",
        { code: "credit_sync_unavailable" }
      );
    }

    const toBlock = Number(finalized.number);
    let eventTopic =
      rental.interface?.getEvent?.("AccessRented")?.topicHash ||
      rental.filters?.AccessRented?.fragment?.topicHash ||
      "0xb4054fd02cbdc36fc1dba2c1f9c83337e36f34f42048985882b46e04960496a8";

    const filter = rental.filters?.AccessRented ? rental.filters.AccessRented(wallet) : null;
    const topics = filter?.topics || [
      eventTopic,
      "0x000000000000000000000000" + wallet.slice(2).toLowerCase(),
    ];

    const logs = await provider.getLogs({
      address: connection.contractAddress,
      topics,
      fromBlock: deploymentBlock,
      toBlock,
    });
    let purchasedMinutes = 0n;
    for (const log of logs) {
      let event;
      try {
        event = rental.interface.parseLog(log);
      } catch {
        continue;
      }
      if (event && event.name === "AccessRented") {
        purchasedMinutes += BigInt(event.args.includedMinutes);
      }
    }
    return purchasedState(purchasedMinutes);
  };
}

export function createPackQuoter(config, options = {}) {
  const connection = options.connection || configuredContracts({ ...config, manifest: options.manifest });
  if (!connection) return null;
  const { rental, token } = connection;
  return async (minutes) => {
    const packageId = PACKAGES.get(minutes);
    if (!packageId) throw new Error("Unsupported minute pack");
    const [wei, decimals, symbol] = await Promise.all([
      rental.quoteRent(packageId),
      token.decimals(),
      token.symbol(),
    ]);
    if (Number(decimals) !== TOKEN_DECIMALS || symbol !== EXPECTED_PAYMENT_TOKEN_SYMBOL) {
      throw new Error("Configured payment token is not Archava Mock USDT");
    }
    return { minutes, wei: wei.toString(), tokenAmount: formatUnits(wei, TOKEN_DECIMALS), symbol };
  };
}

