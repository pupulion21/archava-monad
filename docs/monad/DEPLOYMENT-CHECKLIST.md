# Archava Monad — Production Deployment Checklist

> [!IMPORTANT]
> This checklist covers the **new Monad repository** only.
> The original Archava (BNB, `archava.vercel.app`) must not be touched.
>
> Deployment order is: **new GitHub repository → Railway → Vercel → Envio Cloud.**
> GitHub repository creation, remote configuration, and push are operator-owned.

---

## Canonical References

| Parameter | Value |
|---|---|
| Network | Monad Testnet |
| Chain ID | `10143` / `0x279f` |
| Native token | `MON` |
| ArchavaRentalV2 | `0x7324a2678e74052a4e9a244c0d57b56b23fee6ad` |
| ArchavaMockUSDT (payment token) | `0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c` |
| Deployment block | `70191614` |
| Deployment scope | `archava-monad` |
| Worker agent name | `archava-monad-host` |
| LiveKit URL | `wss://receptionist-lwypqvqa.livekit.cloud` |
| Privy public App ID | `cmv6bk69u002z0fl8k77qer3t` |
| Spatius Avatar ID | `82d7dce9-ec05-4102-969f-2fe341af28cd` |

---

## Phase 0 — Pre-deployment Gate

- [ ] Unit + integration tests pass: `npm test` → **350 pass, 0 fail**
- [ ] Backend tests pass: `npm run test:backend` → **111 tests OK** (Python `unittest` via `scripts/test-backend.mjs`)
- [ ] UI checks pass: `npm run test:ui` → **22/22**
- [ ] Production build succeeds: `npm run build` → `dist/` emitted, avatar WASM copied
- [ ] Onchain contracts verified: `node scripts/verify-monad-onchain-contracts.mjs` → **PASS** (needs network + a running local API on `:5002`)
- [ ] Developer API flow verified: `node scripts/verify-developer-access-live.mjs` → **PASS** (needs a running local API)
- [ ] Live avatar preview verified: `node scripts/verify-live-avatar-session.mjs` → **PASS (8/8)**. Synthetic-media preview only; run with a warm voice worker. The harness emulates `prefers-reduced-motion` so the page's global smooth scrolling does not stall locator clicks.

---

## Phase 1 — Railway (Backend + Worker + built frontend)

### 1.1 Create the Railway service
- [ ] Create a new Railway project named `archava-monad`.
- [ ] Add **one** service: the API and the voice worker run in the same container via `entrypoint.sh`.
- [ ] Connect the **new Monad GitHub repository** (NOT the old Archava repo).
- [ ] Set the root directory to `/` (repo root).
- [ ] Build: Dockerfile at `Dockerfile` (matches `railway.json`).

### 1.2 Persistent volume
- [ ] Add a Railway **volume** mounted at `/app/data`.
- [ ] This holds the API-key digests and the paid-minute usage ledger.
- [ ] **Single-writer rule:** the store is file-based and is not safe for
      concurrent writers. Run exactly one replica (`numReplicas: 1` in
      `railway.json`). During a deployment transition, Railway starts the new
      container before stopping the old one, so briefly two processes can touch
      the volume — use Railway's zero-downtime/overlap settings only if the
      volume is not shared, otherwise stop the old container first. Never scale
      to two replicas.

### 1.3 Runtime environment (Railway variables)

> [!CAUTION]
> Never set `VITE_*` values as runtime secrets. `VITE_PRIVY_APP_ID` is a
> **build-time** value (see 1.4).

