from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Literal
from zoneinfo import ZoneInfo

from .services import (
    LOCAL_USER_ID,
    MarketId,
    asset_visible_to_user,
    asset_kind,
    is_public_market_asset,
    list_market_top_assets,
    normalize_asset_record,
    now_iso,
    read_db,
    record_audit,
    round_number,
    get_cached_value,
    set_cached_value,
    update_db,
)
from .market_data_providers import DEFAULT_HISTORY_RANGE, Interval, MarketDataProviderManager, Range
from .market_screeners import (
    FULL_MARKET_UNIVERSE,
    MARKET_TOP_CACHE_TTL_SECONDS,
    MARKET_TOP_RANKING,
    fetch_full_market_top_assets,
    market_top_cache_key,
)

MARKET_LATEST_CACHE_TTL_SECONDS = 60 * 60 * 36
MARKET_LATEST_RECENT_IN_FLIGHT_SECONDS = 60 * 20
MARKET_LATEST_DAILY_SOURCE = "market-latest-sync"
ASSET_REFRESH_CACHE_TTL_SECONDS = 600
US_EASTERN = ZoneInfo("America/New_York")

def refresh_market_top_assets(
    *,
    user_id: str = LOCAL_USER_ID,
    market_id: MarketId,
    kind: Literal["stock", "fund"],
    limit: int = 10,
) -> dict[str, Any]:
    db = read_db()
    assets = list_market_top_assets(db, market_id, kind, limit, user_id, require_real_turnover=False)
    asset_ids = [str(asset.get("id")) for asset in assets if asset.get("id")]
    if not asset_ids:
        source = MarketDataProviderManager(user_id=user_id).source_label(market_id)
        return {"fetched": 0, "failed": [], "source": source, "skipped": "no-assets"}
    return refresh_market_data(user_id=user_id, market_id=market_id, asset_ids=asset_ids, range_value="1mo", timeout_seconds=4)


def refresh_full_market_latest_data(
    *,
    user_id: str = LOCAL_USER_ID,
    market_id: MarketId,
    force: bool = False,
    timeout_seconds: float = 10,
) -> dict[str, Any]:
    window = market_latest_refresh_window(market_id)
    source = "market-universe"
    if window is None and not force:
        return {"fetched": 0, "failed": [], "source": source, "skipped": "outside-market-refresh-window"}

    resolved_window = window or current_market_latest_window(market_id)
    cache_key = market_latest_cache_key(market_id, resolved_window["sessionDate"], resolved_window["window"])
    db = read_db()
    if not force and market_latest_cache_is_recent(db, cache_key):
        return {
            "fetched": 0,
            "failed": [],
            "source": source,
            "skipped": "recent",
            "sessionDate": resolved_window["sessionDate"],
            "window": resolved_window["window"],
        }

    from .asset_discovery import ensure_market_universe

    universe_result = ensure_market_universe(user_id=user_id, market_id=market_id, timeout_seconds=timeout_seconds, force=True) or {}
    source = str(universe_result.get("source") or source)
    failed = universe_result.get("failed") if isinstance(universe_result.get("failed"), list) else []
    synced = int_value(universe_result.get("synced"))
    if synced <= 0:
        return {
            "fetched": 0,
            "synced": synced,
            "failed": failed,
            "source": source,
            "sessionDate": resolved_window["sessionDate"],
            "window": resolved_window["window"],
            "skipped": "no-market-universe-updates",
        }

    persisted = persist_latest_daily_prices(
        user_id=user_id,
        market_id=market_id,
        trade_date=resolved_window["sessionDate"],
        cache_key=cache_key,
        source=source,
        session_window=resolved_window["window"],
    )
    return {
        "fetched": persisted["fetched"],
        "synced": synced,
        "failed": failed,
        "source": source,
        "sessionDate": resolved_window["sessionDate"],
        "window": resolved_window["window"],
        "dailyPrices": persisted["fetched"],
    }


