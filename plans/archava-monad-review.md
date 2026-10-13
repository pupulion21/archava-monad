# Review adversarial blueprint Archava Monad

**STATUS AKTIF — revision4: accepted as plan, runtime execution pending.** Seluruh temuan critical/high/medium sudah ditutup pada level rencana. Dokumen aktif berada di `/home/pupulion/Archava-Monad-Blueprint/plans/`; keputusan shared repo/worktree revision1–3 telah digantikan clone/repo independen. Verdict awal dan findings di bawah adalah riwayat review; resolusi revision4 terdapat pada bagian terakhir. Belum ada implementasi, transaksi, deployment atau runtime tests dalam pekerjaan review ini.

Reviewer: agent terpisah untuk gate ECC `blueprint`. Tanggal: 11 Oktober 2026. Target awal: revision 1; pemeriksaan ulang revision 2 dicatat di bawah. Review ini hanya membaca dokumen/kode; tidak menjalankan aplikasi, transaksi, deployment atau submission.

**Verdict awal: revisi dahulu.** Tidak ditemukan critical, tetapi ada **2 high dan 4 medium** yang harus mendapat koreksi atau keputusan eksplisit. Arsitektur dasar layak; draft belum sepenuhnya siap dieksekusi oleh agent baru tanpa keputusan tambahan.

## High

### H1 — Jalur entitlement masih mewarisi scan seluruh histori pada setiap request

**Lokasi:** blueprint S03; baseline `server/rental.mjs`, `createCreditReader`.

Reader mengulang `getLogs` dari deployment block sampai head pada setiap pembacaan saldo, dengan rentang tetap 5.000 blok. Draft hanya mengganti chain/config dan menambahkan fail-closed. Itu belum menangani biaya request yang terus tumbuh, batas rentang provider, rate limit, atau konsistensi saat chain berubah. UI Envio tidak membantu jalur ini karena sengaja bukan sumber entitlement. Akibatnya pembayaran sukses dapat diikuti akses yang timeout/gagal, terutama setelah deployment berumur beberapa hari. Besaran limit provider harus diperiksa, tidak diasumsikan sama dengan BNB.

**Koreksi:** S03 wajib memilih strategi authoritative RPC yang bounded: rentang log sesuai provider/adaptive split, timeout/retry terbatas, dan incremental cursor/cache yang merekonsiliasi jendela reorg dengan deduplikasi event. Cache belum tervalidasi tidak boleh memberi akses. Jika memakai strategi lebih sederhana untuk sprint, catat batas usia deployment/volume yang didukung dan buktikan request budget serta latency pada rentang tersebut. Jangan mengalihkan entitlement ke GraphQL hanya untuk menghindari masalah.

**Exit tambahan:** tests untuk rentang histori setara umur demo sampai judging, provider range rejection/429, duplicate/replayed/reorg events, timeout fail-closed, dan pengukuran live receipt→balance pada endpoint Monad yang dipilih. Masukkan kebutuhan kerja ini ke estimasi S03.

### H2 — Config dan manifest baru belum mempunyai jalur masuk ke Docker image

**Lokasi:** blueprint struktur hasil akhir, S02/S03/S07; Dockerfile remote main `fc39413a`.

Draft menuntut runtime membaca `config/networks.json` dan manifest deployment. Dockerfile baseline frontend hanya menyalin root build files, `src/` dan `public/`; runtime hanya menyalin `server/`, `backend/`, `dist/` dan dependencies. Tidak ada `COPY` untuk config atau manifest. S07 menyebut perubahan Docker bersyarat untuk public Privy build variable, sehingga kebutuhan packaging artifact wajib bisa terlewat. Build lokal lulus tidak membuktikan file tersedia di Railway.

**Koreksi:** tetapkan path runtime manifest/config dan ownership Dockerfile pada S03, dengan final verification di S07. Salin hanya metadata publik yang diperlukan ke build/runtime stage; periksa `.dockerignore`. Jika frontend menerima seluruh metadata lewat `/api/config`, nyatakan itu secara eksplisit agar tidak membutuhkan import root config yang hilang di frontend stage.

**Exit tambahan:** jalankan image hasil build dengan konfigurasi uji/manifest yang tepat dan buktikan `/api/config` serta reader menemukan artifact di dalam image. `docker build` saja tidak cukup. Test fixture/offline tidak menggantikan live network check.

## Medium

### M1 — Parallel S03/S04 mengandung dependency interface yang tidak direpresentasikan

Tabel dan Mermaid menyebut S04 hanya bergantung pada S02, tetapi context brief S04 membutuhkan frozen API schema S03. Kalimat “setelah disepakati” belum memberikan artifact yang bisa dibaca agent baru.

