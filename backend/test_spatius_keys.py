import asyncio
import contextlib
import io
import json
import os
import unittest
from unittest.mock import AsyncMock, Mock, patch

from livekit.plugins.spatius.avatar import SpatiusException
from spatius.errors import AvatarSDKError, AvatarSDKErrorCode

from agent import entrypoint
from spatius_keys import SpatiusStartupError, spatius_api_keys, start_spatius_avatar


def quota_error():
    cause = AvatarSDKError(AvatarSDKErrorCode.creditsExhausted, "secret-primary secret-secondary",
                           server_detail="secret-primary", raw_body="secret-secondary")
    wrapped = SpatiusException("Wrapped startup failure")
    wrapped.__cause__ = cause
    return wrapped


def fake_avatar(error=None):
    avatar = Mock()
    avatar.start = AsyncMock(side_effect=error)
    avatar.wait_for_join = AsyncMock()
    avatar.aclose = AsyncMock()
    return avatar


class SpatiusKeyConfigTests(unittest.TestCase):
    def test_primary_then_secondary_and_whitespace(self):
        self.assertEqual(spatius_api_keys({"SPATIUS_API_KEY": " a ", "SPATIUS_API_KEY_2": " b "}),
                         [("primary", "a"), ("secondary", "b")])

    def test_missing_secondary_preserves_single_key(self):
        self.assertEqual(spatius_api_keys({"SPATIUS_API_KEY": "a"}), [("primary", "a")])

    def test_duplicate_key_is_not_attempted_twice(self):
        self.assertEqual(spatius_api_keys({"SPATIUS_API_KEY": "a", "SPATIUS_API_KEY_2": " a "}),
                         [("primary", "a")])

    def test_blank_or_placeholder_secondary_is_ignored(self):
        for value in ("", "  ", "your_api_key"):
            with self.subTest(value=value):
                self.assertEqual(spatius_api_keys({"SPATIUS_API_KEY": "a", "SPATIUS_API_KEY_2": value}),
                                 [("primary", "a")])