def market_latest_refresh_window(market_id: MarketId, now: datetime | None = None) -> dict[str, str] | None:
    if market_id != "us":
        return None
    local_now = (now or datetime.now(timezone.utc)).astimezone(US_EASTERN)
    if local_now.weekday() >= 5:
        return None
    minutes = local_now.hour * 60 + local_now.minute
    open_start = 9 * 60 + 30
    open_end = 10 * 60 + parse_int_env("FUNDX_MARKET_LATEST_OPEN_WINDOW_MINUTES", 60)
    close_start = 16 * 60
    close_end = 16 * 60 + parse_int_env("FUNDX_MARKET_LATEST_CLOSE_WINDOW_MINUTES", 90)
    if open_start <= minutes <= open_end:
        window = "open"
    elif close_start <= minutes <= close_end:
        window = "close"
    else:
        return None
    return {"sessionDate": local_now.date().isoformat(), "window": window}


def current_market_latest_window(market_id: MarketId) -> dict[str, str]:
    local_now = datetime.now(timezone.utc).astimezone(US_EASTERN if market_id == "us" else timezone.utc)
    return {"sessionDate": local_now.date().isoformat(), "window": "manual"}


def market_latest_cache_key(market_id: MarketId, session_date: str, window: str) -> str:
    return f"market-latest-sync:{market_id}:{session_date}:{window}"


def market_latest_cache_is_recent(db: dict[str, Any], cache_key: str) -> bool:
    now = datetime.now(timezone.utc)
    for item in db.get("cache", []):
        if item.get("key") != cache_key:
            continue
        created_at = parse_iso_datetime(str(item.get("createdAt") or ""))
        if created_at and (now - created_at).total_seconds() <= MARKET_LATEST_RECENT_IN_FLIGHT_SECONDS:
            return True
        return str(item.get("expiresAt", "")) > now_iso()
    return False


def persist_latest_daily_prices(
    *,
    user_id: str,
    market_id: MarketId,
    trade_date: str,
    cache_key: str,
    source: str,
    session_window: str,
) -> dict[str, int]:
    saved = {"fetched": 0}
    timestamp = now_iso()

    def mutate(next_db: dict[str, Any]) -> None:
        existing_by_key = {
            (point.get("marketId"), point.get("assetId"), point.get("assetType"), point.get("date")): point
            for point in next_db.get("dailyPrices", [])
            if point.get("marketId") == market_id and point.get("date") == trade_date
        }
        fetched = 0
        for asset in latest_sync_assets(next_db, user_id, market_id):
            point = latest_asset_daily_price_point(asset, trade_date, source)
            if point is None:
                continue
            key = (point.get("marketId"), point.get("assetId"), point.get("assetType"), point.get("date"))
            existing = existing_by_key.get(key)
            if existing:
                merge_latest_daily_price(existing, point)
            else:
                next_db.setdefault("dailyPrices", []).append(point)
            fetched += 1
        set_cached_value(
            next_db,
            cache_key,
            {"fetched": fetched, "at": timestamp, "source": source, "sessionDate": trade_date, "window": session_window},
            MARKET_LATEST_CACHE_TTL_SECONDS,
        )
        set_cached_value(
            next_db,
            f"market-sync:{market_id}",
            {"fetched": fetched, "failed": [], "at": timestamp, "source": source, "range": "latest", "sessionDate": trade_date, "window": session_window},
            600,
        )
        record_audit(
            next_db,
            market_id,
            "data-source.market-latest-sync",
            "market-data",
            user_id=user_id,
            metadata={"fetched": fetched, "source": source, "sessionDate": trade_date, "window": session_window},
        )
        saved["fetched"] = fetched

    update_db(mutate)
    return saved


def latest_sync_assets(db: dict[str, Any], user_id: str, market_id: MarketId) -> list[dict[str, Any]]:
    return [
        normalize_asset_record(asset)
        for asset in db.get("assets", [])
        if asset.get("marketId") == market_id
        and asset_visible_to_user(asset, user_id)
        and is_public_market_asset(asset)
        and asset_kind(asset) in ("stock", "fund")
    ]


