import { useCallback, useEffect, useRef, useState } from "react";
import { BriefcaseBusiness, KeyRound, Mic, Wallet, X } from "lucide-react";
import {
  connectWallet,
  endAvatarSession,
  getConfig,
  getPackQuote,
  getCreditStatus,
  buyMinutePack,
  claimDemoUsdt,
  waitForCreditSync,
  recoverPendingPurchase,
  startAnonymousPreview,
  startAvatarSession,
  type AppConfig,
  type AvatarSession,
  type PackQuote,
  type CreditStatus,
} from "./lib/rental";
import {
  MONAD_CHAIN_ID,
  subscribeWalletEvents,
  ensureMonadChain,
  getSelectedWallet,
  setSelectedWallet,
  disconnectWallet,
  getWalletEpoch,
  onSelectedWalletChange,
} from "./lib/wallet";
import { usePrivyController } from "./lib/privy";
import { operationController, type OperationLock } from "./lib/operationLock";
import {
  isPreviewAvailable,
  previewErrorMessage,
  supportsAvatarRendering,
  SPATIUS_UNSUPPORTED_MESSAGE,
} from "./lib/preview";
import { sounds } from "./lib/sound";
import { useScrollReveal } from "./lib/motion";
import { VideoHero } from "./components/VideoHero";
import { CyberMarquee } from "./components/CyberMarquee";
import { AvatarCatalog } from "./components/AvatarCatalog";
import { DigitalFrontierSection } from "./components/DigitalFrontierSection";
import { BusinessSection } from "./components/BusinessSection";
import { DeveloperAccess } from "./components/DeveloperAccess";
import { BuildPage } from "./components/BuildPage";
import { FeedbackToast } from "./components/FeedbackToast";

async function prepareAvatar(config: AppConfig | null): Promise<void> {
  if (config?.avatarProvider !== "spatius") return;
  const { prepareSpatiusAvatar } = await import("./lib/spatius");
  await prepareSpatiusAvatar(config.spatiusAppId || "", config.spatiusAvatarId || "");
}