class SpatiusStartupTests(unittest.IsolatedAsyncioTestCase):
    async def connect(self, factory, **kwargs):
        return await start_spatius_avatar(factory=factory,
            api_keys=[("primary", "secret-primary"), ("secondary", "secret-secondary")],
            app_id="app", avatar_id="avatar", session=Mock(), room=Mock(), **kwargs)

    async def test_success_does_not_use_secondary(self):
        first = fake_avatar()
        factory = Mock(return_value=first)
        self.assertIs(await self.connect(factory), first)
        factory.assert_called_once()
        self.assertEqual(factory.call_args.kwargs["api_key"], "secret-primary")
        first.aclose.assert_not_awaited()

    async def test_wrapped_credit_error_rotates_after_cleanup_without_secret_log(self):
        first, second = fake_avatar(quota_error()), fake_avatar()
        order = []
        first.aclose.side_effect = lambda: order.append("closed-primary")
        factory = Mock(side_effect=lambda **kw: (
            order.append("created-" + kw["api_key"]),
            first if kw["api_key"] == "secret-primary" else second)[1])
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertIs(await self.connect(factory), second)
        self.assertEqual(order, ["created-secret-primary", "closed-primary", "created-secret-secondary"])
        second.wait_for_join.assert_awaited_once()
        self.assertNotIn("secret-primary", output.getvalue())
        self.assertNotIn("secret-secondary", output.getvalue())

    async def test_billing_required_and_rate_limit_rotate(self):
        for error in (AvatarSDKError(AvatarSDKErrorCode.billingRequired, "billing", http_status=402),
                      AvatarSDKError(AvatarSDKErrorCode.invalidRequest, "rate", http_status=429)):
            with self.subTest(code=error.code, status=error.http_status):
                first, second = fake_avatar(error), fake_avatar()
                self.assertIs(await self.connect(Mock(side_effect=[first, second])), second)
                first.aclose.assert_awaited_once()

    async def test_app_avatar_and_network_errors_do_not_rotate(self):
        for code in (AvatarSDKErrorCode.appIDMismatch, AvatarSDKErrorCode.avatarNotFound,
                     AvatarSDKErrorCode.connectionFailed):
            with self.subTest(code=code):
                avatar = fake_avatar(AvatarSDKError(code, "secret-primary"))
                factory = Mock(return_value=avatar)
                with self.assertRaises(SpatiusStartupError) as error:
                    await self.connect(factory)
                factory.assert_called_once()
                avatar.aclose.assert_awaited_once()
                self.assertNotIn("secret-primary", str(error.exception))

    async def test_both_keys_fail_after_exactly_two_attempts(self):
        avatars = [fake_avatar(quota_error()), fake_avatar(quota_error())]
        factory = Mock(side_effect=avatars)
        with self.assertRaisesRegex(SpatiusStartupError, "credential=secondary"):
            await self.connect(factory)
        self.assertEqual(factory.call_count, 2)
        for avatar in avatars:
            avatar.aclose.assert_awaited_once()

    async def test_single_key_failure_does_not_retry_same_key(self):
        avatar = fake_avatar(quota_error())
        factory = Mock(return_value=avatar)
        with self.assertRaises(SpatiusStartupError):
            await start_spatius_avatar(factory=factory, api_keys=[("primary", "secret-primary")],
                app_id="app", avatar_id="avatar", session=Mock(), room=Mock())
        factory.assert_called_once()

    async def test_hanging_start_is_bounded_and_does_not_rotate(self):
        avatar = fake_avatar()
        async def hang(*args, **kwargs):
            await asyncio.Event().wait()
        avatar.start.side_effect = hang
        factory = Mock(return_value=avatar)
        with self.assertRaisesRegex(SpatiusStartupError, "timeout"):
            await self.connect(factory, startup_timeout=0.01)
        avatar.aclose.assert_awaited_once()
        factory.assert_called_once()

    async def test_cleanup_failure_prevents_overlapping_secondary(self):
        avatar = fake_avatar(quota_error())
        avatar.aclose.side_effect = RuntimeError("secret-primary")
        factory = Mock(return_value=avatar)
        with self.assertRaisesRegex(SpatiusStartupError, "cleanup failed"):
            await self.connect(factory)
        factory.assert_called_once()

    async def test_cancellation_closes_avatar_without_rotating(self):
        avatar = fake_avatar(asyncio.CancelledError())
        factory = Mock(return_value=avatar)
        with self.assertRaises(asyncio.CancelledError):
            await self.connect(factory)
        avatar.aclose.assert_awaited_once()
        factory.assert_called_once()

    async def test_entrypoint_reads_secondary_from_env_and_uses_configured_avatar(self):
        ctx = Mock()
        ctx.connect = AsyncMock()
        ctx.room.metadata = json.dumps({"product": "archava", "deploymentId": "archava-monad"})
        session = Mock(start=AsyncMock())
        first, second = fake_avatar(quota_error()), fake_avatar()
        env = {"AVATAR_PROVIDER": "spatius", "SPATIUS_API_KEY": "secret-primary",
               "SPATIUS_API_KEY_2": "secret-secondary", "SPATIUS_APP_ID": "app",
               "SPATIUS_AVATAR_ID": "82d7dce9-ec05-4102-969f-2fe341af28cd"}
        with patch.dict(os.environ, env, clear=True), \
             patch("agent.new_session", return_value=session), \
             patch("agent.spatius.AvatarSession", side_effect=[first, second]) as factory:
            await entrypoint(ctx, expected_scope="archava-monad")
        self.assertEqual(factory.call_count, 2)
        self.assertEqual(factory.call_args.kwargs["api_key"], "secret-secondary")
        self.assertEqual(factory.call_args.kwargs["avatar_id"], env["SPATIUS_AVATAR_ID"])
        session.start.assert_awaited_once()

    async def test_voice_fallback_uses_fresh_session_after_failed_audio_tail(self):
        ctx = Mock()
        ctx.connect = AsyncMock()
        ctx.room.metadata = json.dumps({"product": "archava", "deploymentId": "archava-monad"})
        old, fresh = Mock(start=AsyncMock()), Mock(start=AsyncMock())
        env = {"AVATAR_PROVIDER": "spatius", "SPATIUS_API_KEY": "secret-primary",
               "SPATIUS_APP_ID": "app", "SPATIUS_AVATAR_ID": "avatar"}
        with patch.dict(os.environ, env, clear=True), \
             patch("agent.new_session", side_effect=[old, fresh]), \
             patch("agent.spatius.AvatarSession", return_value=fake_avatar(quota_error())):
            await entrypoint(ctx, expected_scope="archava-monad")
        old.start.assert_not_awaited()
        fresh.start.assert_awaited_once()