def latest_asset_daily_price_point(asset: dict[str, Any], trade_date: str, source: str) -> dict[str, Any] | None:
    price = float_value(asset.get("latestPrice"))
    if price is None or price <= 0:
        return None
    asset_id = str(asset.get("id") or "")
    asset_type = str(asset.get("assetType") or ("fund" if asset_kind(asset) == "fund" else "stock"))
    volume = float_value(asset.get("latestVolume"))
    point = {
        "id": f"{asset_id}-{trade_date}",
        "marketId": asset.get("marketId"),
        "assetId": asset_id,
        "assetType": asset_type,
        "date": trade_date,
        "open": round_number(price, 4),
        "high": round_number(price, 4),
        "low": round_number(price, 4),
        "close": round_number(price, 4),
        **({"nav": round_number(price, 4)} if asset_kind(asset) != "stock" else {}),
        **({"volume": round_number(volume, 2)} if volume is not None else {}),
        **({"amount": round_number(price * volume, 2)} if volume is not None else {}),
        "source": asset.get("quoteSource") or source or MARKET_LATEST_DAILY_SOURCE,
    }
    return point


def merge_latest_daily_price(existing: dict[str, Any], point: dict[str, Any]) -> None:
    close = float_value(point.get("close"))
    if close is None:
        return
    existing["close"] = point["close"]
    if "nav" in point:
        existing["nav"] = point["nav"]
    for key in ("open", "high", "low"):
        if not isinstance(existing.get(key), (int, float)):
            existing[key] = point[key]
    if isinstance(existing.get("high"), (int, float)):
        existing["high"] = round_number(max(float(existing["high"]), close), 4)
    if isinstance(existing.get("low"), (int, float)):
        existing["low"] = round_number(min(float(existing["low"]), close), 4)
    for key in ("volume", "amount", "source"):
        if key in point:
            existing[key] = point[key]


