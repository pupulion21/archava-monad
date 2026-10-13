"""Tests for runtime target validation, room scoping, and startup lock for Python worker.

Aligned with the project's standard unittest test runner (scripts/test-backend.mjs).
"""

import os
import json
import unittest
from unittest.mock import Mock, AsyncMock, patch

from runtime_target import (
    RuntimeValidationError,
    validate_runtime_startup,
    is_runtime_enabled,
    validate_environment_config,
)
from agent import validate_room_scope, extract_room_metadata, entrypoint, create_entrypoint

valid_targets_fixture = {
    "version": "1",
    "deployment": "monad",
    "network": {
        "chainId": 10143,
        "name": "monadTestnet",
        "rpc": {"public": "https://testnet-rpc.monad.xyz"}
    },
    "hosting": {
        "frontend": {"provider": "vercel", "projectId": "prj_test"},
        "backend": {
            "provider": "railway",
            "projectId": "p1",
            "environmentId": "e1",
            "serviceId": "s1",
            "serviceName": "archava-monad-backend"
        }
    },
    "livekit": {
        "url": "wss://archava-monad.livekit.cloud",
        "projectScope": "archava-monad",
        "agentName": "archava-monad-host"
    },
    "state": {
        "directory": "./data",
        "scope": "monad"
    }
}

valid_network_fixture = {
    "active": "monadTestnet",
    "networks": {
        "monadTestnet": {
            "chainId": 10143,
            "name": "Monad Testnet",
            "nativeCurrency": {"name": "MON", "symbol": "MON", "decimals": 18},
            "blockExplorer": {"name": "MonadScan", "url": "https://testnet.monadscan.com"}
        }
    }
}


class TestIsRuntimeEnabled(unittest.TestCase):
    def test_returns_true_when_enabled(self):
        env = {"ARCHAVA_RUNTIME_ENABLED": "true"}
        self.assertTrue(is_runtime_enabled(env))

    def test_returns_false_when_not_set(self):
        env = {}
        self.assertFalse(is_runtime_enabled(env))

    def test_returns_false_when_disabled(self):
        env = {"ARCHAVA_RUNTIME_ENABLED": "false"}
        self.assertFalse(is_runtime_enabled(env))

    def test_returns_false_for_other_values(self):
        env = {"ARCHAVA_RUNTIME_ENABLED": "yes"}
        self.assertFalse(is_runtime_enabled(env))


class TestValidateRuntimeStartup(unittest.TestCase):
    def test_throws_when_runtime_not_enabled(self):
        env = {
            "ARCHAVA_RUNTIME_ENABLED": "false",
            "CHAIN_ID": "10143",
            "LIVEKIT_URL": "wss://archava-monad.livekit.cloud"
        }
        with self.assertRaises(RuntimeValidationError) as ctx:
            validate_runtime_startup(env, options={"deployment_targets": valid_targets_fixture, "network_config": valid_network_fixture})
        self.assertIn("Runtime startup is locked", str(ctx.exception))

    def test_throws_when_runtime_enabled_missing(self):
        env = {
            "CHAIN_ID": "10143",
            "LIVEKIT_URL": "wss://archava-monad.livekit.cloud"
        }
        with self.assertRaises(RuntimeValidationError) as ctx:
            validate_runtime_startup(env, options={"deployment_targets": valid_targets_fixture, "network_config": valid_network_fixture})
        self.assertIn("Runtime startup is locked", str(ctx.exception))


