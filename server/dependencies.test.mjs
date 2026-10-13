import assert from "node:assert/strict";
import test from "node:test";
import { createDependencies } from "./dependencies.mjs";
import { RuntimeValidationError } from "./runtime-target.mjs";

const isolatedRuntimeFixture = {
  valid: true,
  deployment: "monad",
  network: "monadTestnet",
  chainId: 10143,
  networkConfig: { chainId: 10143, blockExplorer: { url: "https://testnet.monadscan.com" } },
  deploymentTargets: {
    deployment: "monad",
    network: { chainId: 10143 },
    hosting: {
      frontend: { provider: "vercel", projectId: "prj_test" },
      backend: { provider: "railway", projectId: "p1", environmentId: "e1", serviceId: "s1" }
    },
    livekit: { url: "wss://archava-monad.livekit.cloud", projectScope: "archava-monad", agentName: "archava-monad-host" },
    state: { directory: "./data", scope: "monad" }
  },
  livekitUrl: "wss://archava-monad.livekit.cloud",
  agentName: "archava-monad-host",
  deploymentId: "archava-monad",
};

test("createDependencies fails closed when runtime is locked and no fixture injected", () => {
  assert.throws(
    () => createDependencies({ env: { ARCHAVA_RUNTIME_ENABLED: "false" } }),
    (err) => err instanceof RuntimeValidationError && err.message.includes("Runtime startup is locked")
  );
});

test("production dashboard cookie works on local HTTP and is Secure on HTTPS with isolated fixture", () => {
  const local = createDependencies({
    env: { WEB_ORIGIN: "http://localhost:5002", AVATAR_PROVIDER: "tavus" },
    runtimeConfig: isolatedRuntimeFixture,
  });
  const publicHost = createDependencies({
    env: { WEB_ORIGIN: "https://archava.example", AVATAR_PROVIDER: "tavus" },
    runtimeConfig: isolatedRuntimeFixture,
  });
  const localCookie = local.dashboardSessions.issue("0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC").cookie;
  const publicCookie = publicHost.dashboardSessions.issue("0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC").cookie;
  assert.doesNotMatch(localCookie, /; Secure(?:;|$)/);
  assert.match(publicCookie, /; Secure(?:;|$)/);
  assert.match(localCookie, /HttpOnly/);
  assert.match(publicCookie, /SameSite=Strict/);
});