def parse_iso_datetime(value: str) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def float_value(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def int_value(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    return 0


def parse_int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


def refresh_full_market_top_assets(
    *,
    user_id: str = LOCAL_USER_ID,
    market_id: MarketId,
    kind: Literal["stock", "fund"],
    limit: int = 10,
    timeout_seconds: float = 10,
) -> dict[str, Any]:
    result = fetch_full_market_top_assets(market_id=market_id, kind=kind, limit=limit, timeout_seconds=timeout_seconds)
    items = result.get("items") if isinstance(result.get("items"), list) else []
    source = str(result.get("source") or "market-screener")
    updated_at = str(result.get("updatedAt") or now_iso())
    failed = result.get("failed") if isinstance(result.get("failed"), list) else []
    cache_payload = {
        "marketId": market_id,
        "kind": kind,
        "count": len(items),
        "items": items,
        "source": source,
        "updatedAt": updated_at,
        "universe": FULL_MARKET_UNIVERSE,
        "ranking": MARKET_TOP_RANKING,
    }

    def mutate(next_db: dict[str, Any]) -> None:
        if items:
            set_cached_value(next_db, market_top_cache_key(market_id, kind), cache_payload, MARKET_TOP_CACHE_TTL_SECONDS)
        record_audit(
            next_db,
            market_id,
            "data-source.market-top",
            "market-data",
            user_id=user_id,
            metadata={"kind": kind, "fetched": len(items), "failed": len(failed), "source": source, "universe": FULL_MARKET_UNIVERSE},
        )

    update_db(mutate)
    return {
        "fetched": len(items),
        "failed": failed,
        "source": source,
        "universe": FULL_MARKET_UNIVERSE,
        "ranking": MARKET_TOP_RANKING,
        "items": items,
        "updatedAt": updated_at,
    }


def refresh_market_data(
    *,
    user_id: str = LOCAL_USER_ID,
    market_id: MarketId,
    asset_ids: list[str],
    range_value: Range = DEFAULT_HISTORY_RANGE,
    interval: Interval = "1d",
    timeout_seconds: float = 8,
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict[str, Any]:
    if not asset_ids:
        raise ValueError("refresh_market_data requires explicit asset_ids; full-market quote refresh is disabled.")

    db = read_db()
    requested = set(asset_ids)
    visible_requested_assets = [
        normalize_asset_record(asset)
        for asset in db.get("assets", [])
        if asset.get("marketId") == market_id
        and asset.get("id") in requested
        and asset_kind(asset) in ("stock", "fund")
        and asset_visible_to_user(asset, user_id)
    ]
    candidates = [asset for asset in visible_requested_assets if asset.get("assetType") != "customAsset"]
    skipped = [
        {"assetId": str(asset.get("id")), "reason": "Custom assets use user-provided quotes."}
        for asset in visible_requested_assets
        if asset.get("assetType") == "customAsset" and asset.get("id")
    ]
    found_ids = {str(asset.get("id")) for asset in visible_requested_assets if asset.get("id")}
    fetched: list[dict[str, Any]] = []
    cached: list[dict[str, str]] = []
    failed: list[dict[str, str]] = [*skipped, *[{"assetId": asset_id, "reason": "Asset was not found in the selected market."} for asset_id in asset_ids if asset_id not in found_ids]]
    provider_manager = MarketDataProviderManager(user_id=user_id)
    source = provider_manager.source_label(market_id)

    for asset in candidates:
        asset_id = str(asset.get("id"))
        if asset_refresh_cache_hit(db, market_id, asset_id, range_value, start_date, end_date):
            cached.append({"assetId": asset_id, "reason": "Recent asset refresh cache hit."})
            continue
        try:
            quote = provider_manager.fetch_quote(asset, range_value=range_value, interval=interval, timeout_seconds=timeout_seconds, start_date=start_date, end_date=end_date)
            if quote:
                fetched.append(quote)
            else:
                failed.append({"assetId": asset_id, "reason": provider_manager.last_failure_reason(asset_id) or "No public quote returned."})
        except Exception as exc:
            failed.append({"assetId": asset_id, "reason": str(exc) or "Unknown data-source error."})

    def mutate(next_db: dict[str, Any]) -> None:
        for quote in fetched:
            apply_quote(next_db, quote)
        for failure in failed:
            mark_quote_failure(next_db, failure["assetId"], failure["reason"])
        set_cached_value(
            next_db,
            f"market-sync:{market_id}",
            {"fetched": len(fetched), "cached": cached, "failed": failed, "at": now_iso(), "source": source, "range": range_value, "startDate": start_date, "endDate": end_date},
            600,
        )
        for quote in fetched:
            set_cached_value(
                next_db,
                f"asset:{quote['marketId']}:{quote['assetId']}",
                {"fetched": True, "at": quote["fetchedAt"], "source": quote["source"]},
                600,
            )
            set_cached_value(
                next_db,
                asset_refresh_cache_key(quote["marketId"], quote["assetId"], range_value, start_date, end_date),
                {"fetched": True, "at": quote["fetchedAt"], "source": quote["source"], "range": range_value, "startDate": start_date, "endDate": end_date},
                ASSET_REFRESH_CACHE_TTL_SECONDS,
            )
        record_audit(
            next_db,
            market_id,
            "data-source.sync",
            "market-data",
            user_id=user_id,
            metadata={"fetched": len(fetched), "cached": len(cached), "failed": len(failed), "source": source, "range": range_value, "startDate": start_date, "endDate": end_date},
        )

    update_db(mutate)
    return {"fetched": len(fetched), "cached": cached, "failed": failed, "source": source, "range": range_value, "startDate": start_date, "endDate": end_date}


def asset_refresh_cache_hit(db: dict[str, Any], market_id: MarketId, asset_id: str, range_value: Range, start_date: str | None, end_date: str | None) -> bool:
    value = get_cached_value(db, asset_refresh_cache_key(market_id, asset_id, range_value, start_date, end_date))
    return isinstance(value, dict) and value.get("fetched") is True


def asset_refresh_cache_key(market_id: MarketId, asset_id: str, range_value: Range, start_date: str | None, end_date: str | None) -> str:
    return f"asset-refresh:{market_id}:{asset_id}:{range_value}:{start_date or '-'}:{end_date or '-'}"


def fetch_public_quote(
    asset: dict[str, Any],
    *,
    range_value: Range = DEFAULT_HISTORY_RANGE,
    interval: Interval = "1d",
    timeout_seconds: float = 8,
    user_id: str = LOCAL_USER_ID,
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict[str, Any] | None:
    return MarketDataProviderManager(user_id=user_id).fetch_quote(asset, range_value=range_value, interval=interval, timeout_seconds=timeout_seconds, start_date=start_date, end_date=end_date)


def apply_quote(db: dict[str, Any], quote: dict[str, Any]) -> None:
    asset = next((item for item in db.get("assets", []) if item.get("id") == quote["assetId"]), None)
    if asset:
        asset["latestPrice"] = quote["latestPrice"]
        asset["latestVolume"] = quote.get("latestVolume")
        asset["dailyChange"] = quote["dailyChangePercent"]
        asset["source"] = "quote"
        asset["quoteSource"] = quote["source"]
        asset["quoteFetchedAt"] = quote["fetchedAt"]
        asset["quoteStatus"] = "fresh"
        asset.pop("quoteError", None)
        asset["updatedAt"] = quote["fetchedAt"]
        aliases = asset.get("aliases") if isinstance(asset.get("aliases"), list) else []
        asset["aliases"] = list(dict.fromkeys([*aliases, quote["symbol"], str(quote["symbol"]).lower()]))
        if isinstance(quote.get("dividends"), list):
            asset["dividends"] = quote["dividends"]

    fund = next((item for item in db.get("funds", []) if item.get("id") == quote["assetId"]), None)
    if fund:
        fund["nav"] = quote["latestPrice"]
        fund["dailyChange"] = quote["dailyChangePercent"]
        fund["navHistory"] = to_time_points(quote["history"])
        if isinstance(quote.get("dividends"), list):
            fund["dividends"] = quote["dividends"]

    stock = next((item for item in db.get("stocks", []) if item.get("id") == quote["assetId"]), None)
    if stock:
        stock["price"] = quote["latestPrice"]
        stock["dailyChange"] = quote["dailyChangePercent"]
        stock["priceHistory"] = to_time_points(quote["history"])
        if isinstance(quote.get("dividends"), list):
            stock["dividends"] = quote["dividends"]

    existing_by_id = {item.get("id"): item for item in db.get("dailyPrices", []) if item.get("assetId") == quote["assetId"]}
    existing_by_date = {
        (item.get("marketId"), item.get("assetId"), item.get("assetType"), item.get("date")): item
        for item in db.get("dailyPrices", [])
        if item.get("assetId") == quote["assetId"]
    }
    for point in quote["history"]:
        existing = existing_by_id.get(point.get("id")) or existing_by_date.get((point.get("marketId"), point.get("assetId"), point.get("assetType"), point.get("date")))
        if existing:
            existing.update(point)
        else:
            db.setdefault("dailyPrices", []).append(point)


def mark_quote_failure(db: dict[str, Any], asset_id: str, reason: str) -> None:
    asset = next((item for item in db.get("assets", []) if item.get("id") == asset_id), None)
    if not asset:
        return
    asset["quoteStatus"] = "failed" if asset.get("latestPrice") is None else "stale"
    asset["quoteError"] = reason
    asset["updatedAt"] = now_iso()


def to_time_points(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"date": point.get("date"), "value": point.get("nav") if point.get("nav") is not None else point.get("close")} for point in history]