class TestBNBChainRejection(unittest.TestCase):
    def test_rejects_bnb_chain_id_97(self):
        env = {
            "ARCHAVA_RUNTIME_ENABLED": "true",
            "CHAIN_ID": "97",
            "LIVEKIT_URL": "wss://archava-monad.livekit.cloud",
            "ARCHAVA_AGENT_NAME": "archava-monad-host",
            "GEMINI_API_KEY": "test-key"
        }
        with self.assertRaises(RuntimeValidationError) as ctx:
            validate_runtime_startup(env, options={"deployment_targets": valid_targets_fixture, "network_config": valid_network_fixture})
        err = str(ctx.exception)
        self.assertIn("CHAIN_ID is 97", err)
        self.assertIn("BNB Testnet", err)

    def test_rejects_wrong_chain_id(self):
        env = {
            "ARCHAVA_RUNTIME_ENABLED": "true",
            "CHAIN_ID": "1",
            "LIVEKIT_URL": "wss://archava-monad.livekit.cloud",
            "ARCHAVA_AGENT_NAME": "archava-monad-host",
            "GEMINI_API_KEY": "test-key"
        }
        with self.assertRaises(RuntimeValidationError) as ctx:
            validate_runtime_startup(env, options={"deployment_targets": valid_targets_fixture, "network_config": valid_network_fixture})
        self.assertIn("CHAIN_ID is 1", str(ctx.exception))


class TestMissingConfiguration(unittest.TestCase):
    def test_rejects_when_chain_id_not_set(self):
        env = {
            "ARCHAVA_RUNTIME_ENABLED": "true",
            "LIVEKIT_URL": "wss://archava-monad.livekit.cloud",
            "ARCHAVA_AGENT_NAME": "archava-monad-host",
            "GEMINI_API_KEY": "test-key"
        }
        with self.assertRaises(RuntimeValidationError) as ctx:
            validate_runtime_startup(env, options={"deployment_targets": valid_targets_fixture, "network_config": valid_network_fixture})
        self.assertIn("CHAIN_ID environment variable not set", str(ctx.exception))

    def test_rejects_when_livekit_url_not_set(self):
        env = {
            "ARCHAVA_RUNTIME_ENABLED": "true",
            "CHAIN_ID": "10143",
            "ARCHAVA_AGENT_NAME": "archava-monad-host",
            "GEMINI_API_KEY": "test-key"
        }
        with self.assertRaises(RuntimeValidationError) as ctx:
            validate_runtime_startup(env, options={"deployment_targets": valid_targets_fixture, "network_config": valid_network_fixture})
        self.assertIn("LIVEKIT_URL environment variable not set", str(ctx.exception))

    def test_rejects_when_gemini_key_not_set(self):
        env = {
            "ARCHAVA_RUNTIME_ENABLED": "true",
            "CHAIN_ID": "10143",
            "LIVEKIT_URL": "wss://archava-monad.livekit.cloud",
            "ARCHAVA_AGENT_NAME": "archava-monad-host"
        }
        with self.assertRaises(RuntimeValidationError) as ctx:
            validate_runtime_startup(env, options={"deployment_targets": valid_targets_fixture, "network_config": valid_network_fixture})
        self.assertIn("GEMINI_API_KEY environment variable not set", str(ctx.exception))


class TestAvatarProviderValidation(unittest.TestCase):
    def test_rejects_invalid_avatar_provider(self):
        env = {
            "ARCHAVA_RUNTIME_ENABLED": "true",
            "CHAIN_ID": "10143",
            "LIVEKIT_URL": "wss://archava-monad.livekit.cloud",
            "ARCHAVA_AGENT_NAME": "archava-monad-host",
            "GEMINI_API_KEY": "test-key",
            "AVATAR_PROVIDER": "invalid"
        }
        with self.assertRaises(RuntimeValidationError) as ctx:
            validate_runtime_startup(env, options={"deployment_targets": valid_targets_fixture, "network_config": valid_network_fixture})
        self.assertIn('AVATAR_PROVIDER is "invalid"', str(ctx.exception))

    def test_rejects_spatius_without_credentials(self):
        env = {
            "ARCHAVA_RUNTIME_ENABLED": "true",
            "CHAIN_ID": "10143",
            "LIVEKIT_URL": "wss://archava-monad.livekit.cloud",
            "ARCHAVA_AGENT_NAME": "archava-monad-host",
            "GEMINI_API_KEY": "test-key",
            "AVATAR_PROVIDER": "spatius"
        }
        with self.assertRaises(RuntimeValidationError) as ctx:
            validate_runtime_startup(env, options={"deployment_targets": valid_targets_fixture, "network_config": valid_network_fixture})
        err = str(ctx.exception)
        self.assertTrue("SPATIUS_API_KEY" in err or "SPATIUS_APP_ID" in err)


