from __future__ import annotations

import json
import gzip
import html
import math
import re
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .asset_classification import is_excluded_china_theme_asset
from .services import AssetKind, MarketId, now_iso, round_number

FULL_MARKET_UNIVERSE = "full-market"
MARKET_TOP_RANKING = "turnover"
MARKET_TOP_CACHE_TTL_SECONDS = 600

YAHOO_HEADERS = {
    "Accept": "application/json,text/plain,*/*",
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 FundX/0.1 market-screener",
}

YAHOO_PAGE_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36 FundX/0.1",
}

NASDAQ_HEADERS = {
    "Accept": "application/json,text/plain,*/*",
    "Origin": "https://www.nasdaq.com",
    "Referer": "https://www.nasdaq.com/market-activity/funds-and-etfs",
    "User-Agent": "Mozilla/5.0 FundX/0.1 nasdaq-etf-screener",
}

YAHOO_MOST_ACTIVE_ETFS_URL = "https://finance.yahoo.com/markets/etfs/most-active/"
US_HIGH_TURNOVER_ETF_SEEDS = [
    "SPY",
    "QQQ",
    "VOO",
    "IVV",
    "IWM",
    "VTI",
    "SOXL",
    "TQQQ",
    "SQQQ",
    "SMH",
    "IBIT",
    "BITO",
    "XLF",
    "XLE",
    "XLK",
    "TLT",
    "HYG",
    "EEM",
    "EFA",
    "GLD",
    "SLV",
    "ARKK",
    "TSLL",
    "SOXS",
    "TZA",
]


def market_top_cache_key(market_id: MarketId, kind: AssetKind) -> str:
    return f"market-top:{market_id}:{kind}:{MARKET_TOP_RANKING}:{FULL_MARKET_UNIVERSE}:v2"


def fetch_full_market_top_assets(
    *,
    market_id: MarketId,
    kind: AssetKind,
    limit: int = 10,
    timeout_seconds: float = 10,
) -> dict[str, Any]:
    failures: list[dict[str, str]] = []
    sources: list[str] = []
    candidates, sources = _fetch_us_candidates(kind, limit, timeout_seconds, failures)

    items = _rank_full_market_assets(candidates, limit)
    updated_at = now_iso()
    source = ",".join(dict.fromkeys(sources)) if sources else f"market-screener:{market_id}:no-data"
    return {
        "marketId": market_id,
        "kind": kind,
        "count": len(items),
        "items": items,
        "source": source,
        "updatedAt": updated_at,
        "universe": FULL_MARKET_UNIVERSE,
        "ranking": MARKET_TOP_RANKING,
        "failed": failures,
    }


def _fetch_us_candidates(
    kind: AssetKind,
    limit: int,
    timeout_seconds: float,
    failures: list[dict[str, str]],
) -> tuple[list[dict[str, Any]], list[str]]:
    candidates: list[dict[str, Any]] = []
    sources: list[str] = []
    fetch_size = max(250, limit * 30)

    if kind == "stock":
        _extend_from_loader(
            candidates,
            sources,
            failures,
            source="nasdaq-stock-screener",
            loader=lambda: _fetch_nasdaq_stock_rows(timeout_seconds),
            mapper=_nasdaq_stock_row_to_asset,
        )
        _extend_from_loader(
            candidates,
            sources,
            failures,
            source="yahoo-most-actives",
            loader=lambda: _fetch_yahoo_predefined_quotes("most_actives", fetch_size, timeout_seconds),
            mapper=lambda row: _yahoo_quote_to_asset(row, kind="stock", source="yahoo-most-actives"),
        )
        _extend_from_loader(
            candidates,
            sources,
            failures,
            source="yahoo-equity-screener",
            loader=lambda: _fetch_yahoo_screened_quotes("EQUITY", fetch_size, timeout_seconds),
            mapper=lambda row: _yahoo_quote_to_asset(row, kind="stock", source="yahoo-equity-screener"),
        )
    else:
        _extend_from_loader(
            candidates,
            sources,
            failures,
            source="yahoo-most-active-etfs-page",
            loader=lambda: _fetch_yahoo_most_active_etf_records(timeout_seconds),
            mapper=_yahoo_most_active_etf_record_to_asset,
        )
        _extend_from_loader(
            candidates,
            sources,
            failures,
            source="yahoo-etf-quote-pages",
            loader=lambda: _fetch_yahoo_seed_etf_quote_rows(timeout_seconds),
            mapper=_yahoo_quote_page_etf_row_to_asset,
        )
        _extend_from_loader(
            candidates,
            sources,
            failures,
            source="yahoo-etf-screener",
            loader=lambda: _fetch_yahoo_screened_quotes("ETF", fetch_size, timeout_seconds),
            mapper=lambda row: _yahoo_quote_to_asset(row, kind="fund", source="yahoo-etf-screener"),
        )
        _extend_from_loader(
            candidates,
            sources,
            failures,
            source="nasdaq-etf-screener",
            loader=lambda: _fetch_nasdaq_etf_rows(timeout_seconds),
            mapper=_nasdaq_etf_row_to_asset,
        )

    return candidates, sources


