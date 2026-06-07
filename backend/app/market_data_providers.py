from __future__ import annotations

import importlib
import importlib.util
import json
import math
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from .provider_accounts import get_provider_config, get_provider_secret, provider_credentials_ready
from .services import LOCAL_USER_ID, MarketId, asset_kind, now_iso, round_number

Range = Literal["1mo", "3mo", "6mo", "1y", "3y", "5y", "10y", "max"]
Interval = Literal["1d", "1wk", "1mo"]
DEFAULT_HISTORY_RANGE: Range = "max"
DEFAULT_MAX_HISTORY_YEARS = 30

YAHOO_SYMBOL_BY_ASSET_ID = {
    "us-sp500-index": "VOO",
    "us-nasdaq-100": "QQQ",
    "us-dividend-value": "SCHD",
    "us-low-volatility": "USMV",
    "us-healthcare-defensive": "XLV",
    "us-quality-value": "QUAL",
    "us-short-treasury": "SGOV",
}

YAHOO_EXCHANGE_SUFFIXES = {
    "AE",
    "AS",
    "AT",
    "AX",
    "BA",
    "BC",
    "BD",
    "BE",
    "BK",
    "BO",
    "BR",
    "CN",
    "CO",
    "CR",
    "DE",
    "DU",
    "F",
    "HA",
    "HE",
    "HK",
    "HM",
    "IC",
    "IR",
    "IS",
    "JK",
    "JO",
    "KL",
    "KQ",
    "KS",
    "L",
    "LS",
    "MA",
    "MC",
    "ME",
    "MI",
    "MX",
    "NE",
    "NS",
    "NZ",
    "OL",
    "PA",
    "PR",
    "QA",
    "RG",
    "SA",
    "SG",
    "SI",
    "SN",
    "SR",
    "SS",
    "ST",
    "SW",
    "SZ",
    "T",
    "TA",
    "TL",
    "TO",
    "TWO",
    "TW",
    "V",
    "VI",
    "VS",
    "WA",
}

DEFAULT_PROVIDER_ORDER_BY_MARKET: dict[MarketId, list[str]] = {
    "us": ["longbridge", "yfinance", "yahoo"],
}

PROVIDER_ALIASES = {
    "auto": "auto",
    "public-no-key": "auto",
    "multi-provider": "auto",
    "yahoo-chart": "yahoo",
}


@dataclass
class ProviderAttempt:
    provider: str
    status: str
    reason: str | None = None


@dataclass
class ProviderCircuitState:
    failures: int = 0
    opened_until: float = 0


class ProviderCircuitBreaker:
    def __init__(self, *, threshold: int | None = None, cooldown_seconds: int | None = None):
        self.threshold = threshold if threshold is not None else parse_int_env("FUNDX_MARKET_DATA_CIRCUIT_THRESHOLD", 3)
        self.cooldown_seconds = cooldown_seconds if cooldown_seconds is not None else parse_int_env("FUNDX_MARKET_DATA_CIRCUIT_COOLDOWN_SECONDS", 300)
        self._state: dict[str, ProviderCircuitState] = {}

    def is_open(self, provider_name: str) -> bool:
        state = self._state.get(provider_name)
        if not state:
            return False
        if state.opened_until <= time.time():
            state.opened_until = 0
            return False
        return True

    def record_success(self, provider_name: str) -> None:
        self._state[provider_name] = ProviderCircuitState()

    def record_failure(self, provider_name: str) -> None:
        state = self._state.setdefault(provider_name, ProviderCircuitState())
        state.failures += 1
        if state.failures >= self.threshold:
            state.opened_until = time.time() + self.cooldown_seconds


class BaseMarketDataProvider:
    name = "base"
    priority = 99
    user_id = LOCAL_USER_ID

    def is_available(self) -> bool:
        return True

    def supports(self, asset: dict[str, Any]) -> bool:
        return asset.get("marketId") == "us" and asset_kind(asset) in ("stock", "fund")

    def fetch_quote(
        self,
        asset: dict[str, Any],
        *,
        range_value: Range,
        interval: Interval,
        timeout_seconds: float,
        start_date: str | None = None,
        end_date: str | None = None,
    ) -> dict[str, Any] | None:
        raise NotImplementedError