class TestAgentNameAndScopeValidation(unittest.TestCase):
    def test_rejects_agent_name_mismatch(self):
        env = {
            "ARCHAVA_RUNTIME_ENABLED": "true",
            "CHAIN_ID": "10143",
            "LIVEKIT_URL": "wss://archava-monad.livekit.cloud",
            "GEMINI_API_KEY": "test-key",
            "AVATAR_PROVIDER": "tavus",
            "ARCHAVA_AGENT_NAME": "wrong-agent-name"
        }
        with self.assertRaises(RuntimeValidationError) as ctx:
            validate_runtime_startup(env, options={"deployment_targets": valid_targets_fixture, "network_config": valid_network_fixture})
        self.assertIn("ARCHAVA_AGENT_NAME", str(ctx.exception))

    def test_rejects_missing_project_scope(self):
        no_scope_target = {
            **valid_targets_fixture,
            "livekit": {**valid_targets_fixture["livekit"], "projectScope": ""}
        }
        env = {
            "ARCHAVA_RUNTIME_ENABLED": "true",
            "CHAIN_ID": "10143",
            "LIVEKIT_URL": "wss://archava-monad.livekit.cloud",
            "ARCHAVA_AGENT_NAME": "archava-monad-host",
            "GEMINI_API_KEY": "test-key",
        }
        with self.assertRaises(RuntimeValidationError) as ctx:
            validate_runtime_startup(env, options={"deployment_targets": no_scope_target, "network_config": valid_network_fixture})
        self.assertIn("projectScope", str(ctx.exception))


class TestValidMonadConfiguration(unittest.TestCase):
    def test_passes_with_valid_monad_config(self):
        env = {
            "ARCHAVA_RUNTIME_ENABLED": "true",
            "CHAIN_ID": "10143",
            "LIVEKIT_URL": "wss://archava-monad.livekit.cloud",
            "GEMINI_API_KEY": "test-key",
            "AVATAR_PROVIDER": "spatius",
            "SPATIUS_API_KEY": "test-key",
            "SPATIUS_APP_ID": "test-app",
            "SPATIUS_AVATAR_ID": "test-avatar",
            "ARCHAVA_AGENT_NAME": "archava-monad-host"
        }
        result = validate_runtime_startup(env, options={"deployment_targets": valid_targets_fixture, "network_config": valid_network_fixture})
        self.assertTrue(result["valid"])
        self.assertEqual(result["deployment"], "monad")
        self.assertEqual(result["network"], "monadTestnet")
        self.assertEqual(result["chainId"], 10143)
        self.assertEqual(result["agentName"], "archava-monad-host")
        self.assertEqual(result["deploymentId"], "archava-monad")

    def test_passes_with_tavus_provider(self):
        env = {
            "ARCHAVA_RUNTIME_ENABLED": "true",
            "CHAIN_ID": "10143",
            "LIVEKIT_URL": "wss://archava-monad.livekit.cloud",
            "GEMINI_API_KEY": "test-key",
            "AVATAR_PROVIDER": "tavus",
            "ARCHAVA_AGENT_NAME": "archava-monad-host"
        }
        result = validate_runtime_startup(env, options={"deployment_targets": valid_targets_fixture, "network_config": valid_network_fixture})
        self.assertTrue(result["valid"])


class TestRoomScopeIsolation(unittest.TestCase):
    def test_valid_room_scope_accepted(self):
        ctx = Mock()
        ctx.room.metadata = json.dumps({"product": "archava", "deploymentId": "archava-monad"})
        self.assertTrue(validate_room_scope(ctx, "archava-monad"))

    def test_missing_deployment_id_rejected(self):
        ctx = Mock()
        ctx.room.metadata = json.dumps({"product": "archava"})
        self.assertFalse(validate_room_scope(ctx, "archava-monad"))

    def test_foreign_deployment_id_rejected(self):
        ctx = Mock()
        ctx.room.metadata = json.dumps({"product": "archava", "deploymentId": "foreign-deployment"})
        self.assertFalse(validate_room_scope(ctx, "archava-monad"))

    def test_legacy_bnb_scope_rejected(self):
        ctx = Mock()
        ctx.room.metadata = json.dumps({"product": "archava", "deploymentId": "archava-bnb"})
        self.assertFalse(validate_room_scope(ctx, "archava-monad"))

    def test_non_archava_product_rejected(self):
        ctx = Mock()
        ctx.room.metadata = json.dumps({"product": "other-app", "deploymentId": "archava-monad"})
        self.assertFalse(validate_room_scope(ctx, "archava-monad"))

    def test_unparseable_metadata_rejected(self):
        ctx = Mock()
        ctx.room.metadata = "not-json"
        self.assertFalse(validate_room_scope(ctx, "archava-monad"))


