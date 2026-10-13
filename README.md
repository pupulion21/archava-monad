# Archava on Monad

**AI Avatars, On Demand. Onchain.** A self-serve conversational AI avatar platform built natively for Monad Testnet. Visitors can interact with the live avatar without a wallet in free preview mode. Paid calls unlock extended conversations with minute packs purchased with demo mUSDT on Monad Testnet.

This is an **independent deployment** specifically for Monad Metropolis. It uses dedicated Monad contracts, isolated state storage, a dedicated LiveKit project, and integrated sponsor technologies (**Privy** embedded wallets and **Envio HyperIndex** event indexing).

---

## Canonical Deployment on Monad Testnet

| Component | Identifier / Address |
| --- | --- |
| **Network** | Monad Testnet (`10143` / `0x279f`) |
| **RPC Endpoint** | `https://testnet-rpc.monad.xyz` |
| **Block Explorer** | `https://testnet.monadscan.com` |
| **Rental Contract (RentalV2)** | [`0x7324a2678e74052a4e9a244c0d57b56b23fee6ad`](https://testnet.monadscan.com/address/0x7324a2678e74052a4e9a244c0d57b56b23fee6ad) |
| **Payment Token (mUSDT)** | [`0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c`](https://testnet.monadscan.com/address/0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c) |
| **Deployment Block** | `70191614` |
| **Deployment Manifest** | `packages/contracts/deployments/monadTestnetV2.json` |
| **Deployment Scope** | `archava-monad` |
| **Worker Agent** | `archava-monad-host` |
| **LiveKit URL** | `wss://receptionist-lwypqvqa.livekit.cloud` |

---

## Key Features & Implementations

### 1. Core Live Voice & Avatar Flow
- **Spatius Live Avatar & Gemini Realtime Voice**: In-browser video rendering via Spatius AvatarKit Web SDK combined with Gemini multimodal live voice agent streaming through LiveKit Cloud.
- **Dual Flow (Free Preview & Onchain Paid)**:
  - *Anonymous Live Preview*: 120-second session for visitors without needing a wallet, signature, or token.
  - *Onchain Paid Access*: 60-minute and 300-minute packs purchasable using demo mUSDT.
- **Bidirectional Section Awareness**: Ava observes the visitor's currently viewed site section and can smoothly navigate or discuss specific features in real time.
- **Durable Metering Ledger**: Offchain single-writer ledger in `data/usage.json` tracking room allocations, minute deductions, and automatic refund of unconsumed minutes upon early disconnect.

### 2. Track 02 Sponsor: Privy Wallet Integration
- **Seamless Onboarding**: Integrated `@privy-io/react-auth` supporting email, social login, and automatic Monad embedded EOA creation.
- **Selected Provider Abstraction (`src/lib/wallet.ts`)**: Unified interface connecting Privy embedded EOAs and external wallets (MetaMask, Rabby) to checkout, demo token faucet, session authorization signatures, and developer dashboard login.
- **Strict Execution Isolation**: Account and chain switches mid-flow immediately invalidate stale locks, preventing accidental cross-wallet authorization.

### 3. Indexer Sponsor: Envio HyperIndex
- **Dedicated Indexer Package (`packages/indexer`)**: Built with Envio HyperIndex 3.x, tracking `AccessRented` events emitted by `ArchavaRentalV2` starting at block `70191614`.
- **Backend History Service (`server/purchases.mjs`)**: Endpoint `GET /api/purchases?wallet=...` providing authenticated, deduplicated, and bounded pagination.
- **Authoritative Credit Isolation**: Envio feeds public transaction history and synchronization metadata (`_meta`). Authoritative access permissions remain strictly bound to direct finalized onchain contract state, ensuring indexer latency never blocks paid usage.
- **Interactive Feed on `/build`**: Displays indexed purchases with direct MonadScan explorer links and visual indicators for pending, syncing, or offline states.

### 4. Developer Dashboard & Session API
- **Challenge-Response Wallet Signatures**: Purpose-bound authentication messages prevent cross-context replay attacks.
- **Backend Session API (`POST /v1/sessions`)**: Allows external applications to mint ephemeral room tokens using an API key without exposing customer credentials to the browser.

---

## Local Development & Quickstart

Repository: [pupulion21/archava-monad](https://github.com/pupulion21/archava-monad), deployment branch `main`.

```bash
git clone https://github.com/pupulion21/archava-monad.git
cd archava-monad
```

The Foundry test library is vendored in `packages/contracts/lib/forge-std`, with its upstream license files included. No Git submodule initialization is required. Local credentials, runtime state, test-generated stores, diagnostics, and the nested legacy checkout are excluded from version control and deployment uploads.

### Prerequisites
- Node.js 22.18+ (npm 10+)
- Python 3.12 or 3.13 (with `uv` recommended)
- Google Chrome or Microsoft Edge (supporting `RTCRtpScriptTransform` for Spatius avatar streaming)

### 1. Setup Environment
```bash
npm ci
cp .env.example .env
# Fill provider credentials (LIVEKIT_URL, GEMINI_API_KEY, SPATIUS_API_KEY, etc.)
# Set ARCHAVA_RUNTIME_ENABLED=true
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r backend/requirements.txt
```

### 2. Verify Runtime Configuration
```bash
npm run verify:target:runtime
```

### 3. Launch Services
Run the following in separate terminal sessions:
```bash
# Terminal 1: Node.js API server (port 5002)
npm run api

# Terminal 2: Vite Frontend Dev Server (port 5174)
npm run dev

# Terminal 3: Python Voice Worker Daemon (port 8081)
.venv/bin/python backend/agent.py dev
```

Visit `http://localhost:5174` in your browser.

For Spatius, `SPATIUS_API_KEY_2` is an optional backend-only fallback. At the start of a call, the worker tries the primary key and tries the secondary once if the Spatius SDK reports exhausted credits, billing required, or HTTP 429. Both keys must authorize the configured `SPATIUS_APP_ID` and `SPATIUS_AVATAR_ID`. Invalid app/avatar settings and network failures do not rotate keys. Failed attempts are closed before retrying; this does not switch credentials during an active call or replenish a shared credit balance. Restart the API and worker after changing the avatar or credentials. See the [LiveKit Spatius plugin reference](https://docs.livekit.io/reference/python/livekit/plugins/spatius/avatar.html).

### 4. Configure Privy onboarding

Set `VITE_PRIVY_APP_ID` in your local `.env` to the public App ID from the app you selected in the [Privy Dashboard](https://dashboard.privy.io/). Restart Vite after an env change. The frontend uses the login methods enabled in that app's dashboard; enable Email and Wallet, and enable Google if Google login is desired. Privy's default Google OAuth credentials can be used for development; custom Google Client ID/secret are entered in the dashboard, separately from Privy's App Secret.

If configuring allowed origins for local testing, include the exact origin `http://localhost:5174`. Add the actual Monad frontend's HTTPS origin for deployment. The frontend already sets Monad Testnet (`10143`) as its default and supported chain and creates an embedded EOA for users without wallets.

The current API verifies signed wallet challenges and onchain entitlements. It does not consume Privy access tokens or call the Privy server API, so this integration does not require `PRIVY_APP_SECRET`. A future Privy server SDK/REST integration requires separate backend configuration; its secret must stay server-side and must never use a `VITE_` prefix.

Check the login modal, then test email OTP login and confirm an embedded wallet is created on Monad Testnet. Loading the public app configuration alone does not prove successful login or wallet creation. For deployment, set the public `VITE_PRIVY_APP_ID` in Vercel and in the Docker frontend build, then rebuild.

To manage developer API keys, open the dashboard after connecting your wallet and click **Sign developer challenge**. Confirm in the Privy wallet prompt or your external wallet. This signature costs no gas. Cancelling returns to the dashboard; closing it stops the pending sign-in, and a two-minute timeout lets you retry a stalled prompt.

References: [React setup](https://docs.privy.io/basics/react/setup), [login methods](https://docs.privy.io/basics/get-started/dashboard/configure-login-methods), [allowed origins](https://docs.privy.io/recipes/dashboard/allowed-domains), [server SDK setup](https://docs.privy.io/basics/nodeJS/setup).

---

## Testing & Verification

The repository includes a comprehensive, multi-layer verification suite:

```bash
# 1. Run all unit and regression test suites (350 tests across 18 suites)
npm test

# 2. Run backend tests (111 Python unittest tests via scripts/test-backend.mjs)
npm run test:backend

# 3. Run browser and accessibility fixture checks via Playwright (22 checks)
npm run test:ui

# 4. Compile frontend and check TypeScript types
npm run build

# 5. Public read-only preflight check against a running server
npm run preflight:readonly -- --origin http://localhost:5002
```

---

## Deployment Architecture

- **Frontend**: Vercel (`dist/` output, rewrites `/api/*` and `/v1/*` to the Railway backend).
- **Backend & Worker**: Single Docker container orchestrated via `entrypoint.sh` on Railway.
  - Mounts persistent volume at `/app/data` (`ARCHAVA_STATE_DIR=/app/data`).
  - Worker health monitored on `http://127.0.0.1:8081/`.
  - Health check endpoint at `/api/ready` confirms both API and voice worker readiness.
- **Indexer**: `packages/indexer` deployed to Envio Cloud (git-based, root directory `packages/indexer`) feeding `ENVIO_GRAPHQL_URL`.

> [!NOTE]
> The Railway image builds the frontend in the Dockerfile's `frontend` stage and consumes `ARG VITE_PRIVY_APP_ID` at build time; there is no separate frontend-only build.

For full deployment and rollback procedures, refer to [`docs/monad/S07-evidence.md`](docs/monad/S07-evidence.md) and [`plans/archava-monad-metropolis.md`](plans/archava-monad-metropolis.md).
