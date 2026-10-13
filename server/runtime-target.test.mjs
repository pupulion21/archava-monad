/**
 * Tests for runtime target validation and startup lock.
 * 
 * These tests verify that the API correctly rejects wrong configuration
 * before creating provider clients or background jobs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateRuntimeStartup, isRuntimeEnabled, RuntimeValidationError } from "./runtime-target.mjs";

const validDeploymentTargetsFixture = {
  version: "1",
  deployment: "monad",
  network: {
    chainId: 10143,
    name: "monadTestnet",
    rpc: { public: "https://testnet-rpc.monad.xyz" }
  },
  hosting: {
    frontend: { provider: "vercel", projectId: "prj_monad_test" },
    backend: { provider: "railway", projectId: "p1", environmentId: "e1", serviceId: "s1", serviceName: "archava-monad-backend" }
  },
  livekit: {
    url: "wss://archava-monad.livekit.cloud",
    projectScope: "archava-monad",
    agentName: "archava-monad-host"
  },
  state: {
    directory: "./data",
    scope: "monad"
  }
};

const validNetworkConfigFixture = {
  active: "monadTestnet",
  networks: {
    monadTestnet: {
      chainId: 10143,
      name: "Monad Testnet",
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      blockExplorer: { name: "MonadScan", url: "https://testnet.monadscan.com" }
    }
  }
};

describe("Runtime Target Validation", () => {
  
  describe("isRuntimeEnabled", () => {
    it("returns true when ARCHAVA_RUNTIME_ENABLED=true", () => {
      const env = { ARCHAVA_RUNTIME_ENABLED: "true" };
      assert.equal(isRuntimeEnabled(env), true);
    });
    
    it("returns false when ARCHAVA_RUNTIME_ENABLED is not set", () => {
      const env = {};
      assert.equal(isRuntimeEnabled(env), false);
    });
    
    it("returns false when ARCHAVA_RUNTIME_ENABLED=false", () => {
      const env = { ARCHAVA_RUNTIME_ENABLED: "false" };
      assert.equal(isRuntimeEnabled(env), false);
    });
    
    it("returns false for any value other than 'true'", () => {
      const env = { ARCHAVA_RUNTIME_ENABLED: "yes" };
      assert.equal(isRuntimeEnabled(env), false);
    });
  });
  
  describe("validateRuntimeStartup - startup lock", () => {
    it("throws when runtime is not enabled", () => {
      const env = {
        ARCHAVA_RUNTIME_ENABLED: "false",
        CHAIN_ID: "10143",
        RPC_URL: "https://testnet-rpc.monad.xyz"
      };
      
      assert.throws(
        () => validateRuntimeStartup(env, { deploymentTargets: validDeploymentTargetsFixture }),
        {
          name: "RuntimeValidationError",
          message: /Runtime startup is locked/
        }
      );
    });
    
    it("throws when runtime enabled is missing", () => {
      const env = {
        CHAIN_ID: "10143",
        RPC_URL: "https://testnet-rpc.monad.xyz"
      };
      
      assert.throws(
        () => validateRuntimeStartup(env, { deploymentTargets: validDeploymentTargetsFixture }),
        {
          name: "RuntimeValidationError",
          message: /Runtime startup is locked/
        }
      );
    });
  });
  
  describe("validateRuntimeStartup - BNB chain rejection", () => {
    it("rejects BNB Testnet chain ID 97", () => {
      const env = {
        ARCHAVA_RUNTIME_ENABLED: "true",
        CHAIN_ID: "97",
        RPC_URL: "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
        LIVEKIT_URL: "wss://archava-monad.livekit.cloud",
        ARCHAVA_AGENT_NAME: "archava-monad-host"
      };
      
      assert.throws(
        () => validateRuntimeStartup(env, { deploymentTargets: validDeploymentTargetsFixture }),
        {
          name: "RuntimeValidationError",
          message: /CHAIN_ID is 97.*BNB Testnet/
        }
      );
    });
    
    it("rejects BNB RPC URL patterns", () => {
      const env = {
        ARCHAVA_RUNTIME_ENABLED: "true",
        CHAIN_ID: "10143",
        RPC_URL: "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
        LIVEKIT_URL: "wss://archava-monad.livekit.cloud",
        ARCHAVA_AGENT_NAME: "archava-monad-host"
      };
      
      assert.throws(
        () => validateRuntimeStartup(env, { deploymentTargets: validDeploymentTargetsFixture }),
        {
          name: "RuntimeValidationError",
          message: /RPC_URL appears to point to BNB/
        }
      );
    });
    
    it("rejects known BNB rental contract address", () => {
      const env = {
        ARCHAVA_RUNTIME_ENABLED: "true",
        CHAIN_ID: "10143",
        RPC_URL: "https://testnet-rpc.monad.xyz",
        LIVEKIT_URL: "wss://archava-monad.livekit.cloud",
        ARCHAVA_AGENT_NAME: "archava-monad-host",
        RENTAL_CONTRACT: "0xefaacd259136d40cd26a8672697b591c1f84200c"
      };
      
      assert.throws(
        () => validateRuntimeStartup(env, { deploymentTargets: validDeploymentTargetsFixture }),
        {
          name: "RuntimeValidationError",
          message: /RENTAL_CONTRACT is set to BNB Testnet address/
        }
      );
    });
    
    it("rejects known BNB token contract address", () => {
      const env = {
        ARCHAVA_RUNTIME_ENABLED: "true",
        CHAIN_ID: "10143",
        RPC_URL: "https://testnet-rpc.monad.xyz",
        LIVEKIT_URL: "wss://archava-monad.livekit.cloud",
        ARCHAVA_AGENT_NAME: "archava-monad-host",
        RENTAL_CONTRACT: "0x1234567890123456789012345678901234567890",
        PAYMENT_TOKEN_CONTRACT: "0xd63574ac426169cda5495e1e196bf64d124267d0"
      };
      
      assert.throws(
        () => validateRuntimeStartup(env, { deploymentTargets: validDeploymentTargetsFixture }),
        {
          name: "RuntimeValidationError",
          message: /PAYMENT_TOKEN_CONTRACT is set to BNB Testnet address/
        }
      );
    });
  });
  
  describe("validateRuntimeStartup - missing configuration", () => {
    it("rejects when CHAIN_ID is not set", () => {
      const env = {
        ARCHAVA_RUNTIME_ENABLED: "true",
        RPC_URL: "https://testnet-rpc.monad.xyz",
        LIVEKIT_URL: "wss://archava-monad.livekit.cloud",
        ARCHAVA_AGENT_NAME: "archava-monad-host"
      };
      
      assert.throws(
        () => validateRuntimeStartup(env, { deploymentTargets: validDeploymentTargetsFixture }),
        {
          name: "RuntimeValidationError",
          message: /CHAIN_ID environment variable not set/
        }
      );
    });
    
    it("rejects when RPC_URL is not set", () => {
      const env = {
        ARCHAVA_RUNTIME_ENABLED: "true",
        CHAIN_ID: "10143",
        LIVEKIT_URL: "wss://archava-monad.livekit.cloud",
        ARCHAVA_AGENT_NAME: "archava-monad-host"
      };
      
      assert.throws(
        () => validateRuntimeStartup(env, { deploymentTargets: validDeploymentTargetsFixture }),
        {
          name: "RuntimeValidationError",
          message: /RPC_URL environment variable not set/
        }
      );
    });
    
    it("rejects when LIVEKIT_URL is not set", () => {
      const env = {
        ARCHAVA_RUNTIME_ENABLED: "true",
        CHAIN_ID: "10143",
        RPC_URL: "https://testnet-rpc.monad.xyz",
        ARCHAVA_AGENT_NAME: "archava-monad-host"
      };
      
      assert.throws(
        () => validateRuntimeStartup(env, { deploymentTargets: validDeploymentTargetsFixture }),
        {
          name: "RuntimeValidationError",
          message: /LIVEKIT_URL environment variable not set/
        }
      );
    });
  });
  
  describe("validateRuntimeStartup - valid Monad configuration", () => {
    it("passes with valid Monad Testnet configuration", () => {
      const env = {
        ARCHAVA_RUNTIME_ENABLED: "true",
        CHAIN_ID: "10143",
        RPC_URL: "https://provider.example.com/monad",
        LIVEKIT_URL: "wss://archava-monad.livekit.cloud",
        ARCHAVA_AGENT_NAME: "archava-monad-host",
        RENTAL_CONTRACT: "0x0000000000000000000000000000000000000001",
        PAYMENT_TOKEN_CONTRACT: "0x0000000000000000000000000000000000000002",
        ARCHAVA_STATE_DIR: "./data"
      };
      
      const result = validateRuntimeStartup(env, {
        deploymentTargets: validDeploymentTargetsFixture,
        networkConfig: validNetworkConfigFixture
      });
      
      assert.equal(result.valid, true);
      assert.equal(result.deployment, "monad");
      assert.equal(result.network, "monadTestnet");
      assert.equal(result.chainId, 10143);
      assert.equal(result.deploymentId, "archava-monad");
      assert.equal(result.agentName, "archava-monad-host");
    });
    
    it("warns when using public RPC", () => {
      const env = {
        ARCHAVA_RUNTIME_ENABLED: "true",
        CHAIN_ID: "10143",
        RPC_URL: "https://testnet-rpc.monad.xyz",
        LIVEKIT_URL: "wss://archava-monad.livekit.cloud",
        ARCHAVA_AGENT_NAME: "archava-monad-host"
      };
      
      const result = validateRuntimeStartup(env, {
        deploymentTargets: validDeploymentTargetsFixture,
        networkConfig: validNetworkConfigFixture
      });
      
      assert.equal(result.valid, true);
      assert.ok(result.warnings);
      assert.ok(result.warnings.some(w => w.includes("public Monad RPC")));
    });
    
    it("rejects when agent name differs from target", () => {
      const env = {
        ARCHAVA_RUNTIME_ENABLED: "true",
        CHAIN_ID: "10143",
        RPC_URL: "https://provider.example.com/monad",
        LIVEKIT_URL: "wss://archava-monad.livekit.cloud",
        ARCHAVA_AGENT_NAME: "different-agent"
      };
      
      assert.throws(
        () => validateRuntimeStartup(env, {
          deploymentTargets: validDeploymentTargetsFixture,
          networkConfig: validNetworkConfigFixture
        }),
        {
          name: "RuntimeValidationError",
          message: /ARCHAVA_AGENT_NAME.*does not match deployment target/
        }
      );
    });
  });
  
  describe("validateRuntimeStartup - state directory validation", () => {
    it("rejects state directory with BNB in path", () => {
      const env = {
        ARCHAVA_RUNTIME_ENABLED: "true",
        CHAIN_ID: "10143",
        RPC_URL: "https://testnet-rpc.monad.xyz",
        LIVEKIT_URL: "wss://archava-monad.livekit.cloud",
        ARCHAVA_AGENT_NAME: "archava-monad-host",
        ARCHAVA_STATE_DIR: "./data-bnb"
      };
      
      assert.throws(
        () => validateRuntimeStartup(env, { deploymentTargets: validDeploymentTargetsFixture }),
        {
          name: "RuntimeValidationError",
          message: /ARCHAVA_STATE_DIR.*appears to point to BNB state/
        }
      );
    });
    
    it("rejects state directory with BSC in path", () => {
      const env = {
        ARCHAVA_RUNTIME_ENABLED: "true",
        CHAIN_ID: "10143",
        RPC_URL: "https://testnet-rpc.monad.xyz",
        LIVEKIT_URL: "wss://archava-monad.livekit.cloud",
        ARCHAVA_AGENT_NAME: "archava-monad-host",
        ARCHAVA_STATE_DIR: "./bsc-data"
      };
      
      assert.throws(
        () => validateRuntimeStartup(env, { deploymentTargets: validDeploymentTargetsFixture }),
        {
          name: "RuntimeValidationError",
          message: /ARCHAVA_STATE_DIR.*appears to point to BNB state/
        }
      );
    });
  });
  
  describe("validateRuntimeStartup - config mismatch", () => {
    it("rejects when deployment target config has wrong deployment", () => {
      const env = {
        ARCHAVA_RUNTIME_ENABLED: "true",
        CHAIN_ID: "10143",
        RPC_URL: "https://testnet-rpc.monad.xyz",
        LIVEKIT_URL: "wss://archava-monad.livekit.cloud",
        ARCHAVA_AGENT_NAME: "archava-monad-host"
      };

      const wrongDeploymentFixture = {
        ...validDeploymentTargetsFixture,
        deployment: "bnb"
      };

      assert.throws(
        () => validateRuntimeStartup(env, { deploymentTargets: wrongDeploymentFixture }),
        {
          name: "RuntimeValidationError",
          message: /Deployment target is "bnb", expected "monad"/
        }
      );
    });
    
    it("rejects when network config has wrong active network", () => {
      const env = {
        ARCHAVA_RUNTIME_ENABLED: "true",
        CHAIN_ID: "10143",
        RPC_URL: "https://testnet-rpc.monad.xyz",
        LIVEKIT_URL: "wss://archava-monad.livekit.cloud",
        ARCHAVA_AGENT_NAME: "archava-monad-host"
      };

      const wrongNetworkFixture = {
        ...validNetworkConfigFixture,
        active: "bscTestnet"
      };

      assert.throws(
        () => validateRuntimeStartup(env, {
          deploymentTargets: validDeploymentTargetsFixture,
          networkConfig: wrongNetworkFixture
        }),
        {
          name: "RuntimeValidationError",
          message: /Active network is "bscTestnet", expected "monadTestnet"/
        }
      );
    });
  });
});
