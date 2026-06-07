from __future__ import annotations

import json
import math
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Literal

from .asset_classification import is_excluded_china_theme_asset
from .data_sources import apply_quote
from .errors import FundXApiError
from .market_data_providers import DEFAULT_HISTORY_RANGE, MarketDataProviderManager, is_yahoo_exchange_suffix_symbol, normalize_code
from .services import (
    LOCAL_USER_ID,
    MarketId,
    asset_kind,
    get_cached_value,
    now_iso,
    read_db,
    record_audit,
    round_number,
    set_cached_value,
    update_db,
)

AssetKind = Literal["stock", "fund"]

DISCOVERY_CACHE_TTL_SECONDS = 900
UNIVERSE_CACHE_TTL_SECONDS = 60 * 60 * 12
DEFAULT_SEARCH_QUOTE_LIMIT = 0
DEFAULT_UNIVERSE_LIMIT = 20_000

YAHOO_SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search"
YAHOO_SCREENER_URL = "https://query1.finance.yahoo.com/v1/finance/screener"
NASDAQ_STOCK_SCREENER_URL = "https://api.nasdaq.com/api/screener/stocks"
NASDAQ_ETF_SCREENER_URL = "https://api.nasdaq.com/api/screener/etf"

US_HEADERS = {
    "Accept": "application/json,text/plain,*/*",
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 FundX/0.1 public-market-search",
}

NASDAQ_HEADERS = {
    **US_HEADERS,
    "Origin": "https://www.nasdaq.com",
    "Referer": "https://www.nasdaq.com/market-activity/stocks/screener",
}


def discover_assets_for_search(
    *,
    user_id: str = LOCAL_USER_ID,
    market_id: MarketId,
    query: str,
    kind: AssetKind | None,
    page_size: int,
    timeout_seconds: float | None = None,
) -> dict[str, Any] | None:
    query = query.strip()
    if len(query) < 2:
        return ensure_market_universe(user_id=user_id, market_id=market_id, kind=kind, timeout_seconds=timeout_seconds)

    cache_key = f"discovery:{user_id}:{market_id}:{kind or 'all'}:{query.lower()}:v1"
    cached = get_cached_value(read_db(), cache_key)
    if isinstance(cached, dict):
        return {**cached, "cached": True}

    timeout = timeout_seconds or discovery_timeout()
    try:
        assets = _search_us_assets(query, kind, timeout)
    except Exception as exc:
        return {"synced": 0, "source": "online-discovery", "failed": [{"source": "online-discovery", "reason": summarize_exception(exc)}]}

    assets = canonicalize_assets(read_db(), assets)
    quote_limit = min(max(0, parse_int_env("FUNDX_SEARCH_QUOTE_LIMIT", DEFAULT_SEARCH_QUOTE_LIMIT)), page_size)
    quotes = fetch_quotes_for_assets(user_id, market_id, assets[:quote_limit], timeout_seconds=timeout)
    result = upsert_discovered_assets(user_id=user_id, market_id=market_id, assets=assets, quotes=quotes, cache_key=cache_key, source="online-search")
    return result


def ensure_market_universe(
    *,
    user_id: str = LOCAL_USER_ID,
    market_id: MarketId,
    kind: AssetKind | None = None,
    timeout_seconds: float | None = None,
    force: bool = False,
) -> dict[str, Any] | None:
    cache_key = f"universe:{user_id}:{market_id}:{kind or 'all'}:v2"
    if not force:
        cached = get_cached_value(read_db(), cache_key)
        if isinstance(cached, dict):
            synced = cached.get("synced")
            if isinstance(synced, (int, float)) and synced > 0:
                return {**cached, "cached": True}

    timeout = timeout_seconds or discovery_timeout()
    try:
        assets = fetch_market_universe(market_id=market_id, kind=kind, timeout_seconds=timeout)
    except Exception as exc:
        return {"synced": 0, "source": "market-universe", "failed": [{"source": "market-universe", "reason": summarize_exception(exc)}]}
    if not assets:
        return {"synced": 0, "source": "market-universe", "failed": [{"source": "market-universe", "reason": "No assets were returned by the public market universe source."}]}

    result = upsert_discovered_assets(user_id=user_id, market_id=market_id, assets=canonicalize_assets(read_db(), assets), quotes=[], cache_key=cache_key, source="market-universe")
    return result


