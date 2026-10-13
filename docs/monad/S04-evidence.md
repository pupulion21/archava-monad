# S04 Implementation & Verification Evidence: Monad Frontend & Wallet Integration

**Document Version**: 3.0.0  
**Date**: 12 Oktober 2026  
**Target Network**: Monad Testnet (Chain ID: `10143`, Hex: `0x279f`, Native Token: `MON`)  
**Workspace**: `/home/pupulion/Archava-Monad`  
**Status**: **VERIFIED COMPLETE (All 5 Initial S04 Findings + 3 Residual Findings Resolved)**

---

## 1. Executive Summary

Milestone **S04** menyelesaikan integrasi antarmuka frontend Archava dengan wallet Web3 eksternal (MetaMask, Rabby via EIP-1193) dan backend Monad Testnet yang telah diselesaikan pada S03, serta **memperbaiki secara tuntas lima temuan awal S04 dan tiga residual findings**.

Seluruh pekerjaan dilakukan secara terisolasi di workspace `/home/pupulion/Archava-Monad` tanpa mengubah repository BNB lama (`Archzxylabs/Archava`), hosting Vercel lama (`archava.vercel.app`), ataupun deployment state BNB lama.

### Canonical Monad Testnet Deployment Parameters

| Parameter | Nilai Onchain Monad Testnet |
|---|---|
| **Network Name** | Monad Testnet |
| **Chain ID (Decimal)** | `10143` |
| **Chain ID (Hex)** | `0x279f` |
| **Native Token** | `MON` (18 decimals) |
| **Public RPC URL** | `https://testnet-rpc.monad.xyz` |
| **Block Explorer** | `https://testnet.monadscan.com` |
| **ArchavaRentalV2** | `0x7324a2678e74052a4e9a244c0d57b56b23fee6ad` |
| **ArchavaMockUSDT** | `0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c` |
| **Rental Deployment Block** | `70191614` |
| **Mock USDT Decimals / Symbol** | `6` / `mUSDT` |
| **Starter Package (ID 1)** | `4,937,500` base units (4.9375 mUSDT), 60 menit |
| **Pro Package (ID 2)** | `18,687,500` base units (18.6875 mUSDT), 300 menit |
| **Manifest Path** | `packages/contracts/deployments/monadTestnetV2.json` |

---

## 2. Resolusi Tiga Residual Findings S04

### Residual 1 (P1): Auto Network Switch Membuat Checkout Terkunci

