import { isAddress, getAddress } from "ethers";

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 50;
export const DEFAULT_TIMEOUT_MS = 5000;

export const PURCHASES_QUERY = `
  query GetPurchases($wallet: String!, $limit: Int!, $offset: Int!, $chainId: Int!) {
    AccessRented(
      where: { wallet: { _eq: $wallet } }
      order_by: { timestamp: desc }
      limit: $limit
      offset: $offset
    ) {
      id
      wallet
      packageId
      includedMinutes
      expiresAt
      amountPaid
      transactionHash
      blockNumber
      logIndex
      timestamp
    }
    _meta(where: { chainId: { _eq: $chainId } }) {
      chainId
      progressBlock
      sourceBlock
      isReady
      startBlock
      endBlock
      eventsProcessed
    }
  }
`;

function redactSecrets(message, secrets = []) {
  let out = String(message || "Network error");
  for (const secret of secrets) {
    if (secret && typeof secret === "string" && secret.length >= 4 && out.includes(secret)) {
      out = out.split(secret).join("[redacted]");
    }
  }
  return out;
}

function unavailableResult({ error, limit, offset }) {
  return {
    ok: false,
    statusCode: 503,
    status: "unavailable",
    error,
    purchases: [],
    sync: {
      status: "unavailable",
      ready: false,
      isReady: false,
      chainId: null,
      progressBlock: null,
      sourceBlock: null,
      numBlocksBehind: null,
      latestBlock: null,
    },
    pagination: { limit, offset, count: 0 },
  };
}

function toBlockNumber(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isSafeInteger(Number(value))) {
    return Number(value);
  }
  return null;
}

/**
 * Selects validated indexing metadata for the canonical chain only.
 * Never falls back to another chain. Missing or malformed metadata
 * must not produce "synced" — callers receive "unknown".
 */
export function selectChainMeta(metaList, chainId) {
  if (!Array.isArray(metaList) || metaList.length === 0) {
    return { found: false, entry: null };
  }
  const entry = metaList.find((m) => m && Number(m.chainId) === Number(chainId)) || null;
  if (!entry) {
    return { found: false, entry: null };
  }
  const progressBlock = toBlockNumber(entry.progressBlock);
  const sourceBlock = toBlockNumber(entry.sourceBlock);
  const isReady = entry.isReady;
  if (progressBlock === null || sourceBlock === null || typeof isReady !== "boolean") {
    return { found: true, entry: null, malformed: true, raw: entry };
  }
  return { found: true, entry: { ...entry, progressBlock, sourceBlock, isReady } };
}

export function deriveSyncStatus(validEntry) {
  if (!validEntry) {
    return {
      status: "unknown",
      ready: false,
      isReady: false,
      chainId: null,
      progressBlock: null,
      sourceBlock: null,
      numBlocksBehind: null,
      latestBlock: null,
    };
  }
  const lag = Math.max(0, validEntry.sourceBlock - validEntry.progressBlock);
  let status = "unknown";
  if (validEntry.isReady && lag === 0) {
    status = "synced";
  } else if (lag > 0) {
    status = "indexing_lag";
  } else if (!validEntry.isReady) {
    status = "indexing";
  }
  return {
    status,
    ready: validEntry.isReady,
    isReady: validEntry.isReady,
    chainId: Number(validEntry.chainId),
    progressBlock: validEntry.progressBlock,
    sourceBlock: validEntry.sourceBlock,
    numBlocksBehind: lag,
    latestBlock: validEntry.sourceBlock,
    ...(validEntry.startBlock !== undefined ? { startBlock: Number(validEntry.startBlock) } : {}),
    ...(validEntry.endBlock !== undefined && validEntry.endBlock !== null
      ? { endBlock: Number(validEntry.endBlock) }
      : {}),
    ...(validEntry.eventsProcessed !== undefined
      ? { eventsProcessed: Number(validEntry.eventsProcessed) }
      : {}),
  };
}

