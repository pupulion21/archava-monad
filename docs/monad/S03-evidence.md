# S03 Implementation & Verification Evidence: Monad Backend API, Auth, Ledger State, Purchase Cache & Room Isolation

**Document Version**: 1.0.0  
**Date**: 12 Oktober 2026  
**Target Network**: Monad Testnet (Chain ID: `10143`, Native Token: `MON`)  
**Workspace**: `/home/pupulion/Archava-Monad`  
**Status**: **VERIFIED COMPLETE**

---

## 1. Executive Summary

Milestone **S03** menghubungkan API backend, authentication, durable state ledgers, dan LiveKit room lifecycle secara penuh ke smart contract Archava yang telah ter-deploy dan terverifikasi di Monad Testnet pada S02.

Semua pekerjaan dilakukan dalam workspace independen tanpa memodifikasi repository BNB (`Archzxylabs/Archava`), deployment Vercel BNB (`archava.vercel.app`), atau state operasional BNB lama.

### Ringkasan Pencapaian S03
1. **Koneksi Monad Testnet Validated**: Backend terhubung secara strictly-validated ke Monad Testnet Chain ID 10143 dan deployment manifest kanonis.
2. **Incremental Purchase Cache & Scanner**: Menggantikan full-history log scan per-request dengan scanner incremental yang melacak block `finalized` asli Monad dari deployment block `70191614`.
3. **Startup Onchain Read-Only Check**: Verifikasi startup `verifyMonadConnection` memvalidasi bytecode, address linkage, token decimals (6), token symbol (`mUSDT`), dan quote harga paket (Starter `4937500`, Pro `18687500`).
4. **Purpose & Chain-Bound Challenges**: Challenge auth mengikat `Chain ID: 10143`, `Deployment: archava-monad`, `Contract`, `Origin`, `Wallet`, nonce acak satu kali pakai, dan TTL.
5. **Durable Scoped State Isolation**: Semua file state (`purchase-cache.json`, `usage.json`, `keys.json`) menyimpan `schemaVersion: 1` dengan metadata scope lengkap. State legacy atau state milik foreign chain/deployment ditolak secara fail-closed tanpa overwrite.
6. **Room & Domain Isolation**: LiveKit rooms terikat pada `deploymentId: "archava-monad"`; sweeper hanya menghapus room yang cocok; origin legacy BNB ditolak dari CORS whitelist default.
7. **Pembersihan Konteks Worker**: Worker Python (`site_context.py`, `knowledge.py`, `agent.py`) telah dibersihkan dari seluruh rujukan BNB dan diperbarui ke Monad Testnet.
8. **Containerization & Smoke Readiness**: `Dockerfile` menyertakan deployment manifest; smoke test kontainer valid di filesystem lokal dan image Docker `archava-monad:s03`.

---

## 2. Smart Contract & Deployment Manifest Metadata

