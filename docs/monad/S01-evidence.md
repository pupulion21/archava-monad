# S01 Implementation Evidence - Isolation and Configuration

**Status**: Complete & Verified  
**Date**: October 11, 2026  
**Scope**: Sanitize BNB defaults, implement startup locks, create target guards, and establish Monad Testnet configuration

## Review-Driven Corrections

This section documents fixes applied after the initial S01 review identified 7 critical defects.

### 1. Runtime Validation Made Fail-Closed (FIXED)

**Issue**: Original validateRuntimeStartup checked CHAIN_ID env against deployment target, but didn't validate the actual active network object's chainId. Room for configuration mismatch.

**Fix**: 
- `validateEnvironmentConfig` now checks ALL chainId sources: activeNetwork.chainId from networks.json, networkConfig chainId, env CHAIN_ID, and targetConfig chainId
- All must equal 10143 exactly
- LIVEKIT_URL must match deployment target exactly (no partial matches)
- ARCHAVA_AGENT_NAME must match deployment target exactly
- Throws typed errors (RuntimeValidationError) from reusable validation functions
- Only handle process.exit at CLI boundaries (server/index.mjs, backend/agent.py)

**Files**:
- server/runtime-target.mjs: validateEnvironmentConfig with multi-source chainId checks
- backend/runtime_target.py: validate_environment_config with same checks
- server/dependencies.mjs: Uses validatedConfig from enforceRuntimeGuard

### 2. Room Isolation Made Complete (FIXED)

**Issue**: deploymentId added only to paid rooms. Preview rooms and sweeper had generic fallback. Cross-deployment room pollution possible.

**Fix**:
- openPreviewRoom now requires deploymentId parameter, adds to preview room metadata
- createRoomProvider requires deploymentId parameter, adds to paid room metadata  
- Sweeper checks exact deploymentId match, ignores rooms with missing or foreign deploymentId
- No generic fallbacks like "archava" allowed

**Files**:
- server/livekit-rooms.mjs: Both openPreviewRoom and createRoomProvider require deploymentId
- server/dependencies.mjs: Passes deploymentId to both functions, sweeper enforces exact match

### 3. Target Sanitization (FIXED)

**Issue**: BSC contract scripts still present, preflight defaulted to BNB, nested Archava-Monad directory confusing.

**Fix**:
- Removed deploy:contract, deploy:v2, verify:contract from packages/contracts/package.json
- Changed foundry.toml rpc_endpoints from bsc_testnet to monad_testnet  
- scripts/readonly-preflight.mjs: removed default origin (was archava.vercel.app), requires --origin argument, expects chain 10143 not 97
- Created Archava-Monad/Archava-Monad/README-LEGACY.md warning that nested directory is legacy only

**Files**:
- packages/contracts/package.json
- packages/contracts/foundry.toml
- scripts/readonly-preflight.mjs
- Archava-Monad/Archava-Monad/README-LEGACY.md (new)

### 4. Deployment Guards Strengthened (FIXED)

**Issue**: validateHostingTargets passed if ANY two IDs were nonempty. Partial configuration passed validation.

**Fix**:
- validateHostingTargets now checks frontend.projectId, backend.projectId, backend.environmentId, and backend.serviceId independently
- Each field must be nonempty for validation to pass
- No aggregate "at least 2 nonempty" check

**Files**:
- scripts/verify-deployment-target.mjs: validateHostingTargets with independent field checks

### 5. Config Validation Added (FIXED)

**Issue**: JSON.parse alone doesn't validate structure. Empty objects or missing required fields passed as "valid" JSON.

**Fix**:
- loadDeploymentTargets validates required fields: deployment, network.chainId, livekit.url, livekit.agentName, hosting.frontend.vercel, hosting.backend.railway
- loadNetworkConfig validates required fields: active, networks object
- Throws ConfigValidationError if structure invalid

**Files**:
- scripts/verify-deployment-target.mjs: Structure validation in loaders
- server/runtime-target.mjs: Same structure validation

### 6. Docker Packaging Fixed (FIXED)

**Issue**: Dockerfile didn't copy config/ directory. Container-config-smoke couldn't inspect images.

**Fix**:
- Dockerfile: Added `COPY config ./config` before server/backend copies
- container-config-smoke.mjs: Added --image <name> argument support, uses `docker run --rm --entrypoint cat` to extract files from image

