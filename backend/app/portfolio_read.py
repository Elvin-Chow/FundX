from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Request

from .auth import current_user_id
from .errors import FundXApiError
from .services import (
    MarketId,
    browser_local_user_data_enabled,
    calculate_drawdown,
    calculate_return,
    calculate_volatility,
    days_between,
    format_currency,
    format_percent,
    get_cached_value,
    get_market_data_meta,
    healthy_insight_card,
    now_iso,
    number_or_zero,
    parse_market,
    read_db,
    round_number,
    summarize_portfolio,
    tone_from_change,
)

router = APIRouter()

TimeRange = Literal["1D", "1W", "1M", "3M", "6M", "1Y", "3Y", "5Y", "10Y", "ALL"]


@router.get("/api/portfolios")
def get_portfolios(request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    portfolio_id = request.query_params.get("portfolioId") or None
    range_value = parse_time_range(request.query_params.get("range"))
    user_id = current_user_id(request)
    db = read_db()
    if browser_local_user_data_enabled():
        meta = get_market_data_meta(db, market_id, cached=True)
        return {
            "marketId": meta["marketId"],
            "range": range_value,
            "portfolio": None,
            "portfolios": [],
            "summary": None,
            "cached": True,
            "overview": empty_portfolio_overview(market_id),
            "activities": [],
            "source": meta["source"],
            "updatedAt": meta["updatedAt"],
            "cache": meta["cache"],
        }
    portfolio = get_active_portfolio(db, user_id, market_id, portfolio_id)
    if not portfolio:
        meta = get_market_data_meta(db, market_id, cached=True)
        return {
            "marketId": meta["marketId"],
            "range": range_value,
            "portfolio": None,
            "portfolios": list_portfolios(db, user_id, market_id),
            "summary": None,
            "cached": True,
            "overview": empty_portfolio_overview(market_id),
            "activities": list_activities(db, user_id, market_id, None),
            "source": meta["source"],
            "updatedAt": meta["updatedAt"],
            "cache": meta["cache"],
        }

    analytics = get_portfolio_analytics(db, portfolio, range_value)
    summary = analytics["summary"]
    cached = bool(analytics["cached"])
    meta = get_market_data_meta(db, market_id, cached=cached)

    return {
        "marketId": meta["marketId"],
        "range": range_value,
        "portfolio": portfolio,
        "portfolios": list_portfolios(db, user_id, market_id),
        "summary": summary,
        "cached": cached,
        "overview": get_portfolio_overview(market_id, summary),
        "activities": list_activities(db, user_id, market_id, portfolio.get("id")),
        "source": meta["source"],
        "updatedAt": meta["updatedAt"],
        "cache": meta["cache"],
    }


def list_portfolios(db: dict[str, Any], user_id: str, market_id: MarketId) -> list[dict[str, Any]]:
    return [
        portfolio
        for portfolio in db.get("portfolios", [])
        if portfolio.get("userId") == user_id and portfolio.get("marketId") == market_id
        and not is_display_fixture_portfolio(portfolio)
    ]


def get_active_portfolio(
    db: dict[str, Any],
    user_id: str,
    market_id: MarketId,
    portfolio_id: str | None,
) -> dict[str, Any] | None:
    preferred_id = portfolio_id or get_active_portfolio_preference(db, user_id, market_id)
    portfolios = list_portfolios(db, user_id, market_id)
    preferred = next((item for item in portfolios if preferred_id and item.get("id") == preferred_id), None)
    return preferred or (portfolios[0] if portfolios else None)


def get_active_portfolio_preference(db: dict[str, Any], user_id: str, market_id: MarketId) -> str | None:
    user = next((item for item in db.get("users", []) if item.get("id") == user_id), None)
    preferences = user.get("preferences") if isinstance(user, dict) else None
    active_by_market = preferences.get("activePortfolioByMarket") if isinstance(preferences, dict) else None
    value = active_by_market.get(market_id) if isinstance(active_by_market, dict) else None
    return value if isinstance(value, str) and value else None


def get_portfolio_analytics(db: dict[str, Any], portfolio: dict[str, Any], range_value: TimeRange = "ALL") -> dict[str, Any]:
    start_date = saved_period_value(portfolio.get("startDate")) if range_value == "ALL" else None
    end_date = saved_period_value(portfolio.get("endDate")) if range_value == "ALL" else None
    cache_key = f"analytics:portfolio:{portfolio.get('id')}:{portfolio.get('updatedAt')}:{range_value}:{start_date or ''}:{end_date or ''}:v4"
    cached_summary = get_cached_value(db, cache_key)
    if isinstance(cached_summary, dict):
        return {"summary": cached_summary, "cached": True}
    return {"summary": build_portfolio_summary(portfolio, db, range_value, start_date=start_date, end_date=end_date), "cached": False}


def saved_period_value(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def build_portfolio_summary(
    portfolio: dict[str, Any],
    db: dict[str, Any] | None = None,
    range_value: TimeRange = "ALL",
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict[str, Any]:
    stored_history = stored_portfolio_value_history(portfolio)
    stored_contribution_history = stored_portfolio_contribution_history(portfolio)
    planned = {} if stored_history else build_planned_portfolio_from_targets(db or {}, portfolio, start_date, end_date)
    planned_holdings = planned.get("holdings") if isinstance(planned.get("holdings"), list) else None
    effective_portfolio = {**portfolio, "holdings": planned_holdings} if planned_holdings else portfolio
    base = summarize_portfolio(effective_portfolio)
    full_history_seed = stored_history or planned.get("valueHistory") or []
    contribution_history_seed = stored_contribution_history or planned.get("contributionHistory") or []
    total_value = number_or_zero(full_history_seed[-1].get("value")) if full_history_seed else number_or_zero(base.get("totalValue"))
    total_cost = number_or_zero(contribution_history_seed[-1].get("value")) if contribution_history_seed else number_or_zero(base.get("totalCost"))
    total_gain = total_value - total_cost
    holdings = []
    for holding in base.get("holdings", []):
        market_value = number_or_zero(holding.get("marketValue"))
        current_weight = 0 if total_value == 0 else round_number((market_value / total_value) * 100, 2)
        target_gap = round_number(normalize_target_weight_percent(holding.get("targetWeight")) - current_weight, 2)
        holdings.append(
            {
                **holding,
                "currentWeight": current_weight,
                "targetGap": target_gap,
            }
        )

    full_history = full_history_seed or build_portfolio_value_history(db or {}, portfolio, holdings)
    range_history = filter_history_by_dates(full_history, start_date, end_date) if start_date or end_date else filter_history_by_range(full_history, range_value)
    contribution_history = filter_history_by_dates(contribution_history_seed, start_date, end_date) if contribution_history_seed and (start_date or end_date) else filter_history_by_range(contribution_history_seed, range_value) if contribution_history_seed else []
    range_gain, range_gain_percent = range_return(range_history, contribution_history)
    drawdown = calculate_drawdown(range_history) if range_history else {"maxDrawdown": 0}
    volatility = calculate_volatility(range_history) if range_history else 0
    annualized_return = calculate_annualized_return(range_history)
    sector_exposure = calculate_sector_exposure(holdings)
    asset_type_exposure = calculate_asset_type_exposure(holdings, total_value)
    top_holding_concentration = max((number_or_zero(item.get("currentWeight")) for item in holdings), default=0)
    max_drawdown = number_or_zero(drawdown.get("maxDrawdown"))
    top_sector_weight = number_or_zero(sector_exposure[0].get("weight")) if sector_exposure else 0
    risk_score = 0 if not holdings else round_number(
        clamp(30 + top_holding_concentration * 0.35 + top_sector_weight * 0.25 + abs(max_drawdown) * 0.8, 0, 100),
        1,
    )

    return {
        **base,
        "totalValue": round_number(total_value, 2),
        "totalCost": round_number(total_cost, 2),
        "totalGain": round_number(total_gain, 2),
        "totalGainPercent": round_number(calculate_return(total_cost, total_value), 2),
        "range": range_value,
        "rangeGain": round_number(range_gain, 2),
        "rangeGainPercent": round_number(range_gain_percent, 2),
        "rangeStartDate": start_date or planned.get("startDate") or (range_history[0].get("date") if range_history else None),
        "rangeEndDate": end_date or planned.get("endDate") or (range_history[-1].get("date") if range_history else None),
        "rangePointCount": len(range_history),
        "annualizedReturn": annualized_return,
        "maxDrawdown": max_drawdown,
        "volatility": volatility,
        "valueHistory": range_history,
        "holdings": holdings,
        "sectorExposure": sector_exposure,
        "assetTypeExposure": asset_type_exposure,
        "topHoldingConcentration": round_number(top_holding_concentration, 2),
        "riskScore": risk_score,
    }


def stored_portfolio_value_history(portfolio: dict[str, Any]) -> list[dict[str, Any]]:
    value = portfolio.get("valueHistory")
    if not isinstance(value, list):
        return []
    rows = [
        {"date": str(item.get("date")), "value": round_number(number_or_zero(item.get("value")), 2)}
        for item in value
        if isinstance(item, dict) and item.get("date") and number_or_zero(item.get("value")) >= 0
    ]
    by_date = {item["date"]: item for item in rows}
    return [by_date[date] for date in sorted(by_date)]


def stored_portfolio_contribution_history(portfolio: dict[str, Any]) -> list[dict[str, Any]]:
    value = portfolio.get("contributionHistory")
    if not isinstance(value, list):
        return []
    rows = [
        {"date": str(item.get("date")), "value": round_number(number_or_zero(item.get("value")), 2)}
        for item in value
        if isinstance(item, dict) and item.get("date") and number_or_zero(item.get("value")) >= 0
    ]
    by_date = {item["date"]: item for item in rows}
    return [by_date[date] for date in sorted(by_date)]


def parse_time_range(value: str | None) -> TimeRange:
    if value in ("1D", "1W", "1M", "3M", "6M", "1Y", "3Y", "5Y", "10Y", "ALL"):
        return value
    return "ALL"


def build_portfolio_value_history(db: dict[str, Any], portfolio: dict[str, Any], holdings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not holdings:
        return []
    price_rows_by_asset: dict[str, list[dict[str, Any]]] = {}
    holding_asset_ids = {str(holding.get("assetId") or "") for holding in holdings if holding.get("assetId")}
    for row in db.get("dailyPrices", []):
        if row.get("assetId") not in holding_asset_ids:
            continue
        price = history_price(row)
        date = str(row.get("date") or "")
        if price <= 0 or not date:
            continue
        price_rows_by_asset.setdefault(str(row.get("assetId")), []).append({"date": date, "price": price})

    for rows in price_rows_by_asset.values():
        rows.sort(key=lambda item: item["date"])

    priced_asset_ids = [asset_id for asset_id in holding_asset_ids if price_rows_by_asset.get(asset_id)]
    if not priced_asset_ids:
        return []

    first_complete_date = max(price_rows_by_asset[asset_id][0]["date"] for asset_id in priced_asset_ids)
    dates = sorted({row["date"] for asset_id in priced_asset_ids for row in price_rows_by_asset[asset_id] if row["date"] >= first_complete_date})
    if not dates:
        return []

    current_by_asset: dict[str, float] = {}
    row_index_by_asset = {asset_id: 0 for asset_id in priced_asset_ids}
    priced_holdings = [holding for holding in holdings if str(holding.get("assetId") or "") in priced_asset_ids]
    unpriced_value = sum(number_or_zero(holding.get("marketValue")) for holding in holdings if str(holding.get("assetId") or "") not in priced_asset_ids)
    history: list[dict[str, Any]] = []
    cash_balance = number_or_zero(portfolio.get("cashBalance"))

    for date in dates:
        for asset_id in priced_asset_ids:
            rows = price_rows_by_asset[asset_id]
            row_index = row_index_by_asset[asset_id]
            while row_index < len(rows) and rows[row_index]["date"] <= date:
                current_by_asset[asset_id] = number_or_zero(rows[row_index]["price"])
                row_index += 1
            row_index_by_asset[asset_id] = row_index
        if any(asset_id not in current_by_asset for asset_id in priced_asset_ids):
            continue
        value = cash_balance + unpriced_value
        for holding in priced_holdings:
            asset_id = str(holding.get("assetId") or "")
            value += number_or_zero(holding.get("quantity")) * number_or_zero(current_by_asset.get(asset_id))
        history.append({"date": date, "value": round_number(value, 2)})

    return history


def build_planned_portfolio_from_targets(
    db: dict[str, Any],
    portfolio: dict[str, Any],
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict[str, Any]:
    holdings = [holding for holding in portfolio.get("holdings", []) if isinstance(holding, dict) and holding.get("assetId")]
    if not holdings:
        return {}
    market_id = str(portfolio.get("marketId") or "")
    effective_start = start_date or saved_period_value(portfolio.get("startDate"))
    effective_end = end_date or saved_period_value(portfolio.get("endDate")) or now_iso()[:10]
    capital = number_or_zero(portfolio.get("capital")) or infer_portfolio_capital(portfolio, holdings)
    if capital <= 0:
        return {}

    target_weights = [normalize_target_weight_percent(holding.get("targetWeight")) for holding in holdings]
    total_weight = sum(weight for weight in target_weights if weight > 0)
    if total_weight <= 0:
        return {}

    planned_holdings: list[dict[str, Any]] = []
    holding_histories: list[list[dict[str, Any]]] = []

    for holding, target_weight in zip(holdings, target_weights):
        if target_weight <= 0:
            continue
        rows = portfolio_price_rows(db, market_id, str(holding.get("assetId") or ""), effective_start, effective_end)
        if not rows:
            continue
        start_price = first_price_on_or_after(rows, effective_start)
        end_price = last_price_on_or_before(rows, effective_end)
        if start_price <= 0 or end_price <= 0:
            continue
        allocation = capital * (target_weight / total_weight)
        quantity = allocation / start_price
        planned_holding = {
            **holding,
            "quantity": quantity,
            "averageCost": start_price,
            "currentPrice": end_price,
            "targetWeight": target_weight,
        }
        planned_holdings.append(planned_holding)
        holding_histories.append(planned_holding_history(rows, quantity, effective_start, effective_end))

    if not planned_holdings or not holding_histories:
        return {}

    value_history = combine_value_histories(holding_histories, number_or_zero(portfolio.get("cashBalance")))
    actual_start = str((value_history[0] if value_history else {}).get("date") or effective_start or effective_end)
    contribution_history = contribution_history_for_period(capital, actual_start, effective_end, value_history)
    return {
        "holdings": planned_holdings,
        "valueHistory": value_history,
        "contributionHistory": contribution_history,
        "startDate": actual_start,
        "endDate": effective_end,
    }


def infer_portfolio_capital(portfolio: dict[str, Any], holdings: list[dict[str, Any]]) -> float:
    explicit_cash = number_or_zero(portfolio.get("cashBalance"))
    current_value = sum(number_or_zero(holding.get("quantity")) * number_or_zero(holding.get("currentPrice")) for holding in holdings)
    if current_value > 0:
        return round_number(current_value + explicit_cash, 2)
    cost_value = sum(number_or_zero(holding.get("quantity")) * number_or_zero(holding.get("averageCost")) for holding in holdings)
    return round_number(cost_value + explicit_cash, 2)


def portfolio_price_rows(db: dict[str, Any], market_id: str, asset_id: str, start_date: str | None, end_date: str) -> list[dict[str, Any]]:
    rows = [
        {"date": str(row.get("date") or ""), "price": history_price(row)}
        for row in db.get("dailyPrices", [])
        if row.get("marketId") == market_id
        and row.get("assetId") == asset_id
        and history_price(row) > 0
        and str(row.get("date") or "") <= end_date
    ]
    rows.sort(key=lambda item: item["date"])
    if not rows:
        return []
    first_available = next((row for row in rows if not start_date or row["date"] >= start_date), rows[0] if not start_date else rows[-1])
    return [row for row in rows if row["date"] >= first_available["date"]]


def first_price_on_or_after(rows: list[dict[str, Any]], start_date: str | None) -> float:
    row = next((item for item in rows if not start_date or item["date"] >= start_date), rows[0] if rows else None)
    return number_or_zero((row or {}).get("price"))


def last_price_on_or_before(rows: list[dict[str, Any]], end_date: str) -> float:
    candidates = [item for item in rows if item["date"] <= end_date]
    row = candidates[-1] if candidates else rows[-1] if rows else None
    return number_or_zero((row or {}).get("price"))


def planned_holding_history(rows: list[dict[str, Any]], quantity: float, start_date: str | None, end_date: str) -> list[dict[str, Any]]:
    history = [{"date": row["date"], "value": round_number(quantity * number_or_zero(row.get("price")), 2)} for row in rows if row["date"] <= end_date]
    if start_date and history and history[0]["date"] != start_date:
        history.insert(0, {"date": start_date, "value": history[0]["value"]})
    if history and history[-1]["date"] != end_date:
        history.append({"date": end_date, "value": history[-1]["value"]})
    return dedupe_value_history(history)


def contribution_history_for_period(capital: float, start_date: str, end_date: str, value_history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not value_history:
        return []
    history = [{"date": start_date, "value": round_number(capital, 2)}]
    if end_date != start_date:
        history.append({"date": end_date, "value": round_number(capital, 2)})
    return history


def combine_value_histories(histories: list[list[dict[str, Any]]], base_value: float) -> list[dict[str, Any]]:
    clean_histories = [dedupe_value_history(history) for history in histories if history]
    dates = sorted({str(point.get("date")) for history in clean_histories for point in history if point.get("date")})
    if not dates:
        return []
    indexes = [0 for _ in clean_histories]
    current_values: list[float | None] = [None for _ in clean_histories]
    result = []
    for current_date in dates:
        for history_index, history in enumerate(clean_histories):
            while indexes[history_index] < len(history) and str(history[indexes[history_index]].get("date")) <= current_date:
                current_values[history_index] = number_or_zero(history[indexes[history_index]].get("value"))
                indexes[history_index] += 1
        total = base_value + sum(value for value in current_values if value is not None)
        result.append({"date": current_date, "value": round_number(total, 2)})
    return result


def dedupe_value_history(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_date = {str(item.get("date")): item for item in history if item.get("date")}
    return [by_date[date] for date in sorted(by_date)]


def history_price(row: dict[str, Any]) -> float:
    return number_or_zero(row.get("close") if row.get("close") is not None else row.get("nav"))


def filter_history_by_range(history: list[dict[str, Any]], range_value: TimeRange) -> list[dict[str, Any]]:
    sorted_history = sorted(history, key=lambda item: str(item.get("date") or ""))
    if range_value == "ALL":
        return sorted_history
    windows: dict[TimeRange, int] = {
        "1D": 2,
        "1W": 7,
        "1M": 22,
        "3M": 66,
        "6M": 126,
        "1Y": 252,
        "3Y": 756,
        "5Y": 1260,
        "10Y": 2520,
        "ALL": len(sorted_history),
    }
    return sorted_history[-windows[range_value] :]


def filter_history_by_dates(history: list[dict[str, Any]], start_date: str | None, end_date: str | None) -> list[dict[str, Any]]:
    sorted_history = sorted(history, key=lambda item: str(item.get("date") or ""))
    if not start_date and not end_date:
        return sorted_history
    return [
        point
        for point in sorted_history
        if (not start_date or str(point.get("date") or "") >= start_date)
        and (not end_date or str(point.get("date") or "") <= end_date)
    ]


def range_return(history: list[dict[str, Any]], contribution_history: list[dict[str, Any]] | None = None) -> tuple[float, float]:
    if len(history) < 2:
        return 0, 0
    end = number_or_zero(history[-1].get("value"))
    if contribution_history:
        invested = number_or_zero(contribution_history[-1].get("value"))
        return end - invested, calculate_return(invested, end)
    start = number_or_zero(history[0].get("value"))
    return end - start, calculate_return(start, end)


def calculate_annualized_return(history: list[dict[str, Any]]) -> float:
    if len(history) < 2:
        return 0
    start = number_or_zero(history[0].get("value"))
    end = number_or_zero(history[-1].get("value"))
    days = max(1, days_between(str(history[0].get("date") or ""), str(history[-1].get("date") or "")))
    if start <= 0:
        return 0
    return round_number(((end / start) ** (365.25 / days) - 1) * 100, 2)


def is_display_fixture_portfolio(portfolio: dict[str, Any]) -> bool:
    name = str(portfolio.get("name") or "").strip().lower()
    goal = str(portfolio.get("goal") or "").strip().lower()
    if name.startswith("smoke portfolio") or goal == "smoke coverage":
        return True
    for holding in portfolio.get("holdings", []):
        if not isinstance(holding, dict):
            continue
        holding_name = str(holding.get("name") or "").strip().lower()
        symbol = str(holding.get("symbol") or "").strip().upper()
        if holding_name.startswith("smoke ") or symbol.startswith("SMK"):
            return True
    return False


def get_portfolio_overview(market_id: MarketId, summary: dict[str, Any]) -> dict[str, Any]:
    value_history = summary.get("valueHistory")
    if not isinstance(value_history, list):
        value_history = []
    holdings = summary.get("holdings")
    if not isinstance(holdings, list):
        holdings = []
    return {
        "totalValue": format_currency(number_or_zero(summary.get("totalValue")), market_id),
        "dailyGain": format_percent(daily_gain(value_history)),
        "equityCurve": value_history,
        "metrics": [
            {
                "label": "Total gain",
                "value": format_currency(number_or_zero(summary.get("totalGain")), market_id),
                "delta": format_percent(number_or_zero(summary.get("totalGainPercent"))),
                "tone": tone_from_change(summary.get("totalGain")),
            },
            {
                "label": "Annualized",
                "value": format_percent(number_or_zero(summary.get("annualizedReturn"))),
                "tone": tone_from_change(summary.get("annualizedReturn")),
            },
            {"label": "Cash", "value": format_currency(number_or_zero(summary.get("cashBalance")), market_id)},
            {
                "label": "Risk score",
                "value": str(summary.get("riskScore", 0)),
                "tone": "negative" if number_or_zero(summary.get("riskScore")) > 65 else "neutral",
            },
        ],
        "topAssets": top_assets(holdings, market_id),
        "primaryInsight": healthy_insight_card(),
    }


def empty_portfolio_overview(market_id: MarketId) -> dict[str, Any]:
    return {
        "totalValue": format_currency(0, market_id),
        "dailyGain": format_percent(0),
        "equityCurve": [],
        "metrics": [
            {"label": "Total gain", "value": format_currency(0, market_id), "delta": format_percent(0), "tone": "neutral"},
            {"label": "Annualized", "value": format_percent(0), "tone": "neutral"},
            {"label": "Cash", "value": format_currency(0, market_id)},
            {"label": "Risk score", "value": "n/a", "tone": "neutral"},
        ],
        "topAssets": [],
        "primaryInsight": healthy_insight_card(),
    }


def top_assets(holdings: list[dict[str, Any]], market_id: MarketId) -> list[dict[str, Any]]:
    assets = []
    for holding in holdings[:5]:
        asset_type = holding.get("assetType")
        assets.append(
            {
                "id": holding.get("id"),
                "name": holding.get("name"),
                "symbol": holding.get("symbol"),
                "subtitle": (
                    "Fund holding"
                    if asset_type == "fund"
                    else "Stock holding"
                    if asset_type == "stock"
                    else "Asset holding"
                ),
                "value": format_currency(number_or_zero(holding.get("marketValue")), market_id),
                "delta": format_percent(number_or_zero(holding.get("gainPercent"))),
                "tone": tone_from_change(holding.get("gain")),
            }
        )
    return assets


def list_activities(
    db: dict[str, Any],
    user_id: str,
    market_id: MarketId,
    portfolio_id: str | None,
) -> list[dict[str, Any]]:
    cash_movements = [
        item
        for item in db.get("cashMovements", [])
        if item.get("userId") == user_id
        and item.get("marketId") == market_id
        and (not portfolio_id or item.get("portfolioId") == portfolio_id)
    ]
    return [
        {
            "id": item.get("id"),
            "marketId": item.get("marketId"),
            "title": cash_movement_title(str(item.get("type", ""))),
            "subtitle": item.get("note") or item.get("type"),
            "amount": item.get("amount"),
            "date": item.get("date"),
            "type": (
                "dividend"
                if item.get("type") == "dividend"
                else "deposit"
                if number_or_zero(item.get("amount")) >= 0
                else "sell"
            ),
        }
        for item in sorted(cash_movements, key=lambda value: str(value.get("date", "")), reverse=True)[:20]
    ]


def calculate_sector_exposure(holdings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    total = sum(number_or_zero(holding.get("marketValue")) for holding in holdings)
    if total == 0:
        return []
    grouped: dict[str, float] = {}
    for holding in holdings:
        sector = str(holding.get("sector") or "Other")
        grouped[sector] = grouped.get(sector, 0) + number_or_zero(holding.get("marketValue"))
    return [{"name": name, "weight": round_number((value / total) * 100, 2)} for name, value in grouped.items()]


def calculate_asset_type_exposure(holdings: list[dict[str, Any]], total_value: float) -> list[dict[str, Any]]:
    if total_value == 0:
        return []
    grouped: dict[str, float] = {}
    for holding in holdings:
        asset_type = str(holding.get("assetType") or "asset")
        grouped[asset_type] = grouped.get(asset_type, 0) + number_or_zero(holding.get("marketValue"))
    return [{"name": name, "weight": round_number((value / total_value) * 100, 2)} for name, value in grouped.items()]


def daily_gain(value_history: Any) -> float:
    if not isinstance(value_history, list) or len(value_history) < 2:
        return 0
    latest = number_or_zero((value_history[-1] or {}).get("value") if isinstance(value_history[-1], dict) else None)
    previous = number_or_zero((value_history[-2] or {}).get("value") if isinstance(value_history[-2], dict) else None)
    if previous == 0:
        return 0
    return ((latest - previous) / previous) * 100


def normalize_target_weight_percent(value: Any) -> float:
    weight = number_or_zero(value)
    return round_number(weight * 100 if weight <= 1 else weight, 2)


def cash_movement_title(movement_type: str) -> str:
    return {
        "deposit": "Cash deposit",
        "withdrawal": "Cash withdrawal",
        "dividend": "Dividend received",
        "fee": "Fee charged",
        "interest": "Interest received",
        "adjustment": "Portfolio adjustment",
    }.get(movement_type, "Portfolio adjustment")


def portfolio_not_found() -> FundXApiError:
    return FundXApiError("not_found", "Portfolio was not found in the selected market.", 404)


def clamp(value: float, minimum: float, maximum: float) -> float:
    return min(max(value, minimum), maximum)
