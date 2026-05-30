"""ID and seed helpers for photo-web."""

from __future__ import annotations

import secrets
import time

CROCKFORD32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
MAX_SEED = (2**31) - 1


def _encode_crockford(value: int, length: int) -> str:
    chars: list[str] = []
    for _ in range(length):
        chars.append(CROCKFORD32[value & 31])
        value >>= 5
    return "".join(reversed(chars))


def new_ulid() -> str:
    """Return a ULID-like, time-sortable 26-character id."""
    timestamp_ms = int(time.time() * 1000)
    randomness = secrets.randbits(80)
    return _encode_crockford(timestamp_ms, 10) + _encode_crockford(randomness, 16)


def new_seed() -> int:
    """Return an explicit Gemini seed in a conservative signed 32-bit range."""
    return secrets.randbelow(MAX_SEED) + 1