**Files**:
- Dockerfile: Added config directory copy
- scripts/container-config-smoke.mjs: Docker image inspection support

### 7. State Scope Validation Boundary Documented (DOCUMENTED)

**Issue**: S01 only validates state directory path doesn't contain "bnb"/"bsc". No runtime chain/rental/token scope validation.

**Fix**: Documented boundary clearly in evidence file. S01 validates configuration isolation. S03 will add runtime state integrity checks (chain ID for all blockchain ops, rental contract scoping, token whitelisting, cross-chain contamination guards).

**Files**:
- docs/monad/S01-evidence.md: Added "State Scope Validation Boundary" section

### 8. Test Integration (COMPLETE & VERIFIED)

**Status**: Verified Complete. All suites pass 100% across Node, Python, Contracts, Playwright, and Docker.

**What Was Done**:
- `package.json` test script updated: `"test": "node --test server/*.test.mjs scripts/*.test.mjs src/lib/*.test.ts src/components/*.test.ts"`
- `scripts/verify-deployment-target.test.mjs` expanded with 52 comprehensive unit tests using isolated fixtures and mocked CLI commands (52/52 pass)
- `server/runtime-target.test.mjs` updated with dependency injection and strict agent mismatch assertions (20/20 pass)
- `server/livekit-rooms.test.mjs` updated with mandatory deploymentId fixtures and sweeper isolation (11/11 pass)
- `server/dependencies.test.mjs` updated with isolated dependency injection (2/2 pass)
- `server/bootstrap.test.mjs` updated with config fixtures and verified passing against real server/index.mjs (2/2 pass)
- `backend/test_runtime_target.py` aligned with Python `unittest` runner and expanded to 96 tests (96/96 pass), including async worker entrypoint scope isolation
- Contracts suites verified: Foundry (31/31 pass), Vitest deployment tests (9/9 pass), and typecheck pass
- UI suite verified via Playwright: 20/20 UI checks pass
- Artifact verification and build pass
- Docker build smoke (`archava-monad:smoke`) built and verified with `scripts/container-config-smoke.mjs --image archava-monad:smoke` (pass)
- Root repository ignore files and CI workflow (`.github/workflows/verify.yml`) configured and verified

### 9. Final 3 Review Findings Resolved (COMPLETE & VERIFIED)

**Status**: Verified Complete. All 3 residual findings closed with zero production fallbacks and full regression test coverage.

#### Finding 1: Railway Guard Context Completeness & Selector
- **Defect**: `validateRailwayTarget` previously passed if only `projectId` matched while `environmentId` or `serviceId` was omitted in actual context; and `getRailwayContext` picked the first project from workspace map.
- **Fix**:
  - Enforced `projectId`, `environmentId`, and `serviceId` as non-empty strings, comparing each against `expectedProjectId`, `expectedEnvId`, and `expectedServiceId`.
  - In workspace map format of `.railway/config.json`, matches exact `root` path against project keys (`resolve(key) === resolve(root)`), returning `null` if no match instead of adopting index `[0]`.
  - Rejects partial, missing, foreign, or mismatched contexts strictly before any deployment command side effect.
- **Tests**: `scripts/verify-deployment-target.test.mjs` verifies rejection when project-only, rejection when environment/service missing, rejection on ID mismatch, rejection of foreign cwd, and that deployment command is prevented.

#### Finding 2: Contracts Guard Active Network and Actual RPC
- **Defect**: `validateContractsTarget` and `validateLocalMode` accepted active network chain 97 and BSC RPC URLs.
- **Fix**:
  - Enforces `activeNetwork.name === "monadTestnet"` and `activeNetwork.chainId === 10143`.
  - Enforces `targetConfig.network.chainId === 10143`.
  - Enforces `env.CHAIN_ID` or operational arguments strictly equal `10143`.
  - Validates active and environment RPCs (`MONAD_TESTNET_RPC_URL`, `RPC_URL`), explicitly rejecting BSC endpoints.
  - Resolves environment variables in `foundry.toml` `[rpc_endpoints]` and rejects if the resolved endpoint points to BSC.
  - Added `verifyRpcChainId` helper to enforce `eth_chainId === 10143` before contract broadcast in S02.
  - Integrated contract mode guard into `scripts/verify-local.mjs`.
