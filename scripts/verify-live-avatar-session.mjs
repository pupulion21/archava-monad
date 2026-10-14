import { chromium } from "playwright";

const FRONT_URL = process.env.VERIFY_FRONT_URL || "http://localhost:5174/";

/**
 * Synthetic-media preview verification only.
 *
 * What this script proves:
 * - The free preview ("Talk to Ava") opens a LiveKit + Spatius session with
 *   synthetic headless media and renders avatar pixels.
 * - Preview controls respond to real Playwright user clicks.
 * - The floating widget stays visible while scrolling and preserves its canvas
 *   and audio element when minimized and expanded.
 *
 * What this script does NOT prove:
 * - Human-confirmed audible conversation (requires a human listening).
 * - Privy-authenticated purchase or paid session (requires a human wallet).
 *
 * Do not cite a passing run as evidence for the latter two.
 */

function parseTimerToSeconds(text) {
  const m = /(\d+):(\d+)/.exec(text || "");
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

async function verifyLiveAvatar() {
  console.log("=== Verifying Real Live Avatar Session (synthetic-media preview) ===");
  console.log("[Scope: free preview with fake headless media. Not a human audible check. Not a paid session.]");

  const browser = await chromium.launch({
    executablePath: process.env.ARCHAVA_BROWSER_EXECUTABLE || undefined,
    headless: process.env.ARCHAVA_BROWSER_HEADLESS !== "false",
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--enable-gpu-rasterization",
      "--ignore-gpu-blocklist",
      "--enable-webgl",
      "--enable-webgl2",
    ],
  });

  let context = null;
  const startedAt = Date.now();
  try {
    // Emulate the `prefers-reduced-motion: reduce` user preference. The page sets
    // a global `scroll-behavior: smooth`, which makes Playwright's
    // scrollIntoViewIfNeeded + stability re-check cycle stall for several seconds
    // per click; the stylesheet already switches `scroll-behavior` to `auto`
    // under reduced motion. This keeps every interaction a normal Playwright
    // locator click (no force clicks, no JavaScript clicks) while letting
    // actionability checks settle. It does not change what is asserted.
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ["microphone"],
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const logBudget = async (step) => {
      const timer = await page.evaluate(() => document.querySelector(".timer-digits")?.textContent?.trim() ?? "");
      console.log(`Timing: ${step}; elapsed=${Date.now() - startedAt}ms; preview=${timer || "not mounted"}`);
    };
    page.on("response", async response => {
      if (new URL(response.url()).pathname !== "/api/preview" || !response.ok()) return;
      const result = await response.json().catch(() => null);
      if (Number.isFinite(result?.endsAt)) {
        console.log(`Timing: preview issued; elapsed=${Date.now() - startedAt}ms; expiresIn=${result.endsAt - Math.floor(Date.now() / 1000)}s`);
      }
    });

    console.log("1. Loading frontend at", FRONT_URL);
    await page.goto(FRONT_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    const talkBtn = page.locator("button.avatar-launcher");
    await talkBtn.waitFor({ state: "visible", timeout: 15000 });
    console.log("✓ 'Talk to Ava' button is visible");

    console.log("2. Clicking 'Talk to Ava' to initiate session (Playwright user click)...");
    await talkBtn.click();
    console.log("✓ Preview session requested via user click");

    console.log("3. Waiting for live room container and avatar canvas...");
    await page.waitForSelector("#live-avatar-room", { timeout: 20000 });
    // Avatar canvas init can be slow when LiveKit negotiates WebRTC + Spatius loads WASM
    await page.waitForSelector(".spatius-avatar-canvas canvas", { timeout: 60000 });
    console.log("✓ Live avatar room and canvas initialized in DOM");

    console.log("4. Waiting for Ava agent to connect and begin conversation...");
    let agentActive = false;
    let lastState = "";
    for (let i = 0; i < 45; i++) {
      await page.waitForTimeout(1000);
      const stateText = await page.evaluate(() => {
        return document.querySelector(".call-dock-status")?.textContent?.trim() || "";
      });
      lastState = stateText;
      if (stateText.includes("SPEAKING")) {
        agentActive = true;
        console.log(`✓ Agent reached speaking state: "${stateText}" (${i}s)`);
        break;
      } else if (stateText.includes("LISTENING") || stateText.includes("AVA READY")) {
        agentActive = true;
        console.log(`Agent reached active state: "${stateText}" (${i}s)`);
        break;
      }
      if (i % 5 === 0) {
        console.log(`Connecting... current state: "${stateText}" (${i}s)`);
      }
    }
    if (!agentActive) {
      throw new Error(`Agent did not reach active state within timeout. Last state: "${lastState}"`);
    }

    // Wait 3 seconds for WebRTC stream buffer
    await page.waitForTimeout(3000);

    console.log("5. Verifying avatar canvas pixel rendering...");
    const canvasEval = await page.evaluate(() => {
      const c = document.querySelector(".spatius-avatar-canvas canvas");
      if (!c) return { ok: false, error: "no canvas" };
      let dataUrl = "";
      try {
        dataUrl = c.toDataURL("image/png");
      } catch (e) {
        return { ok: false, error: e.message };
      }
      return {
        ok: true,
        width: c.width,
        height: c.height,
        dataUrlLen: dataUrl.length,
        dataUrl,
      };
    });

    if (!canvasEval.ok || canvasEval.dataUrlLen < 5000) {
      throw new Error(`Canvas pixel validation failed: ${JSON.stringify(canvasEval)}`);
    }
    console.log(`✓ Canvas visibly rendered: ${canvasEval.width}x${canvasEval.height}, PNG payload size: ${canvasEval.dataUrlLen} chars`);

    // Capture and save verified screenshot directly from canvas dataUrl
    if (canvasEval.dataUrl) {
      const base64Data = canvasEval.dataUrl.replace(/^data:image\/png;base64,/, "");
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir("/tmp/diag2", { recursive: true });
      await writeFile("/tmp/diag2/live-verified-avatar.png", Buffer.from(base64Data, "base64"));
      console.log("✓ Saved live verified screenshot to /tmp/diag2/live-verified-avatar.png");
    }

    console.log("6. Verifying remote audio evidence (RoomAudioRenderer)...");
    // Production playback is via LiveKit RoomAudioRenderer, which renders
    // one <audio> per subscribed remote audio track. Spatius AvatarPlayer
    // drives the avatar; it does not replace the LiveKit audio element.
    const audioEvidence = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll("audio"));
      return {
        count: els.length,
        details: els.map((aud) => ({
          paused: aud.paused,
          currentTime: aud.currentTime,
          readyState: aud.readyState,
          muted: aud.muted,
          volume: aud.volume,
          srcObjectActive: Boolean(aud.srcObject),
        })),
      };
    });
    console.log("Audio evidence:", JSON.stringify(audioEvidence));
    if (audioEvidence.count === 0) {
      throw new Error(
        "INCONCLUSIVE/FAIL: no <audio> element rendered by RoomAudioRenderer. " +
          "Remote audio cannot be confirmed in this headless run."
      );
    }
    const activeAudio = audioEvidence.details.some(
      (d) => d.readyState >= 2 || d.currentTime > 0 || d.paused === false
    );
    if (!activeAudio) {
      throw new Error(
        `INCONCLUSIVE/FAIL: ${audioEvidence.count} <audio> element(s) present but none shows playback ` +
          `(all paused with readyState 0 and currentTime 0). Human audible check still required.`
      );
    }
    console.log("✓ Remote audio element present with playback evidence (synthetic headless media; not human-confirmed audible)");

    console.log("7. Testing microphone mute/unmute with Playwright user clicks...");
    await logBudget("before mic controls");
    // Production control: button.mic-control-btn toggles
    // localParticipant.setMicrophoneEnabled(). Verify via real clicks and
    // assert both transitions plus restoration. No force/JS clicks.
    const micBtn = page.locator("button.mic-control-btn").first();
    await micBtn.waitFor({ state: "visible", timeout: 15000 });

    const readMicState = async () => {
      const text = (await micBtn.textContent())?.trim() ?? "";
      const ariaPressed = await micBtn.getAttribute("aria-pressed");
      const cls = (await micBtn.getAttribute("class")) ?? "";
      // Best-effort local publication state: the button is the production
      // surface for isMicrophoneEnabled. The LiveKit room object is not
      // exposed globally, so aria-pressed + text + class are the accessible signals.
      return { text, ariaPressed, cls };
    };

    const initial = await readMicState();
    console.log(`Initial mic state: text="${initial.text}" aria-pressed="${initial.ariaPressed}" class="${initial.cls}"`);
    if (!initial.text.includes("MIC ON") && !initial.text.includes("MUTED")) {
      throw new Error(`Unexpected initial mic button state: "${initial.text}"`);
    }

    await micBtn.click({timeout: 10000});
    await logBudget("first mic click");
    await page.waitForTimeout(800);
    const afterFirst = await readMicState();
    console.log(`After first click: text="${afterFirst.text}" aria-pressed="${afterFirst.ariaPressed}"`);

    const startedMuted = initial.text.includes("MUTED");
    if (startedMuted) {
      if (!afterFirst.text.includes("MIC ON")) {
        throw new Error(`Mic did not toggle from MUTED to MIC ON (got "${afterFirst.text}")`);
      }
      if (afterFirst.ariaPressed !== "true" && afterFirst.ariaPressed !== null) {
        console.log(`Note: aria-pressed after unmute is "${afterFirst.ariaPressed}" (expected "true" when MIC ON)`);
      }
    } else {
      if (!afterFirst.text.includes("MUTED")) {
        throw new Error(`Mic did not toggle from MIC ON to MUTED (got "${afterFirst.text}")`);
      }
    }
    if (afterFirst.text === initial.text) {
      throw new Error("Mic button text did not change after first user click");
    }
    console.log("✓ First microphone transition asserted");

    await micBtn.click({timeout: 10000});
    await logBudget("second mic click");
    await page.waitForTimeout(800);
    const afterSecond = await readMicState();
    console.log(`After second click (restored): text="${afterSecond.text}" aria-pressed="${afterSecond.ariaPressed}"`);
    if (afterSecond.text !== initial.text) {
      throw new Error(
        `Mic state was not restored: initial "${initial.text}" vs restored "${afterSecond.text}"`
      );
    }
    if (afterSecond.ariaPressed !== initial.ariaPressed) {
      throw new Error(
        `Mic aria-pressed was not restored: initial "${initial.ariaPressed}" vs restored "${afterSecond.ariaPressed}"`
      );
    }
    console.log("✓ Microphone mute and unmute controls verified with restoration (Playwright clicks)");

    console.log("8. Testing floating position and minimize/expand with the live renderer...");
    await logBudget("before floating checks");
    await page.evaluate(() => {
      window.__verifiedAvatarCanvas = document.querySelector(".spatius-avatar-canvas canvas");
      window.__verifiedAvatarAudio = document.querySelector("audio");
    });
    await page.locator("#business-section").scrollIntoViewIfNeeded({timeout: 10000});
    await logBudget("after scrolling");
    const widget = page.locator("#live-avatar-room");
    const position = await widget.evaluate(el => {
      const r = el.getBoundingClientRect();
      return {fixed: getComputedStyle(el).position, left: r.left, top: r.top,
        rightGap: document.documentElement.clientWidth - r.right, bottomGap: innerHeight - r.bottom};
    });
    if (position.fixed !== "fixed" || position.left < 0 || position.top < 0 ||
        position.rightGap < 0 || position.rightGap > 26 || position.bottomGap < 0 || position.bottomGap > 26) {
      throw new Error(`Floating avatar is outside the bottom-right corner: ${JSON.stringify(position)}`);
    }
    await widget.getByRole("button", {name: "Minimize avatar", exact: true}).click({timeout: 10000});
    await page.locator(".spatius-avatar-canvas canvas").waitFor({state: "hidden"});
    const minimized = await page.evaluate(() => {
      const canvas = document.querySelector(".spatius-avatar-canvas canvas");
      const audio = document.querySelector("audio");
      const r = canvas?.getBoundingClientRect();
      return {sameCanvas: canvas === window.__verifiedAvatarCanvas,
        sameAudio: audio === window.__verifiedAvatarAudio, width: r?.width, height: r?.height,
        playback: !!audio && !audio.paused && audio.readyState >= 2};
    });
    if (!minimized.sameCanvas || !minimized.sameAudio || !minimized.playback ||
        !(minimized.width > 0) || !(minimized.height > 0)) {
      throw new Error(`Minimize interrupted the renderer or audio: ${JSON.stringify(minimized)}`);
    }
    await widget.getByRole("button", {name: "Expand avatar", exact: true}).click({timeout: 10000});
    await page.locator(".spatius-avatar-canvas canvas").waitFor({state: "visible"});
    if (!await page.evaluate(() => document.querySelector(".spatius-avatar-canvas canvas") === window.__verifiedAvatarCanvas)) {
      throw new Error("Expanding the widget recreated the avatar canvas");
    }
    await page.screenshot({path: "/tmp/diag2/live-floating-widget.png"});
    console.log("✓ Widget stays in the corner; minimize/expand keeps the canvas mounted and remote audio playing");

    console.log("9. Testing end call with Playwright user click (before preview expiry)...");
    const timerText = await page.evaluate(() => {
      return document.querySelector(".timer-digits")?.textContent?.trim() ?? "";
    });
    const secondsLeft = parseTimerToSeconds(timerText);
    console.log(`Preview timer before end-call: "${timerText}" (${secondsLeft ?? "unknown"}s left)`);
    if (secondsLeft !== null && secondsLeft <= 10) {
      throw new Error(
        `INCONCLUSIVE: preview expires in ${secondsLeft}s; end-call click would race automatic expiry. ` +
          "Re-run with a fresh preview session."
      );
    }

    const endBtn = page.locator("button.end-call-btn").first();
    await endBtn.waitFor({ state: "visible", timeout: 10000 });
    // Normal user click only. A missing/detached control is a failure —
    // automatic preview expiry must not be substituted for a user click.
    await endBtn.click({ timeout: 10000 });
    console.log("✓ End call button clicked via Playwright user click");
    await page.waitForTimeout(2500);

    const postCallVisible = await page.evaluate(() => {
      const liveRoom = document.querySelector("#live-avatar-room");
      const postCall = document.querySelector("#post-call-panel");
      return {
        liveRoomPresent: !!liveRoom,
        postCallPresent: !!postCall,
      };
    });
    console.log("Post call state:", postCallVisible);
    if (postCallVisible.liveRoomPresent) throw new Error("Live room was not cleaned up after end call");
    if (!postCallVisible.postCallPresent) throw new Error("Post call panel did not appear");
    console.log("✓ End call cleanly closed session and displayed post-call options");

    console.log("\n==========================================");
    console.log("✓ SYNTHETIC-MEDIA PREVIEW CHECKS PASSED!");
    console.log("Scope: preview rendering + preview controls via user clicks.");
    console.log("Not verified here: human-confirmed audible conversation;");
    console.log("Privy-authenticated purchase and paid Ava session.");
    console.log("==========================================\n");
  } catch (error) {
    console.error("✖ Live avatar preview verification failed:", error?.message || error);
    throw error;
  } finally {
    try {
      if (context) await context.close();
    } catch {
      // ignore cleanup errors
    }
    await browser.close();
  }
}

await verifyLiveAvatar();
