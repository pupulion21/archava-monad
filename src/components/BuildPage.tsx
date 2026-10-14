import { useEffect, useRef, useState, useCallback } from "react";
import { formatUnits } from "ethers";
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, Clock3, Code2, Copy, Database, ExternalLink, KeyRound, Mic2, RefreshCw, ShieldCheck, Wallet, Zap } from "lucide-react";
import { type AppConfig, type PackQuote, type CreditStatus, type IndexedPurchase, type PurchaseHistorySync, getPurchaseHistory, getPendingPurchase } from "../lib/rental";

interface BuildPageProps {
  config: AppConfig | null;
  wallet: string;
  credits: CreditStatus | null;
  quote: PackQuote | null;
  selectedPack: number;
  previewReady: boolean;
  previewSupported: boolean;
  configStatus: "loading" | "ready" | "error";
  loading: string;
  txHash: string;
  onConnect: () => void;
  onBuy: () => void;
  onClaimFaucet: () => void;
  txKind: "purchase" | "faucet";
  onSelectPack: (minutes: number) => void;
  onRefreshQuote: () => void;
  onOpenDeveloper: () => void;
  onError: (message: string) => void;
}

const shortWallet = (wallet: string) => wallet.slice(0, 6) + "…" + wallet.slice(-4);

const sessionExample = `// Your backend only. Keep the Archava key off the browser.
const response = await fetch(process.env.ARCHAVA_API_URL + "/v1/sessions", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + process.env.ARCHAVA_API_KEY,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ avatar: "ava" }),
});
if (!response.ok) throw new Error("Ava session unavailable");
const { sessionId, serverUrl, participantToken, endsAt, avatar } =
  await response.json();
// Pass the short-lived room data to your browser, never the API key.`;

const packAbi = `quoteRent(uint8 packageId) → mUSDT base units
rent(uint8 packageId) → transfers approved mUSDT
AccessRented(wallet, packageId, includedMinutes, expiresAt, amountPaid)`;