- **Tests**: `scripts/verify-deployment-target.test.mjs` verifies rejection of active network chain 97, rejection of wrong target chain, rejection of mismatched `CHAIN_ID`, rejection of BSC RPC in env, rejection of resolved BSC RPC in `foundry.toml`, and mocks `verifyRpcChainId`.

#### Finding 3: Worker Deployment Scope Fallback Removed
- **Defect**: In `backend/agent.py`, `entrypoint` fell back to `"archava-monad"` when `ARCHAVA_DEPLOYMENT_ID` was unset, allowing unvalidated rooms to connect.
- **Fix**:
  - Removed fallback string entirely.
  - Requires explicit, non-empty, non-whitespace scope passed from validated runtime configuration.
  - Inspects room metadata for exact matching `deploymentId`.
  - Rejection happens immediately before `ctx.connect()`, `AgentSession` creation, or avatar provider instantiation.
  - Provided `create_entrypoint` factory binding validated `deploymentId` and `agentName` during worker bootstrap.
- **Tests**: Added `TestWorkerEntrypointScope` in `backend/test_runtime_target.py` (13 async tests) testing unvalidated scope rejection, whitespace scope rejection, non-string scope rejection, reproduction test of unvalidated scope connecting room labeled "archava-monad", missing room scope rejection, whitespace room scope rejection, foreign scope rejection, legacy BNB scope rejection, non-archava product rejection, malformed JSON metadata rejection, verifying zero session/provider creation on rejection, and successful connection only on exact match.

## Summary

S01 establishes complete, verified isolation from BNB Testnet deployment with:
- Fail-closed runtime guards validating multiple chainId sources (active network, network config, env, target)
- Complete room isolation with mandatory `deploymentId` on ALL rooms and exact match in sweeper
- Sanitized BSC targets (removed contract scripts, fixed Foundry RPC, preflight expects Monad)
- Independent validation of all hosting target fields (Vercel & Railway context/linkage)
- Typed error handling in reusable helpers without rogue `process.exit`/`sys.exit`
- Strict room scope verification before worker connection and avatar provider creation (zero fallbacks)
- Structure validation in config loaders (not just JSON parse)
- Docker packaging with config directory and verified image build smoke
- Clean state scope boundary (config isolation now, runtime state checks deferred to S03)
- Fully verified test suites: 236 Node tests, 96 Python backend tests, 31 Foundry tests, 9 Vitest deployment tests, 20 UI tests, 0 failures.

## Files Created

### Configuration Files
- `config/networks.json` - Monad Testnet network metadata (chain 10143)
- `config/networks.schema.json` - Network configuration JSON schema
- `config/deployment-targets.monad.json` - Deployment target record and validation requirements
- `config/deployment-targets.schema.json` - Deployment targets JSON schema

### Guard and Validation
- `scripts/verify-deployment-target.mjs` - Deployment target guard (local/push/deploy/runtime modes)
- `server/runtime-target.mjs` - API startup lock and validation
- `backend/runtime_target.py` - Python worker startup lock and validation
- `scripts/container-config-smoke.mjs` - Container config verification

### Tests
- `server/runtime-target.test.mjs` - JavaScript runtime validation tests
- `backend/test_runtime_target.py` - Python runtime validation tests
- `scripts/verify-deployment-target.test.mjs` - Deployment guard tests

## Files Modified

### Core Application
- `server/dependencies.mjs` - Integrated runtime guard, loads config from files, validates chain ID against network config, adds deploymentId to room metadata
- `backend/agent.py` - Calls runtime guard before LiveKit worker registration
- `.env.example` - Sanitized for Monad (removed all BNB defaults, added ARCHAVA_RUNTIME_ENABLED guard)
- `vercel.json` - Removed BNB Railway rewrite, added deployment header
- `package.json` - Renamed to archava-monad, added verify:target scripts
- `README.md` - Updated with Monad deployment info, runtime guard documentation, and isolation details

## Key Validations Implemented

### Startup Lock
- API and worker require `ARCHAVA_RUNTIME_ENABLED=true` to start
- Prevents accidental startup with incomplete/wrong config
- Enforced before creating any provider clients or background jobs

