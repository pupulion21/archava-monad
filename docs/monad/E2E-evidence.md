# Archava Monad — End-to-End Verification Evidence

> Generated: 2026-10-13
> Network: Monad Testnet · chainId 10143 / 0x279f
> Workspace: `/home/pupulion/Archava-Monad`

> [!IMPORTANT]
> This document records **observed** results only. Anything not executed is marked
> as pending/blocked. In particular, the headless preview run below is
> **synthetic-media preview verification** — it is not human-confirmed audible
> conversation and not a Privy-authenticated paid session.

---

## 1. Canonical Deployment (read-only, no redeployment)

| Parameter | Value |
|---|---|
| ArchavaRentalV2 | `0x7324a2678e74052a4e9a244c0d57b56b23fee6ad` |
| ArchavaMockUSDT (payment token) | `0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c` |
| Deploy block | 70191614 |
| Manifest | `packages/contracts/deployments/monadTestnetV2.json` |
| Privy public App ID | `cmv6bk69u002z0fl8k77qer3t` |
| Spatius Avatar ID | `82d7dce9-ec05-4102-969f-2fe341af28cd` |
| LiveKit URL | `wss://receptionist-lwypqvqa.livekit.cloud` |

---

## 2. Automated Test Suite Results (observed)

| Suite | Command | Result | Exit |
|---|---|---|---|
| Unit + integration (Node) | `npm test` | **350 pass / 0 fail** (18 suites) | `0` |
| Backend (Python) | `npm run test:backend` | **111 tests, OK** | `0` |
| Browser / accessibility (Playwright) | `npm run test:ui` | **22 / 22 checks pass** | `0` |
| Production build | `npm run build` | Vite bundle emitted, avatar WASM copied | `0` |

### 2a. Node test suites

Includes `wallet.test.ts`, `scanner-budget.test.mjs`, and the Envio purchase-history
regressions in `server/purchases.test.mjs` (16 tests) plus
`server/envio-integration.test.mjs` (2 tests).

### 2b. Backend runner (name is load-bearing)

`npm run test:backend` runs `scripts/test-backend.mjs`, which invokes
**`python -m unittest discover -s backend -p 'test_*.py'`** (i.e. the Python
`unittest` runner, not `pytest`). It uses `.venv/bin/python` when present, else
`python3`, and only forwards OS/runtime env vars into the tests.

### 2c. UI checks

`npm run test:ui` runs `scripts/ux-check.mjs` against built fixtures (22 checks).
These are **fixture-based checks, not live sessions**.

---

## 3. Onchain Contract Verification

Script: `scripts/verify-monad-onchain-contracts.mjs`
Result: **PASS** (exit `0`), run against a local runtime.

Verified against Monad Testnet (`10143`):
- `ArchavaRentalV2` at `0x7324a267…fee6ad` responds to ABI calls.
- `ArchavaRentalV2.paymentToken()` (the onchain getter) returns `0xe268ce1ad…b39c`. The backend surfaces the same value as the `paymentTokenAddress` field of `GET /api/config` — the two names are not interchangeable: `paymentToken()` is the contract method, `paymentTokenAddress` is the public config field.
- `ArchavaMockUSDT` is `mUSDT` with 6 decimals; `hasClaimed(address)` is callable.
- Package 1 = `4937500` base units (4.9375 mUSDT, 60 min), Package 2 = `18687500` base units (18.6875 mUSDT, 300 min), 30-day validity, active.

---

## 4. Developer API Flow

Script: `scripts/verify-developer-access-live.mjs`
Result: **PASS** (exit `0`), run against a local runtime.

Implemented routes exercised:

| Step | Route |
|---|---|
| Challenge | `POST /api/developer/challenge` |
| Login (sets dashboard cookie) | `POST /api/developer/login` |
| Create key (secret returned once) | `POST /api/developer/keys` |
| List keys (no secret) | `GET /api/developer/keys` |
| Authenticated usage | `GET /v1/usage` |
| Revoke | `POST /api/developer/keys/:id/revoke` |

The dashboard also implements `GET /api/developer/me` and
`GET /api/developer/usage` for the logged-in wallet.

