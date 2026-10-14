import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = process.env.ARCHAVA_UI_ARTIFACTS || path.join(root, ".tmp-test/ui");
await mkdir(artifacts, { recursive: true });
const server = await createServer({
  root, configFile: false, logLevel: "error", plugins: [react()],
  cacheDir: path.join(artifacts, "vite-cache"),
  envDir: path.join(root, "tests/ui"),
  define: { "import.meta.env.VITE_PRIVY_APP_ID": '(globalThis.__ARCHAVA_UI_PRIVY ? "ui-fixture" : "")' },
  resolve: { alias: [
    { find: "@privy-io/react-auth", replacement: path.join(root, "tests/ui/privy-fixture.tsx") },
    { find: "@livekit/components-react", replacement: path.join(root, "tests/ui/livekit-fixture.tsx") },
    { find: /^\.{1,2}\/lib\/spatius$/, replacement: path.join(root, "tests/ui/spatius-fixture.ts") },
  ] },
  server: { host: "127.0.0.1", port: 0 },
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({executablePath: process.env.ARCHAVA_BROWSER_EXECUTABLE || chromium.executablePath(), args: ["--no-sandbox"]});
const baseConfig = {
  chainId: 10143, contractAddress: "0x1111111111111111111111111111111111111111",
  paymentTokenAddress: "0x2222222222222222222222222222222222222222",
  livekitReady: true, avatarProvider: "tavus", previewEnabled: true,
  previewSeconds: 120, packMinutes: [60, 300],
};
const results = [];

async function check(name, options, run) {
  const context = await browser.newContext({viewport: {width: options.width || 1440, height: options.height || 900}, reducedMotion: "reduce"});
  if (options.privy) await context.addInitScript(privy => {
    window.__ARCHAVA_UI_PRIVY = { ...privy, loginCalls: 0, logoutCalls: 0, providerRequests: 0, providerMethods: [] };
  }, options.privy);
  if (options.unsupported) await context.addInitScript(() => Reflect.deleteProperty(globalThis, "RTCRtpScriptTransform"));
  if (options.wallet) await context.addInitScript(({ restored, paidSession }) => {
    let authorized = restored;
    const listeners = new Map();
    window.__ARCHAVA_UI_WALLET_REQUESTS = [];
    window.__ARCHAVA_UI_WALLET_EMIT = (event, payload) => listeners.get(event)?.forEach(listener => listener(payload));
    window.ethereum = {
      async request({method}) {
        window.__ARCHAVA_UI_WALLET_REQUESTS.push(method);
        if (method === "eth_requestAccounts") authorized = true;
        if (method === "eth_accounts" || method === "eth_requestAccounts") return authorized ? ["0x1111111111111111111111111111111111111111"] : [];
        if (method === "eth_chainId") return "0x279f";
        if (method === "personal_sign" && paidSession) return "0xdeadbeef";
        throw new Error("UI fixture does not sign or transact");
      },
      on(event, listener) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(listener); },
      removeListener(event, listener) { listeners.get(event)?.delete(listener); },
    };
  }, { restored: Boolean(options.restored), paidSession: Boolean(options.paidSession) });
  const page = await context.newPage();
  const errors = [];
  const state = { configRequests: 0, previewRequests: 0, endRequests: 0, preparations: 0, developerLogins: 0, developerLogouts: 0, offline: Boolean(options.offline), preparationFailure: false };
  page.on("pageerror", error => errors.push(error.message));
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { await route.abort(); return; }
    const json = async (value, status = 200) => route.fulfill({status, contentType: "application/json", body: JSON.stringify(value)});
    if (url.pathname === "/api/config") {
      state.configRequests++;
      if (options.configDelay) await new Promise(resolve => setTimeout(resolve, options.configDelay));
      await json(state.offline ? {error: "Simulated offline"} : {...baseConfig, ...options.config}, state.offline ? 503 : 200);
    } else if (url.pathname === "/api/quote") {
      const minutes = Number(url.searchParams.get("minutes"));
      await json({minutes, wei: "5000000000000000000", tokenAmount: minutes === 300 ? "20" : "5", symbol: "mUSDT"});
    } else if (url.pathname === "/api/access") {
      await json({active: true, remainingSeconds: 3600, purchasedMinutes: 60, usedSeconds: 0, reservedSeconds: 0});
    } else if (url.pathname === "/api/preview" || url.pathname === "/api/session") {
      state.previewRequests++;
      await json(options.call ? {avatarProvider: "tavus", serverUrl: "wss://room.invalid", token: "ui-fixture", ticket: "ui-fixture", preview: url.pathname === "/api/preview", endsAt: Math.floor(Date.now() / 1000) + (options.expiresIn || 120)} : {error: "Simulated unavailable preview"}, options.call ? 200 : 503);
    } else if (url.pathname === "/api/developer/logout") {
      state.developerLogouts++;
      await json({ok: true});
    } else if (options.paidSession && url.pathname === "/api/challenge") {
      await json({nonce: "paid-fixture", message: "Isolated paid-session UI challenge"});
    } else if (url.pathname === "/api/purchases") {
      await json({
        ok: true,
        status: "synced",
        purchases: [
          {
            id: "10143:0x7324a2678e74052a4e9a244c0d57b56b23fee6ad:0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890:1",
            wallet: "0x1111111111111111111111111111111111111111",
            packageId: 0,
            includedMinutes: 60,
            expiresAt: Math.floor(Date.now() / 1000) + 86400,
            amountPaid: "10000000",
            transactionHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
            blockNumber: 70192000,
            logIndex: 1,
            timestamp: Math.floor(Date.now() / 1000) - 3600,
          },
        ],
        sync: { status: "synced", ready: true, numBlocksBehind: 0, latestBlock: 70195000 },
        pagination: { limit: 20, offset: 0, count: 1 },
      });
    } else if (options.developerSigning && url.pathname === "/api/developer/challenge") {
      await json({nonce: "dashboard-nonce", message: "Archava developer dashboard\nWallet: 0x1111111111111111111111111111111111111111"});
    } else if (options.developerSigning && url.pathname === "/api/developer/login") {
      state.developerLogins++;
      assert.equal(request.postDataJSON().signature, "0xdeadbeef");
      await json({wallet: "0x1111111111111111111111111111111111111111"});
    } else if (options.developerSigning && url.pathname === "/api/developer/me") {
      await json({wallet: "0x1111111111111111111111111111111111111111"});
    } else if (options.developerSigning && url.pathname === "/api/developer/keys") {
      await json({keys: []});
    } else if (options.developerSigning && url.pathname === "/api/developer/usage") {
      await json({allocatedSeconds: 0, sessionCount: 0, balanceAvailable: false});
    } else if (url.pathname === "/api/session/end") { state.endRequests++; await json({ok: true}); }
    else if (url.pathname === "/__ui/avatar-preparation") { state.preparations++; await json({ok: true}, state.preparationFailure ? 503 : 200); }
    else if (url.pathname.startsWith("/api/") || request.method() === "POST") await json({error: "UI fixture does not authorize this action"}, 403);
    else await route.continue();
  });
  try {
    await page.goto(origin + (options.path || "/"), {waitUntil: "domcontentloaded"});
    await page.locator("main").waitFor();
    await run(page, state);
    assert.deepEqual(errors, [], `${name}: page JavaScript errors`);
    results.push({name, passed: true});
    console.log(`PASS ${name}`);
  } catch (error) {
    await page.screenshot({path: path.join(artifacts, `${name}-failure.png`), fullPage: true});
    results.push({name, passed: false, error: error.message});
    console.error(`FAIL ${name}: ${error.message}`);
  } finally { await context.close(); }
}