def fetch_market_universe(*, market_id: MarketId, kind: AssetKind | None = None, timeout_seconds: float) -> list[dict[str, Any]]:
    limit = parse_int_env("FUNDX_UNIVERSE_SYNC_LIMIT", DEFAULT_UNIVERSE_LIMIT)
    return fetch_us_universe(kind=kind, limit=limit, timeout_seconds=timeout_seconds)


def fetch_quotes_for_assets(
    user_id: str,
    market_id: MarketId,
    assets: list[dict[str, Any]],
    *,
    timeout_seconds: float,
) -> list[dict[str, Any]]:
    manager = MarketDataProviderManager(user_id=user_id)
    quotes: list[dict[str, Any]] = []
    for asset in assets:
        if asset.get("marketId") != market_id or asset.get("assetType") == "customAsset":
            continue
        try:
            quote = manager.fetch_quote(asset, range_value=DEFAULT_HISTORY_RANGE, interval="1d", timeout_seconds=timeout_seconds)
        except Exception:
            quote = None
        if quote:
            quotes.append(quote)
    return quotes


def upsert_discovered_assets(
    *,
    user_id: str,
    market_id: MarketId,
    assets: list[dict[str, Any]],
    quotes: list[dict[str, Any]],
    cache_key: str,
    source: str,
) -> dict[str, Any]:
    timestamp = now_iso()
    deduped_assets = dedupe_assets(assets)
    if source == "market-universe" and not deduped_assets:
        return {"synced": 0, "quoted": 0, "source": source, "updatedAt": timestamp, "failed": [{"source": source, "reason": "No assets were returned by the public market universe source."}]}
    quote_asset_ids = {str(quote.get("assetId")) for quote in quotes if quote.get("assetId")}

    def mutate(db: dict[str, Any]) -> None:
        ensure_asset_collections(db)
        preserve_zero_change = source == "market-universe"
        for asset in deduped_assets:
            upsert_security_master_record(db, asset, timestamp)
            upsert_asset_record(db, asset, timestamp, preserve_zero_change=preserve_zero_change)
            if asset_kind(asset) == "fund":
                upsert_fund_record(db, asset)
            else:
                upsert_stock_record(db, asset)
        for quote in quotes:
            apply_quote(db, quote)
        for asset in deduped_assets:
            if str(asset.get("id")) not in quote_asset_ids:
                mark_missing_quote(db, str(asset.get("id")), timestamp)
        payload = {
            "marketId": market_id,
            "synced": len(deduped_assets),
            "quoted": len(quotes),
            "source": source,
            "updatedAt": timestamp,
        }
        set_cached_value(db, cache_key, payload, DISCOVERY_CACHE_TTL_SECONDS if source == "online-search" else UNIVERSE_CACHE_TTL_SECONDS)
        record_audit(
            db,
            market_id,
            f"asset-discovery.{source}",
            "securityMaster",
            user_id=user_id,
            metadata={"synced": len(deduped_assets), "quoted": len(quotes), "source": source},
        )

    update_db(mutate)
    return {"synced": len(deduped_assets), "quoted": len(quotes), "source": source, "updatedAt": timestamp}