Observed: challenge bound to Chain ID 10143 and deployment `archava-monad`; a
fresh key is issued (201) and its secret is absent from the list response; a
Bearer request to `GET /v1/usage` returns 200 with wallet-scoped usage; after
revocation the same Bearer key returns 401. No key value is printed in evidence.

---

## 5. Live Avatar Session — Synthetic-Media Preview

Script: `scripts/verify-live-avatar-session.mjs`
Scope: **free preview only**, headless Chromium with fake media devices.

Observed passing run (exit code `0`) against the locally running stack on `:5174`:

```
=== Verifying Real Live Avatar Session (synthetic-media preview) ===
[Scope: free preview with fake headless media. Not a human audible check. Not a paid session.]
1. Loading frontend at http://localhost:5174/
✓ 'Talk to Ava' button is visible
2. Clicking 'Talk to Ava' to initiate session (Playwright user click)...
✓ Preview session requested via user click
3. Waiting for live room container and avatar canvas...
✓ Live avatar room and canvas initialized in DOM
4. Waiting for Ava agent to connect and begin conversation...
Connecting... current state: "CONNECTING AVA" (0s)
Connecting... current state: "CONNECTING AVA" (5s)
✓ Agent reached speaking state: "AVA IS SPEAKING" (8s)
5. Verifying avatar canvas pixel rendering...
✓ Canvas visibly rendered: 666x442, PNG payload size: 306306 chars
6. Verifying remote audio evidence (RoomAudioRenderer)...
Audio evidence: {"count":1,"details":[{"paused":false,"currentTime":5.56,"readyState":4,"muted":false,"volume":1,"srcObjectActive":true}]}
✓ Remote audio element present with playback evidence (synthetic headless media; not human-confirmed audible)
7. Testing microphone mute/unmute with Playwright user clicks...
Initial mic state: text="MIC ON" aria-pressed="true" class="mic-control-btn active"
After first click: text="MUTED" aria-pressed="false"
✓ First microphone transition asserted
After second click (restored): text="MIC ON" aria-pressed="true"
✓ Microphone mute and unmute controls verified with restoration (Playwright clicks)
8. Testing end call with Playwright user click (before preview expiry)...
Preview timer before end-call: "00:56" (56s left)
✓ End call button clicked via Playwright user click
Post call state: { liveRoomPresent: false, postCallPresent: true }
✓ End call cleanly closed session and navigated to post-call panel

==========================================
✓ SYNTHETIC-MEDIA PREVIEW CHECKS PASSED!
==========================================
```

### Preview-budget measurement (single instrumented session)

| Stage | Observed |
|---|---|
| API session creation (`POST /api/preview` → 200) | ≈4 s |
| Room + avatar canvas in DOM | immediately after the response |
| Worker connection + avatar init (room → agent active) | ≈27 s cold; ≈8 s with a warm worker |
| Remote audio live | ≈4 s after agent active |
| Browser control interaction | ≈1–2 s per locator click |

### Demonstrated issue and fix (end-call)

The earlier end-call failures were **not** only a preview-budget problem: even
with 32 s remaining, a Playwright locator click on `button.end-call-btn` timed
out. Debug tracing showed the page sets a global `scroll-behavior: smooth`
(`src/styles.css`), so Playwright's `scrollIntoViewIfNeeded` + stability re-check
cycle stalled ~8–10 s per click and the bounded click timed out. The stylesheet
already sets `scroll-behavior: auto` under `@media (prefers-reduced-motion: reduce)`.

Fix: `scripts/verify-live-avatar-session.mjs` now launches its context with
`reducedMotion: "reduce"`, emulating a real user preference. Every interaction
remains a normal Playwright locator click — no force clicks, no JavaScript
clicks, no automatic expiry, and no increased preview duration. End-call was then
verified with 56 s remaining. Real users are unaffected; this only removes a
tooling actionability stall.

### What this run proves

| Claim | Evidence |
|---|---|
| Preview renders live avatar pixels | 666×442 canvas, ~306 k-char PNG dataUrl |
| Agent connects and reaches speaking state | `"AVA IS SPEAKING"` at ~8 s |
| Remote audio element is present with playback evidence | `readyState: 4`, `paused: false`, `currentTime: 5.56`, `srcObject` set |
| Mic mute/unmute works and is restored | Playwright clicks; `MIC ON → MUTED → MIC ON`, `aria-pressed` `true → false → true` |
| End call via a real user click | locator click at 56 s remaining; `#live-avatar-room` removed and `#post-call-panel` shown |

