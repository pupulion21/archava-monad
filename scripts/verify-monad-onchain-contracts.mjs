import assert from "node:assert/strict";
import { ethers } from "ethers";

const RPC_URL = process.env.RPC_URL || "https://testnet-rpc.monad.xyz";
const RENTAL_ADDRESS = "0x7324a2678e74052a4e9a244c0d57b56b23fee6ad";
const TOKEN_ADDRESS = "0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c";
const EXPECTED_CHAIN_ID = 10143n;

const RENTAL_ABI = [
  "function paymentToken() view returns (address)",
  "function quoteRent(uint8 packageId) view returns (uint256)",
  "function packageDetails(uint8 packageId) view returns (uint256 price, uint256 validityDuration, uint256 includedMinutes, bool active)",
  "function hasActiveAccess(address user) view returns (bool)",
  "function activeAccesses(address user) view returns (uint256 expiresAt, uint256 purchasedMinutes)",
];

const TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function hasClaimed(address) view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

async function verifyOnchain() {
  console.log("=== Verifying Live Monad Testnet Contracts (Chain ID 10143) ===");
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  const network = await provider.getNetwork();
  console.log(`1. Connected to network: Chain ID ${network.chainId}`);
  assert.equal(network.chainId, EXPECTED_CHAIN_ID, "Chain ID must be 10143 (Monad Testnet)");

  const rental = new ethers.Contract(RENTAL_ADDRESS, RENTAL_ABI, provider);
  const token = new ethers.Contract(TOKEN_ADDRESS, TOKEN_ABI, provider);

  console.log("2. Verifying Payment Token bytecode and metadata...");
  const tokenCode = await provider.getCode(TOKEN_ADDRESS);
  assert.ok(tokenCode && tokenCode !== "0x", "Payment token bytecode missing");
  const [name, symbol, decimals] = await Promise.all([
    token.name(),
    token.symbol(),
    token.decimals(),
  ]);
  console.log(`✓ Token: ${name} (${symbol}), decimals: ${decimals}`);
  assert.equal(symbol, "mUSDT");
  assert.equal(Number(decimals), 6);

  console.log("3. Verifying RentalV2 bytecode and configuration...");
  const rentalCode = await provider.getCode(RENTAL_ADDRESS);
  assert.ok(rentalCode && rentalCode !== "0x", "Rental contract bytecode missing");
  const paymentTokenOnchain = await rental.paymentToken();
  console.log(`✓ RentalV2 paymentToken onchain: ${paymentTokenOnchain}`);
  assert.equal(paymentTokenOnchain.toLowerCase(), TOKEN_ADDRESS.toLowerCase());

  console.log("4. Verifying Package Details and Pricing Quotes...");
  const [starterQuote, proQuote] = await Promise.all([
    rental.quoteRent(1),
    rental.quoteRent(2),
  ]);
  console.log(`✓ Package 1 (Starter 60m): ${starterQuote} base units (${ethers.formatUnits(starterQuote, 6)} mUSDT)`);
  console.log(`✓ Package 2 (Pro 300m):     ${proQuote} base units (${ethers.formatUnits(proQuote, 6)} mUSDT)`);
  assert.equal(starterQuote, 4937500n, "Starter package price must be 4.9375 mUSDT (4937500 units)");
  assert.equal(proQuote, 18687500n, "Pro package price must be 18.6875 mUSDT (18687500 units)");

  const starterDetails = await rental.packageDetails(1);
  assert.equal(starterDetails.includedMinutes, 60n);
  assert.equal(starterDetails.validityDuration, 30n * 86400n);
  assert.equal(starterDetails.active, true);

  const proDetails = await rental.packageDetails(2);
  assert.equal(proDetails.includedMinutes, 300n);
  assert.equal(proDetails.validityDuration, 30n * 86400n);
  assert.equal(proDetails.active, true);

  console.log("5. Checking faucet eligibility query on token...");
  const dummyWallet = ethers.Wallet.createRandom().address;
  const dummyClaimed = await token.hasClaimed(dummyWallet);
  assert.equal(dummyClaimed, false, "Fresh wallet must not have claimed faucet");
  console.log("✓ Faucet eligibility query works as expected");

  console.log("6. Verifying local API /api/config alignment...");
  const configRes = await fetch("http://localhost:5002/api/config");
  assert.equal(configRes.status, 200);
  const config = await configRes.json();
  assert.equal(config.chainId, 10143);
  assert.equal(config.contractAddress.toLowerCase(), RENTAL_ADDRESS.toLowerCase());
  assert.equal(config.paymentTokenAddress.toLowerCase(), TOKEN_ADDRESS.toLowerCase());
  console.log("✓ Local API config strictly matches onchain canonical contracts");

  console.log("\n==========================================");
  console.log("✓ ONCHAIN CONTRACT CHECKS PASSED!");
  console.log("==========================================\n");
}

await verifyOnchain();