**Koreksi:** paling sederhana, keluarkan public config/wallet/auth schema beserta fixture sebagai output S02, lalu S03 dan S04 mengonsumsinya. Alternatif: catat checkpoint S03a dan edge S03a→S04. Sertakan owner, lokasi file dan hash/commit interface; sinkronkan DAG, brief, exit dan ownership.

### M2 — Fallback Privy meninggalkan Envio dengan dependency yang tidak terpenuhi

Saat S05 di-skip, S06 tetap bergantung pada S05. Catatan fallback justru mengubah S07 menjadi hanya S03+S04, walaupun Envio mungkin tetap dipilih.

**Koreksi:** nyatakan dependency conditional: S06 menunggu S03+S04 dan S05 hanya jika Privy dipilih. S07 menunggu core S03+S04 dan seluruh integrasi sponsor yang masih dipilih. Untuk keputusan skip, perbarui tabel, Mermaid, brief dan indeks sekaligus; jangan menganggap langkah skipped memenuhi dependency produk yang belum ada.

### M3 — Risiko hosting/voice baru dipatahkan terlalu dekat deadline

Draft baru menempatkan release hosting dan bukti live lengkap pada S07, setelah Privy dan Envio. Kesehatan GET deployment BNB tidak membuktikan credentials, model quota, avatar, koneksi microphone, atau worker di deployment baru bekerja. Jadwal 13 Oktober pagi menyisakan sedikit waktu untuk memperbaiki masalah provider/hosting.

**Koreksi:** tambahkan checkpoint staging dini sesudah S03/S04, paling lambat 12 Oktober sebelum investasi sponsor lanjutan: image benar-benar berjalan pada service/volume baru, paid external-wallet flow dan real voice/avatar bekerja. S07 menjadi promosi/pengerasan release yang sudah pernah terbukti. Domain dan origin final dapat disiapkan S01/S03; jangan menunggu S07 untuk seluruh provisioning. KIMI tetap paling awal dipotong. Estimasi nominal mandatory saat ini 21–36 jam kerja aktif; review, provider onboarding dan dua perbaikan high belum jelas termasuk, jadi hindari menyebutnya janji realistis untuk satu builder.

### M4 — Satu replica belum mendefinisikan prosedur satu writer selama rollout

State JSON memerlukan satu writer, tetapi release/rollback hanya menyatakan satu replica dan menunda ketika ada paid room. Belum ada prosedur mencegah request baru masuk saat menunggu drain atau membuktikan writer lama berhenti sebelum writer baru memakai volume yang sama.

**Koreksi:** runbook menetapkan maintenance gate untuk create-session baru, drain dengan batas waktu dan pemeriksaan reservations, backup konsisten, hentikan writer lama sebelum membuka writer baru, lalu validasi scope/schema dan restore traffic. Periksa perilaku deployment Railway yang dipilih; jangan mengasumsikan setting replica saja menyelesaikan overlap rollout. Rollback code terhadap volume aktif jangan memulihkan backup usage lama yang mengembalikan menit yang sudah dikonsumsi.

## Area yang sudah ditangani dengan benar

- Baseline local/remote dibedakan dan tidak ada instruksi overwrite/reset checkout lama.
- Reuse RentalV2, deploy terpisah, token mock diberi label jujur; residual lifetime-minute semantics disebutkan.
- Provider terpilih digunakan untuk transaksi serta dua tujuan signature; login Privy bukan entitlement; verifier EOA dibatasi dengan jelas.
- LiveKit project baru menghindari sweeper BNB yang masih memproses seluruh metadata `product: archava`.
- State BNB tidak diimpor, schema scope dan rollback compatibility masuk plan; GraphQL tidak menjadi sumber saldo.
- Test mocks, GET health/readiness, transaksi nyata dan voice proof tidak disamakan.
- Sponsor eligibility belum diklaim terkonfirmasi, credits/perks dibedakan dari bounty, field/rules portal menjadi gate S01.
- Terdapat rollback per langkah, pemotongan scope, disclosure existing work dan receipt final submission.

## Gate penutupan review

Parent harus memperbaiki H1/H2 sebelum menetapkan blueprint final, lalu catat resolusi setiap M1–M4 atau alasan menerima risiko. Pembaruan ini adalah perbaikan **rencana**, bukan permintaan mengimplementasikan fitur sekarang. Status approval di indeks baru boleh diperbarui setelah dokumen revisi diperiksa terhadap temuan tersebut.

