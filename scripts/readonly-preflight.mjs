/** Public GET requests only. Never loads env, signs, opens rooms, or transacts. */
import assert from "node:assert/strict";

const args = process.argv.slice(2);
let origin = null;

// Origin is required - no default to BNB deployment
try {
  if (args.length) {
    assert.equal(args.length, 2);
    assert.equal(args[0], "--origin");
    origin = args[1];
  }
  
  if (!origin) {
    throw new Error("Origin is required");
  }
  
  const target = new URL(origin);
  assert.ok(["https:", "http:"].includes(target.protocol));
  assert.ok(!target.username && !target.password && !target.search && !target.hash && target.pathname === "/");
  origin = target.origin;
} catch (error) {
  console.error("Usage: npm run preflight:readonly -- --origin https://your-monad-site.example");
  console.error("Note: Origin is required. No default is provided.");
  process.exit(1);
}

async function get(path, json = true) {
  const response = await fetch(origin + path, { signal: AbortSignal.timeout(15000), redirect: "error" });
  assert.equal(response.status, 200, `${path} returned HTTP ${response.status}`);
  return json ? response.json() : response.text();
}

try {
  const health = await get("/api/health");
  assert.equal(health.ok, true);
  const ready = await get("/api/ready");
  assert.equal(ready.ok, true);
  assert.equal(ready.checks?.worker, "ok", "Production worker health is not configured or unavailable");
  const config = await get("/api/config");
  assert.equal(config.livekitReady, true);
  assert.ok(["spatius", "tavus"].includes(config.avatarProvider));
  if (config.avatarProvider === "spatius") assert.ok(config.spatiusAppId && config.spatiusAvatarId);
  
  // Monad Testnet validation - expect chain ID 10143
  if (config.contractAddress) {
    assert.equal(config.chainId, 10143, "Expected Monad Testnet chain ID 10143");
    assert.deepEqual(config.packMinutes, [60, 300]);
    for (const minutes of config.packMinutes) {
      const quote = await get(`/api/quote?minutes=${minutes}`);
      assert.equal(quote.minutes, minutes);
      assert.equal(quote.symbol, "mUSDT");
      assert.ok(Number(quote.tokenAmount) > 0);
    }
  }
  
  const html = await get("/", false), build = await get("/build", false);
  assert.match(html, /<title>[^<]*Archava/i, "Home is not the Archava application");
  const script = source => source.match(/<script[^>]*src="(\/assets\/[^\"]+\.js)"/)?.[1];
  assert.ok(script(html), "Home is not the built Archava application");
  assert.equal(script(html), script(build), "Home and Build have different frontend artifacts");
  
  console.log(JSON.stringify({ 
    mode: "READ ONLY; NO ROOMS OR TRANSACTIONS", 
    origin,
    deployment: "monad-testnet",
    expectedChainId: 10143,
    actualChainId: config.chainId,
    api: "ok", 
    workerHealth: "ok", 
    provider: config.avatarProvider,
    previewEnabled: config.previewEnabled, 
    previewSeconds: config.previewSeconds,
    testnetQuotes: config.contractAddress ? "ok" : "not_configured", 
    frontendRoutes: "ok" 
  }, null, 2));
  
  console.log("PASS public deployment checks. A real microphone/voice call remains a separate check.");
} catch (error) {
  // Fetch/provider errors can include URLs and credentials; print assertion text only.
  console.error("FAIL public preflight: check API/worker readiness, public config, testnet quotes, and frontend routes.");
  console.error("Error:", error.message);
  process.exitCode = 1;
}