def canonicalize_assets(db: dict[str, Any], assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    existing: dict[tuple[str, str, str], dict[str, Any]] = {}
    for asset in db.get("assets", []):
        symbol = normalize_symbol_for_key(asset.get("symbol"), str(asset.get("marketId") or ""))
        kind = asset_kind(asset)
        if symbol and asset.get("marketId") == "us":
            existing[(str(asset.get("marketId")), kind, symbol)] = asset

    canonical: list[dict[str, Any]] = []
    for asset in assets:
        symbol_key = normalize_symbol_for_key(asset.get("symbol"), str(asset.get("marketId") or ""))
        current = existing.get((str(asset.get("marketId")), asset_kind(asset), symbol_key))
        if current:
            aliases = list(dict.fromkeys([*(current.get("aliases") or []), *(asset.get("aliases") or [])]))
            canonical.append({**asset, "id": current.get("id"), "aliases": aliases})
        else:
            canonical.append(asset)
    return canonical


def _search_us_assets(query: str, kind: AssetKind | None, timeout_seconds: float) -> list[dict[str, Any]]:
    params = urllib.parse.urlencode({"q": query, "quotesCount": "25", "newsCount": "0", "enableFuzzyQuery": "true"})
    payload = fetch_json(f"{YAHOO_SEARCH_URL}?{params}", timeout_seconds=timeout_seconds, headers=US_HEADERS)
    quotes = payload.get("quotes") if isinstance(payload.get("quotes"), list) else []
    assets = [yahoo_search_quote_to_asset(row) for row in quotes if isinstance(row, dict)]
    if kind:
        assets = [asset for asset in assets if asset and asset_kind(asset) == kind]
    return [asset for asset in assets if asset and not is_excluded_china_theme_asset(asset)]


def fetch_us_universe(*, kind: AssetKind | None, limit: int, timeout_seconds: float) -> list[dict[str, Any]]:
    assets: list[dict[str, Any]] = []
    if kind in (None, "stock"):
        try:
            assets.extend(nasdaq_rows_to_assets(fetch_nasdaq_rows(NASDAQ_STOCK_SCREENER_URL, 10_000, timeout_seconds), "stock", "nasdaq-stock-screener"))
        except Exception:
            pass
    if kind in (None, "fund"):
        for loader in (
            lambda: nasdaq_rows_to_assets(fetch_nasdaq_rows(NASDAQ_ETF_SCREENER_URL, 5_000, timeout_seconds), "fund", "nasdaq-etf-screener"),
            lambda: yahoo_screened_assets("ETF", min(250, limit), timeout_seconds),
            lambda: yahoo_screened_assets("MUTUALFUND", min(250, limit), timeout_seconds),
        ):
            try:
                assets.extend(loader())
            except Exception:
                pass
    return dedupe_assets(assets)[:limit]


def fetch_nasdaq_rows(endpoint: str, limit: int, timeout_seconds: float) -> list[dict[str, Any]]:
    params = urllib.parse.urlencode({"tableonly": "true", "limit": str(limit), "offset": "0", "download": "true"})
    payload = fetch_json(f"{endpoint}?{params}", timeout_seconds=timeout_seconds, headers=NASDAQ_HEADERS)
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    rows = data.get("rows") if isinstance(data.get("rows"), list) else []
    if not rows and isinstance(data.get("data"), dict):
        nested = data.get("data") or {}
        rows = nested.get("rows") if isinstance(nested.get("rows"), list) else []
    return [row for row in rows if isinstance(row, dict)]


def yahoo_screened_assets(quote_type: str, count: int, timeout_seconds: float) -> list[dict[str, Any]]:
    body = {
        "offset": 0,
        "size": count,
        "sortField": "intradaymarketcap",
        "sortType": "DESC",
        "quoteType": quote_type,
        "query": {
            "operator": "AND",
            "operands": [
                {"operator": "eq", "operands": ["region", "us"]},
                {"operator": "eq", "operands": ["quoteType", quote_type]},
            ],
        },
        "userId": "",
        "userIdType": "guid",
    }
    payload = fetch_json(YAHOO_SCREENER_URL, timeout_seconds=timeout_seconds, headers=US_HEADERS, method="POST", body=body)
    finance = payload.get("finance") if isinstance(payload.get("finance"), dict) else {}
    results = finance.get("result") if isinstance(finance.get("result"), list) else []
    rows: list[dict[str, Any]] = []
    for result in results:
        if isinstance(result, dict) and isinstance(result.get("quotes"), list):
            rows.extend(item for item in result["quotes"] if isinstance(item, dict))
    return [asset for asset in (yahoo_search_quote_to_asset(row) for row in rows) if asset]


def yahoo_search_quote_to_asset(row: dict[str, Any]) -> dict[str, Any] | None:
    symbol = clean_symbol(row.get("symbol"))
    if not symbol or symbol.startswith("^"):
        return None
    if is_yahoo_exchange_suffix_symbol(symbol):
        return None
    quote_type = str(row.get("quoteType") or row.get("quoteTypeDisp") or "").upper()
    kind: AssetKind | None = "stock" if quote_type == "EQUITY" else "fund" if quote_type in {"ETF", "MUTUALFUND"} else None
    if not kind:
        return None
    name = str(row.get("longname") or row.get("shortname") or row.get("longName") or row.get("shortName") or symbol).strip()
    price = quote_number(row, "regularMarketPrice", "postMarketPrice")
    volume = quote_number(row, "regularMarketVolume", "regularMarketDayVolume", "dayvolume", "volume")
    change = quote_number(row, "regularMarketChangePercent", "regularMarketPercentChange")
    dividend_yield = quote_number(row, "trailingAnnualDividendYield", "dividendYield", "yield", "dividendYieldPercent")
    fetched_at = now_iso()
    return {
        "id": f"us-{kind}-{id_part(symbol)}",
        "marketId": "us",
        "assetType": "fund" if kind == "fund" else "stock",
        "kind": kind,
        **({"fundSubtype": "etf" if quote_type == "ETF" else "mutual_fund"} if kind == "fund" else {}),
        "name": name,
        "symbol": symbol,
        "exchange": str(row.get("exchDisp") or row.get("fullExchangeName") or row.get("exchange") or "").strip() or None,
        "aliases": aliases(name, symbol, row.get("name"), row.get("shortname"), row.get("longname")),
        "industry": str(row.get("industry") or "").strip() or None,
        "sector": str(row.get("sector") or "").strip() or None,
        "category": str(row.get("typeDisp") or quote_type).strip() or None,
        "fundType": "ETF" if quote_type == "ETF" else "Mutual fund" if quote_type == "MUTUALFUND" else None,
        "latestPrice": round_number(price, 4) if price is not None and price > 0 else None,
        "latestVolume": int(volume) if volume is not None and volume > 0 else None,
        "latestTurnover": round_number(price * volume, 2) if price and volume else None,
        "dailyChange": round_number(change, 2) if change is not None else None,
        "dividendYield": round_number(dividend_yield, 4) if dividend_yield is not None else None,
        "dividends": [],
        "popularity": 0,
        "source": "market-discovery",
        "sourceName": "Yahoo Finance Search",
        "sourceUrl": "https://finance.yahoo.com/lookup",
        "isTradable": True,
        "quoteSource": "yahoo-search" if price is not None and price > 0 else None,
        "quoteFetchedAt": fetched_at if price is not None and price > 0 else None,
        "quoteStatus": "fresh" if price is not None and price > 0 else "missing",
        "updatedAt": fetched_at,
    }


def nasdaq_rows_to_assets(rows: list[dict[str, Any]], kind: AssetKind, source_name: str) -> list[dict[str, Any]]:
    assets = []
    for row in rows:
        symbol = clean_symbol(row.get("symbol"))
        if not symbol:
            continue
        name = str(row.get("name") or row.get("securityName") or row.get("companyName") or symbol).strip()
        price = parse_number(row.get("lastsale") or row.get("lastSale") or row.get("lastSalePrice"))
        volume = parse_number(row.get("volume"))
        change = parse_number(row.get("pctchange") or row.get("pctChange") or row.get("percentageChange"))
        dividend_yield = parse_number(row.get("dividendYield") or row.get("yield"))
        fetched_at = now_iso()
        assets.append(
            {
                "id": f"us-{kind}-{id_part(symbol)}",
                "marketId": "us",
                "assetType": "fund" if kind == "fund" else "stock",
                "kind": kind,
                **({"fundSubtype": "etf", "fundType": "ETF"} if kind == "fund" else {}),
                "name": name,
                "symbol": symbol,
                "exchange": str(row.get("exchange") or "NASDAQ").strip() or None,
                "aliases": aliases(name, symbol),
                "category": "ETF" if kind == "fund" else str(row.get("marketCategory") or "").strip() or None,
                "latestPrice": round_number(price, 4) if price is not None and price > 0 else None,
                "latestVolume": int(volume) if volume is not None and volume > 0 else None,
                "latestTurnover": round_number(price * volume, 2) if price and volume else None,
                "dailyChange": round_number(change, 2) if change is not None else None,
                "dividendYield": round_number(dividend_yield, 4) if dividend_yield is not None else None,
                "dividends": [],
                "popularity": 0,
                "source": "market-discovery",
                "sourceName": source_name,
                "sourceUrl": "https://www.nasdaq.com/market-activity/stocks/screener" if kind == "stock" else "https://www.nasdaq.com/market-activity/funds-and-etfs",
                "isTradable": True,
                "quoteSource": source_name if price is not None and price > 0 else None,
                "quoteFetchedAt": fetched_at if price is not None and price > 0 else None,
                "quoteStatus": "fresh" if price is not None and price > 0 else "missing",
                "updatedAt": fetched_at,
            }
        )
    return assets


def upsert_security_master_record(db: dict[str, Any], asset: dict[str, Any], timestamp: str) -> None:
    record = {
        "id": asset.get("id"),
        "marketId": asset.get("marketId"),
        "kind": asset_kind(asset),
        **({"fundSubtype": asset.get("fundSubtype")} if asset.get("fundSubtype") else {}),
        "symbol": asset.get("symbol"),
        "exchange": asset.get("exchange") or "",
        "name": asset.get("name"),
        "sector": asset.get("sector"),
        "industry": asset.get("industry"),
        "category": asset.get("category") or asset.get("fundType"),
        "fundCompany": asset.get("fundCompany"),
        "sourceName": asset.get("sourceName") or "Market discovery",
        "sourceUrl": asset.get("sourceUrl") or "",
        "sourceAsOf": timestamp[:10],
        "isTradable": asset.get("isTradable") is not False,
        "aliases": asset.get("aliases") or [],
    }
    upsert_collection_item(db, "securityMaster", record)


def upsert_asset_record(db: dict[str, Any], asset: dict[str, Any], timestamp: str, *, preserve_zero_change: bool = False) -> None:
    clean = {key: value for key, value in asset.items() if value is not None}
    clean.setdefault("updatedAt", timestamp)
    clean.setdefault("quoteStatus", "missing")
    if preserve_zero_change and numeric_zero(clean.get("dailyChange")):
        existing = next((item for item in db.get("assets", []) if item.get("id") == asset.get("id")), None)
        if existing and numeric_nonzero(existing.get("dailyChange")):
            clean.pop("dailyChange", None)
    upsert_collection_item(db, "assets", clean, merge=merge_asset_records)


def upsert_fund_record(db: dict[str, Any], asset: dict[str, Any]) -> None:
    fund = {
        "id": asset.get("id"),
        "marketId": asset.get("marketId"),
        "name": asset.get("name"),
        "symbol": asset.get("symbol"),
        "type": asset.get("fundType") or asset.get("fundSubtype") or "Fund",
        "category": asset.get("category") or asset.get("sector") or "Unclassified",
        "style": asset.get("category") or asset.get("sector") or "Unclassified",
        "nav": asset.get("latestPrice"),
        "dailyChange": asset.get("dailyChange"),
        "oneYearReturn": None,
        "threeYearAnnualizedReturn": None,
        "fiveYearAnnualizedReturn": None,
        "totalReturn": None,
        "maxDrawdown": None,
        "volatility": None,
        "sharpeRatio": None,
        "expenseRatio": asset.get("expenseRatio"),
        "fundCompany": asset.get("fundCompany"),
        "dividendYield": asset.get("dividendYield"),
        "aum": asset.get("aum"),
        "riskLevel": "Balanced",
        "holdings": [],
        "sectorExposure": [],
        "navHistory": [],
        "dividends": asset.get("dividends") if isinstance(asset.get("dividends"), list) else [],
    }
    upsert_collection_item(db, "funds", fund, merge=merge_sparse_records)


def upsert_stock_record(db: dict[str, Any], asset: dict[str, Any]) -> None:
    stock = {
        "id": asset.get("id"),
        "marketId": asset.get("marketId"),
        "name": asset.get("name"),
        "symbol": asset.get("symbol"),
        "sector": asset.get("sector") or "Unclassified",
        "industry": asset.get("industry") or "Unclassified",
        "price": asset.get("latestPrice"),
        "dailyChange": asset.get("dailyChange"),
        "marketCap": None,
        "peRatio": None,
        "pbRatio": None,
        "dividendYield": asset.get("dividendYield"),
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
        "priceHistory": [],
        "dividends": asset.get("dividends") if isinstance(asset.get("dividends"), list) else [],
    }
    upsert_collection_item(db, "stocks", stock, merge=merge_sparse_records)


def mark_missing_quote(db: dict[str, Any], asset_id: str, timestamp: str) -> None:
    asset = next((item for item in db.get("assets", []) if item.get("id") == asset_id), None)
    if not asset:
        return
    if asset.get("quoteStatus") == "fresh" and asset.get("latestPrice") is not None:
        return
    asset["quoteStatus"] = "missing"
    asset["latestPrice"] = None
    asset["dailyChange"] = None
    asset["updatedAt"] = timestamp


def upsert_collection_item(db: dict[str, Any], collection: str, item: dict[str, Any], merge: Any | None = None) -> None:
    item_id = item.get("id")
    if not item_id:
        return
    db.setdefault(collection, [])
    for index, existing in enumerate(db[collection]):
        if existing.get("id") == item_id:
            db[collection][index] = merge(existing, item) if merge else {**existing, **item}
            return
    db[collection].append(item)


def merge_asset_records(existing: dict[str, Any], item: dict[str, Any]) -> dict[str, Any]:
    merged = {**existing, **item}
    if item.get("quoteStatus") != "fresh" and existing.get("quoteStatus") == "fresh":
        for key in ("latestPrice", "latestVolume", "latestTurnover", "dailyChange", "quoteSource", "quoteFetchedAt", "quoteStatus"):
            if existing.get(key) is not None:
                merged[key] = existing[key]
    if numeric_zero(item.get("dailyChange")) and numeric_nonzero(existing.get("dailyChange")) and str(item.get("sourceName") or "").startswith(("nasdaq-", "Yahoo Finance")):
        merged["dailyChange"] = existing["dailyChange"]
    if item.get("dividends") == [] and existing.get("dividends") not in (None, [], ""):
        merged["dividends"] = existing["dividends"]
    merged["aliases"] = list(dict.fromkeys([*(existing.get("aliases") or []), *(item.get("aliases") or [])]))
    return merged


def numeric_zero(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and abs(float(value)) < 0.000001


def numeric_nonzero(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and abs(float(value)) >= 0.000001


def merge_sparse_records(existing: dict[str, Any], item: dict[str, Any]) -> dict[str, Any]:
    merged = dict(existing)
    for key, value in item.items():
        if value in (None, [], "") and existing.get(key) not in (None, [], ""):
            continue
        merged[key] = value
    return merged


def ensure_asset_collections(db: dict[str, Any]) -> None:
    for key in ("securityMaster", "assets", "funds", "stocks", "dailyPrices", "auditEvents", "cache"):
        db.setdefault(key, [])


def dedupe_assets(assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[str, str, str]] = set()
    result: list[dict[str, Any]] = []
    for asset in assets:
        if not asset or asset.get("marketId") != "us":
            continue
        if is_excluded_china_theme_asset(asset):
            continue
        symbol = normalize_symbol_for_key(asset.get("symbol"), str(asset.get("marketId")))
        key = (str(asset.get("marketId")), asset_kind(asset), symbol)
        if not symbol or key in seen:
            continue
        seen.add(key)
        result.append(asset)
    return result


def fetch_json(
    url: str,
    *,
    timeout_seconds: float,
    headers: dict[str, str],
    method: str = "GET",
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            if response.status < 200 or response.status >= 300:
                raise ValueError(f"HTTP {response.status}")
            return json.loads(response.read().decode("utf-8-sig"))
    except urllib.error.HTTPError as exc:
        raise ValueError(f"HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise ValueError(str(exc.reason)) from exc


def quote_number(row: dict[str, Any], *keys: str) -> float | None:
    for key in keys:
        value = row.get(key)
        if isinstance(value, dict):
            parsed = parse_number(value.get("raw"))
            if parsed is None:
                parsed = parse_number(value.get("fmt"))
        else:
            parsed = parse_number(value)
        if parsed is not None:
            return parsed
    return None


def parse_number(value: Any) -> float | None:
    if isinstance(value, bool) or value in (None, "", "-", "--", "N/A"):
        return None
    if isinstance(value, (int, float)):
        parsed = float(value)
    else:
        text = str(value).strip()
        multiplier = 1.0
        if text.endswith("%"):
            text = text[:-1]
        if text.endswith(("K", "k")):
            multiplier = 1_000
            text = text[:-1]
        elif text.endswith(("M", "m")):
            multiplier = 1_000_000
            text = text[:-1]
        elif text.endswith(("B", "b")):
            multiplier = 1_000_000_000
            text = text[:-1]
        text = re.sub(r"[^0-9.+-]", "", text)
        if text in ("", "+", "-"):
            return None
        try:
            parsed = float(text) * multiplier
        except ValueError:
            return None
    if math.isnan(parsed) or math.isinf(parsed):
        return None
    return parsed


def clean_symbol(value: Any) -> str:
    return str(value or "").strip().upper()


def id_part(symbol: str) -> str:
    return re.sub(r"[^A-Z0-9]+", "-", symbol.upper()).strip("-").lower()


def aliases(*values: Any) -> list[str]:
    return list(dict.fromkeys(str(value).strip() for value in values if value and str(value).strip()))


def normalize_symbol_for_key(value: Any, market_id: str) -> str:
    symbol = clean_symbol(value)
    if market_id == "us":
        return re.sub(r"[/-]", ".", symbol)
    return symbol


def tokenize(value: str) -> list[str]:
    return [token for token in re.split(r"[^a-z0-9]+", value.lower()) if token]


def searchable_text(asset: dict[str, Any]) -> str:
    return " ".join(
        str(value).lower()
        for value in [
            asset.get("name"),
            asset.get("symbol"),
            asset.get("exchange"),
            asset.get("industry"),
            asset.get("sector"),
            asset.get("category"),
            asset.get("fundType"),
            *(asset.get("aliases") or []),
        ]
        if value
    )


def discovery_timeout() -> float:
    return float(parse_int_env("FUNDX_DISCOVERY_TIMEOUT_SECONDS", 3))


def parse_int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


def summarize_exception(exc: Exception) -> str:
    if isinstance(exc, FundXApiError):
        return exc.message
    return " ".join((str(exc).strip() or type(exc).__name__).split())