Sumber inspeksi: skill ECC `blueprint` lokal; tiga dokumen `plans/`; kode kontrak/auth/usage/reader lokal pada baseline yang disebut blueprint; Dockerfile dan dependencies remote main yang dipin, dibaca dari salinan read-only `/tmp/archava-main-2.txt` dan `/tmp/archava-main-8.txt`. Tidak ada klaim telah melakukan live runtime validation.

## Pemeriksaan ulang revision 2

Tanggal: 11 Oktober 2026. Dibaca ulang: blueprint revision 2, indeks plan, dan dokumen baru `archava-monad-resources.md`. Temuan awal di atas dipertahankan sebagai riwayat; tabel berikut menyatakan status setelah koreksi.

| Temuan | Status review rencana | Koreksi yang diperiksa |
| --- | --- | --- |
| H1 — RPC scan tidak bounded | Resolved | S03 sekarang merencanakan scanner deployment-scoped, finalized-only, cursor/totals atomik, adaptive ranges, retry/time budget, freshness/pending, invalidation fail-closed, aged-gap sampai akhir judging, crash/reorg/rate-limit tests dan target latency live. Estimasi S03 naik menjadi 5–8 jam. |
| H2 — Artifact hilang dari image | Resolved | Path `/app/config/networks.json` dan `/app/packages/contracts/deployments/monadTestnetV2.json` eksplisit; S03 memiliki COPY/.dockerignore serta probe API-only di image; S07 mengulang probe bersama verifikasi live. |
| M1 — Dependency interface tersembunyi | Resolved | S02 menghasilkan committed interface dan public-config fixture sebelum S03/S04 berjalan paralel; brief serta graph sudah konsisten. |
| M2 — Fallback sponsor tidak konsisten | Resolved | Selected set dan semua kombinasi skip Privy/Envio memiliki dependency eksplisit; S07 menunggu core G1 dan integrasi sponsor yang tetap dipilih. |
| M3 — Live hosting/voice terlalu akhir | Resolved | Provisioning dimajukan, S03 memeriksa staging voice, G1 mewajibkan paid external-wallet flow dan persistent restart pada 12 Oktober sebelum sponsor. Estimasi membedakan core, sponsor dan antrean eksternal. |
| M4 — Rollout satu writer tidak lengkap | Resolved | Maintenance gate, drain, backup konsisten, stop-before-start, pemeriksaan perilaku Railway, startup validation, penundaan saat call aktif dan mempertahankan usage terbaru saat rollback tertulis eksplisit. |

Resource notes membatasi klaim dengan benar: kategori MCP terlihat pada client publik, katalog lengkap memerlukan login, exact server endpoints belum terverifikasi dan tool belum diasumsikan terpasang. Link user menjadi input S01, sedangkan setup MCP tetap opsional dan tidak mengubah dependency produk atau membuktikan sponsor integration. Kebutuhan Foundry mode Monad dan Envio network support dicantumkan bersama sumber resmi serta verifikasi akun/runtime saat eksekusi.

Catatan koordinasi kecil yang disampaikan ke parent: S03 menambah npm script root untuk container probe, sedangkan S04 memiliki perubahan root dependencies. Serialkan handoff `package.json` melalui satu owner atau commit sebelum branch parallel, supaya aturan ownership tidak bertentangan. Ini tidak membuka kembali temuan high atau desain arsitektur.

**Verdict akhir: accepted as plan, runtime execution pending.** Tidak ada critical/high yang tersisa dari review. Semua enam temuan awal telah ditangani pada level dokumen. Status ini tidak menyatakan scanner/cache sudah diimplementasikan, image sudah lolos smoke, transaksi/voice sudah bekerja, atau eligibility sponsor sudah dikonfirmasi. Semua itu tetap exit criteria eksekusi; langkah implementasi masih dimulai dari S01 setelah diminta user.

## Pemeriksaan terbatas revision 3

Tanggal: 11 Oktober 2026. Scope: tambahan katalog resources yang diberikan user, hubungan S01/S05/S06 dengan resource notes, tabel participant perks, indeks plan dan penutupan catatan ownership. Arsitektur runtime serta conditional dependency graph tidak berubah dari revision 2.

**Verdict: revision 3 accepted as plan, runtime execution pending.** Tidak ada temuan critical/high baru. Pilihan resources konsisten dengan scope produk: Monad deploy/gas/RPC docs untuk porting; Privy embedded EOA pattern sebagai referensi bagi React/Vite existing; Envio CLI/skills/docs untuk indexer. Template Next.js/PWA tidak dijadikan alasan mengganti framework. Envio Docs MCP dipisahkan dari runtime indexer dan entitlement; token local/self-hosted dibedakan dari akses Envio Cloud.