### What is NOT proven by this run

| Flow | Status | Reason |
|---|---|---|
| Human-confirmed audible conversation | ⏳ Pending | Synthetic media; a human must listen |
| Privy Google login | ⏳ Pending | OAuth redirect; performed by the operator in Brave |
| Purchase (approve + buy) and paid Ava session | ⏳ Pending | Requires a human wallet signature |

---

## 6. Wallet Lifecycle Fixes

Applied to source and covered by `wallet.test.ts` regression:

| Fix | File |
|---|---|
| Post-logout chain switch guard | `src/components/PrivyWalletBridge.tsx` |
| Epoch-aware event re-subscription | `src/App.tsx` |
| Account-change wallet update keeps the epoch consistent | `src/App.tsx` |

---

## 7. Envio / Purchase History Integration

### Local status: verified by regression tests

- `packages/indexer/config.yaml` — chain 10143, start block 70191614, canonical contract address.
- `packages/indexer/schema.graphql` — the **`AccessRented`** entity (there is no `Purchase` entity).
- `packages/indexer/src/EventHandlers.ts` — Envio v3 `indexer.onEvent`; compound id `${chainId}:${contractAddress}:${txHash}:${logIndex}`; wallet stored lowercase.
- `server/purchases.mjs` — GraphQL client that selects the documented **`_meta` array** for chain 10143 explicitly and derives sync status; buyer-wallet and deployment-scope validation; compound-id deduplication; bounded fetch+body timeout.
- `server/purchases.test.mjs` + `server/envio-integration.test.mjs` — 18 tests covering correct chain, wrong chain, missing/malformed metadata, indexing lag, foreign records, stalled body, and authoritative-credit isolation.

The installed `envio` CLI (v3.14) exposes `init`, `dev`, `stop`, `codegen`,
`local`, `start`, `metrics`, `skills`, `tools`, and `config` — it has **no
`login` or `deploy` command**. Deployment is therefore the git-based Envio Cloud
workflow (see `DEPLOYMENT-CHECKLIST.md`, Phase 3).

### Cloud status: pending operator deployment

`ENVIO_GRAPHQL_URL` is not set in the local environment, so `/api/config`
reports `envioConfigured: false` and `GET /api/purchases` returns a bounded
`503`/`unavailable` result by design. **Live Envio integration is pending** and
has not been validated against a real GraphQL endpoint.

> [!NOTE]
> Envio history is separate from authoritative finalized credit. The scanner
> (`server/purchase-cache.mjs` / `server/rental.mjs` over finalized RPC state) is
> the source of truth for billing. Envio provides the user-facing purchase
> history feed only; indexer downtime never blocks paid access.

---

## 8. Implementation Notes (current state)

| Area | State |
|---|---|
| `scripts/verify-live-avatar-session.mjs` | Uses normal Playwright locator clicks for preview, mic, and end-call; asserts both mic transitions and restoration; asserts `RoomAudioRenderer` `<audio>` playback evidence; guards end-call against preview expiry; cleans up context/browser in `finally`. Emulates `reducedMotion: "reduce"` so the page's global `scroll-behavior: smooth` does not stall locator actionability (no force/JS clicks). All 8 checks pass. |
| `server/purchases.mjs` | `_meta(where: { chainId: { _eq: $chainId } })` array shape; validated per-chain metadata; single deadline covering fetch and body read; timers cleared in `finally`; secrets redacted from public errors |
| `packages/indexer` | `AccessRented` entity; compound event ids |
| `server/envio-integration.test.mjs` | Envio failure cannot grant or remove authoritative paid access |

---

## 8b. Human Wallet Acceptance Test (local — pending operator)

Preconditions checked locally:

