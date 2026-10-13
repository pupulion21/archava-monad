import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { encodeAbiParameters, isAddress, type Address } from 'viem'
import {
  MONAD_TESTNET_CHAIN_ID,
  type MonadDeploymentManifest,
} from './deploy-monad-v2.js'

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

export const MONADSCAN_API_URL = 'https://api-testnet.monadscan.com/api'
export const SOURCIFY_MONAD_URL = 'https://sourcify-api-monad.blockvision.org'

export interface VerificationOptions {
  verifier?: 'etherscan' | 'sourcify' | 'blockscout' | 'custom'
  verifierUrl?: string
  apiKey?: string
  compilerVersion?: string
  optimizerRuns?: number
  evmVersion?: string
}

export interface VerificationResult {
  contractName: string
  address: Address
  status: 'verified' | 'pending' | 'unverified' | 'failed'
  verifier: string
  message: string
}

export interface VerificationReport {
  success: boolean
  manifestPath: string
  results: Record<string, VerificationResult>
}

/**
 * Mask sensitive arguments for logging.
 */
export function sanitizeVerificationArgsForLog(args: readonly string[]): string[] {
  const sanitized: string[] = []
  let maskNext = false
  for (const arg of args) {
    if (maskNext) {
      sanitized.push('***')
      maskNext = false
      continue
    }
    if (arg === '--etherscan-api-key' || arg === '--verifier-api-key') {
      sanitized.push(arg)
      maskNext = true
      continue
    }
    sanitized.push(arg)
  }
  return sanitized
}

/**
 * Build forge verify-contract argument array without shell interpolation.
 */
export function buildMonadVerificationArgs(
  contractTarget: 'mockUsdt' | 'rentalV2',
  manifest: MonadDeploymentManifest,
  options: VerificationOptions = {}
): string[] {
  if (manifest.chainId !== MONAD_TESTNET_CHAIN_ID) {
    throw new Error(
      `Monad verification requires chain ID ${MONAD_TESTNET_CHAIN_ID}; got ${manifest.chainId}.`
    )
  }

  const verifier = options.verifier || (options.apiKey ? 'etherscan' : 'sourcify')
  const verifierUrl =
    options.verifierUrl ||
    (verifier === 'sourcify' ? SOURCIFY_MONAD_URL : MONADSCAN_API_URL)
  const compilerVersion = options.compilerVersion || '0.8.28'
  const optimizerRuns = options.optimizerRuns ?? 200
  const evmVersion = options.evmVersion || 'cancun'

  let contractAddress: Address
  let contractPath: string
  let encodedArgs: string

  if (contractTarget === 'mockUsdt') {
    const contract = manifest.contracts.mockUsdt
    if (!contract || !isAddress(contract.address)) {
      throw new Error(`Invalid or missing mockUsdt address in manifest: ${contract?.address}`)
    }
    contractAddress = contract.address
    contractPath = 'src/ArchavaMockUSDT.sol:ArchavaMockUSDT'

    const owner = contract.constructorArguments[0]
    if (!isAddress(owner)) {
      throw new Error(`Invalid constructor initialOwner: ${owner}`)
    }

    encodedArgs = encodeAbiParameters([{ type: 'address', name: 'initialOwner' }], [owner])
  } else if (contractTarget === 'rentalV2') {
    const contract = manifest.contracts.rentalV2
    if (!contract || !isAddress(contract.address)) {
      throw new Error(`Invalid or missing rentalV2 address in manifest: ${contract?.address}`)
    }
    contractAddress = contract.address
    contractPath = 'src/ArchavaRentalV2.sol:ArchavaRentalV2'

    const [owner, token] = contract.constructorArguments
    if (!isAddress(owner) || !isAddress(token)) {
      throw new Error(`Invalid constructor arguments for ArchavaRentalV2: ${owner}, ${token}`)
    }

    encodedArgs = encodeAbiParameters(
      [
        { type: 'address', name: 'initialOwner' },
        { type: 'address', name: 'initialPaymentToken' },
      ],
      [owner, token]
    )
  } else {
    throw new Error(`Unknown contract target: ${String(contractTarget)}`)
  }

  const args: string[] = [
    'verify-contract',
    contractAddress,
    contractPath,
    '--chain-id',
    MONAD_TESTNET_CHAIN_ID.toString(),
    '--compiler-version',
    compilerVersion,
    '--optimizer-runs',
    optimizerRuns.toString(),
    '--evm-version',
    evmVersion,
    '--constructor-args',
    encodedArgs,
    '--verifier',
    verifier,
    '--verifier-url',
    verifierUrl,
  ]

  if (verifier === 'etherscan' && options.apiKey && options.apiKey.trim() !== '') {
    args.push('--etherscan-api-key', options.apiKey.trim())
  } else if (verifier === 'custom' && options.apiKey && options.apiKey.trim() !== '') {
    args.push('--verifier-api-key', options.apiKey.trim())
  }

  args.push('--watch')

  return args
}

/**
 * Execute forge verify-contract using child_process.spawnSync (safe array execution).
 */
export function executeForgeVerify(
  args: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    spawnFn?: typeof spawnSync
  } = {}
): SpawnSyncReturns<Buffer | string> {
  const spawnFn = options.spawnFn || spawnSync
  const cwd = options.cwd || rootDir
  const env = options.env || process.env

  return spawnFn('forge', args, {
    cwd,
    env,
    encoding: 'utf8',
  })
}

