from __future__ import annotations

import json
import math
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Literal

from .asset_classification import enrich_asset_classification, is_excluded_china_theme_asset
from .errors import FundXApiError, invalid_market, validation_error

MarketId = Literal["us"]
AssetKind = Literal["stock", "fund"]

LOCAL_USER_ID = "local-user"
REPO_ROOT = Path(__file__).resolve().parents[2]
PRIMARY_DB_PATH = REPO_ROOT / ".fundx" / "fundx-db.json"
FALLBACK_DB_PATH = REPO_ROOT / "data" / "fundx.db.json"
_DB_CACHE_SIGNATURE: tuple[str, int, int] | None = None
_DB_CACHE_DATA: dict[str, Any] | None = None

US_SECTORS = [
    "Technology",
    "Healthcare",
    "Financials",
    "Consumer Staples",
    "Consumer Discretionary",
    "Industrials",
    "Energy",
    "Utilities",
    "Communication Services",
    "Materials",
    "Real Estate",
]

MARKET_CONFIGS: dict[MarketId, dict[str, Any]] = {
    "us": {
        "id": "us",
        "name": "US Market",
        "region": "United States",
        "currency": "USD",
        "currencySymbol": "$",
        "accent": "#00c805",
        "benchmarks": ["S&P 500", "Nasdaq 100", "Dow Jones", "Russell 1000 Value"],
        "sectors": US_SECTORS,
        "style": "Quality compounders, index core, dividend value, and defensive cash buffers.",
    },
}


def browser_local_user_data_enabled() -> bool:
    return os.environ.get("FUNDX_USER_DATA_MODE", "browser-local").strip().lower() != "server"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def read_db() -> dict[str, Any]:
    path = get_db_path()
    if not path:
        raise FundXApiError(
            "database_not_found",
            "FundX local database was not found.",
            500,
            details={"checked": [str(PRIMARY_DB_PATH), str(FALLBACK_DB_PATH)]},
        )

    global _DB_CACHE_DATA, _DB_CACHE_SIGNATURE
    signature = db_file_signature(path)
    if _DB_CACHE_SIGNATURE == signature and _DB_CACHE_DATA is not None:
        return _DB_CACHE_DATA

    with path.open("r", encoding="utf-8") as handle:
        raw = json.load(handle)
    normalized = normalize_db(raw)
    _DB_CACHE_SIGNATURE = signature
    _DB_CACHE_DATA = normalized
    return normalized


def read_raw_db() -> tuple[Path, dict[str, Any], dict[str, Any]]:
    path = get_db_path()
    if not path:
        raise FundXApiError(
            "database_not_found",
            "FundX local database was not found.",
            500,
            details={"checked": [str(PRIMARY_DB_PATH), str(FALLBACK_DB_PATH)]},
        )
    with path.open("r", encoding="utf-8") as handle:
        raw = json.load(handle)
    data = raw.get("data") if isinstance(raw.get("data"), dict) else raw
    ensure_collections(data)
    return path, raw, data


def update_db(mutator: Callable[[dict[str, Any]], Any]) -> dict[str, Any]:
    path, raw, data = read_raw_db()
    result = mutator(data)
    timestamp = now_iso()
    if isinstance(raw.get("data"), dict):
        raw["migratedAt"] = timestamp
    else:
        raw["updatedAt"] = timestamp
    temp_path = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    temp_path.write_text(f"{json.dumps(raw, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
    temp_path.replace(path)
    normalized = normalize_db(raw)
    set_db_cache(path, normalized)
    if isinstance(result, dict):
        result.setdefault("_db", normalized)
    return normalized


def db_file_signature(path: Path) -> tuple[str, int, int]:
    stats = path.stat()
    return (str(path.resolve()), stats.st_mtime_ns, stats.st_size)


def set_db_cache(path: Path, data: dict[str, Any]) -> None:
    global _DB_CACHE_DATA, _DB_CACHE_SIGNATURE
    _DB_CACHE_SIGNATURE = db_file_signature(path)
    _DB_CACHE_DATA = data


def ensure_collections(db: dict[str, Any]) -> None:
    for key in (
        "users",
        "securityMaster",
        "funds",
        "stocks",
        "assets",
        "dailyPrices",
        "portfolios",
        "portfolioVersions",
        "transactions",
        "cashMovements",
        "watchlist",
        "dcaPlans",
        "customFunds",
        "portfolioSnapshots",
        "rebalanceSuggestions",
        "insightRecommendations",
        "reports",
        "providerAccounts",
        "activities",
        "auditEvents",
        "jobs",
        "cache",
    ):
        db.setdefault(key, [])
    ensure_dividend_fields(db)


def ensure_dividend_fields(db: dict[str, Any]) -> None:
    for collection in ("assets", "funds", "stocks"):
        for item in db.get(collection, []):
            if not isinstance(item, dict):
                continue
            if collection == "assets":
                if item.get("assetType") in ("customAsset", "customFund"):
                    continue
                if asset_kind(item) not in ("stock", "fund"):
                    continue
            if not isinstance(item.get("dividends"), list):
                item["dividends"] = []


def create_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4()}"


def clone_json(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False))


def set_cached_value(db: dict[str, Any], key: str, value: Any, ttl_seconds: int) -> None:
    created_at = now_iso()
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    db["cache"] = [item for item in db.get("cache", []) if item.get("key") != key and str(item.get("expiresAt", "")) > created_at]
    db.setdefault("cache", []).append({"key": key, "value": value, "expiresAt": expires_at, "createdAt": created_at})


def record_audit(
    db: dict[str, Any],
    market_id: str | None,
    action: str,
    entity_type: str,
    entity_id: str | None = None,
    *,
    user_id: str = LOCAL_USER_ID,
    metadata: dict[str, Any] | None = None,
) -> None:
    db.setdefault("auditEvents", []).insert(
        0,
        {
            "id": create_id("audit"),
            "userId": user_id,
            "marketId": market_id,
            "action": action,
            "entityType": entity_type,
            **({"entityId": entity_id} if entity_id else {}),
            **({"metadata": metadata} if metadata else {}),
            "createdAt": now_iso(),
        },
    )
    db["auditEvents"] = db["auditEvents"][:1000]


