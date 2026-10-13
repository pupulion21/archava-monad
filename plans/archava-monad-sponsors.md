# Archava Monad: matriks track dan sponsor Metropolis

Dicek 11 Oktober 2026. Nilai di bawah adalah reward yang diumumkan, **bukan** perkiraan pendapatan Archava. Judul disederhanakan dalam Bahasa Indonesia. Daftar publik menampilkan 21 bounty dan menyatakan daftar penuh ada di portal; jangan menganggap halaman publik sudah memuat seluruh bounty event.

**Scope revision4: target hanya Privy + Envio, provisional setelah rules S01.** Tabel penuh adalah referensi pemilihan, bukan daftar SDK/resources yang harus dipasang. Semua integrasi terpilih hanya di repo/hosting Monad independen; keputusan shared repo pada arsip revision3 sudah digantikan.

Sumber reward/kategori: [halaman resmi Metropolis](https://www.monad.xyz/developers/hackathons/metropolis). Pilih satu primary track; bounty tambahan punya persyaratan/field sendiri di [portal track](https://hackathon.monad.xyz/tracks). Detail katalog memerlukan login. Semua kolom kecocokan dan fitur berikut adalah **analisis/rekomendasi Archava**, belum merupakan konfirmasi penerimaan sponsor. Cek pembatasan track, network/token, SDK, region/team, evidence dan payout terms pada S01 sebelum implementasi.

## Pilihan track utama

| Track | Pool publik | Kecocokan Archava |
| --- | --- | --- |
| 01 — Onchain Finance & Trading | $30.000 / tiga tim | Rendah; produk existing bukan trading/lending |
| **02 — Consumer Products & Payments** | **$30.000 / tiga tim** | **Utama: checkout untuk akses avatar, wallet onboarding dan API pelanggan** |
| 03 — Social, Attention & Culture | $30.000 / tiga tim | Hanya jika produk bergeser ke komunitas/creator; tidak diambil sekarang |
| 04 — Trust, Identity & AI Infrastructure | $30.000 / tiga tim | Alternatif bila membangun agent identity/provenance/trust infra yang substantif |

Grand champion lintas track diumumkan $25.000. Pool track/bounty tidak berarti semua participant menerima reward. [Track dan prize resmi](https://www.monad.xyz/developers/hackathons/metropolis).

## Shortlist yang masuk akal

| Target | Reward diumumkan | Fitur yang dibangun | Bukti minimum dari produk | Keputusan |
| --- | --- | --- | --- | --- |
| **Privy** | **$5.000** | Email/social onboarding, embedded EOA wallet di Monad, selected provider untuk payment dan dashboard signature | Fresh login→MON funding→mock faucet→approve→rent→paid Ava→dashboard; code integration + live receipts | Target setelah rules dicek |
| **Envio** | **$1.000** | Index RentalV2 events, purchase history dengan sync status dan explorer links | New rent masuk history tepat sekali; chain/contract filter; `_meta` sync; lag fallback | Target setelah rules dicek |

Privy diprioritaskan karena langsung menyelesaikan onboarding; Envio langsung memberi pengguna riwayat pembelian. Ini alasan produk, bukan klaim peluang menang. Jika rules hanya menerima Track 04 atau network yang tidak dipakai, ganti shortlist, bukan memasukkan checkbox yang tidak cocok.

## Semua bounty yang terlihat di halaman publik

| # | Sponsor / kategori ringkas | Reward | Bisa diambil Archava? |
| --- | --- | --- | --- |
| 1 | Envio — penggunaan indexer | $1.000 | **Ya sebagai target**: purchase history dan index status |
| 2 | Cleanverse — integrasi CVI/CVA | $2.000 | Tunda; butuh use case credential/identity sesuai docs, bukan label avatar |
| 3 | Kuru — aplikasi trading konsumen | $5.000 | Rendah; memerlukan produk trading yang berbeda |
| 4 | Kuru — aset dan pasar baru | $5.000 | Rendah; rental avatar bukan otomatis aset/market Kuru |
| 5 | Dynamic — penggunaan wallet tooling | $5.000 | Referensi alternatif Privy; tidak dipilih revision4 |
| 6 | Alchemy — project memakai tooling | **$1.000 credits** | Referensi; tidak dipilih revision4, layanan/network requirements belum confirmed |
| 7 | Chainlink — workflow CRE | $3.000 | Tunda; butuh workflow nyata, jangan tambah oracle untuk quote yang sudah onchain |
| 8 | Perpl — penggunaan API | $5.000 | Rendah; baru cocok jika avatar berfungsi sebagai produk trading Perpl |
| 9 | Perpl — analytics/risk | $3.000 | Rendah; dashboard menit bukan analytics/risk trading |
| 10 | Privy — integrasi wallet | $5.000 | **Ya sebagai target**: wallet+payment+signature nyata |
| 11 | Nansen — penggunaan data | $5.000 | Rendah; data wallet/trading harus memberi fungsi nyata, tidak ada di scope inti |
| 12 | Agora — mobile trading Monad | $10.000 | Rendah; web avatar checkout bukan mobile trading |
| 13 | Agora — cross-border payments | $10.000 | Roadmap; perlu pembayaran lintas negara dan token/integrasi yang required; mUSDT mock belum membuktikannya |
| 14 | Tencent — model Hunyuan | **$2.000 credits** | Ditunda; provider AI tambahan tidak dibutuhkan voice stack existing |
| 15 | KIMI — build memakai model | **$3.000 credits** | Ditunda; tidak ada step KIMI di revision4 |
| 16 | Alibaba — Qwen 3.8 Max | **$5.000 credits** | Ditunda; nama dari homepage, model/API availability tidak diverifikasi untuk sprint |
| 17 | Category Labs — UX dengan Mera | $2.500 | Tunda; P256/passkey/account dan signature verifier menambah scope |
| 18 | Category Labs — Mera multi-key | $2.500 | Tunda; perlu flows key/account nyata, bukan mengganti login button |
| 19 | MetaMask — agent wallet plugin | $2.500 | Tunda; harus membuat plugin agent yang memenuhi spec, bukan external MetaMask checkout biasa |
| 20 | Monad — community team | $5.000 | Conditional di luar integrasi teknis; cek syarat team/community dan bukti yang diwajibkan |
| 21 | Aurora Intents — likuiditas dari chain lain | $5.000 | Roadmap; cross-chain funds→Monad membutuhkan actual intent flow dan token requirement |

[Sumber daftar dan reward publik](https://www.monad.xyz/developers/hackathons/metropolis). Angka tanpa label credits tetap perlu verifikasi payout currency, jumlah pemenang, pembagian reward dan terms di portal; bukan janji cash yang pasti diterima.

## Sponsored winner prizes bukan bounty tambahan

Ini paket yang diumumkan untuk pemenang tertentu, umumnya layanan/kredit. Nilai agregat di homepage bukan pembayaran cash per tim.

| Sponsor | Nilai diumumkan | Bentuk |
| --- | --- | --- |
| ack3 | $15.000 | Security scan untuk winning teams |
| Chainstack | $10.000 | Annual Pro untuk Track 01 dan overall winner |
| Crouton | $10.000 | Tiga bulan unlimited RPC untuk winning teams |
| Mercuryo | $10.000 | Product credits dan integration support |
| BlockVision | $8.000 | Tiga bulan Pro untuk track winners |
| Zerion | $6.000 | Tiga bulan API Builder untuk winners |
| Envio | $5.000 | Envio Cloud hosting untuk winners |
| Spectrum | $3.000 | Business/Enterprise plans sesuai kategori winner |

Jangan menghitung row Envio hosting $5.000 sebagai bounty indexer $5.000: bounty yang terlihat adalah $1.000. [Sponsored prizes resmi](https://www.monad.xyz/developers/hackathons/metropolis).

## Participant resources

| Provider | Resource publik | Eligibility dari katalog yang dikirim user |
| --- | --- | --- |
| QuickNode | Tiga bulan Build plan | **New accounts only** |
| Tenderly | Lisensi Pro untuk simulation/debug/monitoring | All teams |
| Zerion | Satu bulan API Builder | All teams |
| Dwellir | Tiga bulan Developer plan | All teams |
| Spectrum | Dua bulan Business | All teams |
| BlockVision | Dua bulan Lite | All teams |

Katalog resource yang diberikan user menyebut **satu voucher per tim untuk tiap resource**. Claim melalui jalur event/provider yang resmi dan cek network support serta kuota. Jika operator sudah memakai QuickNode untuk BNB, cek account eligibility sebelum mengandalkan perk new-account. Ini resources saat build; bukan bounty yang dimenangkan dan bukan pendapatan proyek. [Participant resources](https://www.monad.xyz/developers/hackathons/metropolis). Pemilihan tools, MCP endpoint dan perk values ada di [resource notes](archava-monad-resources.md).

## Form keputusan setelah login portal

Isi satu baris untuk setiap bounty yang benar-benar dipilih. Row yang belum diisi **belum eligible confirmed**.

| Bounty | Track 02 diterima? | Testnet 10143 diterima? | SDK/use case wajib | Evidence/field resmi | Deadline/terms | Go/no-go |
| --- | --- | --- | --- | --- | --- | --- |
| Privy | Belum dikonfirmasi | Belum dikonfirmasi | Baca portal | Baca portal | Baca portal | Target provisional |
| Envio | Belum dikonfirmasi | Belum dikonfirmasi | Baca portal | Baca portal | Baca portal | Target provisional |

**Checklist claim sponsor:** code integrasi terlihat, fitur dipakai di live demo, field portal lengkap, network dan track memenuhi rule, evidence tidak mengandung secret. Jangan menganggap install SDK atau menambahkan logo sudah cukup. Rencana lengkap dan dependency ada di [blueprint](archava-monad-metropolis.md).