def _extend_from_loader(
    candidates: list[dict[str, Any]],
    sources: list[str],
    failures: list[dict[str, str]],
    *,
    source: str,
    loader: Any,
    mapper: Any,
) -> None:
    try:
        rows = loader()
    except Exception as exc:
        failures.append({"source": source, "reason": _summarize_exception(exc)})
        return

    before = len(candidates)
    for row in rows:
        asset = mapper(row)
        if asset is not None and not is_excluded_china_theme_asset(asset):
            candidates.append(asset)
    if len(candidates) > before:
        sources.append(source)
    else:
        failures.append({"source": source, "reason": "No tradable rows with current price and volume were returned."})


def _fetch_yahoo_predefined_quotes(scr_id: str, count: int, timeout_seconds: float) -> list[dict[str, Any]]:
    params = urllib.parse.urlencode(
        {
            "formatted": "false",
            "lang": "en-US",
            "region": "US",
            "scrIds": scr_id,
            "count": str(count),
        }
    )
    payload = _fetch_json(f"https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?{params}", timeout_seconds=timeout_seconds, headers=YAHOO_HEADERS)
    return _yahoo_quotes_from_payload(payload)


def _fetch_yahoo_screened_quotes(quote_type: str, count: int, timeout_seconds: float) -> list[dict[str, Any]]:
    body = {
        "offset": 0,
        "size": min(count, 250),
        "sortField": "dayvolume",
        "sortType": "DESC",
        "quoteType": quote_type,
        "query": {
            "operator": "AND",
            "operands": [
                {"operator": "eq", "operands": ["region", "us"]},
                {"operator": "eq", "operands": ["quoteType", quote_type]},
                {"operator": "gt", "operands": ["dayvolume", 0]},
            ],
        },
        "userId": "",
        "userIdType": "guid",
    }
    last_error: Exception | None = None
    for endpoint in ("https://query1.finance.yahoo.com/v1/finance/screener", "https://query2.finance.yahoo.com/v1/finance/screener"):
        try:
            payload = _fetch_json(endpoint, timeout_seconds=timeout_seconds, headers=YAHOO_HEADERS, method="POST", body=body)
            return _yahoo_quotes_from_payload(payload)
        except Exception as exc:
            last_error = exc
    raise ValueError(_summarize_exception(last_error or ValueError("Yahoo screener failed.")))


def _fetch_nasdaq_etf_rows(timeout_seconds: float) -> list[dict[str, Any]]:
    params = urllib.parse.urlencode({"tableonly": "true", "limit": "5000", "offset": "0", "download": "true"})
    payload = _fetch_json(f"https://api.nasdaq.com/api/screener/etf?{params}", timeout_seconds=timeout_seconds, headers=NASDAQ_HEADERS)
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    rows = data.get("rows") if isinstance(data.get("rows"), list) else []
    if not rows and isinstance(data.get("data"), dict):
        nested = data.get("data") or {}
        rows = nested.get("rows") if isinstance(nested.get("rows"), list) else []
    return [row for row in rows if isinstance(row, dict)]