def get_db_path() -> Path | None:
    for configured in (os.environ.get("FUNDX_DB_PATH"), os.environ.get("FUNDX_DB_FILE")):
        if not configured:
            continue
        configured_path = Path(configured)
        if configured_path.exists():
            return configured_path
    if PRIMARY_DB_PATH.exists():
        return PRIMARY_DB_PATH
    if FALLBACK_DB_PATH.exists():
        return FALLBACK_DB_PATH
    return None


def normalize_db(raw: dict[str, Any]) -> dict[str, Any]:
    if "data" in raw and isinstance(raw["data"], dict):
        data = raw["data"]
        timestamp = raw.get("migratedAt") or raw.get("createdAt") or now_iso()
        normalized = {
            "version": raw.get("schemaVersion", 1),
            "createdAt": raw.get("createdAt", timestamp),
            "updatedAt": timestamp,
            "users": data.get("users") or data.get("userPreferences") or [],
            "securityMaster": data.get("securityMaster", []),
            "funds": data.get("funds", []),
            "stocks": data.get("stocks", []),
            "assets": data.get("assets", []),
            "dailyPrices": data.get("dailyPrices", []),
            "portfolios": data.get("portfolios", []),
            "portfolioVersions": data.get("portfolioVersions", []),
            "transactions": data.get("transactions", []),
            "cashMovements": data.get("cashMovements", []),
            "watchlist": data.get("watchlist", []),
            "dcaPlans": data.get("dcaPlans", []),
            "customFunds": data.get("customFunds", []),
            "portfolioSnapshots": data.get("portfolioSnapshots", []),
            "rebalanceSuggestions": data.get("rebalanceSuggestions", []),
            "insightRecommendations": data.get("insightRecommendations", []),
            "reports": data.get("reports", []),
            "providerAccounts": data.get("providerAccounts", []),
            "activities": data.get("activities", []),
            "auditEvents": data.get("auditEvents", []),
            "jobs": data.get("jobs", []),
            "cache": data.get("cache", []),
        }
        ensure_collections(normalized)
        return normalized

    normalized = dict(raw)
    for key in (
        "users",
        "securityMaster",
        "funds",
        "stocks",
        "assets",
        "dailyPrices",
        "portfolios",
        "portfolioVersions",
        "transactions",
        "cashMovements",
        "watchlist",
        "dcaPlans",
        "customFunds",
        "portfolioSnapshots",
        "rebalanceSuggestions",
        "insightRecommendations",
        "reports",
        "providerAccounts",
        "activities",
        "auditEvents",
        "jobs",
        "cache",
    ):
        normalized.setdefault(key, [])
    normalized.setdefault("updatedAt", normalized.get("createdAt") or now_iso())
    ensure_dividend_fields(normalized)
    return normalized


def parse_market(value: str | None) -> MarketId:
    market = value or "us"
    if market == "us":
        return market
    raise invalid_market()


def parse_int(
    value: str | None,
    *,
    default: int | None = None,
    minimum: int | None = None,
    maximum: int | None = None,
    field: str,
) -> int:
    if value in (None, ""):
        if default is None:
            raise validation_error(f"{field} is required.")
        parsed = default
    else:
        try:
            parsed = int(value)
        except ValueError as exc:
            raise validation_error(f"{field} must be an integer.") from exc

    if minimum is not None and parsed < minimum:
        raise validation_error(f"{field} must be greater than or equal to {minimum}.")
    if maximum is not None and parsed > maximum:
        raise validation_error(f"{field} must be less than or equal to {maximum}.")
    return parsed


def parse_bool(value: str | None) -> bool:
    return value in ("true", "1")


def health_payload() -> dict[str, Any]:
    path = get_db_path()
    counts: dict[str, int] = {}
    updated_at = None
    if path:
        db = read_db()
        updated_at = db.get("updatedAt")
        counts = {
            "funds": len(db.get("funds", [])),
            "stocks": len(db.get("stocks", [])),
            "assets": len(db.get("assets", [])),
        }

    return {
        "ok": True,
        "service": "fundx-fastapi",
        "status": "healthy" if path else "degraded",
        "database": {
            "path": str(path) if path else None,
            "available": path is not None,
            "updatedAt": updated_at,
            "counts": counts,
        },
    }


def market_payload(market_id: MarketId, portfolio_id: str | None = None, user_id: str = LOCAL_USER_ID) -> dict[str, Any]:
    db = read_db()
    return {
        **get_market_data_meta(db, market_id),
        "market": MARKET_CONFIGS[market_id],
        "options": list_market_options(),
        "overview": get_market_overview(db, user_id, market_id, portfolio_id),
    }


def funds_payload(market_id: MarketId, refresh_value: str | None = None, user_id: str = LOCAL_USER_ID) -> dict[str, Any]:
    refreshed = parse_bool(refresh_value)
    refresh_result = None
    if refreshed:
        from .data_sources import refresh_market_top_assets

        refresh_result = refresh_market_top_assets(user_id=user_id, market_id=market_id, kind="fund", limit=10)
    db = read_db()
    funds = list_real_funds(db, market_id)
    enriched = [{**fund, "calculated": calculated_from_history(fund.get("navHistory", []))} for fund in funds]
    payload = {
        **get_market_data_meta(db, market_id),
        "funds": enriched,
        "discover": list_discover_funds(funds, market_id),
        "count": len(enriched),
        "refreshed": refreshed,
    }
    if refresh_result is not None:
        payload["refreshResult"] = refresh_result
    return payload


