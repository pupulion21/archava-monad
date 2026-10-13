# Milestone S06 Evidence — Envio HyperIndex Integration

Tanggal: 13 Oktober 2026  
Lingkup: Archava Monad (`archava-monad`)  
Jaringan: Monad Testnet (Chain ID `10143` / `0x279f`)  
Kontrak Rental: `0x7324a2678e74052a4e9a244c0d57b56b23fee6ad`  
Blok Deploy: `70191614`  
Token Pembayaran: `0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c` (mUSDT)

---

## 1. Ringkasan Eksekutif

Milestone S06 menyelesaikan integrasi **Envio HyperIndex** untuk Archava Monad sesuai spesifikasi hackathon Metropolis.
Integrasi ini menyediakan feed riwayat pembelian publik (`AccessRented`) secara real-time dan terverifikasi di Monad Testnet tanpa mengorbankan integritas sistem otorisasi offchain:
1. **Paket Indexer Independen**: `packages/indexer` dikonfigurasi dengan Envio HyperIndex 3.x, schema GraphQL, dan event handler terkompilasi TypeScript.
2. **Backend Purchase History Service**: Layanan server-side (`server/purchases.mjs`) yang mengekspos endpoint `GET /api/purchases`, dengan validasi ketat, bound pagination, dan proteksi credential GraphQL.
3. **Pemisahan Tegas Antara History dan Hak Akses**: Validasi kredit menit dan saldo ledger offchain tetap mutlak berbasis finalized RPC onchain dan usage store lokal. Kegagalan indexer tidak pernah memberikan maupun mencabut akses berbayar.
4. **Tampilan Frontend Terintegrasi**: Halaman `/build` dilengkapi terminal riwayat onchain bertenaga Envio dengan status sinkronisasi eksplisit (`synced`, `indexing_lag`, `indexing`, `unavailable`) dan tautan langsung ke MonadScan.

---

## 2. Arsitektur Indexer (`packages/indexer`)

### 2.1 Konfigurasi Envio 3.x (`packages/indexer/config.yaml`)
```yaml
name: archava-monad-indexer
field_selection:
  transaction_fields:
    - hash
contracts:
  - name: ArchavaRentalV2
    handler: ./src/EventHandlers.ts
    events:
      - event: "AccessRented(address indexed wallet, uint8 indexed packageId, uint256 includedMinutes, uint256 expiresAt, uint256 amountPaid)"
chains:
  - id: 10143
    start_block: 70191614
    contracts:
      - name: ArchavaRentalV2
        address:
          - "0x7324a2678e74052a4e9a244c0d57b56b23fee6ad"
```

### 2.2 Skema GraphQL (`packages/indexer/schema.graphql`)
```graphql
type AccessRented {
  id: ID!
  wallet: String! @index
  packageId: Int!
  includedMinutes: BigInt!
  expiresAt: BigInt!
  amountPaid: BigInt!
  transactionHash: String!
  blockNumber: Int!
  logIndex: Int!
  timestamp: Int!
}
```

### 2.3 Event Handler (`packages/indexer/src/EventHandlers.ts`)
Event handler menggunakan API Envio 3.14 (`indexer.onEvent`) dan menghasilkan ID entitas komposit untuk deduplikasi mutlak:
`${chainId}:${contractAddress}:${txHash}:${logIndex}`
Menyimpan wallet dalam format lowercase untuk pencarian cepat dan case-insensitive.

---

## 3. Layanan Backend (`server/purchases.mjs` & `server/app.mjs`)

### 3.1 Endpoint `GET /api/purchases?wallet=...&limit=...&offset=...`
- **Validasi Input**: Memvalidasi parameter `wallet` menggunakan `isAddress()` dari `ethers`. Input tidak valid menghasilkan HTTP 400 `{ ok: false, error: "Invalid or missing wallet address" }`.
- **Bound Pagination**: Parameter `limit` dibatasi aman antara 1 hingga 50 (default: 20), dan `offset` non-negatif.
- **Proteksi Kredensial**: `ENVIO_GRAPHQL_URL` dan `ENVIO_API_KEY` dikelola sepenuhnya di sisi server. Kredensial tidak pernah bocor ke browser atau respon API.
- **Status Sinkronisasi Metadata**: Memilih `_meta` (array per-chain) dari Envio HyperIndex secara eksplisit untuk chain 10143, lalu menurunkan lag dari `progressBlock`/`sourceBlock` untuk mendeteksi:
  - `synced`: Indexer siap dan `numBlocksBehind === 0`.
  - `indexing_lag`: Indexer sedang tertinggal beberapa blok (`numBlocksBehind > 0`).
  - `indexing`: Indexer belum siap (`ready === false`).
  - `unavailable`: Endpoint Envio offline, timeout, atau belum dikonfigurasi.
