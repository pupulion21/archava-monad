/**
 * Tests for deployment target guard (scripts/verify-deployment-target.mjs).
 * 
 * Verifies that the guard compares expected target configuration with the
 * actual linkage/context/selector used by Vercel and Railway, and rejects
 * missing, incomplete, or legacy targets before side effects.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

import {
  DeploymentGuardError,
  loadDeploymentTargets,
  loadNetworkConfig,
  validateGitRemote,
  getVercelLinkage,
  validateVercelTarget,
  getRailwayContext,
  validateRailwayTarget,
  validateHostingTargets,
  validateRuntimeConfig,
  validateContractsTarget,
  validateLocalMode,
  verifyDeploymentTarget,
  verifyRpcChainId,
  isBnbRpc,
  validateRpcUrl,
  maskRpcUrl,
  getNetworkRpcUrls,
  resolveOperationalRpc,
} from "./verify-deployment-target.mjs";

const GUARD_SCRIPT = resolve(process.cwd(), "scripts/verify-deployment-target.mjs");

function createTempWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "guard-test-"));
  mkdirSync(join(dir, "config"), { recursive: true });
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const validTargetConfig = {
  version: "1",
  deployment: "monad",
  git: {
    remoteUrl: "https://github.com/Archzxylabs/Archava-Monad.git",
    remoteName: "origin",
    defaultBranch: "monad",
  },
  network: {
    chainId: 10143,
    name: "monadTestnet",
    rpc: {
      public: "https://testnet-rpc.monad.xyz",
    },
  },
  hosting: {
    frontend: {
      provider: "vercel",
      projectId: "prj_monad_frontend_123",
      projectName: "archava-monad",
    },
    backend: {
      provider: "railway",
      projectId: "railway_proj_monad_456",
      environmentId: "env_monad_789",
      serviceId: "srv_monad_012",
      serviceName: "archava-monad-backend",
    },
  },
  livekit: {
    url: "wss://archava-monad.livekit.cloud",
    projectScope: "archava-monad",
    agentName: "archava-monad-host",
  },
  state: {
    directory: "./data",
    scope: "monad",
  },
};

const validNetworkConfig = {
  active: "monadTestnet",
  networks: {
    monadTestnet: {
      chainId: 10143,
      name: "Monad Testnet",
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      blockExplorer: { name: "MonadScan", url: "https://testnet.monadscan.com" },
      rpcUrls: {
        default: { http: ["https://testnet-rpc.monad.xyz"] },
        public: { http: ["https://testnet-rpc.monad.xyz"] },
      },
    },
  },
};

describe("Deployment Target Guard", () => {
  describe("Config loaders structure validation", () => {
    it("fails if deployment target config file is missing", () => {
      const ws = createTempWorkspace();
      try {
        assert.throws(
          () => loadDeploymentTargets({ cwd: ws.dir }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("Deployment target configuration not found")
        );
      } finally {
        ws.cleanup();
      }
    });

    it("fails if deployment target config is missing required livekit.projectScope", () => {
      const ws = createTempWorkspace();
      try {
        const invalid = { ...validTargetConfig, livekit: { ...validTargetConfig.livekit, projectScope: "" } };
        writeFileSync(join(ws.dir, "config/deployment-targets.monad.json"), JSON.stringify(invalid));
        assert.throws(
          () => loadDeploymentTargets({ cwd: ws.dir }),
          (err) => err instanceof DeploymentGuardError && err.details?.error?.includes("livekit.projectScope")
        );
      } finally {
        ws.cleanup();
      }
    });

    it("fails if network config file is missing", () => {
      const ws = createTempWorkspace();
      try {
        assert.throws(
          () => loadNetworkConfig({ cwd: ws.dir }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("Network configuration not found")
        );
      } finally {
        ws.cleanup();
      }
    });
  });

  describe("Git remote validation (push mode)", () => {
    it("passes with matching Git remote URL", () => {
      const mockExec = () => "https://github.com/Archzxylabs/Archava-Monad.git\n";
      const result = validateGitRemote(validTargetConfig, { exec: mockExec });
      assert.equal(result, true);
    });

    it("fails if expected Git remote is not configured in targetConfig", () => {
      const config = { ...validTargetConfig, git: { ...validTargetConfig.git, remoteUrl: "" } };
      assert.throws(
        () => validateGitRemote(config),
        (err) => err instanceof DeploymentGuardError && err.message.includes("Git remote URL not configured")
      );
    });

    it("fails if actual Git remote does not match expected target", () => {
      const mockExec = () => "https://github.com/SomeOtherOrg/RandomRepo.git\n";
      assert.throws(
        () => validateGitRemote(validTargetConfig, { exec: mockExec }),
        (err) => err instanceof DeploymentGuardError && err.message.includes("Git remote does not match Monad deployment target")
      );
    });

    it("fails with warning if actual Git remote points to legacy BNB repo", () => {
      const mockExec = () => "https://github.com/Archzxylabs/Archava.git\n";
      assert.throws(
        () => validateGitRemote(validTargetConfig, { exec: mockExec }),
        (err) => err instanceof DeploymentGuardError && err.details.warning?.includes("BNB production remote")
      );
    });
  });

  describe("Vercel target and linkage validation (vercel / deploy mode)", () => {
    it("fails if expected Vercel projectId is empty in targetConfig", () => {
      const config = {
        ...validTargetConfig,
        hosting: {
          ...validTargetConfig.hosting,
          frontend: { ...validTargetConfig.hosting.frontend, projectId: "" },
        },
      };
      assert.throws(
        () => validateVercelTarget(config),
        (err) => err instanceof DeploymentGuardError && err.message.includes("hosting.frontend.projectId is empty")
      );
    });

    it("fails if expected Vercel projectId points to legacy BNB project", () => {
      const config = {
        ...validTargetConfig,
        hosting: {
          ...validTargetConfig.hosting,
          frontend: { ...validTargetConfig.hosting.frontend, projectId: "archava-onchain" },
        },
      };
      assert.throws(
        () => validateVercelTarget(config),
        (err) => err instanceof DeploymentGuardError && err.message.includes("legacy BNB deployment")
      );
    });

    it("fails if actual .vercel linkage is missing", () => {
      const ws = createTempWorkspace();
      try {
        assert.throws(
          () => validateVercelTarget(validTargetConfig, { cwd: ws.dir, env: {} }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("Vercel linkage not found")
        );
      } finally {
        ws.cleanup();
      }
    });

    it("fails if actual .vercel/project.json has mismatched projectId", () => {
      const ws = createTempWorkspace();
      try {
        mkdirSync(join(ws.dir, ".vercel"));
        writeFileSync(join(ws.dir, ".vercel/project.json"), JSON.stringify({ projectId: "prj_wrong_123" }));
        assert.throws(
          () => validateVercelTarget(validTargetConfig, { cwd: ws.dir, env: {} }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("does not match expected Monad deployment target")
        );
      } finally {
        ws.cleanup();
      }
    });

    it("fails if actual .vercel/project.json points to legacy BNB project", () => {
      const ws = createTempWorkspace();
      try {
        mkdirSync(join(ws.dir, ".vercel"));
        writeFileSync(join(ws.dir, ".vercel/project.json"), JSON.stringify({ projectId: "archava-onchain", projectName: "archava-onchain" }));
        assert.throws(
          () => validateVercelTarget(validTargetConfig, { cwd: ws.dir, env: {} }),
          (err) => err instanceof DeploymentGuardError && err.details.warning?.includes("legacy BNB production project")
        );
      } finally {
        ws.cleanup();
      }
    });

    it("passes when actual .vercel/project.json matches expected projectId", () => {
      const ws = createTempWorkspace();
      try {
        mkdirSync(join(ws.dir, ".vercel"));
        writeFileSync(
          join(ws.dir, ".vercel/project.json"),
          JSON.stringify({ projectId: "prj_monad_frontend_123", orgId: "team_monad" })
        );
        const result = validateVercelTarget(validTargetConfig, { cwd: ws.dir, env: {} });
        assert.equal(result, true);
      } finally {
        ws.cleanup();
      }
    });

    it("passes when VERCEL_PROJECT_ID environment variable matches expected projectId", () => {
      const ws = createTempWorkspace();
      try {
        const result = validateVercelTarget(validTargetConfig, {
          cwd: ws.dir,
          env: { VERCEL_PROJECT_ID: "prj_monad_frontend_123" },
        });
        assert.equal(result, true);
      } finally {
        ws.cleanup();
      }
    });
  });

  describe("Railway target and context validation (railway / deploy mode)", () => {
    it("fails if any expected Railway target ID is empty", () => {
      const config = {
        ...validTargetConfig,
        hosting: {
          ...validTargetConfig.hosting,
          backend: { ...validTargetConfig.hosting.backend, environmentId: "" },
        },
      };
      assert.throws(
        () => validateRailwayTarget(config),
        (err) => err instanceof DeploymentGuardError && err.message.includes("hosting.backend.environmentId is empty")
      );
    });

    it("fails if expected serviceName suggests BNB production", () => {
      const config = {
        ...validTargetConfig,
        hosting: {
          ...validTargetConfig.hosting,
          backend: { ...validTargetConfig.hosting.backend, serviceName: "archava-production" },
        },
      };
      assert.throws(
        () => validateRailwayTarget(config),
        (err) => err instanceof DeploymentGuardError && err.message.includes("suggests BNB production")
      );
    });

    it("fails if actual Railway context is not found", () => {
      const ws = createTempWorkspace();
      try {
        assert.throws(
          () => validateRailwayTarget(validTargetConfig, {
            cwd: ws.dir,
            env: {},
            exec: () => { throw new Error("railway not found"); },
          }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("Railway context not found")
        );
      } finally {
        ws.cleanup();
      }
    });

    it("fails if actual Railway context only contains project ID (environmentId and serviceId missing)", () => {
      const ws = createTempWorkspace();
      try {
        const env = {
          RAILWAY_PROJECT_ID: "railway_proj_monad_456",
        };
        assert.throws(
          () => validateRailwayTarget(validTargetConfig, {
            cwd: ws.dir,
            env,
            exec: () => { throw new Error("not found"); },
          }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("actual environmentId is missing or empty")
        );
      } finally {
        ws.cleanup();
      }
    });

    it("fails if actual Railway context is missing serviceId", () => {
      const ws = createTempWorkspace();
      try {
        const env = {
          RAILWAY_PROJECT_ID: "railway_proj_monad_456",
          RAILWAY_ENVIRONMENT_ID: "env_monad_789",
        };
        assert.throws(
          () => validateRailwayTarget(validTargetConfig, {
            cwd: ws.dir,
            env,
            exec: () => { throw new Error("not found"); },
          }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("actual serviceId is missing or empty")
        );
      } finally {
        ws.cleanup();
      }
    });

    it("fails if actual Railway context has mismatched projectId", () => {
      const ws = createTempWorkspace();
      try {
        const env = {
          RAILWAY_PROJECT_ID: "railway_proj_wrong_999",
          RAILWAY_ENVIRONMENT_ID: "env_monad_789",
          RAILWAY_SERVICE_ID: "srv_monad_012",
        };
        assert.throws(
          () => validateRailwayTarget(validTargetConfig, {
            cwd: ws.dir,
            env,
            exec: () => { throw new Error("not found"); },
          }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("projectId mismatch")
        );
      } finally {
        ws.cleanup();
      }
    });

    it("fails if actual Railway context has mismatched environmentId", () => {
      const ws = createTempWorkspace();
      try {
        const env = {
          RAILWAY_PROJECT_ID: "railway_proj_monad_456",
          RAILWAY_ENVIRONMENT_ID: "env_wrong_999",
          RAILWAY_SERVICE_ID: "srv_monad_012",
        };
        assert.throws(
          () => validateRailwayTarget(validTargetConfig, {
            cwd: ws.dir,
            env,
            exec: () => { throw new Error("not found"); },
          }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("environmentId mismatch")
        );
      } finally {
        ws.cleanup();
      }
    });

    it("fails if actual Railway context has mismatched serviceId", () => {
      const ws = createTempWorkspace();
      try {
        mkdirSync(join(ws.dir, ".railway"));
        writeFileSync(
          join(ws.dir, ".railway/config.json"),
          JSON.stringify({
            project: "railway_proj_monad_456",
            environment: "env_monad_789",
            service: "srv_wrong_999",
          })
        );
        assert.throws(
          () => validateRailwayTarget(validTargetConfig, {
            cwd: ws.dir,
            env: {},
            exec: () => { throw new Error("not found"); },
          }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("serviceId mismatch")
        );
      } finally {
        ws.cleanup();
      }
    });

    it("fails if actual Railway context indicates legacy BNB service", () => {
      const ws = createTempWorkspace();
      try {
        mkdirSync(join(ws.dir, ".railway"));
        writeFileSync(
          join(ws.dir, ".railway/config.json"),
          JSON.stringify({
            project: "railway_proj_monad_456",
            environment: "env_monad_789",
            service: "srv_monad_012",
            serviceName: "archava-production",
          })
        );
        assert.throws(
          () => validateRailwayTarget(validTargetConfig, {
            cwd: ws.dir,
            env: {},
            exec: () => { throw new Error("not found"); },
          }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("legacy BNB service")
        );
      } finally {
        ws.cleanup();
      }
    });

    it("handles workspace map format in .railway/config.json matching cwd and rejects foreign cwd", () => {
      const ws = createTempWorkspace();
      try {
        mkdirSync(join(ws.dir, ".railway"));
        const workspaceConfig = {
          projects: {
            [ws.dir]: {
              project: "railway_proj_monad_456",
              environment: "env_monad_789",
              service: "srv_monad_012",
              serviceName: "archava-monad-backend",
            },
            "/some/other/workspace": {
              project: "other_project",
              environment: "other_env",
              service: "other_srv",
            },
          },
        };
        writeFileSync(join(ws.dir, ".railway/config.json"), JSON.stringify(workspaceConfig));

        // When cwd matches ws.dir, context is resolved and validated
        const result = validateRailwayTarget(validTargetConfig, {
          cwd: ws.dir,
          env: {},
          exec: () => { throw new Error("not found"); },
        });
        assert.equal(result, true);

        // When cwd is a different directory without a mapping in projects, it fails closed
        assert.throws(
          () => validateRailwayTarget(validTargetConfig, {
            cwd: "/some/unregistered/path",
            env: {},
            exec: () => { throw new Error("not found"); },
          }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("Railway context not found")
        );
      } finally {
        ws.cleanup();
      }
    });

    it("rejects before executing deployment command side effect", () => {
      const ws = createTempWorkspace();
      let deploymentSideEffectExecuted = false;
      const mockDeployCommand = () => {
        deploymentSideEffectExecuted = true;
      };

      try {
        // Attempt deployment with incomplete Railway context (project only)
        const env = { RAILWAY_PROJECT_ID: "railway_proj_monad_456" };
        assert.throws(() => {
          validateRailwayTarget(validTargetConfig, {
            cwd: ws.dir,
            env,
            exec: () => { throw new Error("not found"); },
          });
          mockDeployCommand();
        });
        assert.equal(deploymentSideEffectExecuted, false, "Side effect must not execute when guard rejects target");
      } finally {
        ws.cleanup();
      }
    });

    it("passes when actual .railway/config.json matches expected IDs", () => {
      const ws = createTempWorkspace();
      try {
        mkdirSync(join(ws.dir, ".railway"));
        writeFileSync(
          join(ws.dir, ".railway/config.json"),
          JSON.stringify({
            project: "railway_proj_monad_456",
            environment: "env_monad_789",
            service: "srv_monad_012",
            serviceName: "archava-monad-backend",
          })
        );
        const result = validateRailwayTarget(validTargetConfig, {
          cwd: ws.dir,
          env: {},
          exec: () => { throw new Error("not found"); },
        });
        assert.equal(result, true);
      } finally {
        ws.cleanup();
      }
    });

    it("passes when RAILWAY_* environment variables match expected IDs", () => {
      const ws = createTempWorkspace();
      try {
        const env = {
          RAILWAY_PROJECT_ID: "railway_proj_monad_456",
          RAILWAY_ENVIRONMENT_ID: "env_monad_789",
          RAILWAY_SERVICE_ID: "srv_monad_012",
          RAILWAY_SERVICE_NAME: "archava-monad-backend",
        };
        const result = validateRailwayTarget(validTargetConfig, {
          cwd: ws.dir,
          env,
          exec: () => { throw new Error("not found"); },
        });
        assert.equal(result, true);
      } finally {
        ws.cleanup();
      }
    });

    it("passes when railway status --json CLI output matches expected IDs", () => {
      const ws = createTempWorkspace();
      try {
        const cliOutput = JSON.stringify({
          id: "railway_proj_monad_456",
          environment: { id: "env_monad_789" },
          service: { id: "srv_monad_012", name: "archava-monad-backend" },
        });
        const result = validateRailwayTarget(validTargetConfig, {
          cwd: ws.dir,
          env: {},
          exec: () => cliOutput,
        });
        assert.equal(result, true);
      } finally {
        ws.cleanup();
      }
    });
  });

  describe("Deploy mode requires both Vercel and Railway linkage", () => {
    it("fails deploy mode when either hosting target has missing linkage", () => {
      const ws = createTempWorkspace();
      try {
        // Vercel linked but Railway missing
        mkdirSync(join(ws.dir, ".vercel"));
        writeFileSync(
          join(ws.dir, ".vercel/project.json"),
          JSON.stringify({ projectId: "prj_monad_frontend_123" })
        );
        assert.throws(
          () => validateHostingTargets(validTargetConfig, {
            cwd: ws.dir,
            env: {},
            exec: () => { throw new Error("no railway"); },
          }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("Railway context not found")
        );
      } finally {
        ws.cleanup();
      }
    });
  });

  describe("Runtime mode validation", () => {
    it("passes with valid Monad Testnet runtime target", () => {
      const result = validateRuntimeConfig(validTargetConfig, validNetworkConfig);
      assert.equal(result, true);
    });

    it("rejects BNB chain ID 97 in runtime config", () => {
      const config = { ...validTargetConfig, network: { ...validTargetConfig.network, chainId: 97 } };
      assert.throws(
        () => validateRuntimeConfig(config, validNetworkConfig),
        (err) => err instanceof DeploymentGuardError && err.message.includes("does not match Monad Testnet")
      );
    });

    it("rejects agent name without monad in runtime target", () => {
      const config = {
        ...validTargetConfig,
        livekit: { ...validTargetConfig.livekit, agentName: "generic-agent" },
      };
      assert.throws(
        () => validateRuntimeConfig(config, validNetworkConfig),
        (err) => err instanceof DeploymentGuardError && err.message.includes('does not include "monad"')
      );
    });

    it("rejects state directory pointing to BNB", () => {
      const config = {
        ...validTargetConfig,
        state: { directory: "./data-bnb", scope: "bnb-production" },
      };
      assert.throws(
        () => validateRuntimeConfig(config, validNetworkConfig),
        (err) => err instanceof DeploymentGuardError && err.message.includes("points to BNB/BSC")
      );
    });
  });

  describe("Contracts target validation (contracts mode)", () => {
    it("passes with valid Monad Testnet contract target", async () => {
      const ws = createTempWorkspace();
      try {
        mkdirSync(join(ws.dir, "packages/contracts"), { recursive: true });
        writeFileSync(
          join(ws.dir, "packages/contracts/foundry.toml"),
          `[profile.default]\n[rpc_endpoints]\nmonad_testnet = "https://testnet-rpc.monad.xyz"\n`
        );
        const result = await validateContractsTarget(validTargetConfig, validNetworkConfig, { cwd: ws.dir });
        assert.equal(result.valid, true);
      } finally {
        ws.cleanup();
      }
    });

    it("correctly reads networks.monadTestnet.rpcUrls structure", async () => {
      const ws = createTempWorkspace();
      try {
        const networkConfigWithActualRpcUrls = {
          active: "monadTestnet",
          networks: {
            monadTestnet: {
              chainId: 10143,
              name: "Monad Testnet",
              nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
              blockExplorer: { name: "MonadScan", url: "https://testnet.monadscan.com" },
              rpcUrls: {
                default: { http: ["https://testnet-rpc.monad.xyz"] },
                public: { http: ["https://testnet-rpc.monad.xyz"] },
              },
            },
          },
        };
        const result = await validateContractsTarget(validTargetConfig, networkConfigWithActualRpcUrls, { cwd: ws.dir });
        assert.equal(result.valid, true);
      } finally {
        ws.cleanup();
      }
    });

    it("rejects when active network rpcUrls contains BSC endpoint", async () => {
      const ws = createTempWorkspace();
      try {
        const bscRpcNetworkConfig = {
          active: "monadTestnet",
          networks: {
            monadTestnet: {
              ...validNetworkConfig.networks.monadTestnet,
              rpcUrls: {
                default: { http: ["https://data-seed-prebsc-1-s1.binance.org:8545"] },
              },
            },
          },
        };
        await assert.rejects(
          async () => await validateContractsTarget(validTargetConfig, bscRpcNetworkConfig, { cwd: ws.dir }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("points to BNB/BSC RPC endpoint")
        );
      } finally {
        ws.cleanup();
      }
    });

    it("rejects when active network in networkConfig has chainId 97 (reproduction case)", async () => {
      const ws = createTempWorkspace();
      try {
        const bnbNetworkConfig = {
          active: "monadTestnet",
          networks: {
            monadTestnet: {
              ...validNetworkConfig.networks.monadTestnet,
              chainId: 97,
            },
          },
        };
        await assert.rejects(
          async () => await validateContractsTarget(validTargetConfig, bnbNetworkConfig, { cwd: ws.dir }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("chain ID is 97, expected 10143")
        );
      } finally {
        ws.cleanup();
      }
    });

    it("rejects when active network name is not monadTestnet", async () => {
      const ws = createTempWorkspace();
      try {
        const bscNetworkConfig = {
          active: "bscTestnet",
          networks: {
            bscTestnet: {
              chainId: 97,
              name: "BNB Smart Chain Testnet",
            },
          },
        };
        await assert.rejects(
          async () => await validateContractsTarget(validTargetConfig, bscNetworkConfig, { cwd: ws.dir }),
          (err) => err instanceof DeploymentGuardError && err.message.includes('expected "monadTestnet"')
        );
      } finally {
        ws.cleanup();
      }
    });

    it("rejects when targetConfig has wrong chainId", async () => {
      const ws = createTempWorkspace();
      try {
        const wrongTarget = {
          ...validTargetConfig,
          network: { ...validTargetConfig.network, chainId: 97 },
        };
        await assert.rejects(
          async () => await validateContractsTarget(wrongTarget, validNetworkConfig, { cwd: ws.dir }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("Contract target chain ID is 97, expected 10143")
        );
      } finally {
        ws.cleanup();
      }
    });

    it("rejects when CHAIN_ID from env mismatches 10143", async () => {
      const ws = createTempWorkspace();
      try {
        await assert.rejects(
          async () => await validateContractsTarget(validTargetConfig, validNetworkConfig, {
            cwd: ws.dir,
            env: { CHAIN_ID: "97" },
          }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("CHAIN_ID from environment (97) does not match")
        );
      } finally {
        ws.cleanup();
      }
    });

    it("rejects when options.chainId mismatches 10143", async () => {
      const ws = createTempWorkspace();
      try {
        await assert.rejects(
          async () => await validateContractsTarget(validTargetConfig, validNetworkConfig, {
            cwd: ws.dir,
            chainId: 97,
          }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("Operation chain ID (97) does not match")
        );
      } finally {
        ws.cleanup();
      }
    });

    it("rejects when MONAD_TESTNET_RPC_URL points to BSC", async () => {
      const ws = createTempWorkspace();
      try {
        await assert.rejects(
          async () => await validateContractsTarget(validTargetConfig, validNetworkConfig, {
            cwd: ws.dir,
            env: { MONAD_TESTNET_RPC_URL: "https://bsc-dataseed1.binance.org" },
          }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("points to BNB/BSC RPC endpoint")
        );
      } finally {
        ws.cleanup();
      }
    });

    it("rejects when foundry.toml references BSC testnet endpoints directly", async () => {
      const ws = createTempWorkspace();
      try {
        mkdirSync(join(ws.dir, "packages/contracts"), { recursive: true });
        writeFileSync(
          join(ws.dir, "packages/contracts/foundry.toml"),
          `[profile.default]\n[rpc_endpoints]\nbsc_testnet = "https://data-seed-prebsc-1-s1.bnbchain.org:8545"\n`
        );
        await assert.rejects(
          async () => await validateContractsTarget(validTargetConfig, validNetworkConfig, { cwd: ws.dir }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("foundry.toml contains BSC testnet endpoints")
        );
      } finally {
        ws.cleanup();
      }
    });

    it("rejects when foundry.toml resolves env var that points to BSC RPC", async () => {
      const ws = createTempWorkspace();
      try {
        mkdirSync(join(ws.dir, "packages/contracts"), { recursive: true });
        writeFileSync(
          join(ws.dir, "packages/contracts/foundry.toml"),
          `[profile.default]\n[rpc_endpoints]\nmonad_testnet = "\${MONAD_TESTNET_RPC_URL}"\n`
        );
        await assert.rejects(
          async () => await validateContractsTarget(validTargetConfig, validNetworkConfig, {
            cwd: ws.dir,
            env: { MONAD_TESTNET_RPC_URL: "https://data-seed-prebsc-2-s3.binance.org:8545" },
          }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("points to BNB/BSC RPC endpoint")
        );
      } finally {
        ws.cleanup();
      }
    });

    it("passes when foundry.toml resolves valid Monad RPC from environment", async () => {
      const ws = createTempWorkspace();
      try {
        mkdirSync(join(ws.dir, "packages/contracts"), { recursive: true });
        writeFileSync(
          join(ws.dir, "packages/contracts/foundry.toml"),
          `[profile.default]\n[rpc_endpoints]\nmonad_testnet = "\${MONAD_TESTNET_RPC_URL}"\n`
        );
        const result = await validateContractsTarget(validTargetConfig, validNetworkConfig, {
          cwd: ws.dir,
          env: { MONAD_TESTNET_RPC_URL: "https://testnet-rpc.monad.xyz" },
        });
        assert.equal(result.valid, true);
      } finally {
        ws.cleanup();
      }
    });

    it("accepts Monad endpoints with API keys containing '97'", () => {
      assert.equal(isBnbRpc("https://testnet-rpc.monad.xyz?key=user-97-key"), false);
      assert.equal(isBnbRpc("https://monad-rpc.example.com/v1/apikey97"), false);
      assert.equal(isBnbRpc("https://rpc.monad.xyz/api/token97/rpc"), false);
      assert.equal(validateRpcUrl("https://testnet-rpc.monad.xyz?key=mykey97", "Monad RPC"), true);
    });

    it("rejects recognized BNB/BSC RPC endpoints via isBnbRpc", () => {
      assert.equal(isBnbRpc("https://data-seed-prebsc-1-s1.binance.org:8545/"), true);
      assert.equal(isBnbRpc("https://bsc-testnet.public.blastapi.io"), true);
      assert.equal(isBnbRpc("https://rpc.ankr.com/bsc_testnet_chapel"), true);
      assert.equal(isBnbRpc("https://multichain-rpc.io/97"), true);
      assert.equal(isBnbRpc("https://multichain-rpc.io?chainId=97"), true);
    });

    it("masks sensitive query parameters and credentials in maskRpcUrl", () => {
      const masked = maskRpcUrl("https://user:secretpass@rpc.example.com/v1?key=supersecret12345678");
      assert.ok(!masked.includes("secretpass"));
      assert.ok(!masked.includes("supersecret12345678"));
      assert.ok(masked.includes("***"));
    });

    it("resolves single operational RPC via resolveOperationalRpc", () => {
      const rpc1 = resolveOperationalRpc(validTargetConfig, validNetworkConfig, {
        rpcUrl: "https://dedicated-rpc.monad.xyz",
      });
      assert.equal(rpc1, "https://dedicated-rpc.monad.xyz");

      const rpc2 = resolveOperationalRpc(validTargetConfig, validNetworkConfig, {
        env: { MONAD_TESTNET_RPC_URL: "https://env-rpc.monad.xyz" },
      });
      assert.equal(rpc2, "https://env-rpc.monad.xyz");

      const rpc3 = resolveOperationalRpc(validTargetConfig, validNetworkConfig, {});
      assert.equal(rpc3, "https://testnet-rpc.monad.xyz");

      assert.throws(
        () => resolveOperationalRpc(validTargetConfig, validNetworkConfig, { rpcUrl: "https://bsc-dataseed.binance.org" }),
        (err) => err instanceof DeploymentGuardError && err.message.includes("points to BNB/BSC")
      );
    });

    it("verifies online RPC chain ID via async verifyRpcChainId helper with strict validation", async () => {
      // 1. Valid Monad Testnet chain ID 0x279f (10143)
      const mockFetchSuccess = async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x279f" }),
      });
      const chainId = await verifyRpcChainId("https://testnet-rpc.monad.xyz", { fetch: mockFetchSuccess });
      assert.equal(chainId, 10143);

      // 2. Wrong chain ID 0x61 (97 BNB Testnet)
      const mockFetchBnb = async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x61" }),
      });
      await assert.rejects(
        async () => await verifyRpcChainId("https://testnet-rpc.monad.xyz", { fetch: mockFetchBnb }),
        (err) => err instanceof DeploymentGuardError && err.message.includes("expected Monad Testnet (10143)")
      );

      // 3. JSON-RPC error response
      const mockFetchRpcError = async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Node internal error" } }),
      });
      await assert.rejects(
        async () => await verifyRpcChainId("https://testnet-rpc.monad.xyz", { fetch: mockFetchRpcError }),
        (err) => err instanceof DeploymentGuardError && err.message.includes("Node internal error")
      );

      // 4. HTTP non-200 error
      const mockFetchHttpError = async () => ({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
      });
      await assert.rejects(
        async () => await verifyRpcChainId("https://testnet-rpc.monad.xyz", { fetch: mockFetchHttpError }),
        (err) => err instanceof DeploymentGuardError && err.message.includes("HTTP 502")
      );

      // 5. Malformed result (not hex)
      const mockFetchMalformed = async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ jsonrpc: "2.0", id: 1, result: "not-hex" }),
      });
      await assert.rejects(
        async () => await verifyRpcChainId("https://testnet-rpc.monad.xyz", { fetch: mockFetchMalformed }),
        (err) => err instanceof DeploymentGuardError && err.message.includes("malformed result")
      );

      // 6. Network timeout / abort
      const mockFetchTimeout = async () => {
        const err = new Error("The operation was aborted");
        err.name = "TimeoutError";
        throw err;
      };
      await assert.rejects(
        async () => await verifyRpcChainId("https://testnet-rpc.monad.xyz?key=supersecret123", { fetch: mockFetchTimeout }),
        (err) => {
          assert.ok(err instanceof DeploymentGuardError);
          assert.ok(err.message.includes("timed out"));
          // Assert that secret was not leaked
          assert.ok(!err.message.includes("supersecret123"));
          return true;
        }
      );
    });
  });

  describe("Local mode validation", () => {
    it("passes with valid local configuration and reports warnings", async () => {
      const ws = createTempWorkspace();
      try {
        writeFileSync(join(ws.dir, "config/deployment-targets.monad.json"), JSON.stringify(validTargetConfig));
        writeFileSync(join(ws.dir, "config/networks.json"), JSON.stringify(validNetworkConfig));
        const result = await verifyDeploymentTarget("local", { cwd: ws.dir, env: {} });
        assert.equal(result.valid, true);
        assert.ok(Array.isArray(result.warnings));
      } finally {
        ws.cleanup();
      }
    });

    it("rejects local mode when active network has chainId 97 (reproduction case)", () => {
      const ws = createTempWorkspace();
      try {
        const bnbNetworkConfig = {
          active: "monadTestnet",
          networks: {
            monadTestnet: {
              ...validNetworkConfig.networks.monadTestnet,
              chainId: 97,
            },
          },
        };
        assert.throws(
          () => validateLocalMode(validTargetConfig, bnbNetworkConfig, { cwd: ws.dir, env: {} }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("chain ID is 97, expected 10143")
        );
      } finally {
        ws.cleanup();
      }
    });

    it("rejects local mode when active network is not monadTestnet", () => {
      const ws = createTempWorkspace();
      try {
        const bscNetworkConfig = {
          active: "bscTestnet",
          networks: {
            bscTestnet: {
              chainId: 97,
            },
          },
        };
        assert.throws(
          () => validateLocalMode(validTargetConfig, bscNetworkConfig, { cwd: ws.dir, env: {} }),
          (err) => err instanceof DeploymentGuardError && err.message.includes('expected "monadTestnet"')
        );
      } finally {
        ws.cleanup();
      }
    });

    it("rejects local mode when CHAIN_ID env is 97", () => {
      const ws = createTempWorkspace();
      try {
        assert.throws(
          () => validateLocalMode(validTargetConfig, validNetworkConfig, { cwd: ws.dir, env: { CHAIN_ID: "97" } }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("CHAIN_ID from environment")
        );
      } finally {
        ws.cleanup();
      }
    });

    it("rejects local mode when RPC_URL points to BSC", () => {
      const ws = createTempWorkspace();
      try {
        assert.throws(
          () => validateLocalMode(validTargetConfig, validNetworkConfig, {
            cwd: ws.dir,
            env: { RPC_URL: "https://bsc-dataseed.binance.org" },
          }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("points to BNB/BSC RPC endpoint")
        );
      } finally {
        ws.cleanup();
      }
    });

    it("rejects if local .vercel linkage points to legacy BNB project", () => {
      const ws = createTempWorkspace();
      try {
        mkdirSync(join(ws.dir, ".vercel"));
        writeFileSync(join(ws.dir, ".vercel/project.json"), JSON.stringify({ projectId: "archava-onchain" }));
        assert.throws(
          () => validateLocalMode(validTargetConfig, validNetworkConfig, { cwd: ws.dir, env: {} }),
          (err) => err instanceof DeploymentGuardError && err.message.includes("Local .vercel linkage points to BNB")
        );
      } finally {
        ws.cleanup();
      }
    });
  });

  describe("CLI integration", () => {
    it("passes CLI local mode against workspace config", () => {
      const output = execSync(`node ${GUARD_SCRIPT} local`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      assert.ok(output.includes("LOCAL validation passed"));
    });

    it("rejects invalid mode from CLI", () => {
      try {
        execSync(`node ${GUARD_SCRIPT} invalid_mode`, {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        assert.fail("Should have exited with non-zero code");
      } catch (error) {
        assert.ok(error.stderr.includes("Invalid mode: invalid_mode"));
      }
    });
  });
});