def list_real_funds(db: dict[str, Any], market_id: MarketId) -> list[dict[str, Any]]:
    funds_by_id = {fund.get("id"): fund for fund in db.get("funds", []) if fund.get("marketId") == market_id}
    history_index = daily_price_history_index(db, market_id)
    result: list[dict[str, Any]] = []
    for asset in db.get("assets", []):
        if asset.get("marketId") != market_id:
            continue
        if is_excluded_china_theme_asset(asset):
            continue
        if asset_kind(asset) != "fund" or asset.get("assetType") == "customAsset":
            continue
        if not is_public_market_asset(asset):
            continue
        asset = normalize_asset_record(asset)
        base = funds_by_id.get(asset.get("id"), {})
        history = list_real_asset_history(db, market_id, str(asset.get("id")), "fund", history_index)
        latest_price = asset.get("latestPrice") if isinstance(asset.get("latestPrice"), (int, float)) else base.get("nav")
        result.append(
            {
                **base,
                "id": asset.get("id"),
                "marketId": market_id,
                "name": asset.get("name"),
                "symbol": asset.get("symbol"),
                "type": asset.get("fundType") or asset.get("fundSubtype") or base.get("type") or "Fund",
                "category": asset.get("category") or asset.get("sector") or base.get("category") or "Unclassified",
                "style": asset.get("category") or asset.get("sector") or base.get("style") or "Unclassified",
                "nav": latest_price if isinstance(latest_price, (int, float)) else 0,
                "dailyChange": asset.get("dailyChange") or 0,
                "oneYearReturn": None,
                "threeYearAnnualizedReturn": None,
                "fiveYearAnnualizedReturn": None,
                "totalReturn": None,
                "maxDrawdown": None,
                "volatility": None,
                "sharpeRatio": None,
                "expenseRatio": asset.get("expenseRatio"),
                "dividendYield": base.get("dividendYield") if base.get("dividendYield") is not None else asset.get("dividendYield"),
                "aum": asset.get("aum"),
                "riskLevel": base.get("riskLevel") or "Balanced",
                "holdings": [],
                "sectorExposure": [],
                "navHistory": history,
                "dividends": base.get("dividends") if isinstance(base.get("dividends"), list) else [],
            }
        )
    return result


def list_real_stocks(db: dict[str, Any], market_id: MarketId) -> list[dict[str, Any]]:
    stocks_by_id = {stock.get("id"): stock for stock in db.get("stocks", []) if stock.get("marketId") == market_id}
    history_index = daily_price_history_index(db, market_id)
    result: list[dict[str, Any]] = []
    for asset in db.get("assets", []):
        if asset.get("marketId") != market_id or asset_kind(asset) != "stock":
            continue
        if is_excluded_china_theme_asset(asset):
            continue
        if not is_public_market_asset(asset):
            continue
        asset = normalize_asset_record(asset)
        base = stocks_by_id.get(asset.get("id"), {})
        latest_price = asset.get("latestPrice") if isinstance(asset.get("latestPrice"), (int, float)) else base.get("price")
        result.append(
            {
                **base,
                "id": asset.get("id"),
                "marketId": market_id,
                "name": asset.get("name"),
                "symbol": asset.get("symbol"),
                "sector": asset.get("sector") or asset.get("industry") or "Unclassified",
                "industry": asset.get("industry") or asset.get("sector") or "Unclassified",
                "price": latest_price if isinstance(latest_price, (int, float)) else 0,
                "dailyChange": asset.get("dailyChange") or 0,
                "marketCap": None,
                "peRatio": None,
                "pbRatio": None,
                "dividendYield": base.get("dividendYield") if base.get("dividendYield") is not None else asset.get("dividendYield"),
                "roe": None,
                "grossMargin": None,
                "debtRatio": None,
                "freeCashFlowYield": None,
                "revenueGrowth": None,
                "profitGrowth": None,
                "volatility": None,
                "valueScore": None,
                "qualityScore": None,
                "riskScore": None,
                "priceHistory": list_real_asset_history(db, market_id, str(asset.get("id")), "stock", history_index),
                "dividends": base.get("dividends") if isinstance(base.get("dividends"), list) else [],
            }
        )
    return result


DailyPriceHistoryIndex = dict[tuple[str, AssetKind], list[dict[str, Any]]]


def daily_price_history_index(db: dict[str, Any], market_id: MarketId) -> DailyPriceHistoryIndex:
    index: DailyPriceHistoryIndex = {}
    for point in db.get("dailyPrices", []):
        if point.get("marketId") != market_id or not point.get("assetId"):
            continue
        kind = daily_price_kind(point)
        if not (isinstance(point.get("nav"), (int, float)) or isinstance(point.get("close"), (int, float))):
            continue
        value = point.get("nav") if kind == "fund" and isinstance(point.get("nav"), (int, float)) else point.get("close")
        index.setdefault((str(point.get("assetId")), kind), []).append({"date": point.get("date"), "value": value})
    for history in index.values():
        history.sort(key=lambda point: str(point.get("date") or ""))
    return index


def list_real_asset_history(
    db: dict[str, Any],
    market_id: MarketId,
    asset_id: str,
    kind: AssetKind,
    history_index: DailyPriceHistoryIndex | None = None,
) -> list[dict[str, Any]]:
    resolved_index = history_index if history_index is not None else daily_price_history_index(db, market_id)
    return list(resolved_index.get((asset_id, kind), []))


def daily_price_kind(point: dict[str, Any]) -> AssetKind:
    return "fund" if point.get("assetType") in ("fund", "etf") else "stock"


