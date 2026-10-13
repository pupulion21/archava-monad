# Indeks blueprint Archava Monad

Revision4, 11 Oktober 2026. Scope: **blueprint, pemilihan resources dan persiapan clone source lokal**, belum migrasi kode, membuat repo GitHub/layanan, install tools, claim voucher, transaksi atau publish.

Dokumen aktif di `/home/pupulion/Archava-Monad-Blueprint/plans/`, di luar folder BNB. Salinan revision1–3 di `/home/pupulion/Archava/plans/` adalah arsip; keputusan shared repo/worktree di sana sudah digantikan.

## Dokumen

- [Blueprint utama](archava-monad-metropolis.md): **delapan PR**, isolasi repo/hosting/credentials, kontrak, tests, rollback dan jadwal.
- [Resources terpilih](archava-monad-resources.md): Monad docs, Privy embedded EOA, Envio Testnet/indexer, satu RPC; MCP docs optional.
- [Matriks sponsor](archava-monad-sponsors.md): 21 bounty publik sebagai referensi; target hanya Privy+Envio provisional.
- [Review adversarial](archava-monad-review.md): riwayat revision1–3 dan gate revision4.
- [Evidence clone lokal](archava-monad-clone.md): source pinned yang sudah tersedia, independensi Git dan pekerjaan S01 yang masih pending.
- [Mapping kekurangan](archava-monad-gap-map.md): fondasi reuse, 16 gap, prioritas P0/P1/P2, input dan bukti selesai setiap step; pelengkap blueprint berdasarkan inspeksi source.
- [Prompt implementasi S01](archava-monad-s01-prompt.md): wajib memakai monskill dan mengerjakan kode di repo yang disiapkan user. Setup GitHub, remote, push dan PR bukan tugas agent dalam prompt ini.

## Keputusan yang harus dipertahankan

- Source existing `Archzxylabs/Archava`, pinned baseline `fc39413a0e1bf72e875f9ee59df2bcfbf64ead94`; jangan implementasi di `/home/pupulion/Archava`.
- Target runtime `/home/pupulion/Archava-Monad`, clone/.git independen; proposed GitHub repo `Archzxylabs/Archava-Monad`, default/integrasi `monad`. Remote BNB dilepas segera setelah clone, origin hanya repo baru.
- Clone persiapan saat ini berada di `/home/pupulion/Archava-Monad-Blueprint/Archava-Monad` karena target folder sibling berada di luar area tulis sesi. Source sudah cocok dengan pinned baseline; lokasi runtime kanonis di atas tetap usulan. Repo GitHub/hosting belum dibuat atau dihubungkan.
- User menyiapkan repo GitHub baru sendiri. Prompt berikutnya wajib memakai [monskill](/home/pupulion/.agents/skills/monskill/SKILL.md) dan fokus pada implementasi kode; instruksi membuat repo, mengatur remote, push dan PR sudah dihapus dari scope agent.
- S01 sanitasi default BNB, API rewrite dan broadcast aliases; target guard sebelum push/deploy serta **startup lock API/worker sebelum client/sweeper/jobs**. Runtime disabled sampai validated S03; inherited BNB shell env harus reject tanpa side effect.
- Vercel project/domain, Railway **project/environment/service/volume**, LiveKit project, Privy app, Envio indexer, RPC/voice credentials dan deployer wallet khusus Monad.
- Reuse RentalV2+MockUSDT Solidity, deployment baru **Testnet10143**; active runtime/deployer tidak menyediakan chain97/fallback.
- `ARCHAVA_STATE_DIR` existing, satu API writer; tidak copy/import ledger/env/linkage BNB.
- Track02; sponsor provisional `{Privy, Envio}`. Tidak ada KIMI, Alchemy MCP/skills, trading atau agent payments dalam sprint.
- Deadline publik 14 Oktober2026 10:59WIB; internal 13 Oktober20:00WIB; effective portal rules/deadline dikonfirmasi S01.

## Cursor

Revision4: **accepted and verified**. Review H3/M5/M6 dan 3 temuan review terakhir selesai diverifikasi di S01. S02 (contracts, deployer tooling, RPC guard, source verification, interface specification, serta regression tests) dan S03 (Monad backend integration, incremental purchase cache & scanner, purpose-bound challenges, scoped state isolation, room isolation, container smoke readiness) selesai diimplementasikan dan diverifikasi 100% di workspace Monad independen.

| Step | Status | Commit / evidence |
| --- | --- | --- |
| S01 independent repo/target guard/eligibility | verified complete | [S01 evidence](../docs/monad/S01-evidence.md) |
| S02 contracts/deploy/interfaces | verified complete | [S02 evidence](../docs/monad/S02-evidence.md) |
| S03 API/state/staging | verified complete | [S03 evidence](../docs/monad/S03-evidence.md) |
| S04 wallet/frontend | ready to start | — |
| S05 Privy | not started | — |
| S06 Envio | not started | — |
| S07 release/live smoke | not started | — |
| S08 submission | not started | — |

Setelah setiap PR catat verified exit, commit/evidence, rollback dan next step. De-scope sponsor harus memperbarui selected set, dependencies/diagram/tests/rollback; `skipped` bukan `done`. Public evidence tidak berisi env/key/ledger/signatures.