```
ARCHAVA_RUNTIME_ENABLED=true
PORT=5002
WEB_ORIGIN=https://<your-vercel-domain>.vercel.app
ARCHAVA_STATE_DIR=/app/data
ARCHAVA_AGENT_NAME=archava-monad-host
ARCHAVA_WORKER_HEALTH_URL=http://127.0.0.1:8081/

# LiveKit
LIVEKIT_URL=wss://receptionist-lwypqvqa.livekit.cloud
LIVEKIT_API_KEY=<from LiveKit dashboard>
LIVEKIT_API_SECRET=<from LiveKit dashboard>

# AI / Avatar
GEMINI_API_KEY=<from Google AI Studio>
GEMINI_MODEL=gemini-2.5-flash-native-audio-preview-12-2025
GEMINI_VOICE=Kore
AVATAR_PROVIDER=spatius
SPATIUS_API_KEY=<primary key>
# Optional fallback: same App ID / Avatar ID as the primary key, and only for
# exhausted credits, billing required, or HTTP 429.
SPATIUS_API_KEY_2=
SPATIUS_APP_ID=app_mv4vopzw_vkdggp
SPATIUS_AVATAR_ID=82d7dce9-ec05-4102-969f-2fe341af28cd

# Monad Testnet
CHAIN_ID=10143
# Optional: defaults to the public endpoint https://testnet-rpc.monad.xyz
RPC_URL=
RENTAL_CONTRACT=0x7324a2678e74052a4e9a244c0d57b56b23fee6ad
PAYMENT_TOKEN_CONTRACT=0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c
RENTAL_DEPLOYMENT_BLOCK=70191614

# Preview
ENABLE_PREVIEW=true
PREVIEW_SECONDS=120

# Envio (set in Phase 3)
ENVIO_GRAPHQL_URL=
ENVIO_API_KEY=
```

> [!NOTE]
> `PRIVY_APP_SECRET` and `DATABASE_URL` are **not consumed** by any implemented
> backend component and must not be required. Privy integration is frontend-only.
> The ledger and API-key store are **files** under `/app/data`, not a database.
> Tavus variables (`TAVUS_API_KEY`, `FACE_ID`, `PAL_ID`, `TAVUS_ENABLED`) are only
> needed if `AVATAR_PROVIDER=tavus`.

### 1.4 Docker build arguments (Railway)

The Dockerfile **does build the frontend**: the `frontend` stage runs
`npm run build` (after `COPY src public index.html …`) and declares
`ARG VITE_PRIVY_APP_ID`, which is baked into the browser bundle. There is no
separate frontend-only build; Railway's image is the one that ships `dist/`.

Per Railway's Dockerfile documentation, variables you define on the service are
injected at build time, but the Dockerfile must declare them with `ARG` **in the
stage where they are used** (here, the `frontend` stage):

- [ ] Add `VITE_PRIVY_APP_ID=cmv6bk69u002z0fl8k77qer3t` to the Railway service
      variables so the `frontend` stage receives it at build time.
- [ ] Confirm the build log shows the `frontend` stage running `npm run build`.
- [ ] It is a **public** value; never place an App Secret or any secret in `VITE_*`.

Reference: <https://docs.railway.com/builds/dockerfiles> → "Using variables at build time".

### 1.5 Verify the Railway deployment
- [ ] `GET https://<railway-url>/api/ready` → `{"ok":true,"checks":{"api":"ok","worker":"ok"}}`
- [ ] `GET https://<railway-url>/api/config` → chainId 10143, canonical addresses, `envioConfigured` once Phase 3 is done
- [ ] `GET https://<railway-url>/api/health` → `{"ok":true}`

---

## Phase 2 — Vercel (frontend)

### 2.1 Create the Vercel project
- [ ] Create a new Vercel project named `archava-monad` and connect the Monad GitHub repository.
- [ ] Framework: **Vite**; build command `npm run build`; output directory `dist`; root `/`.

### 2.2 Build environment variables (Vercel)

```
VITE_PRIVY_APP_ID=cmv6bk69u002z0fl8k77qer3t
```

> This is the only Vercel build variable required. It is the public Privy App ID,
> not a secret.

### 2.3 Update `vercel.json` rewrites
`vercel.json` proxies `/api/*` and `/v1/*` to the Railway backend.
- [ ] Replace `https://archava-monad-backend.up.railway.app` with the actual Railway service URL.

### 2.4 Set Railway `WEB_ORIGIN`
- [ ] After Vercel assigns a domain, set Railway `WEB_ORIGIN` to that exact HTTPS origin and redeploy Railway.