def market_top_payload(
    market_id: MarketId,
    kind: str | None,
    limit_value: str | None,
    refresh_value: str | None,
    user_id: str = LOCAL_USER_ID,
) -> dict[str, Any]:
    if kind not in ("stock", "fund"):
        raise validation_error("kind must be one of: stock, fund.")
    limit = parse_int(limit_value, default=10, minimum=1, maximum=50, field="limit")
    auto_refresh = refresh_value == "auto"
    force_refresh = parse_bool(refresh_value)
    refreshed = auto_refresh or force_refresh
    refresh_result = None
    refresh_skipped = None
    items: list[dict[str, Any]] = []
    source = "market-screener"
    updated_at = None
    cached = False
    from .market_screeners import FULL_MARKET_UNIVERSE, MARKET_TOP_CACHE_TTL_SECONDS, MARKET_TOP_RANKING, market_top_cache_key

    cache_key = market_top_cache_key(market_id, kind)
    db = read_db()
    cache_record = get_cache_record(db, cache_key, include_expired=True)
    cached_payload = market_top_cache_payload(cache_record)

    if auto_refresh and cached_payload and is_cache_record_recent(cache_record, MARKET_TOP_CACHE_TTL_SECONDS):
        cached_items = cached_payload.get("items") if isinstance(cached_payload.get("items"), list) else []
        items = cached_items[:limit]
        source = str(cached_payload.get("source") or source)
        updated_at = str(cached_payload.get("updatedAt") or "") or None
        cached = True
        refreshed = False
        refresh_skipped = "recent"
    elif refreshed:
        from .data_sources import refresh_full_market_top_assets

        refresh_result = refresh_full_market_top_assets(user_id=user_id, market_id=market_id, kind=kind, limit=limit)
        refreshed_items = refresh_result.get("items") if isinstance(refresh_result, dict) else []
        if isinstance(refreshed_items, list):
            items = refreshed_items[:limit]
        source = str(refresh_result.get("source") or source) if isinstance(refresh_result, dict) else source
        updated_at = str(refresh_result.get("updatedAt") or "") if isinstance(refresh_result, dict) and refresh_result.get("updatedAt") else None
        db = read_db()
    if not refreshed and not items and cached_payload:
        cached_items = cached_payload.get("items") if isinstance(cached_payload.get("items"), list) else []
        items = cached_items[:limit]
        source = str(cached_payload.get("source") or source)
        updated_at = str(cached_payload.get("updatedAt") or "") or None
        cached = True
    if not refreshed and not items:
        items = list_market_top_assets(db, market_id, kind, limit, user_id, require_real_turnover=True)
        cached = True if items else cached
        source = "local-db"
    payload = {
        **get_market_data_meta(db, market_id, source=source, cache_key=cache_key, cached=cached),
        "kind": kind,
        "count": len(items),
        "items": items,
        "refreshed": refreshed,
        "cached": cached,
        "universe": FULL_MARKET_UNIVERSE,
        "ranking": MARKET_TOP_RANKING,
    }
    if updated_at:
        payload["updatedAt"] = updated_at
    if refresh_skipped:
        payload["refreshSkipped"] = refresh_skipped
    if refresh_result is not None:
        payload["refreshResult"] = {key: value for key, value in refresh_result.items() if key != "items"}
    return payload


def asset_search_payload(params: dict[str, str], user_id: str = LOCAL_USER_ID) -> dict[str, Any]:
    market_id = parse_market(params.get("market"))
    query = (params.get("q") or "").strip()
    if len(query) > 80:
        raise validation_error("q must contain at most 80 characters.")

    search_type = params.get("type") or "all"
    if search_type not in ("all", "fund", "stock"):
        raise validation_error("type must be one of: all, fund, stock.")

    sort = params.get("sort") or "relevance"
    if sort not in ("relevance", "size", "return", "risk", "popularity"):
        raise validation_error("sort must be one of: relevance, size, return, risk, popularity.")

    page = parse_int(params.get("page"), default=1, minimum=1, field="page")
    page_size = parse_int(params.get("limit") or params.get("pageSize"), default=20, minimum=1, maximum=100, field="pageSize")
    asset_types = None if search_type == "all" else [search_type]
    input_data = {
        "query": query,
        "marketId": market_id,
        "assetTypes": sorted(asset_types) if asset_types else None,
        "industry": (params.get("industry") or "").strip() or None,
        "fundType": (params.get("fundType") or "").strip() or None,
        "sort": sort,
        "page": page,
        "pageSize": page_size,
    }

    discovery_result = discover_assets_for_search(input_data, user_id) if should_discover_assets(params) else None
    db = read_db()
    assets = searchable_assets(db, user_id)
    market_assets = [asset for asset in assets if asset.get("marketId") == market_id]
    facet_assets = filter_assets_for_facets(market_assets, asset_types)
    stats = search_stats(market_assets)
    cache_key = f"search:{user_id}:{json_stringify(input_data)}"
    cached_result = get_cached_value(db, cache_key)
    if isinstance(cached_result, dict):
        result = {**cached_result, "cached": True}
        if not isinstance(result.get("stats"), dict):
            result["stats"] = build_search_result(assets, input_data).get("stats")
    else:
        result = {**build_search_result(assets, input_data), "cached": False}

    payload = {
        **get_market_data_meta(db, market_id, cache_key=cache_key, cached=result["cached"]),
        "query": query,
        "type": search_type,
        "sort": sort,
        "cached": result["cached"],
        "count": len(result.get("items", [])),
        "items": result.get("items", []),
        "total": result.get("total", 0),
        "page": result.get("page", page),
        "pageSize": result.get("pageSize", page_size),
        "totalPages": result.get("totalPages", 1),
        "stats": stats,
        "filteredStats": result.get("stats", {"total": result.get("total", 0), "funds": 0, "stocks": 0}),
        "facets": search_facets(facet_assets),
        "facetCounts": search_facet_counts(facet_assets),
    }
    if discovery_result is not None:
        payload["discovery"] = discovery_result
    return payload


def should_discover_assets(params: dict[str, str]) -> bool:
    return parse_bool(params.get("discover") or params.get("sync"))


def discover_assets_for_search(input_data: dict[str, Any], user_id: str) -> dict[str, Any] | None:
    search_types = input_data.get("assetTypes")
    kind = search_types[0] if isinstance(search_types, list) and len(search_types) == 1 and search_types[0] in ("stock", "fund") else None
    try:
        from .asset_discovery import discover_assets_for_search as discover

        return discover(
            user_id=user_id,
            market_id=input_data["marketId"],
            query=str(input_data.get("query") or ""),
            kind=kind,
            page_size=int(input_data.get("pageSize") or 20),
        )
    except Exception as exc:
        return {"synced": 0, "quoted": 0, "source": "online-discovery", "failed": [{"reason": str(exc) or type(exc).__name__}]}


