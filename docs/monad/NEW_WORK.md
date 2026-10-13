# Archava Monad — Statement of New Work & Hackathon Delta

**Project**: Archava on Monad  
**Hackathon**: Monad Metropolis (Track 02 — Consumer Products & Payments)  
**Submission Date**: October 2026  
**Target Chain**: Monad Testnet (Chain ID `10143` / `0x279f`)  

---

## 1. Baseline & Clean Break Isolation

Archava originated as an exploration on BNB Testnet (`Archzxylabs/Archava`, pinned baseline commit `fc39413a0e1bf72e875f9ee59df2bcfbf64ead94`). 

For the Monad Metropolis Hackathon, a **complete architectural clean break** was established:
- **Independent Repository**: Dedicated workspace at `/home/pupulion/Archava-Monad`, completely decoupled from existing BNB repositories.
- **Dedicated Infrastructure**: Independent Vercel frontend project, dedicated Railway backend service with an isolated persistent volume mount (`/app/data`), dedicated LiveKit Cloud project (`archava-monad`), and dedicated worker agent (`archava-monad-host`).
- **Zero Legacy State Leakage**: Zero credential sharing, zero state carryover; independent usage ledger, key stores, and contract deployment manifests.
- **Strict Startup & Runtime Guards**: `server/runtime-target.mjs` and `backend/runtime_target.py` validate deployment scope, reject chain 97, enforce chain 10143, verify contract bytecode onchain, and fail closed if foreign configuration is detected.

---

## 2. Onchain Deployments & Monad Testnet Integration

Contracts were compiled, deployed, verified, and bound specifically to Monad Testnet:
- **Rental Contract (`ArchavaRentalV2`)**: [`0x7324a2678e74052a4e9a244c0d57b56b23fee6ad`](https://testnet.monadscan.com/address/0x7324a2678e74052a4e9a244c0d57b56b23fee6ad)
- **Payment Token (`ArchavaMockUSDT`)**: [`0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c`](https://testnet.monadscan.com/address/0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c)
- **Deployment Block**: `70191614`
- **Deployment Manifest**: `packages/contracts/deployments/monadTestnetV2.json`
- **Native Block Time / Finality**: Optimized scanner budget and log-splitting logic bound to Monad's 400ms block time and RPC query limits (`server/purchase-cache.mjs` and `server/rental.mjs`).

---

## 3. Selected Sponsor 1 — Privy Wallet Integration (Track 02)

To satisfy the Consumer Products & Payments track requirements for frictionless onboarding:
1. **Pinned SDK**: Integrated `@privy-io/react-auth@3.48.1` natively within the React/Vite architecture.
2. **Selected Provider Abstraction (`src/lib/wallet.ts`)**:
   - Centralized wallet provider abstraction replacing direct `window.ethereum` calls.
   - Embedded EOA creation configured directly for Monad Testnet (`10143`).
   - Unified support for both Privy embedded wallets (email/social) and external EOA wallets (MetaMask, Rabby).
3. **End-to-End Onboarding Flow**:
   - First-time user logs in via email/social → Embedded EOA generated on Monad Testnet.
   - Demo faucet claims 100 demo mUSDT.
   - Approval and package purchase execute through the selected embedded provider.
   - Signed session authorization and developer dashboard login use the same selected provider.
4. **Adversarial Invalidation & Security**:
   - `assertActiveContext()` enforces that provider and account cannot change mid-transaction.
   - Switching accounts or networks immediately terminates stale operations and releases locks.

---

## 4. Selected Sponsor 2 — Envio HyperIndex

To provide verified, real-time public purchase history and indexer observability:
1. **Dedicated Indexer Package (`packages/indexer`)**:
   - Configured with Envio HyperIndex 3.x (`config.yaml` and `schema.graphql`).
   - Listens to `AccessRented` events emitted by `ArchavaRentalV2` on Chain 10143 starting at block `70191614`.
   - Generates composite deduplication IDs: `${chainId}:${contractAddress}:${txHash}:${logIndex}`.
   - Event handlers implemented in `packages/indexer/src/EventHandlers.ts` with complete TypeScript typings.
2. **Backend History Service (`server/purchases.mjs`)**:
   - Endpoint `GET /api/purchases?wallet=...&limit=...&offset=...`.
   - Strict address validation via `isAddress()`, bounded pagination (1–50), and bounded fetch timeouts.
   - GraphQL credentials remain strictly server-side.
   - Exposes sync status metadata (`synced`, `indexing_lag`, `indexing`, `unavailable`) derived from the documented Envio `_meta` array, selected for chain 10143 explicitly.
3. **Authoritative Access Isolation**:
   - Envio supplies public history only.
   - Authoritative credit validation and room permissions remain bound to finalized RPC state. Indexer downtime never blocks customer access.
4. **Interactive UI on `/build`**:
   - Displays real-time purchase feed, package minutes, formatted mUSDT amounts, timestamps, and direct MonadScan links.
   - Accurately renders transaction stages (`PENDING`, `INDEXING`, `INDEXED`).

---

## 5. Verification & Test Evidence

All code modifications are backed by comprehensive, genuine regression and integration suites:
- **`npm test`**: 350 passed tests across 18 suites (including wallet provider abstraction, scanner budget, credit settlement, Envio history service, and adversarial race tests).
- **`npm run test:backend`**: 111 passing backend tests via `python -m unittest` (including room lifecycle, deployment scope isolation, session tokens, and key stores).
- **`npm run test:ui`**: 22/22 Playwright fixture checks passed (320px–1440px layouts, accessibility, focus trapping, persistent call controls, and clipboard operations).
- **`npm run build`**: TypeScript compilation and Vite production bundling passed with exit code 0.
- **`npm run preflight:readonly`**: Public deployment probe passed against local runtime, verifying API readiness, worker health, testnet quotes, and frontend routes.
- **Live Voice & Avatar Verification**: A synthetic-media preview run (`scripts/verify-live-avatar-session.mjs`) verifies Spatius AvatarKit canvas rendering, LiveKit cloud transport, remote audio playback evidence, and microphone control transitions. Human-confirmed audible conversation and paid sessions remain operator checks.
