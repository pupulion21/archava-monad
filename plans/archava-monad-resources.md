# Resources terpilih untuk Archava Monad

Revision 4, 11 Oktober 2026. Input: [katalog resmi Metropolis](https://hackathon.monad.xyz/resources) beserta export lengkap yang diberikan user, termasuk URL publisher dan claim. Dokumen ini adalah **shortlist eksekusi**, bukan daftar semua resource yang harus dipasang. Tidak ada install MCP, claim voucher atau deployment yang dilakukan.

Tambahan instruksi user setelah mapping: sesi implementasi wajib memulai dengan [monskill lokal](/home/pupulion/.agents/skills/monskill/SKILL.md), lalu mengambil skill/reference yang relevan saja. Monskill menjadi router panduan Monad; source existing tetap dipakai ulang. Target wallet tetap Privy; wallet-integration monskill yang khusus Para dan agent-wallet Alchemy tidak otomatis mengubah selected set. Indexer skill relevan saat S06. [Prompt S01](archava-monad-s01-prompt.md) mengerjakan kode pada repo yang disiapkan user; setup GitHub, remote, push dan PR bukan tugas agent dalam prompt ini.

## Pilihan yang dipakai

| Resource | Fungsi untuk Archava | Step / keputusan |
| --- | --- | --- |
| [Monad developer summary](https://docs.monad.xyz/developer-essentials/summary), [differences](https://docs.monad.xyz/developer-essentials/differences), [gas pricing](https://docs.monad.xyz/developer-essentials/gas-pricing), [reserve balance](https://docs.monad.xyz/developer-essentials/reserve-balance) | Memeriksa kompatibilitas dan gas ketika memakai ulang RentalV2; detail opcode/precompile dibaca jika dibutuhkan | S01–S02, wajib |
| [Deploy dengan Foundry](https://docs.monad.xyz/guides/deploy-smart-contract/foundry), [verify dengan Foundry](https://docs.monad.xyz/guides/verify-smart-contract/foundry), [testnet info](https://docs.monad.xyz/developer-essentials/testnet) | Build/test artifact existing dan deploy+verify instance baru di chain10143 | S02, wajib; tidak scaffold ulang kontrak |
| [Monad JSON-RPC](https://docs.monad.xyz/reference/json-rpc/overview) | Payment crediting finalized, scan event bounded, provider-limit handling | S02–S03, wajib |
| [Privy embedded-wallet template](https://docs.monad.xyz/templates/next-serwist-privy-embedded-wallet), [Privy React SDK](https://docs.privy.io/basics/react/quickstart), [network configuration](https://docs.privy.io/basics/react/advanced/configuring-evm-networks) | Login dan selected EOA provider untuk approve/rent/sign challenge | S04–S05, target bounty; template hanya referensi pola, React/Vite tetap |
| [Envio overview](https://docs.envio.dev/docs/HyperIndex/overview), [quickstart](https://docs.envio.dev/docs/HyperIndex/quickstart), [Monad Testnet](https://docs.envio.dev/docs/HyperIndex/monad-testnet), [testing](https://docs.envio.dev/docs/HyperIndex/testing) | Index AccessRented untuk riwayat pembelian dan status sync; entitlement tetap direct RPC | S06, target bounty |
| [Envio quickstart with AI](https://docs.envio.dev/docs/HyperIndex/quickstart-with-ai) dan [indexer skills dari katalog](https://docs.envio.dev/blog/ai-agents-acting-onchain-indexer) | Membantu config/schema/handler/tests versi HyperIndex yang dipin | Hanya skills yang relevan S06; tidak install semua otomatis |
| Satu general-purpose RPC Monad Testnet | Transaksi deployer, read entitlement dan logs | S01 pilih provider; S03 ukur budget/finality/log limits |

**Network Envio harus Testnet10143.** Link `monad-testnet` dari export user sekarang redirect ke [halaman resmi Envio Testnet](https://envio.dev/chains/monad-testnet), yang mencantumkan HyperSync `https://monad-testnet.hypersync.xyz`. Resource launchpad `HyperIndex/monad` membahas mainnet143 dan tidak dipakai untuk deployment ini. Endpoint lama berbasis ID pernah ada di supported-network docs; pilih endpoint dari publisher current+installed version dan buktikan akses chain saat S06. HyperSync/HyperRPC berbeda dari general RPC broadcast; jangan mengganti RPC transaksi dengan endpoint read-only.

Template Privy memakai Next.js/PWA. Archava memakai React/Vite; ambil provider/login pattern dan SDK current saja. Scope auth MVP embedded/external **EOA**, karena verifier existing belum mendukung smart-account signatures. Gas MON/faucet tetap perlu; login bukan gas sponsorship atau paid entitlement. [Template publisher](https://docs.monad.xyz/templates/next-serwist-privy-embedded-wallet), [Privy network config](https://docs.privy.io/basics/react/advanced/configuring-evm-networks).

## RPC dan perk yang dipilih seperlunya

Default discovery/smoke memakai RPC publik pada Monad testnet info. Untuk demo, pilih **satu endpoint server/deployer dengan app/key khusus Monad**, setelah chain10143, finalized tag, historical logs, range limit dan rate budget terbukti. Jangan mengambil semua voucher hanya karena tersedia.

| Kandidat | Keputusan | Claim dari export user |
| --- | --- | --- |
| QuickNode Build: 3 bulan, sekitar $147 | Pilihan jika account memenuhi **new accounts only** pada katalog user sebelumnya, serta tier mendukung Monad Testnet. [Quickstart resmi](https://www.quicknode.com/docs/monad/quickstart) | [QuickNode Metropolis credits](https://www.notion.so/quicknode/Quicknode-Credits-for-Metropolis-Hackers-3cd15a82e84c8093b33af5fee0452ca9) |
| Dwellir Developer: 3 bulan, sekitar $147 | Alternatif jika QuickNode eligibility/access tidak cocok; cek endpoint Testnet dan quota sebelum memilih | [Dwellir](https://www.dwellir.com/) — export belum menyediakan landing claim event yang lebih spesifik |
| Tenderly Pro: sekitar $7.200 | Hanya jika benar-benar perlu debug approve/rent/deploy dan network capability sesuai. Bukan dependency atau target bounty | [Tenderly participant access](https://www.notion.so/monad-foundation/Tenderly-Access-for-Metropolis-participants-3ce6367594f280539f27d268d05431cd) |

Nilai/claim di atas berasal dari export user; eligibility tambahan QuickNode berasal dari salinan katalog sebelumnya. **Satu voucher per tim per resource**; nilai layanan bukan cash/bounty. Claim pages belum diautentikasi, voucher belum diclaim; konfirmasi terms lewat event saat S01. Spectrum, BlockVision dan Zerion perks disimpan sebagai referensi sponsor, belum dipilih.

## MCP minimum

[Envio Docs MCP](https://docs.envio.dev/docs/HyperIndex/mcp-server), endpoint publisher `https://docs.envio.dev/mcp`, **opsional saat S06** jika membantu mencari/fetch docs. Tidak diperlukan untuk checkout atau menjalankan indexer. Tool session belum connected; URL dalam katalog bukan bukti tool terpasang. Gunakan docs biasa bila setup menghabiskan waktu. HyperSync token/Cloud access tetap disiapkan sesuai account dan installed version.

Alchemy MCP/CLI/Agent Skills, Zerion agent tools, Monad Agent Kit dan Uniswap skills **tidak dipilih dalam blueprint ini**. Tidak menambah workflow x402/autonomous wallet payment untuk rental testnet.

## Yang ditunda dan alasannya

| Kelompok | Alasan |
| --- | --- |
| Aave, Morpho, Euler, Curvance, Perpl, Blend, Kuru, Uniswap, Pendle | Alur rental menit tidak menggunakan trading, lending, yield atau liquidity |
| x402, ERC-8004, Trust8004, MERA, agent wallet | Memerlukan flow payment/identity/trust tambahan di luar checkout existing |
| Privy smart wallet, Pimlico, Alchemy Smart Wallets, EIP-7702 | Menambah signature verifier/paymaster dan network scope; EOA cukup untuk MVP |
| Farcaster, React Native, Next/PWA rewrite | Format produk baru; demo web existing cukup |
| Superfluid, Sablier, pools, gifts, insurance, identity credentials | Ide produk lain; metering room Archava bukan streaming payment onchain |
| KIMI, Qwen, Hunyuan sebagai provider tambahan | Gemini/Spatius existing sudah menangani voice/avatar; fitur AI baru tidak dibutuhkan sprint |

## Batas isolasi dan pemilihan sponsor

Semua SDK/indexer/config baru ditambahkan hanya ke repo Monad independen. Privy app, Envio indexer, hosting, LiveKit, credentials dan ledger khusus Monad; tidak memasang tool atau menyalin config di checkout BNB. Detail guard dan project IDs ada di [blueprint](archava-monad-metropolis.md).

Target provisional **Track02 + Privy + Envio**. Resources membuktikan adanya dokumentasi/network support; **bukan** konfirmasi eligibility bounty. Login portal S01 harus mengonfirmasi track/network/evidence rules. Bila salah satu tidak cocok atau waktu tidak cukup, de-scope bounty dan lanjut core. Full katalog sponsor pada [matriks](archava-monad-sponsors.md) hanya bahan pembanding.