def get_market_data_meta(
    db: dict[str, Any],
    market_id: MarketId,
    *,
    source: str | None = None,
    cache_key: str | None = None,
    cached: bool | None = None,
) -> dict[str, Any]:
    assets = [
        asset
        for asset in db.get("assets", [])
        if asset.get("marketId") == market_id
        and asset.get("assetType") != "customAsset"
        and not is_excluded_china_theme_asset(asset)
    ]
    timestamps = [db.get("updatedAt"), *(asset.get("updatedAt") for asset in assets)]
    updated_at = max((timestamp for timestamp in timestamps if timestamp), default=db.get("updatedAt"))
    latest_asset = max(assets, key=lambda asset: asset.get("updatedAt") or "", default=None)
    resolved_cache_key = cache_key or f"market-sync:{market_id}"
    cache_record = next((item for item in db.get("cache", []) if item.get("key") == resolved_cache_key), None)
    cache_fresh = bool(cache_record and str(cache_record.get("expiresAt", "")) > now_iso())

    return {
        "marketId": market_id,
        "source": source or (latest_asset or {}).get("source") or "local-db",
        "updatedAt": updated_at,
        "cache": {
            "cached": cached if cached is not None else cache_fresh,
            "key": resolved_cache_key,
            "status": "fresh" if cache_fresh else "expired" if cache_record else "miss",
            **({"createdAt": cache_record.get("createdAt")} if cache_record and cache_record.get("createdAt") else {}),
            **({"expiresAt": cache_record.get("expiresAt")} if cache_record and cache_record.get("expiresAt") else {}),
        },
    }


def list_market_options() -> list[dict[str, Any]]:
    options = []
    for market in MARKET_CONFIGS.values():
        options.append(
            {
                "id": market["id"],
                "code": "US",
                "name": market["name"],
                "currency": f"{market['currency']} {market['currencySymbol']}",
                "description": market["style"],
                "benchmarks": market["benchmarks"],
                "href": f"/home?market={market['id']}",
            }
        )
    return options


def get_market_overview(db: dict[str, Any], user_id: str, market_id: MarketId, portfolio_id: str | None) -> dict[str, Any]:
    portfolio = next(
        (
            item
            for item in db.get("portfolios", [])
            if item.get("userId") == user_id
            and item.get("marketId") == market_id
            and (not portfolio_id or item.get("id") == portfolio_id)
        ),
        None,
    )
    if not portfolio:
        return {
            "totalValue": format_currency(0, market_id),
            "dailyGain": format_percent(0),
            "equityCurve": [],
            "metrics": [
                {"label": "Total gain", "value": format_currency(0, market_id), "delta": format_percent(0), "tone": "neutral"},
                {"label": "Annualized", "value": "Historical data insufficient", "tone": "neutral"},
                {"label": "Cash", "value": format_currency(0, market_id)},
                {"label": "Risk score", "value": "n/a", "tone": "neutral"},
            ],
            "topAssets": [],
            "primaryInsight": healthy_insight_card(),
        }

    summary = summarize_portfolio(portfolio)
    return {
        "totalValue": format_currency(summary["totalValue"], market_id),
        "dailyGain": format_percent(0),
        "equityCurve": summary["valueHistory"],
        "metrics": [
            {
                "label": "Total gain",
                "value": format_currency(summary["totalGain"], market_id),
                "delta": format_percent(summary["totalGainPercent"]),
                "tone": tone_from_change(summary["totalGain"]),
            },
            {
                "label": "Annualized",
                "value": format_percent(summary["annualizedReturn"]),
                "tone": tone_from_change(summary["annualizedReturn"]),
            },
            {"label": "Cash", "value": format_currency(summary["cashBalance"], market_id)},
            {
                "label": "Risk score",
                "value": str(summary["riskScore"]),
                "tone": "negative" if summary["riskScore"] > 65 else "neutral",
            },
        ],
        "topAssets": [],
        "primaryInsight": healthy_insight_card(),
    }


def list_market_top_assets(
    db: dict[str, Any],
    market_id: MarketId,
    kind: AssetKind,
    limit: int,
    user_id: str = LOCAL_USER_ID,
    require_real_turnover: bool = True,
) -> list[dict[str, Any]]:
    assets = [
        normalize_asset_record(asset)
        for asset in db.get("assets", [])
        if asset.get("marketId") == market_id
        and asset_kind(asset) == kind
        and asset.get("isTradable") is not False
        and asset_visible_to_user(asset, user_id)
        and not is_excluded_china_theme_asset(asset)
    ]
    if require_real_turnover:
        assets = [asset for asset in assets if has_real_turnover_quote(asset)]

    def sort_key(asset: dict[str, Any]) -> tuple[float, str, str]:
        turnover = asset_turnover_value(asset)
        return (-(turnover or 0), _reverse_string(asset.get("quoteFetchedAt") or ""), asset.get("symbol") or "")

    return sorted(assets, key=sort_key)[:limit]


def has_real_turnover_quote(asset: dict[str, Any]) -> bool:
    latest_price = asset.get("latestPrice")
    return (
        asset.get("quoteStatus") == "fresh"
        and isinstance(latest_price, (int, float))
        and latest_price > 0
        and asset_turnover_value(asset) is not None
    )


def asset_turnover_value(asset: dict[str, Any]) -> float | None:
    latest_turnover = asset.get("latestTurnover")
    if isinstance(latest_turnover, (int, float)) and latest_turnover > 0:
        return float(latest_turnover)
    latest_price = asset.get("latestPrice")
    latest_volume = asset.get("latestVolume")
    if (
        isinstance(latest_price, (int, float))
        and latest_price > 0
        and isinstance(latest_volume, (int, float))
        and latest_volume > 0
    ):
        return float(latest_price) * float(latest_volume)
    return None


def _reverse_string(value: str) -> str:
    return "".join(chr(0x10FFFF - ord(char)) for char in value)


def list_discover_funds(funds: list[dict[str, Any]], market_id: MarketId) -> list[dict[str, Any]]:
    return [
        {
            "id": fund.get("id"),
            "name": fund.get("name"),
            "symbol": fund.get("symbol"),
            "category": f"{fund.get('type', '')} \u00b7 {fund.get('style', '')}",
            "href": f"/funds/{fund.get('id')}?market={market_id}",
            "performance": fund.get("navHistory", [])[-180:],
            "tone": tone_from_change(fund.get("oneYearReturn")),
            "returnLabel": format_percent(number_or_zero(fund.get("oneYearReturn"))),
            "drawdownLabel": format_percent(number_or_zero(fund.get("maxDrawdown"))),
        }
        for fund in funds
    ]