Alchemy MCP ditempatkan sebagai tooling opsional dengan OAuth dan pemilihan app, serta pengecekan chain sebelum query. `alchemy-api` tidak disamakan dengan agentic gateway/x402 atau pembayaran compute otomatis. Dokumen membedakan endpoint yang dirujuk publisher dengan koneksi tool yang benar-benar sudah aktif: instalasi, OAuth, handshake dan claim voucher belum dilakukan. Perk new-account QuickNode, eligibility resource lain dan batas satu voucher per tim/resource diatribusikan pada katalog dari user, tanpa dipromosikan menjadi konfirmasi kelayakan bounty.

**Catatan ownership revision 2 resolved:** S03 sekarang memanggil `node scripts/container-config-smoke.mjs` langsung, sehingga tidak perlu mengubah root `package.json` milik S04; ownership CI juga dinyatakan. Semua temuan awal dan catatan koordinasi review telah ditutup pada level rencana. Klaim readiness runtime, pemenuhan bounty dan keberhasilan deployment tetap menunggu bukti saat eksekusi.

## Review revision 4 — repo dan runtime independen

Tanggal: 11 Oktober 2026. Dokumen otoritatif yang diperiksa berada di `/home/pupulion/Archava-Monad-Blueprint/plans/`. Review revision1–3 di atas adalah riwayat; keputusan shared repo/worktree sudah digantikan. Review ini membaca blueprint, resources, matriks sponsor, indeks dan baseline dependency bootstrap; tidak melakukan implementasi atau tindakan eksternal.

**Verdict awal revision4: perlu koreksi 1 high dan 2 medium.** Pemisahan clone/.git/repo, seluruh project Railway, Vercel, LiveKit, state dan credentials adalah arah yang konsisten dengan permintaan user. Delapan PR dan pemotongan KIMI/Alchemy tooling membuat scope lebih terfokus. Temuan baru terkait batas bootstrap/runtime, bukan pembukaan kembali H1/H2.

### H3 — Guard deploy belum memblokir runtime yang menerima env BNB

S01 membersihkan template/rewrite/aliases dan memberi guard untuk push/deploy/broadcast. Namun baseline `createDependencies({ env = process.env })` masih mempunyai default chain97/origin BNB dan membuat LiveKit client dari env sebelum S03; sweeper memakai project tersebut. Folder baru dan tidak menyalin `.env` tidak menghapus variabel yang diwarisi dari shell atau konfigurasi runtime. Menjalankan API/worker langsung dapat melewati guard deploy dan memakai target lama.

**Koreksi:** S01 memasang startup lock/fail-closed sebelum real provider clients atau background jobs sampai loader/isolation S03 siap; tests memakai env allowlist dan fake provider secara eksplisit. S03 memvalidasi actual chain, selected manifest, LiveKit URL/project scope, state directory/scope, serta konfigurasi API/worker yang sama sebelum memulai business calls, sweeper atau room dispatch. Guard target yang hanya memeriksa file/CLI linkage tidak menggantikan runtime check. Worker startup juga harus melewati batas ini. Tidak perlu mengasumsikan credentials BNB saat ini benar-benar ada di shell untuk menguji kasus tersebut.

**Exit tambahan:** negative fixtures inherited BNB RPC/LiveKit URL/state path dan missing target menolak startup sebelum provider business calls/room mutation; validation RPC yang read-only dibatasi secara eksplisit. Positive test dengan konfigurasi Monad lengkap membuka clients/jobs. S01 local tests tidak memakai credentials operator.

### M5 — Expected migration failures belum mempunyai batas CI yang executable

S01 mengganti fixture expected Monad sebelum loader/UI S03/S04 siap, sementara deployment tests baru diadaptasi S02. Exit memperbolehkan expected migration failures tanpa daftar test, pemilik dan kapan gate harus hijau. Agent baru bisa menganggap semua CI merah boleh diabaikan.

**Koreksi:** isolation/guard/startup-lock, generic contract tests dan build yang relevan harus hard-green S01. Kalau ada kegagalan transisi, daftar test spesifik, alasan, owner dan step penghapusannya secara machine-readable atau eksplisit di evidence; tidak memakai blanket `continue-on-error`. Alternatif yang lebih bersih adalah fail-closed fixtures yang sudah dapat lulus pada S01. S02/S03/S04 harus menghapus pengecualian masing-masing; G1 tidak membawa expected failures.

### M6 — Bootstrap branch belum memberi diff PR S01 yang jelas