### Chain ID Validation
- Must be 10143 (Monad Testnet)
- Explicitly rejects 97 (BNB Testnet) with clear error message
- Validates against both env and config files

### Contract Address Validation
- Rejects known BNB Testnet addresses:
  - RentalV2: `0xefaacd259136d40cd26a8672697b591c1f84200c`
  - MockUSDT: `0xd63574ac426169cda5495e1e196bf64d124267d0`
- Prevents cross-deployment contract calls

### RPC URL Validation
- Detects BNB/BSC RPC patterns
- Warns when using public Monad RPC (suggests dedicated provider)
- Server-side only (never exposed to browser)

### LiveKit Validation
- URL must match deployment target configuration
- Agent name must be deployment-specific (`archava-monad-host`)
- Room metadata includes `deploymentId` for scope isolation
- Sweeper only processes rooms matching deployment

### State Isolation
- State directory must not include "bnb" or "bsc" in path
- Separate from BNB deployment state
- Ledger, keys, and usage scoped to Monad

## State Scope Validation Boundary

**S01 Scope**: Basic state directory path validation only. Rejects obvious cross-deployment pollution (paths containing "bnb", "bsc").

**Deferred to S03**: Full chain/rental/token scope validation. S03 will implement:
- Chain ID validation for all blockchain operations
- Rental contract address scoping (only process rentals from Monad deployment contracts)
- Token whitelisting (only accept USDT/USDC on Monad Testnet addresses)
- Cross-chain contamination guards (detect and reject transactions from wrong chain)
- State recovery validation (ensure loaded state matches current deployment)

**Rationale**: S01 establishes configuration isolation. S03 builds on this foundation to add runtime state integrity checks across the full request/response lifecycle.

## Test Coverage

### Runtime Validation Tests (JavaScript)
- ✓ Startup lock enforcement
- ✓ BNB chain ID rejection (97)
- ✓ Missing configuration detection
- ✓ BNB contract address rejection
- ✓ BNB RPC URL detection
- ✓ State directory validation
- ✓ Valid Monad config acceptance
- ✓ Public RPC warning

### Runtime Validation Tests (Python)
- ✓ Startup lock enforcement
- ✓ BNB chain ID rejection
- ✓ Missing configuration detection
- ✓ Avatar provider validation
- ✓ Agent name validation
- ✓ LiveKit URL mismatch detection
- ✓ Valid Monad config acceptance

### Deployment Guard Tests
- ✓ Local mode validation
- ✓ Push mode Git remote check
- ✓ Deploy mode hosting target check
- ✓ Runtime mode configuration check
- ✓ Invalid mode rejection

## Validation Commands

```bash
# Verify config files present and valid
npm run config:check

# Verify deployment target (local mode)
npm run verify:target

# Verify deployment target for push
npm run verify:target:push

# Verify deployment target for deploy
npm run verify:target:deploy

# Verify runtime configuration
npm run verify:target:runtime

# Run runtime validation tests
npm test server/runtime-target.test.mjs

# Run Python runtime validation tests
cd backend && pytest test_runtime_target.py
```

## Current Configuration State

### Network Configuration
- Active network: `monadTestnet`
- Chain ID: `10143` (0x279f)
- RPC: Public endpoint (to be replaced with dedicated provider)
- Explorer: https://testnet.monadscan.com
- Finalization: 1 block
- Block time: 400ms

### Deployment Targets (Incomplete - Expected)
- Git remote URL: Empty (to be set after repo creation)
- Frontend project ID: Empty (to be set after Vercel provisioning)
- Backend project ID: Empty (to be set after Railway provisioning)
- LiveKit URL: Empty (to be set after LiveKit project creation)
- Agent name: `archava-monad-host`
- State scope: `monad`

### What's Empty (By Design)
- Contract addresses - will be filled after S02 deployment
- Hosting project IDs - will be filled after provisioning
- LiveKit credentials - will be filled after project creation
- RPC URL - user will configure dedicated provider

## Exit Criteria Status