- **Deduplikasi**: Memastikan setiap log event pembelian muncul tepat satu kali.

### 3.2 Independensi Authoritative Access
Diverifikasi melalui `server/envio-integration.test.mjs`:
- Jika endpoint Envio mati (HTTP 503/timeout), `/api/access` tetap memberikan otorisasi penuh berbasis finalized RPC onchain.
- Riwayat Envio bersifat informatif publik dan tidak menjadi gerbang penentu hak bicara avatar Ava.

---

## 4. Antarmuka Pengguna (`src/components/BuildPage.tsx` & `src/styles.css`)

Pada halaman `/build`:
1. **Bagian `02 / PURCHASE HISTORY (INDEXED BY ENVIO)`**:
   - Menampilkan status feed real-time di header terminal:
     - `ENVIO SYNCED · BLOCK #<block>` (hijau / `.build-ready`)
     - `INDEXING LAG (<n> BLOCKS)` (kuning / `.build-pending`)
     - `INDEXING IN PROGRESS` (kuning / `.build-pending`)
     - `INDEXER OFFLINE` (kuning / `.build-pending`)
2. **Status Transaksi Spesifik**:
   - Menampilkan transaksi yang baru dikirim atau pending di localStorage sebagai `AWAITING INDEX`.
   - Menampilkan event yang terindeks sebagai `INDEXED` lengkap dengan rincian menit paket, pembayaran mUSDT terformat, timestamp, dan nomor blok.
   - Tautan langsung ke MonadScan (`https://testnet.monadscan.com/tx/<txHash>`).
3. **Pembedaan Status Kosong**:
   - Membedakan antara ketiadaan pembelian riwayat (`No purchase events found...`) dengan gangguan koneksi indexer (`Envio HyperIndex service is currently offline...`).
4. **Tombol Refresh Manual**: Pengguna dapat memicu pembaruan status indexer kapan saja tanpa me-reload halaman.

---

## 5. Bukti Pengujian & Regresi

1. **`server/purchases.test.mjs`** (8 tes):
   - Reject alamat wallet tidak valid (HTTP 400).
   - Clamp limit (1-50) dan offset non-negatif.
   - Penanganan endpoint tidak terkonfigurasi secara anggun (status: `unavailable`).
   - Parsing dan deduplikasi event duplikat.
   - Deteksi indexing lag via metadata `_meta`.
   - Penanganan GraphQL error tanpa membocorkan API key.
   - Penanganan HTTP error status (502).
   - Penanganan timeout query (AbortController).
2. **`server/envio-integration.test.mjs`** (2 tes):
   - Isolasi kegagalan indexer: `/api/access` tetap 200 OK saat Envio 503.
   - Isolasi data per wallet: Alice dan Bob hanya menerima riwayat masing-masing.
3. **`test:backend`** (111 tes lulus): Dijalankan via `python -m unittest` oleh `scripts/test-backend.mjs`.
4. **`npm test`** (350 tes lulus across 18 suites).
5. **`test:ui`** (22/22 checks lulus): Semua interaksi Playwright lulus tanpa regresi.
6. **`npm run build`** (Exit code 0): TypeScript dan bundler Vite lulus bersih.

---

## 6. Persiapan Deployment Envio Cloud

Paket `packages/indexer` di-deploy ke Envio Cloud via alur berbasis Git (bukan perintah CLI `deploy`, yang tidak tersedia di CLI `envio` yang terpasang):
- Operator menghubungkan repositori Monad baru melalui Envio App dan mengatur **root directory** ke `packages/indexer`.
- Envio Cloud melakukan build dan index dari branch deployment (start block `70191614`, chain `10143`).
- Endpoint GraphQL hasil deployment disetel ke `ENVIO_GRAPHQL_URL` (dan `ENVIO_API_KEY` bila privat) pada environment server (Railway), hanya di sisi server.