class LongbridgeProvider(BaseMarketDataProvider):
    name = "longbridge"
    priority = 4

    def __init__(self):
        self._ctx = None

    def is_available(self) -> bool:
        return importlib.util.find_spec("longbridge") is not None and bool(longbridge_credentials_ready(self.user_id))

    def supports(self, asset: dict[str, Any]) -> bool:
        return asset.get("marketId") == "us" and asset_kind(asset) in ("stock", "fund") and bool(longbridge_symbol(asset))

    def fetch_quote(
        self,
        asset: dict[str, Any],
        *,
        range_value: Range,
        interval: Interval,
        timeout_seconds: float,
        start_date: str | None = None,
        end_date: str | None = None,
    ) -> dict[str, Any] | None:
        if interval != "1d":
            return None
        symbol = longbridge_symbol(asset)
        if not symbol:
            return None
        ctx = self._get_ctx()
        if ctx is None:
            return None
        try:
            from longbridge.openapi import AdjustType, Period
        except Exception as exc:
            raise ValueError(f"Longbridge SDK is unavailable: {exc}") from exc

        window_start, window_end = normalized_date_window(start_date, end_date, range_value)
        candles = ctx.history_candlesticks_by_date(
            symbol,
            Period.Day,
            AdjustType.ForwardAdjust,
            datetime.fromisoformat(window_start).date(),
            datetime.fromisoformat(window_end).date(),
        )
        rows: list[dict[str, Any]] = []
        for candle in candles or []:
            timestamp = getattr(candle, "timestamp", None)
            if timestamp is None:
                continue
            date = timestamp.date().isoformat() if hasattr(timestamp, "date") else datetime.fromtimestamp(int(timestamp), tz=timezone.utc).date().isoformat()
            rows.append(
                {
                    "date": date,
                    "open": getattr(candle, "open", None),
                    "high": getattr(candle, "high", None),
                    "low": getattr(candle, "low", None),
                    "close": getattr(candle, "close", None),
                    "volume": getattr(candle, "volume", None),
                    "amount": getattr(candle, "turnover", None),
                }
            )
        history = normalize_tabular_history(asset, rows, source=f"longbridge:{symbol}")
        return quote_from_history(asset, history, source=f"longbridge:{symbol}", symbol=symbol)

    def _get_ctx(self):
        if self._ctx is not None:
            return self._ctx
        from longbridge.openapi import Config, QuoteContext

        sanitize_longbridge_env(get_provider_config("longbridge", "region", "us", self.user_id))
        app_key = get_provider_secret("longbridge", "appKey", "us", self.user_id)
        app_secret = get_provider_secret("longbridge", "appSecret", "us", self.user_id)
        access_token = get_provider_secret("longbridge", "accessToken", "us", self.user_id)
        if not (app_key and app_secret and access_token):
            return None
        self._ctx = QuoteContext(Config.from_apikey(app_key, app_secret, access_token))
        return self._ctx


class YFinanceLibraryProvider(BaseMarketDataProvider):
    name = "yfinance"
    priority = 5

    def is_available(self) -> bool:
        return importlib.util.find_spec("yfinance") is not None

    def supports(self, asset: dict[str, Any]) -> bool:
        return asset.get("marketId") == "us" and asset_kind(asset) in ("stock", "fund") and bool(resolve_yahoo_symbol(asset))

    def fetch_quote(
        self,
        asset: dict[str, Any],
        *,
        range_value: Range,
        interval: Interval,
        timeout_seconds: float,
        start_date: str | None = None,
        end_date: str | None = None,
    ) -> dict[str, Any] | None:
        yf = importlib.import_module("yfinance")
        symbol = resolve_yahoo_symbol(asset)
        if not symbol:
            return None
        ticker = yf.Ticker(symbol)
        if start_date or end_date:
            window_start, window_end = normalized_date_window(start_date, end_date, range_value)
            frame = ticker.history(start=window_start, end=exclusive_end_date(window_end), interval=interval, auto_adjust=False)
        else:
            frame = ticker.history(period=range_value, interval=interval, auto_adjust=False)
        rows = records_from_frame(frame.reset_index() if hasattr(frame, "reset_index") else frame)
        history = normalize_yfinance_history(asset, rows, source=f"yfinance:{symbol}")
        return quote_from_history(asset, history, source=f"yfinance:{symbol}", symbol=symbol, dividends=parse_yfinance_dividends(rows))


