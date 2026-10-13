import assert from "node:assert/strict";
import test from "node:test";
import { createCreditReader, createPackQuoter, normalizeWallet, RENTAL_ABI, TOKEN_ABI, purchasedState } from "./rental.mjs";

test("the V2 contract seam exposes token rental quotes, expiry, and purchase events", () => {
  assert.deepEqual(RENTAL_ABI, [
    "function paymentToken() view returns (address)",
    "function quoteRent(uint8 packageId) view returns (uint256)",
    "function expiresAt(address wallet) view returns (uint256)",
    "function hasActiveAccess(address wallet) view returns (bool)",
    "event AccessRented(address indexed wallet, uint8 indexed packageId, uint256 includedMinutes, uint256 expiresAt, uint256 amountPaid)",
  ]);
  assert.deepEqual(TOKEN_ABI, [
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
  ]);
  assert.deepEqual(purchasedState(360n), { purchasedMinutes: 360 });
  assert.throws(() => purchasedState(2n ** 60n), /Invalid purchased minutes/);
  assert.throws(() => purchasedState(-1), /Invalid purchased minutes/);
});

test("wallet and contract configuration reject invalid addresses and chain mismatch", () => {
  assert.throws(() => normalizeWallet("not a wallet"), /Invalid wallet/);
  assert.equal(createCreditReader({ contractAddress: "", chainId: 10143 }), null);
  assert.equal(createPackQuoter({ contractAddress: "", chainId: 10143 }), null);
  assert.throws(() => createCreditReader({ contractAddress: "bad", chainId: 10143 }), /RENTAL_CONTRACT/);
  assert.throws(
    () => createCreditReader({
      contractAddress: "0x7324a2678e74052a4e9a244c0d57b56b23fee6ad",
      tokenAddress: "0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c",
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 97, // BNB chain rejected
    }),
    /Monad Testnet chain ID 10143/
  );
});

test("contract configuration validates against deployment manifest", () => {
  const fakeManifest = {
    schemaVersion: "1.0.0",
    deploymentId: "archava-monad",
    chainId: 10143,
    contracts: {
      rentalV2: { address: "0x7324a2678e74052a4e9a244c0d57b56b23fee6ad", deployBlock: "70191614" },
      mockUsdt: { address: "0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c" },
    },
  };

  // Rejects wrong rental contract
  assert.throws(
    () => createCreditReader(
      {
        contractAddress: "0x1111111111111111111111111111111111111111",
        tokenAddress: "0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c",
        rpcUrl: "http://127.0.0.1:8545",
        chainId: 10143,
      },
      { manifest: fakeManifest }
    ),
    /RENTAL_CONTRACT .* does not match deployment manifest/
  );

  // Rejects wrong payment token
  assert.throws(
    () => createCreditReader(
      {
        contractAddress: "0x7324a2678e74052a4e9a244c0d57b56b23fee6ad",
        tokenAddress: "0x2222222222222222222222222222222222222222",
        rpcUrl: "http://127.0.0.1:8545",
        chainId: 10143,
      },
      { manifest: fakeManifest }
    ),
    /PAYMENT_TOKEN_CONTRACT .* does not match deployment manifest/
  );
});

