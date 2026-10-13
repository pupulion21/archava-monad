import { describe, expect, it } from 'vitest'
import {
  MONAD_TESTNET_CHAIN_ID,
  MONAD_V2_PACKAGES,
  DeploymentError,
  buildMonadDeploymentManifest,
  isBnbRpc,
  maskRpcUrl,
  resolveOperationalRpc,
  verifyRpcChainId,
  verifyDeployedContracts,
  loadProgress,
  saveProgress,
  deployMonadV2,
  type MonadDeploymentManifest,
} from '../scripts/deploy-monad-v2.js'
import {
  buildMonadVerificationArgs,
  sanitizeVerificationArgsForLog,
  verifyMonadV2,
  MONADSCAN_API_URL,
  SOURCIFY_MONAD_URL,
} from '../scripts/verify-monad-v2.js'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PublicClient } from 'viem'

describe('Monad V2 Deployment & Verification Suite', () => {
  const dummyOwner = '0x1111111111111111111111111111111111111111' as const
  const dummyDeployer = '0x2222222222222222222222222222222222222222' as const
  const dummyToken = '0x3333333333333333333333333333333333333333' as const
  const dummyRental = '0x4444444444444444444444444444444444444444' as const
  const dummyTx1 = `0x${'55'.repeat(32)}` as const
  const dummyTx2 = `0x${'66'.repeat(32)}` as const

  describe('Section A: RPC resolution, BNB rejection & eth_chainId check', () => {
    it('rejects known BNB/BSC RPC endpoints', () => {
      expect(isBnbRpc('https://data-seed-prebsc-1-s1.binance.org:8545/')).toBe(true)
      expect(isBnbRpc('https://bsc-testnet.publicnode.com')).toBe(true)
      expect(isBnbRpc('https://testnet.bscscan.com')).toBe(true)
      expect(isBnbRpc('https://rpc.ankr.com/bsc_testnet_chapel')).toBe(true)
      expect(isBnbRpc('https://provider.example.com/v1/bsc')).toBe(true)
      expect(isBnbRpc('https://provider.example.com/v1/97')).toBe(true)
      expect(isBnbRpc('https://provider.example.com/rpc?chainId=97')).toBe(true)
    })

    it('accepts Monad endpoints even if key or query contains 97', () => {
      expect(isBnbRpc('https://testnet-rpc.monad.xyz')).toBe(false)
      expect(isBnbRpc('https://testnet-rpc.monad.xyz/v1/api97key')).toBe(false)
      expect(isBnbRpc('https://rpc.monad.xyz?partner=alpha97')).toBe(false)
    })

    it('resolveOperationalRpc throws DeploymentError on BNB RPC', () => {
      expect(() =>
        resolveOperationalRpc({ MONAD_TESTNET_RPC_URL: 'https://data-seed-prebsc-1-s1.binance.org:8545/' })
      ).toThrow(/points to BNB\/BSC/i)
    })

    it('verifyRpcChainId rejects BNB RPC before network call', async () => {
      await expect(
        verifyRpcChainId('https://data-seed-prebsc-1-s1.binance.org:8545/')
      ).rejects.toThrow(/points to BNB\/BSC/i)
    })

    it('verifyRpcChainId rejects chain ID 97 (BSC Testnet)', async () => {
      const mockFetch = (async () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x61' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as typeof fetch

      await expect(
        verifyRpcChainId('https://testnet-rpc.monad.xyz', { fetch: mockFetch })
      ).rejects.toThrow(/returned chain ID 97, expected Monad Testnet \(10143\)/i)
    })

    it('verifyRpcChainId rejects non-200 HTTP responses', async () => {
      const mockFetch = (async () =>
        new Response('Service Unavailable', {
          status: 503,
          statusText: 'Service Unavailable',
        })) as typeof fetch

      await expect(
        verifyRpcChainId('https://testnet-rpc.monad.xyz', { fetch: mockFetch })
      ).rejects.toThrow(/HTTP 503: Service Unavailable/i)
    })

    it('verifyRpcChainId rejects JSON-RPC errors', async () => {
      const mockFetch = (async () =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32000, message: 'Resource rate limited' },
          }),
          { status: 200 }
        )) as typeof fetch

      await expect(
        verifyRpcChainId('https://testnet-rpc.monad.xyz', { fetch: mockFetch })
      ).rejects.toThrow(/JSON-RPC error: Resource rate limited/i)
    })

    it('verifyRpcChainId rejects malformed result', async () => {
      const mockFetch = (async () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'invalid-hex' }), {
          status: 200,
        })) as typeof fetch

      await expect(
        verifyRpcChainId('https://testnet-rpc.monad.xyz', { fetch: mockFetch })
      ).rejects.toThrow(/malformed result/i)
    })

    it('verifyRpcChainId accepts Monad Testnet hex chain ID (0x279f = 10143)', async () => {
      const mockFetch = (async () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x279f' }), {
          status: 200,
        })) as typeof fetch

      const chainId = await verifyRpcChainId('https://testnet-rpc.monad.xyz', { fetch: mockFetch })
      expect(chainId).toBe(10143)
    })

    it('maskRpcUrl strips credentials and secret keys from RPC URLs', () => {
      const masked = maskRpcUrl('https://alice:secret123@rpc.monad.xyz/v1/apikeyabcdef0123456789?apiKey=supersecrettoken')
      expect(masked).not.toContain('secret123')
      expect(masked).not.toContain('supersecrettoken')
      expect(masked).toContain('***')
    })
  })

  describe('Section B: deployMonadV2 Pre-Flight & Lifecycle Guards', () => {
    const mockFetch10143 = (async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x279f' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch

    const samplePrivateKey =
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const
    const sampleDeployer = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const

    it('rejects deployment when deployer private key is missing', async () => {
      const origKey = process.env.MONAD_DEPLOYER_PRIVATE_KEY
      const origPriv = process.env.PRIVATE_KEY
      delete process.env.MONAD_DEPLOYER_PRIVATE_KEY
      delete process.env.PRIVATE_KEY
      try {
        await expect(
          deployMonadV2({
            rpcUrl: 'https://testnet-rpc.monad.xyz',
            fetch: mockFetch10143,
          })
        ).rejects.toThrow(/Missing deployer private key/i)
      } finally {
        if (origKey) process.env.MONAD_DEPLOYER_PRIVATE_KEY = origKey
        if (origPriv) process.env.PRIVATE_KEY = origPriv
      }
    })

    it('rejects deployment when signer address mismatches EXPECTED_DEPLOYER_ADDRESS', async () => {
      await expect(
        deployMonadV2({
          rpcUrl: 'https://testnet-rpc.monad.xyz',
          privateKey: samplePrivateKey,
          expectedDeployer: '0x0000000000000000000000000000000000000001',
          fetch: mockFetch10143,
        })
      ).rejects.toThrow(/Deployer address mismatch/i)
    })

    it('rejects deployment when deployer balance is below 0.05 MON safety threshold', async () => {
      const lowBalanceClient = {
        getBalance: async () => 10_000_000_000_000_000n, // 0.01 MON
      } as unknown as PublicClient

      await expect(
        deployMonadV2({
          rpcUrl: 'https://testnet-rpc.monad.xyz',
          privateKey: samplePrivateKey,
          expectedDeployer: sampleDeployer,
          fetch: mockFetch10143,
          publicClient: lowBalanceClient,
        })
      ).rejects.toThrow(/Insufficient MON balance for deployment/i)
    })

    it('dry-run mode succeeds preflight and produces fixture manifest without onchain calls', async () => {
      const highBalanceClient = {
        getBalance: async () => 1_000_000_000_000_000_000n, // 1 MON
      } as unknown as PublicClient

      const manifest = await deployMonadV2({
        rpcUrl: 'https://testnet-rpc.monad.xyz',
        privateKey: samplePrivateKey,
        expectedDeployer: sampleDeployer,
        dryRun: true,
        fetch: mockFetch10143,
        publicClient: highBalanceClient,
      })

      expect(manifest.chainId).toBe(10143)
      expect(manifest.deployer).toBe(sampleDeployer)
      expect(manifest.contracts.mockUsdt.name).toBe('ArchavaMockUSDT')
      expect(manifest.contracts.rentalV2.name).toBe('ArchavaRentalV2')
    })

    it('reverted deployment receipt aborts and never writes canonical manifest', async () => {
      const revertedClient = {
        getBalance: async () => 1_000_000_000_000_000_000n,
        getCode: async () => '0x',
        waitForTransactionReceipt: async () => ({
          status: 'reverted',
          contractAddress: null,
        }),
      } as unknown as PublicClient

      const mockWalletClient = {
        deployContract: async () => dummyTx1,
      }

      const tempDir = mkdtempSync(join(tmpdir(), 'monad-revert-test-'))
      const manifestPath = join(tempDir, 'monadTestnetV2.json')
      const progressPath = join(tempDir, '.progress.json')

      try {
        await expect(
          deployMonadV2({
            rpcUrl: 'https://testnet-rpc.monad.xyz',
            privateKey: samplePrivateKey,
            expectedDeployer: sampleDeployer,
            fetch: mockFetch10143,
            publicClient: revertedClient,
            walletClient: mockWalletClient,
            manifestPath,
            progressPath,
          })
        ).rejects.toThrow(/deployment failed or reverted/i)

        // Strict assertion: no manifest file created on failure!
        expect(existsSync(manifestPath)).toBe(false)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })
  })

  describe('Section C: Canonical Manifest & V2 Package Pricing', () => {
    it('builds canonical manifest with exact V2 package pricing for Monad Testnet', () => {
      const manifest = buildMonadDeploymentManifest({
        deployer: dummyDeployer,
        owner: dummyOwner,
        tokenAddress: dummyToken,
        tokenTxHash: dummyTx1,
        tokenBlock: 100n,
        tokenAbi: [],
        rentalAddress: dummyRental,
        rentalTxHash: dummyTx2,
        rentalBlock: 101n,
        rentalAbi: [],
        deployedAt: '2026-10-12T00:00:00.000Z',
      })

      expect(manifest.schemaVersion).toBe('1.0.0')
      expect(manifest.chainId).toBe(10143)
      expect(manifest.network).toBe('Monad Testnet')
      expect(manifest.deployer).toBe(dummyDeployer)
      expect(manifest.owner).toBe(dummyOwner)
      expect(manifest.contracts.mockUsdt.address).toBe(dummyToken)
      expect(manifest.contracts.mockUsdt.constructorArguments).toEqual([dummyOwner])
      expect(manifest.contracts.rentalV2.address).toBe(dummyRental)
      expect(manifest.contracts.rentalV2.constructorArguments).toEqual([dummyOwner, dummyToken])
      expect(manifest.contracts.mockUsdt.explorerUrl).toBe(
        `https://testnet.monadscan.com/address/${dummyToken}`
      )
      expect(manifest.contracts.rentalV2.explorerUrl).toBe(
        `https://testnet.monadscan.com/address/${dummyRental}`
      )
      expect(manifest.packages).toEqual([
        {
          packageId: 1,
          name: 'Starter',
          displayPriceIdr: 79_000,
          priceMusdt: '4.9375',
          priceUnits: '4937500',
          includedMinutes: 60,
          validityDays: 30,
        },
        {
          packageId: 2,
          name: 'Pro',
          displayPriceIdr: 299_000,
          priceMusdt: '18.6875',
          priceUnits: '18687500',
          includedMinutes: 300,
          validityDays: 30,
        },
      ])
    })

    it('MONAD_V2_PACKAGES match exact Monad pricing definitions', () => {
      expect(MONAD_V2_PACKAGES).toHaveLength(2)
      expect(MONAD_V2_PACKAGES[0].priceUnits).toBe('4937500')
      expect(MONAD_V2_PACKAGES[1].priceUnits).toBe('18687500')
    })
  })

  describe('Section C: Onchain Read-Back Verification', () => {
    function createMockPublicClient(overrides: {
      tokenCode?: `0x${string}`
      rentalCode?: `0x${string}`
      tokenDecimals?: number
      tokenSymbol?: string
      tokenOwner?: string
      tokenFaucet?: bigint
      rentalOwner?: string
      rentalPaymentToken?: string
      rentalPaused?: boolean
      starterQuote?: bigint
      proQuote?: bigint
      starterActive?: boolean
      proActive?: boolean
    } = {}): PublicClient {
      return {
        getCode: async ({ address }: { address: string }) => {
          if (address.toLowerCase() === dummyToken.toLowerCase()) {
            return overrides.tokenCode ?? ('0x60806040' as `0x${string}`)
          }
          if (address.toLowerCase() === dummyRental.toLowerCase()) {
            return overrides.rentalCode ?? ('0x60806040' as `0x${string}`)
          }
          return '0x'
        },
        readContract: async ({
          address,
          functionName,
          args,
        }: {
          address: string
          functionName: string
          args?: readonly unknown[]
        }) => {
          if (address.toLowerCase() === dummyToken.toLowerCase()) {
            if (functionName === 'decimals') return overrides.tokenDecimals ?? 6
            if (functionName === 'symbol') return overrides.tokenSymbol ?? 'mUSDT'
            if (functionName === 'owner') return overrides.tokenOwner ?? dummyOwner
            if (functionName === 'FAUCET_AMOUNT') return overrides.tokenFaucet ?? 100_000_000n
          }
          if (address.toLowerCase() === dummyRental.toLowerCase()) {
            if (functionName === 'owner') return overrides.rentalOwner ?? dummyOwner
            if (functionName === 'paymentToken') return overrides.rentalPaymentToken ?? dummyToken
            if (functionName === 'paused') return overrides.rentalPaused ?? false
            if (functionName === 'quoteRent') {
              const pkgId = args?.[0]
              if (pkgId === 1) return overrides.starterQuote ?? 4_937_500n
              if (pkgId === 2) return overrides.proQuote ?? 18_687_500n
            }
            if (functionName === 'packageDetails') {
              const pkgId = args?.[0]
              if (pkgId === 1) {
                return {
                  price: overrides.starterQuote ?? 4_937_500n,
                  validityDuration: 2592000n,
                  includedMinutes: 60n,
                  active: overrides.starterActive ?? true,
                }
              }
              if (pkgId === 2) {
                return {
                  price: overrides.proQuote ?? 18_687_500n,
                  validityDuration: 2592000n,
                  includedMinutes: 300n,
                  active: overrides.proActive ?? true,
                }
              }
            }
          }
          throw new Error(`Unhandled readContract call: ${address}.${functionName}`)
        },
      } as unknown as PublicClient
    }

    it('passes when all onchain read-backs match specifications', async () => {
      const client = createMockPublicClient()
      await expect(
        verifyDeployedContracts(client, {
          tokenAddress: dummyToken,
          rentalAddress: dummyRental,
          expectedOwner: dummyOwner,
        })
      ).resolves.toBeUndefined()
    })

    it('throws DeploymentError when token bytecode is empty', async () => {
      const client = createMockPublicClient({ tokenCode: '0x' })
      await expect(
        verifyDeployedContracts(client, {
          tokenAddress: dummyToken,
          rentalAddress: dummyRental,
          expectedOwner: dummyOwner,
        })
      ).rejects.toThrow(/token contract at .* has no bytecode/i)
    })

    it('throws DeploymentError when rental bytecode is empty', async () => {
      const client = createMockPublicClient({ rentalCode: '0x' })
      await expect(
        verifyDeployedContracts(client, {
          tokenAddress: dummyToken,
          rentalAddress: dummyRental,
          expectedOwner: dummyOwner,
        })
      ).rejects.toThrow(/rental contract at .* has no bytecode/i)
    })

    it('throws DeploymentError when token decimals is not 6', async () => {
      const client = createMockPublicClient({ tokenDecimals: 18 })
      await expect(
        verifyDeployedContracts(client, {
          tokenAddress: dummyToken,
          rentalAddress: dummyRental,
          expectedOwner: dummyOwner,
        })
      ).rejects.toThrow(/Token decimals mismatch: got 18, expected 6/i)
    })

    it('throws DeploymentError when token symbol is not mUSDT', async () => {
      const client = createMockPublicClient({ tokenSymbol: 'USDT' })
      await expect(
        verifyDeployedContracts(client, {
          tokenAddress: dummyToken,
          rentalAddress: dummyRental,
          expectedOwner: dummyOwner,
        })
      ).rejects.toThrow(/Token symbol mismatch: got "USDT", expected "mUSDT"/i)
    })

    it('throws DeploymentError when token owner does not match expectedOwner', async () => {
      const client = createMockPublicClient({
        tokenOwner: '0x9999999999999999999999999999999999999999',
      })
      await expect(
        verifyDeployedContracts(client, {
          tokenAddress: dummyToken,
          rentalAddress: dummyRental,
          expectedOwner: dummyOwner,
        })
      ).rejects.toThrow(/Token owner mismatch/i)
    })

    it('throws DeploymentError when rental paymentToken does not point to tokenAddress', async () => {
      const client = createMockPublicClient({
        rentalPaymentToken: '0x9999999999999999999999999999999999999999',
      })
      await expect(
        verifyDeployedContracts(client, {
          tokenAddress: dummyToken,
          rentalAddress: dummyRental,
          expectedOwner: dummyOwner,
        })
      ).rejects.toThrow(/Rental paymentToken mismatch/i)
    })

    it('throws DeploymentError when rental contract is paused', async () => {
      const client = createMockPublicClient({ rentalPaused: true })
      await expect(
        verifyDeployedContracts(client, {
          tokenAddress: dummyToken,
          rentalAddress: dummyRental,
          expectedOwner: dummyOwner,
        })
      ).rejects.toThrow(/Rental contract initial state is paused/i)
    })

    it('throws DeploymentError when Starter package price is mismatched', async () => {
      const client = createMockPublicClient({ starterQuote: 5_000_000n })
      await expect(
        verifyDeployedContracts(client, {
          tokenAddress: dummyToken,
          rentalAddress: dummyRental,
          expectedOwner: dummyOwner,
        })
      ).rejects.toThrow(/Starter quoteRent mismatch: got 5000000, expected 4937500/i)
    })

    it('throws DeploymentError when Pro package price is mismatched', async () => {
      const client = createMockPublicClient({ proQuote: 20_000_000n })
      await expect(
        verifyDeployedContracts(client, {
          tokenAddress: dummyToken,
          rentalAddress: dummyRental,
          expectedOwner: dummyOwner,
        })
      ).rejects.toThrow(/Pro quoteRent mismatch: got 20000000, expected 18687500/i)
    })
  })

  describe('Section D: Progress Tracking & Partial Deployment Resume', () => {
    it('saves and loads progress atomically', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'monad-progress-test-'))
      const progressPath = join(tempDir, '.progress-monadTestnetV2.json')

      try {
        expect(loadProgress(progressPath)).toBeNull()

        saveProgress(progressPath, {
          chainId: 10143,
          deployer: dummyDeployer,
          owner: dummyOwner,
          tokenAddress: dummyToken,
          tokenDeployTxHash: dummyTx1,
          status: 'token_confirmed',
          updatedAt: '2026-10-12T00:00:00.000Z',
        })

        const loaded = loadProgress(progressPath)
        expect(loaded).not.toBeNull()
        expect(loaded?.chainId).toBe(10143)
        expect(loaded?.tokenAddress).toBe(dummyToken)
        expect(loaded?.status).toBe('token_confirmed')
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })
  })

  describe('Section E: Contract Source Verification Arguments & Fallback', () => {
    const validManifest: MonadDeploymentManifest = {
      schemaVersion: '1.0.0',
      deploymentId: 'archava-monad',
      network: 'Monad Testnet',
      chainId: 10143,
      deployedAt: '2026-10-12T00:00:00.000Z',
      deployer: dummyDeployer,
      owner: dummyOwner,
      contracts: {
        mockUsdt: {
          name: 'ArchavaMockUSDT',
          address: dummyToken,
          deployTxHash: dummyTx1,
          deployBlock: '100',
          constructorArguments: [dummyOwner],
          abi: [],
          verificationStatus: 'pending',
          explorerUrl: `https://testnet.monadscan.com/address/${dummyToken}`,
        },
        rentalV2: {
          name: 'ArchavaRentalV2',
          address: dummyRental,
          deployTxHash: dummyTx2,
          deployBlock: '101',
          constructorArguments: [dummyOwner, dummyToken],
          abi: [],
          verificationStatus: 'pending',
          explorerUrl: `https://testnet.monadscan.com/address/${dummyRental}`,
        },
      },
      packages: MONAD_V2_PACKAGES,
      compiler: {
        solcVersion: '0.8.28',
        optimizer: true,
        runs: 200,
        evmVersion: 'cancun',
      },
    }

    it('rejects verification for non-10143 chain manifests', () => {
      const invalidManifest = { ...validManifest, chainId: 97 as unknown as 10143 }
      expect(() => buildMonadVerificationArgs('mockUsdt', invalidManifest)).toThrow(
        /Monad verification requires chain ID 10143/i
      )
    })

    it('builds ArchavaMockUSDT verification args with Sourcify when no API key provided', () => {
      const args = buildMonadVerificationArgs('mockUsdt', validManifest, {
        verifier: 'sourcify',
      })

      expect(args).toContain('verify-contract')
      expect(args).toContain(dummyToken)
      expect(args).toContain('src/ArchavaMockUSDT.sol:ArchavaMockUSDT')
      expect(args).toContain('--chain-id')
      expect(args).toContain('10143')
      expect(args).toContain('--compiler-version')
      expect(args).toContain('0.8.28')
      expect(args).toContain('--optimizer-runs')
      expect(args).toContain('200')
      expect(args).toContain('--evm-version')
      expect(args).toContain('cancun')
      expect(args).toContain('--verifier')
      expect(args).toContain('sourcify')
      expect(args).toContain('--verifier-url')
      expect(args).toContain(SOURCIFY_MONAD_URL)
      expect(args).toContain('--constructor-args')
      // ABI encoded dummyOwner address
      expect(args.at(args.indexOf('--constructor-args') + 1)).toMatch(/^0x[0-9a-f]{64}$/i)
      expect(args).toContain('--watch')
    })

    it('builds ArchavaRentalV2 verification args with Monadscan and ABI encoded 2 arguments', () => {
      const args = buildMonadVerificationArgs('rentalV2', validManifest, {
        verifier: 'etherscan',
        apiKey: 'dummy_monadscan_key_123',
      })

      expect(args).toContain('verify-contract')
      expect(args).toContain(dummyRental)
      expect(args).toContain('src/ArchavaRentalV2.sol:ArchavaRentalV2')
      expect(args).toContain('--chain-id')
      expect(args).toContain('10143')
      expect(args).toContain('--verifier')
      expect(args).toContain('etherscan')
      expect(args).toContain('--verifier-url')
      expect(args).toContain(MONADSCAN_API_URL)
      expect(args).toContain('--etherscan-api-key')
      expect(args).toContain('dummy_monadscan_key_123')
      // ABI encoded dummyOwner + dummyToken = 128 hex chars + 0x = 130
      const constructorHex = args.at(args.indexOf('--constructor-args') + 1)
      expect(constructorHex).toMatch(/^0x[0-9a-f]{128}$/i)
    })

    it('sanitizeVerificationArgsForLog masks sensitive api keys', () => {
      const args = [
        'verify-contract',
        dummyRental,
        'src/ArchavaRentalV2.sol:ArchavaRentalV2',
        '--etherscan-api-key',
        'supersecretapikey123',
        '--verifier-url',
        'https://api-testnet.monadscan.com/api',
      ]
      const sanitized = sanitizeVerificationArgsForLog(args)
      expect(sanitized).not.toContain('supersecretapikey123')
      expect(sanitized).toContain('***')
      expect(sanitized[sanitized.indexOf('--etherscan-api-key') + 1]).toBe('***')
    })

    it('verifyMonadV2 catches verifier failure gracefully without aborting deployment state', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'monad-verify-test-'))
      const manifestPath = join(tempDir, 'monadTestnetV2.json')
      writeFileSync(manifestPath, JSON.stringify(validManifest, null, 2), 'utf8')

      // Mock spawnSync that returns status 1 (verification failure e.g. rate limit)
      const mockSpawn = () =>
        ({
          status: 1,
          stdout: '',
          stderr: 'Verification failed: rate limited by explorer API',
          pid: 1234,
          output: [],
          signal: null,
        } as unknown as ReturnType<typeof import('node:child_process').spawnSync>)

      try {
        const report = await verifyMonadV2({
          manifestPath,
          spawnFn: mockSpawn as unknown as typeof import('node:child_process').spawnSync,
        })

        // Verification report indicates non-success, but function does not throw
        expect(report.success).toBe(false)
        expect(report.results.mockUsdt.status).toBe('pending')
        expect(report.results.rentalV2.status).toBe('pending')

        // Manifest file is intact and retains pending status
        const manifestAfter = JSON.parse(
          readFileSync(manifestPath, 'utf8')
        ) as MonadDeploymentManifest
        expect(manifestAfter.chainId).toBe(10143)
        expect(manifestAfter.contracts.mockUsdt.address).toBe(dummyToken)
        expect(manifestAfter.contracts.mockUsdt.verificationStatus).toBe('pending')
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })
  })
})