def _fetch_nasdaq_stock_rows(timeout_seconds: float) -> list[dict[str, Any]]:
    params = urllib.parse.urlencode({"tableonly": "true", "limit": "10000", "offset": "0", "download": "true"})
    payload = _fetch_json(f"https://api.nasdaq.com/api/screener/stocks?{params}", timeout_seconds=timeout_seconds, headers=NASDAQ_HEADERS)
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    rows = data.get("rows") if isinstance(data.get("rows"), list) else []
    return [row for row in rows if isinstance(row, dict)]


def _fetch_yahoo_most_active_etf_records(timeout_seconds: float) -> list[dict[str, Any]]:
    page = _fetch_text(YAHOO_MOST_ACTIVE_ETFS_URL, timeout_seconds=timeout_seconds, headers=YAHOO_PAGE_HEADERS)
    pattern = re.compile(
        r'<script[^>]+data-sveltekit-fetched[^>]+data-url="[^"]*MOST_ACTIVES_ETFS[^"]*"[^>]*>(.*?)</script>',
        re.DOTALL,
    )
    match = pattern.search(page)
    if not match:
        raise ValueError("Yahoo Most Active ETFs page did not include an embedded screener payload.")
    try:
        outer = json.loads(html.unescape(match.group(1)))
        body = json.loads(outer.get("body") or "{}")
    except json.JSONDecodeError as exc:
        raise ValueError("Yahoo Most Active ETFs embedded payload was not valid JSON.") from exc
    finance = body.get("finance") if isinstance(body.get("finance"), dict) else {}
    results = finance.get("result") if isinstance(finance.get("result"), list) else []
    for result in results:
        if not isinstance(result, dict) or result.get("canonicalName") != "MOST_ACTIVES_ETFS":
            continue
        records = result.get("records") if isinstance(result.get("records"), list) else []
        return [record for record in records if isinstance(record, dict)]
    return []


def _fetch_yahoo_seed_etf_quote_rows(timeout_seconds: float) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    per_request_timeout = max(4.0, min(timeout_seconds, 8.0))
    with ThreadPoolExecutor(max_workers=6) as executor:
        futures = {
            executor.submit(_fetch_yahoo_single_etf_quote_row, symbol, per_request_timeout): symbol
            for symbol in US_HIGH_TURNOVER_ETF_SEEDS
        }
        for future in as_completed(futures):
            try:
                row = future.result()
            except Exception:
                continue
            if row:
                rows.append(row)
    return rows


def _fetch_yahoo_single_etf_quote_row(symbol: str, timeout_seconds: float) -> dict[str, Any] | None:
    clean_symbol = _clean_symbol(symbol)
    if not clean_symbol:
        return None
    page = _fetch_text(
        f"https://finance.yahoo.com/quote/{urllib.parse.quote(clean_symbol)}/",
        timeout_seconds=timeout_seconds,
        headers=YAHOO_PAGE_HEADERS,
    )
    price = _first_regex_number(page, r'data-testid="qsp-price">([^<]+)<')
    change_percent = _first_regex_number(page, r'data-testid="qsp-price-change-percent">\(?([+-]?[0-9.,]+)%\)?\s*<')
    volume = _streamer_data_value(page, "regularMarketVolume")
    name = _first_regex_text(page, r'data-url="https://query1\.finance\.yahoo\.com/v1/finance/quoteType/[^"]+"[^>]*>(.*?)</script>')
    resolved_name = clean_symbol
    if name:
        try:
            outer = json.loads(html.unescape(name))
            body = json.loads(outer.get("body") or "{}")
            quote_type = body.get("quoteType") if isinstance(body.get("quoteType"), dict) else {}
            results = quote_type.get("result") if isinstance(quote_type.get("result"), list) else []
            quote = next((item for item in results if isinstance(item, dict) and _clean_symbol(item.get("symbol")) == clean_symbol), None)
            resolved_name = str((quote or {}).get("longName") or (quote or {}).get("shortName") or clean_symbol).strip()
        except (json.JSONDecodeError, TypeError, ValueError):
            resolved_name = clean_symbol
    if price is None or price <= 0 or volume is None or volume <= 0:
        return None
    return {
        "symbol": clean_symbol,
        "name": resolved_name,
        "price": price,
        "volume": volume,
        "changePercent": change_percent,
        "exchange": None,
    }