- **Lokasi Kode**:
  - [`src/lib/operationLock.ts`](file:///home/pupulion/Archava-Monad/src/lib/operationLock.ts) *(Modul baru untuk ownership-token lock)*
  - [`src/App.tsx`](file:///home/pupulion/Archava-Monad/src/App.tsx)
  - [`src/lib/rental.ts`](file:///home/pupulion/Archava-Monad/src/lib/rental.ts)
- **Akar Masalah**:
  - Ketika wallet pengguna berada pada chain non-Monad (misalnya BSC 97), auto-switch jaringan yang diinisiasi oleh helper checkout (`ensureMonadChain`) memicu event `chainChanged`.
  - Event `chainChanged` menaikkan `epochRef`. Namun karena lock operasi sebelumnya diambil sebelum switch jaringan, callback `handleBuy` menganggap operasi tersebut stale dan melewati blok pelepasan loading pada `finally`.
  - Akibatnya, UI terkunci pada status loading "buy" dan tombol checkout tidak dapat diklik kembali.
- **Implementasi Perbaikan**:
  1. **Pemisahan Fase Persiapan Jaringan dan Eksekusi Terkunci**:
     - Memisahkan tahap persiapan (`await ensureMonadChain()`) dari tahap perolehan lock (`operationController.acquire(...)`).
     - Switch jaringan awal yang memang diminta oleh aplikasi dijalankan terlebih dahulu hingga selesai.
  2. **Ownership-Token Operation Lock (`OperationController` & `OperationLock`)**:
     - Setiap lock memiliki `ownerId` unik (`op_<type>_<timestamp>_<rand>`), mengikat tipe operasi, target wallet, dan snapshot epoch yang valid *setelah* persiapan selesai.
     - Pelepasan lock (`lock.release()`) hanya dapat dilakukan oleh pemilik token tersebut. Operasi lama yang tertunda tidak dapat melepaskan lock milik operasi baru yang sedang aktif.
     - Jika terjadi perpindahan jaringan atau akun yang tidak diharapkan di tengah-tengah transaksi, `assertActiveContext` membatalkan eksekusi, dan lock milik operasi tersebut dibersihkan secara aman tanpa mengunci UI.
- **Regression Tests**:
  - `src/lib/s04-findings-regression.test.ts`:
    - `Residual 1 / Temuan 3: initial wrong network -> auto-switch succeeds -> checkout completes -> lock and loading clean`
    - `Residual 1 / Temuan 3: user rejects network switch -> lock and loading cleared cleanly`
    - `Residual 1 / Temuan 3: unexpected chain change during approval -> rent not sent and lock released`
    - `Residual 1 / Temuan 3: old operation finishing after new operation active does not release new lock`
    - `Residual 1 / Temuan 3: late avatar session for invalidated wallet is discarded and immediately closed on backend`

---

### Residual 2 (P2): Status Pembelian Tidak Mengikat Transaksi ke Buyer Wallet

- **Lokasi Kode**:
  - [`server/purchase-cache.mjs`](file:///home/pupulion/Archava-Monad/server/purchase-cache.mjs)
  - [`server/app.mjs`](file:///home/pupulion/Archava-Monad/server/app.mjs)
  - [`server/dependencies.mjs`](file:///home/pupulion/Archava-Monad/server/dependencies.mjs)
- **Akar Masalah**:
  - `GET /api/purchase/status` sebelumnya hanya memeriksa keberadaan `txHash` di dalam cache dan mengembalikan parameter `wallet` dari request tanpa memvalidasi apakah wallet tersebut adalah pembeli sebenarnya.
  - Hal ini membuka celah di mana wallet lain (Bob) dapat mengklaim transaksi pembelian milik Alice hanya dengan mengetahui hash transaksinya.
- **Implementasi Perbaikan**:
  1. **Event Metadata Persistence di Scanner Cache**:
     - `purchase-cache.mjs` diperbarui (`schemaVersion: 1`) untuk menyimpan metadata event (`buyer`, `packageId`, `purchasedMinutes`, `blockNumber`) bersama event key.
  2. **Verifikasi Kepemilikan Transaksi (`isTxCreditedForWallet`)**:
     - `hasTx(txHash, expectedWallet)` memvalidasi bahwa event dalam cache cocok dengan `expectedWallet`.
     - Jika transaksi belum ada dalam memory cache, `isTxCreditedForWallet` melakukan verifikasi bounded receipt langsung ke provider:
       - Memastikan `receipt.to` cocok dengan kontrak canonical Monad RentalV2 (`0x7324a2678e74052a4e9a244c0d57b56b23fee6ad`).
       - Memastikan status receipt sukses (`status === 1`).
       - Memastikan blok transaksi sudah berada di dalam batas finalitas (`receipt.blockNumber <= cursor.lastFinalizedBlock`).
       - Memparsing event `AccessRented` dan memastikan parameter `buyer` cocok dengan `expectedWallet`.
  3. **Strict Binding pada Endpoint Status**:
     - `GET /api/purchase/status` memanggil `isTxCreditedForWallet(txHash, wallet)`. Jika wallet tidak cocok dengan pembeli onchain, mengembalikan `{ ok: true, credited: false, reason: "wallet_mismatch" }`.
- **Regression Tests**:
  - `server/purchase-cache.test.mjs`:
    - `hasTx matches buyer wallet and rejects mismatched wallet`
    - `isTxCreditedForWallet verifies receipt and event buyer against canonical deployment`
  - `server/http-integration.test.mjs`:
    - `GET /api/purchase/status enforces wallet binding and rejects wallet mismatch`

---

### Residual 3 (P2): Late Sync Transaksi Lama Menghapus Pending Purchase Baru

- **Lokasi Kode**:
  - [`src/lib/rental.ts`](file:///home/pupulion/Archava-Monad/src/lib/rental.ts)
- **Akar Masalah**:
  - Fungsi `updatePendingPurchaseStage` dan `clearPendingPurchase` sebelumnya hanya menerima parameter `wallet` string.
  - Jika transaksi `txA` selesai terlambat di background sementara pengguna sudah memulai transaksi baru `txB`, proses pembersihan `txA` akan menghapus record `txB` dari localStorage karena keduanya memakai wallet yang sama.
- **Implementasi Perbaikan**:
  1. **Compare-And-Set (CAS) Operation Identity**:
     - Menambahkan interface `PendingOperationIdentity` (`operationId`, `txHash`, `chainId`, `deploymentId`, `wallet`).
     - Menyimpan `operationId` unik pada setiap record pending purchase.
  2. **Idempotent dan Atomic Mutation**:
     - `updatePendingPurchaseStage`, `updatePendingPurchaseHash`, dan `clearPendingPurchase` memvalidasi identitas operasi (`matchesOperationIdentity`) sebelum melakukan mutasi.
     - Jika record di localStorage sudah berpindah ke `operationId` atau `txHash` baru (`txB`), pembersihan dari `txA` ditolak secara aman tanpa menyentuh record baru.
  3. **Preservasi Replacement Hash**:
     - Pada saat transaksi di-speed up / repriced, `updatePendingPurchaseHash` mencatat `originalTxHash` dan `replacementTxHash`, sehingga pencarian berdasarkan salah satu hash tetap valid.
- **Regression Tests**:
  - `src/lib/s04-findings-regression.test.ts`:
    - `Residual 3: Late completion of txA after pending changed to txB leaves txB untouched`
    - `Residual 3: Two monitors for txA - first cleanup succeeds, second is safe/idempotent`
    - `Residual 3: Replacement txA -> txA2 preserves operation identity and updates hash`
    - `Residual 3: Foreign scope cannot be updated or deleted`
    - `Residual 3: matchesOperationIdentity compares deployment, chain, wallet, operationId, and hash strictly`

---

## 3. Resolusi Lima Temuan Awal S04

### Temuan 1 (P1): Approval Masih Bisa Dikirim pada Chain Salah

- **Lokasi Kode**: [`src/lib/wallet.ts`](file:///home/pupulion/Archava-Monad/src/lib/wallet.ts), [`src/lib/rental.ts`](file:///home/pupulion/Archava-Monad/src/lib/rental.ts)
- **Implementasi**:
  - `normalizeChainId` menolak chain ID non-safe integer atau format malformed.
  - `assertActiveContext(context)` memverifikasi `eth_chainId` (10143) dan `eth_accounts` seketika sebelum setiap mutasi onchain (`approve()` dan `rent()`).

### Temuan 2 (P1): Pending Purchase Baru Disimpan Setelah tx.wait()

- **Lokasi Kode**: [`src/lib/rental.ts`](file:///home/pupulion/Archava-Monad/src/lib/rental.ts)
- **Implementasi**:
  - `savePendingPurchase` dipanggil seketika saat `tx.hash` diperoleh dari broadcast.
  - Storage key scoped per deployment dan chain: `archava_pending_v1_archava-monad_10143_${wallet}`.
  - Penanganan `TRANSACTION_REPLACED` untuk repricing vs cancellation.

### Temuan 3 (P1): Wallet Callback State Dapat Menimpa State Wallet Baru

- **Lokasi Kode**: [`src/App.tsx`](file:///home/pupulion/Archava-Monad/src/App.tsx), [`src/lib/wallet.ts`](file:///home/pupulion/Archava-Monad/src/lib/wallet.ts)
- **Implementasi**:
  - Generation token `epochRef` mengabaikan respons asinkron kadaluwarsa saat wallet berganti.
  - Penutupan otomatis orphaned avatar session jika wallet berganti saat sesi disiapkan.

### Temuan 4 (P2): Deteksi Credited Balance Tidak Memastikan TX Tertentu

- **Lokasi Kode**: [`server/purchase-cache.mjs`](file:///home/pupulion/Archava-Monad/server/purchase-cache.mjs), [`server/app.mjs`](file:///home/pupulion/Archava-Monad/server/app.mjs)
- **Implementasi**:
  - Endpoint `GET /api/purchase/status` memverifikasi hash transaksi spesifik sebelum kredit dianggap selesai.

### Temuan 5 (P2): Timeout Polling Tidak Membatasi Fetch yang Menggantung

- **Lokasi Kode**: [`src/lib/rental.ts`](file:///home/pupulion/Archava-Monad/src/lib/rental.ts)
- **Implementasi**:
  - Per-request abort controller (5000ms timeout) dan overall deadline.
  - Fail-fast pada error non-transient (400, 404, 500).
  - Preservasi catatan pending pada timeout untuk pemulihan berikutnya.

---

## 4. Hasil Verifikasi Pengujian Aktual

Seluruh pengujian dijalankan langsung pada workspace `/home/pupulion/Archava-Monad` dan berhasil lulus 100%:

### A. Full Local Verification Pipeline (`npm run verify:local`)
```bash
$ npm run verify:local

Verifying verify:target
PASS deployment target configuration is aligned with Monad Testnet (Chain ID 10143).

Verifying verify:target:contracts
PASS canonical deployment contracts:
  RentalV2: 0x7324a2678e74052a4e9a244c0d57b56b23fee6ad
  MockUSDT: 0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c
  Block:    70191614

Verifying config:check
PASS container and deployment configuration sanity check.

Verifying test
ℹ tests 304
ℹ suites 18
ℹ pass 304
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 13428.998694

Verifying test:backend
Ran 96 tests in 2.987s
OK

Verifying test:ui
PASS layout-1440
PASS layout-768
PASS layout-390
PASS layout-320
PASS talk-keyboard-Enter
PASS talk-keyboard-Space
PASS wallet-error-visible
PASS offline-retry
PASS checking-state
PASS unsupported-before-click
PASS build-does-not-prepare-avatar
PASS home-keeps-avatar-preload
PASS developer-dialog-keyboard
PASS restore-authorized-wallet
PASS copy-code-success-and-failure
PASS persistent-call-controls
PASS call-expiry-next-step
PASS accessibility-home
PASS accessibility-home-mobile
PASS accessibility-build-mobile
20/20 UI checks passed. Artifacts: /home/pupulion/Archava-Monad/.tmp-test/ui

Verifying build
vite v5.4.21 building for production...
✓ 1809 modules transformed.
dist/index.html                                                1.49 kB │ gzip:   0.66 kB
dist/assets/index-B-MDw_BQ.css                                86.80 kB │ gzip:  17.56 kB
dist/assets/index-5O57djoU.js                              1,165.93 kB │ gzip: 348.15 kB
✓ built in 10.59s
✅ [avatarkit] Copied WASM file to dist/assets/avatar_core_wasm-36bf5449.wasm
✅ [avatarkit] Copied WASM JS file to dist/assets/avatar_core_wasm.js
✅ [avatarkit] Created _headers file for Cloudflare Pages

Verifying verify:artifacts
PASS production entrypoints and fixture-free browser assets. Operator env files were not read.

PASS local code and browser checks. Live voice and deployment checks are separate.
```

### B. Unit & Regression Tests Summary (`npm test`)
- Total Suites: **18**
- Total Tests: **304** (100% lulus, 0 gagal)
- Regression findings terverifikasi secara individual:
  - 5 tests untuk Temuan 1 (chain safety & input parsing)
  - 5 tests untuk Temuan 2 (immediate persistence, duplicate checkout, transaction replaced, CAS recovery)
  - 5 tests untuk Residual 1 & Temuan 3 (preparation separation, network switch, unexpected switch, lock ownership, orphaned sessions)
  - 1 test untuk Temuan 4 (txHash credit confirmation)
  - 4 tests untuk Temuan 5 (abort signals, fail-fast, timeout persistence)
  - 5 tests untuk Residual 3 (CAS local storage semantics, race condition prevention, multi-monitor idempotency)
  - 2 tests untuk Residual 2 backend purchase status & wallet binding

---

## 5. Kesimpulan

Seluruh temuan S04 dan residual findings telah diselesaikan dan diverifikasi secara menyeluruh:
1. **Ownership Lock Model**: Persiapan jaringan dipisahkan dari transaksi terkunci, mencegah UI checkout terkunci pada auto-switch jaringan Monad.
2. **Buyer Wallet Binding**: Backend mengikat bukti transaksi onchain dengan pembeli via event metadata and receipt verification, mencegah klaim silang antar wallet.
3. **Compare-And-Set Storage**: Mutasi pending purchase terlindungi oleh identitas operasi (`operationId`, `txHash`), mencegah sinkronisasi transaksi lama menghapus transaksi baru.
4. **100% Green Verification**: Semua 304 unit/regression tests, 20 UI tests, 96 backend tests, build TypeScript/Vite, dan verifikasi artefak berhasil lulus tanpa kesalahan.