export function BuildPage({
  config,
  wallet,
  credits,
  quote,
  selectedPack,
  previewReady,
  previewSupported,
  configStatus,
  loading,
  txHash,
  onConnect,
  onBuy,
  onClaimFaucet,
  txKind,
  onSelectPack,
  onRefreshQuote,
  onOpenDeveloper,
  onError,
}: BuildPageProps) {
  const [copied, setCopied] = useState<"session" | "contract" | "">("");
  const copyTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const copyExample = async (kind: "session" | "contract") => {
    try {
      await navigator.clipboard.writeText(kind === "session" ? sessionExample : packAbi);
      setCopied(kind);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(""), 2000);
    } catch {
      onError("Couldn't copy the example. Select the code to copy it manually, or allow clipboard access and try again.");
    }
  };

  // Envio purchase history state
  const [purchases, setPurchases] = useState<IndexedPurchase[]>([]);
  const [syncMeta, setSyncMeta] = useState<PurchaseHistorySync | null>(null);
  const [historyStatus, setHistoryStatus] = useState<"idle" | "loading" | "ready" | "unavailable">("idle");
  const [historyLoading, setHistoryLoading] = useState(false);

  const fetchHistory = useCallback(async () => {
    if (!wallet) {
      setPurchases([]);
      setSyncMeta(null);
      setHistoryStatus("idle");
      return;
    }
    setHistoryLoading(true);
    try {
      const res = await getPurchaseHistory(wallet);
      if (res && res.ok) {
        setPurchases(res.purchases || []);
        setSyncMeta(res.sync || null);
        setHistoryStatus(res.status === "unavailable" ? "unavailable" : "ready");
      } else {
        setSyncMeta(res?.sync || { status: "unavailable", ready: false, numBlocksBehind: null, latestBlock: null });
        setHistoryStatus("unavailable");
      }
    } catch {
      setSyncMeta({ status: "unavailable", ready: false, numBlocksBehind: null, latestBlock: null });
      setHistoryStatus("unavailable");
    } finally {
      setHistoryLoading(false);
    }
  }, [wallet]);

  useEffect(() => {
    void fetchHistory();
  }, [fetchHistory, txHash]);

  const contractConfigured = Boolean(config?.contractAddress);
  const hasCredits = Boolean(credits?.active);
  const explorer = "https://testnet.monadscan.com/tx/";
  const accessLabel = !contractConfigured
    ? "AWAITING CONTRACT"
    : hasCredits
      ? "MINUTES AVAILABLE"
      : quote
        ? "PACK AVAILABLE"
        : "CHECKING CONTRACT";

  // Check for any pending purchase not yet reflected in Envio
  const pendingRecord = wallet ? getPendingPurchase(wallet) : null;
  const isTxIndexed = (hash: string) => purchases.some((p) => p.transactionHash.toLowerCase() === hash.toLowerCase());
  const pendingPurchaseItem = pendingRecord && !isTxIndexed(pendingRecord.txHash) ? pendingRecord : null;

  // History sync badge
  const historySyncStatus = syncMeta?.status || (historyStatus === "unavailable" ? "unavailable" : "unknown");
  const historySyncLabel = historyLoading
    ? "CHECKING INDEXER…"
    : historySyncStatus === "synced"
      ? `ENVIO SYNCED${syncMeta?.latestBlock ? ` · BLOCK #${syncMeta.latestBlock}` : ""}`
      : historySyncStatus === "indexing_lag"
        ? `INDEXING LAG (${syncMeta?.numBlocksBehind ?? "?"} BLOCKS)`
        : historySyncStatus === "indexing"
          ? "INDEXING IN PROGRESS"
          : historySyncStatus === "unavailable"
            ? "INDEXER OFFLINE"
            : "ENVIO INDEXER";

  return (
    <main className="build-page" id="top" tabIndex={-1}>
      <div className="build-page-grid" aria-hidden="true" />
      <header className="build-nav">
        <a className="build-brand" href="/" aria-label="Archava home">ARCHAVA<small>BUILD</small></a>
        <nav aria-label="Build page navigation">
          <a href="#access">Onchain access</a>
          <a href="#history">Purchase history</a>
          <a href="#api">Session API</a>
          <a href="/#catalog-section">Talk to Ava <ArrowUpRight size={14} /></a>
        </nav>
      </header>

      <section className="build-hero" aria-labelledby="build-title">
        <div className="build-hero-copy">
          <span className="build-kicker"><span className="build-status-dot" /> ONE AVATAR / TWO WAYS IN</span>
          <h1 id="build-title">Bring Ava<br /><em>into your world</em></h1>
          <p>
            Explore Ava in the browser. When the live preview is online, talk to her without a wallet. Buy Ava minutes with a wallet to keep talking or use an Archava API key from your own backend.
          </p>
          <div className="build-hero-actions">
            <a className="build-button build-button-primary" href="/#catalog-section"><Mic2 size={17} /> {previewReady ? "Talk to Ava" : "Explore Ava"} <ArrowUpRight size={17} /></a>
            <a className="build-button build-button-quiet" href="#access">Explore access <ArrowRight size={17} /></a>
          </div>
          <div className="build-hero-footnote">{configStatus === "loading" ? "LIVE PREVIEW / CHECKING AVAILABILITY" : !previewSupported ? "LIVE PREVIEW / OPEN IN CHROME OR EDGE" : previewReady ? "LIVE PREVIEW / NO WALLET NEEDED" : "LIVE PREVIEW / CURRENTLY OFFLINE"} · API KEYS / WALLET SIGNATURE · MINUTE PACKS / MONAD TESTNET</div>
        </div>
        <div className="build-hero-art" aria-label="Concept artwork of Ava">
          <img src="/assets/archava_hero_clean.webp" alt="Concept portrait representing Ava" />
          <div className="build-art-grid" aria-hidden="true" />
          <div className="build-art-label"><span>AVA / 001</span><strong>ONE LIVE HOST</strong><span>CONCEPT PORTRAIT</span></div>
        </div>
      </section>

      <section className="build-route-strip" aria-label="How Archava works">
        <div><span>01 / EXPERIENCE</span><strong>Meet Ava in the browser</strong><small>{previewReady ? "Anonymous live preview" : "Live preview offline"}</small></div>
        <ArrowRight size={18} aria-hidden="true" />
        <div><span>02 / ACCESS</span><strong>Buy Ava minutes</strong><small>Mock USDT on Monad Testnet</small></div>
        <ArrowRight size={18} aria-hidden="true" />
        <div><span>03 / HISTORY</span><strong>Envio HyperIndex</strong><small>Indexed purchase events</small></div>
        <ArrowRight size={18} aria-hidden="true" />
        <div><span>04 / INTEGRATE</span><strong>Open a room by API</strong><small>Key stays on your backend</small></div>
      </section>

      <section className="build-section build-access" id="access" aria-labelledby="access-title" data-reveal>
        <div className="build-section-intro">
          <span className="build-section-index">01 / ONCHAIN ACCESS</span>
          <h2 id="access-title">Your minutes<br /><span>Your Ava sessions</span></h2>
          <p>Minute packs belong to a wallet. Archava reads the wallet's rental events and active access from Monad Testnet, then subtracts allocated room time from its server ledger. Your website calls and API key share one balance.</p>
        </div>
        <div className="build-access-card">
          <div className="build-card-top"><span>ACCESS TERMINAL</span><span className={hasCredits || quote ? "build-ready" : "build-pending"}>{accessLabel}</span></div>
          <div className="build-access-row"><span>NETWORK</span><strong>{!config ? "UNVERIFIED" : config.chainId === 10143 ? "MONAD TESTNET" : `CHAIN #${config.chainId}`}</strong></div>
          <div className="build-access-row"><span>WALLET</span><strong>{wallet ? shortWallet(wallet) : "NOT CONNECTED"}</strong></div>
          <div className="build-access-row"><span>CONTRACT</span><strong>{contractConfigured ? "CONFIGURED" : "NOT CONNECTED"}</strong></div>
          {contractConfigured && <div className="build-access-row"><span>AVAILABLE</span><strong>{credits ? `${Math.floor(credits.remainingSeconds / 60)}m ${credits.remainingSeconds % 60}s` : wallet ? "CHECKING BALANCE" : "CONNECT TO CHECK"}</strong></div>}
          {config && <div className="pack-options" role="group" aria-label="Choose minute pack">{(config.packMinutes || [60, 300]).map((minutes) => <button key={minutes} type="button" className={selectedPack === minutes ? "selected" : ""} aria-pressed={selectedPack === minutes} onClick={() => onSelectPack(minutes)}>{minutes} min</button>)}</div>}
          {contractConfigured && quote && <div className="build-quote"><span>{quote.minutes} AVA MINUTES</span><strong>{quote.tokenAmount} {quote.symbol}</strong></div>}
          {!contractConfigured ? (
            <p className="build-card-note">The contract address is not configured in this build. {previewReady ? "The free preview is available from the landing page." : "The live preview is currently offline."}</p>
          ) : !wallet ? (
            <button className="build-button build-button-primary build-card-action" type="button" onClick={onConnect} disabled={!!loading}><Wallet size={16} /> {loading === "connect" ? "Connecting…" : "Connect wallet"}</button>
          ) : quote ? (
            <button className="build-button build-button-primary build-card-action" type="button" onClick={onBuy} disabled={!!loading}><Zap size={16} /> {loading === "buy" ? "Confirming pack…" : `Buy ${selectedPack} minutes`}</button>
          ) : (
            <button className="build-button build-button-quiet build-card-action" type="button" onClick={onRefreshQuote}>Quote unavailable · retry</button>
          )}
          {wallet && config?.paymentTokenAddress && <button className="build-button build-button-quiet build-card-action" type="button" onClick={onClaimFaucet} disabled={!!loading}><Wallet size={16} /> {loading === "faucet" ? "Claiming demo mUSDT…" : "Claim 100 demo mUSDT"}</button>}
          {hasCredits && <a className="build-button build-button-quiet build-card-action" href="/#catalog-section"><Check size={16} /> Talk with Ava <ArrowUpRight size={16} /></a>}
          {txHash && <a className="build-tx" href={explorer + txHash} target="_blank" rel="noreferrer">{txKind === "faucet" ? "Demo mUSDT claimed" : "Minute pack confirmed"} · View transaction <ArrowUpRight size={13} /></a>}
          <span className="build-card-disclaimer"><Clock3 size={13} /> mUSDT is a testnet demo token with no real value. Keep MON for gas. Each call runs up to 30 minutes; unused reserved seconds return when you end it.</span>
        </div>
      </section>

      <section className="build-section build-history" id="history" aria-labelledby="history-title" data-reveal>
        <div className="build-section-intro">
          <span className="build-section-index">02 / PURCHASE HISTORY</span>
          <h2 id="history-title">Indexed onchain<br /><span>Powered by Envio</span></h2>
          <p>
            Purchase events from ArchavaRentalV2 are indexed continuously by Envio HyperIndex on Monad Testnet. Review your past package rentals, verified transaction hashes, and real-time indexing status.
          </p>
        </div>
        <div className="build-access-card">
          <div className="build-card-top">
            <span><Database size={13} style={{ verticalAlign: "middle", marginRight: 6 }} /> ONCHAIN RENTAL FEED</span>
            <span className={historySyncStatus === "synced" ? "build-ready" : "build-pending"}>
              {historySyncLabel}
            </span>
          </div>
          {!wallet ? (
            <p className="build-card-note">Connect a wallet above to inspect its onchain minute purchases and Envio index status.</p>
          ) : (
            <>
              <div className="build-history-list">
                {pendingPurchaseItem && (
                  <div className="build-history-item pending" key={`pending-${pendingPurchaseItem.txHash}`}>
                    <div className="build-history-item-top">
                      <strong>{pendingPurchaseItem.minutes} AVA MINUTES</strong>
                      <span className="build-history-pill build-pending">AWAITING INDEX</span>
                    </div>
                    <div className="build-history-item-details">
                      <span>Submitted: {new Date(pendingPurchaseItem.submittedAt).toLocaleTimeString()}</span>
                      <a href={explorer + pendingPurchaseItem.txHash} target="_blank" rel="noreferrer">
                        {pendingPurchaseItem.txHash.slice(0, 10)}…{pendingPurchaseItem.txHash.slice(-6)} <ExternalLink size={10} />
                      </a>
                    </div>
                  </div>
                )}
                {purchases.map((item) => (
                  <div className="build-history-item" key={item.id}>
                    <div className="build-history-item-top">
                      <strong>{item.includedMinutes} AVA MINUTES</strong>
                      <span className="build-history-pill build-ready">INDEXED</span>
                    </div>
                    <div className="build-history-item-details">
                      <span>{formatUnits(item.amountPaid, 6)} mUSDT · Pack #{item.packageId}</span>
                      <span>{new Date(item.timestamp * 1000).toLocaleString()} · Block #{item.blockNumber}</span>
                      <a href={explorer + item.transactionHash} target="_blank" rel="noreferrer">
                        {item.transactionHash.slice(0, 10)}…{item.transactionHash.slice(-6)} <ExternalLink size={10} />
                      </a>
                    </div>
                  </div>
                ))}
              </div>

              {purchases.length === 0 && !pendingPurchaseItem && (
                <div className="build-history-empty">
                  {historyStatus === "unavailable" ? (
                    <p>Envio HyperIndex service is currently offline. Authoritative room access and minute ledger continue to operate directly from onchain state.</p>
                  ) : (
                    <p>No minute pack purchases found for this wallet yet. Rent minutes above to create your first indexed session pack.</p>
                  )}
                </div>
              )}

              <button
                className="build-button build-button-quiet build-card-action"
                type="button"
                onClick={fetchHistory}
                disabled={historyLoading}
              >
                <RefreshCw size={14} className={historyLoading ? "spin" : ""} /> {historyLoading ? "Checking indexer…" : "Refresh purchase history"}
              </button>

              <div className="build-history-meta">
                <span>INDEXER: ENVIO HYPERINDEX 3.x</span>
                <span>CHAIN: MONAD TESTNET (10143)</span>
              </div>
            </>
          )}
        </div>
      </section>

      <section className="build-section build-api" id="api" aria-labelledby="api-title" data-reveal>
        <div className="build-section-intro">
          <span className="build-section-index">03 / SESSION API</span>
          <h2 id="api-title">One request<br /><span>One live Ava</span></h2>
          <p>Archava creates the voice and avatar room behind one session API. Your backend holds the Archava key; your browser receives only the short lived room token and public avatar identifiers.</p>
          <div className="build-api-cta">
            {!wallet ? (
              <button className="build-button build-button-primary" type="button" onClick={onConnect} disabled={!!loading}><Wallet size={16} /> Connect wallet for API keys</button>
            ) : (
              <button className="build-button build-button-primary" type="button" onClick={onOpenDeveloper}><KeyRound size={16} /> Open API key dashboard</button>
            )}
            <span>Creating a key is free. Paid sessions draw from the same wallet minute balance.</span>
          </div>
        </div>
        <div className="build-code-card">
          <div className="build-code-head"><span><Code2 size={16} /> BACKEND / JAVASCRIPT</span><span>POST /v1/sessions</span><button className="code-copy-btn" type="button" onClick={() => void copyExample("session")} aria-label="Copy session API example">{copied === "session" ? <Check size={15} /> : <Copy size={15} />}{copied === "session" ? "Copied" : "Copy"}</button></div>
          <pre tabIndex={0} role="region" aria-label="Session API JavaScript example"><code>{sessionExample}</code></pre>
          <div className="build-code-foot"><ShieldCheck size={16} /><span>Keep the Archava key on your server. Return only the short lived participant token to your browser.</span></div>
        </div>
      </section>

      <section className="build-contract-note" aria-labelledby="contract-note-title" data-reveal>
        <div><span className="build-section-index">04 / CONTRACT INTERFACE</span><h2 id="contract-note-title">Minutes bought onchain</h2><p>The contract emits each wallet's purchased minutes and access expiry. Archava meters room time offchain and shares the remaining balance with the wallet and its API keys.</p></div>
        <div className="contract-code"><button className="code-copy-btn" type="button" onClick={() => void copyExample("contract")} aria-label="Copy contract interface">{copied === "contract" ? <Check size={15} /> : <Copy size={15} />}{copied === "contract" ? "Copied" : "Copy interface"}</button><pre tabIndex={0} role="region" aria-label="Minute pack contract interface"><code>{packAbi}</code></pre></div>
      </section>

      <footer className="build-footer"><a href="/"><ArrowLeft size={15} /> Back to Ava</a><span>ARCHAVA / HACKATHON BUILD · ONE AVATAR, LIVE VOICE</span></footer>
    </main>
  );
}