def _yahoo_quotes_from_payload(payload: dict[str, Any]) -> list[dict[str, Any]]:
    finance = payload.get("finance") if isinstance(payload.get("finance"), dict) else {}
    results = finance.get("result") if isinstance(finance.get("result"), list) else []
    quotes: list[dict[str, Any]] = []
    for result in results:
        if not isinstance(result, dict):
            continue
        result_quotes = result.get("quotes") if isinstance(result.get("quotes"), list) else []
        quotes.extend(row for row in result_quotes if isinstance(row, dict))
    return quotes


def _yahoo_most_active_etf_record_to_asset(row: dict[str, Any]) -> dict[str, Any] | None:
    symbol = _clean_symbol(row.get("ticker") or row.get("symbol"))
    if not symbol:
        return None
    price = _raw_number(row.get("regularMarketPrice"))
    volume = _raw_number(row.get("regularMarketVolume"))
    if price is None or price <= 0 or volume is None or volume <= 0:
        return None
    name = str(row.get("companyName") or row.get("longName") or row.get("shortName") or symbol).strip()
    change_percent = _raw_number(row.get("regularMarketChangePercent"))
    exchange = str(row.get("exchange") or "").strip() or None
    fetched_at = now_iso()
    return {
        "id": f"market-top-us-fund-{_id_part(symbol)}",
        "marketId": "us",
        "assetType": "fund",
        "kind": "fund",
        "fundSubtype": "etf",
        "fundType": "ETF",
        "name": name,
        "symbol": symbol,
        "exchange": exchange,
        "aliases": [symbol, symbol.lower(), name],
        "category": "ETF",
        "latestPrice": round_number(price, 4),
        "latestVolume": int(volume),
        "latestTurnover": round_number(price * volume, 2),
        "dailyChange": round_number(change_percent, 2) if change_percent is not None else None,
        "popularity": 0,
        "source": "market-screener",
        "sourceName": "yahoo-most-active-etfs-page",
        "sourceUrl": YAHOO_MOST_ACTIVE_ETFS_URL,
        "isTradable": True,
        "quoteSource": "yahoo-most-active-etfs-page",
        "quoteFetchedAt": fetched_at,
        "quoteStatus": "fresh",
        "updatedAt": fetched_at,
    }


def _yahoo_quote_page_etf_row_to_asset(row: dict[str, Any]) -> dict[str, Any] | None:
    symbol = _clean_symbol(row.get("symbol"))
    price = _parse_number(row.get("price"))
    volume = _parse_number(row.get("volume"))
    if not symbol or price is None or price <= 0 or volume is None or volume <= 0:
        return None
    name = str(row.get("name") or symbol).strip()
    change_percent = _parse_number(row.get("changePercent"))
    fetched_at = now_iso()
    return {
        "id": f"market-top-us-fund-{_id_part(symbol)}",
        "marketId": "us",
        "assetType": "fund",
        "kind": "fund",
        "fundSubtype": "etf",
        "fundType": "ETF",
        "name": name,
        "symbol": symbol,
        "exchange": str(row.get("exchange") or "").strip() or None,
        "aliases": [symbol, symbol.lower(), name],
        "category": "ETF",
        "latestPrice": round_number(price, 4),
        "latestVolume": int(volume),
        "latestTurnover": round_number(price * volume, 2),
        "dailyChange": round_number(change_percent, 2) if change_percent is not None else None,
        "popularity": 0,
        "source": "market-screener",
        "sourceName": "yahoo-etf-quote-pages",
        "sourceUrl": f"https://finance.yahoo.com/quote/{urllib.parse.quote(symbol)}/",
        "isTradable": True,
        "quoteSource": "yahoo-etf-quote-pages",
        "quoteFetchedAt": fetched_at,
        "quoteStatus": "fresh",
        "updatedAt": fetched_at,
    }