class YahooChartProvider(BaseMarketDataProvider):
    name = "yahoo"
    priority = 6

    def supports(self, asset: dict[str, Any]) -> bool:
        return asset.get("marketId") == "us" and asset_kind(asset) in ("stock", "fund") and bool(resolve_yahoo_symbol(asset))

    def fetch_quote(
        self,
        asset: dict[str, Any],
        *,
        range_value: Range,
        interval: Interval,
        timeout_seconds: float,
        start_date: str | None = None,
        end_date: str | None = None,
    ) -> dict[str, Any] | None:
        symbol = resolve_yahoo_symbol(asset)
        if not symbol:
            return None
        return fetch_yahoo_chart(asset, symbol, range_value=range_value, interval=interval, timeout_seconds=timeout_seconds, start_date=start_date, end_date=end_date)


PROVIDER_FACTORIES = {
    "longbridge": LongbridgeProvider,
    "yfinance": YFinanceLibraryProvider,
    "yahoo": YahooChartProvider,
}


class MarketDataProviderManager:
    def __init__(self, providers: list[BaseMarketDataProvider] | None = None, user_id: str | None = None):
        self.user_id = user_id or LOCAL_USER_ID
        self.providers = providers if providers is not None else self._build_configured_providers()
        self._uses_injected_providers = providers is not None
        self._last_failures: dict[str, list[str]] = {}
        for provider in self.providers:
            provider.user_id = self.user_id

    def source_label(self, market_id: MarketId | None = None) -> str:
        tokens = configured_provider_tokens(market_id, self.user_id) if market_id else [provider.name for provider in self.providers]
        return f"multi-provider:{','.join(tokens)}" if tokens else "multi-provider:none"

    def last_failure_reason(self, asset_id: str) -> str | None:
        failures = self._last_failures.get(asset_id)
        return "; ".join(failures) if failures else None

    def fetch_quote(
        self,
        asset: dict[str, Any],
        *,
        range_value: Range = DEFAULT_HISTORY_RANGE,
        interval: Interval = "1d",
        timeout_seconds: float = 8,
        start_date: str | None = None,
        end_date: str | None = None,
    ) -> dict[str, Any] | None:
        asset_id = str(asset.get("id") or "")
        attempts: list[ProviderAttempt] = []
        providers = self._providers_for_asset(asset)
        if not providers:
            self._last_failures[asset_id] = ["no configured provider supports this asset"]
            return None

        for index, provider in enumerate(providers):
            if _circuit_breaker.is_open(provider.name):
                attempts.append(ProviderAttempt(provider.name, "skipped", "circuit open"))
                continue
            if not provider.is_available():
                attempts.append(ProviderAttempt(provider.name, "skipped", "provider unavailable"))
                continue
            try:
                quote = provider.fetch_quote(asset, range_value=range_value, interval=interval, timeout_seconds=timeout_seconds, start_date=start_date, end_date=end_date)
                if has_basic_quote(quote):
                    _circuit_breaker.record_success(provider.name)
                    quote = dict(quote or {})
                    if attempts:
                        first_failure = next((attempt.provider for attempt in attempts if attempt.status != "ok"), None)
                        if first_failure:
                            quote["fallbackFrom"] = first_failure
                    attempts.append(ProviderAttempt(provider.name, "ok"))
                    quote["providerChain"] = [attempt.__dict__ for attempt in attempts]
                    return self._supplement_quote(
                        asset,
                        quote,
                        providers[index + 1 :],
                        range_value=range_value,
                        interval=interval,
                        timeout_seconds=timeout_seconds,
                        start_date=start_date,
                        end_date=end_date,
                    )
                _circuit_breaker.record_failure(provider.name)
                attempts.append(ProviderAttempt(provider.name, "failed", "empty quote"))
            except Exception as exc:
                _circuit_breaker.record_failure(provider.name)
                attempts.append(ProviderAttempt(provider.name, "failed", summarize_exception(exc)))

        self._last_failures[asset_id] = [format_attempt(attempt) for attempt in attempts]
        return None

    def _supplement_quote(
        self,
        asset: dict[str, Any],
        quote: dict[str, Any],
        providers: list[BaseMarketDataProvider],
        *,
        range_value: Range,
        interval: Interval,
        timeout_seconds: float,
        start_date: str | None = None,
        end_date: str | None = None,
    ) -> dict[str, Any]:
        needs_volume = asset_kind(asset) == "stock" and quote.get("latestVolume") is None
        needs_dividends = "dividends" not in quote
        if not needs_volume and not needs_dividends:
            return quote

        for provider in providers[:2]:
            if _circuit_breaker.is_open(provider.name) or not provider.supports(asset) or not provider.is_available():
                continue
            try:
                supplement = provider.fetch_quote(asset, range_value=range_value, interval=interval, timeout_seconds=timeout_seconds, start_date=start_date, end_date=end_date)
            except Exception:
                continue
            if not has_basic_quote(supplement):
                continue
            latest_volume = supplement.get("latestVolume")
            if needs_volume and latest_volume is not None:
                quote["latestVolume"] = latest_volume
                quote["supplementSource"] = supplement.get("source")
                needs_volume = False
            if needs_dividends and isinstance(supplement.get("dividends"), list):
                quote["dividends"] = supplement["dividends"]
                quote["dividendSource"] = supplement.get("source")
                needs_dividends = False
            if not needs_volume and not needs_dividends:
                break
        return quote

    def _build_configured_providers(self) -> list[BaseMarketDataProvider]:
        marketless_tokens = configured_provider_tokens(None, self.user_id)
        providers: list[BaseMarketDataProvider] = []
        for token in marketless_tokens:
            factory = PROVIDER_FACTORIES.get(token)
            if factory is None:
                continue
            providers.append(factory())
        return dedupe_providers(providers)

    def _providers_for_asset(self, asset: dict[str, Any]) -> list[BaseMarketDataProvider]:
        if self._uses_injected_providers:
            return [provider for provider in self.providers if provider.supports(asset)]
        market_id = asset.get("marketId") if asset.get("marketId") == "us" else None
        order = configured_provider_tokens(market_id, self.user_id)
        providers_by_name = {provider.name: provider for provider in self.providers}
        ordered = [providers_by_name[token] for token in order if token in providers_by_name]
        return [provider for provider in ordered if provider.supports(asset)]


