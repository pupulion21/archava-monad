# Evidence persiapan clone Archava Monad

Tanggal: 11 Oktober 2026, WIB. User mengizinkan clone source yang berguna; scope pekerjaan ini adalah menyiapkan source lokal, bukan menuntaskan seluruh S01.

## Source dan lokasi

- Source existing: `Archzxylabs/Archava`.
- Clone persiapan: `/home/pupulion/Archava-Monad-Blueprint/Archava-Monad`.
- Target runtime yang diusulkan blueprint: `/home/pupulion/Archava-Monad`. Folder sibling tersebut berada di luar area tulis sesi, sehingga belum dibuat.
- Branch aktif: `monad`.
- Commit baseline: `fc39413a0e1bf72e875f9ee59df2bcfbf64ead94`.
- Tree baseline: `544c64a8638bddb7fefc22266562e12ae0f493b2`.
- Remote repo dan submodule: kosong. Repo GitHub Monad dan layanan hosting belum dibuat atau dihubungkan.

## Cara memperoleh source

Akses GitHub langsung lewat shell gagal karena DNS; permintaan eksekusi dengan izin tambahan ditolak otomatis oleh aturan sesi. Clone awal memakai repo lokal `/home/pupulion/Archava` pada commit `297aa1bef07752f494fa8a522d94c399e6d93446`, dengan `git clone --no-checkout --no-hardlinks`, lalu origin lokal segera dilepas.

Source pinned dipulihkan dari cache GitHub API yang dibuat saat pemeriksaan blueprint: `/tmp/archava-baseline-compare.json` dan `/tmp/archava-remote-main.json`. Seluruh 50 file hasil patch cocok dengan blob SHA GitHub. Setelah mempertahankan executable bit `entrypoint.sh`, tree Git cocok persis dengan tree baseline di atas. Metadata commit unsigned dari cache juga menghasilkan objek commit dengan SHA asli yang sama persis; tidak dibuat commit pengganti atau perubahan implementasi.

Objek pinned yang terverifikasi dipindahkan ke clone lewat fetch lokal tanpa menambahkan remote, kemudian branch `monad` memilih commit tersebut. Boundary shallow pada commit pinned dicatat oleh Git; tujuh commit parent yang belum tersedia tidak diklaim sudah diunduh. History lokal lama tetap tersedia pada branch existing. Main GitHub terkini belum diperiksa ulang secara live. Cache `/tmp` hanya sumber pemulihan; seluruh objek yang diperlukan checkout sudah berada di `.git` clone dan tidak menggunakan alternates atau hardlink ke source/scratch.

Submodule `packages/contracts/lib/forge-std` juga di-clone independen dengan `--no-hardlinks` dari checkout lokal, pada commit `f3dae6e6ee381f25eb6a246f7da9b85c91a68219`. Origin dilepas dan Git directory submodule ditempatkan di `.git/modules/` clone sendiri. URL upstream Foundry pada `.gitmodules` tetap metadata dependency; tidak ada remote BNB.

## Verifikasi

- HEAD, branch dan tree sesuai baseline yang dicatat.
- Integritas objek repo dan submodule diperiksa dengan `git fsck --full --strict`; keduanya exit 0. Submodule hanya mempunyai notice dangling commits setelah origin dilepas, tanpa object corruption.
- Submodule sesuai gitlink baseline; checkout source bersih sebelum menambahkan salinan dokumen.
- Git directory berada di clone sendiri; tidak ada alternates atau objek yang berbagi inode dengan checkout BNB/scratch.
- `.env`, `.vercel`, state `data/`, `node_modules`, `.venv` dan linkage Railway lokal tidak disalin.
- Checkout BNB tidak diubah; tracked diff tetap kosong, arsip `plans/` tetap untracked.

Seluruh pemeriksaan di atas pass. Source root berisi 154 tracked paths; `git diff --exit-code` dan `git diff --cached --exit-code` kosong sebelum dokumen ditambahkan. Histori shallow dan pemeriksaan live upstream yang pending dicatat sebagai batas hasil ini.

Dokumen rencana disalin ke `plans/` clone sebagai snapshot referensi; dokumen otoritatif saat ini tetap di folder blueprint. Evidence ini adalah pemeriksaan clone, bukan hasil build/test/runtime Monad. Dependencies aplikasi belum di-install dan API/worker/deploy tidak dijalankan.

## Cursor S01

Clone source selesai. S01 tetap **in progress**: sanitasi default BNB/rewrite/aliases, startup lock, deployment-target guard, CI, pemeriksaan eligibility dan provisioning target baru belum dikerjakan. Source masih mempunyai konfigurasi BNB inherited yang akan diadaptasi pada S01.

History pinned dapat dilengkapi saat akses GitHub tersedia, melalui fetch upstream sementara tanpa menjadikan repo BNB sebagai origin. Repo Monad baru baru boleh menerima push setelah sanitasi dan guard S01 terpenuhi sesuai blueprint.
