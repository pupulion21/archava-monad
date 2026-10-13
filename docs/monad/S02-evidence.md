# S02 Evidence: Monad Smart Contract Deployment & Interface Specification

Dokumen bukti penyelesaian implementasi tahap **S02: Smart Contracts, Monad Testnet Deployment Tooling, Source Verification, and Canonical Interfaces**.

---

## 1. Project Boundaries & Constraints Compliance

| Parameter | Status | Catatan |
|---|---|---|
| **Independent Workspace** | COMPLIANT | Workspace `/home/pupulion/Archava-Monad` terisolasi sepenuhnya. |
| **Zero BNB/Production Leakage** | COMPLIANT | Tidak ada modifikasi atau push ke repo `Archzxylabs/Archava.git` atau `https://archava.vercel.app/`. RPC BSC ditolak ketat oleh guard dan deployer script. |
| **Target Chain** | COMPLIANT | Monad Testnet (Chain ID `10143`, native currency `MON`). |
| **Runtime Flag** | COMPLIANT | `ARCHAVA_RUNTIME_ENABLED=false` dipertahankan pada konfigurasi default. |
| **Live Broadcast Guard** | COMPLIANT | Operator belum memasukkan signer private key ke env; fail-closed guard mencegah broadcast tanpa kredensial valid dan saldo minimum MON. |

---

## 2. Implementasi Komponen S02

### A. Perbaikan Validasi RPC Monad (`scripts/verify-deployment-target.mjs`)
- **Struktur Config Aktual**: Membaca `networks.monadTestnet.rpcUrls.default.http` dan `networks.monadTestnet.rpcUrls.public.http` (array string) dari `config/networks.json`.
- **Operational RPC Single Point**: Menentukan satu operational RPC URL (`options.rpcUrl` || `env.MONAD_TESTNET_RPC_URL` || `config/networks.json` || `deployment-targets.monad.json`).
- **Deteksi BNB Akurat**: Deteksi hostname dan path segmen spesifik BSC (`binance.org`, `bscscan.com`, `data-seed-prebsc`, `/bsc`, dsb.). Endpoint Monad dengan API key atau query berisi string `"97"` (mis. `/v1/api97key`) diterima dengan benar.
- **Tanpa Shell Interpolation**: Request `eth_chainId` menggunakan native `fetch` async dengan `AbortSignal.timeout(5000)`.
- **Sanitasi Kredensial**: Fungsi `maskRpcUrl` menyembunyikan API key, secret, dan username/password pada log dan pesan error.
- **Strict Chain ID Assertion**: Memastikan respons HTTP 200, format JSON valid, ketiadaan JSON-RPC error, format result hex `0x`, dan nilai integer `10143`.