def _yahoo_quote_to_asset(row: dict[str, Any], *, kind: AssetKind, source: str) -> dict[str, Any] | None:
    symbol = _clean_symbol(row.get("symbol"))
    if not symbol or symbol.startswith("^"):
        return None
    quote_type = str(row.get("quoteType") or "").upper()
    if kind == "stock" and quote_type and quote_type != "EQUITY":
        return None
    if kind == "fund" and quote_type and quote_type not in {"ETF", "MUTUALFUND"}:
        return None

    price = _quote_number(row, "regularMarketPrice", "postMarketPrice")
    volume = _quote_number(row, "regularMarketVolume", "regularMarketDayVolume", "dayvolume", "volume")
    if price is None or price <= 0 or volume is None or volume <= 0:
        return None

    name = str(row.get("shortName") or row.get("longName") or row.get("displayName") or symbol).strip()
    change_percent = _quote_number(row, "regularMarketChangePercent", "regularMarketPercentChange")
    fetched_at = now_iso()
    asset_type = "stock" if kind == "stock" else "fund"
    return {
        "id": f"market-top-us-{kind}-{_id_part(symbol)}",
        "marketId": "us",
        "assetType": asset_type,
        "kind": kind,
        **({"fundSubtype": "etf"} if kind == "fund" else {}),
        "name": name,
        "symbol": symbol,
        "exchange": str(row.get("fullExchangeName") or row.get("exchange") or "").strip() or None,
        "aliases": [symbol, symbol.lower(), name],
        "industry": str(row.get("industry") or "").strip() or None,
        "sector": str(row.get("sector") or "").strip() or None,
        "category": str(row.get("typeDisp") or quote_type or "").strip() or None,
        "latestPrice": round_number(price, 4),
        "latestVolume": int(volume),
        "latestTurnover": round_number(price * volume, 2),
        "dailyChange": round_number(change_percent, 2) if change_percent is not None else None,
        "popularity": 0,
        "source": "market-screener",
        "sourceName": source,
        "sourceUrl": "https://finance.yahoo.com/markets/stocks/most-active/",
        "isTradable": True,
        "quoteSource": source,
        "quoteFetchedAt": fetched_at,
        "quoteStatus": "fresh",
        "updatedAt": fetched_at,
    }


def _nasdaq_etf_row_to_asset(row: dict[str, Any]) -> dict[str, Any] | None:
    return _nasdaq_row_to_asset(row, kind="fund", source="nasdaq-etf-screener", source_url="https://www.nasdaq.com/market-activity/funds-and-etfs")


def _nasdaq_stock_row_to_asset(row: dict[str, Any]) -> dict[str, Any] | None:
    return _nasdaq_row_to_asset(row, kind="stock", source="nasdaq-stock-screener", source_url="https://www.nasdaq.com/market-activity/stocks/screener")


def _nasdaq_row_to_asset(row: dict[str, Any], *, kind: AssetKind, source: str, source_url: str) -> dict[str, Any] | None:
    symbol = _clean_symbol(row.get("symbol"))
    if not symbol:
        return None
    price = _parse_number(row.get("lastsale") or row.get("lastSale") or row.get("lastSalePrice"))
    volume = _parse_number(row.get("volume"))
    if price is None or price <= 0 or volume is None or volume <= 0:
        return None
    name = str(row.get("name") or row.get("securityName") or row.get("companyName") or symbol).strip()
    change_percent = _parse_number(row.get("pctchange") or row.get("pctChange") or row.get("percentageChange"))
    fetched_at = now_iso()
    asset_type = "stock" if kind == "stock" else "fund"
    return {
        "id": f"market-top-us-{kind}-{_id_part(symbol)}",
        "marketId": "us",
        "assetType": asset_type,
        "kind": kind,
        **({"fundSubtype": "etf"} if kind == "fund" else {}),
        "name": name,
        "symbol": symbol,
        "exchange": str(row.get("exchange") or "NASDAQ").strip(),
        "aliases": [symbol, symbol.lower(), name],
        "category": "ETF" if kind == "fund" else str(row.get("marketCategory") or "").strip() or None,
        "latestPrice": round_number(price, 4),
        "latestVolume": int(volume),
        "latestTurnover": round_number(price * volume, 2),
        "dailyChange": round_number(change_percent, 2) if change_percent is not None else None,
        "popularity": 0,
        "source": "market-screener",
        "sourceName": source,
        "sourceUrl": source_url,
        "isTradable": True,
        "quoteSource": source,
        "quoteFetchedAt": fetched_at,
        "quoteStatus": "fresh",
        "updatedAt": fetched_at,
    }