### 2.5 Privy allowed origins
- [ ] In the Privy Dashboard, add the **actual Vercel origin** to the app's Allowed Origins **before** testing public login.
- [ ] Keep the local development origin `http://localhost:5174` allowed.
- [ ] Redeploy/clear cache if the origin list changes, then verify the login modal opens on the deployed origin.

### 2.6 Verify the Vercel deployment
- [ ] `https://<vercel-url>/api/ready` proxies through to Railway → ok
- [ ] `https://<vercel-url>/api/config` → correct chain and addresses
- [ ] Frontend loads; Privy login modal opens; "Talk to Ava" preview is visible

---

## Phase 3 — Envio HyperIndex (Envio Cloud)

The installed `envio` CLI (`^3.14`) exposes `init`, `dev`, `stop`, `codegen`,
`local`, `start`, `metrics`, `skills`, `tools`, and `config`. It has **no
`login` or `deploy` command**. Deploy through Envio Cloud's git-based workflow:
<https://docs.envio.dev/docs/HyperIndex/hosted-service-deployment>.

### 3.1 Configure the indexer on Envio Cloud
1. Sign in at the Envio App with GitHub and install the Envio Deployments GitHub App for the new repository.
2. Click **Add Indexer** and connect the **new Monad repository**.
3. Set **root directory** to `packages/indexer` (monorepo). Ensure imports stay inside that directory.
4. Set the **config file path** to `config.yaml` and choose the deployment branch.
5. Confirm `packages/indexer/package.json` declares `envio` in `dependencies` and requires Node ≥ 24.
6. Push the deployment branch; Envio Cloud builds and indexes from the configured start block (`70191614`) and chain (`10143`).

### 3.2 Provision the endpoint and credentials
- [ ] From the Envio Cloud indexer, copy the **GraphQL endpoint URL**.
- [ ] If the deployment is private, copy the **API key**.
- [ ] Store both **server-side only** — never in `VITE_*` and never in the frontend bundle.

### 3.3 Update Railway
- [ ] Set `ENVIO_GRAPHQL_URL=<provisioned endpoint>`.
- [ ] Set `ENVIO_API_KEY=<key>` if the deployment is private.
- [ ] Redeploy Railway.

### 3.4 Verify
- [ ] `GET https://<vercel-url>/api/purchases?wallet=<any-wallet>` → `{"ok":true,...}`
- [ ] `sync.chainId` is `10143`; `sync.isReady` true; `sync.numBlocksBehind` small
- [ ] Records are scoped to the queried wallet and the canonical contract/deployment block

> [!NOTE]
> An unset `ENVIO_GRAPHQL_URL` is handled gracefully: `/api/purchases` returns a
> bounded `unavailable` result and authoritative credit is unaffected.

---

## Phase 3b — Populate `config/deployment-targets.monad.json`

The runtime guard (`server/runtime-target.mjs`) and the deploy guard
(`scripts/verify-deployment-target.mjs`) read this file. Fill it **only** with
values from the provisioned services; do not invent IDs or URLs.

- [ ] `git.remoteUrl` — the new repository's remote (required before `verify:target:push`).
- [ ] `hosting.frontend.provider` = `vercel`; set `projectId`, `projectName`, `productionDomain`.
- [ ] `hosting.backend.provider` = `railway`; set `projectId`, `environmentId`, `serviceId`, `serviceName`.
- [ ] `hosting.backend.publicUrl` — the canonical Railway origin that `vercel.json` rewrites to (required before `verify:target:deploy`).
- [ ] Keep `validation.requiredForPush` / `requiredForDeploy` / `requiredForRuntime` as-is.

Guards are preserved: known BNB project IDs/services and BNB RPC endpoints are
rejected, and an empty `publicUrl` fails the deploy guard instead of falling back
to a guessed host.

### Values only the operator can provide

These are the only externally-sourced values; do not invent them:

