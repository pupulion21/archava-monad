import { AvatarManager, AvatarSDK, DrivingServiceMode, type Avatar } from "@spatius/avatarkit";

/**
 * Bounded waits. The avatar pipeline is a chain of network fetches (SDK bootstrap,
 * avatar metadata, mesh/texture assets, WASM compile). Any of them can hang
 * without rejecting, which would leave "Preparing Ava" up forever, so each stage
 * races against a deadline instead of awaiting blindly.
 */
export const SDK_INIT_TIMEOUT_MS = 30_000;
export const AVATAR_LOAD_TIMEOUT_MS = 45_000;

/** Distinct error classes so the UI can tell a hang from a browser-support failure. */
export class SpatiusTimeoutError extends Error {
  constructor(stage: string, timeoutMs: number) {
    super(`The avatar service did not respond in time (${stage}, ${Math.round(timeoutMs / 1000)}s). Check your connection and try again.`);
    this.name = "SpatiusTimeoutError";
  }
}

export class SpatiusUnsupportedError extends Error {
  constructor() {
    super("This browser cannot display the Spatius avatar. Try a recent Chrome or Edge browser.");
    this.name = "SpatiusUnsupportedError";
  }
}

export class SpatiusConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpatiusConfigError";
  }
}

let initializedAppId = "";
let initialization: Promise<void> | null = null;
const avatars = new Map<string, Promise<Avatar>>();

/** Race a promise against a deadline. A hang becomes a SpatiusTimeoutError. */
function withTimeout<T>(stage: string, work: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      onTimeout?.();
      reject(new SpatiusTimeoutError(stage, timeoutMs));
    }, timeoutMs);
    work.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error) => { window.clearTimeout(timer); reject(error); },
    );
  });
}

export async function prepareSpatiusAvatar(appId: string, avatarId: string): Promise<Avatar> {
  if (!("RTCRtpScriptTransform" in globalThis)) throw new SpatiusUnsupportedError();
  if (!appId || !avatarId) throw new SpatiusConfigError("Spatius avatar configuration is missing.");
  if (initializedAppId && initializedAppId !== appId) {
    throw new SpatiusConfigError("The Spatius application changed. Reload this page to continue.");
  }

  if (!initialization) {
    initializedAppId = appId;
    // A hung init poisons every later caller that awaits the same singleton, so
    // drop it on timeout as well as on rejection.
    initialization = withTimeout("avatar sdk", AvatarSDK.initialize(appId, { drivingServiceMode: DrivingServiceMode.rtc }), SDK_INIT_TIMEOUT_MS, () => {
      initializedAppId = "";
    }).catch((error: unknown) => {
      initialization = null;
      initializedAppId = "";
      throw error;
    });
  }
  await initialization;

  let loading = avatars.get(avatarId);
  if (!loading) {
    loading = withTimeout("avatar assets", AvatarManager.shared.load(avatarId), AVATAR_LOAD_TIMEOUT_MS, () => {
      avatars.delete(avatarId);
    }).catch((error: unknown) => {
      avatars.delete(avatarId);
      throw error;
    });
    avatars.set(avatarId, loading);
  }
  return loading;
}

/** Drop cached state. Used when the caller gives up so a later attempt starts clean. */
export function forgetSpatiusAvatar(avatarId: string): void {
  avatars.delete(avatarId);
}