/**
 * Run verification for both contracts in the deployment manifest.
 */
export async function verifyMonadV2(options: {
  manifestPath?: string
  verifier?: 'etherscan' | 'sourcify' | 'blockscout' | 'custom'
  verifierUrl?: string
  apiKey?: string
  spawnFn?: typeof spawnSync
} = {}): Promise<VerificationReport> {
  const manifestPath =
    options.manifestPath || join(rootDir, 'deployments', 'monadTestnetV2.json')

  if (!existsSync(manifestPath)) {
    throw new Error(
      `Deployment manifest not found at ${manifestPath}. Deploy contracts first with deploy:monad:v2.`
    )
  }

  const raw = readFileSync(manifestPath, 'utf8')
  let manifest: MonadDeploymentManifest
  try {
    manifest = JSON.parse(raw) as MonadDeploymentManifest
  } catch (err) {
    throw new Error(`Failed to parse manifest at ${manifestPath}: ${(err as Error).message}`)
  }

  const apiKey =
    options.apiKey ||
    process.env.MONADSCAN_API_KEY ||
    process.env.ETHERSCAN_API_KEY ||
    ''

  const envVerifier = process.env.VERIFIER as 'etherscan' | 'sourcify' | 'blockscout' | 'custom' | undefined
  const chosenVerifier: 'etherscan' | 'sourcify' | 'blockscout' | 'custom' =
    options.verifier || envVerifier || (apiKey && apiKey.trim() !== '' ? 'etherscan' : 'sourcify')

  const verifyOpts: VerificationOptions = {
    verifier: chosenVerifier,
    verifierUrl: options.verifierUrl,
    apiKey,
  }

  console.log('\n================ Monad Contract Verification ================')
  console.log(`Manifest: ${manifestPath}`)
  console.log(`Network:  ${manifest.network} (${manifest.chainId})`)
  console.log(`Verifier: ${chosenVerifier}`)
  console.log(`URL:      ${verifyOpts.verifierUrl || (chosenVerifier === 'sourcify' ? SOURCIFY_MONAD_URL : MONADSCAN_API_URL)}`)
  console.log('=============================================================\n')

  const results: Record<string, VerificationResult> = {}
  let allSuccess = true

  const targets: readonly ('mockUsdt' | 'rentalV2')[] = ['mockUsdt', 'rentalV2']

  const updatedManifest: MonadDeploymentManifest = {
    ...manifest,
    contracts: {
      mockUsdt: { ...manifest.contracts.mockUsdt },
      rentalV2: { ...manifest.contracts.rentalV2 },
    },
  }

  for (const target of targets) {
    const contract = manifest.contracts[target]
    const contractName = contract.name

    console.log(`[Verifying] ${contractName} at ${contract.address}...`)

    const args = buildMonadVerificationArgs(target, manifest, verifyOpts)
    const sanitizedLog = sanitizeVerificationArgsForLog(args).join(' ')
    console.log(`Running: forge ${sanitizedLog}`)

    const res = executeForgeVerify(args, { spawnFn: options.spawnFn })
    const output = `${res.stdout || ''}\n${res.stderr || ''}`

    if (res.status === 0) {
      console.log(`✓ ${contractName} successfully verified!`)
      results[target] = {
        contractName,
        address: contract.address,
        status: 'verified',
        verifier: chosenVerifier,
        message: 'Contract source successfully verified onchain explorer.',
      }
      if (target === 'mockUsdt') {
        ;(updatedManifest.contracts.mockUsdt as { verificationStatus: string }).verificationStatus = 'verified'
      } else {
        ;(updatedManifest.contracts.rentalV2 as { verificationStatus: string }).verificationStatus = 'verified'
      }
    } else {
      allSuccess = false
      const errorSnippet = output.trim().split('\n').slice(-5).join(' ') || `Exit code ${res.status}`
      console.warn(`⚠ ${contractName} verification did not complete (exit code ${res.status}).`)
      console.warn(`Reason: ${errorSnippet}`)
      console.warn('Note: Deployment remains valid and intact. Contract can be verified manually.')

      results[target] = {
        contractName,
        address: contract.address,
        status: 'pending',
        verifier: chosenVerifier,
        message: `Verification attempt failed: ${errorSnippet}`,
      }
      if (target === 'mockUsdt') {
        ;(updatedManifest.contracts.mockUsdt as { verificationStatus: string }).verificationStatus = 'pending'
      } else {
        ;(updatedManifest.contracts.rentalV2 as { verificationStatus: string }).verificationStatus = 'pending'
      }
    }
  }

  // Save updated manifest
  try {
    writeFileSync(manifestPath, JSON.stringify(updatedManifest, null, 2), 'utf8')
    console.log(`\nUpdated manifest verification status written to: ${manifestPath}`)
  } catch (err) {
    console.warn(`Warning: Could not write updated manifest: ${(err as Error).message}`)
  }

  return {
    success: allSuccess,
    manifestPath,
    results,
  }
}

// CLI entrypoint
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  verifyMonadV2()
    .then((report) => {
      if (report.success) {
        console.log('\nAll contracts verified successfully!')
        process.exit(0)
      } else {
        console.log('\nSome or all contracts could not be verified automatically. Status marked as pending.')
        // Verification failure does NOT mean deployment failure; exit 0 to prevent deployment abort
        process.exit(0)
      }
    })
    .catch((err) => {
      console.error(`\nVerification Error: ${err.message}`)
      process.exit(1)
    })
}