def configured_provider_tokens(market_id: MarketId | None, user_id: str | None = None) -> list[str]:
    configured_order = os.environ.get("FUNDX_MARKET_DATA_PROVIDERS", "").strip()
    provider_label = os.environ.get("FUNDX_MARKET_DATA_PROVIDER", "public-no-key").strip()
    if configured_order:
        tokens = split_provider_tokens(configured_order)
    elif normalize_provider_token(provider_label) != "auto":
        tokens = split_provider_tokens(provider_label)
    elif market_id:
        tokens = default_provider_order(market_id, user_id)
    else:
        tokens = unique_tokens(default_provider_order("us", user_id))
    return unique_tokens(tokens)


def default_provider_order(market_id: MarketId, user_id: str | None = None) -> list[str]:
    return list(DEFAULT_PROVIDER_ORDER_BY_MARKET[market_id])


def split_provider_tokens(value: str) -> list[str]:
    return [normalize_provider_token(token) for token in value.replace(";", ",").split(",") if normalize_provider_token(token)]


def normalize_provider_token(token: str) -> str:
    normalized = token.strip().lower().replace("_", "-")
    return PROVIDER_ALIASES.get(normalized, normalized)


def unique_tokens(tokens: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for token in tokens:
        if token == "auto":
            continue
        if token not in seen:
            seen.add(token)
            result.append(token)
    return result


def dedupe_providers(providers: list[BaseMarketDataProvider]) -> list[BaseMarketDataProvider]:
    seen: set[str] = set()
    result: list[BaseMarketDataProvider] = []
    for provider in providers:
        if provider.name in seen:
            continue
        seen.add(provider.name)
        result.append(provider)
    return result


def supported_market_ids(provider: BaseMarketDataProvider) -> set[MarketId]:
    return {"us"} if provider.name in PROVIDER_FACTORIES else set()


def has_basic_quote(quote: dict[str, Any] | None) -> bool:
    if not isinstance(quote, dict):
        return False
    latest_price = quote.get("latestPrice")
    history = quote.get("history")
    return isinstance(latest_price, (int, float)) and latest_price > 0 and isinstance(history, list) and bool(history)


def quote_from_history(
    asset: dict[str, Any],
    history: list[dict[str, Any]],
    *,
    source: str,
    symbol: str,
    dividends: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    history = sorted(history, key=lambda point: str(point.get("date", "")))
    if not history:
        return None

    latest = history[-1]
    latest_price = parse_float(latest.get("nav")) if latest.get("nav") is not None else parse_float(latest.get("close"))
    if latest_price is None:
        return None
    previous_price = latest_price
    if len(history) >= 2:
        previous_price = parse_float(history[-2].get("nav")) if history[-2].get("nav") is not None else parse_float(history[-2].get("close"))
        previous_price = previous_price if previous_price is not None else latest_price
    daily_change = latest_price - previous_price
    quote = {
        "assetId": asset.get("id"),
        "marketId": asset.get("marketId"),
        "source": source,
        "symbol": symbol,
        "latestPrice": round_number(latest_price, 4),
        "latestVolume": parse_float(latest.get("volume")),
        "dailyChange": round_number(daily_change, 4),
        "dailyChangePercent": round_number((daily_change / previous_price) * 100 if previous_price else 0, 2),
        "history": history,
        "fetchedAt": now_iso(),
    }
    if dividends is not None:
        quote["dividends"] = dividends
    return quote


def normalize_tabular_history(
    asset: dict[str, Any],
    rows: list[dict[str, Any]],
    *,
    source: str,
) -> list[dict[str, Any]]:
    history: list[dict[str, Any]] = []
    for row in rows:
        date = normalize_date(row_value(row, "date", "trade_date"))
        close = parse_float(row_value(row, "close"))
        if close is None or not date:
            continue
        open_value = parse_float(row_value(row, "open")) or close
        high = parse_float(row_value(row, "high")) or max(open_value, close)
        low = parse_float(row_value(row, "low")) or min(open_value, close)
        volume = parse_float(row_value(row, "volume", "vol"))
        amount = parse_float(row_value(row, "amount"))
        history.append(history_point(asset, date, open_value, high, low, close, volume=volume, amount=amount, source=source))
    return history


def normalize_yfinance_history(asset: dict[str, Any], rows: list[dict[str, Any]], *, source: str) -> list[dict[str, Any]]:
    history: list[dict[str, Any]] = []
    for row in rows:
        date = normalize_date(row_value(row, "Date", "Datetime", "date"))
        close = parse_float(row_value(row, "Adj Close", "Close", "close"))
        if close is None or not date:
            continue
        open_value = parse_float(row_value(row, "Open", "open")) or close
        high = parse_float(row_value(row, "High", "high")) or max(open_value, close)
        low = parse_float(row_value(row, "Low", "low")) or min(open_value, close)
        volume = parse_float(row_value(row, "Volume", "volume"))
        history.append(history_point(asset, date, open_value, high, low, close, volume=volume, source=source))
    return history


def parse_yfinance_dividends(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    dividends: list[dict[str, Any]] = []
    for row in rows:
        date = normalize_date(row_value(row, "Date", "Datetime", "date"))
        amount = parse_float(row_value(row, "Dividends", "dividends"))
        if not date or amount is None or amount <= 0:
            continue
        dividends.append({"date": date, "amount": round_number(amount, 4)})
    return sorted(dividends, key=lambda dividend: dividend["date"])


def history_point(
    asset: dict[str, Any],
    date: str,
    open_value: float,
    high: float,
    low: float,
    close: float,
    *,
    volume: float | None = None,
    amount: float | None = None,
    source: str,
) -> dict[str, Any]:
    return {
        "id": f"{asset.get('id')}-{date}",
        "marketId": asset.get("marketId"),
        "assetId": asset.get("id"),
        "assetType": asset.get("assetType"),
        "date": date,
        "open": round_number(open_value, 4),
        "high": round_number(high, 4),
        "low": round_number(low, 4),
        "close": round_number(close, 4),
        **({"nav": round_number(close, 4)} if asset_kind(asset) != "stock" else {}),
        **({"volume": round_number(volume, 2)} if volume is not None else {}),
        **({"amount": round_number(amount, 2)} if amount is not None else {}),
        "source": source,
    }


def fetch_yahoo_chart(
    asset: dict[str, Any],
    yahoo_symbol: str,
    *,
    range_value: Range,
    interval: Interval,
    timeout_seconds: float,
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict[str, Any] | None:
    if start_date or end_date:
        window_start, window_end = normalized_date_window(start_date, end_date, range_value)
        params_payload = {
            "period1": unix_seconds(window_start),
            "period2": unix_seconds(exclusive_end_date(window_end)),
            "interval": interval,
            "events": "div,splits",
            "includePrePost": "false",
        }
    else:
        params_payload = {
            "range": range_value,
            "interval": interval,
            "events": "div,splits",
            "includePrePost": "false",
        }
    params = urllib.parse.urlencode(params_payload)
    body = fetch_json(
        f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(yahoo_symbol)}?{params}",
        timeout_seconds=timeout_seconds,
        headers={"User-Agent": "FundX/0.1 yahoo-chart", "Accept": "application/json"},
    )
    result = (((body.get("chart") or {}).get("result") or [None])[0]) if isinstance(body, dict) else None
    if not isinstance(result, dict):
        return None
    timestamps = result.get("timestamp")
    quote = ((((result.get("indicators") or {}).get("quote") or [None])[0]) if isinstance(result.get("indicators"), dict) else None)
    if not isinstance(timestamps, list) or not timestamps or not isinstance(quote, dict):
        return None
    adj_close = ((((result.get("indicators") or {}).get("adjclose") or [{}])[0]).get("adjclose") or [])

    history: list[dict[str, Any]] = []
    for index, timestamp in enumerate(timestamps):
        close = sanitize_number(value_at(adj_close, index) if adj_close else value_at(quote.get("close"), index))
        if close is None:
            continue
        open_value = sanitize_number(value_at(quote.get("open"), index)) or close
        high = sanitize_number(value_at(quote.get("high"), index)) or max(open_value, close)
        low = sanitize_number(value_at(quote.get("low"), index)) or min(open_value, close)
        date = datetime.fromtimestamp(int(timestamp), tz=timezone.utc).date().isoformat()
        history.append(
            history_point(
                asset,
                date,
                open_value,
                high,
                low,
                close,
                volume=sanitize_number(value_at(quote.get("volume"), index)),
                source=f"yahoo:{yahoo_symbol}",
            )
        )
    if not history:
        return None

    yahoo_quote = quote_from_history(asset, history, source=f"yahoo:{yahoo_symbol}", symbol=yahoo_symbol, dividends=parse_yahoo_dividends(((result.get("events") or {}).get("dividends") if isinstance(result.get("events"), dict) else None)))
    if not yahoo_quote:
        return None
    meta = result.get("meta") if isinstance(result.get("meta"), dict) else {}
    latest_price = sanitize_number(meta.get("regularMarketPrice"))
    if latest_price is not None and len(history) >= 1:
        previous = history[-2]["close"] if len(history) >= 2 else sanitize_number(meta.get("chartPreviousClose")) or history[-1]["close"]
        daily_change = latest_price - previous
        yahoo_quote["latestPrice"] = round_number(latest_price, 4)
        yahoo_quote["dailyChange"] = round_number(daily_change, 4)
        yahoo_quote["dailyChangePercent"] = round_number((daily_change / previous) * 100 if previous else 0, 2)
    return yahoo_quote


def fetch_json(url: str, *, timeout_seconds: float, headers: dict[str, str]) -> dict[str, Any]:
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            if response.status < 200 or response.status >= 300:
                raise ValueError(f"HTTP {response.status}")
            return json.loads(response.read().decode("utf-8-sig"))
    except urllib.error.HTTPError as exc:
        raise ValueError(f"HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise ValueError(str(exc.reason)) from exc


def resolve_yahoo_symbol(asset: dict[str, Any]) -> str | None:
    asset_id = str(asset.get("id") or "")
    if asset_id in YAHOO_SYMBOL_BY_ASSET_ID:
        return YAHOO_SYMBOL_BY_ASSET_ID[asset_id]
    return yahoo_symbol(normalize_code(asset.get("symbol")))


def yahoo_symbol(symbol: str) -> str | None:
    symbol = normalize_code(symbol)
    if not symbol:
        return None
    if is_yahoo_exchange_suffix_symbol(symbol):
        return symbol
    preferred = re.fullmatch(r"([A-Z0-9]+)\^([A-Z0-9]+)", symbol)
    if preferred:
        return f"{preferred.group(1)}-P{preferred.group(2)}"
    if "^" in symbol:
        return None
    return symbol.replace("/", "-").replace(".", "-")


def normalize_code(value: Any) -> str:
    return str(value or "").strip().upper()


def longbridge_symbol(asset: dict[str, Any]) -> str | None:
    symbol = str(asset.get("symbol") or "").strip().upper()
    if not symbol:
        return None
    if "^" in symbol or is_yahoo_exchange_suffix_symbol(symbol):
        return None
    if symbol.endswith(".US"):
        return f"{symbol[:-3].replace('/', '.')}.US"
    if symbol.endswith(".HK"):
        return f"{symbol[:-3].replace('/', '.')}.HK"
    if asset.get("marketId") == "us":
        return f"{symbol.replace('/', '.')}.US"
    return None


def is_yahoo_exchange_suffix_symbol(symbol: Any) -> bool:
    normalized = normalize_code(symbol)
    match = re.fullmatch(r"[A-Z0-9-]+\.([A-Z]{1,4})", normalized)
    return bool(match and match.group(1) in YAHOO_EXCHANGE_SUFFIXES)


def clean_env(name: str) -> str:
    return str(os.environ.get(name) or "").strip()


def sanitize_longbridge_env(region_override: str | None = None) -> None:
    for key in (
        "LONGBRIDGE_HTTP_URL",
        "LONGBRIDGE_QUOTE_WS_URL",
        "LONGBRIDGE_TRADE_WS_URL",
        "LONGBRIDGE_REGION",
    ):
        if os.environ.get(key) is not None and not clean_env(key):
            del os.environ[key]
    region = (region_override or clean_env("LONGBRIDGE_REGION")).lower()
    if region == "hk":
        os.environ.setdefault("LONGPORT_REGION", "hk")
        os.environ.setdefault("LONGBRIDGE_HTTP_URL", "https://openapi.longbridge.com")
        os.environ.setdefault("LONGBRIDGE_QUOTE_WS_URL", "wss://openapi-quote.longbridge.com/v2")
        os.environ.setdefault("LONGBRIDGE_TRADE_WS_URL", "wss://openapi-trade.longbridge.com/v2")


def longbridge_credentials_ready(user_id: str | None = None) -> bool:
    return provider_credentials_ready("longbridge", "us", user_id)


def range_to_days(range_value: Range) -> int:
    if range_value == "max":
        return int(max(1, parse_int_env("FUNDX_MARKET_DATA_MAX_HISTORY_YEARS", DEFAULT_MAX_HISTORY_YEARS)) * 365.25)
    return {
        "1mo": 40,
        "3mo": 110,
        "6mo": 220,
        "1y": 370,
        "3y": 1110,
        "5y": 1850,
        "10y": 3700,
    }.get(range_value, 370)


def iso_date_window(range_value: Range) -> tuple[str, str]:
    end_date = datetime.now(timezone.utc).date()
    start_date = end_date - timedelta(days=range_to_days(range_value))
    return start_date.isoformat(), end_date.isoformat()


def normalized_date_window(start_date: str | None, end_date: str | None, range_value: Range) -> tuple[str, str]:
    fallback_start, fallback_end = iso_date_window(range_value)
    normalized_start = normalize_date(start_date) if start_date else fallback_start
    normalized_end = normalize_date(end_date) if end_date else fallback_end
    if not is_iso_date(normalized_start):
        normalized_start = fallback_start
    if not is_iso_date(normalized_end):
        normalized_end = fallback_end
    if normalized_start > normalized_end:
        normalized_start, normalized_end = normalized_end, normalized_start
    return normalized_start, normalized_end


def exclusive_end_date(value: str) -> str:
    parsed = datetime.fromisoformat(value).date()
    return (parsed + timedelta(days=1)).isoformat()


def unix_seconds(value: str) -> int:
    return int(datetime.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp())


def is_iso_date(value: str) -> bool:
    if len(value) != 10 or value[4] != "-" or value[7] != "-":
        return False
    try:
        datetime.fromisoformat(value)
    except ValueError:
        return False
    return True


def compact_date_window(range_value: Range) -> tuple[str, str]:
    start_date, end_date = iso_date_window(range_value)
    return start_date.replace("-", ""), end_date.replace("-", "")


def records_from_frame(frame: Any) -> list[dict[str, Any]]:
    if frame is None:
        return []
    empty = getattr(frame, "empty", False)
    if empty:
        return []
    if hasattr(frame, "to_dict"):
        return frame.to_dict("records")
    if isinstance(frame, list):
        return [item for item in frame if isinstance(item, dict)]
    return []


def row_value(row: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in row:
            return row.get(key)
    lowered = {str(key).lower(): value for key, value in row.items()}
    for key in keys:
        value = lowered.get(key.lower())
        if value is not None:
            return value
    return None


def normalize_date(value: Any) -> str:
    if value in (None, ""):
        return ""
    if hasattr(value, "strftime"):
        return value.strftime("%Y-%m-%d")
    text = str(value).strip()
    if len(text) >= 10 and text[4] == "-" and text[7] == "-":
        return text[:10]
    if len(text) == 8 and text.isdigit():
        return f"{text[:4]}-{text[4:6]}-{text[6:]}"
    return text


def parse_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(parsed) or math.isinf(parsed):
        return None
    return parsed


def parse_int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


def parse_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def summarize_exception(exc: Exception) -> str:
    message = str(exc).strip() or type(exc).__name__
    return " ".join(message.split())


def format_attempt(attempt: ProviderAttempt) -> str:
    return f"{attempt.provider}: {attempt.reason or attempt.status}"


def parse_yahoo_dividends(events: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(events, dict):
        return []
    dividends = []
    for item in events.values():
        if not isinstance(item, dict):
            continue
        timestamp = item.get("date")
        amount = sanitize_number(item.get("amount"))
        if not isinstance(timestamp, (int, float)) or amount is None:
            continue
        dividends.append({"date": datetime.fromtimestamp(int(timestamp), tz=timezone.utc).date().isoformat(), "amount": round_number(amount, 4)})
    return dividends


def value_at(values: Any, index: int) -> Any:
    return values[index] if isinstance(values, list) and index < len(values) else None


def sanitize_number(value: Any) -> float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


_circuit_breaker = ProviderCircuitBreaker()
