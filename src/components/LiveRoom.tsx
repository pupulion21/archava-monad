import { lazy, Suspense, useEffect, useState } from "react";
import { Shield } from "lucide-react";
import {
  isTrackReference,
  StartAudio,
  useLocalParticipant,
  useTracks,
  useVoiceAssistant,
  VideoTrack,
} from "@livekit/components-react";
import { Track } from "livekit-client";
import { type AvatarSession } from "../lib/rental";
import { sounds } from "../lib/sound";
import { SiteAwareness } from "./SiteAwareness";
import { LiveCallDock } from "./LiveCallDock";

const SpatiusAvatar = lazy(() => import("./SpatiusAvatar").then((module) => ({ default: module.SpatiusAvatar })));

interface LiveRoomProps {
  session: AvatarSession;
  minimized: boolean;
  onToggleMinimized: () => void;
  onClose: () => void;
}

const timeLeft = (seconds: number) => {
  const left = Math.max(0, seconds - Math.floor(Date.now() / 1000));
  return String(Math.floor(left / 60)).padStart(2, "0") + ":" + String(left % 60).padStart(2, "0");
};

/** Every LiveKit agent state, so a new SDK state cannot silently fall through. */
type AgentState = ReturnType<typeof useVoiceAssistant>["state"];

/** Motion class on the viewport. Each phase has its own CSS treatment. */
type CallPhase = "speaking" | "thinking" | "listening" | "standby" | "failed";

const CALL_PHASES: Record<AgentState, CallPhase> = {
  speaking: "speaking",
  thinking: "thinking",
  listening: "listening",
  idle: "standby",
  disconnected: "standby",
  "pre-connect-buffering": "standby",
  initializing: "standby",
  connecting: "standby",
  failed: "failed",
};

const STATE_LABELS: Record<AgentState, string> = {
  speaking: "AVA IS SPEAKING",
  thinking: "AVA IS THINKING",
  listening: "AVA IS LISTENING",
  idle: "AVA READY",
  disconnected: "CONNECTING AVA",
  "pre-connect-buffering": "CONNECTING AVA",
  initializing: "CONNECTING AVA",
  connecting: "CONNECTING AVA",
  failed: "AVA OFFLINE",
};

export function LiveRoom({ session, minimized, onToggleMinimized, onClose }: LiveRoomProps) {
  const tracks = useTracks([Track.Source.Camera]);
  const avatarTrack =
    tracks.find((item) => isTrackReference(item) && item.participant.identity === "tavus-avatar-agent") ??
    tracks.find((item) => isTrackReference(item) && item.participant.isAgent);

  const { state } = useVoiceAssistant();
  const { localParticipant } = useLocalParticipant();
  const [remaining, setRemaining] = useState(timeLeft(session.endsAt));
  const [micError, setMicError] = useState("");
  const isMuted = !localParticipant?.isMicrophoneEnabled;
  const callPhase: CallPhase = CALL_PHASES[state];
  const stateLabel = STATE_LABELS[state];

  useEffect(() => {
    const timer = window.setInterval(() => {
      setRemaining(timeLeft(session.endsAt));
      if (session.endsAt <= Math.floor(Date.now() / 1000)) {
        onClose();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [session.endsAt, onClose]);

  const toggleMic = async () => {
    try {
      sounds.playClick();
      setMicError("");
      const targetState = !localParticipant.isMicrophoneEnabled;
      await localParticipant.setMicrophoneEnabled(targetState);
    } catch {
      setMicError("Microphone permission required for conversation.");
    }
  };

  const handleEnd = () => {
    sounds.playClick();
    onClose();
  };

  return (
    <LiveCallDock
      remaining={remaining}
      stateLabel={stateLabel}
      preview={Boolean(session.preview)}
      minimized={minimized}
      muted={isMuted}
      error={micError}
      onToggleMinimized={onToggleMinimized}
      onToggleMic={() => void toggleMic()}
      onEnd={handleEnd}
      audioAction={<StartAudio label="Allow audio" className="call-dock-audio" />}
    >
      {/* Main Video Viewport with HUD Brackets */}
      <div className={`live-video-viewport call-phase-${callPhase}`}>
        {/* Corner HUD Reticles */}
        <div className="hud-corner-bracket top-left" />
        <div className="hud-corner-bracket top-right" />
        <div className="hud-corner-bracket bottom-left" />
        <div className="hud-corner-bracket bottom-right" />

        {session.avatarProvider === "spatius" ? (
          <Suspense fallback={<div className="avatar-connecting-screen">Loading avatar renderer…</div>}>
            <SpatiusAvatar session={session} />
          </Suspense>
        ) : avatarTrack && isTrackReference(avatarTrack) ? (
          <VideoTrack trackRef={avatarTrack} className="avatar-video-feed" />
        ) : (
          <div className="avatar-connecting-screen">
            <div className="connecting-radar">
              <div className="radar-circle-1" />
              <div className="radar-circle-2" />
              <div className="radar-sweep" />
              <span className="brand-mark brand-mark-small">
                <span className="brand-mark-cut" />
              </span>
            </div>
            <h3 className="connecting-title">BRINGING AVA ONLINE</h3>
            <p className="connecting-sub">Connecting avatar video and realtime voice…</p>
            <div className="connecting-tags">
              <span>LIVEKIT ROOM</span>
              <span>AI-GENERATED AVATAR</span>
            </div>
          </div>
        )}

        <div className="live-call-motion" aria-hidden="true" data-active={callPhase}>
          <span className="call-scan-beam" />
          <span className="call-orbit"><span /><span /><span /><i /></span>
          <span className="call-signal-caption">ARCHAVA / LIVE PRESENCE</span>
        </div>
      </div>

      <div className="live-guide-row">
        <SiteAwareness />
      </div>

      <div className="live-footer-note">
        <span><Shield size={11} /> {session.preview ? "Free preview · AI-generated avatar" : "Paid conversation · AI-generated avatar"}</span>
      </div>
    </LiveCallDock>
  );
}
