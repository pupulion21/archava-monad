# Prompt implementasi S01 Archava Monad

Prompt untuk sesi coding di repo yang disiapkan user. Scope agent adalah implementasi kode dengan monskill, dimulai dari S01. Pembuatan repo GitHub, pengaturan remote, push dan PR tidak termasuk tugas agent.

```text
Gunakan $monskill untuk mengembangkan Archava versi Monad berdasarkan blueprint dan gap map yang sudah dibuat.

Repo baru sudah saya siapkan sendiri. Kerjakan kode di repo/workspace yang saya berikan. Jangan membuat repo GitHub, mengatur remote, melakukan push atau membuat PR. Jika dokumen lama menyuruh melakukan setup GitHub, instruksi saya ini menggantikannya.

Mulai dengan membaca SKILL.md monskill yang tersedia di environment. Lokasi yang sebelumnya digunakan: /home/pupulion/.agents/skills/monskill/SKILL.md. Jika path berubah, cari skill tersebut. Gunakan panduan Monad yang relevan saja; periksa dokumentasi resmi untuk konfigurasi jaringan dan provider yang akan dipakai.

Baca AGENTS.md yang berlaku, lalu dokumen plans/README.md, archava-monad-gap-map.md, archava-monad-metropolis.md, archava-monad-resources.md dan archava-monad-review.md. Periksa struktur source dan perubahan user sebelum mengedit. Mapping sudah tersedia; lanjutkan implementasi dari situ.

Tujuan aplikasi: pengguna mendapat wallet dan gas MON, claim demo mUSDT, membeli menit di Monad Testnet, membuka sesi Ava, melihat saldo dan memakai API key dari aplikasi lain. Gunakan kembali React/Vite, RentalV2/MockUSDT, API, ledger dan voice worker yang sudah ada. Pertahankan pilihan Privy dan Envio dalam blueprint; penggunaan monskill tidak otomatis mengganti provider.

Mulai dari implementasi S01:
1. Bersihkan konfigurasi aktif BNB: env examples, chain/RPC/address defaults, backend rewrite, deployment aliases dan instruksi menjalankan aplikasi. Siapkan konfigurasi Monad Testnet sesuai blueprint. Nilai yang belum tersedia tetap kosong dan fitur terkait tidak aktif sampai konfigurasi valid.
2. Tambahkan konfigurasi target deployment dan validasi yang benar-benar dipanggil entrypoints. API dan voice worker harus memvalidasi target sebelum membuat provider clients, menjalankan jobs atau mendaftarkan worker. Ikuti startup lock blueprint; flag enable saja tidak cukup untuk membuka runtime yang belum siap.
3. Pisahkan credentials dan state Monad menggunakan ARCHAVA_STATE_DIR serta scope chain/contract/token sesuai tahapnya. Jangan memakai resource production BNB sebagai fallback atau mengubah checkout BNB lama.
4. Tambahkan pengujian bermakna untuk konfigurasi salah/tidak lengkap dan pastikan startup gagal sebelum side effect. Gunakan mocks dan temporary state. Sesuaikan CI serta Docker hanya sejauh yang diperlukan untuk perubahan ini.
5. Jalankan checks yang relevan dengan perubahan, lalu perbaiki kegagalan dalam scope. Catat hasil aktual, konfigurasi yang masih dibutuhkan dan status implementasi di dokumentasi repo. Jangan mengklaim checks yang belum dijalankan sebagai pass.

Selesaikan pekerjaan kode S01 yang bisa dikerjakan lokal. S02–S08 mengikuti urutan dan dependency blueprint; jangan memperluas sesi ini ke deployment, transaksi atau integrasi sponsor. Jika ada akses eksternal yang belum tersedia, lanjutkan pekerjaan lokal yang independen dan catat kebutuhan tersebut secara spesifik.

Output akhir: ringkasan perubahan, file penting, hasil checks, bagian S01 yang selesai/belum selesai dan langkah berikutnya. Hasil utama harus berupa perubahan kode yang bisa saya review di repo ini. Urusan membuat dan menghubungkan repo GitHub saya tangani sendiri.
```
