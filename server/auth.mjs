import { randomBytes } from "node:crypto";
import { verifyMessage } from "ethers";
import { normalizeWallet } from "./rental.mjs";

export function createChallengeStore({
  origin,
  ttlMs = 5 * 60_000,
  purpose,
  chainId,
  deploymentId,
  contractAddress,
  now = Date.now,
} = {}) {
  const pending = new Map();
  // The paid browser flow keeps its original wording; the dashboard binds a
  // different purpose so a signature for one can never be replayed at the other.
  const headline = purpose || "Archava session access";

  function issue(wallet) {
    const address = normalizeWallet(wallet);
    const nonce = randomBytes(16).toString("hex");
    const lines = [
      headline,
      "Wallet: " + address,
    ];
    if (chainId) {
      lines.push("Chain ID: " + Number(chainId));
    }
    if (deploymentId) {
      lines.push("Deployment: " + String(deploymentId));
    }
    if (contractAddress) {
      lines.push("Contract: " + normalizeWallet(contractAddress));
    }
    lines.push(
      "Origin: " + origin,
      "Nonce: " + nonce,
      "Issued: " + new Date(now()).toISOString(),
      "Sign this message to prove wallet ownership. This does not submit a transaction."
    );
    const message = lines.join("\n");
    pending.set(nonce, { wallet: address, message, expires: now() + ttlMs });
    return { nonce, message };
  }

  function consume({ wallet, nonce, signature }) {
    if (typeof nonce !== "string" || typeof signature !== "string") return false;
    let expectedWallet;
    try {
      expectedWallet = normalizeWallet(wallet);
    } catch {
      return false;
    }
    const challenge = pending.get(nonce);
    pending.delete(nonce);
    if (!challenge || challenge.expires < now() || challenge.wallet !== expectedWallet) return false;
    try {
      return normalizeWallet(verifyMessage(challenge.message, signature)) === expectedWallet;
    } catch {
      return false;
    }
  }

  function prune() {
    for (const [nonce, challenge] of pending) {
      if (challenge.expires < now()) pending.delete(nonce);
    }
  }

  return { issue, consume, prune };
}
