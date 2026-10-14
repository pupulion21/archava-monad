import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Mic, MicOff, Minus, PhoneOff } from "lucide-react";

interface LiveCallDockProps {
  remaining: string;
  stateLabel: string;
  preview: boolean;
  minimized: boolean;
  muted: boolean;
  error: string;
  children: ReactNode;
  onToggleMinimized: () => void;
  onToggleMic: () => void;
  onEnd: () => void;
  audioAction?: ReactNode;
}

export function LiveCallDock({ remaining, stateLabel, preview, minimized, muted, error, children, onToggleMinimized, onToggleMic, onEnd, audioAction }: LiveCallDockProps) {
  const widgetRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const trigger = document.activeElement;
    const widget = widgetRef.current;
    widget?.focus({ preventScroll: true });
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected &&
          (document.activeElement === document.body || widget?.contains(document.activeElement))) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, []);

  return createPortal(
    <aside ref={widgetRef} id="live-avatar-room" tabIndex={-1} className={`live-call-dock${minimized ? " is-minimized" : ""}`} aria-label="Live conversation with Ava">
      <div className="call-dock-header">
        <div className="call-dock-title"><span className="live-dot" aria-hidden="true" /><div><h2>Ava</h2><span>{preview ? "Live preview" : "Paid conversation"}</span></div></div>
        <span className="call-dock-timer timer-digits" aria-label="Time remaining">{remaining}</span>
        <button type="button" className="call-dock-minimize" onClick={onToggleMinimized} aria-label={minimized ? "Expand avatar" : "Minimize avatar"} aria-expanded={!minimized} aria-controls="ava-floating-content">
          {minimized ? <Maximize2 size={17} /> : <Minus size={18} />}
        </button>
      </div>
      {/* Keep the renderer mounted while minimized: only its visibility changes. */}
      <div className="call-dock-content" id="ava-floating-content" aria-hidden={minimized}>{children}</div>
      <div className="call-dock-status" role="status" aria-live="polite"><span>{stateLabel}</span></div>
      <div className="call-dock-actions">
        <button type="button" onClick={onToggleMic} aria-label={muted ? "Unmute microphone" : "Mute microphone"} aria-pressed={!muted} className={`call-dock-mic mic-control-btn ${muted ? "muted" : "active"}`}>{muted ? <MicOff size={17} /> : <Mic size={17} />}<span>{muted ? "MUTED" : "MIC ON"}</span></button>
        {audioAction}
        <button type="button" onClick={onEnd} className="call-dock-end end-call-btn" aria-label="End conversation"><PhoneOff size={17} /><span>End call</span></button>
      </div>
      {error && <p className="call-dock-error" role="alert">{error}</p>}
    </aside>,
    document.body,
  );
}
