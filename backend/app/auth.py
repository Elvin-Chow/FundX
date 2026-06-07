from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Literal

from fastapi import Request

from .errors import FundXApiError

MarketId = Literal["us"]
RateLimitBucket = Literal["read", "search", "mutation"]

DEFAULT_LOCAL_USER_ID = "local-user"
ALL_MARKETS: tuple[MarketId, ...] = ("us",)
RATE_LIMIT_POLICIES: dict[RateLimitBucket, tuple[int, int]] = {
    "read": (240, 60),
    "search": (90, 60),
    "mutation": (30, 60),
}

_rate_buckets: dict[str, tuple[int, float]] = {}
_last_cleanup_at = 0.0


@dataclass(frozen=True)
class ApiSession:
    user_id: str
    role: Literal["user", "readonly"]
    allowed_markets: tuple[MarketId, ...]
    can_mutate: bool
    is_anonymous_local_user: bool


@dataclass(frozen=True)
class RateLimitResult:
    allowed: bool
    limit: int
    remaining: int
    reset_at: int
    retry_after_seconds: int
    window_seconds: int


def prepare_api_request(request: Request) -> tuple[ApiSession, RateLimitResult]:
    session = get_api_session(request)
    bucket = rate_limit_bucket(request)
    rate_limit = enforce_rate_limit(request, session, bucket)

    query_market = request.query_params.get("market")
    if query_market:
        assert_market_access(session, parse_market_value(query_market))

    if request.method in {"POST", "PATCH", "DELETE"} and not session.can_mutate:
        raise FundXApiError("forbidden", "Current session is read-only and cannot mutate FundX resources.", 403)

    return session, rate_limit


def get_api_session(request: Request) -> ApiSession:
    cookies = parse_cookie_header(request.headers.get("cookie"))
    raw_user_id = (
        request.headers.get("x-fundx-user-id")
        or request.headers.get("x-user-id")
        or cookies.get("fundx_user_id")
        or cookies.get("user_id")
    )
    role_hint = request.headers.get("x-fundx-role") or cookies.get("fundx_role")
    readonly = role_hint == "readonly" or is_truthy(request.headers.get("x-fundx-readonly") or cookies.get("fundx_readonly"))
    return ApiSession(
        user_id=normalize_user_id(raw_user_id),
        role="readonly" if readonly else "user",
        allowed_markets=parse_allowed_markets(request.headers.get("x-fundx-markets") or cookies.get("fundx_markets")),
        can_mutate=not readonly,
        is_anonymous_local_user=not bool(raw_user_id),
    )


def current_session(request: Request) -> ApiSession:
    session = getattr(request.state, "session", None)
    return session if isinstance(session, ApiSession) else get_api_session(request)


def current_user_id(request: Request) -> str:
    return current_session(request).user_id


def assert_request_market_access(request: Request, market_id: str, *, mutation: bool = False) -> None:
    session = current_session(request)
    parsed_market = parse_market_value(market_id)
    assert_market_access(session, parsed_market)
    if mutation and not session.can_mutate:
        raise FundXApiError("forbidden", "Current session is read-only and cannot mutate FundX resources.", 403)


def assert_market_access(session: ApiSession, market_id: MarketId) -> None:
    if market_id not in session.allowed_markets:
        raise FundXApiError("market_forbidden", "Current session cannot access the selected market.", 403)


def parse_market_value(value: str) -> MarketId:
    if value == "us":
        return value
    raise FundXApiError("invalid_market", "market must be: us", 400)


def rate_limit_bucket(request: Request) -> RateLimitBucket:
    if request.method in {"POST", "PATCH", "DELETE"}:
        return "mutation"
    if request.url.path == "/api/assets/search":
        return "search"
    return "read"


def enforce_rate_limit(request: Request, session: ApiSession, bucket: RateLimitBucket) -> RateLimitResult:
    cleanup_rate_buckets()
    limit, window_seconds = RATE_LIMIT_POLICIES[bucket]
    now = time.time()
    key = ":".join(
        [
            bucket,
            session.user_id,
            client_rate_limit_id(request),
            request.method,
            request.url.path,
        ]
    )
    count, reset_at = _rate_buckets.get(key, (0, now + window_seconds))
    if reset_at <= now:
        count = 0
        reset_at = now + window_seconds

    if count >= limit:
        retry_after = max(1, int(reset_at - now + 0.999))
        result = RateLimitResult(
            allowed=False,
            limit=limit,
            remaining=0,
            reset_at=int(reset_at),
            retry_after_seconds=retry_after,
            window_seconds=window_seconds,
        )
        raise FundXApiError(
            "rate_limited",
            "Too many FundX API requests. Please retry shortly.",
            429,
            details={
                "limit": result.limit,
                "windowSeconds": result.window_seconds,
                "retryAfterSeconds": result.retry_after_seconds,
            },
            headers=rate_limit_headers(result),
        )

    count += 1
    _rate_buckets[key] = (count, reset_at)
    return RateLimitResult(
        allowed=True,
        limit=limit,
        remaining=max(0, limit - count),
        reset_at=int(reset_at),
        retry_after_seconds=0,
        window_seconds=window_seconds,
    )


def rate_limit_headers(result: RateLimitResult) -> dict[str, str]:
    return {
        "Retry-After": str(result.retry_after_seconds),
        "X-RateLimit-Limit": str(result.limit),
        "X-RateLimit-Remaining": str(result.remaining),
        "X-RateLimit-Reset": str(result.reset_at),
    }


def cleanup_rate_buckets() -> None:
    global _last_cleanup_at
    now = time.time()
    if now - _last_cleanup_at < 60:
        return
    _last_cleanup_at = now
    expired = [key for key, (_, reset_at) in _rate_buckets.items() if reset_at <= now]
    for key in expired:
        del _rate_buckets[key]


def client_rate_limit_id(request: Request) -> str:
    forwarded_for = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    client_ip = forwarded_for or request.headers.get("x-real-ip") or request.headers.get("cf-connecting-ip")
    if not client_ip and request.client:
        client_ip = request.client.host
    user_agent = request.headers.get("user-agent") or "unknown-agent"
    return f"{client_ip or 'unknown-ip'}:{user_agent[:80]}"


def parse_cookie_header(cookie_header: str | None) -> dict[str, str]:
    cookies: dict[str, str] = {}
    if not cookie_header:
        return cookies
    for part in cookie_header.split(";"):
        raw_key, _, raw_value = part.strip().partition("=")
        if raw_key and raw_value:
            cookies[raw_key] = raw_value
    return cookies


def normalize_user_id(value: str | None) -> str:
    if not value or not value.strip():
        return DEFAULT_LOCAL_USER_ID
    normalized = "".join(char if char.isalnum() or char in "_.:-" else "-" for char in value.strip()[:80])
    return normalized or DEFAULT_LOCAL_USER_ID


def parse_allowed_markets(value: str | None) -> tuple[MarketId, ...]:
    if not value or not value.strip():
        return ALL_MARKETS
    markets: list[MarketId] = []
    for raw_item in value.split(","):
        item = raw_item.strip()
        if item == "us" and item not in markets:
            markets.append(item)
    return tuple(markets) or ALL_MARKETS


def is_truthy(value: str | None) -> bool:
    return bool(value and value.lower() in {"1", "true", "yes", "on"})