async function openWalletMenu(page) {
  const controls = page.getByRole("group", {name: "Wallet account"});
  const trigger = controls.getByRole("button", {name: "Wallet account options", exact: true});
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
  const popup = controls.getByRole("dialog", {name: "Wallet options", exact: true});
  await popup.waitFor();
  return popup;
}

try {
  for (const width of [1440, 1024, 390, 320]) {
    await check(`landing-wallet-${width}`, {wallet: true, width, height: 900}, async (page, state) => {
      const controls = page.getByRole("group", {name: "Wallet account"});
      const connect = controls.getByRole("button", {name: "Connect wallet", exact: true});
      await connect.waitFor();
      assert.ok(await connect.evaluate(el => {
        const r = el.getBoundingClientRect();
        return r.left >= 0 && r.right <= document.documentElement.clientWidth && r.top >= 0 && r.height >= 44;
      }), "connect is directly reachable in the top-right header");
      if (width === 390) { await connect.focus(); await connect.press("Enter"); }
      else await connect.click();
      const trigger = controls.getByRole("button", {name: "Wallet account options", exact: true});
      await trigger.waitFor();
      assert.equal(await controls.getByRole("button").count(), 1, "the header has a single account button");
      assert.equal(await controls.getByRole("button", {name: "Disconnect", exact: true}).count(), 0, "disconnect is only inside the popup");
      const popup = await openWalletMenu(page);
      assert.equal(await trigger.getAttribute("aria-expanded"), "true");
      assert.ok(await popup.evaluate(el => {
        const r = el.getBoundingClientRect();
        return r.left >= 0 && r.right <= document.documentElement.clientWidth && r.bottom <= innerHeight;
      }), "the popup fits the viewport");
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {configurable: true, value: {async writeText(value) { window.__copiedWallet = value; }}});
      });
      await popup.getByRole("button", {name: "Copy wallet address", exact: true}).click();
      await popup.getByRole("status").filter({hasText: "Copied"}).waitFor();
      assert.equal(await page.evaluate(() => window.__copiedWallet), "0x1111111111111111111111111111111111111111");
      const disconnect = popup.getByRole("button", {name: "Disconnect", exact: true});
      assert.ok(await disconnect.evaluate(el => {
        const r = el.getBoundingClientRect();
        return r.left >= 0 && r.right <= document.documentElement.clientWidth && r.height >= 44;
      }), "disconnect is reachable inside the popup");
      assert.equal(new URL(page.url()).pathname, "/", "connect never navigates to the build page");
      assert.equal(await page.evaluate(() => window.__ARCHAVA_UI_WALLET_REQUESTS.filter(method => method === "eth_requestAccounts").length), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await page.screenshot({path: path.join(artifacts, `wallet-connected-${width}.png`)});
      await disconnect.click();
      await connect.waitFor();
      assert.equal(await trigger.count(), 0);
      assert.equal(await popup.count(), 0);
      assert.equal(state.developerLogouts, 1);
      assert.equal(await page.getByRole("button", {name: "Open API key dashboard"}).count(), 0);
    });
  }
  await check("wallet-popup-keyboard-and-dismiss", {wallet: true, restored: true, width: 390}, async page => {
    const controls = page.getByRole("group", {name: "Wallet account"});
    const trigger = controls.getByRole("button", {name: "Wallet account options", exact: true});
    await trigger.focus();
    await trigger.press("Enter");
    const popup = controls.getByRole("dialog", {name: "Wallet options", exact: true});
    await popup.waitFor();
    assert.ok(await popup.getByRole("button", {name: "Copy wallet address", exact: true}).evaluate(el => el === document.activeElement));
    await page.keyboard.press("Escape");
    await popup.waitFor({state: "detached"});
    assert.ok(await trigger.evaluate(el => el === document.activeElement), "Escape returns focus to the wallet button");
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    await trigger.press("ArrowDown");
    await popup.waitFor();
    await page.keyboard.press("Tab");
    assert.ok(await popup.getByRole("button", {name: "Disconnect", exact: true}).evaluate(el => el === document.activeElement));
    await page.keyboard.press("Tab");
    await popup.waitFor({state: "detached"});
    await openWalletMenu(page);
    await page.locator(".video-hero-root").click({position: {x: 4, y: 4}});
    await popup.waitFor({state: "detached"});
    await openWalletMenu(page);
    await trigger.click();
    await popup.waitFor({state: "detached"});
  });
  await check("wallet-popup-copy-error-and-account-change", {wallet: true, restored: true, width: 390}, async page => {
    const popup = await openWalletMenu(page);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {configurable: true, value: {async writeText() { throw new Error("Clipboard permission denied"); }}});
    });
    await popup.getByRole("button", {name: "Copy wallet address", exact: true}).click();
    await page.getByRole("alert").filter({hasText: "Couldn't copy the wallet address"}).waitFor();
    assert.equal(await popup.getByRole("status").filter({hasText: "Copied"}).count(), 0, "copy failure never reports success");
    await page.evaluate(() => window.__ARCHAVA_UI_WALLET_EMIT("accountsChanged", ["0x2222222222222222222222222222222222222222"]));
    await popup.waitFor({state: "detached"});
    await page.getByRole("button", {name: "Wallet account options", exact: true}).filter({hasText: "0x2222"}).waitFor();
  });
  await check("wallet-popup-accessibility", {wallet: true, restored: true, width: 320}, async page => {
    await openWalletMenu(page);
    await page.addScriptTag({path: fileURLToPath(import.meta.resolve("axe-core/axe.min.js"))});
    const violations = await page.evaluate(async () => (await axe.run(document, {runOnly: {type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"]}})).violations.map(v => ({id: v.id, impact: v.impact, nodes: v.nodes.map(n => ({target: n.target, failureSummary: n.failureSummary}))})));
    await writeFile(path.join(artifacts, "axe-wallet-popup.json"), JSON.stringify(violations, null, 2));
    assert.deepEqual(violations, [], "open account popup accessibility");
  });
  await check("landing-wallet-signout-survives-reload", {wallet: true, restored: true, width: 320}, async (page, state) => {
    const controls = page.getByRole("group", {name: "Wallet account"});
    await controls.getByRole("button", {name: "Wallet account options", exact: true}).waitFor();
    const key = "archava_pending_v1_archava-monad_10143_0x1111111111111111111111111111111111111111";
    await page.evaluate(key => localStorage.setItem(key, JSON.stringify({schemaVersion: 1, deploymentId: "archava-monad", chainId: 10143, txHash: "0x" + "a".repeat(64), operationId: "pending-ui-fixture"})), key);
    const saved = await page.evaluate(key => localStorage.getItem(key), key);
    const popup = await openWalletMenu(page);
    await popup.getByRole("button", {name: "Disconnect", exact: true}).click();
    await controls.getByRole("button", {name: "Connect wallet", exact: true}).waitFor();
    await page.evaluate(() => {
      window.__ARCHAVA_UI_WALLET_EMIT("accountsChanged", ["0x1111111111111111111111111111111111111111"]);
      window.__ARCHAVA_UI_WALLET_EMIT("chainChanged", "0x61");
      window.__ARCHAVA_UI_WALLET_EMIT("disconnect");
    });
    assert.equal(await page.getByRole("alert").count(), 0, "old provider events must not restore app state");
    await page.reload();
    await controls.getByRole("button", {name: "Connect wallet", exact: true}).waitFor();
    assert.equal(await controls.getByRole("button", {name: "Wallet account options", exact: true}).count(), 0);
    assert.equal(await page.evaluate(() => window.__ARCHAVA_UI_WALLET_REQUESTS.length), 0, "reload does not silently reconnect the extension");
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), saved, "sign-out preserves pending purchase recovery");
    assert.equal(state.developerLogouts, 1);
    await controls.getByRole("button", {name: "Connect wallet", exact: true}).click();
    await controls.getByRole("button", {name: "Wallet account options", exact: true}).waitFor();
  });
  await check("landing-privy-login-cancel-logout", {privy: {}, width: 390}, async (page, state) => {
    const controls = page.getByRole("group", {name: "Wallet account"});
    const connect = controls.getByRole("button", {name: "Log in / Connect", exact: true});
    await connect.click();
    await page.getByRole("dialog", {name: "Fixture login"}).waitFor();
    await page.getByRole("button", {name: "Cancel login", exact: true}).click();
    assert.ok(await connect.isEnabled(), "cancelling login never locks the header");
    await connect.click();
    await page.getByRole("button", {name: "Continue with fixture account", exact: true}).click();
    await controls.getByRole("button", {name: "Wallet account options", exact: true}).filter({hasText: "0x3333"}).waitFor();
    assert.match(await controls.innerText(), /0x3333/);
    const popup = await openWalletMenu(page);
    await popup.getByRole("button", {name: "Disconnect", exact: true}).click();
    await connect.waitFor();
    assert.equal(state.developerLogouts, 1);
    assert.equal(await page.evaluate(() => window.__ARCHAVA_UI_PRIVY.logoutCalls), 1);
    await connect.click();
    await page.getByRole("button", {name: "Cancel login", exact: true}).click();
    assert.equal(await page.evaluate(() => sessionStorage.getItem("archava_wallet_disconnected_v1")), "true", "cancelled login preserves the prior sign-out preference");
    await connect.click();
    await page.getByRole("button", {name: "Continue with fixture account", exact: true}).click();
    await controls.getByRole("button", {name: "Wallet account options", exact: true}).filter({hasText: "0x3333"}).waitFor();
  });
  await check("landing-privy-loading", {privy: {ready: false}, width: 320}, async page => {
    const controls = page.getByRole("group", {name: "Wallet account"});
    assert.ok(await controls.getByRole("button", {name: "Loading wallet…", exact: true}).isDisabled());
    await page.evaluate(() => window.__ARCHAVA_UI_SET_PRIVY_READY(true));
    assert.ok(await controls.getByRole("button", {name: "Log in / Connect", exact: true}).isEnabled());
  });
  await check("landing-privy-late-provider-after-logout", {privy: {authenticated: true, providerDelay: 1200}, width: 320}, async page => {
    const controls = page.getByRole("group", {name: "Wallet account"});
    await page.waitForFunction(() => window.__ARCHAVA_UI_PRIVY.providerRequests > 0);
    const popup = await openWalletMenu(page);
    await popup.getByRole("button", {name: "Disconnect", exact: true}).click();
    await controls.getByRole("button", {name: "Log in / Connect", exact: true}).waitFor();
    await page.waitForTimeout(1350);
    assert.equal(await controls.getByRole("button", {name: "Wallet account options", exact: true}).count(), 0, "late SDK provider cannot reconnect after logout");
  });
  await check("landing-privy-logout-retry", {privy: {authenticated: true, logoutFailure: true}, width: 390}, async page => {
    const controls = page.getByRole("group", {name: "Wallet account"});
    await controls.getByRole("button", {name: "Wallet account options", exact: true}).filter({hasText: "0x3333"}).waitFor();
    const popup = await openWalletMenu(page);
    await popup.getByRole("button", {name: "Disconnect", exact: true}).click();
    await page.getByRole("alert").filter({hasText: "sign-out failed"}).waitFor();
    assert.doesNotMatch(await controls.innerText(), /0x3333/);
    await page.evaluate(() => { window.__ARCHAVA_UI_PRIVY.logoutFailure = false; });
    const retryPopup = await openWalletMenu(page);
    await retryPopup.getByRole("button", {name: "Disconnect", exact: true}).click();
    await controls.getByRole("button", {name: "Log in / Connect", exact: true}).waitFor();
    assert.equal(await page.getByRole("alert").count(), 0);
  });
  for (const paidSession of [false, true]) {
    await check(`wallet-signout-${paidSession ? "ends-paid" : "keeps-preview"}`, {wallet: true, restored: true, call: true, paidSession}, async (page, state) => {
      const controls = page.getByRole("group", {name: "Wallet account"});
      await controls.getByRole("button", {name: "Wallet account options", exact: true}).waitFor();
      if (paidSession) {
        await page.locator(".catalog-paid-access summary").click();
        await page.getByRole("button", {name: "Start paid conversation", exact: true}).click();
      } else await page.locator(".avatar-launcher").click();
      const dock = page.getByRole("complementary", {name: "Live conversation with Ava"});
      await dock.waitFor();
      const popup = await openWalletMenu(page);
      await popup.getByRole("button", {name: "Disconnect", exact: true}).click();
      await controls.getByRole("button", {name: "Connect wallet", exact: true}).waitFor();
      if (paidSession) {
        await dock.waitFor({state: "detached"});
        assert.equal(state.endRequests, 1, "the paid room is ended exactly once");
      } else {
        assert.ok(await dock.isVisible(), "the wallet-free demo keeps running after sign-out");
        assert.equal(state.endRequests, 0);
        await dock.getByRole("button", {name: "End conversation"}).click();
      }
    });
  }
  for (const route of ["/", "/build"]) {
    await check(`avatar-launcher-${route === "/" ? "home" : "build"}`, {path: route, call: true, width: 390, height: 844}, async (page, state) => {
      const launcher = page.locator(".avatar-launcher");
      await launcher.filter({hasText: "Talk to Ava"}).waitFor();
      const anchorSelector = route === "/" ? "#business-section h2" : ".build-footer";
      const anchor = page.locator(anchorSelector);
      await anchor.scrollIntoViewIfNeeded();
      const anchorTop = await anchor.evaluate(el => el.getBoundingClientRect().top);
      // Copy changes and post-call content can change document height. Native
      // scroll anchoring must keep the viewed content at the same screen position.
      const assertSameView = () => page.waitForFunction(({selector, top}) =>
        Math.abs(document.querySelector(selector).getBoundingClientRect().top - top) <= 2,
        {selector: anchorSelector, top: anchorTop}, {timeout: 3000});
      assert.equal(await launcher.evaluate(el => getComputedStyle(el).position), "fixed");
      assert.ok(await launcher.evaluate(el => {
        const r = el.getBoundingClientRect();
        return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      }), "Ava can be opened from the bottom of the page");
      await launcher.click();
      const dock = page.getByRole("complementary", {name: "Live conversation with Ava"});
      await dock.waitFor();
      assert.equal(await launcher.count(), 0, "only the active widget is displayed");
      await assertSameView();
      assert.equal(new URL(page.url()).pathname, route);
      await dock.getByRole("button", {name: "End conversation"}).click();
      await dock.waitFor({state: "detached"});
      await launcher.filter({hasText: "Talk to Ava"}).waitFor();
      assert.equal(state.previewRequests, 1);
      assert.equal(state.endRequests, 1);
      await assertSameView();
    });
  }
  for (const [width, height] of [[1440, 900], [768, 1024], [390, 844], [320, 740]]) {
    await check(`layout-${width}`, {width, height}, async page => {
      await page.locator(".hero-neon-pill-btn").filter({hasText: "Talk to Ava"}).waitFor();
      const measurements = await page.evaluate(() => {
        const box = el => ({left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom});
        return {width: innerWidth, scrollWidth: document.documentElement.scrollWidth, hints: [...document.querySelectorAll(".hero-preview-hint,.hero-access-hint,.hero-jump-link")].map(box), hud: box(document.querySelector(".hero-left-hud")), entry: box(document.querySelector(".hero-demo-entry")), hero: box(document.querySelector(".video-hero-canvas"))};
      });
      assert.equal(measurements.scrollWidth, width);
      for (const r of measurements.hints) assert.ok(r.left >= 0 && r.right <= width, "hero text is clipped");
      if (width <= 768) assert.ok(measurements.hud.bottom <= measurements.entry.top, "hero content overlaps");
      assert.equal(await page.locator("[role=button] button").count(), 0);
      assert.equal(await page.locator(".catalog-avatar-poster").count(), 1);
      assert.equal(await page.locator(".catalog-avatar-card").count(), 0);
      await page.screenshot({path: path.join(artifacts, `home-${width}.png`)});
      await page.locator("#catalog-section").scrollIntoViewIfNeeded();
      await page.screenshot({path: path.join(artifacts, `catalog-${width}.png`)});
    });
  }
  for (const key of ["Enter", "Space"]) {
    await check(`talk-keyboard-${key}`, {}, async (page, state) => {
      const button = page.locator(".catalog-demo-entry button");
      await button.filter({hasText: "Talk to Ava"}).waitFor();
      await button.focus();
      await button.press(key);
      await page.getByRole("alert").waitFor();
      assert.equal(state.previewRequests, 1);
      assert.match(await page.getByRole("alert").innerText(), /warming up/);
      const inViewport = await page.getByRole("alert").evaluate(el => el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().bottom <= innerHeight);
      assert.ok(inViewport, "error feedback must be visible");
    });
  }
  await check("wallet-error-visible", {path: "/build", width: 390, height: 844}, async page => {
    await page.getByRole("button", {name: "Connect wallet", exact: true}).click();
    await page.getByRole("alert").waitFor();
    assert.match(await page.getByRole("alert").innerText(), /Install a wallet/);
    assert.ok(await page.getByRole("alert").evaluate(el => el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().bottom <= innerHeight));
    await page.getByRole("button", {name: "Dismiss notification"}).click();
    assert.equal(await page.getByRole("alert").count(), 0);
  });
  await check("offline-retry", {offline: true, width: 390, height: 844}, async (page, state) => {
    await page.getByRole("button", {name: "Retry connection"}).waitFor();
    assert.match(await page.locator("#hero-demo-note").innerText(), /offline/);
    state.offline = false;
    await page.getByRole("button", {name: "Retry connection"}).click();
    await page.locator(".hero-neon-pill-btn").filter({hasText: "Talk to Ava"}).waitFor();
    assert.ok(state.configRequests >= 2);
    assert.equal(await page.getByRole("alert").count(), 0);
  });
  await check("checking-state", {configDelay: 500}, async page => {
    await page.locator(".hero-neon-pill-btn").filter({hasText: "Checking availability"}).waitFor();
    assert.ok(await page.locator(".hero-neon-pill-btn").isDisabled());
    await page.locator(".hero-neon-pill-btn").filter({hasText: "Talk to Ava"}).waitFor();
  });
  await check("unsupported-before-click", {unsupported: true, config: {avatarProvider: "spatius"}, width: 320, height: 740}, async (page, state) => {
    await page.locator(".hero-neon-pill-btn").filter({hasText: "Browser not supported"}).waitFor();
    assert.ok(await page.locator(".hero-neon-pill-btn").isDisabled());
    assert.match(await page.locator("#hero-demo-note").innerText(), /Chrome or Edge/);
    assert.equal(state.previewRequests, 0);
    assert.equal(state.preparations, 0);
    assert.ok(await page.evaluate(() => document.querySelector(".hero-left-hud").getBoundingClientRect().bottom <= document.querySelector(".hero-demo-entry").getBoundingClientRect().top));
    await page.screenshot({path: path.join(artifacts, "unsupported-320.png")});
  });
  await check("build-does-not-prepare-avatar", {path: "/build", config: {avatarProvider: "spatius"}}, async (page, state) => {
    await page.getByRole("button", {name: "300 min"}).click();
    await page.waitForFunction(() => document.querySelector(".build-quote")?.textContent.includes("20 mUSDT"));
    assert.equal(await page.getByRole("button", {name: "300 min"}).getAttribute("aria-pressed"), "true");
    assert.equal(state.preparations, 0);
  });
  await check("home-keeps-avatar-preload", {config: {avatarProvider: "spatius"}}, async (page, state) => {
    await page.locator(".avatar-preparation-note").filter({hasText: "ready to connect"}).waitFor();
    assert.ok(state.preparations > 0);
    assert.equal(state.previewRequests, 0, "preload must not start a session");
  });
  await check("developer-dialog-keyboard", {wallet: true}, async page => {
    await page.locator(".catalog-paid-access summary").click();
    await page.getByRole("button", {name: "Connect wallet for paid access"}).click();
    const trigger = page.getByRole("button", {name: "Open API key dashboard", exact: true});
    await trigger.click();
    const dialog = page.getByRole("dialog", {name: "Developer access", exact: true});
    await dialog.waitFor();
    assert.ok(await dialog.evaluate(el => el.matches(":modal")));
    assert.ok(await page.evaluate(() => !!document.activeElement.closest("#developer-access")));
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press("Tab");
      assert.ok(await page.evaluate(() => !!document.activeElement.closest("#developer-access")), "focus escaped dialog");
    }
    await page.screenshot({path: path.join(artifacts, "developer-dialog.png")});
    await page.keyboard.press("Escape");
    await dialog.waitFor({state: "detached"});
    assert.ok(await trigger.evaluate(el => el === document.activeElement), "focus was not restored");
    assert.notEqual(await page.evaluate(() => document.body.style.overflow), "hidden");
  });
  await check("restore-authorized-wallet", {path: "/build", wallet: true, restored: true}, async page => {
    await page.getByRole("button", {name: "Open API key dashboard"}).waitFor();
    assert.equal(await page.getByRole("button", {name: "Connect wallet", exact: true}).count(), 0);
  });
  for (const rejectSignature of [false, true]) {
    await check(`developer-wallet-confirmation-${rejectSignature ? "reject" : "approve"}`,
      {path: "/build", wallet: true, restored: true, developerSigning: true}, async (page, state) => {
        await page.evaluate(() => {
          const original = window.ethereum.request.bind(window.ethereum);
          window.ethereum.request = args => {
            if (args.method !== "personal_sign") return original(args);
            return new Promise((resolve, reject) => {
              // Wallet SDKs render their confirmation portal outside the dashboard.
              const portal = document.createElement("div");
              portal.id = "wallet-signature-fixture";
              portal.setAttribute("role", "dialog");
              portal.setAttribute("aria-label", "Wallet signature");
              portal.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(0,0,0,.7)";
              for (const cancelled of [false, true]) {
                const button = document.createElement("button");
                button.textContent = cancelled ? "Reject signature" : "Confirm signature";
                button.onclick = () => {
                  portal.remove();
                  if (cancelled) reject(Object.assign(new Error("Rejected"), {code: 4001}));
                  else resolve("0xdeadbeef");
                };
                portal.append(button);
              }
              document.body.append(portal);
              portal.querySelector("button").focus();
            });
          };
        });
        await page.getByRole("button", {name: "Open API key dashboard"}).click();
        const dialog = page.locator("#developer-access");
        assert.ok(await dialog.evaluate(el => el.matches(":modal")));
        await page.getByRole("button", {name: "Sign developer challenge", exact: true}).click();
        const confirmation = page.getByRole("dialog", {name: "Wallet signature"});
        await confirmation.waitFor();
        assert.equal(await dialog.evaluate(el => el.matches(":modal")), false);
        await page.getByRole("button", {name: rejectSignature ? "Reject signature" : "Confirm signature", exact: true}).click();
        if (rejectSignature) {
          await dialog.getByRole("alert").filter({hasText: "Signature cancelled"}).waitFor();
          assert.equal(state.developerLogins, 0);
          assert.ok(await page.getByRole("button", {name: "Sign developer challenge", exact: true}).isEnabled());
        } else {
          await dialog.getByText("authenticated", {exact: true}).waitFor();
          assert.equal(state.developerLogins, 1);
        }
        assert.ok(await dialog.evaluate(el => el.matches(":modal")), "dashboard modal must be restored after wallet confirmation");
        await page.keyboard.press("Escape");
        await dialog.waitFor({state: "detached"});
      });
  }
  await check("copy-code-success-and-failure", {path: "/build", width: 390, height: 844}, async page => {
    await page.evaluate(() => {
      window.__copiedExample = "";
      Object.defineProperty(navigator, "clipboard", {configurable: true, value: {async writeText(value) { window.__copiedExample = value; }}});
    });
    await page.getByRole("button", {name: "Copy session API example"}).click();
    assert.match(await page.evaluate(() => window.__copiedExample), /POST|POST.*|method: "POST"/);
    assert.match(await page.getByRole("button", {name: "Copy session API example"}).innerText(), /Copied/);
    await page.getByRole("region", {name: "Session API JavaScript example"}).focus();
    assert.ok(await page.getByRole("region", {name: "Session API JavaScript example"}).evaluate(el => el === document.activeElement));
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", {configurable: true, value: {async writeText() {throw new Error("Simulated denied permission");}}}));
    await page.getByRole("button", {name: "Copy contract interface"}).click();
    await page.getByRole("alert").waitFor();
    assert.match(await page.getByRole("alert").innerText(), /copy it manually/);
    await page.screenshot({path: path.join(artifacts, "copy-feedback.png")});
  });
  for (const [width, height] of [[1440, 900], [768, 1024], [390, 844], [320, 740], [844, 390]]) {
    await check(`floating-avatar-${width}`, {call: true, width, height}, async (page, state) => {
      const launch = page.locator(".hero-neon-pill-btn").filter({hasText: "Talk to Ava"});
      await launch.click();
      const openedAtScroll = await page.evaluate(() => scrollY);
      const dock = page.getByRole("complementary", {name: "Live conversation with Ava"});
      await dock.waitFor();
      await page.waitForFunction(() => !!window.__ARCHAVA_UI_ROOM);
      await page.waitForFunction(() => document.querySelector(".live-site-awareness")?.textContent.includes("AVA HAS THIS SECTION"));
      assert.equal(await page.locator("#live-avatar-room").count(), 1);
      assert.equal(await page.locator(".catalog-avatar-poster").count(), 1, "the catalog keeps its artwork");
      assert.equal(await page.evaluate(() => scrollY), openedAtScroll, "opening the widget must not scroll to the catalog");
      await page.evaluate(() => {
        window.__ARCHAVA_SAVED_ROOM = window.__ARCHAVA_UI_ROOM;
        window.__ARCHAVA_SAVED_VIEWPORT = document.querySelector(".live-video-viewport");
      });
      const assertCorner = async () => {
        const position = await dock.evaluate(el => {
          const r = el.getBoundingClientRect();
          return {fixed: getComputedStyle(el).position, portal: el.parentElement === document.body,
            left: r.left, top: r.top, rightGap: document.documentElement.clientWidth - r.right, bottomGap: innerHeight - r.bottom,
            scrollWidth: document.documentElement.scrollWidth, width: innerWidth};
        });
        assert.equal(position.fixed, "fixed");
        assert.equal(position.portal, true);
        assert.ok(position.left >= 0 && position.top >= 0, "widget must fit the viewport");
        assert.ok(position.rightGap >= 0 && position.rightGap <= 26, "widget is at the right edge");
        assert.ok(position.bottomGap >= 0 && position.bottomGap <= 26, "widget is at the bottom edge");
        assert.equal(position.scrollWidth, position.width, "widget must not cause horizontal scrolling");
      };
      await assertCorner();
      await page.evaluate(() => window.__ARCHAVA_UI_ROOM.emit(
        "dataReceived", new TextEncoder().encode(JSON.stringify({section: "business-section"})),
        {isAgent: true}, 0, "archava.navigation",
      ));
      await page.waitForFunction(() => {
        const section = document.getElementById("business-section").getBoundingClientRect();
        return section.top >= 0 && section.top <= innerHeight * 0.4;
      });
      await page.waitForFunction(() => document.querySelector(".live-site-awareness")?.textContent.includes("AVA HAS THIS SECTION") && document.querySelector(".live-site-awareness")?.textContent.includes("For business"));
      await assertCorner();
      await page.screenshot({path: path.join(artifacts, `floating-avatar-${width}.png`)});
      await dock.getByRole("button", {name: "Minimize avatar", exact: true}).click();
      await page.locator(".live-video-viewport").waitFor({state: "hidden"});
      await assertCorner();
      assert.equal(await page.evaluate(() => window.__ARCHAVA_UI_ROOM === window.__ARCHAVA_SAVED_ROOM && document.querySelector(".live-video-viewport") === window.__ARCHAVA_SAVED_VIEWPORT), true, "minimize must preserve the room and renderer");
      assert.equal(state.endRequests, 0, "minimize must not end the session");
      await dock.getByRole("button", {name: "Mute microphone", exact: true}).click();
      await dock.getByRole("button", {name: "Unmute microphone", exact: true}).waitFor();
      await dock.getByRole("button", {name: "Unmute microphone", exact: true}).click();
      await dock.getByRole("button", {name: "Mute microphone", exact: true}).waitFor();
      await page.screenshot({path: path.join(artifacts, `floating-avatar-minimized-${width}.png`)});
      await dock.getByRole("button", {name: "Expand avatar", exact: true}).click();
      await page.locator(".live-video-viewport").waitFor({state: "visible"});
      await assertCorner();
      assert.equal(await page.evaluate(() => window.__ARCHAVA_UI_ROOM === window.__ARCHAVA_SAVED_ROOM && document.querySelector(".live-video-viewport") === window.__ARCHAVA_SAVED_VIEWPORT), true, "expand must not recreate the session");
      assert.equal(state.previewRequests, 1, "one purchase/preview ticket per conversation");
      const closedAtScroll = await page.evaluate(() => scrollY);
      await dock.getByRole("button", {name: "End conversation"}).click();
      await dock.waitFor({state: "detached"});
      await page.locator("#post-call-panel").waitFor({state: "attached"});
      await page.waitForFunction(() => !window.__ARCHAVA_UI_ROOM);
      assert.equal(await page.evaluate(() => scrollY), closedAtScroll, "ending the call must not jump the page");
      assert.equal(state.endRequests, 1, "end-call cleanup must run once");
    });
  }
  for (const minimized of [false, true]) {
    await check(`call-expiry-${minimized ? "minimized" : "expanded"}`, {call: true, expiresIn: 4}, async (page, state) => {
      await page.locator(".hero-neon-pill-btn").filter({hasText: "Talk to Ava"}).click();
      if (minimized) await page.getByRole("button", {name: "Minimize avatar", exact: true}).click();
      await page.locator("#post-call-panel").waitFor({state: "attached"});
      assert.equal(await page.locator(".live-call-dock").count(), 0);
      assert.equal(state.endRequests, 1);
    });
  }
  await check("floating-avatar-accessibility", {call: true, width: 390, height: 844}, async page => {
    await page.locator(".hero-neon-pill-btn").filter({hasText: "Talk to Ava"}).click();
    const dock = page.getByRole("complementary", {name: "Live conversation with Ava"});
    await dock.waitFor();
    await page.addScriptTag({path: fileURLToPath(import.meta.resolve("axe-core/axe.min.js"))});
    for (const minimized of [false, true]) {
      if (minimized) await dock.getByRole("button", {name: "Minimize avatar", exact: true}).click();
      const violations = await page.evaluate(async () => (await axe.run(document, {runOnly: {type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"]}})).violations.map(v => ({id: v.id, impact: v.impact, nodes: v.nodes.map(n => ({target: n.target, failureSummary: n.failureSummary}))})));
      await writeFile(path.join(artifacts, `axe-floating-${minimized ? "minimized" : "expanded"}.json`), JSON.stringify(violations, null, 2));
      assert.deepEqual(violations, [], "widget accessibility, including hidden controls while minimized");
    }
  });
  for (const [name, route, width] of [["home", "/", 1440], ["home-mobile", "/", 390], ["build-mobile", "/build", 390]]) {
    await check(`accessibility-${name}`, {path: route, width, height: 900}, async page => {
      await page.locator(route === "/" ? ".catalog-demo-entry button" : ".build-quote").waitFor();
      await page.addScriptTag({path: fileURLToPath(import.meta.resolve("axe-core/axe.min.js"))});
      const result = await page.evaluate(async () => {
        const result = await axe.run(document, {runOnly: {type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"]}});
        return {violations: result.violations.map(v => ({id: v.id, impact: v.impact, nodes: v.nodes.map(n => ({target: n.target, failureSummary: n.failureSummary}))})), incomplete: result.incomplete.map(v => ({id: v.id, count: v.nodes.length}))};
      });
      await writeFile(path.join(artifacts, `axe-${name}.json`), JSON.stringify(result, null, 2));
      assert.deepEqual(result.violations, [], "automated accessibility violations");
    });
  }
} finally {
  await browser.close();
  await server.close();
  await writeFile(path.join(artifacts, "results.json"), JSON.stringify(results, null, 2));
}
const passed = results.filter(result => result.passed).length;
console.log(`${passed}/${results.length} UI checks passed. Artifacts: ${artifacts}`);
if (passed !== results.length) process.exitCode = 1;