export default function App() {
  useScrollReveal();
  const isBuildPage = window.location.pathname.replace(/\/$/, "") === "/build";
  const [config, setConfig] = useState<AppConfig | null>(null);
  const privy = usePrivyController();
  const [configStatus, setConfigStatus] = useState<"loading" | "ready" | "error">("loading");
  const [avatarStatus, setAvatarStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const configRequest = useRef(0);
  const avatarRequest = useRef(0);
  const [wallet, setWallet] = useState("");
  const [credits, setCredits] = useState<CreditStatus | null>(null);
  const [quote, setQuote] = useState<PackQuote | null>(null);
  const [selectedPack, setSelectedPack] = useState(60);
  const quoteRequest = useRef(0);
  const creditRequest = useRef(0);
  const [session, setSession] = useState<AvatarSession | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [developerOpen, setDeveloperOpen] = useState(false);
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const [txHash, setTxHash] = useState("");
  const [txKind, setTxKind] = useState<"purchase" | "faucet">("purchase");
  const [nextSteps, setNextSteps] = useState(false);
  const [lastCallPaid, setLastCallPaid] = useState(false);
  const [currentWalletEpoch, setCurrentWalletEpoch] = useState(() => getWalletEpoch());

  useEffect(() => {
    return onSelectedWalletChange((selected) => {
      setCurrentWalletEpoch(getWalletEpoch());
      if (!selected) {
        setWallet("");
        setCredits(null);
        setDeveloperOpen(false);
      } else if (selected.address) {
        setWallet(selected.address);
      }
    });
  }, []);

  // Synchronize wallet state when Privy authenticates
  useEffect(() => {
    if (privy.isConfigured && privy.authenticated && privy.walletAddress) {
      if (wallet.toLowerCase() !== privy.walletAddress.toLowerCase()) {
        setWallet(privy.walletAddress);
      }
    } else if (privy.isConfigured && !privy.authenticated && getSelectedWallet()?.type === "privy") {
      setWallet("");
      setCredits(null);
    }
  }, [privy.isConfigured, privy.authenticated, privy.walletAddress, wallet]);

  useEffect(() => {
    if (session) {
      setError("");
    }
  }, [session]);

  const loadConfig = useCallback(async () => {
    const request = ++configRequest.current;
    setConfigStatus("loading");
    setError("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const next = await getConfig(controller.signal);
      if (request !== configRequest.current) return;
      setConfig(next);
      setConfigStatus("ready");
    } catch {
      if (request !== configRequest.current) return;
      setConfig(null);
      setConfigStatus("error");
      setError("The live demo is temporarily offline. You can retry the connection or explore the page.");
    } finally {
      window.clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
    return () => { configRequest.current++; };
  }, [loadConfig]);

  useEffect(() => {
    let cancelled = false;
    // Don't auto-read window.ethereum if a wallet is already selected (e.g. Privy)
    if (getSelectedWallet()) return;
    // Reuse a wallet already authorized by its extension; never open a prompt on load.
    void window.ethereum?.request({ method: "eth_accounts" }).then((accounts) => {
      if (cancelled || !Array.isArray(accounts)) return;
      const address = accounts[0];
      if (typeof address === "string" && /^0x[a-fA-F0-9]{40}$/.test(address)) {
        if (!getSelectedWallet()) {
          setSelectedWallet({
            provider: window.ethereum!,
            address,
            type: "injected",
          });
          setWallet(address);
        }
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const warmAvatar = useCallback(async (appConfig: AppConfig | null) => {
    const request = ++avatarRequest.current;
    setAvatarStatus("loading");
    // prepareAvatar is bounded by the timeouts in lib/spatius.ts; without those it
    // could hang forever and leave avatarStatus stuck on "loading". Race it anyway
    // so a stuck warm never blocks a later, genuine attempt.
    const settled = Promise.race([
      prepareAvatar(appConfig),
      new Promise((_, reject) =>
        window.setTimeout(() => reject(new Error("Avatar preparation timed out. Try again.")), 60_000),
      ),
    ]);
    try {
      await settled;
      if (request === avatarRequest.current) setAvatarStatus("ready");
    } catch (cause) {
      if (request === avatarRequest.current) setAvatarStatus("error");
      throw cause;
    }
  }, []);

  useEffect(() => {
    // Keep the demo warm. Reading the integration guide never downloads the avatar.
    if (!isBuildPage && config && isPreviewAvailable(config) && supportsAvatarRendering(config)) {
      void warmAvatar(config).catch(() => {});
    }
  }, [isBuildPage, config, warmAvatar]);

  const refreshQuote = useCallback(() => {
    const request = ++quoteRequest.current;
    if (!isBuildPage || !config?.contractAddress) {
      setQuote(null);
      return;
    }
    setQuote(null);
    void getPackQuote(selectedPack).then((next) => {
      if (request === quoteRequest.current && next.minutes === selectedPack) setQuote(next);
    }).catch(() => { if (request === quoteRequest.current) setQuote(null); });
  }, [isBuildPage, config?.contractAddress, selectedPack]);

  useEffect(() => refreshQuote(), [refreshQuote]);

  const handleSelectPack = (minutes: number) => {
    if (!config?.packMinutes?.includes(minutes)) return;
    setQuote(null);
    setSelectedPack(minutes);
  };

  useEffect(() => {
    if (!session) return;
    const onPageHide = () => {
      navigator.sendBeacon(
        "/api/session/end",
        new Blob([JSON.stringify({ ticket: session.ticket })], { type: "application/json" })
      );
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [session]);

  const closeSession = useCallback(() => {
    const closing = sessionRef.current;
    if (!closing) return;
    sessionRef.current = null;
    sounds.playClick();
    setSession(null);
    setLastCallPaid(!closing.preview);
    // The call is over: offer the visitor one clear next step instead of
    // dropping them back into the catalog with no direction.
    setNextSteps(true);
    void endAvatarSession(closing.ticket)
      .then(() => { if (!closing.preview && wallet && config) void refreshCredits(wallet, config); })
      .catch(() => {});
    window.setTimeout(() => {
      document.getElementById("post-call-panel")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 120);
  }, [wallet, config]);

  const refreshCredits = useCallback(async (address: string, appConfig: AppConfig) => {
    const req = ++creditRequest.current;
    const currentEpoch = operationController.getEpoch();
    if (!appConfig.contractAddress) {
      setCredits(null);
      return;
    }
    try {
      const status = await getCreditStatus(address);
      if (req === creditRequest.current && operationController.getEpoch() === currentEpoch) {
        setCredits(status);
      }
    } catch (cause: any) {
      if (req === creditRequest.current && operationController.getEpoch() === currentEpoch) {
        setCredits(null);
        if (cause?.status === 503 || cause?.code === "credit_sync_unavailable") {
          setError("Credit scanner is currently indexing Monad Testnet blocks. Please retry in a few moments.");
        } else {
          setError(cause instanceof Error ? cause.message : "Failed to read minute balance");
        }
      }
    }
  }, []);

  useEffect(() => {
    if (!wallet || !config?.contractAddress) return;
    void refreshCredits(wallet, config);
    const onReturn = () => { if (!document.hidden) void refreshCredits(wallet, config); };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [wallet, config, refreshCredits]);

  useEffect(() => {
    return subscribeWalletEvents({
      onAccountsChanged(accounts) {
        operationController.invalidate("accountsChanged");
        creditRequest.current++;
        quoteRequest.current++;
        const currentLock = operationController.getCurrentLock();
        if (currentLock) currentLock.release();
        setLoading("");
        const next = accounts[0] || "";
        const currentSelected = getSelectedWallet();
        if (currentSelected && next) {
          setSelectedWallet({
            ...currentSelected,
            address: next,
          });
        } else if (!next) {
          disconnectWallet();
        }
        setWallet(next);
        setCredits(null);
        // Wallet-scoped dashboard state must not survive an account switch.
        setDeveloperOpen(false);
        setSession((current) => {
          if (current) void endAvatarSession(current.ticket).catch(() => {});
          return null;
        });
        setNextSteps(false);
        setTxHash("");
      },
      onChainChanged(newChainId) {
        operationController.invalidate("chainChanged");
        creditRequest.current++;
        quoteRequest.current++;
        if (newChainId !== MONAD_CHAIN_ID) {
          setError(`Please switch your wallet to Monad Testnet (${MONAD_CHAIN_ID}) to continue.`);
        } else {
          setError("");
        }
      },
      onDisconnect() {
        operationController.invalidate("disconnect");
        disconnectWallet();
        creditRequest.current++;
        quoteRequest.current++;
        const currentLock = operationController.getCurrentLock();
        if (currentLock) currentLock.release();
        setLoading("");
        setWallet("");
        setCredits(null);
        setDeveloperOpen(false);
        setSession((current) => {
          if (current) void endAvatarSession(current.ticket).catch(() => {});
          return null;
        });
        setNextSteps(false);
        setTxHash("");
      },
    });
  }, [currentWalletEpoch]);

  // Recover any unconfirmed pending purchases from local storage
  useEffect(() => {
    if (!wallet || !config?.contractAddress) return;
    const currentEpoch = operationController.getEpoch();
    const controller = new AbortController();

    void recoverPendingPurchase(wallet, { signal: controller.signal })
      .then((res) => {
        if (operationController.getEpoch() === currentEpoch && res.status === "completed" && res.credits) {
          setCredits(res.credits);
        }
      })
      .catch(() => {});

    return () => {
      controller.abort();
    };
  }, [wallet, config?.contractAddress]);

  const handleConnect = async () => {
    setError("");
    setLoading("connect");
    sounds.playClick();
    try {
      if (privy.isConfigured) {
        privy.login();
      } else {
        const address = await connectWallet();
        setWallet(address);
        sounds.playSuccess();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet connection rejected");
    } finally {
      setLoading("");
    }
  };

  const handleBuy = async () => {
    if (!config || !wallet || !quote) return;
    if (operationController.isLocked()) return;
    setError("");
    setTxHash("");
    setTxKind("purchase");
    setLoading("buy");
    sounds.playClick();

    let lock: OperationLock | null = null;
    try {
      // 1. Preparation phase: ensure wallet is switched to Monad Testnet FIRST.
      // Any chainChanged event during preparation will increment epoch before transaction lock is acquired.
      await ensureMonadChain();

      // 2. Lock operation with post-preparation epoch
      lock = operationController.acquire("buy", wallet);
      if (!lock) {
        setLoading("");
        return;
      }

      const hash = await buyMinutePack(config, selectedPack, wallet, {
        onSubmitted: ({ txHash: submittedHash, stage }) => {
          if (lock?.isActive() && stage === "rental") {
            setTxHash(submittedHash);
          }
        },
      });

      if (!lock.isActive()) return;
      setTxHash(hash);
      sounds.playSuccess();
      try {
        const synced = await waitForCreditSync(wallet, hash, { maxWaitMs: 45_000 });
        if (lock.isActive()) {
          setCredits(synced);
        }
      } catch (syncErr: any) {
        if (lock.isActive()) {
          setError(syncErr?.message || "Purchase confirmed on Monad Testnet! Minutes will appear shortly.");
          await refreshCredits(wallet, config);
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Minute-pack transaction failed");
    } finally {
      if (lock) {
        lock.release();
      }
      if (!operationController.isLocked()) {
        setLoading("");
      }
    }
  };

  const handleClaimFaucet = async () => {
    if (!config || !wallet) return;
    if (operationController.isLocked()) return;
    setError("");
    setTxHash("");
    setTxKind("faucet");
    setLoading("faucet");
    sounds.playClick();

    let lock: OperationLock | null = null;
    try {
      // 1. Preparation phase: switch chain before acquiring transaction lock
      await ensureMonadChain();

      // 2. Lock operation with post-preparation epoch
      lock = operationController.acquire("faucet", wallet);
      if (!lock) {
        setLoading("");
        return;
      }

      const hash = await claimDemoUsdt(config, wallet);
      if (!lock.isActive()) return;
      setTxHash(hash);
      sounds.playSuccess();
      await refreshCredits(wallet, config);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Demo mUSDT faucet failed");
    } finally {
      if (lock) {
        lock.release();
      }
      if (!operationController.isLocked()) {
        setLoading("");
      }
    }
  };

  const scrollToCatalog = useCallback(() => {
    document.getElementById(sessionRef.current ? "live-avatar-room" : "catalog-section")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "center" });
  }, []);

  const scrollToBusiness = useCallback(() => {
    document.getElementById("business-section")?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const handleStart = async () => {
    if (!wallet) return;
    setError("");
    setNextSteps(false);
    if (!supportsAvatarRendering(config)) {
      setError(SPATIUS_UNSUPPORTED_MESSAGE);
      return;
    }
    if (operationController.isLocked()) return;

    setLoading("session");
    sounds.playClick();

    let lock: OperationLock | null = null;
    try {
      // 1. Preparation phase: ensure Monad chain
      await ensureMonadChain();

      // 2. Lock operation
      lock = operationController.acquire("session", wallet);
      if (!lock) {
        setLoading("");
        return;
      }

      await warmAvatar(config);
      if (!lock.isActive()) return;

      const next = await startAvatarSession(wallet);
      if (!lock.isActive()) {
        // Discard session and end room on backend to avoid resource leak
        void endAvatarSession(next.ticket).catch(() => {});
        return;
      }
      setSession(next);
      sounds.playSuccess();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open neural session");
    } finally {
      if (lock) {
        lock.release();
      }
      if (!operationController.isLocked()) {
        setLoading("");
      }
    }
  };

  const handleTryPreview = async () => {
    console.log("[DEBUG handleTryPreview] called!", {
      previewAvailable,
      hasSession: Boolean(session),
      supportsRendering: supportsAvatarRendering(config),
      config,
    });
    if (!previewAvailable || session) {
      console.log("[DEBUG handleTryPreview] bailed out due to !previewAvailable || session", { previewAvailable, session });
      return;
    }
    setError("");
    setNextSteps(false);
    if (!supportsAvatarRendering(config)) {
      console.log("[DEBUG handleTryPreview] bailed out due to !supportsAvatarRendering");
      setError(SPATIUS_UNSUPPORTED_MESSAGE);
      scrollToCatalog();
      return;
    }
    // Set synchronously so a rapid second click cannot open a second room: the
    // disabled state must not wait for the first async tick to commit.
    if (operationController.isLocked()) return;
    const previewLock = operationController.acquire("preview", wallet || "guest");
    if (!previewLock) return;
    setLoading("preview");
    sounds.playClick();
    try {
      // Warm errors are no longer swallowed: an unsupported browser or a timed-out
      // SDK must reach the visitor instead of looking like a slow connection.
      const warmPromise = warmAvatar(config);
      const next = await startAnonymousPreview();
      setError("");
      setSession(next);
      sounds.playSuccess();
      window.setTimeout(scrollToCatalog, 80);
      await warmPromise;
    } catch (cause) {
      console.error("[App] Preview opening error:", cause);
      if (!sessionRef.current) {
        setError(previewErrorMessage(cause));
      }
      scrollToCatalog();
    } finally {
      previewLock.release();
      if (!operationController.isLocked()) {
        setLoading("");
      }
    }
  };

  const handleScrollToRent = () => {
    sounds.playClick();
    scrollToCatalog();
  };

  /**
   * The dashboard is wallet-authenticated but never gates the preview: it is a
   * separate surface that only appears once a wallet is connected.
   */
  const openDeveloper = useCallback(() => {
    if (!wallet) return;
    sounds.playClick();
    setError("");
    setDeveloperOpen(true);
  }, [wallet]);

  const closeDeveloper = useCallback(() => {
    sounds.playClick();
    setDeveloperOpen(false);
  }, []);

  const previewAvailable = isPreviewAvailable(config);
  const previewSupported = supportsAvatarRendering(config);
  const openingLabel = avatarStatus === "ready" ? "Connecting live room…" : "Preparing Ava…";
  const feedback = <FeedbackToast message={error} onDismiss={() => setError("")} onRetry={configStatus === "error" ? () => void loadConfig() : undefined} />;

  if (isBuildPage) {
    return (
      <div className="archava-site-root">
        <a className="skip-link" href="#top">Skip to main content</a>
        <BuildPage
          config={config}
          wallet={wallet}
          credits={credits}
          quote={quote}
          selectedPack={selectedPack}
          previewReady={previewAvailable && previewSupported}
          previewSupported={previewSupported}
          configStatus={configStatus}
          loading={loading}
          txHash={txHash}
          onConnect={handleConnect}
          onBuy={handleBuy}
          onClaimFaucet={handleClaimFaucet}
          txKind={txKind}
          onSelectPack={handleSelectPack}
          onRefreshQuote={refreshQuote}
          onOpenDeveloper={openDeveloper}
          onError={setError}
        />
        {feedback}
        {developerOpen && wallet && (
          <DeveloperAccess
            key={wallet.toLowerCase()}
            wallet={wallet}
            contractConnected={Boolean(config?.contractAddress)}
            onClose={closeDeveloper}
          />
        )}
      </div>
    );
  }

  return (
    <div className="archava-site-root">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <main id="main-content" tabIndex={-1}>
        <VideoHero
          wallet={wallet}
          configStatus={configStatus}
          previewSupported={previewSupported}
          previewSeconds={config?.previewSeconds}
          openingLabel={openingLabel}
          onCopyError={setError}
          onRentClick={handleScrollToRent}
          previewEnabled={previewAvailable && !session}
          sessionActive={Boolean(session)}
          previewLoading={loading === "preview"}
          onTryPreview={handleTryPreview}
          onOpenDeveloper={openDeveloper}
        />

        <CyberMarquee />

        <AvatarCatalog
          config={config}
          configStatus={configStatus}
          avatarStatus={avatarStatus}
          previewSupported={previewSupported}
          openingLabel={openingLabel}
          wallet={wallet}
          credits={credits}
          session={session}
          loading={loading}
          onConnect={handleConnect}
          onStartSession={handleStart}
          onTryPreview={handleTryPreview}
          onCloseSession={closeSession}
          onOpenDeveloper={openDeveloper}
          onRetryConfig={() => void loadConfig()}
        />

        {/*
          Shown only after a call ends, so every visitor — including one whose
          two minutes simply ran out — gets one clear next step instead of an
          unexplained return to the catalog.
        */}
        {nextSteps && !session && (
          <section className="post-call-panel" id="post-call-panel" aria-label="After your call">
            <div className="post-call-inner">
              <div className="post-call-head">
                <span className="post-call-eyebrow">CALL ENDED / WHAT NEXT</span>
                <button type="button" className="post-call-dismiss" onClick={() => setNextSteps(false)} aria-label="Dismiss next steps">
                  <X size={14} />
                </button>
              </div>
              <h2 className="post-call-title">Thanks for talking to Ava.</h2>
              <div className="post-call-actions">
                {lastCallPaid && wallet && credits?.active && credits.reservedSeconds === 0 ? (
                  <button
                    type="button"
                    className="post-call-btn primary"
                    onClick={() => { sounds.playClick(); void handleStart(); }}
                    disabled={!!loading}
                  >
                    <Mic size={15} /><span>{loading === "session" ? "Opening room…" : "Continue with your minutes"}</span>
                  </button>
                ) : lastCallPaid && config?.contractAddress ? (
                  <a className="post-call-btn primary" href="/build#access">
                    <Wallet size={15} /><span>Check balance or top up minutes</span>
                  </a>
                ) : previewAvailable && previewSupported ? (
                  <button
                    type="button"
                    className="post-call-btn primary"
                    onClick={() => { sounds.playClick(); void handleTryPreview(); }}
                    disabled={!!loading}
                  >
                    <Mic size={15} /><span>{loading === "preview" ? "Opening Archava…" : "Talk to Ava again"}</span>
                  </button>
                ) : (
                  <span className="post-call-unavailable">{previewSupported ? "The live preview is offline right now." : SPATIUS_UNSUPPORTED_MESSAGE}</span>
                )}
                <button
                  type="button"
                  className="post-call-btn"
                  onClick={() => { wallet ? openDeveloper() : handleConnect(); }}
                >
                  {wallet ? <KeyRound size={15} /> : <Wallet size={15} />}
                  <span>{wallet ? "Developer access · API keys" : "Connect wallet for developer access"}</span>
                </button>
                <button
                  type="button"
                  className="post-call-btn"
                  onClick={() => { sounds.playClick(); scrollToBusiness(); }}
                >
                  <BriefcaseBusiness size={15} /><span>For business · custom integration</span>
                </button>
              </div>
            </div>
          </section>
        )}

        <DigitalFrontierSection previewReady={previewAvailable && previewSupported} />
        <BusinessSection
          contactHref={import.meta.env.VITE_BUSINESS_CONTACT_URL || ""}
          previewEnabled={previewAvailable && previewSupported && !session}
          onTryPreview={handleTryPreview}
        />
      </main>
      {feedback}

      {/*
        `key={wallet}` remounts the dashboard on an account switch, so cached
        keys, the signed-in session, and any revealed secret cannot leak into
        the next wallet's view.
      */}
      {developerOpen && wallet && (
        <DeveloperAccess
          key={wallet.toLowerCase()}
          wallet={wallet}
          contractConnected={Boolean(config?.contractAddress)}
          onClose={closeDeveloper}
        />
      )}
    </div>
  );
}
