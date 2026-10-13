import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const rootDir = join(scriptDir, '..')
const workspaceRoot = join(rootDir, '..', '..')

export function loadEnvSafely(): void {
  const envCandidates = [
    join(workspaceRoot, '.env'),
    join(rootDir, '.env'),
    join(process.cwd(), '.env'),
  ]
  for (const envFile of envCandidates) {
    if (existsSync(envFile)) {
      try {
        const content = readFileSync(envFile, 'utf8')
        for (const line of content.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith('#')) continue
          const eqIdx = trimmed.indexOf('=')
          if (eqIdx === -1) continue
          const key = trimmed.slice(0, eqIdx).trim()
          let val = trimmed.slice(eqIdx + 1).trim()
          if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
          ) {
            val = val.slice(1, -1)
          }
          if (!process.env[key] && val) {
            process.env[key] = val
          }
        }
      } catch {
        // ignore error reading env
      }
    }
  }
}
loadEnvSafely()

export const MONAD_TESTNET_CHAIN_ID = 10143

export const monadTestnet = defineChain({
  id: MONAD_TESTNET_CHAIN_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://testnet-rpc.monad.xyz'] },
    public: { http: ['https://testnet-rpc.monad.xyz'] },
  },
  blockExplorers: {
    default: { name: 'MonadScan', url: 'https://testnet.monadscan.com' },
  },
  testnet: true,
})

export const MONAD_V2_PACKAGES = [
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
] as const

export interface ForgeArtifact {
  readonly abi: readonly unknown[]
  readonly bytecode: { readonly object: Hex }
}

export interface MonadDeploymentManifest {
  readonly schemaVersion: '1.0.0'
  readonly deploymentId: string
  readonly network: 'Monad Testnet'
  readonly chainId: 10143
  readonly deployedAt: string
  readonly deployer: Address
  readonly owner: Address
  readonly contracts: {
    readonly mockUsdt: {
      readonly name: 'ArchavaMockUSDT'
      readonly address: Address
      readonly deployTxHash: Hex
      readonly deployBlock: string
      readonly constructorArguments: readonly [Address]
      readonly abi: readonly unknown[]
      readonly verificationStatus: 'verified' | 'pending' | 'unverified'
      readonly explorerUrl: string
    }
    readonly rentalV2: {
      readonly name: 'ArchavaRentalV2'
      readonly address: Address
      readonly deployTxHash: Hex
      readonly deployBlock: string
      readonly constructorArguments: readonly [Address, Address]
      readonly abi: readonly unknown[]
      readonly verificationStatus: 'verified' | 'pending' | 'unverified'
      readonly explorerUrl: string
    }
  }
  readonly packages: typeof MONAD_V2_PACKAGES
  readonly compiler: {
    readonly solcVersion: string
    readonly optimizer: boolean
    readonly runs: number
    readonly evmVersion: string
  }
}

export interface DeploymentProgress {
  readonly chainId: 10143
  readonly deployer: Address
  readonly owner: Address
  tokenDeployTxHash?: Hex
  tokenAddress?: Address
  tokenBlockNumber?: string
  rentalDeployTxHash?: Hex
  rentalAddress?: Address
  rentalBlockNumber?: string
  status: 'idle' | 'token_pending' | 'token_confirmed' | 'rental_pending' | 'completed'
  updatedAt: string
}

export class DeploymentError extends Error {
  constructor(message: string, public readonly details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'DeploymentError'
  }
}

/**
 * Mask sensitive credentials or query keys in RPC URL.
 */
export function maskRpcUrl(url: string): string {
  if (!url || typeof url !== 'string') return ''
  try {
    const parsed = new URL(url)
    if (parsed.password) parsed.password = '***'
    if (parsed.username) parsed.username = '***'
    const secretKeys = ['key', 'apikey', 'api_key', 'token', 'auth', 'secret']
    for (const [k, v] of parsed.searchParams.entries()) {
      if (secretKeys.includes(k.toLowerCase()) || v.length >= 16) {
        parsed.searchParams.set(k, '***')
      }
    }
    const parts = parsed.pathname.split('/')
    const maskedParts = parts.map((part) =>
      part.length >= 24 && !part.includes('monad') ? '***' : part
    )
    parsed.pathname = maskedParts.join('/')
    return parsed.toString()
  } catch {
    return url.replace(/([?&][a-zA-Z0-9_-]+=)[^&]+/g, '$1***')
  }
}