/**
 * Creates the server-side purchase history service backed by Envio HyperIndex GraphQL.
 *
 * Credentials and GraphQL URLs are kept strictly server-side.
 * Authoritative credit validation and the usage ledger are NEVER replaced by Envio;
 * this service provides public historical records, sync metadata, and explorer linkages.
 */
export function createPurchaseHistoryService({
  envioUrl = process.env.ENVIO_GRAPHQL_URL || "",
  envioApiKey = process.env.ENVIO_API_KEY || "",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  chainId = 10143,
  contractAddress = "0x7324a2678e74052a4e9a244c0d57b56b23fee6ad",
  deploymentBlock = 70191614,
  purchaseCache = null,
} = {}) {
  const canonicalContract = contractAddress.toLowerCase();
  const canonicalChainId = Number(chainId);
  const canonicalDeployBlock = Number(deploymentBlock);

  return {
    isConfigured() {
      return Boolean(envioUrl);
    },

    async getPurchases({ wallet, limit = DEFAULT_PAGE_LIMIT, offset = 0 } = {}) {
      // 1. Validate wallet address
      if (!wallet || typeof wallet !== "string" || !isAddress(wallet)) {
        return {
          ok: false,
          statusCode: 400,
          status: "bad_request",
          error: "Invalid or missing wallet address",
          purchases: [],
          sync: { status: "invalid_input" },
        };
      }

      const checksumWallet = getAddress(wallet);
      const queryWallet = checksumWallet.toLowerCase();

      // 2. Bound pagination
      const parsedLimit = Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(Number(limit) || DEFAULT_PAGE_LIMIT)));
      const parsedOffset = Math.max(0, Math.floor(Number(offset) || 0));

      // 3. Gracefully return unavailable if Envio endpoint is not configured
      if (!envioUrl) {
        return {
          ok: true,
          statusCode: 200,
          status: "unavailable",
          error: "Envio indexer endpoint not configured",
          purchases: [],
          sync: {
            status: "unavailable",
            ready: false,
            isReady: false,
            chainId: canonicalChainId,
            progressBlock: null,
            sourceBlock: null,
            numBlocksBehind: null,
            latestBlock: null,
            message: "ENVIO_GRAPHQL_URL is not configured",
          },
          pagination: {
            limit: parsedLimit,
            offset: parsedOffset,
            count: 0,
          },
        };
      }

      // 4. Query Envio GraphQL with a single deadline covering fetch + body read.
      const controller = new AbortController();
      let timeoutId = null;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          try {
            controller.abort();
          } catch {
            // ignore abort errors
          }
          const err = new Error("Envio query timed out");
          err.name = "AbortError";
          reject(err);
        }, timeoutMs);
      });

      try {
        const headers = {
          "content-type": "application/json",
          accept: "application/json",
        };
        if (envioApiKey) {
          headers.authorization = `Bearer ${envioApiKey}`;
          headers["x-api-key"] = envioApiKey;
        }

        const response = await Promise.race([
          fetchImpl(envioUrl, {
            method: "POST",
            headers,
            body: JSON.stringify({
              query: PURCHASES_QUERY,
              variables: {
                wallet: queryWallet,
                limit: parsedLimit,
                offset: parsedOffset,
                chainId: canonicalChainId,
              },
            }),
            signal: controller.signal,
          }),
          timeoutPromise,
        ]);

        if (!response.ok) {
          return {
            ok: false,
            statusCode: 503,
            status: "unavailable",
            error: `Envio HTTP error: ${response.status}`,
            purchases: [],
            sync: {
              status: "unavailable",
              ready: false,
              isReady: false,
              chainId: canonicalChainId,
              progressBlock: null,
              sourceBlock: null,
              numBlocksBehind: null,
              latestBlock: null,
            },
            pagination: { limit: parsedLimit, offset: parsedOffset, count: 0 },
          };
        }

        // Body reading shares the same deadline: a stalled body rejects via timeoutPromise.
        const json = await Promise.race([response.json(), timeoutPromise]);

        if (json.errors && json.errors.length > 0) {
          const errorMessage = json.errors.map((e) => e.message).join(", ");
          return {
            ok: false,
            statusCode: 503,
            status: "unavailable",
            error: redactSecrets(`Envio GraphQL error: ${errorMessage}`, [envioApiKey, envioUrl]),
            purchases: [],
            sync: {
              status: "unavailable",
              ready: false,
              isReady: false,
              chainId: canonicalChainId,
              progressBlock: null,
              sourceBlock: null,
              numBlocksBehind: null,
              latestBlock: null,
            },
            pagination: { limit: parsedLimit, offset: parsedOffset, count: 0 },
          };
        }

        const data = json.data || {};
        const rawList = Array.isArray(data.AccessRented) ? data.AccessRented : [];
        const metaList = data._meta;

        // Select metadata for the canonical chain explicitly; never fall back.
        const selection = selectChainMeta(metaList, canonicalChainId);
        const sync = deriveSyncStatus(selection.entry || null);
        // Preserve canonical chain id in sync even when metadata is missing.
        if (sync.chainId === null || sync.chainId === undefined) {
          sync.chainId = canonicalChainId;
        }
        const syncStatus = sync.status;

        // 5. Validate records against requested wallet + canonical deployment scope,
        // then deduplicate by compound event ID (chain + contract + txHash + logIndex).
        const seenIds = new Set();
        const purchases = [];
        const expectedIdPrefix = `${canonicalChainId}:${canonicalContract}:`;

        for (const item of rawList) {
          if (!item || typeof item !== "object") continue;
          // Buyer-wallet scoping: drop foreign purchase records.
          let itemWalletLower = "";
          try {
            if (typeof item.wallet !== "string" || !isAddress(item.wallet)) continue;
            itemWalletLower = getAddress(item.wallet).toLowerCase();
          } catch {
            continue;
          }
          if (itemWalletLower !== queryWallet) continue;

          const blockNumber = Number(item.blockNumber);
          if (!Number.isSafeInteger(blockNumber) || blockNumber < canonicalDeployBlock) continue;

          const txHash = typeof item.transactionHash === "string" ? item.transactionHash.toLowerCase() : "";
          if (!/^0x[0-9a-f]{64}$/.test(txHash)) continue;
          const logIndex = Number(item.logIndex);
          if (!Number.isSafeInteger(logIndex) || logIndex < 0) continue;

          const id =
            item.id || `${canonicalChainId}:${canonicalContract}:${txHash}:${logIndex}`;
          // Enforce compound ID scope when the indexer provides one.
          if (typeof item.id === "string" && item.id.length > 0) {
            const idLower = item.id.toLowerCase();
            if (!idLower.startsWith(expectedIdPrefix)) continue;
          }
          if (seenIds.has(id)) continue;
          seenIds.add(id);

          const timestamp = Number(item.timestamp);
          const expiresAt = Number(item.expiresAt);
          if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(expiresAt)) continue;

          purchases.push({
            id,
            wallet: getAddress(item.wallet),
            packageId: Number(item.packageId),
            includedMinutes: Number(item.includedMinutes),
            expiresAt,
            amountPaid: String(item.amountPaid),
            transactionHash: txHash,
            blockNumber,
            logIndex,
            timestamp,
          });
        }

        return {
          ok: true,
          statusCode: 200,
          status: syncStatus,
          purchases,
          sync,
          pagination: {
            limit: parsedLimit,
            offset: parsedOffset,
            count: purchases.length,
          },
        };
      } catch (err) {
        const isTimeout =
          err && (err.name === "AbortError" || /timed out/i.test(err.message || ""));
        const rawMessage = isTimeout ? "Envio query timed out" : err.message || "Network error";
        return unavailableResult({
          error: redactSecrets(rawMessage, [envioApiKey, envioUrl]),
          limit: parsedLimit,
          offset: parsedOffset,
        });
      } finally {
        if (timeoutId !== null) clearTimeout(timeoutId);
      }
    },
  };
}
