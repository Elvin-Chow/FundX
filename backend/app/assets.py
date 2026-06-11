from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Request

from .auth import current_user_id
from .errors import FundXApiError, validation_error
from .services import (
    LOCAL_USER_ID,
    calculated_from_history,
    format_currency,
    format_percent,
    get_market_data_meta,
    is_public_market_asset,
    list_real_funds,
    list_real_stocks,
    normalize_asset_record,
    number_or_zero,
    parse_market,
    read_db,
)

ASSET_TYPES = ("fund", "stock", "etf", "customFund", "customAsset")

router = APIRouter(tags=["assets"])


@router.get("/api/stocks")
def list_stocks(request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    refreshed = parse_refresh(request.query_params.get("refresh"))
    refresh_result = refresh_top_assets_if_requested(request, market_id, "stock", refreshed)
    db = read_db()
    stocks = list_real_stocks(db, market_id)
    payload = {
        **get_market_data_meta(db, market_id),
        "stocks": [{**stock, "calculated": calculated_from_history(stock.get("priceHistory", []))} for stock in stocks],
        "customFundUniverse": list_custom_fund_universe(db, market_id),
    }
    add_refresh_result(payload, refreshed, refresh_result)
    return payload


@router.get("/api/stocks/{asset_id}")
def get_stock(asset_id: str, request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    refreshed = parse_refresh(request.query_params.get("refresh"))
    refresh_result = refresh_assets_if_requested(request, market_id, [asset_id], refreshed)
    db = read_db()
    stock = resolve_stock(db, market_id, asset_id)
    asset_detail = asset_detail_payload(db, current_user_id(request), market_id, asset_id, "stock", refreshed, refresh_result)

    payload = {
        "marketId": market_id,
        "source": asset_detail["source"],
        "updatedAt": asset_detail["updatedAt"],
        "cache": asset_detail.get("cache"),
        "stock": stock,
        "detail": asset_detail.get("detail"),
        "history": asset_detail.get("history", []),
        "calculated": calculated_from_history(stock.get("priceHistory", [])),
    }
    add_refresh_result(payload, refreshed, refresh_result)
    return payload


@router.get("/api/funds/{asset_id}")
def get_fund(asset_id: str, request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    refreshed = parse_refresh(request.query_params.get("refresh"))
    refresh_result = refresh_assets_if_requested(request, market_id, [asset_id], refreshed)
    db = read_db()
    fund = resolve_fund(db, market_id, asset_id)
    asset_type = "etf" if fund.get("type") == "ETF" else "fund"
    asset_detail = asset_detail_payload(db, current_user_id(request), market_id, asset_id, asset_type, refreshed, refresh_result)

    payload = {
        "marketId": market_id,
        "source": asset_detail["source"],
        "updatedAt": asset_detail["updatedAt"],
        "cache": asset_detail.get("cache"),
        "fund": fund,
        "detail": asset_detail.get("detail"),
        "history": asset_detail.get("history", []),
        "calculated": calculated_from_history(fund.get("navHistory", [])),
    }
    add_refresh_result(payload, refreshed, refresh_result)
    return payload


@router.get("/api/assets/{asset_id}")
def get_asset(asset_id: str, request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    asset_type = parse_asset_type(request.query_params.get("type"))
    refreshed = parse_refresh(request.query_params.get("refresh"))
    refresh_result = refresh_assets_if_requested(request, market_id, [asset_id], refreshed)
    db = read_db()
    return asset_detail_payload(db, current_user_id(request), market_id, asset_id, asset_type, refreshed, refresh_result)


def asset_detail_payload(
    db: dict[str, Any],
    user_id: str,
    market_id: str,
    asset_id: str,
    asset_type: str | None,
    refreshed: bool,
    refresh_result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    asset = resolve_any_asset(db, user_id, market_id, asset_id, asset_type)
    resolved_asset_id = str(asset.get("id") or asset_id)
    history = list_asset_history(db, user_id, market_id, resolved_asset_id, asset.get("assetType"))
    detail = build_asset_detail(db, user_id, market_id, asset)
    payload = {
        **get_market_data_meta(
            db,
            market_id,
            source=asset.get("source"),
            cache_key=f"asset:{market_id}:{asset.get('id')}",
            cached=not refreshed,
        ),
        "asset": asset,
        "detail": detail,
        "history": history,
        "source": asset.get("source") or "local-db",
        "updatedAt": asset.get("updatedAt") or get_market_data_meta(db, market_id).get("updatedAt"),
        "refreshed": refreshed,
    }
    add_refresh_result(payload, refreshed, refresh_result)
    return payload


def resolve_fund(db: dict[str, Any], market_id: str, asset_id: str) -> dict[str, Any]:
    fund = next(
        (item for item in list_real_funds(db, market_id) if item.get("id") == asset_id and item.get("marketId") == market_id),
        None,
    )
    if not fund:
        raise FundXApiError("not_found", "Fund was not found in the selected market.", 404)
    return fund


def resolve_stock(db: dict[str, Any], market_id: str, asset_id: str) -> dict[str, Any]:
    stock = next(
        (item for item in list_real_stocks(db, market_id) if item.get("id") == asset_id and item.get("marketId") == market_id),
        None,
    )
    if not stock:
        raise FundXApiError("not_found", "Stock was not found in the selected market.", 404)
    return stock


def resolve_any_asset(
    db: dict[str, Any],
    user_id: str,
    market_id: str,
    asset_id: str,
    asset_type: str | None,
) -> dict[str, Any]:
    asset = next(
        (
            normalize_asset_record(item)
            for item in db.get("assets", [])
            if item.get("id") == asset_id
            and item.get("marketId") == market_id
            and asset_type_matches(str(item.get("assetType")), asset_type)
            and asset_visible_to_user(item, user_id)
            and is_public_market_asset(item)
        ),
        None,
    )
    if asset:
        return asset

    symbol_slug = symbol_slug_from_route_id(asset_id, market_id)
    if symbol_slug:
        asset = next(
            (
                normalize_asset_record(item)
                for item in db.get("assets", [])
                if item.get("marketId") == market_id
                and symbol_slug_for_asset(item.get("symbol")) == symbol_slug
                and asset_type_matches(str(item.get("assetType")), asset_type)
                and asset_visible_to_user(item, user_id)
                and is_public_market_asset(item)
            ),
            None,
        )
        if asset:
            return asset

    if asset_type in (None, "customFund"):
        custom_fund = next(
            (
                item
                for item in db.get("customFunds", [])
                if item.get("userId") == user_id and item.get("id") == asset_id and item.get("marketId") == market_id
            ),
            None,
        )
        if custom_fund:
            return custom_fund_to_asset(custom_fund)

    raise FundXApiError("not_found", "Asset was not found in the selected market.", 404)


def symbol_slug_from_route_id(asset_id: str, market_id: str) -> str | None:
    return market_top_symbol_slug(asset_id, market_id) or market_symbol_slug(asset_id, market_id)


def market_top_symbol_slug(asset_id: str, market_id: str) -> str | None:
    prefix = f"market-top-{market_id}-"
    if not asset_id.startswith(prefix):
        return None
    parts = asset_id[len(prefix):].split("-", 1)
    if len(parts) != 2:
        return None
    return parts[1].strip().lower() or None


def market_symbol_slug(asset_id: str, market_id: str) -> str | None:
    prefix = f"{market_id}-"
    if not asset_id.startswith(prefix):
        return None
    return asset_id[len(prefix):].strip().lower() or None


def symbol_slug_for_asset(symbol: Any) -> str:
    return re.sub(r"[^A-Z0-9]+", "-", str(symbol or "").upper()).strip("-").lower()


def asset_type_matches(actual: str, requested: str | None) -> bool:
    if not requested:
        return True
    if requested == "fund":
        return actual in ("fund", "etf")
    if requested == "etf":
        return actual in ("fund", "etf")
    return actual == requested


def asset_visible_to_user(asset: dict[str, Any], user_id: str) -> bool:
    if asset.get("assetType") != "customAsset":
        return True
    return (asset.get("userId") or LOCAL_USER_ID) == user_id


def list_asset_history(db: dict[str, Any], user_id: str, market_id: str, asset_id: str, asset_type: str | None) -> list[dict[str, Any]]:
    if asset_type == "customFund":
        custom_fund = next(
            (
                item
                for item in db.get("customFunds", [])
                if item.get("userId") == user_id and item.get("marketId") == market_id and item.get("id") == asset_id
            ),
            None,
        )
        return ((custom_fund or {}).get("score") or {}).get("backtestHistory", [])

    daily_prices = sorted(
        (
            point
            for point in db.get("dailyPrices", [])
            if point.get("marketId") == market_id
            and point.get("assetId") == asset_id
            and (not asset_type or asset_type_matches(str(point.get("assetType")), asset_type))
        ),
        key=lambda point: str(point.get("date", "")),
    )
    if daily_prices:
        return [daily_price_to_time_point(point) for point in daily_prices]

    return []


def daily_price_to_time_point(point: dict[str, Any]) -> dict[str, Any]:
    value = point.get("nav") if point.get("nav") is not None else point.get("close")
    return {
        "date": point.get("date"),
        "value": value,
    }


def build_asset_detail(db: dict[str, Any], user_id: str, market_id: str, asset: dict[str, Any]) -> dict[str, Any]:
    asset_type = asset.get("assetType")
    if asset_type in ("fund", "etf"):
        fund = next((item for item in db.get("funds", []) if item.get("id") == asset.get("id") and item.get("marketId") == market_id), None)
        return build_fund_detail(fund) if fund else {"asset": asset}

    if asset_type == "stock":
        stock = next((item for item in db.get("stocks", []) if item.get("id") == asset.get("id") and item.get("marketId") == market_id), None)
        return build_stock_detail(stock) if stock else {"asset": asset}

    if asset_type == "customFund":
        custom_fund = next(
            (
                item
                for item in db.get("customFunds", [])
                if item.get("userId") == user_id and item.get("id") == asset.get("id") and item.get("marketId") == market_id
            ),
            None,
        )
        return custom_fund or {"asset": asset}

    return {
        "asset": asset,
        "performance": list_asset_history(db, user_id, market_id, str(asset.get("id")), str(asset_type) if asset_type else None),
        "metrics": [
            {"label": "Latest price", "value": format_maybe_currency(asset.get("latestPrice"), market_id), "tone": tone_from_change(asset.get("dailyChange"))},
            {"label": "Daily change", "value": format_maybe_percent(asset.get("dailyChange")), "tone": tone_from_change(asset.get("dailyChange"))},
        ],
    }


def build_fund_detail(fund: dict[str, Any]) -> dict[str, Any]:
    nav_history = fund.get("navHistory", [])
    one_year_return = number_or_zero(fund.get("oneYearReturn"))
    max_drawdown = number_or_zero(fund.get("maxDrawdown"))
    dividend_yield = number_or_zero(fund.get("dividendYield"))
    three_year_return = number_or_zero(fund.get("threeYearAnnualizedReturn"))
    holdings = fund.get("holdings", [])
    market_name = "US"

    return {
        "id": fund.get("id"),
        "symbol": fund.get("symbol"),
        "name": fund.get("name"),
        "description": (
            f"{fund.get('type')} for {fund.get('category')}. "
            f"{fund.get('style')} exposure with {format_percent(one_year_return)} one-year return "
            f"and {format_percent(max_drawdown)} max drawdown."
        ),
        "performance": nav_history,
        "allocation": to_slices(fund.get("sectorExposure", [])),
        "holdings": holdings,
        "rawFund": fund,
        "metrics": [
            {"label": "1Y return", "value": format_percent(one_year_return), "tone": tone_from_change(one_year_return)},
            {"label": "3Y annualized", "value": format_percent(three_year_return), "tone": tone_from_change(three_year_return)},
            {"label": "Expense", "value": f"{number_or_zero(fund.get('expenseRatio')):.2f}%"},
            {"label": "Dividend", "value": f"{dividend_yield:.2f}%", "tone": "positive" if dividend_yield > 2.5 else "neutral"},
        ],
        "calculated": calculated_from_history(nav_history),
        "valueNarrative": (
            f"{fund.get('name')} is positioned as a {str(fund.get('style') or '').lower()} sleeve. "
            f"Top exposure includes {', '.join(str(item.get('name')) for item in holdings[:3])}. "
            f"It is kept within the {market_name} market data boundary."
        ),
    }


def build_stock_detail(stock: dict[str, Any]) -> dict[str, Any]:
    price_history = stock.get("priceHistory", [])
    dividend_yield = number_or_zero(stock.get("dividendYield"))
    roe = number_or_zero(stock.get("roe"))

    return {
        "id": stock.get("id"),
        "symbol": stock.get("symbol"),
        "name": stock.get("name"),
        "description": (
            f"{stock.get('name')} is a {stock.get('industry')} stock in {stock.get('sector')} "
            f"with {format_percent(number_or_zero(stock.get('dailyChange')))} latest daily change."
        ),
        "performance": price_history,
        "rawStock": stock,
        "metrics": [
            {"label": "P/E", "value": f"{number_or_zero(stock.get('peRatio')):.1f}"},
            {"label": "P/B", "value": f"{number_or_zero(stock.get('pbRatio')):.1f}"},
            {"label": "Dividend", "value": f"{dividend_yield:.2f}%", "tone": "positive" if dividend_yield > 2.5 else "neutral"},
            {"label": "ROE", "value": f"{roe:.1f}%", "tone": tone_from_change(roe)},
        ],
        "scores": {
            "value": stock.get("valueScore"),
            "quality": stock.get("qualityScore"),
            "risk": stock.get("riskScore"),
        },
        "calculated": calculated_from_history(price_history),
    }


def list_custom_fund_universe(db: dict[str, Any], market_id: str) -> list[dict[str, Any]]:
    return [
        {
            **stock,
            "valueLabel": str(stock.get("valueScore")),
            "qualityLabel": str(stock.get("qualityScore")),
            "priceLabel": format_currency(number_or_zero(stock.get("price")), market_id),
        }
        for stock in list_real_stocks(db, market_id)
    ]


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
        "latestPrice": round(float(latest), 4) if isinstance(latest, (int, float)) else None,
        "latestVolume": None,
        "dailyChange": round(float(daily_change), 2) if isinstance(daily_change, (int, float)) else None,
        "popularity": 0,
        "source": "user-custom-fund",
        "quoteStatus": "missing" if latest is None else "fresh",
        "updatedAt": fund.get("updatedAt"),
    }


def refresh_top_assets_if_requested(
    request: Request,
    market_id: str,
    kind: str,
    refreshed: bool,
) -> dict[str, Any] | None:
    if not refreshed:
        return None
    from .data_sources import refresh_market_top_assets

    if kind not in ("stock", "fund"):
        raise validation_error("kind must be one of: stock, fund.")
    return refresh_market_top_assets(user_id=current_user_id(request), market_id=market_id, kind=kind)


def refresh_assets_if_requested(
    request: Request,
    market_id: str,
    asset_ids: list[str],
    refreshed: bool,
) -> dict[str, Any] | None:
    if not refreshed:
        return None
    from .data_sources import refresh_market_data

    range_value, start_date, end_date = asset_refresh_window(request)
    return refresh_market_data(user_id=current_user_id(request), market_id=market_id, asset_ids=asset_ids, range_value=range_value, start_date=start_date, end_date=end_date)


def asset_refresh_window(request: Request) -> tuple[str, str | None, str | None]:
    start_date = request.query_params.get("startDate") or None
    end_date = request.query_params.get("endDate") or None
    if start_date or end_date:
        return "max", start_date, end_date
    requested_range = request.query_params.get("range") or request.query_params.get("timeRange") or request.query_params.get("chartRange")
    if requested_range == "YTD":
        return "max", f"{now_iso()[:4]}-01-01", None
    range_map = {
        "1D": "1mo",
        "1W": "1mo",
        "1M": "1mo",
        "3M": "3mo",
        "6M": "6mo",
        "1Y": "1y",
        "3Y": "3y",
        "5Y": "5y",
        "10Y": "10y",
        "ALL": "max",
    }
    return range_map.get(requested_range or "ALL", "max"), None, None


def add_refresh_result(payload: dict[str, Any], refreshed: bool, refresh_result: dict[str, Any] | None = None) -> None:
    if not refreshed:
        return
    payload["refreshed"] = True
    if refresh_result is not None:
        payload["refreshResult"] = refresh_result
        return
    from .market_data_providers import MarketDataProviderManager

    payload["refreshResult"] = {"fetched": 0, "failed": [], "source": MarketDataProviderManager().source_label(payload.get("marketId"))}


def parse_asset_type(value: str | None) -> str | None:
    if value in (None, ""):
        return None
    if value not in ASSET_TYPES:
        raise validation_error(f"type must be one of: {', '.join(ASSET_TYPES)}.")
    return value


def parse_refresh(value: str | None) -> bool:
    if value in (None, "", "false", "0"):
        return False
    if value in ("true", "1"):
        return True
    raise validation_error("refresh must be one of: true, false, 1, 0.")


def tone_from_change(value: Any) -> str:
    if value is None:
        return "neutral"
    numeric = number_or_zero(value)
    if numeric > 0:
        return "positive"
    if numeric < 0:
        return "negative"
    return "neutral"


def format_maybe_currency(value: Any, market_id: str) -> str:
    return "—" if value is None else format_currency(number_or_zero(value), market_id)


def format_maybe_percent(value: Any) -> str:
    return "—" if value is None else format_percent(number_or_zero(value))


def to_slices(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"label": item.get("name"), "value": exposure_value(number_or_zero(item.get("weight")))} for item in items]


def exposure_value(weight: float) -> int:
    return round(weight * 100) if weight <= 1 else round(weight)