/**
 * Check if URL points to BNB/BSC.
 * Allows Monad URLs where keys contain '97'.
 */
export function isBnbRpc(url: string): boolean {
  if (!url || typeof url !== 'string') return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    const lower = url.toLowerCase()
    return lower.includes('binance') || lower.includes('bsc') || lower.includes('bnbchain')
  }

  const hostname = parsed.hostname.toLowerCase()
  const pathname = parsed.pathname.toLowerCase()

  if (hostname.endsWith('monad.xyz') || hostname.includes('monad')) {
    return false
  }

  if (
    hostname.includes('binance.org') ||
    hostname.includes('bscscan.com') ||
    hostname.includes('bsc.nodereal.io') ||
    hostname.includes('bnbchain.org') ||
    hostname.includes('data-seed-prebsc') ||
    hostname.includes('bsc-dataseed') ||
    hostname.includes('bsc') ||
    hostname.startsWith('bnb.') ||
    hostname.includes('.bnb.')
  ) {
    return true
  }

  if (
    pathname.includes('/bsc') ||
    pathname.includes('bsc_') ||
    pathname.includes('bsc-') ||
    pathname.includes('/binance') ||
    pathname.includes('/bnb')
  ) {
    return true
  }

  const pathSegments = pathname.split('/').filter(Boolean)
  if (pathSegments.includes('97')) {
    return true
  }
  const chainParam =
    parsed.searchParams.get('chain') ||
    parsed.searchParams.get('chainId') ||
    parsed.searchParams.get('chain_id')
  if (chainParam === '97') {
    return true
  }

  return false
}

/**
 * Resolve single operational RPC endpoint.
 */
export function resolveOperationalRpc(
  env: Record<string, string | undefined> = process.env,
  customRpc?: string
): string {
  let candidate = customRpc || env.MONAD_TESTNET_RPC_URL || env.RPC_URL || env.MONAD_RPC_URL

  if (!candidate) {
    // Try to load from config/networks.json
    try {
      const networksPath = join(workspaceRoot, 'config', 'networks.json')
      if (existsSync(networksPath)) {
        const netConfig = JSON.parse(readFileSync(networksPath, 'utf8'))
        const active = netConfig.networks?.[netConfig.active || 'monadTestnet']
        if (active?.rpcUrls?.default?.http?.[0]) {
          candidate = active.rpcUrls.default.http[0]
        }
      }
    } catch {
      // Fallback
    }
  }

  if (!candidate) {
    candidate = 'https://testnet-rpc.monad.xyz'
  }

  if (isBnbRpc(candidate)) {
    throw new DeploymentError(
      `Operational RPC endpoint points to BNB/BSC ("${maskRpcUrl(candidate)}"). Monad deployment must use Monad RPC.`
    )
  }

  return candidate.trim()
}

/**
 * Verify online RPC chain ID via JSON-RPC.
 */
