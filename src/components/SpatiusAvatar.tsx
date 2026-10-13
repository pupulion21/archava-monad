import { useEffect, useRef, useState } from "react";
import { useRoomContext } from "@livekit/components-react";
import { AvatarView } from "@spatius/avatarkit";
import { AvatarPlayer, LiveKitProvider } from "@spatius/avatarkit-rtc";
import { type AvatarSession } from "../lib/rental";
import {
  AVATAR_LOAD_TIMEOUT_MS,
  forgetSpatiusAvatar,
  prepareSpatiusAvatar,
  SpatiusTimeoutError,
  SpatiusUnsupportedError,
} from "../lib/spatius";

interface SpatiusAvatarProps {
  session: AvatarSession;
}

/**
 * Bounded waits for the room side too. LiveKit signalling can stall on a
 * reachable-but-unresponsive SFU, and that must not read as "connecting" forever.
 */
const ROOM_CONNECT_TIMEOUT_MS = 30_000;
/**
 * onFirstRendering is the SDK's only "the avatar is on screen" signal, and it can
 * stay silent on a lost WebGL context or a throttled background tab. Treat its
 * absence after the asset budget as a failure rather than an endless spinner.
 */
const FIRST_RENDER_GRACE_MS = AVATAR_LOAD_TIMEOUT_MS + 15_000;

function describeError(cause: unknown): string {
  if (cause instanceof SpatiusUnsupportedError) return cause.message;
  if (cause instanceof SpatiusTimeoutError) return cause.message;
  if (cause instanceof Error && cause.message) return cause.message;
  return "Could not display the Spatius avatar.";
}

export function SpatiusAvatar({ session }: SpatiusAvatarProps) {
  const room = useRoomContext();
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Disposal has to work even when start() is still mid-flight: the cleanup
    // below runs unconditionally and every awaited step re-checks `cancelled`.
    let cancelled = false;
    let disposed = false;
    let connected = false;
    let view: AvatarView | undefined;
    let player: AvatarPlayer | undefined;
    const timers: number[] = [];
    const clearTimers = () => { for (const t of timers) window.clearTimeout(t); timers.length = 0; };

    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      clearTimers();
      // Detach first: it stops the RTC pipeline that the view's renderer feeds.
      try { await player?.detach(); } catch { /* already detached */ }
      if (connected || room.state !== "disconnected") {
        try { await room.disconnect(); } catch { /* already left */ }
      }
      try { view?.dispose(); } catch { /* renderer already gone */ }
      if (containerRef.current) {
        try { containerRef.current.replaceChildren(); } catch { /* ignore */ }
      }
      view = undefined;
      player = undefined;
    };

    const start = async () => {
      const avatar = await prepareSpatiusAvatar(session.spatiusAppId || "", session.spatiusAvatarId || "");
      if (cancelled || !containerRef.current) return;
      // A StrictMode remount can have re-rendered into this container between the
      // feature checks; own it before attaching the renderer.
      containerRef.current.replaceChildren();
      view = new AvatarView(avatar, containerRef.current);
      view.onFirstRendering = () => {
        clearTimers();
        if (!cancelled && !disposed) setReady(true);
      };
      // Bound the silent case where rendering never reports success.
      timers.push(window.setTimeout(() => {
        if (!cancelled && !disposed) {
          setError("The avatar is taking longer than expected to render. Retry, or continue with voice only.");
        }
      }, FIRST_RENDER_GRACE_MS));

      player = new AvatarPlayer(new LiveKitProvider(), view);
      await player.attach(room);
      if (cancelled || disposed) {
        await dispose();
        return;
      }

      // Race the connect so a stalled SFU surfaces instead of hanging on CONNECTING AVA.
      let roomConnected = false;
      try {
        await Promise.race([
          room.connect(session.serverUrl, session.token),
          new Promise((_, reject) => {
            timers.push(window.setTimeout(() => reject(new SpatiusTimeoutError("live room", ROOM_CONNECT_TIMEOUT_MS)), ROOM_CONNECT_TIMEOUT_MS));
          }),
        ]);
        roomConnected = true;
        connected = true;
      } catch (connectError) {
        if (cancelled || disposed) return;
        throw connectError;
      }

      if (cancelled || disposed) {
        if (roomConnected || room.state !== "disconnected") {
          try { await room.disconnect(); } catch {}
        }
        await dispose();
        return;
      }

      // The mic is best-effort: a denied permission must not kill the call.
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
      } catch (micError) {
        console.warn("Could not auto-enable microphone:", micError);
      }
    };

    void start().then(
      () => { if (cancelled) void dispose(); },
      async (cause: unknown) => {
        await dispose();
        if (!cancelled) setError(describeError(cause));
      },
    );

    return () => {
      cancelled = true;
      void dispose();
    };
  }, [room, session.serverUrl, session.token, session.spatiusAppId, session.spatiusAvatarId, attempt]);

  const retry = () => {
    setError("");
    setReady(false);
    forgetSpatiusAvatar(session.spatiusAvatarId || "");
    setAttempt((current) => current + 1);
  };

  return (
    <div className="spatius-avatar-surface">
      <div className="spatius-avatar-canvas" ref={containerRef} />
      {(!ready || error) && (
        <div className="spatius-avatar-status" role={error ? "alert" : "status"}>
          <span className="live-pulse-dot" />
          <span>{error || "Preparing Ava's live avatar…"}</span>
          {error && (
            <button type="button" className="spatius-retry-btn" onClick={retry}>
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}
