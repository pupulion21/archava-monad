// Track preparation policy without fetching the model or contacting a provider.
export const AVATAR_LOAD_TIMEOUT_MS = 45_000;

export class SpatiusTimeoutError extends Error {
  constructor(stage = "avatar", timeoutMs = 45000) {
    super(`The avatar service did not respond in time (${stage}, ${Math.round(timeoutMs / 1000)}s).`);
    this.name = "SpatiusTimeoutError";
  }
}

export class SpatiusUnsupportedError extends Error {
  constructor() {
    super("This browser cannot display the Spatius avatar.");
    this.name = "SpatiusUnsupportedError";
  }
}

export function forgetSpatiusAvatar(_avatarId?: string): void {}

export async function prepareSpatiusAvatar() {
  const response = await fetch("/__ui/avatar-preparation");
  if (!response.ok) throw new Error("Simulated avatar preparation failure");
  return {};
}