Instruksi first push sanitized baseline lalu membuat PR S01 dari baseline tersebut belum menjelaskan bagian mana yang menjadi isi PR S01. PR bisa kosong atau sanitasi utama telanjur masuk default branch tanpa review step.

**Koreksi:** pilih dan tulis urutan konkret: buat branch `monad/s01-isolation` sebelum perubahan, lalu bootstrap base `monad` yang belum dapat menjalankan hosting/runtime dan buka PR sanitasi yang mempunyai diff; atau jadikan bootstrap sanitasi sebagai commit awal yang dicatat dan nyatakan bagian CI/guard/evidence yang masih direview lewat PR S01. Hosting tetap tidak terhubung/aktif sebelum gate S01 selesai. Tidak perlu menambah PR kesembilan.

Resource shortlist, pembedaan chain10143/mainnet143, pembatasan HyperSync/HyperRPC sebagai read path, resource eligibility versus bounty rules, conditional Privy/Envio DAG, dan rollback hanya layanan Monad sudah konsisten. Pemeriksaan ulang setelah koreksi H3/M5/M6 diperlukan sebelum revision4 diberi status final.

## Pemeriksaan ulang revision 4 — resolusi akhir

Tanggal: 11 Oktober 2026. Dibaca ulang: bagian isolation/startup, S01–S04, acceptance gates, bootstrap/CI sequence dan indeks pada direktori blueprint independen.

| Temuan | Status pada level rencana | Koreksi yang diperiksa |
| --- | --- | --- |
| H3 — Runtime bisa menerima env BNB | Resolved | S01 memasang default-disabled lock pada entry API dan Python worker sebelum client/sweeper/jobs/registration. S03 mewajibkan static target match sebelum network, kemudian actual chain10143/manifest/LiveKit scope/state validation; flag enable tidak menjadi bypass. Tests memakai env allowlist dan mock provider, dengan spies untuk membuktikan inherited BNB target tidak menghasilkan legacy calls, deletes atau registration. Contract guard S02 tetap jalur terpisah. |
| M5 — CI transisi tidak dibatasi | Resolved | Guard/startup/generic/typecheck/build/offline image-lock checks wajib hijau pada S01. Pengecualian migrasi memiliki exact test-name/path, baseline, alasan, owner dan removal step; unknown failures tetap blocker. S02–S04 menghapus entries masing-masing dan G1 mewajibkan allowlist kosong serta full verification hijau. BSC test references tidak dipindahkan sebelum import diadaptasi. |
| M6 — Bootstrap versus PR S01 ambigu | Resolved | Base `monad` dibootstrap dari source dengan sanitasi minimum dan startup lock, hanya dipush ke origin repo baru setelah guard lokal, tanpa hosting aktif. Feature branch S01 membawa permanent guards, tests, target record, CI dan docs sebagai diff review yang jelas. Bootstrap tidak menambah PR/deployment. |

**Verdict final revision4: accepted as plan, runtime execution pending.** Tidak ada temuan critical, high atau medium yang belum terselesaikan dalam scope review ini. Delapan PR, pemisahan repo/.git/hosting/credentials/state, guard deployment serta startup, shortlist resources dan gate sebelum sponsor konsisten satu sama lain.

Acceptance ini berlaku pada desain dan instruksi dokumen aktif di `/home/pupulion/Archava-Monad-Blueprint/plans/`. Ia tidak menyatakan guard sudah dibuat, CI pernah dijalankan, lingkungan telah terisolasi secara operasional, transaksi/voice telah berhasil atau sponsor telah mengonfirmasi eligibility. Semua pemeriksaan dan bukti tersebut tetap pekerjaan eksekusi S01–S08; tidak ada runtime, repo atau layanan yang dibuat oleh review.

## Review mapping source setelah clone

Tanggal: 11 Oktober 2026. Artifact: [mapping kekurangan](archava-monad-gap-map.md). Review adversarial read-only membandingkan 16 gap dengan blueprint revision4, indeks dan clone aktual pada `fc39413a0e1bf72e875f9ee59df2bcfbf64ead94`.

**Verdict: accepted as mapping only. Tidak ada temuan critical/high/medium.** Fondasi reuse, semantik metering/expiry, gap scanner/wallet/worker/CI/Docker, prioritas isolasi, G1 sebelum sponsor, dependencies conditional dan tautan lokal konsisten dengan source/rencana. Dokumen membedakan inspeksi statis dari bukti runtime dan verifikasi layanan eksternal.

Review ini tidak menjalankan aplikasi, install, build/tests, transaksi atau deployment. Gap map adalah checklist pekerjaan yang tersisa; S01 masih in progress pada tahap clone, S02–S08 belum dimulai.