| Target | Value needed | Where it comes from |
|---|---|---|
| `config/deployment-targets.monad.json` | `git.remoteUrl` | New GitHub repository remote |
| `config/deployment-targets.monad.json` | `hosting.frontend.projectId` / `productionDomain` | Vercel project settings |
| `config/deployment-targets.monad.json` | `hosting.backend.projectId` / `environmentId` / `serviceId` / `publicUrl` | Railway project/service settings |
| `vercel.json` | real Railway origin replacing the placeholder | Railway public domain |
| Railway `WEB_ORIGIN` | real Vercel origin | Vercel production domain |
| Privy Dashboard | allowed origin | Vercel production domain |
| Railway `ENVIO_GRAPHQL_URL` / `ENVIO_API_KEY` | provisioned endpoint/key | Envio Cloud indexer |

---

## Phase 4 — Post-deployment verification

### 4.1 Live avatar preview
- [ ] Open `https://<vercel-url>/#catalog-section`; click **Talk to Ava**
- [ ] Avatar canvas renders; remote audio plays
- [ ] Mic toggles correctly and restores (MIC ON ↔ MUTED)
- [ ] End call closes the session and shows the post-call panel (before preview expiry)

### 4.2 Privy wallet flow
- [ ] Login → Google OAuth completes on the allowlisted origin
- [ ] Embedded wallet created/connected; network is Monad Testnet (`10143`)
- [ ] Dashboard opens after the wallet challenge signature; logout restores a clean state

### 4.3 Purchase flow (human operator wallet)
- [ ] Check MON balance; claim demo mUSDT via the faucet if eligible
- [ ] Read the 60-minute quote; approve the exact mUSDT amount to RentalV2
- [ ] Rent the pack → broadcast; hash persisted immediately
- [ ] Credit syncs after finalization; paid Ava session starts; usage deducts; teardown is clean

### 4.4 Developer API flow
- [ ] Open `/build`; connect wallet; sign the developer challenge
- [ ] `POST /api/developer/keys` → secret shown once; `GET /api/developer/keys` → no secret
- [ ] `GET /v1/usage` with the Bearer key → 200; `POST /api/developer/keys/:id/revoke` → revoked key then 401

### 4.5 Scanner resilience
- [ ] Under RPC throttling, credit status returns `503` with `code: "credit_sync_unavailable"` and recovers on retry

---

## Phase 5 — Rollout safety

| Step | Action |
|---|---|
| 1 | Deploy Railway at one replica; confirm health. |
| 2 | Test `/api/ready` and `/api/config` on the Railway URL. |
| 3 | Deploy Vercel; keep the old deployment until verified. |
| 4 | Update Railway `WEB_ORIGIN`; redeploy. |
| 5 | Add the Vercel origin to the Privy allowlist. |
| 6 | Run the Phase 4 checks on production. |
| 7 | Configure Envio Cloud; set `ENVIO_GRAPHQL_URL`; verify `/api/purchases`. |

> [!WARNING]
> **Never run two Railway replicas at once.** The file-based state in `/app/data`
> is not safe for concurrent writers.

---

## Phase 6 — Custom domain (optional)

- [ ] Add the domain to Vercel.
- [ ] Update Railway `WEB_ORIGIN` and redeploy.
- [ ] Add the custom domain to the Privy allowlist.

---

## Appendix — Fixes reflected in this revision

| File | Change |
|---|---|
| `server/purchases.mjs` | Selects the documented `_meta` array for chain 10143; validated per-chain sync status; bounded timeout covers fetch + body; secrets redacted |
| `server/purchases.test.mjs` | Regression coverage for correct chain, wrong chain, missing/malformed metadata, lag, foreign records, stalled body |
| `packages/indexer/schema.graphql` | `AccessRented` entity |
| `scripts/verify-live-avatar-session.mjs` | Normal Playwright locator clicks; both mic transitions + restoration; `RoomAudioRenderer` audio evidence; end-call guarded against preview expiry; cleanup in `finally` |
| `docs/monad/DEPLOYMENT-CHECKLIST.md` | Corrected Railway frontend build-arg behavior; file-based state; git-based Envio Cloud workflow; real developer routes; `deployment-targets.monad.json` instructions |