- API (`node server/index.mjs`), voice worker (`backend/agent.py start`), and Vite (`:5174`) each run as a **single** instance; `/api/ready` = `{"ok":true,"checks":{"api":"ok","worker":"ok"}}`.
- Pre-wallet endpoints healthy: `GET /api/quote?minutes=60` → 4.9375 mUSDT; `GET /api/access` → zero balance for a fresh wallet; `POST /api/challenge` → nonce message bound to chain 10143 / `archava-monad`.
- CORS: foreign origin rejected (`403`); `http://localhost:5174` allowed.
- `VITE_PRIVY_APP_ID` is served to the frontend (Privy login enabled).
- The app was opened in the operator's existing Brave session (`brave --new-tab http://localhost:5174/`).

The operator performs every account login and wallet confirmation in Brave. No
scripted wallet is substituted. Record each row's observed outcome; unperformed
rows stay **pending**.

| # | Step | Expected observation | Result |
|---|---|---|---|
| 1 | Privy Google login | Privy modal completes without console error | Pending |
| 2 | Wallet + network | Embedded/connected wallet on Monad Testnet `10143` | Pending |
| 3 | Developer challenge signing (`/build`) | Signature accepted; dashboard unlocks | Pending |
| 4 | API key management | Key created (secret once), listed masked, revoked → `401` | Pending |
| 5 | mUSDT faucet claim (if eligible) | `hasClaimed` false → claim; balance `+100 mUSDT` | Pending |
| 6 | Exact token approval | Approve amount equals quote (4.9375 mUSDT for 60 min) | Pending |
| 7 | Purchase (rent 60 min) | Tx broadcast; hash persisted; `/api/purchase/status` → `awaiting_credit` | Pending |
| 8 | Pending recovery | Reload keeps pending hash; recovers to credited | Pending |
| 9 | Finalized credit for this tx + buyer | `GET /api/access` → active, 60 min; only this tx credited | Pending |
| 10 | Paid Ava session with human-confirmed audio | Human hears Ava in Brave | Pending |
| 11 | Session teardown + usage | End call; remaining minutes deducted accurately | Pending |

---

## 9. Deployment Readiness

Full instructions: [`docs/monad/DEPLOYMENT-CHECKLIST.md`](DEPLOYMENT-CHECKLIST.md).

### Environment variables actually consumed

The application consumes the variables listed in `.env.example`. Notable points:

- `PRIVY_APP_SECRET` and `DATABASE_URL` are **not consumed** by any implemented
  backend component and must not be required. Privy integration is frontend-only
  (`VITE_PRIVY_APP_ID`, a public value).
- The usage ledger and API-key store are **file-based** under `ARCHAVA_STATE_DIR`
  (`/app/data` in the container), backed by a Railway persistent volume.
- `SPATIUS_API_KEY_2` is an **optional** fallback.
- Secrets must never be placed in `VITE_*` variables.

### Config

- `config/deployment-targets.monad.json` — populate the Git remote, hosting IDs,
  and backend `publicUrl` after provisioning (see the checklist). Existing guards
  reject BNB identifiers and empty deploy values instead of guessing.

### Operator tasks remaining

- [ ] Create the new GitHub repository and push (operator-owned).
- [ ] Create Railway project/service; set runtime secrets; mount `/app/data`.
- [ ] Provide the Docker build arg `VITE_PRIVY_APP_ID` on Railway (the image builds the frontend).
- [ ] Deploy the frontend to Vercel; add the Vercel origin to the Privy allowlist.
- [ ] Deploy `packages/indexer` via Envio Cloud; set `ENVIO_GRAPHQL_URL`/`ENVIO_API_KEY` on Railway.
- [ ] Perform the live Privy login, purchase, and paid-session flow.

---

## 10. Summary

| Milestone | Status |
|---|---|
| Unit + integration tests | ✅ 350 pass |
| Python backend tests | ✅ 111 pass (`python -m unittest`) |
| UI checks | ✅ 22 pass |
| Production build | ✅ Success |
| Onchain contract verification | ✅ PASS |
| Developer API key flow | ✅ PASS |
| Envio integration (local tests) | ✅ 18 tests pass |
| Live avatar preview (synthetic media) | ✅ 8/8 checks pass (end-call verified via locator click) |
| Human wallet acceptance (local) | ⏳ Pending operator (see 8b) |
| Envio Cloud endpoint | ⏳ Pending operator |
| Privy login (human-confirmed) | ⏳ Pending operator |
| Purchase + paid session | ⏳ Pending operator |
| Railway / Vercel deployment | ⏳ Pending operator |