def _rank_full_market_assets(candidates: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    unique: dict[str, dict[str, Any]] = {}
    for asset in candidates:
        if is_excluded_china_theme_asset(asset):
            continue
        if not _has_real_turnover(asset):
            continue
        symbol = str(asset.get("symbol") or "").upper()
        if not symbol:
            continue
        current = unique.get(symbol)
        if current is None or _source_priority(asset) > _source_priority(current) or (
            _source_priority(asset) == _source_priority(current) and _asset_turnover(asset) > _asset_turnover(current)
        ):
            unique[symbol] = asset

    ranked = sorted(unique.values(), key=lambda asset: (-_asset_turnover(asset), str(asset.get("symbol") or "")))[:limit]
    for index, asset in enumerate(ranked, start=1):
        asset["popularity"] = index
    return ranked


def _has_real_turnover(asset: dict[str, Any]) -> bool:
    price = _parse_number(asset.get("latestPrice"))
    volume = _parse_number(asset.get("latestVolume"))
    turnover = _asset_turnover(asset)
    return asset.get("quoteStatus") == "fresh" and price is not None and price > 0 and volume is not None and volume > 0 and turnover > 0


def _asset_turnover(asset: dict[str, Any]) -> float:
    explicit = _parse_number(asset.get("latestTurnover"))
    if explicit is not None and explicit > 0:
        return explicit
    price = _parse_number(asset.get("latestPrice")) or 0
    volume = _parse_number(asset.get("latestVolume")) or 0
    return price * volume


def _source_priority(asset: dict[str, Any]) -> int:
    source_name = str(asset.get("sourceName") or asset.get("quoteSource") or "")
    if source_name == "yahoo-most-active-etfs-page":
        return 30
    if source_name == "yahoo-etf-quote-pages":
        return 20
    if source_name.startswith("yahoo"):
        return 10
    return 0


def _quote_number(row: dict[str, Any], *keys: str) -> float | None:
    for key in keys:
        value = row.get(key)
        if isinstance(value, dict):
            parsed = _parse_number(value.get("raw"))
            if parsed is None:
                parsed = _parse_number(value.get("fmt"))
        else:
            parsed = _parse_number(value)
        if parsed is not None:
            return parsed
    return None


def _raw_number(value: Any) -> float | None:
    if isinstance(value, dict):
        parsed = _parse_number(value.get("raw"))
        if parsed is not None:
            return parsed
        return _parse_number(value.get("fmt") or value.get("longFmt"))
    return _parse_number(value)


def _first_regex_number(text: str, pattern: str) -> float | None:
    match = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
    if not match:
        return None
    return _parse_number(html.unescape(match.group(1)))


def _first_regex_text(text: str, pattern: str) -> str | None:
    match = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
    return html.unescape(match.group(1)) if match else None


def _streamer_data_value(text: str, field: str) -> float | None:
    for match in re.finditer(r"<fin-streamer\b[^>]*>", text, re.IGNORECASE):
        tag = match.group(0)
        if f'data-field="{field}"' not in tag:
            continue
        value_match = re.search(r'data-value="([^"]+)"', tag, re.IGNORECASE)
        if value_match:
            return _parse_number(html.unescape(value_match.group(1)))
    return None


def _rounded_optional(value: Any, digits: int) -> float | None:
    parsed = _parse_number(value)
    return round_number(parsed, digits) if parsed is not None else None


def _parse_number(value: Any) -> float | None:
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


def _fetch_json(
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


def _fetch_text(url: str, *, timeout_seconds: float, headers: dict[str, str]) -> str:
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            if response.status < 200 or response.status >= 300:
                raise ValueError(f"HTTP {response.status}")
            raw = response.read()
            encoding = response.headers.get("Content-Encoding")
            if encoding == "gzip":
                raw = gzip.decompress(raw)
            elif encoding == "deflate":
                raw = zlib.decompress(raw)
            return raw.decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as exc:
        raise ValueError(f"HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise ValueError(str(exc.reason)) from exc


def _clean_symbol(value: Any) -> str:
    return str(value or "").strip().upper()


def _id_part(symbol: str) -> str:
    return re.sub(r"[^A-Z0-9]+", "-", symbol.upper()).strip("-").lower()


def _summarize_exception(exc: Exception) -> str:
    return " ".join((str(exc).strip() or type(exc).__name__).split())