class TestWorkerEntrypointScope(unittest.IsolatedAsyncioTestCase):
    async def test_entrypoint_rejects_missing_expected_scope_when_env_unset(self):
        """Worker rejects room immediately if no deployment scope is configured in environment or arguments."""
        with patch.dict(os.environ, {}, clear=True):
            ctx = Mock()
            ctx.connect = AsyncMock()
            ctx.room = Mock()
            ctx.room.metadata = json.dumps({"product": "archava", "deploymentId": "archava-monad"})

            await entrypoint(ctx)
            ctx.connect.assert_not_called()

    async def test_entrypoint_rejects_empty_or_whitespace_expected_scope(self):
        """Worker rejects room when expected scope is empty or whitespace-only."""
        ctx = Mock()
        ctx.connect = AsyncMock()
        ctx.room = Mock()
        ctx.room.metadata = json.dumps({"product": "archava", "deploymentId": "archava-monad"})

        await entrypoint(ctx, expected_scope="")
        ctx.connect.assert_not_called()

        await entrypoint(ctx, expected_scope="   \t\n")
        ctx.connect.assert_not_called()

    async def test_entrypoint_rejects_non_string_expected_scope(self):
        """Worker rejects room when expected scope is not a string."""
        ctx = Mock()
        ctx.connect = AsyncMock()
        ctx.room = Mock()
        ctx.room.metadata = json.dumps({"product": "archava", "deploymentId": "archava-monad"})

        await entrypoint(ctx, expected_scope=123)  # type: ignore
        ctx.connect.assert_not_called()

    async def test_entrypoint_reproduction_unvalidated_scope_with_archava_monad_room_is_rejected(self):
        """REPRODUCTION: Scope fallback previously allowed unvalidated jobs to connect.
        
        Previous bug: `expected_scope = os.getenv("ARCHAVA_DEPLOYMENT_ID") or "archava-monad"`
        When ARCHAVA_DEPLOYMENT_ID was missing from env, room labeled "archava-monad" reached ctx.connect().
        Now: without validated scope, it MUST reject before connect.
        """
        with patch.dict(os.environ, {}, clear=True):
            ctx = Mock()
            ctx.connect = AsyncMock()
            ctx.room = Mock()
            ctx.room.metadata = json.dumps({"product": "archava", "deploymentId": "archava-monad"})

            await entrypoint(ctx)
            ctx.connect.assert_not_called()

    async def test_entrypoint_rejects_missing_room_scope(self):
        """Worker rejects room when room metadata does not contain deploymentId."""
        ctx = Mock()
        ctx.connect = AsyncMock()
        ctx.room = Mock()
        ctx.room.metadata = json.dumps({"product": "archava"})

        await entrypoint(ctx, expected_scope="archava-monad")
        ctx.connect.assert_not_called()

    async def test_entrypoint_rejects_empty_or_whitespace_room_scope(self):
        """Worker rejects room when room deploymentId is empty or whitespace."""
        ctx = Mock()
        ctx.connect = AsyncMock()
        ctx.room = Mock()
        ctx.room.metadata = json.dumps({"product": "archava", "deploymentId": "   "})

        await entrypoint(ctx, expected_scope="archava-monad")
        ctx.connect.assert_not_called()

    async def test_entrypoint_rejects_foreign_room_scope(self):
        """Worker rejects room with mismatched deploymentId."""
        ctx = Mock()
        ctx.connect = AsyncMock()
        ctx.room = Mock()
        ctx.room.metadata = json.dumps({"product": "archava", "deploymentId": "foreign-cluster"})

        await entrypoint(ctx, expected_scope="archava-monad")
        ctx.connect.assert_not_called()

    async def test_entrypoint_rejects_legacy_bnb_room_scope(self):
        """Worker rejects room with legacy BNB deploymentId."""
        ctx = Mock()
        ctx.connect = AsyncMock()
        ctx.room = Mock()
        ctx.room.metadata = json.dumps({"product": "archava", "deploymentId": "archava-bnb"})

        await entrypoint(ctx, expected_scope="archava-monad")
        ctx.connect.assert_not_called()

    async def test_entrypoint_rejects_non_archava_product(self):
        """Worker rejects room with non-archava product in metadata."""
        ctx = Mock()
        ctx.connect = AsyncMock()
        ctx.room = Mock()
        ctx.room.metadata = json.dumps({"product": "other-product", "deploymentId": "archava-monad"})

        await entrypoint(ctx, expected_scope="archava-monad")
        ctx.connect.assert_not_called()

    async def test_entrypoint_rejects_malformed_room_metadata(self):
        """Worker rejects room with invalid JSON metadata."""
        ctx = Mock()
        ctx.connect = AsyncMock()
        ctx.room = Mock()
        ctx.room.metadata = "not-json-content{{"

        await entrypoint(ctx, expected_scope="archava-monad")
        ctx.connect.assert_not_called()

    async def test_entrypoint_no_session_or_provider_created_on_rejection(self):
        """No AgentSession or AvatarSession is created when scope validation fails."""
        ctx = Mock()
        ctx.connect = AsyncMock()
        ctx.room = Mock()
        ctx.room.metadata = json.dumps({"product": "archava", "deploymentId": "wrong-deployment"})

        with patch("agent.new_session") as mock_new_session, \
             patch("agent.spatius.AvatarSession") as mock_spatius, \
             patch("agent.tavus.AvatarSession") as mock_tavus:
            await entrypoint(ctx, expected_scope="archava-monad")
            ctx.connect.assert_not_called()
            mock_new_session.assert_not_called()
            mock_spatius.assert_not_called()
            mock_tavus.assert_not_called()

    async def test_entrypoint_proceeds_with_valid_matching_scope(self):
        """Worker connects and starts session only when scope exactly matches."""
        ctx = Mock()
        ctx.connect = AsyncMock()
        ctx.room = Mock()
        ctx.room.metadata = json.dumps({"product": "archava", "deploymentId": "archava-monad"})
        ctx.room.on = Mock()
        ctx.room.local_participant = Mock()

        mock_session = Mock()
        mock_session.start = AsyncMock()
        mock_session.generate_reply = Mock()

        with patch("agent.new_session", return_value=mock_session) as mock_new_session, \
             patch.dict(os.environ, {"AVATAR_PROVIDER": "tavus", "TAVUS_ENABLED": "false"}, clear=False):
            await entrypoint(ctx, expected_scope="archava-monad")
            ctx.connect.assert_awaited_once()
            mock_new_session.assert_called_once()
            mock_session.start.assert_awaited_once()

    async def test_create_entrypoint_binds_validated_scope(self):
        """create_entrypoint creates an entrypoint pre-bound to the validated scope."""
        bound_ep = create_entrypoint("monad-cluster-alpha")

        ctx = Mock()
        ctx.connect = AsyncMock()
        ctx.room = Mock()
        ctx.room.metadata = json.dumps({"product": "archava", "deploymentId": "monad-cluster-alpha"})
        ctx.room.on = Mock()
        ctx.room.local_participant = Mock()

        mock_session = Mock()
        mock_session.start = AsyncMock()
        mock_session.generate_reply = Mock()

        with patch("agent.new_session", return_value=mock_session):
            await bound_ep(ctx)
            ctx.connect.assert_awaited_once()

        with self.assertRaises(ValueError):
            create_entrypoint("")
        with self.assertRaises(ValueError):
            create_entrypoint("   ")


if __name__ == "__main__":
    unittest.main()