### B. Reuse Kontrak Solidity & Kompilasi
- **Kontrak**: [`packages/contracts/src/ArchavaMockUSDT.sol`](file:///home/pupulion/Archava-Monad/packages/contracts/src/ArchavaMockUSDT.sol) dan [`packages/contracts/src/ArchavaRentalV2.sol`](file:///home/pupulion/Archava-Monad/packages/contracts/src/ArchavaRentalV2.sol).
- **Kompilasi**: Solc `0.8.28`, `optimizer = true`, `optimizer_runs = 200`, EVM `cancun`.
- **Hasil Test Solidity**: 31 tests lulus (ArchavaRentalV2: 8 tests, ArchavaRental: 23 tests).

### C. Deployer Script Monad (`packages/contracts/scripts/deploy-monad-v2.ts`)
- Script: `npm --prefix packages/contracts run deploy:monad:v2`.
- Pre-flight validation:
  - Verifikasi RPC chain ID = 10143.
  - Resolusi deployer private key (`MONAD_DEPLOYER_PRIVATE_KEY` / `PRIVATE_KEY`).
  - Verifikasi address signer terhadap `EXPECTED_DEPLOYER_ADDRESS`.
  - Balance safety check: minimal 0.05 MON (memperhitungkan gas model Monad yang membebankan `gas_limit`).
- Progress tracking & Resume:
  - Disimpan di `.progress-monadTestnetV2.json`.
  - Jika token `ArchavaMockUSDT` sudah terdeploy dan terverifikasi di onchain, script me-reuse token tersebut tanpa membuat duplicate token.
- Onchain Read-Back:
  - Verifikasi bytecode token dan rental non-empty.
  - Verifikasi `decimals == 6`, `symbol == "mUSDT"`, `owner == expectedOwner`, `FAUCET_AMOUNT == 100_000_000n`.
  - Verifikasi `rental.owner == expectedOwner`, `paymentToken == tokenAddress`, `paused == false`.
  - Verifikasi kuotasi dan konfigurasi paket Starter (4.9375 mUSDT / 4,937,500 base units, 60 menit) dan Pro (18.6875 mUSDT / 18,687,500 base units, 300 menit).
- Manifest Generator: Menghasilkan manifest kanonis `monadTestnetV2.json`.

### D. Source Verification Script (`packages/contracts/scripts/verify-monad-v2.ts`)
- Script: `npm --prefix packages/contracts run verify:monad:v2`.
- Parameter: Solc `0.8.28`, optimizer 200 runs, evm-version `cancun`, ABI-encoded constructor arguments via `viem`.
- Verifiers:
  - Monadscan: `https://api-testnet.monadscan.com/api` (menggunakan `MONADSCAN_API_KEY` / `ETHERSCAN_API_KEY`).
  - Sourcify / BlockVision: `https://sourcify-api-monad.blockvision.org`.
- Toleransi Kegagalan: Kegagalan akibat rate limit explorer, indexing delay, atau ketiadaan API key tidak membatalkan atau merusak state deployment; status dicatat sebagai `pending` di manifest.
- Masking Kredensial: Logging aman tanpa mengekspos API key di stdout.

### E. Dokumentasi Antarmuka & Fixtures
- [`docs/monad/interfaces.md`](file:///home/pupulion/Archava-Monad/docs/monad/interfaces.md): Skema manifest kanonis, referensi ABI, event `AccessRented`, aturan kredit menit dan masa berlaku, serta struktur `/api/config`.
- [`docs/monad/fixtures/public-config.json`](file:///home/pupulion/Archava-Monad/docs/monad/fixtures/public-config.json): Fixture konfigurasi publik yang aman tanpa rahasia.

---

## 3. Hasil Pengujian & Verifikasi Aktual

### A. Target Verification Tests (`scripts/verify-deployment-target.test.mjs`)
- Perintah: `node --test scripts/verify-deployment-target.test.mjs`
- Hasil: **58 passed, 0 failed, 0 skipped**.
- Cakupan: Struktur `rpcUrls`, penolakan BSC domain/path, penerimaan Monad URL dengan key "97", masking credential, prioritas resolusi RPC, penolakan RPC non-10143, timeout, HTTP error, JSON error, dan hex malformed.

### B. Foundry Unit Tests (`packages/contracts`)
- Perintah: `npm --prefix packages/contracts test` (`forge test -vv`)
- Hasil: **31 passed, 0 failed, 0 skipped**.
  - `ArchavaRentalV2Test`: 8 passed.
  - `ArchavaRentalTest`: 23 passed.

### C. Vitest Deployment Tests (`packages/contracts`)
- Perintah: `npm --prefix packages/contracts run test:deployment`
- Hasil: **42 passed across 3 test files, 0 failed**.
  - `test/deployment-monad-v2.test.ts`: **33 passed**.
  - `test/deployment.test.ts`: **7 passed**.
  - `test/deployment-v2.test.ts`: **2 passed**.

### D. TypeScript Check
- Perintah: `npm --prefix packages/contracts run typecheck`
- Hasil: **0 errors**.

### E. CI Workflow Alignment
- File: [`.github/workflows/verify.yml`](file:///home/pupulion/Archava-Monad/.github/workflows/verify.yml)
- Langkah yang dijalankan:
  1. `npm run verify:target`
  2. `npm run verify:target:contracts`
  3. `npm run config:check`
  4. `npm run verify:local`
  5. `npm --prefix packages/contracts test`
  6. `npm --prefix packages/contracts run test:deployment`
  7. `npm --prefix packages/contracts run typecheck`
  8. `docker build -t archava:ci .`

---

## 4. Hasil Live Onchain Deployment (Monad Testnet)

Deployment berhasil dieksekusi langsung ke jaringan Monad Testnet (Chain ID 10143) oleh deployer `0xA9836DbD80F2852B8b135437e991C7cEdBa58c34`:

| Kontrak | Alamat Deployed | Block | Tx Hash | Source Verification |
|---|---|---|---|---|
| **ArchavaMockUSDT** | [`0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c`](https://testnet.monadscan.com/address/0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c) | `70191611` | `0x64f72246d76a43b7955ea40d023830c45879c5ab80742d1ae1f52cbd15d68241` | **Verified** (Sourcify Job: `8b5659c9-4266-4c5b-9cb3-1a3173f6a0eb`) |
| **ArchavaRentalV2** | [`0x7324a2678e74052a4e9a244c0d57b56b23fee6ad`](https://testnet.monadscan.com/address/0x7324a2678e74052a4e9a244c0d57b56b23fee6ad) | `70191614` | `0x9b17c810ece311149a7f436dd5e40a571843876b3aba2649063e58a78fbc2a44` | **Verified** (Sourcify Job: `b5e031ad-f78c-4bba-b670-6fac4cdba6b4`) |

- **Read-back Onchain**: Bytecodes non-empty, decimals 6, symbol `mUSDT`, faucet 100 mUSDT, rental owner & token linkage match, Starter (4.9375 mUSDT) & Pro (18.6875 mUSDT) quotes verified.
- **Manifest Kanonis**: Tersimpan di [`packages/contracts/deployments/monadTestnetV2.json`](packages/contracts/deployments/monadTestnetV2.json).

---

## 5. Status Milestone S02

- **Implementasi Kode & Tooling**: SELESAI (100%).
- **Automated Regression Tests**: SELESAI (100%, 42 Vitest tests + 31 Foundry tests + 58 Target tests PASS).
- **Live Onchain Deployment**: SELESAI (100%, Deployed on Monad Testnet block 70191611-70191614).
- **Source Verification**: SELESAI (100%, Verified via Sourcify / MonadVision).
- **Handoff Documentation & Interfaces**: SELESAI (`docs/monad/interfaces.md`, `docs/monad/fixtures/public-config.json`).
- **Langkah Berikutnya**: S03 (Integrasi API & State Management pada Monad Testnet).