export async function verifyRpcChainId(
  rpcUrl: string,
  options: { timeoutMs?: number; fetch?: typeof fetch } = {}
): Promise<number> {
  const masked = maskRpcUrl(rpcUrl)
  if (isBnbRpc(rpcUrl)) {
    throw new DeploymentError(`RPC endpoint points to BNB/BSC: ${masked}`)
  }

  const timeoutMs = options.timeoutMs || 5000
  const fetchFn = options.fetch || globalThis.fetch

  let response: Response
  try {
    response = await fetchFn(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err: unknown) {
    const error = err as Error
    const msg =
      error.name === 'TimeoutError'
        ? `RPC connection timed out after ${timeoutMs}ms`
        : `Network error connecting to RPC (${masked}): ${error.message}`
    throw new DeploymentError(msg, { rpcUrl: masked })
  }

  if (!response.ok) {
    throw new DeploymentError(
      `RPC endpoint (${masked}) responded with HTTP ${response.status}: ${response.statusText}`,
      { status: response.status }
    )
  }

  let json: { jsonrpc?: string; result?: string; error?: { message?: string } }
  try {
    json = await response.json()
  } catch (err: unknown) {
    throw new DeploymentError(`RPC endpoint (${masked}) returned invalid JSON`, {
      error: (err as Error).message,
    })
  }

  if (json.error) {
    throw new DeploymentError(
      `RPC endpoint (${masked}) returned JSON-RPC error: ${json.error.message || JSON.stringify(json.error)}`
    )
  }

  if (typeof json.result !== 'string' || !json.result.startsWith('0x')) {
    throw new DeploymentError(
      `RPC endpoint (${masked}) returned malformed result for eth_chainId: ${JSON.stringify(json.result)}`
    )
  }

  const chainId = parseInt(json.result, 16)
  if (chainId !== MONAD_TESTNET_CHAIN_ID) {
    throw new DeploymentError(
      `RPC endpoint (${masked}) returned chain ID ${chainId}, expected Monad Testnet (${MONAD_TESTNET_CHAIN_ID})`
    )
  }

  return chainId
}

/**
 * Load Forge compile artifact.
 */
export function loadForgeArtifact(contractName: string, subDir?: string): ForgeArtifact {
  const folder = subDir || `${contractName}.sol`
  const artifactPath = join(rootDir, 'out', folder, `${contractName}.json`)
  if (!existsSync(artifactPath)) {
    throw new DeploymentError(
      `Build artifact not found for ${contractName} at ${artifactPath}. Run 'forge build' first.`
    )
  }
  const parsed = JSON.parse(readFileSync(artifactPath, 'utf8'))
  if (!parsed.abi || !parsed.bytecode?.object) {
    throw new DeploymentError(`Invalid artifact format in ${artifactPath}`)
  }
  return {
    abi: parsed.abi,
    bytecode: { object: parsed.bytecode.object as Hex },
  }
}

/**
 * Load existing progress if available.
 */
export function loadProgress(progressFile: string): DeploymentProgress | null {
  if (!existsSync(progressFile)) return null
  try {
    return JSON.parse(readFileSync(progressFile, 'utf8')) as DeploymentProgress
  } catch {
    return null
  }
}

/**
 * Save progress atomically.
 */
export function saveProgress(progressFile: string, progress: DeploymentProgress): void {
  mkdirSync(dirname(progressFile), { recursive: true })
  writeFileSync(progressFile, JSON.stringify(progress, null, 2), 'utf8')
}

/**
 * Build canonical deployment manifest.
 */
export function buildMonadDeploymentManifest(input: {
  readonly deployer: Address
  readonly owner: Address
  readonly tokenAddress: Address
  readonly tokenTxHash: Hex
  readonly tokenBlock: bigint | string
  readonly tokenAbi: readonly unknown[]
  readonly rentalAddress: Address
  readonly rentalTxHash: Hex
  readonly rentalBlock: bigint | string
  readonly rentalAbi: readonly unknown[]
  readonly deployedAt: string
  readonly deploymentId?: string
  readonly verificationStatus?: 'verified' | 'pending' | 'unverified'
}): MonadDeploymentManifest {
  const status = input.verificationStatus || 'pending'
  const explorerBase = 'https://testnet.monadscan.com'

  return {
    schemaVersion: '1.0.0',
    deploymentId: input.deploymentId || 'archava-monad',
    network: 'Monad Testnet',
    chainId: MONAD_TESTNET_CHAIN_ID,
    deployedAt: input.deployedAt,
    deployer: input.deployer,
    owner: input.owner,
    contracts: {
      mockUsdt: {
        name: 'ArchavaMockUSDT',
        address: input.tokenAddress,
        deployTxHash: input.tokenTxHash,
        deployBlock: input.tokenBlock.toString(),
        constructorArguments: [input.owner],
        abi: input.tokenAbi,
        verificationStatus: status,
        explorerUrl: `${explorerBase}/address/${input.tokenAddress}`,
      },
      rentalV2: {
        name: 'ArchavaRentalV2',
        address: input.rentalAddress,
        deployTxHash: input.rentalTxHash,
        deployBlock: input.rentalBlock.toString(),
        constructorArguments: [input.owner, input.tokenAddress],
        abi: input.rentalAbi,
        verificationStatus: status,
        explorerUrl: `${explorerBase}/address/${input.rentalAddress}`,
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
}

/**
 * Read-back onchain verification of deployed contracts.
 */
export async function verifyDeployedContracts(
  publicClient: PublicClient,
  contracts: {
    readonly tokenAddress: Address
    readonly rentalAddress: Address
    readonly expectedOwner: Address
  }
): Promise<void> {
  const { tokenAddress, rentalAddress, expectedOwner } = contracts

  // 1. Verify bytecodes are non-empty
  const tokenBytecode = await publicClient.getCode({ address: tokenAddress })
  if (!tokenBytecode || tokenBytecode === '0x') {
    throw new DeploymentError(`Read-back failed: token contract at ${tokenAddress} has no bytecode`)
  }

  const rentalBytecode = await publicClient.getCode({ address: rentalAddress })
  if (!rentalBytecode || rentalBytecode === '0x') {
    throw new DeploymentError(`Read-back failed: rental contract at ${rentalAddress} has no bytecode`)
  }

  // Minimal ABIs for read-back
  const tokenReadAbi = [
    { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
    { type: 'function', name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
    { type: 'function', name: 'owner', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
    { type: 'function', name: 'FAUCET_AMOUNT', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  ] as const

  const rentalReadAbi = [
    { type: 'function', name: 'owner', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
    { type: 'function', name: 'paymentToken', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
    { type: 'function', name: 'paused', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
    { type: 'function', name: 'quoteRent', inputs: [{ type: 'uint8', name: 'packageId' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
    {
      type: 'function',
      name: 'packageDetails',
      inputs: [{ type: 'uint8', name: 'packageId' }],
      outputs: [{
        type: 'tuple',
        components: [
          { type: 'uint256', name: 'price' },
          { type: 'uint256', name: 'validityDuration' },
          { type: 'uint256', name: 'includedMinutes' },
          { type: 'bool', name: 'active' },
        ],
      }],
      stateMutability: 'view',
    },
  ] as const

  // 2. Token read-back
  const [decimals, symbol, tokenOwner, faucetAmount] = await Promise.all([
    publicClient.readContract({ address: tokenAddress, abi: tokenReadAbi, functionName: 'decimals' }),
    publicClient.readContract({ address: tokenAddress, abi: tokenReadAbi, functionName: 'symbol' }),
    publicClient.readContract({ address: tokenAddress, abi: tokenReadAbi, functionName: 'owner' }),
    publicClient.readContract({ address: tokenAddress, abi: tokenReadAbi, functionName: 'FAUCET_AMOUNT' }),
  ])

  if (decimals !== 6) {
    throw new DeploymentError(`Token decimals mismatch: got ${decimals}, expected 6`)
  }
  if (symbol !== 'mUSDT') {
    throw new DeploymentError(`Token symbol mismatch: got "${symbol}", expected "mUSDT"`)
  }
  if (tokenOwner.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new DeploymentError(`Token owner mismatch: got ${tokenOwner}, expected ${expectedOwner}`)
  }
  if (faucetAmount !== 100_000_000n) {
    throw new DeploymentError(`Token faucet amount mismatch: got ${faucetAmount}, expected 100000000n`)
  }

  // 3. Rental read-back
  const [rentalOwner, paymentToken, isPaused, starterQuote, proQuote, starterPkg, proPkg] = await Promise.all([
    publicClient.readContract({ address: rentalAddress, abi: rentalReadAbi, functionName: 'owner' }),
    publicClient.readContract({ address: rentalAddress, abi: rentalReadAbi, functionName: 'paymentToken' }),
    publicClient.readContract({ address: rentalAddress, abi: rentalReadAbi, functionName: 'paused' }),
    publicClient.readContract({ address: rentalAddress, abi: rentalReadAbi, functionName: 'quoteRent', args: [1] }),
    publicClient.readContract({ address: rentalAddress, abi: rentalReadAbi, functionName: 'quoteRent', args: [2] }),
    publicClient.readContract({ address: rentalAddress, abi: rentalReadAbi, functionName: 'packageDetails', args: [1] }),
    publicClient.readContract({ address: rentalAddress, abi: rentalReadAbi, functionName: 'packageDetails', args: [2] }),
  ])

  if (rentalOwner.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new DeploymentError(`Rental owner mismatch: got ${rentalOwner}, expected ${expectedOwner}`)
  }
  if (paymentToken.toLowerCase() !== tokenAddress.toLowerCase()) {
    throw new DeploymentError(`Rental paymentToken mismatch: got ${paymentToken}, expected ${tokenAddress}`)
  }
  if (isPaused !== false) {
    throw new DeploymentError('Rental contract initial state is paused; expected unpaused')
  }

  // Starter package validation
  if (starterQuote !== 4_937_500n) {
    throw new DeploymentError(`Starter quoteRent mismatch: got ${starterQuote}, expected 4937500`)
  }
  if (starterPkg.price !== 4_937_500n || starterPkg.includedMinutes !== 60n || !starterPkg.active) {
    throw new DeploymentError('Starter package configuration mismatch')
  }

  // Pro package validation
  if (proQuote !== 18_687_500n) {
    throw new DeploymentError(`Pro quoteRent mismatch: got ${proQuote}, expected 18687500`)
  }
  if (proPkg.price !== 18_687_500n || proPkg.includedMinutes !== 300n || !proPkg.active) {
    throw new DeploymentError('Pro package configuration mismatch')
  }
}

/**
 * Execute deployment to Monad Testnet with progress tracking and safety checks.
 */
export async function deployMonadV2(options: {
  rpcUrl?: string
  privateKey?: Hex
  expectedDeployer?: Address
  initialOwner?: Address
  manifestPath?: string
  progressPath?: string
  dryRun?: boolean
  fetch?: typeof fetch
  publicClient?: PublicClient
  walletClient?: any
} = {}): Promise<MonadDeploymentManifest> {
  const env = process.env
  const rpcUrl = resolveOperationalRpc(env, options.rpcUrl)
  const maskedRpc = maskRpcUrl(rpcUrl)

  // 1. Verify online RPC chain ID
  const chainId = await verifyRpcChainId(rpcUrl, { fetch: options.fetch })
  if (chainId !== MONAD_TESTNET_CHAIN_ID) {
    throw new DeploymentError(`Connected RPC chain ID ${chainId} is not Monad Testnet (${MONAD_TESTNET_CHAIN_ID})`)
  }

  // 2. Resolve Signer
  const rawKey = options.privateKey || (env.MONAD_DEPLOYER_PRIVATE_KEY as Hex) || (env.PRIVATE_KEY as Hex)
  if (!rawKey) {
    throw new DeploymentError(
      'Missing deployer private key. Provide MONAD_DEPLOYER_PRIVATE_KEY or PRIVATE_KEY.'
    )
  }
  const formattedKey: Hex = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`
  const account = privateKeyToAccount(formattedKey)

  // 3. Match Expected Deployer
  const expectedDeployer = options.expectedDeployer || (env.EXPECTED_DEPLOYER_ADDRESS as Address) || (env.DEPLOYER_ADDRESS as Address)
  if (expectedDeployer && account.address.toLowerCase() !== expectedDeployer.toLowerCase()) {
    throw new DeploymentError(
      `Deployer address mismatch: signer address is ${account.address}, but expected deployer is ${expectedDeployer}`
    )
  }

  const owner = options.initialOwner || (env.INITIAL_OWNER_ADDRESS as Address) || account.address

  // Clients
  const publicClient =
    options.publicClient ||
    createPublicClient({
      chain: monadTestnet,
      transport: http(rpcUrl),
    })

  const walletClient =
    options.walletClient ||
    createWalletClient({
      account,
      chain: monadTestnet,
      transport: http(rpcUrl),
    })

  // 4. Balance Check & Monad Gas Estimation
  const balance = await publicClient.getBalance({ address: account.address })
  // On Monad, gas limit is charged directly. Total deployment estimated gas: ~3,000,000 gas.
  // At 100 gwei base fee, ~0.3 MON. Minimum safety floor: 0.05 MON.
  const minRequiredMon = 50_000_000_000_000_000n // 0.05 MON
  if (balance < minRequiredMon) {
    throw new DeploymentError(
      `Insufficient MON balance for deployment. Required at least 0.05 MON, current balance is ${formatEther(balance)} MON.`,
      { balance: formatEther(balance), required: '0.05 MON', deployer: account.address }
    )
  }

  console.log('\n================ Monad Testnet Deployment Summary ================')
  console.log(`Chain:            Monad Testnet (${MONAD_TESTNET_CHAIN_ID})`)
  console.log(`RPC URL:          ${maskedRpc}`)
  console.log(`Deployer:         ${account.address}`)
  console.log(`Initial Owner:    ${owner}`)
  console.log(`Deployer Balance: ${formatEther(balance)} MON`)
  console.log(`Contracts:        ArchavaMockUSDT, ArchavaRentalV2`)
  console.log('===================================================================\n')

  if (options.dryRun) {
    console.log('[DRY-RUN] Pre-flight checks passed successfully.')
    // Return fixture manifest
    return buildMonadDeploymentManifest({
      deployer: account.address,
      owner,
      tokenAddress: '0x0000000000000000000000000000000000000001',
      tokenTxHash: '0x0000000000000000000000000000000000000000000000000000000000000001',
      tokenBlock: 1n,
      tokenAbi: [],
      rentalAddress: '0x0000000000000000000000000000000000000002',
      rentalTxHash: '0x0000000000000000000000000000000000000000000000000000000000000002',
      rentalBlock: 2n,
      rentalAbi: [],
      deployedAt: new Date().toISOString(),
    })
  }

  // 5. Track Progress
  const deploymentsDir = join(rootDir, 'deployments')
  const progressPath = options.progressPath || join(deploymentsDir, '.progress-monadTestnetV2.json')
  const manifestPath = options.manifestPath || join(deploymentsDir, 'monadTestnetV2.json')

  let progress = loadProgress(progressPath) || {
    chainId: MONAD_TESTNET_CHAIN_ID,
    deployer: account.address,
    owner,
    status: 'idle',
    updatedAt: new Date().toISOString(),
  }

  // Load compiled artifacts
  const mockUsdtArtifact = loadForgeArtifact('ArchavaMockUSDT')
  const rentalV2Artifact = loadForgeArtifact('ArchavaRentalV2')

  // Step A: Deploy ArchavaMockUSDT (or resume if already deployed)
  let tokenAddress = progress.tokenAddress
  let tokenTxHash = progress.tokenDeployTxHash
  let tokenBlockNumber = progress.tokenBlockNumber

  if (tokenAddress) {
    console.log(`[Resume] Found existing token deployment at ${tokenAddress}. Verifying onchain...`)
    const code = await publicClient.getCode({ address: tokenAddress })
    if (code && code !== '0x') {
      console.log(`[Resume] Reusing verified existing ArchavaMockUSDT at ${tokenAddress}`)
    } else {
      console.log(`[Resume] Warning: Token at ${tokenAddress} has no bytecode. Redeploying token...`)
      tokenAddress = undefined
    }
  }

  if (!tokenAddress) {
    if (tokenTxHash && !tokenAddress) {
      console.log(`[Resume] Checking pending token deployment tx: ${tokenTxHash}...`)
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash: tokenTxHash })
        if (receipt.status === 'success' && receipt.contractAddress) {
          tokenAddress = receipt.contractAddress
          tokenBlockNumber = receipt.blockNumber.toString()
          progress.tokenAddress = tokenAddress
          progress.tokenBlockNumber = tokenBlockNumber
          progress.status = 'token_confirmed'
          saveProgress(progressPath, progress)
        }
      } catch {
        // Receipt not found yet, will redeploy
      }
    }

    if (!tokenAddress) {
      console.log('Deploying ArchavaMockUSDT...')
      tokenTxHash = await walletClient.deployContract({
        abi: mockUsdtArtifact.abi,
        bytecode: mockUsdtArtifact.bytecode.object,
        args: [owner],
      })
      console.log(`Transaction sent: ${tokenTxHash}. Awaiting confirmation...`)

      progress.tokenDeployTxHash = tokenTxHash
      progress.status = 'token_pending'
      saveProgress(progressPath, progress)

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: tokenTxHash!,
        confirmations: 1,
      })

      if (receipt.status !== 'success' || !receipt.contractAddress) {
        throw new DeploymentError(`ArchavaMockUSDT deployment failed or reverted: tx ${tokenTxHash}`)
      }

      tokenAddress = receipt.contractAddress
      tokenBlockNumber = receipt.blockNumber.toString()
      console.log(`✓ ArchavaMockUSDT deployed at ${tokenAddress} (block ${tokenBlockNumber})`)

      progress.tokenAddress = tokenAddress
      progress.tokenBlockNumber = tokenBlockNumber
      progress.status = 'token_confirmed'
      progress.updatedAt = new Date().toISOString()
      saveProgress(progressPath, progress)
    }
  }

  // Step B: Deploy ArchavaRentalV2
  let rentalAddress = progress.rentalAddress
  let rentalTxHash = progress.rentalDeployTxHash
  let rentalBlockNumber = progress.rentalBlockNumber

  if (rentalAddress) {
    console.log(`[Resume] Found existing rental deployment at ${rentalAddress}. Verifying onchain...`)
    const code = await publicClient.getCode({ address: rentalAddress })
    if (code && code !== '0x') {
      console.log(`[Resume] Reusing verified existing ArchavaRentalV2 at ${rentalAddress}`)
    } else {
      rentalAddress = undefined
    }
  }

  if (!rentalAddress) {
    if (rentalTxHash && !rentalAddress) {
      console.log(`[Resume] Checking pending rental deployment tx: ${rentalTxHash}...`)
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash: rentalTxHash })
        if (receipt.status === 'success' && receipt.contractAddress) {
          rentalAddress = receipt.contractAddress
          rentalBlockNumber = receipt.blockNumber.toString()
          progress.rentalAddress = rentalAddress
          progress.rentalBlockNumber = rentalBlockNumber
          progress.status = 'completed'
          saveProgress(progressPath, progress)
        }
      } catch {
        // Receipt not found yet
      }
    }

    if (!rentalAddress) {
      console.log(`Deploying ArchavaRentalV2 with payment token ${tokenAddress}...`)
      rentalTxHash = await walletClient.deployContract({
        abi: rentalV2Artifact.abi,
        bytecode: rentalV2Artifact.bytecode.object,
        args: [owner, tokenAddress],
      })
      console.log(`Transaction sent: ${rentalTxHash}. Awaiting confirmation...`)

      progress.rentalDeployTxHash = rentalTxHash
      progress.status = 'rental_pending'
      saveProgress(progressPath, progress)

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: rentalTxHash!,
        confirmations: 1,
      })

      if (receipt.status !== 'success' || !receipt.contractAddress) {
        throw new DeploymentError(`ArchavaRentalV2 deployment failed or reverted: tx ${rentalTxHash}`)
      }

      rentalAddress = receipt.contractAddress
      rentalBlockNumber = receipt.blockNumber.toString()
      console.log(`✓ ArchavaRentalV2 deployed at ${rentalAddress} (block ${rentalBlockNumber})`)

      progress.rentalAddress = rentalAddress
      progress.rentalBlockNumber = rentalBlockNumber
      progress.status = 'completed'
      progress.updatedAt = new Date().toISOString()
      saveProgress(progressPath, progress)
    }
  }

  // 6. Read-back Verification
  console.log('\nRunning onchain read-back verification...')
  await verifyDeployedContracts(publicClient, {
    tokenAddress,
    rentalAddress,
    expectedOwner: owner,
  })
  console.log('✓ All onchain read-backs verified successfully.')

  // 7. Generate Canonical Manifest
  const manifest = buildMonadDeploymentManifest({
    deployer: account.address,
    owner,
    tokenAddress,
    tokenTxHash: tokenTxHash!,
    tokenBlock: tokenBlockNumber!,
    tokenAbi: mockUsdtArtifact.abi,
    rentalAddress,
    rentalTxHash: rentalTxHash!,
    rentalBlock: rentalBlockNumber!,
    rentalAbi: rentalV2Artifact.abi,
    deployedAt: new Date().toISOString(),
    verificationStatus: 'pending',
  })

  mkdirSync(dirname(manifestPath), { recursive: true })
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  console.log(`\n✓ Canonical deployment manifest written to: ${manifestPath}`)

  // Clean up progress file on successful completion
  try {
    if (existsSync(progressPath)) {
      unlinkSync(progressPath)
    }
  } catch {
    // ignore
  }

  return manifest
}

// CLI entrypoint
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  deployMonadV2()
    .then((manifest) => {
      console.log('\nDeployment succeeded!')
      console.log(`ArchavaMockUSDT:  ${manifest.contracts.mockUsdt.address}`)
      console.log(`ArchavaRentalV2:  ${manifest.contracts.rentalV2.address}`)
      process.exit(0)
    })
    .catch((err) => {
      console.error(`\n❌ Deployment Failed: ${err.message}`)
      if (err.details) console.error('Details:', err.details)
      process.exit(1)
    })
}
