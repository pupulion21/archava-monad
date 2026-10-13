# Archava Monad Contract Interfaces & Integration Specification

Dokumentasi antarmuka smart contract, skema manifest kanonis, event definitions, serta aturan kredit untuk Archava Monad Testnet (Chain ID 10143).

---

## 1. Canonical Deployment Manifest Schema

Manifest deployment kanonis disimpan di [`packages/contracts/deployments/monadTestnetV2.json`](file:///home/pupulion/Archava-Monad/packages/contracts/deployments/monadTestnetV2.json).

### Schema Definition (`MonadDeploymentManifest`)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "MonadDeploymentManifest",
  "type": "object",
  "required": [
    "schemaVersion",
    "deploymentId",
    "network",
    "chainId",
    "deployedAt",
    "deployer",
    "owner",
    "contracts",
    "packages",
    "compiler"
  ],
  "properties": {
    "schemaVersion": { "type": "string", "enum": ["1.0.0"] },
    "deploymentId": { "type": "string" },
    "network": { "type": "string", "enum": ["Monad Testnet"] },
    "chainId": { "type": "integer", "enum": [10143] },
    "deployedAt": { "type": "string", "format": "date-time" },
    "deployer": { "type": "string", "pattern": "^0x[0-9a-fA-F]{40}$" },
    "owner": { "type": "string", "pattern": "^0x[0-9a-fA-F]{40}$" },
    "contracts": {
      "type": "object",
      "required": ["mockUsdt", "rentalV2"],
      "properties": {
        "mockUsdt": {
          "type": "object",
          "required": [
            "name",
            "address",
            "deployTxHash",
            "deployBlock",
            "constructorArguments",
            "abi",
            "verificationStatus",
            "explorerUrl"
          ],
          "properties": {
            "name": { "type": "string", "enum": ["ArchavaMockUSDT"] },
            "address": { "type": "string", "pattern": "^0x[0-9a-fA-F]{40}$" },
            "deployTxHash": { "type": "string", "pattern": "^0x[0-9a-fA-F]{64}$" },
            "deployBlock": { "type": "string" },
            "constructorArguments": { "type": "array", "items": [{ "type": "string" }] },
            "abi": { "type": "array" },
            "verificationStatus": { "type": "string", "enum": ["verified", "pending", "unverified"] },
            "explorerUrl": { "type": "string", "format": "uri" }
          }
        },
        "rentalV2": {
          "type": "object",
          "required": [
            "name",
            "address",
            "deployTxHash",
            "deployBlock",
            "constructorArguments",
            "abi",
            "verificationStatus",
            "explorerUrl"
          ],
          "properties": {
            "name": { "type": "string", "enum": ["ArchavaRentalV2"] },
            "address": { "type": "string", "pattern": "^0x[0-9a-fA-F]{40}$" },
            "deployTxHash": { "type": "string", "pattern": "^0x[0-9a-fA-F]{64}$" },
            "deployBlock": { "type": "string" },
            "constructorArguments": { "type": "array", "items": [{ "type": "string" }] },
            "abi": { "type": "array" },
            "verificationStatus": { "type": "string", "enum": ["verified", "pending", "unverified"] },
            "explorerUrl": { "type": "string", "format": "uri" }
          }
        }
      }
    },
    "packages": { "type": "array" },
    "compiler": {
      "type": "object",
      "properties": {
        "solcVersion": { "type": "string" },
        "optimizer": { "type": "boolean" },
        "runs": { "type": "integer" },
        "evmVersion": { "type": "string" }
      }
    }
  }
}
```

---

## 2. ABI Locations & Reference

File kompilasi dan ABI kanonis:
- **Build Artifacts Foundry**:
  - `ArchavaMockUSDT`: [`packages/contracts/out/ArchavaMockUSDT.sol/ArchavaMockUSDT.json`](file:///home/pupulion/Archava-Monad/packages/contracts/out/ArchavaMockUSDT.sol/ArchavaMockUSDT.json)
  - `ArchavaRentalV2`: [`packages/contracts/out/ArchavaRentalV2.sol/ArchavaRentalV2.json`](file:///home/pupulion/Archava-Monad/packages/contracts/out/ArchavaRentalV2.sol/ArchavaRentalV2.json)
- **Deployment Manifest**:
  - `contracts.mockUsdt.abi`: array ABI lengkap ERC-20 + faucet.
  - `contracts.rentalV2.abi`: array ABI lengkap RentalV2 (`rent`, `quoteRent`, `packageDetails`, `activeAccesses`, events, etc.).
- **Public Fixture**:
  - [`docs/monad/fixtures/public-config.json`](file:///home/pupulion/Archava-Monad/docs/monad/fixtures/public-config.json)

---

## 3. Smart Contract Events

### `AccessRented` (ArchavaRentalV2)

Diemisikan setiap kali pengguna berhasil membeli atau memperpanjang paket sewa:

```solidity
event AccessRented(
    address indexed wallet,
    uint8 indexed packageId,
    uint256 includedMinutes,
    uint256 expiresAt,
    uint256 amountPaid
);
```

- **`wallet`** (`address`, indexed): Alamat wallet pembeli (dipakai oleh indexer Envio sebagai field filter/lookup).
- **`packageId`** (`uint8`, indexed): ID paket (1 = Starter, 2 = Pro).
- **`includedMinutes`** (`uint256`): Menit kuota suara yang dikreditkan ke akun (60 untuk Starter, 300 untuk Pro).
- **`expiresAt`** (`uint256`): Unix timestamp masa berlaku akses (perpanjangan akumulatif jika paket masih aktif).
- **`amountPaid`** (`uint256`): Jumlah token mUSDT yang dibayarkan dalam base units (6 desimal).

### `PackageConfigured` & `PackageRemoved`

```solidity
event PackageConfigured(uint8 indexed packageId, uint256 price, uint256 validityDuration, uint256 includedMinutes);
event PackageRemoved(uint8 indexed packageId);
```

---

## 4. Package Definitions & Credit Rules

| Parameter | Paket 1: Starter | Paket 2: Pro |
|---|---|---|
| **Package ID** | `1` | `2` |
| **Nama** | Starter | Pro |
| **Harga Display (IDR)** | Rp 79.000 | Rp 299.000 |
| **Harga mUSDT** | `4.9375` mUSDT | `18.6875` mUSDT |
| **Base Units (6 Desimal)** | `4937500` | `18687500` |
| **Included Minutes** | **60 menit** (3.600 detik) | **300 menit** (18.000 detik) |
| **Validity Duration** | 30 hari (2.592.000 detik) | 30 hari (2.592.000 detik) |
| **Status Default** | Active (`true`) | Active (`true`) |

### Aturan Perpanjangan dan Upgrade:
1. Jika pengguna membeli saat paket sebelumnya masih aktif (`block.timestamp < expiresAt`):
   - Waktu kadaluarsa baru: `expiresAt = oldExpiresAt + validityDuration` (akumulasi durasi kalender).
   - Menit suara: ditambahkan ke saldo kuota pengguna di state backend (`creditBalance += includedMinutes`).
2. Jika pengguna membeli setelah paket kadaluarsa (`block.timestamp >= expiresAt`):
   - Waktu kadaluarsa baru: `expiresAt = block.timestamp + validityDuration`.
   - Menit suara: diinisialisasi ulang atau ditambahkan sesuai aturan billing.

---

## 5. Token mUSDT Specification

- **Name**: `Archava Mock USDT`
- **Symbol**: `mUSDT`
- **Decimals**: `6`
- **Initial Supply**: `0`
- **Faucet Function**:
  ```solidity
  function faucet() external;
  function hasClaimed(address) external view returns (bool);
  function FAUCET_AMOUNT() external view returns (uint256);
  ```
  - Memberikan `100` mUSDT (`100_000_000` base units) per wallet pemanggil satu kali (`hasClaimed[msg.sender] == true`).
  - Tidak memungut biaya selain gas native MON pada Monad Testnet.

---

## 6. Public Client Metadata (`/api/config` & Frontend Safe)

Metadata publik tidak memuat credentialed RPC URLs, API keys, private keys, atau Railway/LiveKit secrets.

```json
{
  "network": {
    "name": "Monad Testnet",
    "chainId": 10143,
    "nativeCurrency": {
      "name": "MON",
      "symbol": "MON",
      "decimals": 18
    },
    "rpcUrl": "https://testnet-rpc.monad.xyz",
    "explorerUrl": "https://testnet.monadscan.com"
  },
  "contracts": {
    "mockUsdt": {
      "address": "<DEPLOYED_MOCK_USDT_ADDRESS>",
      "decimals": 6,
      "symbol": "mUSDT"
    },
    "rentalV2": {
      "address": "<DEPLOYED_RENTAL_V2_ADDRESS>"
    }
  },
  "packages": [
    {
      "packageId": 1,
      "name": "Starter",
      "displayPriceIdr": 79000,
      "priceMusdt": "4.9375",
      "priceUnits": "4937500",
      "includedMinutes": 60,
      "validityDays": 30
    },
    {
      "packageId": 2,
      "name": "Pro",
      "displayPriceIdr": 299000,
      "priceMusdt": "18.6875",
      "priceUnits": "18687500",
      "includedMinutes": 300,
      "validityDays": 30
    }
  ]
}
```