def searchable_assets(db: dict[str, Any], user_id: str = LOCAL_USER_ID) -> list[dict[str, Any]]:
    visible_assets = (
        normalize_asset_record(asset)
        for asset in db.get("assets", [])
        if asset_visible_to_user(asset, user_id)
        and is_public_market_asset(asset)
        and not is_excluded_china_theme_asset(asset)
    )
    return unique_assets_by_id(visible_assets)


def is_public_market_asset(asset: dict[str, Any]) -> bool:
    if asset.get("assetType") in ("customAsset", "customFund"):
        return False
    if asset.get("isTradable") is False:
        return False
    if not asset.get("symbol") or not asset.get("name"):
        return False
    if asset.get("source") == "user-custom" or asset.get("quoteSource") == "user-custom":
        return False
    if asset.get("fundCompany") == "FundX Public Market Adapter":
        return False
    return asset_kind(asset) in ("stock", "fund")


def asset_visible_to_user(asset: dict[str, Any], user_id: str) -> bool:
    if asset.get("assetType") != "customAsset":
        return True
    return (asset.get("userId") or LOCAL_USER_ID) == user_id


def build_search_result(assets: list[dict[str, Any]], input_data: dict[str, Any]) -> dict[str, Any]:
    tokens = tokenize(input_data["query"])
    asset_types = input_data.get("assetTypes")
    normalized_asset_types = {normalize_asset_type(item) for item in asset_types} if asset_types else None
    filtered = []
    for asset in assets:
        if input_data.get("marketId") and asset.get("marketId") != input_data["marketId"]:
            continue
        if is_excluded_china_theme_asset(asset):
            continue
        if normalized_asset_types and normalize_asset_type(asset.get("assetType")) not in normalized_asset_types:
            continue
        if input_data.get("industry") and input_data["industry"] not in (asset.get("industry"), asset.get("sector"), asset.get("category")):
            continue
        if input_data.get("fundType") and asset.get("fundType") != input_data["fundType"]:
            continue

        relevance = score_relevance(asset, tokens)
        if tokens and relevance <= 0:
            continue
        filtered.append(
            {
                **asset,
                "relevance": relevance,
                "riskProxy": risk_proxy(asset),
                "returnProxy": asset.get("dailyChange") if asset.get("dailyChange") is not None else -math.inf,
                "sizeProxy": asset.get("aum") or 0,
            }
        )

    sort = input_data["sort"]
    if sort == "size":
        sorted_assets = sorted(filtered, key=lambda asset: asset["sizeProxy"], reverse=True)
    elif sort == "return":
        sorted_assets = sorted(filtered, key=lambda asset: asset["returnProxy"], reverse=True)
    elif sort == "risk":
        sorted_assets = sorted(filtered, key=lambda asset: asset["riskProxy"])
    elif sort == "popularity":
        sorted_assets = sorted(filtered, key=lambda asset: asset.get("popularity") or 0, reverse=True)
    else:
        sorted_assets = sorted(filtered, key=lambda asset: (asset["relevance"], asset.get("popularity") or 0), reverse=True)

    facets = search_facets(sorted_assets)
    page = input_data["page"]
    page_size = input_data["pageSize"]
    start = (page - 1) * page_size
    items = [strip_search_private_fields(asset) for asset in sorted_assets[start : start + page_size]]
    total = len(sorted_assets)
    return {
        "items": items,
        "total": total,
        "page": page,
        "pageSize": page_size,
        "totalPages": max(1, math.ceil(total / page_size)),
        "stats": search_stats(sorted_assets),
        "facets": facets,
    }


def filter_assets_for_facets(assets: list[dict[str, Any]], asset_types: list[str] | None) -> list[dict[str, Any]]:
    normalized_asset_types = {normalize_asset_type(item) for item in asset_types} if asset_types else None
    if not normalized_asset_types:
        return assets
    return [asset for asset in assets if normalize_asset_type(asset.get("assetType")) in normalized_asset_types]


def search_stats(assets: list[dict[str, Any]]) -> dict[str, int]:
    funds = 0
    stocks = 0
    for asset in assets:
        if asset_kind(asset) == "fund":
            funds += 1
        elif asset_kind(asset) == "stock":
            stocks += 1
    return {"total": len(assets), "funds": funds, "stocks": stocks}


def search_facets(assets: list[dict[str, Any]]) -> dict[str, list[str]]:
    sectors = sorted({str(asset.get("sector")) for asset in assets if asset.get("sector")})
    industries = sorted({str(asset.get("industry")) for asset in assets if asset.get("industry")})
    fund_types = sorted({str(asset.get("fundType") or asset.get("fundSubtype")) for asset in assets if asset.get("fundType") or asset.get("fundSubtype")})
    return {"sectors": sectors, "industries": industries, "fundTypes": fund_types}