Manifest kanonis dibaca langsung dari [`packages/contracts/deployments/monadTestnetV2.json`](file:///home/pupulion/Archava-Monad/packages/contracts/deployments/monadTestnetV2.json):

| Parameter | Nilai Onchain Monad Testnet |
|---|---|
| **Network** | Monad Testnet |
| **Chain ID** | `10143` |
| **ArchavaMockUSDT** | `0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c` |
| **Mock USDT Deploy Block** | `70191611` |
| **Mock USDT Decimals / Symbol** | `6` / `mUSDT` |
| **ArchavaRentalV2** | `0x7324a2678e74052a4e9a244c0d57b56b23fee6ad` |
| **Rental V2 Deploy Block** | `70191614` |
| **Starter Package (ID 1)** | `4,937,500` base units (4.9375 mUSDT), 60 menit |
| **Pro Package (ID 2)** | `18,687,500` base units (18.6875 mUSDT), 300 menit |
| **Validity Duration** | 30 hari (`2,592,000` detik) |

---

## 3. Implementasi Detail

### A. Rental Contract & Onchain Verification (`server/rental.mjs`)
- Menggantikan parameter BNB Chain ID 97 dengan Monad Testnet Chain ID 10143 dan start block `70191614`.
- Fungsi `loadDeploymentManifest(cwd)` memuat manifest kanonis dan memverifikasi integritasnya.
- Fungsi `configuredContracts` memvalidasi bahwa `RENTAL_CONTRACT` dan `PAYMENT_TOKEN_CONTRACT` yang dikonfigurasi sama persis dengan manifest.
- Fungsi `verifyMonadConnection(connection)` menjalankan pemeriksaan onchain:
  - `(await provider.getNetwork()).chainId === 10143n`
  - Bytecode rental dan payment token tersedia (`getCode !== "0x"`).
  - `rental.paymentToken()` onchain cocok dengan address token pada manifest.
  - Token `decimals() === 6` dan `symbol() === "mUSDT"`.
  - `quoteRent(1) === 4937500n` dan `quoteRent(2) === 18687500n`.
- `createCreditReader`:
  - Memeriksa `rental.hasActiveAccess(wallet)` onchain. Jika inaktif/expired, mengembalikan 0 menit.
  - Mengambil saldo menit dari `purchaseCache`.
  - Jika saldo cache 0 dan scanner aktif, melakukan sinkronisasi cepat terhadap event finalized terbaru.
- `createPackQuoter`: membaca quote mUSDT langsung dari kontrak Monad.

### B. Incremental Purchase Cache & Scanner (`server/purchase-cache.mjs`)
- **Durable File**: `purchase-cache.json` di `ARCHAVA_STATE_DIR`.
- **Atomic Writes**: Menulis ke staging file `.tmp-{pid}-{random}` lalu rename atomik.
- **Deduplication**: Kunci unik per event: `${chainId}:${rentalContract}:${txHash}:${logIndex}`. Replay event tidak menambah kredit ganda.
- **Finalized Block Tracking**: Menggunakan tag native `"finalized"` dari RPC Monad (`provider.getBlock("finalized")`).
- **Adaptive Range Handling**: `fetchLogsAdaptive` membagi query rentang blok secara rekursif jika RPC mengembalikan limit/range error.
- **Single-Flight Synchronization**: Mutex `activeSyncPromise` mencegah pemanggilan paralel yang tumpang-tindih.
- **Fail-Closed on RPC Errors**: Menghasilkan `RecoverableScanError` (HTTP 503) saat RPC gagal tanpa mengosongkan cache atau mengubah saldo menjadi 0.
- **Background Sync**: Polling periodik non-blocking tanpa mengganggu pembacaan state finalized yang sudah tersimpan.

### C. Scoped State Stores (`server/usage.mjs` & `server/apikeys.mjs`)
- `createUsageStore` dan `createKeyStore` menerima parameter `scope`:
  ```json
  {
    "deploymentId": "archava-monad",
    "chainId": 10143,
    "rentalContract": "0x7324a2678e74052a4e9a244c0d57b56b23fee6ad",
    "paymentToken": "0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c"
  }
  ```
- File `usage.json` dan `keys.json` menyimpan `schemaVersion: 1` dan metadata scope.
- State legacy (unscoped array) atau state dengan scope mismatch ditolak dengan error yang jelas tanpa ditimpa.

### D. Purpose-Bound & Chain-Bound Challenges (`server/auth.mjs`)
- Challenge message menyertakan:
  ```
  [Headline: "Archava session access" / "Archava developer dashboard access"]
  Wallet: <checksum-address>
  Chain ID: 10143
  Deployment: archava-monad
  Contract: 0x7324a2678e74052a4e9a244c0d57b56b23fee6ad
  Origin: <origin>
  Nonce: <random-hex-nonce>
  Issued: <ISO-timestamp>
  Sign this message to prove wallet ownership. This does not submit a transaction.
  ```
- Nonce langsung dihapus dari memori saat diproses (mencegah replay).
- Signature untuk session access ditolak di dashboard access, dan sebaliknya.
- Alamat wallet dinormalisasi ke checksum format (`ethers.getAddress`).

### E. Room Isolation & Sweeper (`server/dependencies.mjs`)
- Room metadata menyimpan `product: "archava"`, `deploymentId: "archava-monad"`.
- Sweeper `closeExpiredRooms` hanya memproses room yang memiliki `meta.deploymentId === "archava-monad"`, mengabaikan room milik deployment lain.
- Whitelist origin membersihkan domain BNB lama (`archava.vercel.app` dll.).

### F. Worker Python Knowledge Sanitization
- `backend/site_context.py`: membersihkan rujukan "BNB Testnet" pada deskripsi avatar dan minute pack.
- `backend/knowledge.py`: mengarahkan fakta produk ke Monad Testnet (Chain ID 10143) dan kontrak mUSDT Monad.
- `backend/agent.py`: prompt agent membedakan preview gratis dan minute packs di Monad Testnet.

---

## 4. Bukti Hasil Verifikasi (Evidence Logs)

### A. Live Monad Testnet Contract Verification
```
$ node -e 'import("./server/rental.mjs").then(async ({ configuredContracts, verifyMonadConnection }) => { ... })'

Checking Monad Testnet connection and contracts onchain...
✓ LIVE MONAD TESTNET VERIFICATION PASSED!
✓ Quotes verified: 4937500 18687500
✓ Payment token verified: 0xe268CE1aD255f8D32bFA9a7f9fEEF3eaBf45b39C
```

### B. Live Incremental Scanner Sync pada Monad Testnet
```
$ node -e 'import("./server/purchase-cache.mjs").then(async ({ createPurchaseCache, createPurchaseScanner }) => { ... })'

Testing live sync on Monad Testnet...
✓ Live sync succeeded: {
  synced: true,
  fromBlock: 70191614,
  toBlock: 70199310,
  newEventsCount: 0
}
✓ Cursor advanced to: {
  lastFinalizedBlock: 70199310,
  lastFinalizedBlockHash: '0x5a2510e8dd4ffb4403b5ee03c5b99b9b646c91fb87745a8dd7612860c8bf840c'
}
```

### C. Node Test Suite (264 Tests)
```
$ npm test

▶ Runtime Target Validation
  ✔ isRuntimeEnabled (5.89ms)
  ✔ validateRuntimeStartup - startup lock (2.79ms)
  ✔ validateRuntimeStartup - BNB chain rejection (8.54ms)
  ✔ validateRuntimeStartup - missing configuration (4.41ms)
  ✔ validateRuntimeStartup - valid Monad configuration (3.63ms)
  ✔ validateRuntimeStartup - state directory validation (2.68ms)
  ✔ validateRuntimeStartup - config mismatch (1.59ms)
✔ Runtime Target Validation (31.42ms)
...
✔ validateScope asserts all deployment identity fields (7.48ms)
✔ purchase cache creates scoped state and survives restarts (16.35ms)
✔ purchase cache rejects legacy unscoped or foreign state without overwriting it (10.41ms)
✔ purchase scanner deduplicates events and updates cache atomically (9.14ms)
✔ purchase scanner handles RPC failure with RecoverableScanError without zeroing cache (6.47ms)
✔ purchase scanner executes single-flight synchronization under concurrent calls (27.32ms)
✔ wallet and contract configuration reject invalid addresses and chain mismatch (3.21ms)
✔ contract configuration validates against deployment manifest (2.75ms)
✔ scoped usage store validates deployment scope and rejects legacy or foreign state (22.72ms)
✔ scoped key store validates deployment scope and rejects legacy or foreign state (9.67ms)
...
ℹ tests 264
ℹ suites 18
ℹ pass 264
ℹ fail 0
```

### D. Python Backend Test Suite (96 Tests)
```
$ npm run test:backend

Ran 96 tests in 2.942s
OK
```

### E. Frontend Build & Static Verification
```
$ npm run build

vite v5.4.21 building for production...
✓ 1807 modules transformed.
dist/index.html                                                1.49 kB
dist/assets/index-B-MDw_BQ.css                                86.80 kB
dist/assets/index-CJcJMnTb.js                              1,143.93 kB
✓ built in 10.63s
```

### F. Verification Guards
```
$ npm run verify:target && npm run config:check
✓ LOCAL validation passed
Container Configuration Smoke Test (local filesystem)
✓ Network configuration: config/networks.json
✓ Deployment targets: config/deployment-targets.monad.json
✓ Contract deployment manifest: packages/contracts/deployments/monadTestnetV2.json
✓ All required configurations present and valid

$ npm run verify:artifacts
PASS production entrypoints and fixture-free browser assets. Operator env files were not read.
```

### G. Docker Image Build & Container Smoke Test
```
$ docker build -t archava-monad:s03 .
Step 22/29 : COPY packages/contracts/deployments ./packages/contracts/deployments
Successfully built 41fdb5a9532e
Successfully tagged archava-monad:s03

$ node scripts/container-config-smoke.mjs --image archava-monad:s03
Container Configuration Smoke Test (Docker image)
Inspecting image: archava-monad:s03

✓ Network configuration: config/networks.json
✓ Deployment targets: config/deployment-targets.monad.json
✓ Contract deployment manifest: packages/contracts/deployments/monadTestnetV2.json
✓ All required configurations present and valid
```

---

## 5. Resolusi Temuan Kritis S03 & Regression Tests

Empat temuan kritis dalam integrasi backend S03 telah diselesaikan dan diverifikasi dengan suite pengujian regresi dedicated ([`server/s03-findings-regression.test.mjs`](file:///home/pupulion/Archava-Monad/server/s03-findings-regression.test.mjs)):

### Temuan 1: API Key Store Validation Bypass After Error
- **Masalah**: `load()` menetapkan `loaded = true` sebelum pembacaan dan validasi berhasil, memungkinkan pemanggilan berikutnya melewati validasi dan menimpa file invalid/foreign.
- **Perbaikan**:
  - `loaded = true` hanya ditetapkan setelah pembacaan dan validasi skema serta scope berhasil.
  - Pemanggilan concurrent menggunakan `loadPromise` bersama.
  - Sticky `validationError` diterapkan: setelah error validasi, seluruh operasi berikutnya (`issue`, `list`, `revoke`, `touch`, `flush`) langsung ditolak (fail-closed).
  - Operasi flush ditolak jika store belum tervalidasi.
  - File invalid, foreign, atau korup dipertahankan di disk tanpa overwrite atau pembersihan otomatis.
- **Regression Tests**:
  - Foreign scope list ditolak, `issue()` berikutnya pada instance yang sama tetap ditolak, file tidak ditimpa.
  - File korup ditolak, operasi berikutnya tetap ditolak, file tidak ditimpa.
  - Concurrent `load()` tidak melewati validasi.
  - Store yang valid mendukung `issue()`, `findBySecret()`, `list()`, `revoke()`, dan restart persistence.

### Temuan 2: Fallback Finality Masih Memberi Kredit
- **Masalah**: `getFinalizedBlockInfo()` menggunakan fallback `latest - 30` ketika RPC finalized gagal, dan direct credit reader melakukan fallback ke `getBlockNumber()`.
- **Perbaikan**:
  - Menghapus seluruh fallback `latest`, `latest - 30`, atau confirmation count dari jalur crediting.
  - Memerlukan tag block `"finalized"` asli dari RPC Monad. Jika tidak tersedia atau malformed, melempar `RecoverableScanError` (status 503, code `credit_sync_unavailable`).
  - Pembacaan active access onchain (`rental.hasActiveAccess(wallet, { blockTag: "finalized" })`) secara eksplisit menggunakan block finalized.
  - Cursor dan totals tidak pernah dimajukan menggunakan perkiraan unfinalized.
- **Regression Tests**:
  - RPC finalized error / tag tidak tersedia: sync ditolak, `getLogs` tidak dipanggil, cursor tidak bergerak.
  - Direct credit reader menolak membaca saldo tanpa finalized block yang valid (tidak fallback ke latest).

### Temuan 3: Error Sync Ditelan dan Cache Usang Meluluskan Paid Gate
- **Masalah**: `createCreditReader()` menelan error sync dan mengembalikan 0 menit (menyebabkan 403 "No Ava minutes remaining" padahal sinkronisasi gagal), atau mengembalikan saldo usang tanpa validasi freshness.
- **Perbaikan**:
  - Menerapkan freshness policy eksplisit (`isFresh(maxStalenessMs)` dengan default 60 detik).
  - Melacak `lastSuccessfulFullSyncAt` secara terpisah dari intermediate/partial page commits.
  - `createCreditReader()` memeriksa freshness cache; jika stale atau saldo aktif 0, menjalankan `scanner.sync()`.
  - Error sinkronisasi tidak ditelan, melainkan dipropagasi sebagai `RecoverableScanError` (status 503, code `credit_sync_unavailable`).
  - `createEntitlementGate`, `/v1/usage`, `/v1/sessions`, `/api/access`, dan `/api/session` mengembalikan 503 `credit_sync_unavailable` saat sync gagal atau unavailable.
- **Regression Tests**:
  - Saldo cache 0 saat scanner error mengembalikan HTTP 503 `credit_sync_unavailable`, bukan 403.
  - Cache usang berisi saldo positif saat scanner error menolak paid gate dengan HTTP 503.
  - Cache fresh berisi saldo positif meluluskan paid gate tanpa memicu sync redundan.

### Temuan 4: Validasi Hash Block pada Cursor Belum Lengkap
- **Masalah**: Commit intermediate page menyetel `lastFinalizedBlockHash = null`, dan scanner tidak memvalidasi hash block cursor terhadap RPC sebelum melanjutkan sinkronisasi.
- **Perbaikan**:
  - Setiap cursor commit (termasuk intermediate page) mengambil hash block `currentTo` dari RPC dan menyertakannya secara valid.
  - Pada saat memuat cache dari disk, struktur cursor divalidasi: jika `lastFinalizedBlock != null`, `lastFinalizedBlockHash` wajib ada dan valid.
  - Sebelum memproses log baru:
    1. Memeriksa `cursor.lastFinalizedBlock <= finalized.number`. Jika lebih besar, melempar `RecoverableScanError`.
    2. Jika cursor memiliki block dan hash, memanggil `provider.getBlock(cursor.lastFinalizedBlock)` dan memverifikasi `block.hash === cursor.lastFinalizedBlockHash`. Jika terjadi mismatch (misalnya reorg), melempar `RecoverableScanError` dan TIDAK memodifikasi cache di disk.
- **Regression Tests**:
  - Cursor block hash mismatch terdeteksi dan menolak sync tanpa memodifikasi file di disk.
  - Cursor di depan finalized head ditolak dengan `RecoverableScanError`.
  - Cache dengan cursor block number tanpa block hash ditolak pada saat `load()`.
  - Multi-page sync melakukan commit block hash yang valid untuk setiap intermediate page.

---

## 6. Status Milestone

S03 selesai diimplementasikan, seluruh 4 temuan telah diperbaiki dan diverifikasi dengan regression tests (13 test cases), suite test Node (264 test cases), suite test backend Python (96 test cases), build frontend Vite, target verification, dan container configuration smoke test.

Sistem siap untuk handoff ke **S04 (Frontend & Wallet Connection Integration)**.

