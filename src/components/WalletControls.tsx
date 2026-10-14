import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Copy, LogOut, Wallet } from "lucide-react";
import { sounds } from "../lib/sound";

interface WalletControlsProps {
  wallet: string;
  authenticated: boolean;
  privyConfigured: boolean;
  ready: boolean;
  action: "connect" | "disconnect" | "";
  onConnect: () => void;
  onDisconnect: () => void;
  onError: (message: string) => void;
}

export function WalletControls({ wallet, authenticated, privyConfigured, ready, action, onConnect, onDisconnect, onError }: WalletControlsProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const copyTimer = useRef(0);
  useEffect(() => {
    setOpen(false);
    setCopied(false);
    return () => window.clearTimeout(copyTimer.current);
  }, [wallet, authenticated]);

  useEffect(() => {
    if (!open) return;
    firstActionRef.current?.focus({ preventScroll: true });
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  const copyWallet = async () => {
    try {
      await navigator.clipboard.writeText(wallet);
      setCopied(true);
      sounds.playSuccess();
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      onError("Couldn't copy the wallet address. Please allow clipboard access and try again.");
    }
  };

  return (
    <div
      ref={containerRef}
      className="wallet-controls"
      role="group"
      aria-label="Wallet account"
      onBlur={event => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={event => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus({ preventScroll: true });
        }
      }}
    >
      {wallet || authenticated || action === "disconnect" ? (
        <>
          <button
            ref={triggerRef}
            type="button"
            className="hero-wallet-pill"
            onClick={() => setOpen(value => !value)}
            onKeyDown={event => {
              if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); }
            }}
            aria-label="Wallet account options"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            disabled={Boolean(action)}
          >
            <span className="live-dot" aria-hidden="true" />
            <span className="mono-addr">{action === "disconnect" ? "Disconnecting…" : wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "Account"}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
          {open && (
            <div id={menuId} className="wallet-menu" role="dialog" aria-label="Wallet options">
              <div className="wallet-menu-header">
                <span>{wallet ? "Connected wallet" : "Preparing wallet…"}</span>
                {wallet && <p className="wallet-menu-address">{wallet}</p>}
              </div>
              {wallet && (
                <button ref={firstActionRef} type="button" className="wallet-menu-option" onClick={() => void copyWallet()} aria-label="Copy wallet address">
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                  <span role="status">{copied ? "Copied" : "Copy address"}</span>
                </button>
              )}
              <button
                ref={wallet ? undefined : firstActionRef}
                type="button"
                className="wallet-menu-option"
                onClick={() => { setOpen(false); onDisconnect(); }}
                disabled={Boolean(action)}
              >
                <LogOut size={16} />
                <span>Disconnect</span>
              </button>
            </div>
          )}
        </>
      ) : (
        <button type="button" className="hero-connect-pill" onClick={onConnect} disabled={!ready || Boolean(action)}>
          <Wallet size={15} />
          <span>{!ready ? "Loading wallet…" : action === "connect" ? "Connecting…" : privyConfigured ? "Log in / Connect" : "Connect wallet"}</span>
        </button>
      )}
    </div>
  );
}
