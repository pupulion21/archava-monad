# Archava Monad — S05 Privy Integration Evidence

## 1. Overview and Track Requirements

- **Primary Track**: Track 02 — Consumer Products & Payments ($30,000 pool).
- **Sponsor Bounty**: Privy — Wallet integration on Monad ($5,000 bounty).
- **Target Network**: Monad Testnet, Chain ID `10143` (`0x279f`).
- **Core Requirement**: Seamless email/social onboarding with embedded EOA wallets on Monad Testnet, preserving external Web3 wallet connectivity under a unified selected-provider abstraction.
- **Entitlement Rule**: Privy authentication does not grant free minutes, gas, or tokens. Entitlement remains 100% authoritative onchain (RentalV2 contract `0x7324a2678e74052a4e9a244c0d57b56b23fee6ad` and server usage ledger).

---

## 2. Pinned Dependencies & SDK Setup

- **Pinned SDK**: `@privy-io/react-auth` version `3.48.1`.
- **Framework Compatibility**: React 18.3.1 + Vite 5.4.x.
- **Monad Testnet Chain Specification** (`MONAD_PRIVY_CHAIN` in `src/lib/wallet.ts`):
  - Chain ID: `10143`
  - Name: `"Monad Testnet"`
  - Network: `"monad-testnet"`
  - Native Currency: `{ name: "MON", symbol: "MON", decimals: 18 }`
  - RPC URL: `https://testnet-rpc.monad.xyz`
  - Explorer: `https://testnet.monadscan.com`
  - Testnet: `true`

---

## 3. Selected Provider Abstraction

Architecture implemented in `src/lib/wallet.ts`:
1. **Single Active Provider Registry**:
   - `setSelectedWallet({ provider, address, type, chainId })`
   - `getSelectedWallet()`: Returns active selected wallet metadata.
   - `getSelectedWalletProvider()`: Returns the active EIP-1193 provider.
   - `disconnectWallet()`: Atomically unsets active wallet and invalidates operations.
   - `getWalletEpoch()`: Monotonically increasing epoch counter incremented whenever active provider or address transitions.
2. **Unified Provider Resolution**:
   - `getEthereumProvider()` returns `activeSelectedWallet.provider` when set.
   - Falls back cleanly to `window.ethereum` when no Privy session is active.
   - `createOperationContext()` asserts that active provider and address match expected identity.
   - `assertActiveContext()` checks against `activeSelectedWallet.provider` directly, preventing mid-flow wallet or provider swapping.
3. **Consumer Integration**:
   - `injectedProvider()` in `src/lib/rental.ts` uses `getBrowserProvider()` which delegates to `getEthereumProvider()`.
   - `signChallengeMessage()` in `src/lib/developer.ts` signs with the selected provider signer.
   - `startAvatarSession()` in `src/lib/rental.ts` signs the room authorization challenge using the active selected provider.
   - `buyMinutePack()` and `claimDemoUsdt()` execute contract calls (`approve`, `rent`, `faucet`) strictly on the selected provider.

---

## 4. Privy Lifecycle & External Wallet Fallback

Implemented in `src/main.tsx`, `src/lib/privy.ts`, `src/components/PrivyWalletBridge.tsx`, and `src/App.tsx`:
- **Conditional Mounting**:
  - If `VITE_PRIVY_APP_ID` is present: wraps application in `<PrivyProvider>` with `defaultChain={MONAD_PRIVY_CHAIN}` and `embeddedWallets={{ ethereum: { createOnLogin: 'users-without-wallets' } }}`.
  - If `VITE_PRIVY_APP_ID` is unset or empty: renders `<App />` directly with zero runtime overhead or warnings.
- **State Synchronization (`PrivyWalletBridge`)**:
  - Automatically extracts EIP-1193 provider from the connected Privy wallet via `wallet.getEthereumProvider()`.
  - Switches chain to Monad Testnet (`10143`).
  - Registers provider via `setSelectedWallet`.
  - Invalidates in-flight operations on logout or account switch via `operationController.invalidate("privyLogout")`.
- **External Wallet Preservation**:
  - Users without Privy or visitors who prefer external extensions (MetaMask, Rabby, Coinbase) connect via `connectExternalWallet()`.
  - `connectExternalWallet()` registers the external provider via `setSelectedWallet({ provider, address, type: "injected" })`.

---

## 5. Build & Environment Packaging

- **Docker Build**:
  - `Dockerfile` includes `ARG VITE_PRIVY_APP_ID` and `ENV VITE_PRIVY_APP_ID=$VITE_PRIVY_APP_ID` in the `frontend` stage to bake the public app ID into the client bundle at build time.
- **Vercel Deployments**:
  - Reads `VITE_PRIVY_APP_ID` at build time without exposing application secret.
- **Documentation**:
  - `.env.example` documents `VITE_PRIVY_APP_ID` under `PRIVY WALLET AUTHENTICATION`.

---

## 6. Regression Test Evidence

- `src/lib/wallet.test.ts`:
  - `setSelectedWallet and getSelectedWallet manage active wallet and provider cleanly`: PASS.
  - `MONAD_PRIVY_CHAIN adheres to Monad Testnet 10143 specifications`: PASS.
  - `createOperationContext and assertActiveContext enforce selected provider and account`: PASS.
- Full Suite Verification:
  - `npm test`: 324 tests passing across 18 suites (0 failures).
  - `npm run test:ui`: 20/20 UI checks passing.
  - `npm run build`: Production bundle built successfully with Vite.
