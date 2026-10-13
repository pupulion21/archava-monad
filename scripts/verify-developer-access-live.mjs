import assert from "node:assert/strict";
import { Wallet } from "ethers";

const API_BASE = "http://localhost:5002";

async function verifyDeveloperAccess() {
  console.log("=== Verifying Developer Access & API Key Flow ===");

  const wallet = Wallet.createRandom();
  console.log("1. Generated test developer wallet:", wallet.address);

  // 1. Request developer challenge
  console.log("2. Requesting developer dashboard challenge...");
  const challengeRes = await fetch(`${API_BASE}/api/developer/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost:5174" },
    body: JSON.stringify({ wallet: wallet.address }),
  });
  assert.equal(challengeRes.status, 200, "Developer challenge failed");
  const challengeData = await challengeRes.json();
  assert.ok(challengeData.message.includes("Archava developer dashboard access"));
  assert.ok(challengeData.message.includes("Chain ID: 10143"));
  assert.ok(challengeData.message.includes("Deployment: archava-monad"));
  console.log("✓ Challenge received with valid Monad Testnet binding");

  // 2. Sign challenge message
  console.log("3. Signing challenge message with EOA wallet...");
  const signature = await wallet.signMessage(challengeData.message);

  // 3. Login to developer dashboard
  console.log("4. Logging in to developer dashboard...");
  const loginRes = await fetch(`${API_BASE}/api/developer/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost:5174" },
    body: JSON.stringify({
      wallet: wallet.address,
      nonce: challengeData.nonce,
      signature,
    }),
  });
  assert.equal(loginRes.status, 200, "Developer login failed");
  const cookieHeader = loginRes.headers.get("set-cookie");
  assert.ok(cookieHeader, "Missing set-cookie in developer login response");
  const cookie = cookieHeader.split(";")[0];
  console.log("✓ Developer session established, dashboard cookie issued");

  // 4. Issue a new API key
  console.log("5. Issuing new customer API key...");
  const issueRes = await fetch(`${API_BASE}/api/developer/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost:5174", cookie },
    body: JSON.stringify({ label: "live-verification-key" }),
  });
  assert.equal(issueRes.status, 201, "API key issuance failed");
  const keyData = await issueRes.json();
  assert.ok(keyData.apiKey, "Missing apiKey secret in issuance response");
  assert.ok(keyData.id, "Missing key ID in issuance response");
  assert.equal(keyData.label, "live-verification-key");
  console.log("✓ API key successfully issued, ID:", keyData.id);

  // 5. List keys and ensure secret is not leaked in list
  console.log("6. Listing developer keys...");
  const listRes = await fetch(`${API_BASE}/api/developer/keys`, {
    method: "GET",
    headers: { origin: "http://localhost:5174", cookie },
  });
  assert.equal(listRes.status, 200);
  const keysList = await listRes.json();
  assert.ok(Array.isArray(keysList.keys));
  const found = keysList.keys.find((k) => k.id === keyData.id);
  assert.ok(found, "Issued key not found in key list");
  assert.equal(found.apiKey, undefined, "Secret apiKey must never leak in list endpoint");
  console.log("✓ Key list verified; secret key is masked and not exposed");

  // 6. Test /v1/usage with bearer API key
  console.log("7. Querying /v1/usage using bearer key...");
  const usageRes = await fetch(`${API_BASE}/v1/usage`, {
    method: "GET",
    headers: { Authorization: `Bearer ${keyData.apiKey}` },
  });
  assert.equal(usageRes.status, 200);
  const usageData = await usageRes.json();
  console.log("Usage response:", usageData);
  assert.equal(usageData.active, false);
  console.log("✓ /v1/usage authenticated and returned valid scoped usage");

  // 7. Revoke API key via documented POST /api/developer/keys/:id/revoke
  console.log("8. Revoking API key...");
  const revokeRes = await fetch(`${API_BASE}/api/developer/keys/${encodeURIComponent(keyData.id)}/revoke`, {
    method: "POST",
    headers: { origin: "http://localhost:5174", cookie },
  });
  assert.equal(revokeRes.status, 200, "Key revocation failed");
  console.log("✓ API key successfully revoked");

  // 8. Verify revoked key can no longer access /v1/usage
  console.log("9. Verifying revoked key is rejected...");
  const postRevokeRes = await fetch(`${API_BASE}/v1/usage`, {
    method: "GET",
    headers: { Authorization: `Bearer ${keyData.apiKey}` },
  });
  assert.equal(postRevokeRes.status, 401, "Revoked key should be rejected with 401");
  console.log("✓ Revoked API key correctly rejected with 401 Unauthorized");

  console.log("\n==========================================");
  console.log("✓ DEVELOPER ACCESS VERIFICATION PASSED!");
  console.log("==========================================\n");
}

await verifyDeveloperAccess();