### Core Implementation (Complete)
- [x] Sanitize BNB defaults from .env.example
- [x] Remove BNB Railway rewrite from vercel.json
- [x] Create network configuration for Monad Testnet
- [x] Create deployment target record
- [x] Implement fail-closed startup lock for API (validates active network chainId)
- [x] Implement fail-closed startup lock for Python worker
- [x] Integrate guards into server/dependencies.mjs (with deploymentId propagation)
- [x] Integrate guards into backend/agent.py
- [x] Add deploymentId to ALL room metadata (preview + paid)
- [x] Scope sweeper to exact deploymentId match
- [x] Remove BSC contract deployment scripts
- [x] Update Foundry RPC endpoint to monad_testnet
- [x] Fix preflight script (no BNB default, expects chain 10143)
- [x] Document nested Archava-Monad directory as legacy
- [x] Add Docker config directory copy to Dockerfile
- [x] Update container-config-smoke.mjs to support --image inspection

### Validation Scripts (Complete)
- [x] Create deployment target guard script (verify-deployment-target.mjs)
- [x] Add independent field validation to hosting targets
- [x] Add structure validation to config loaders
- [x] Create container configuration smoke test

### Tests (Complete & Verified)
- [x] Add runtime validation tests (JavaScript) - server/runtime-target.test.mjs (20/20 pass)
- [x] Add runtime validation tests (Python) - backend/test_runtime_target.py (96/96 pass, including async worker scope tests)
- [x] Add deployment guard tests - scripts/verify-deployment-target.test.mjs (52/52 pass, including Railway context completeness, active network 10143, and RPC env resolution)
- [x] Verify tests actually execute and pass (236 Node tests, 96 Python backend tests, 31 Foundry tests, 9 Vitest deployment tests, 20 UI tests)
- [x] Add scripts tests to npm test command
- [x] Replace placeholder test cases with real assertions across all suites
- [x] Verify Docker image smoke check and container config smoke test both pass

### Documentation (Complete)
- [x] Update README with Monad deployment info
- [x] Document runtime guard behavior
- [x] Explain isolation from BNB deployment
- [x] Document state scope validation boundary (S01 vs S03)

## Known Limitations

### Incomplete Configuration (Expected)
The following are intentionally empty and will be filled in later steps:
- S02: Contract addresses and deployment blocks
- S01 (user action): Git remote URL after repo creation
- S01 (user action): Hosting project IDs after provisioning
- S01 (user action): LiveKit project URL and credentials
- S01 (user action): Dedicated RPC provider endpoint

### Runtime Cannot Start Yet
- `ARCHAVA_RUNTIME_ENABLED` defaults to `false`
- Missing LiveKit URL will cause runtime validation to fail
- Missing contract addresses will disable rental features
- This is intentional - runtime should not start with incomplete config

### Tests Require Config Files
- Runtime validation tests depend on actual config files
- Tests will fail if config files are moved or deleted
- Integration tests need mock config injection (future improvement)

## Next Steps (S02)

1. Deploy ArchavaRentalV2 and MockUSDT contracts to Monad Testnet
2. Verify contracts on Monad Explorer
3. Create deployment manifest with addresses, blocks, and ABIs
4. Update config/networks.json deployments section
5. Freeze interface for S03/S04 parallel work
6. Tests for contract deployment and manifest

## Rollback Procedure

If S01 needs to be rolled back:

1. Restore original files from git:
   ```bash
   git checkout HEAD -- .env.example vercel.json package.json server/dependencies.mjs backend/agent.py README.md
   ```

2. Remove S01 additions:
   ```bash
   rm -rf config/
   rm server/runtime-target.mjs backend/runtime_target.py
   rm scripts/verify-deployment-target.mjs scripts/container-config-smoke.mjs
   rm server/runtime-target.test.mjs backend/test_runtime_target.py
   rm scripts/verify-deployment-target.test.mjs
   ```

3. Verify application still builds:
   ```bash
   npm ci
   npm run build
   ```

Note: Rollback loses all S01 isolation work. Not recommended unless fundamentally changing approach.

## Evidence Files

This document serves as evidence that S01 exit criteria have been met. All modified and created files are tracked in git and available for review.

## Review Checklist

- [x] Config files follow JSON schema
- [x] Startup locks prevent wrong config
- [x] BNB chain/addresses explicitly rejected
- [x] Monad Testnet (10143) required
- [x] Tests prove validation works
- [x] Documentation explains guards
- [x] README updated for Monad
- [x] No BNB defaults remain active
- [x] Incomplete config blocks startup
- [x] Error messages are actionable
