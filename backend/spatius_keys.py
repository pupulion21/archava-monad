"""Bounded startup failover between operator-configured Spatius credentials."""

import asyncio
from collections.abc import Mapping

from spatius.errors import AvatarSDKError, AvatarSDKErrorCode


def spatius_api_keys(env: Mapping[str, str]) -> list[tuple[str, str]]:
    keys = []
    seen = set()
    for label, name in (("primary", "SPATIUS_API_KEY"), ("secondary", "SPATIUS_API_KEY_2")):
        value = env.get(name, "").strip()
        if value and not value.lower().startswith("your_") and value not in seen:
            keys.append((label, value))
            seen.add(value)
    return keys


def spatius_failure_reason(error: BaseException) -> tuple[str, bool]:
    """Inspect the SDK cause wrapped by LiveKit without logging credentials/body."""
    seen = set()
    current = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, AvatarSDKError):
            code = current.code
            if code in (AvatarSDKErrorCode.creditsExhausted, AvatarSDKErrorCode.billingRequired):
                return code.value, True
            if current.http_status == 429:
                return "rate_limited", True
            return code.value, False
        current = current.__cause__ or current.__context__
    return ("timeout" if isinstance(error, TimeoutError) else "startup_failed"), False


class SpatiusStartupError(RuntimeError):
    """A safe diagnostic that never contains SDK response bodies or API keys."""


async def start_spatius_avatar(*, factory, api_keys, app_id, avatar_id, session, room,
                               startup_timeout=30, cleanup_timeout=5):
    if not api_keys:
        raise SpatiusStartupError("Spatius requires SPATIUS_API_KEY")

    async def close_failed(avatar):
        if avatar is None:
            return True
        try:
            await asyncio.wait_for(avatar.aclose(), timeout=cleanup_timeout)
            return True
        except Exception:
            return False

    for index, (label, key) in enumerate(api_keys):
        avatar = None
        try:
            avatar = factory(api_key=key, app_id=app_id, avatar_id=avatar_id)

            async def connect():
                await avatar.start(session, room=room)
                await avatar.wait_for_join(timeout=20)

            await asyncio.wait_for(connect(), timeout=startup_timeout)
            print(f"[archava] Spatius avatar connected (credential={label})", flush=True)
            return avatar
        except asyncio.CancelledError:
            await close_failed(avatar)
            raise
        except Exception as error:
            reason, can_rotate = spatius_failure_reason(error)
            if not await close_failed(avatar):
                raise SpatiusStartupError("Spatius startup cleanup failed; retry stopped") from None
            if can_rotate and index + 1 < len(api_keys):
                print(f"[archava] Spatius {label} unavailable ({reason}); trying secondary credential", flush=True)
                continue
            raise SpatiusStartupError(f"Spatius avatar startup failed ({reason}, credential={label})") from None