def search_facet_counts(assets: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    sectors: dict[str, int] = {}
    industries: dict[str, int] = {}
    fund_types: dict[str, int] = {}
    for asset in assets:
        for values, key in (
            (sectors, asset.get("sector")),
            (industries, asset.get("industry")),
            (fund_types, asset.get("fundType") or asset.get("fundSubtype")),
        ):
            if not key:
                continue
            normalized = str(key)
            values[normalized] = values.get(normalized, 0) + 1
    return {"sectors": sectors, "industries": industries, "fundTypes": fund_types}


def strip_search_private_fields(asset: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in asset.items() if key not in ("relevance", "riskProxy", "returnProxy", "sizeProxy")}


def get_cache_record(db: dict[str, Any], key: str, *, include_expired: bool = False) -> dict[str, Any] | None:
    now = now_iso()
    for item in db.get("cache", []):
        if item.get("key") != key:
            continue
        if include_expired or str(item.get("expiresAt", "")) > now:
            return item
    return None


def get_cached_value(db: dict[str, Any], key: str) -> Any | None:
    return (get_cache_record(db, key) or {}).get("value")


def market_top_cache_payload(cache_record: dict[str, Any] | None) -> dict[str, Any] | None:
    value = cache_record.get("value") if isinstance(cache_record, dict) else None
    if not isinstance(value, dict):
        return None
    if value.get("universe") != "full-market" or value.get("ranking") != "turnover":
        return None
    if not isinstance(value.get("items"), list):
        return None
    return value


def is_cache_record_recent(cache_record: dict[str, Any] | None, max_age_seconds: int) -> bool:
    if not isinstance(cache_record, dict):
        return False
    timestamp = str(cache_record.get("createdAt") or "")
    value = cache_record.get("value")
    if isinstance(value, dict) and value.get("updatedAt"):
        timestamp = str(value.get("updatedAt"))
    created_at = parse_iso_datetime(timestamp)
    if created_at is None:
        return False
    return (datetime.now(timezone.utc) - created_at).total_seconds() < max_age_seconds


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


def custom_fund_to_asset(fund: dict[str, Any]) -> dict[str, Any]:
    history = ((fund.get("score") or {}).get("backtestHistory") or [])
    latest = history[-1].get("value") if history else None
    previous = history[-2].get("value") if len(history) > 1 else latest
    daily_change = None if latest is None or previous in (None, 0) else ((latest - previous) / previous) * 100
    sector_exposure = ((fund.get("score") or {}).get("sectorExposure") or [])
    return {
        "id": fund.get("id"),
        "marketId": fund.get("marketId"),
        "assetType": "customFund",
        "name": fund.get("name"),
        "symbol": fund.get("id"),
        "aliases": [fund.get("name"), fund.get("id"), str(fund.get("name", "")).lower(), str(fund.get("id", "")).lower()],
        "industry": fund.get("style"),
        "sector": sector_exposure[0].get("name") if sector_exposure else None,
        "kind": "fund",
        "latestPrice": round(latest, 4) if isinstance(latest, (int, float)) else None,
        "latestVolume": None,
        "dailyChange": round(daily_change, 2) if isinstance(daily_change, (int, float)) else None,
        "popularity": 0,
        "source": "user-custom-fund",
        "quoteStatus": "missing" if latest is None else "fresh",
        "updatedAt": fund.get("updatedAt"),
    }


def unique_assets_by_id(assets: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    symbol_index: dict[str, int] = {}
    unique = []
    for asset in assets:
        asset_id = asset.get("id")
        if not asset_id or asset_id in seen:
            continue
        symbol_key = asset_symbol_dedupe_key(asset)
        if symbol_key and symbol_key in symbol_index:
            index = symbol_index[symbol_key]
            if asset_search_preference(asset) > asset_search_preference(unique[index]):
                unique[index] = asset
            seen.add(asset_id)
            continue
        seen.add(asset_id)
        if symbol_key:
            symbol_index[symbol_key] = len(unique)
        unique.append(asset)
    return unique


def asset_symbol_dedupe_key(asset: dict[str, Any]) -> str:
    market_id = str(asset.get("marketId") or "").lower()
    symbol = str(asset.get("symbol") or "").strip().upper()
    if not market_id or not symbol:
        return ""
    if market_id == "us":
        symbol = re.sub(r"[/-]", ".", symbol)
    return f"{market_id}:{asset_kind(asset)}:{symbol}"


def asset_search_preference(asset: dict[str, Any]) -> tuple[int, int, str]:
    has_fresh_quote = asset.get("quoteStatus") == "fresh" and isinstance(asset.get("latestPrice"), (int, float)) and asset.get("latestPrice") > 0
    return (1 if has_fresh_quote else 0, int(asset.get("popularity") or 0), str(asset.get("updatedAt") or ""))


def normalize_asset_type(asset_type: Any) -> str:
    return "fund" if asset_type == "etf" else str(asset_type)


def asset_kind(asset: dict[str, Any]) -> AssetKind:
    if asset.get("kind") in ("stock", "fund"):
        return asset["kind"]
    return "fund" if normalize_asset_type(asset.get("assetType")) == "fund" else "stock"


def normalize_asset_record(asset: dict[str, Any]) -> dict[str, Any]:
    with_kind = {**asset, "kind": asset_kind(asset)}
    return enrich_asset_classification(with_kind)


def tokenize(value: str) -> list[str]:
    return [token for token in re.split(r"[^a-z0-9\u4e00-\u9fa5]+", value.lower()) if token]


def score_relevance(asset: dict[str, Any], tokens: list[str]) -> int:
    if not tokens:
        return 1
    aliases = [alias for alias in asset.get("aliases", []) if alias]
    haystack = " ".join(
        str(item)
        for item in [
            asset.get("name"),
            asset.get("symbol"),
            asset.get("id"),
            asset.get("industry"),
            asset.get("sector"),
            asset.get("category"),
            asset.get("fundType"),
            asset.get("fundCompany"),
            *localized_asset_terms(asset),
            *aliases,
        ]
        if item
    ).lower()
    symbol = str(asset.get("symbol", "")).lower()
    asset_id = str(asset.get("id", "")).lower()
    name = str(asset.get("name", "")).lower()

    score = 0
    for token in tokens:
        if symbol == token:
            score += 120
        elif asset_id == token:
            score += 100
        elif token in name:
            score += 70
        elif any(token in str(alias).lower() for alias in aliases):
            score += 55
        elif token in haystack:
            score += 30
    return score


def localized_asset_terms(asset: dict[str, Any]) -> list[str]:
    terms: list[str] = []
    for value in (asset.get("sector"), asset.get("industry"), asset.get("category"), asset.get("fundType")):
        normalized = str(value or "").strip().lower()
        if normalized:
            terms.extend(LOCALIZED_ASSET_TERMS.get(normalized, []))
    return terms


LOCALIZED_ASSET_TERMS = {
    "technology": ["科技", "信息技术", "科技股", "技術"],
    "healthcare": ["医药", "医疗", "医疗保健", "醫療"],
    "financials": ["金融", "银行", "保险", "銀行"],
    "consumer staples": ["消费", "必需消费", "日常消费", "消費"],
    "consumer discretionary": ["可选消费", "消费", "非必需消费"],
    "industrials": ["工业", "制造", "工業"],
    "energy": ["能源", "石油", "油气"],
    "utilities": ["公用事业", "公用事業"],
    "communication services": ["通信", "传媒", "通讯"],
    "materials": ["材料", "原材料"],
    "real estate": ["地产", "房地产", "地產"],
    "large blend": ["大盘均衡", "大盤均衡", "宽基"],
    "large growth": ["大盘成长", "科技成长", "成長"],
    "large value": ["大盘价值", "价值", "價值"],
    "dividend": ["红利", "股息", "分红"],
    "low volatility": ["低波", "低波动", "低波動"],
    "treasury": ["国债", "短债", "现金管理"],
    "etf": ["基金", "交易型基金", "指数基金", "指數基金"],
    "mutual fund": ["共同基金", "基金"],
    "fund": ["基金"],
}


def risk_proxy(asset: dict[str, Any]) -> int:
    if asset.get("assetType") == "stock":
        return 50
    fund_type = str(asset.get("fundType") or "").lower()
    if "bond" in fund_type:
        return 15
    if "low" in fund_type:
        return 25
    return 35


def calculated_from_history(history: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "volatility": calculate_volatility(history),
        "drawdown": calculate_drawdown(history),
    }


def calculate_drawdown(history: list[dict[str, Any]]) -> dict[str, Any]:
    sorted_history = sort_history(history)
    if not sorted_history:
        return {
            "maxDrawdown": 0,
            "startDate": "",
            "bottomDate": "",
            "recoveryDate": None,
            "durationDays": 0,
            "drawdownHistory": [],
        }

    peak = number_or_zero(sorted_history[0].get("value"))
    peak_date = str(sorted_history[0].get("date", ""))
    max_drawdown = 0.0
    start_date = peak_date
    bottom_date = peak_date
    recovery_date = None
    drawdown_history = []

    for point in sorted_history:
        value = number_or_zero(point.get("value"))
        date = str(point.get("date", ""))
        if value > peak:
            peak = value
            peak_date = date
        drawdown = 0 if peak == 0 else ((value - peak) / peak) * 100
        drawdown_history.append({"date": date, "value": round_number(drawdown, 2)})
        if drawdown < max_drawdown:
            max_drawdown = drawdown
            start_date = peak_date
            bottom_date = date
            recovery_date = None
        if not recovery_date and max_drawdown < 0 and date > bottom_date and value >= peak:
            recovery_date = date

    return {
        "maxDrawdown": round_number(max_drawdown, 2),
        "startDate": start_date,
        "bottomDate": bottom_date,
        "recoveryDate": recovery_date,
        "durationDays": days_between(start_date, recovery_date or str(sorted_history[-1].get("date", ""))),
        "drawdownHistory": drawdown_history,
    }


def calculate_volatility(history: list[dict[str, Any]]) -> float:
    sorted_history = sort_history(history)
    if len(sorted_history) < 2:
        return 0
    returns = []
    for index, point in enumerate(sorted_history[1:]):
        previous = number_or_zero(sorted_history[index].get("value"))
        value = number_or_zero(point.get("value"))
        returns.append(0 if previous == 0 else (value - previous) / previous)
    average = sum(returns) / len(returns)
    variance = sum((value - average) ** 2 for value in returns) / len(returns)
    return round_number(math.sqrt(variance) * math.sqrt(252) * 100, 2)


def summarize_portfolio(portfolio: dict[str, Any]) -> dict[str, Any]:
    holdings = []
    for holding in portfolio.get("holdings", []):
        market_value = number_or_zero(holding.get("quantity")) * number_or_zero(holding.get("currentPrice"))
        cost = number_or_zero(holding.get("quantity")) * number_or_zero(holding.get("averageCost"))
        gain = market_value - cost
        holdings.append(
            {
                **holding,
                "marketValue": round_number(market_value, 2),
                "cost": round_number(cost, 2),
                "gain": round_number(gain, 2),
                "gainPercent": round_number(calculate_return(cost, market_value), 2),
                "currentWeight": 0,
                "targetGap": 0,
            }
        )
    invested_value = sum(number_or_zero(item.get("marketValue")) for item in holdings)
    total_value = invested_value + number_or_zero(portfolio.get("cashBalance"))
    total_cost = sum(number_or_zero(item.get("cost")) for item in holdings)
    total_gain = invested_value - total_cost
    return {
        "totalValue": round_number(total_value, 2),
        "totalCost": round_number(total_cost, 2),
        "totalGain": round_number(total_gain, 2),
        "totalGainPercent": round_number(calculate_return(total_cost, invested_value), 2),
        "annualizedReturn": 0,
        "cashBalance": number_or_zero(portfolio.get("cashBalance")),
        "maxDrawdown": 0,
        "volatility": 0,
        "sharpeRatio": 0,
        "riskScore": 30,
        "sectorExposure": [],
        "assetTypeExposure": [],
        "topHoldingConcentration": 0,
        "holdings": holdings,
        "valueHistory": [],
    }


def calculate_return(start_value: float, end_value: float) -> float:
    if start_value == 0:
        return 0
    return ((end_value - start_value) / start_value) * 100


def sort_history(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(history, key=lambda point: str(point.get("date", "")))


def days_between(start_date: str, end_date: str) -> int:
    try:
        start = datetime.fromisoformat(start_date[:10])
        end = datetime.fromisoformat(end_date[:10])
    except ValueError:
        return 0
    return (end - start).days


def healthy_insight_card() -> dict[str, Any]:
    return {
        "id": "insight-healthy",
        "title": "Portfolio balance looks healthy",
        "body": "No major concentration issue is above the FundX threshold.",
        "actionLabel": "Open insights",
        "tone": "positive",
        "targetWeight": 100,
    }


def tone_from_change(value: Any) -> str:
    if value is None:
        return "neutral"
    numeric = number_or_zero(value)
    if numeric > 0:
        return "positive"
    if numeric < 0:
        return "negative"
    return "neutral"


def format_currency(value: float, market_id: MarketId) -> str:
    return f"${number_or_zero(value):,.0f}"


def format_percent(value: float, digits: int = 1) -> str:
    numeric = number_or_zero(value)
    sign = "+" if numeric >= 0 else ""
    return f"{sign}{numeric:.{digits}f}%"


def number_or_zero(value: Any) -> float:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def round_number(value: float, digits: int = 2) -> float:
    return round(value + (1e-12 if value >= 0 else -1e-12), digits)


def json_stringify(value: dict[str, Any]) -> str:
    import json

    without_undefined = {key: item for key, item in value.items() if item is not None}
    return json.dumps(without_undefined, ensure_ascii=False, separators=(",", ":"))
