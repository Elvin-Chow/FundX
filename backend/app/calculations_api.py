from __future__ import annotations

import hashlib
import random
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Request

from .assets import asset_detail_payload, parse_asset_type
from .auth import current_user_id
from .custom_funds import market_stocks, score_custom_fund
from .data_sources import refresh_market_data
from .dca import (
    DCA_FREQUENCIES,
    DCA_STRATEGIES,
    has_real_nav_history,
    real_market_asset,
    simulate_dca_plan,
)
from .errors import FundXApiError, validation_error
from .portfolio_read import build_portfolio_summary, get_active_portfolio
from .reports_jobs_settings import build_report_payload
from .services import (
    MarketId,
    asset_kind,
    asset_visible_to_user,
    browser_local_user_data_enabled,
    calculate_drawdown,
    calculate_return,
    calculate_volatility,
    clone_json,
    create_id,
    custom_fund_to_asset,
    days_between,
    get_market_data_meta,
    is_public_market_asset,
    normalize_asset_record,
    normalize_asset_type,
    now_iso,
    number_or_zero,
    parse_market,
    read_db,
    round_number,
    sort_history,
    update_db,
)

Workflow = Literal[
    "portfolio",
    "dca",
    "custom-fund",
    "compare",
    "watchlist",
    "insights",
    "asset-detail",
    "fund-detail",
    "report",
]

router = APIRouter(tags=["calculations"])

WORKFLOWS: set[str] = {
    "portfolio",
    "dca",
    "custom-fund",
    "compare",
    "watchlist",
    "insights",
    "asset-detail",
    "fund-detail",
    "report",
}

DEFAULT_INSIGHT_SIMULATIONS = 12000
MAX_INSIGHT_SIMULATIONS = 50000
INSIGHT_CANDIDATE_POOL_LIMIT = 420
INSIGHT_RECOMMENDATION_LIMIT = 12
INSIGHT_MIN_HISTORY_POINTS = 20


@router.get("/api/insights/recommendations")
def list_insight_recommendations_route(request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    user_id = current_user_id(request)
    limit = query_int(request.query_params.get("limit"), default=INSIGHT_RECOMMENDATION_LIMIT, minimum=1, maximum=50)
    db = read_db()
    return {
        "ok": True,
        **get_market_data_meta(db, market_id, cached=True),
        "recommendations": recent_insight_recommendations(db, user_id, market_id, limit),
    }


@router.post("/api/calculations", status_code=201)
async def run_calculation_route(request: Request) -> dict[str, Any]:
    body = await read_json_body(request)
    market_id = parse_market(str(body.get("marketId") or request.query_params.get("market") or ""))
    if request.query_params.get("market") and parse_market(request.query_params.get("market")) != market_id:
        raise FundXApiError("market_mismatch", "Request query market and body marketId must match.", 400)

    workflow = require_workflow(body.get("workflow"))
    assets = require_assets(body.get("assets"))
    params = body.get("params") if isinstance(body.get("params"), dict) else {}
    refresh = body.get("refresh") is not False
    user_id = current_user_id(request)
    db = read_db()
    assets = derive_assets_for_workflow(db, user_id, market_id, workflow, assets, params)
    refresh_result = sync_selected_assets(user_id, market_id, assets, params) if refresh else no_refresh_result()
    db = read_db()
    warnings = warnings_from_refresh(refresh_result)
    result = build_calculation_result(db, user_id, market_id, workflow, assets, params, refresh_result)
    meta = get_market_data_meta(db, market_id)

    return {
        "ok": True,
        "marketId": market_id,
        "workflow": workflow,
        "runId": f"calc-{uuid.uuid4()}",
        "computedAt": now_iso(),
        "dataAsOf": meta.get("updatedAt"),
        "refreshResult": refresh_result,
        "warnings": warnings,
        "result": result,
    }


async def read_json_body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception as exc:
        raise FundXApiError("invalid_json", "Request body must be valid JSON.", 400) from exc
    if not isinstance(body, dict):
        raise validation_error("Request body must be a JSON object.")
    return body


def require_workflow(value: Any) -> Workflow:
    if isinstance(value, str) and value in WORKFLOWS:
        return value  # type: ignore[return-value]
    raise validation_error(f"workflow must be one of: {', '.join(sorted(WORKFLOWS))}.")


def require_assets(value: Any) -> list[dict[str, str]]:
    if value in (None, ""):
        return []
    if not isinstance(value, list):
        raise validation_error("assets must be an array.")
    assets: list[dict[str, str]] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise validation_error(f"assets[{index}] must be an object.")
        asset_id = item.get("assetId")
        asset_type = item.get("assetType")
        if not isinstance(asset_id, str) or not asset_id.strip():
            raise validation_error(f"assets[{index}].assetId is required.")
        if not isinstance(asset_type, str) or asset_type not in {"fund", "stock", "etf", "customFund", "customAsset"}:
            raise validation_error(f"assets[{index}].assetType is invalid.")
        assets.append({"assetId": asset_id.strip(), "assetType": asset_type})
    return assets


def derive_assets_for_workflow(
    db: dict[str, Any],
    user_id: str,
    market_id: MarketId,
    workflow: Workflow,
    assets: list[dict[str, str]],
    params: dict[str, Any],
) -> list[dict[str, str]]:
    if assets:
        return assets
    if workflow in {"portfolio", "report"}:
        portfolio_id = string_param(params, "portfolioId")
        portfolio = get_active_portfolio(db, user_id, market_id, portfolio_id)
        if portfolio:
            return [
                {"assetId": str(holding.get("assetId")), "assetType": normalize_asset_type(holding.get("assetType"))}
                for holding in portfolio.get("holdings", [])
                if holding.get("assetId")
            ]
    if workflow == "insights" and params.get("scope") == "portfolio":
        portfolio_id = string_param(params, "portfolioId")
        portfolio = get_active_portfolio(db, user_id, market_id, portfolio_id)
        if portfolio:
            return [
                {"assetId": str(holding.get("assetId")), "assetType": normalize_asset_type(holding.get("assetType"))}
                for holding in portfolio.get("holdings", [])
                if holding.get("assetId")
            ]
    return []


def sync_selected_assets(user_id: str, market_id: MarketId, assets: list[dict[str, str]], params: dict[str, Any]) -> dict[str, Any]:
    public_asset_ids = list(dict.fromkeys(asset["assetId"] for asset in assets if asset["assetType"] in {"fund", "stock", "etf"}))
    if not public_asset_ids:
        return no_refresh_result()
    range_value, start_date, end_date = market_data_request_window(params)
    try:
        return refresh_market_data(user_id=user_id, market_id=market_id, asset_ids=public_asset_ids, range_value=range_value, start_date=start_date, end_date=end_date)
    except Exception as exc:
        return {
            "fetched": 0,
            "failed": [{"assetId": asset_id, "reason": str(exc) or type(exc).__name__} for asset_id in public_asset_ids],
            "source": "market-data",
            "range": range_value,
            "startDate": start_date,
            "endDate": end_date,
        }


def market_data_request_window(params: dict[str, Any]) -> tuple[str, str | None, str | None]:
    start_date = string_param(params, "startDate")
    end_date = string_param(params, "endDate")
    if start_date or end_date:
        return "max", start_date, end_date
    requested_range = string_param(params, "range") or string_param(params, "timeRange") or string_param(params, "chartRange")
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
        "1mo": "1mo",
        "3mo": "3mo",
        "6mo": "6mo",
        "1y": "1y",
        "3y": "3y",
        "5y": "5y",
        "10y": "10y",
        "max": "max",
    }
    return range_map.get(requested_range or "ALL", "max"), None, None


def no_refresh_result() -> dict[str, Any]:
    return {"fetched": 0, "failed": [], "source": "not-requested", "skipped": "no-public-assets"}


def warnings_from_refresh(refresh_result: dict[str, Any]) -> list[dict[str, str]]:
    failed = refresh_result.get("failed") if isinstance(refresh_result.get("failed"), list) else []
    return [
        {
            "assetId": str(item.get("assetId") or ""),
            "message": str(item.get("reason") or "Quote refresh failed."),
        }
        for item in failed
        if isinstance(item, dict)
    ]


def build_calculation_result(
    db: dict[str, Any],
    user_id: str,
    market_id: MarketId,
    workflow: Workflow,
    assets: list[dict[str, str]],
    params: dict[str, Any],
    refresh_result: dict[str, Any],
) -> dict[str, Any]:
    if workflow == "compare":
        return {"items": [compare_item(db, user_id, market_id, asset) for asset in assets]}
    if workflow in {"asset-detail", "fund-detail"}:
        return detail_result(db, user_id, market_id, assets, workflow, refresh_result)
    if workflow == "dca":
        return dca_result(db, market_id, assets, params)
    if workflow == "custom-fund":
        return custom_fund_result(db, user_id, market_id, assets, params)
    if workflow == "portfolio":
        return portfolio_result(db, user_id, market_id, assets, params)
    if workflow == "watchlist":
        return watchlist_result(db, user_id, market_id, assets, params)
    if workflow == "insights":
        return insights_result(db, user_id, market_id, assets, params)
    if workflow == "report":
        return report_result(db, user_id, market_id, assets, params)
    raise validation_error("Unsupported workflow.")


def detail_result(
    db: dict[str, Any],
    user_id: str,
    market_id: MarketId,
    assets: list[dict[str, str]],
    workflow: Workflow,
    refresh_result: dict[str, Any],
) -> dict[str, Any]:
    if not assets:
        raise validation_error("At least one asset is required.")
    selected = assets[0]
    asset_type = "fund" if workflow == "fund-detail" else selected.get("assetType")
    return asset_detail_payload(
        db,
        user_id,
        market_id,
        selected["assetId"],
        parse_asset_type(asset_type),
        True,
        refresh_result,
    )


def compare_item(db: dict[str, Any], user_id: str, market_id: MarketId, selected: dict[str, str]) -> dict[str, Any]:
    asset = resolve_selected_asset(db, user_id, market_id, selected)
    history = list_asset_history(db, user_id, market_id, str(asset.get("id")), str(asset.get("assetType") or selected.get("assetType")))
    drawdown = calculate_drawdown(history)
    volatility = calculate_volatility(history)
    total_return = cumulative_return(history)
    return {
        "asset": asset,
        "history": history,
        "metrics": {
            "return": total_return,
            "volatility": volatility,
            "maxDrawdown": drawdown.get("maxDrawdown", 0),
            "riskScore": round_number(abs(number_or_zero(drawdown.get("maxDrawdown"))) + volatility, 2),
            "dividendYield": number_or_zero(asset.get("dividendYield")),
            "expenseRatio": number_or_zero(asset.get("expenseRatio")),
        },
        "allocation": [{"name": asset.get("sector") or asset.get("industry") or asset.get("category") or "Other", "weight": 100}],
        "holdings": [],
    }


def dca_result(db: dict[str, Any], market_id: MarketId, assets: list[dict[str, str]], params: dict[str, Any]) -> dict[str, Any]:
    if not assets:
        raise validation_error("Select one asset before running DCA.")
    asset_id = assets[0]["assetId"]
    fund = real_market_asset(db, market_id, asset_id)
    if not fund:
        raise FundXApiError("not_found", "Asset was not found in the selected market.", 404)
    if not has_real_nav_history(fund):
        raise FundXApiError("invalid_request", "Real price or NAV history is required before this DCA calculation can run.", 400)
    input_data = {
        "marketId": market_id,
        "fundId": asset_id,
        "name": string_param(params, "name") or f"{fund.get('name')} DCA",
        "initialAmount": number_param(params, "initialAmount", 1000),
        "recurringAmount": number_param(params, "recurringAmount", 500),
        "frequency": choice_param(params, "frequency", DCA_FREQUENCIES, "monthly"),
        "startDate": string_param(params, "startDate") or first_history_date(fund),
        "endDate": string_param(params, "endDate") or last_history_date(fund),
        "reinvestDividends": bool(params.get("reinvestDividends", True)),
        "transactionCost": number_param(params, "transactionCost", 0),
        "strategy": choice_param(params, "strategy", DCA_STRATEGIES, "standard"),
    }
    return {"asset": fund, "input": input_data, "simulation": simulate_dca_plan(fund, input_data)}


def custom_fund_result(db: dict[str, Any], user_id: str, market_id: MarketId, assets: list[dict[str, str]], params: dict[str, Any]) -> dict[str, Any]:
    if not assets:
        raise validation_error("Select at least one stock before calculating a custom fund.")
    holdings = holdings_from_params_or_assets(assets, params)
    stock_universe = market_stocks(db, market_id)
    score = score_custom_fund(market_id, holdings, stock_universe)
    stock_by_id = {stock.get("id"): stock for stock in stock_universe}
    selected_assets = [
        custom_fund_selected_asset(resolve_selected_asset(db, user_id, market_id, asset), stock_by_id)
        for asset in assets
    ]
    capital = number_param(params, "capital", 100000)
    cash_balance = number_param(params, "cashBalance", 0)
    dca_plans = portfolio_dca_plans(params)
    if has_enabled_portfolio_dca_plan(dca_plans):
        draft = draft_holdings_with_dca(db, user_id, market_id, assets, params, capital, cash_balance, dca_plans)
        summary_holdings = draft["holdings"]
        value_history = draft["valueHistory"]
        contribution_history = draft["contributionHistory"]
        dca_results = draft["dcaResults"]
    else:
        summary_holdings = draft_holdings(db, user_id, market_id, assets, params, capital)
        value_history = []
        contribution_history = []
        dca_results = []
    portfolio = {
        "id": string_param(params, "customFundId") or "draft-custom-fund",
        "marketId": market_id,
        "name": string_param(params, "name") or "Custom stock fund",
        "currency": "USD",
        "goal": string_param(params, "style") or "Custom stock fund",
        "riskPreference": "Custom",
        "capital": capital,
        "startDate": string_param(params, "startDate"),
        "endDate": string_param(params, "endDate"),
        "dcaPlans": dca_plans,
        "cashBalance": cash_balance,
        "holdings": summary_holdings,
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
    }
    if value_history:
        portfolio["valueHistory"] = value_history
        portfolio["contributionHistory"] = contribution_history
        portfolio["dcaResults"] = dca_results
    summary = build_portfolio_summary(
        portfolio,
        db,
        start_date=string_param(params, "startDate"),
        end_date=string_param(params, "endDate"),
    )
    return {
        "name": string_param(params, "name") or "Custom stock fund",
        "style": string_param(params, "style") or "Quality Value",
        "holdings": holdings,
        "score": score,
        "assets": selected_assets,
        "portfolio": portfolio,
        "summary": summary,
    }


def custom_fund_selected_asset(asset: dict[str, Any], stock_by_id: dict[Any, dict[str, Any]]) -> dict[str, Any]:
    stock = stock_by_id.get(asset.get("id")) or {}
    return {
        **asset,
        "latestPrice": stock.get("price") if stock.get("price") is not None else asset.get("latestPrice"),
        "dailyChange": stock.get("dailyChange") if stock.get("dailyChange") is not None else asset.get("dailyChange"),
        "sector": stock.get("sector") or asset.get("sector"),
        "industry": stock.get("industry") or asset.get("industry"),
        "category": stock.get("category") or asset.get("category"),
        "dividendYield": stock.get("dividendYield"),
        "peRatio": stock.get("peRatio"),
        "pbRatio": stock.get("pbRatio"),
        "roe": stock.get("roe"),
        "valueScore": stock.get("valueScore"),
        "qualityScore": stock.get("qualityScore"),
        "riskScore": stock.get("riskScore"),
    }


def portfolio_result(
    db: dict[str, Any],
    user_id: str,
    market_id: MarketId,
    assets: list[dict[str, str]],
    params: dict[str, Any],
) -> dict[str, Any]:
    portfolio_id = string_param(params, "portfolioId")
    saved_portfolio = get_active_portfolio(db, user_id, market_id, portfolio_id)
    if assets:
        capital = number_param(params, "capital", number_or_zero((saved_portfolio or {}).get("capital")) or number_or_zero((saved_portfolio or {}).get("cashBalance")) or 100000)
        cash_balance = number_param(params, "cashBalance", 0)
        dca_plans = portfolio_dca_plans(params)
        if has_enabled_portfolio_dca_plan(dca_plans):
            draft = draft_holdings_with_dca(db, user_id, market_id, assets, params, capital, cash_balance, dca_plans)
            holdings = draft["holdings"]
            value_history = draft["valueHistory"]
            contribution_history = draft["contributionHistory"]
            dca_results = draft["dcaResults"]
        else:
            holdings = draft_holdings(db, user_id, market_id, assets, params, capital)
            value_history = []
            contribution_history = []
            dca_results = []
        portfolio = {
            "id": portfolio_id or "draft-portfolio",
            "marketId": market_id,
            "name": string_param(params, "name") or ((saved_portfolio or {}).get("name") or "Draft portfolio"),
            "currency": "USD",
            "goal": string_param(params, "goal") or ((saved_portfolio or {}).get("goal") or "Manual calculation"),
            "riskPreference": string_param(params, "riskPreference") or ((saved_portfolio or {}).get("riskPreference") or "Balanced"),
            "capital": capital,
            "startDate": string_param(params, "startDate"),
            "endDate": string_param(params, "endDate"),
            "dcaPlans": dca_plans,
            "cashBalance": cash_balance,
            "holdings": holdings,
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
        }
        if value_history:
            portfolio["valueHistory"] = value_history
            portfolio["contributionHistory"] = contribution_history
            portfolio["dcaResults"] = dca_results
    elif saved_portfolio:
        portfolio = saved_portfolio
    else:
        raise FundXApiError("not_found", "Portfolio was not found in the selected market.", 404)
    summary = build_portfolio_summary(
        portfolio,
        db,
        start_date=string_param(params, "startDate"),
        end_date=string_param(params, "endDate"),
    )
    return {"portfolio": portfolio, "summary": summary, "savedPortfolio": saved_portfolio}


def watchlist_result(
    db: dict[str, Any],
    user_id: str,
    market_id: MarketId,
    assets: list[dict[str, str]],
    params: dict[str, Any],
) -> dict[str, Any]:
    rows = []
    target_discount = number_param(params, "targetDiscount", 0.95)
    for selected in assets:
        asset = resolve_selected_asset(db, user_id, market_id, selected)
        price = number_or_zero(asset.get("latestPrice"))
        target = number_param(params, f"target:{asset.get('id')}", round_number(price * target_discount, 2))
        rows.append(
            {
                "asset": asset,
                "target": target,
                "price": price,
                "dailyChange": number_or_zero(asset.get("dailyChange")),
                "signal": "below-target" if price and price <= target else "watch",
                "history": list_asset_history(db, user_id, market_id, str(asset.get("id")), str(asset.get("assetType") or selected.get("assetType")))[-40:],
            }
        )
    return {"items": rows}


def insights_result(
    db: dict[str, Any],
    user_id: str,
    market_id: MarketId,
    assets: list[dict[str, str]],
    params: dict[str, Any],
) -> dict[str, Any]:
    anchors = [resolve_selected_asset(db, user_id, market_id, asset) for asset in assets]
    active_portfolio = get_active_portfolio(db, user_id, market_id, string_param(params, "portfolioId"))
    baseline_summary = (
        build_portfolio_summary(
            active_portfolio,
            db,
            start_date=string_param(params, "startDate"),
            end_date=string_param(params, "endDate"),
        )
        if active_portfolio
        else None
    )
    universe = build_insight_universe(db, user_id, market_id)
    simulation = run_insight_recommendation_engine(universe, anchors, params)
    insights = strategy_insights(simulation["strategies"])
    result = {
        "summary": baseline_summary,
        "baselinePortfolio": active_portfolio,
        "selectedAssets": [compact_anchor_asset(asset) for asset in anchors],
        "simulationSummary": simulation["summary"],
        "strategies": simulation["strategies"],
        "insights": insights,
        "methodology": simulation["methodology"],
    }
    saved_record = None
    if bool_param(params, "saveRecommendation", True) and not browser_local_user_data_enabled():
        saved_record = save_insight_recommendation(user_id, market_id, params, result)
        result["savedRecommendation"] = saved_record
    latest_db = read_db() if saved_record else db
    result["savedRecommendations"] = recent_insight_recommendations(latest_db, user_id, market_id, INSIGHT_RECOMMENDATION_LIMIT)
    return result


def build_insight_universe(db: dict[str, Any], user_id: str, market_id: MarketId) -> list[dict[str, Any]]:
    stock_by_id = {stock.get("id"): stock for stock in db.get("stocks", []) if stock.get("marketId") == market_id}
    fund_by_id = {fund.get("id"): fund for fund in db.get("funds", []) if fund.get("marketId") == market_id}
    daily_by_asset = daily_history_index(db, market_id)
    candidates: list[dict[str, Any]] = []
    for raw_asset in db.get("assets", []):
        if raw_asset.get("marketId") != market_id:
            continue
        if not asset_visible_to_user(raw_asset, user_id) or not is_public_market_asset(raw_asset):
            continue
        asset = normalize_asset_record(raw_asset)
        kind = asset_kind(asset)
        if kind not in {"stock", "fund"}:
            continue
        record = stock_by_id.get(asset.get("id")) if kind == "stock" else fund_by_id.get(asset.get("id"))
        history = candidate_history(asset, record or {}, daily_by_asset, kind)
        metrics = candidate_metrics(asset, record or {}, history, kind)
        if metrics["investableScore"] <= 0:
            continue
        candidates.append(
            {
                "id": asset.get("id"),
                "assetType": normalize_asset_type(asset.get("assetType")),
                "kind": kind,
                "name": asset.get("name"),
                "symbol": asset.get("symbol"),
                "sector": asset.get("sector") or asset.get("industry") or asset.get("category") or "Other",
                "industry": asset.get("industry") or asset.get("sector") or "Other",
                "category": asset.get("category") or asset.get("fundType") or record.get("category") or "Unclassified",
                "latestPrice": asset.get("latestPrice") if isinstance(asset.get("latestPrice"), (int, float)) else record.get("price") or record.get("nav"),
                "dailyChange": asset.get("dailyChange") if isinstance(asset.get("dailyChange"), (int, float)) else record.get("dailyChange"),
                "source": asset.get("source") or "local-db",
                "updatedAt": asset.get("updatedAt"),
                "metrics": metrics,
            }
        )
    return candidates


def daily_history_index(db: dict[str, Any], market_id: MarketId) -> dict[str, list[dict[str, Any]]]:
    by_asset: dict[str, list[dict[str, Any]]] = {}
    for point in db.get("dailyPrices", []):
        if point.get("marketId") != market_id:
            continue
        value = point.get("nav") if point.get("nav") is not None else point.get("close")
        if not isinstance(value, (int, float)) or value <= 0 or not point.get("assetId") or not point.get("date"):
            continue
        by_asset.setdefault(str(point.get("assetId")), []).append({"date": point.get("date"), "value": value})
    return {asset_id: sort_history(points) for asset_id, points in by_asset.items()}


def candidate_history(
    asset: dict[str, Any],
    record: dict[str, Any],
    daily_by_asset: dict[str, list[dict[str, Any]]],
    kind: str,
) -> list[dict[str, Any]]:
    daily_history = daily_by_asset.get(str(asset.get("id"))) or []
    if len(daily_history) >= 2:
        return daily_history
    record_history_key = "priceHistory" if kind == "stock" else "navHistory"
    raw_history = record.get(record_history_key) if isinstance(record.get(record_history_key), list) else []
    history = [
        {"date": str(point.get("date")), "value": number_or_zero(point.get("value"))}
        for point in raw_history
        if isinstance(point, dict) and point.get("date") and number_or_zero(point.get("value")) > 0
    ]
    return sort_history(history)


def candidate_metrics(asset: dict[str, Any], record: dict[str, Any], history: list[dict[str, Any]], kind: str) -> dict[str, Any]:
    history_points = len(history)
    history_return = history_expected_return(history) if history_points >= INSIGHT_MIN_HISTORY_POINTS else None
    history_volatility = calculate_volatility(history) if history_points >= INSIGHT_MIN_HISTORY_POINTS else None
    history_drawdown = calculate_drawdown(history).get("maxDrawdown") if history_points >= INSIGHT_MIN_HISTORY_POINTS else None
    dividend_yield = finite_number(record.get("dividendYield"), finite_number(asset.get("dividendYield"), 0))
    expense_ratio = finite_number(asset.get("expenseRatio"), finite_number(record.get("expenseRatio"), 0))
    daily_change = finite_number(asset.get("dailyChange"), finite_number(record.get("dailyChange"), 0))
    liquidity_score = asset_liquidity_score(asset)
    if kind == "stock":
        quality_score = finite_number(record.get("qualityScore"), estimate_stock_quality(record))
        value_score = finite_number(record.get("valueScore"), estimate_stock_value(record))
        risk_score = finite_number(record.get("riskScore"), 52)
        expected_return = history_return if history_return is not None else estimate_stock_return(record, dividend_yield, quality_score, value_score, risk_score)
        volatility = history_volatility if history_volatility is not None and history_volatility > 0 else finite_number(record.get("volatility"), 10 + risk_score * 0.34 + abs(daily_change))
    else:
        quality_score = fund_quality_score(asset, record)
        value_score = fund_value_score(asset, record)
        risk_score = fund_risk_score(asset, record)
        expected_return = history_return if history_return is not None else estimate_fund_return(asset, record, dividend_yield, expense_ratio, risk_score)
        volatility = history_volatility if history_volatility is not None and history_volatility > 0 else 5 + risk_score * 0.22
    max_drawdown = finite_number(history_drawdown, -clamp_number(volatility * 1.2 + risk_score * 0.08, 4, 55))
    investable_score = clamp_number(35 + liquidity_score + quality_score * 0.18 + value_score * 0.08 - risk_score * 0.08 + (8 if history_points >= INSIGHT_MIN_HISTORY_POINTS else 0), 0, 100)
    rank_score = (
        expected_return * 1.45
        + dividend_yield * 0.75
        + quality_score * 0.12
        + value_score * 0.08
        + liquidity_score * 0.16
        - volatility * 0.42
        - risk_score * 0.05
        - expense_ratio * 0.9
        + (6 if history_points >= INSIGHT_MIN_HISTORY_POINTS else 0)
    )
    return {
        "expectedReturn": round_number(clamp_number(expected_return, -35, 80), 2),
        "volatility": round_number(clamp_number(volatility, 1, 90), 2),
        "maxDrawdown": round_number(clamp_number(max_drawdown, -90, 0), 2),
        "dividendYield": round_number(clamp_number(dividend_yield, 0, 25), 2),
        "expenseRatio": round_number(clamp_number(expense_ratio, 0, 5), 2),
        "qualityScore": round_number(clamp_number(quality_score, 0, 100), 1),
        "valueScore": round_number(clamp_number(value_score, 0, 100), 1),
        "riskScore": round_number(clamp_number(risk_score, 0, 100), 1),
        "liquidityScore": round_number(clamp_number(liquidity_score, 0, 100), 1),
        "historyPoints": history_points,
        "historyBacked": history_points >= INSIGHT_MIN_HISTORY_POINTS,
        "investableScore": round_number(investable_score, 1),
        "rankScore": round_number(rank_score, 2),
    }


def run_insight_recommendation_engine(
    universe: list[dict[str, Any]],
    anchors: list[dict[str, Any]],
    params: dict[str, Any],
) -> dict[str, Any]:
    if len(universe) < 3:
        raise validation_error("At least three database assets are required before running portfolio recommendations.")
    simulation_count = bounded_int_param(params, "simulationCount", DEFAULT_INSIGHT_SIMULATIONS, 500, MAX_INSIGHT_SIMULATIONS)
    risk_profile = choice_param(params, "riskProfile", {"conservative", "balanced", "growth", "income"}, "balanced")
    include_anchors = bool_param(params, "includeSelectedAssets", True)
    candidate_pool = recommendation_candidate_pool(universe, anchors, risk_profile, INSIGHT_CANDIDATE_POOL_LIMIT)
    allocation_policy = insight_allocation_policy(candidate_pool, anchors, risk_profile, include_anchors)
    holdings_count = (
        bounded_int_param(params, "holdingsCount", allocation_policy["holdingsCount"], 3, min(24, len(candidate_pool)))
        if has_param_value(params, "holdingsCount")
        else allocation_policy["holdingsCount"]
    )
    max_position = (
        clamp_number(number_param(params, "maxPosition", allocation_policy["maxPosition"]), 8, 45)
        if has_param_value(params, "maxPosition")
        else allocation_policy["maxPosition"]
    )
    anchor_candidates = anchor_candidates_from_pool(candidate_pool, anchors)
    rng = random.Random(insight_seed(params, anchors, len(universe), holdings_count, max_position))
    objectives = recommendation_objectives(risk_profile)
    top_by_objective: dict[str, list[dict[str, Any]]] = {objective["id"]: [] for objective in objectives}
    distributions: dict[str, list[float]] = {
        "expectedReturn": [],
        "volatility": [],
        "maxDrawdown": [],
        "dividendYield": [],
        "historyCoverage": [],
    }

    for index in range(simulation_count):
        target_count = clamp_int(holdings_count + rng.choice([-2, -1, 0, 0, 1, 2]), 3, min(24, len(candidate_pool)))
        selected = choose_simulation_assets(candidate_pool, anchor_candidates, target_count, rng, include_anchors)
        if len(selected) < 3:
            continue
        weights = simulation_weights(selected, rng, max_position, risk_profile)
        metrics = simulated_portfolio_metrics(selected, weights)
        for key in distributions:
            distributions[key].append(number_or_zero(metrics.get(key)))
        signature = portfolio_signature(selected)
        for objective in objectives:
            score = objective_score(metrics, objective["id"])
            add_top_simulation(
                top_by_objective[objective["id"]],
                {
                    "assets": selected,
                    "weights": weights,
                    "metrics": {**metrics, "objectiveScore": round_number(score, 2)},
                    "objectiveId": objective["id"],
                    "signature": signature,
                    "simulationIndex": index + 1,
                },
                score,
            )

    strategies = select_recommendation_strategies(top_by_objective, objectives, universe, anchors, candidate_pool)
    if not strategies:
        raise validation_error("The recommendation engine could not build a valid simulated portfolio from the database assets.")
    summary = {
        "simulationCount": simulation_count,
        "completedSimulations": len(distributions["expectedReturn"]),
        "universeCount": len(universe),
        "candidatePoolSize": len(candidate_pool),
        "historyBackedAssets": sum(1 for item in universe if item["metrics"].get("historyBacked")),
        "selectedAnchorCount": len(anchors),
        "includedAnchorCount": len(anchor_candidates) if include_anchors else 0,
        "riskProfile": risk_profile,
        "holdingsCount": holdings_count,
        "maxPosition": round_number(max_position, 1),
        "allocationPolicy": allocation_policy,
        "percentiles": {key: percentile_summary(values) for key, values in distributions.items()},
    }
    methodology = [
        "Screened the full local database asset universe, excluding non-public or non-tradable records.",
        "Ranked candidates with history coverage, liquidity, valuation, quality, income, volatility, drawdown, and concentration penalties.",
        f"Ran {simulation_count:,} randomized portfolio trials with capped single-position weights and sector diversification checks.",
        "Selected different plans for risk control, balance, growth, or income instead of returning only the highest raw-return portfolio.",
    ]
    return {"summary": summary, "strategies": strategies, "methodology": methodology}


def insight_allocation_policy(
    candidate_pool: list[dict[str, Any]],
    anchors: list[dict[str, Any]],
    risk_profile: str,
    include_anchors: bool,
) -> dict[str, Any]:
    pool_size = max(1, len(candidate_pool))
    sector_count = len({str(candidate.get("sector") or "Other") for candidate in candidate_pool})
    history_backed = sum(1 for candidate in candidate_pool if candidate["metrics"].get("historyBacked"))
    history_ratio = history_backed / pool_size

    profile_holdings = {
        "conservative": 11,
        "balanced": 9,
        "growth": 7,
        "income": 8,
    }
    profile_max_position = {
        "conservative": 18,
        "balanced": 22,
        "growth": 28,
        "income": 24,
    }

    holdings_count = profile_holdings.get(risk_profile, 9)
    if pool_size >= 320:
        holdings_count += 2
    elif pool_size >= 140:
        holdings_count += 1
    elif pool_size < 35:
        holdings_count -= 1
    if sector_count >= 8:
        holdings_count += 1
    elif sector_count <= 3:
        holdings_count -= 1
    if history_ratio < 0.35:
        holdings_count += 1
    elif risk_profile == "growth" and history_ratio >= 0.75:
        holdings_count -= 1
    if include_anchors and anchors:
        holdings_count = max(holdings_count, min(24, len(anchors) + 2))
    holdings_count = clamp_int(holdings_count, 3, min(24, pool_size))

    max_position = float(profile_max_position.get(risk_profile, 22))
    if holdings_count >= 12:
        max_position -= 2
    elif holdings_count <= 6:
        max_position += 2
    if history_ratio < 0.35:
        max_position -= 2
    if sector_count <= 3:
        max_position -= 1
    minimum_feasible = 100 / holdings_count + 1.5
    max_position = clamp_number(max(max_position, minimum_feasible), 10, 42)

    return {
        "automatic": True,
        "holdingsCount": holdings_count,
        "maxPosition": round_number(max_position, 1),
        "sectorCount": sector_count,
        "historyCoverageRatio": round_number(history_ratio * 100, 1),
    }


def recommendation_candidate_pool(
    universe: list[dict[str, Any]],
    anchors: list[dict[str, Any]],
    risk_profile: str,
    limit: int,
) -> list[dict[str, Any]]:
    anchor_ids = {str(anchor.get("id")) for anchor in anchors}

    def profile_adjusted_score(candidate: dict[str, Any]) -> float:
        metrics = candidate["metrics"]
        base = number_or_zero(metrics.get("rankScore"))
        if risk_profile == "conservative":
            return base + number_or_zero(metrics.get("qualityScore")) * 0.05 + number_or_zero(metrics.get("maxDrawdown")) * 0.25 - number_or_zero(metrics.get("volatility")) * 0.35
        if risk_profile == "growth":
            return base + number_or_zero(metrics.get("expectedReturn")) * 0.55 + number_or_zero(metrics.get("qualityScore")) * 0.05
        if risk_profile == "income":
            return base + number_or_zero(metrics.get("dividendYield")) * 1.4 - number_or_zero(metrics.get("expenseRatio")) * 0.8
        return base

    ranked = sorted(universe, key=profile_adjusted_score, reverse=True)
    selected = ranked[:limit]
    by_id = {str(item.get("id")): item for item in selected}
    for candidate in ranked:
        candidate_id = str(candidate.get("id"))
        if candidate_id in anchor_ids and candidate_id not in by_id:
            selected.append(candidate)
            by_id[candidate_id] = candidate
    return selected


def anchor_candidates_from_pool(candidate_pool: list[dict[str, Any]], anchors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    anchor_ids = {str(anchor.get("id")) for anchor in anchors}
    return [candidate for candidate in candidate_pool if str(candidate.get("id")) in anchor_ids]


def choose_simulation_assets(
    candidate_pool: list[dict[str, Any]],
    anchors: list[dict[str, Any]],
    target_count: int,
    rng: random.Random,
    include_anchors: bool,
) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    selected_ids: set[str] = set()
    if include_anchors:
        for anchor in anchors[:target_count]:
            selected.append(anchor)
            selected_ids.add(str(anchor.get("id")))
    attempts = 0
    max_sector_count = max(2, int(target_count * 0.45))
    while len(selected) < target_count and attempts < target_count * 80:
        attempts += 1
        candidate = biased_candidate_pick(candidate_pool, rng)
        candidate_id = str(candidate.get("id"))
        if candidate_id in selected_ids:
            continue
        sector_counts = sector_count_map(selected)
        candidate_sector = str(candidate.get("sector") or "Other")
        if sector_counts.get(candidate_sector, 0) >= max_sector_count and rng.random() < 0.82:
            continue
        selected.append(candidate)
        selected_ids.add(candidate_id)
    return selected


def biased_candidate_pick(candidate_pool: list[dict[str, Any]], rng: random.Random) -> dict[str, Any]:
    index = min(len(candidate_pool) - 1, int((rng.random() ** 2.35) * len(candidate_pool)))
    return candidate_pool[index]


def simulation_weights(
    selected: list[dict[str, Any]],
    rng: random.Random,
    max_position: float,
    risk_profile: str,
) -> dict[str, float]:
    raw: list[float] = []
    for candidate in selected:
        metrics = candidate["metrics"]
        base = max(0.2, 1 + number_or_zero(metrics.get("rankScore")) / 80)
        if risk_profile == "conservative":
            base += number_or_zero(metrics.get("qualityScore")) / 140 - number_or_zero(metrics.get("volatility")) / 90
        elif risk_profile == "growth":
            base += number_or_zero(metrics.get("expectedReturn")) / 55
        elif risk_profile == "income":
            base += number_or_zero(metrics.get("dividendYield")) / 8
        raw.append(max(0.05, base) * (0.35 + rng.expovariate(1.15)))
    weights = normalize_weight_values(raw)
    capped = cap_weights(weights, max(max_position, 100 / max(1, len(weights))))
    return {str(candidate.get("id")): round_number(capped[index], 2) for index, candidate in enumerate(selected)}


def normalize_weight_values(values: list[float]) -> list[float]:
    total = sum(max(0, value) for value in values)
    if total <= 0:
        return [100 / len(values) for _ in values]
    return [max(0, value) / total * 100 for value in values]


def cap_weights(weights: list[float], max_position: float) -> list[float]:
    capped = list(weights)
    for _ in range(8):
        excess = sum(max(0, weight - max_position) for weight in capped)
        if excess <= 0.001:
            break
        capped = [min(weight, max_position) for weight in capped]
        available_indexes = [index for index, weight in enumerate(capped) if weight < max_position - 0.001]
        if not available_indexes:
            break
        available_total = sum(capped[index] for index in available_indexes)
        if available_total <= 0:
            share = excess / len(available_indexes)
            for index in available_indexes:
                capped[index] += share
        else:
            for index in available_indexes:
                capped[index] += excess * (capped[index] / available_total)
    total = sum(capped)
    return [weight / total * 100 for weight in capped] if total > 0 else capped


def simulated_portfolio_metrics(selected: list[dict[str, Any]], weights: dict[str, float]) -> dict[str, Any]:
    weighted = lambda key: sum(number_or_zero(candidate["metrics"].get(key)) * number_or_zero(weights.get(str(candidate.get("id")))) / 100 for candidate in selected)
    sector_weights: dict[str, float] = {}
    kind_weights: dict[str, float] = {}
    for candidate in selected:
        weight = number_or_zero(weights.get(str(candidate.get("id"))))
        sector_weights[str(candidate.get("sector") or "Other")] = sector_weights.get(str(candidate.get("sector") or "Other"), 0) + weight
        kind_weights[str(candidate.get("kind") or "asset")] = kind_weights.get(str(candidate.get("kind") or "asset"), 0) + weight
    top_weight = max((number_or_zero(weight) for weight in weights.values()), default=0)
    top_sector_weight = max(sector_weights.values(), default=0)
    sector_count = len([weight for weight in sector_weights.values() if weight > 1])
    history_coverage = sum(number_or_zero(weights.get(str(candidate.get("id")))) for candidate in selected if candidate["metrics"].get("historyBacked"))
    base_volatility = weighted("volatility")
    concentration_penalty = max(0, top_weight - 18) * 0.18 + max(0, top_sector_weight - 35) * 0.08
    volatility = base_volatility + concentration_penalty
    max_drawdown = weighted("maxDrawdown") - concentration_penalty * 0.8
    diversification_score = clamp_number(40 + len(selected) * 3.6 + sector_count * 5.4 - max(0, top_weight - 18) * 0.8 - max(0, top_sector_weight - 38) * 0.4, 0, 100)
    return {
        "expectedReturn": round_number(weighted("expectedReturn"), 2),
        "volatility": round_number(volatility, 2),
        "maxDrawdown": round_number(clamp_number(max_drawdown, -90, 0), 2),
        "dividendYield": round_number(weighted("dividendYield"), 2),
        "expenseRatio": round_number(weighted("expenseRatio"), 2),
        "qualityScore": round_number(weighted("qualityScore"), 1),
        "valueScore": round_number(weighted("valueScore"), 1),
        "riskScore": round_number(weighted("riskScore"), 1),
        "topWeight": round_number(top_weight, 2),
        "topSectorWeight": round_number(top_sector_weight, 2),
        "sectorCount": sector_count,
        "holdingCount": len(selected),
        "historyCoverage": round_number(history_coverage, 2),
        "diversificationScore": round_number(diversification_score, 1),
        "sectorExposure": sorted(
            [{"name": name, "weight": round_number(weight, 2)} for name, weight in sector_weights.items()],
            key=lambda item: item["weight"],
            reverse=True,
        ),
        "assetTypeExposure": sorted(
            [{"name": name, "weight": round_number(weight, 2)} for name, weight in kind_weights.items()],
            key=lambda item: item["weight"],
            reverse=True,
        ),
    }


def recommendation_objectives(risk_profile: str) -> list[dict[str, str]]:
    if risk_profile == "conservative":
        return [
            {"id": "defensive", "name": "Conservative plan"},
            {"id": "balanced", "name": "Balanced plan"},
            {"id": "income", "name": "Income plan"},
        ]
    if risk_profile == "growth":
        return [
            {"id": "growth", "name": "Growth plan"},
            {"id": "balanced", "name": "Balanced plan"},
            {"id": "defensive", "name": "Conservative plan"},
        ]
    if risk_profile == "income":
        return [
            {"id": "income", "name": "Income plan"},
            {"id": "defensive", "name": "Conservative plan"},
            {"id": "balanced", "name": "Balanced plan"},
        ]
    return [
        {"id": "balanced", "name": "Balanced plan"},
        {"id": "defensive", "name": "Conservative plan"},
        {"id": "growth", "name": "Growth plan"},
    ]


def objective_score(metrics: dict[str, Any], objective_id: str) -> float:
    expected = number_or_zero(metrics.get("expectedReturn"))
    volatility = number_or_zero(metrics.get("volatility"))
    drawdown = number_or_zero(metrics.get("maxDrawdown"))
    income = number_or_zero(metrics.get("dividendYield"))
    quality = number_or_zero(metrics.get("qualityScore"))
    value = number_or_zero(metrics.get("valueScore"))
    risk = number_or_zero(metrics.get("riskScore"))
    diversification = number_or_zero(metrics.get("diversificationScore"))
    top_weight = number_or_zero(metrics.get("topWeight"))
    top_sector = number_or_zero(metrics.get("topSectorWeight"))
    history = number_or_zero(metrics.get("historyCoverage"))
    if objective_id == "defensive":
        return expected * 0.95 + income * 0.85 + quality * 0.13 + diversification * 0.18 + drawdown * 0.85 - volatility * 1.05 - risk * 0.08 - top_weight * 0.1 - top_sector * 0.08 + history * 0.05
    if objective_id == "growth":
        return expected * 2.0 + quality * 0.17 + value * 0.06 + diversification * 0.08 + drawdown * 0.2 - volatility * 0.42 - top_weight * 0.08 + history * 0.04
    if objective_id == "income":
        return income * 2.5 + expected * 0.8 + quality * 0.09 + diversification * 0.12 + drawdown * 0.45 - volatility * 0.72 - top_sector * 0.08 + history * 0.03
    return expected * 1.35 + income * 0.65 + quality * 0.12 + value * 0.05 + diversification * 0.14 + drawdown * 0.42 - volatility * 0.62 - top_weight * 0.1 - top_sector * 0.06 + history * 0.04


def add_top_simulation(top: list[dict[str, Any]], simulation: dict[str, Any], score: float) -> None:
    top.append({**simulation, "score": round_number(score, 2)})
    top.sort(key=lambda item: number_or_zero(item.get("score")), reverse=True)
    del top[12:]


def select_recommendation_strategies(
    top_by_objective: dict[str, list[dict[str, Any]]],
    objectives: list[dict[str, str]],
    universe: list[dict[str, Any]],
    anchors: list[dict[str, Any]],
    candidate_pool: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    strategies: list[dict[str, Any]] = []
    used_signatures: list[set[str]] = []
    for objective in objectives:
        chosen = None
        for simulation in top_by_objective.get(objective["id"], []):
            signature = set(str(asset.get("id")) for asset in simulation.get("assets", []))
            if all(signature_overlap(signature, used) < 0.72 for used in used_signatures):
                chosen = simulation
                break
        if chosen is None and top_by_objective.get(objective["id"]):
            chosen = top_by_objective[objective["id"]][0]
        if chosen is None:
            continue
        signature = set(str(asset.get("id")) for asset in chosen.get("assets", []))
        used_signatures.append(signature)
        strategies.append(build_strategy_payload(objective, chosen, universe, anchors, candidate_pool, len(strategies) + 1))
    return strategies


def build_strategy_payload(
    objective: dict[str, str],
    simulation: dict[str, Any],
    universe: list[dict[str, Any]],
    anchors: list[dict[str, Any]],
    candidate_pool: list[dict[str, Any]],
    index: int,
) -> dict[str, Any]:
    assets = simulation["assets"]
    weights = simulation["weights"]
    metrics = simulation["metrics"]
    anchor_ids = {str(anchor.get("id")) for anchor in anchors}
    holdings = [
        {
            "asset": compact_candidate_asset(candidate),
            "weight": round_number(number_or_zero(weights.get(str(candidate.get("id")))), 2),
            "role": candidate_role(candidate, objective["id"]),
            "rationale": candidate_rationale(candidate, objective["id"]),
            "selectedAnchor": str(candidate.get("id")) in anchor_ids,
        }
        for candidate in sorted(assets, key=lambda item: number_or_zero(weights.get(str(item.get("id")))), reverse=True)
    ]
    title = objective["name"]
    top_sector = (metrics.get("sectorExposure") or [{}])[0]
    confidence = clamp_number(48 + number_or_zero(simulation.get("score")) / 3 + number_or_zero(metrics.get("historyCoverage")) * 0.12 - number_or_zero(metrics.get("volatility")) * 0.15, 1, 99)
    thesis = (
        f"{title} screened {len(universe):,} database assets and selected {len(holdings)} holdings with "
        f"{round_number(number_or_zero(metrics.get('expectedReturn')), 1)}% expected return, "
        f"{round_number(number_or_zero(metrics.get('volatility')), 1)}% volatility, and "
        f"{round_number(number_or_zero(metrics.get('topSectorWeight')), 1)}% top-sector exposure."
    )
    action_summary = (
        f"Use this as the {objective['name'].lower()}: cap single positions near "
        f"{round_number(number_or_zero(metrics.get('topWeight')), 1)}%, keep {top_sector.get('name') or 'the largest sector'} below "
        f"{round_number(number_or_zero(metrics.get('topSectorWeight')), 1)}%, and review selected assets before execution."
    )
    explanations = [
        f"Database coverage: {len(universe):,} assets were scored; the shortlist kept {len(candidate_pool):,} higher-quality or more liquid assets.",
        f"Risk control: max drawdown is estimated at {round_number(number_or_zero(metrics.get('maxDrawdown')), 1)}% with a diversification score of {round_number(number_or_zero(metrics.get('diversificationScore')), 1)}.",
        f"Evidence mix: {round_number(number_or_zero(metrics.get('historyCoverage')), 1)}% of the portfolio weight is backed by stored price history; the rest uses database fundamentals and quote metrics.",
    ]
    if anchors:
        included = [holding["asset"]["symbol"] for holding in holdings if holding["selectedAnchor"]]
        explanations.append(
            f"Selected assets: {', '.join(included) if included else 'none of the selected assets'} remained in this plan after full-database scoring."
        )
    return {
        "id": f"strategy-{objective['id']}-{index}",
        "objective": objective["id"],
        "name": title,
        "thesis": thesis,
        "actionSummary": action_summary,
        "confidence": round_number(confidence, 1),
        "recommendedHoldings": holdings,
        "metrics": metrics,
        "explanations": explanations,
        "sourceSimulation": simulation.get("simulationIndex"),
        "signature": simulation.get("signature"),
    }


def strategy_insights(strategies: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "id": strategy.get("id"),
            "title": strategy.get("name"),
            "issue": strategy.get("thesis"),
            "suggestion": strategy.get("actionSummary"),
            "targetWeight": strategy.get("confidence"),
        }
        for strategy in strategies
    ]


def compact_candidate_asset(candidate: dict[str, Any]) -> dict[str, Any]:
    metrics = candidate.get("metrics") or {}
    return {
        "id": candidate.get("id"),
        "assetId": candidate.get("id"),
        "assetType": candidate.get("assetType"),
        "kind": candidate.get("kind"),
        "name": candidate.get("name"),
        "symbol": candidate.get("symbol"),
        "sector": candidate.get("sector"),
        "category": candidate.get("category"),
        "latestPrice": candidate.get("latestPrice"),
        "dailyChange": candidate.get("dailyChange"),
        "expectedReturn": metrics.get("expectedReturn"),
        "volatility": metrics.get("volatility"),
        "maxDrawdown": metrics.get("maxDrawdown"),
        "dividendYield": metrics.get("dividendYield"),
        "qualityScore": metrics.get("qualityScore"),
        "riskScore": metrics.get("riskScore"),
        "historyPoints": metrics.get("historyPoints"),
    }


def compact_anchor_asset(asset: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": asset.get("id"),
        "assetId": asset.get("id"),
        "assetType": normalize_asset_type(asset.get("assetType")),
        "kind": asset_kind(asset),
        "name": asset.get("name"),
        "symbol": asset.get("symbol"),
        "sector": asset.get("sector") or asset.get("industry") or asset.get("category") or "Other",
    }


def save_insight_recommendation(user_id: str, market_id: MarketId, params: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    saved: dict[str, Any] = {}

    def mutate(db: dict[str, Any]) -> None:
        timestamp = now_iso()
        strategies = result.get("strategies") if isinstance(result.get("strategies"), list) else []
        title = string_param(params, "name") or default_insight_recommendation_title(params, timestamp)
        record = {
            "id": create_id("insight-rec"),
            "userId": user_id,
            "marketId": market_id,
            "title": title,
            "params": compact_recommendation_params(params),
            "selectedAssets": clone_json(result.get("selectedAssets") or []),
            "simulationSummary": clone_json(result.get("simulationSummary") or {}),
            "strategies": clone_json(strategies),
            "insights": clone_json(result.get("insights") or []),
            "methodology": clone_json(result.get("methodology") or []),
            "createdAt": timestamp,
            "updatedAt": timestamp,
        }
        db.setdefault("insightRecommendations", []).insert(0, record)
        db["insightRecommendations"] = db.get("insightRecommendations", [])[:100]
        saved.update(clone_json(record))

    update_db(mutate)
    return saved


def default_insight_recommendation_title(params: dict[str, Any], timestamp: str) -> str:
    language = str(params.get("language") or "").lower()
    if language.startswith("zh-tw") or language.startswith("zh-hk"):
        return f"智能建議 {timestamp[:10]}"
    if language.startswith("zh"):
        return f"智能建议 {timestamp[:10]}"
    return f"Insight recommendation {timestamp[:10]}"


def compact_recommendation_params(params: dict[str, Any]) -> dict[str, Any]:
    keys = ("riskProfile", "simulationCount", "holdingsCount", "maxPosition", "includeSelectedAssets", "portfolioId")
    return {key: params.get(key) for key in keys if key in params}


def recent_insight_recommendations(db: dict[str, Any], user_id: str, market_id: MarketId, limit: int) -> list[dict[str, Any]]:
    rows = [
        item
        for item in db.get("insightRecommendations", [])
        if item.get("userId") == user_id and item.get("marketId") == market_id
    ]
    rows.sort(key=lambda item: str(item.get("createdAt") or ""), reverse=True)
    return [clone_json(item) for item in rows[:limit]]


def candidate_role(candidate: dict[str, Any], objective_id: str) -> str:
    if objective_id == "defensive":
        return "Lower-risk holding" if number_or_zero(candidate["metrics"].get("volatility")) < 18 else "Diversifying holding"
    if objective_id == "growth":
        return "Growth holding" if number_or_zero(candidate["metrics"].get("expectedReturn")) > 8 else "Quality holding"
    if objective_id == "income":
        return "Income holding" if number_or_zero(candidate["metrics"].get("dividendYield")) > 2 else "Stable holding"
    return "Main holding" if candidate.get("kind") == "fund" else "Supporting holding"


def candidate_rationale(candidate: dict[str, Any], objective_id: str) -> str:
    metrics = candidate["metrics"]
    if objective_id == "income":
        return f"{candidate.get('symbol')} adds {round_number(number_or_zero(metrics.get('dividendYield')), 1)}% yield with {round_number(number_or_zero(metrics.get('volatility')), 1)}% estimated volatility."
    if objective_id == "defensive":
        return f"{candidate.get('symbol')} balances quality score {round_number(number_or_zero(metrics.get('qualityScore')), 1)} against drawdown estimate {round_number(number_or_zero(metrics.get('maxDrawdown')), 1)}%."
    if objective_id == "growth":
        return f"{candidate.get('symbol')} ranks for expected return {round_number(number_or_zero(metrics.get('expectedReturn')), 1)}% and quality score {round_number(number_or_zero(metrics.get('qualityScore')), 1)}."
    return f"{candidate.get('symbol')} improves sector mix with expected return {round_number(number_or_zero(metrics.get('expectedReturn')), 1)}%."


def asset_liquidity_score(asset: dict[str, Any]) -> float:
    turnover = asset.get("latestTurnover")
    if not isinstance(turnover, (int, float)) or turnover <= 0:
        latest_price = asset.get("latestPrice")
        latest_volume = asset.get("latestVolume")
        turnover = latest_price * latest_volume if isinstance(latest_price, (int, float)) and isinstance(latest_volume, (int, float)) else 0
    if turnover <= 0:
        return 8 if asset.get("quoteStatus") == "fresh" else 2
    return clamp_number(12 + (len(str(int(turnover))) - 6) * 8, 4, 55)


def estimate_stock_quality(record: dict[str, Any]) -> float:
    roe = finite_number(record.get("roe"), 10)
    margin = finite_number(record.get("grossMargin"), 35)
    debt = finite_number(record.get("debtRatio"), 45)
    return clamp_number(42 + roe * 0.35 + margin * 0.18 - debt * 0.12, 0, 100)


def estimate_stock_value(record: dict[str, Any]) -> float:
    pe = finite_number(record.get("peRatio"), 24)
    pb = finite_number(record.get("pbRatio"), 4)
    fcf = finite_number(record.get("freeCashFlowYield"), 2)
    return clamp_number(72 - max(0, pe - 12) * 1.1 - max(0, pb - 2) * 2.2 + fcf * 4, 0, 100)


def estimate_stock_return(record: dict[str, Any], dividend_yield: float, quality_score: float, value_score: float, risk_score: float) -> float:
    revenue_growth = finite_number(record.get("revenueGrowth"), 3)
    profit_growth = finite_number(record.get("profitGrowth"), revenue_growth)
    fcf = finite_number(record.get("freeCashFlowYield"), 2)
    pe = finite_number(record.get("peRatio"), 24)
    valuation_penalty = max(-1.5, min(4, (pe - 22) * 0.08))
    return clamp_number(3 + (revenue_growth + profit_growth) * 0.22 + fcf * 0.32 + dividend_yield * 0.45 + quality_score * 0.045 + value_score * 0.025 - risk_score * 0.025 - valuation_penalty, -20, 45)


def fund_quality_score(asset: dict[str, Any], record: dict[str, Any]) -> float:
    aum = finite_number(asset.get("aum"), finite_number(record.get("aum"), 0))
    expense = finite_number(asset.get("expenseRatio"), finite_number(record.get("expenseRatio"), 0.35))
    history = record.get("navHistory") if isinstance(record.get("navHistory"), list) else []
    return clamp_number(55 + min(20, len(history) / 15) + min(14, len(str(int(aum))) if aum > 0 else 0) - expense * 8, 0, 100)


def fund_value_score(asset: dict[str, Any], record: dict[str, Any]) -> float:
    expense = finite_number(asset.get("expenseRatio"), finite_number(record.get("expenseRatio"), 0.35))
    dividend = finite_number(record.get("dividendYield"), finite_number(asset.get("dividendYield"), 0))
    return clamp_number(58 + dividend * 4 - expense * 11, 0, 100)


def fund_risk_score(asset: dict[str, Any], record: dict[str, Any]) -> float:
    text = " ".join(str(value or "").lower() for value in (asset.get("fundType"), asset.get("category"), record.get("type"), record.get("riskLevel")))
    if "treasury" in text or "money" in text or "short" in text:
        return 18
    if "bond" in text or "income" in text:
        return 32
    if "low" in text or "minimum" in text:
        return 38
    if "growth" in text or "technology" in text:
        return 62
    return 48


def estimate_fund_return(asset: dict[str, Any], record: dict[str, Any], dividend_yield: float, expense_ratio: float, risk_score: float) -> float:
    text = " ".join(str(value or "").lower() for value in (asset.get("fundType"), asset.get("category"), record.get("type"), record.get("style")))
    style_bonus = 1.8 if "growth" in text or "technology" in text else 0.9 if "value" in text or "dividend" in text else -0.6 if "treasury" in text or "money" in text else 0.4
    return clamp_number(4.2 + style_bonus + dividend_yield * 0.55 - expense_ratio * 0.8 - max(0, risk_score - 55) * 0.035, -10, 25)


def percentile_summary(values: list[float]) -> dict[str, float]:
    clean = sorted(value for value in values if isinstance(value, (int, float)))
    if not clean:
        return {"p10": 0, "p50": 0, "p90": 0}
    return {
        "p10": round_number(percentile(clean, 0.1), 2),
        "p50": round_number(percentile(clean, 0.5), 2),
        "p90": round_number(percentile(clean, 0.9), 2),
    }


def percentile(sorted_values: list[float], ratio: float) -> float:
    if not sorted_values:
        return 0
    index = min(len(sorted_values) - 1, max(0, int(round((len(sorted_values) - 1) * ratio))))
    return sorted_values[index]


def sector_count_map(candidates: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for candidate in candidates:
        sector = str(candidate.get("sector") or "Other")
        counts[sector] = counts.get(sector, 0) + 1
    return counts


def portfolio_signature(candidates: list[dict[str, Any]]) -> str:
    return "|".join(sorted(str(candidate.get("id")) for candidate in candidates))


def signature_overlap(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0
    return len(left & right) / max(1, min(len(left), len(right)))


def insight_seed(params: dict[str, Any], anchors: list[dict[str, Any]], universe_count: int, holdings_count: int, max_position: float) -> int:
    raw = "|".join(
        [
            str(params.get("riskProfile") or "balanced"),
            str(params.get("simulationCount") or DEFAULT_INSIGHT_SIMULATIONS),
            str(holdings_count),
            str(round_number(max_position, 1)),
            ",".join(sorted(str(anchor.get("id")) for anchor in anchors)),
            str(universe_count),
            str(params.get("seed") or ""),
        ]
    )
    return int(hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16], 16)


def has_param_value(params: dict[str, Any], key: str) -> bool:
    return key in params and params.get(key) not in (None, "")


def finite_number(value: Any, default: float) -> float:
    if isinstance(value, (int, float)) and value == value:
        return float(value)
    return default


def clamp_number(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def clamp_int(value: int, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, value))


def bool_param(params: dict[str, Any], key: str, default: bool) -> bool:
    value = params.get(key)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        if value.lower() in {"true", "1", "yes"}:
            return True
        if value.lower() in {"false", "0", "no"}:
            return False
    return default


def bounded_int_param(params: dict[str, Any], key: str, default: int, minimum: int, maximum: int) -> int:
    value = params.get(key)
    try:
        parsed = int(value) if value not in (None, "") else default
    except (TypeError, ValueError):
        parsed = default
    return clamp_int(parsed, minimum, maximum)


def query_int(value: str | None, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value) if value not in (None, "") else default
    except (TypeError, ValueError):
        parsed = default
    return clamp_int(parsed, minimum, maximum)


def report_result(
    db: dict[str, Any],
    user_id: str,
    market_id: MarketId,
    assets: list[dict[str, str]],
    params: dict[str, Any],
) -> dict[str, Any]:
    report_type = choice_param(params, "type", {"portfolio", "dca", "custom-fund"}, "portfolio")
    if assets and report_type == "custom-fund":
        return {"type": report_type, "preview": custom_fund_result(db, user_id, market_id, assets, params)}
    if assets and report_type == "dca":
        return {"type": report_type, "preview": dca_result(db, market_id, assets[:1], params)}
    return {"type": report_type, "preview": build_report_payload(db, user_id, market_id, report_type, params)}


def resolve_selected_asset(db: dict[str, Any], user_id: str, market_id: MarketId, selected: dict[str, str]) -> dict[str, Any]:
    if selected.get("assetType") == "customFund":
        custom_fund = next(
            (
                item
                for item in db.get("customFunds", [])
                if item.get("userId") == user_id and item.get("marketId") == market_id and item.get("id") == selected["assetId"]
            ),
            None,
        )
        if custom_fund:
            return custom_fund_to_asset(custom_fund)
    asset = next(
        (
            normalize_asset_record(item)
            for item in db.get("assets", [])
            if item.get("id") == selected["assetId"]
            and item.get("marketId") == market_id
            and asset_visible_to_user(item, user_id)
            and is_public_market_asset(item)
            and selected_asset_type_matches(item, selected.get("assetType"))
        ),
        None,
    )
    if not asset:
        raise FundXApiError("not_found", f"Asset {selected['assetId']} was not found in the selected market.", 404)
    return asset


def selected_asset_type_matches(asset: dict[str, Any], requested: str | None) -> bool:
    if not requested:
        return True
    if requested in {"fund", "etf"}:
        return asset_kind(asset) == "fund"
    return normalize_asset_type(asset.get("assetType")) == normalize_asset_type(requested)


def list_asset_history(db: dict[str, Any], user_id: str, market_id: MarketId, asset_id: str, asset_type: str | None) -> list[dict[str, Any]]:
    if asset_type == "customFund":
        custom_fund = next(
            (
                item
                for item in db.get("customFunds", [])
                if item.get("userId") == user_id and item.get("marketId") == market_id and item.get("id") == asset_id
            ),
            None,
        )
        history = ((custom_fund or {}).get("score") or {}).get("backtestHistory", [])
        return history if isinstance(history, list) else []
    points = [
        point
        for point in db.get("dailyPrices", [])
        if point.get("marketId") == market_id
        and point.get("assetId") == asset_id
        and (not asset_type or selected_asset_type_matches({"assetType": point.get("assetType")}, asset_type))
    ]
    return [
        {"date": point.get("date"), "value": point.get("nav") if point.get("nav") is not None else point.get("close")}
        for point in sort_history(points)
        if isinstance(point.get("nav"), (int, float)) or isinstance(point.get("close"), (int, float))
    ]


def cumulative_return(history: list[dict[str, Any]]) -> float:
    sorted_history = sort_history(history)
    if len(sorted_history) < 2:
        return 0
    return round_number(calculate_return(number_or_zero(sorted_history[0].get("value")), number_or_zero(sorted_history[-1].get("value"))), 2)


def history_expected_return(history: list[dict[str, Any]]) -> float | None:
    sorted_history = sort_history(history)
    if len(sorted_history) < INSIGHT_MIN_HISTORY_POINTS:
        return None
    start = number_or_zero(sorted_history[0].get("value"))
    end = number_or_zero(sorted_history[-1].get("value"))
    if start <= 0 or end <= 0:
        return None
    days = days_between(str(sorted_history[0].get("date") or ""), str(sorted_history[-1].get("date") or ""))
    if days < 30:
        return None
    cumulative = calculate_return(start, end)
    annualized = ((end / start) ** (365.25 / days) - 1) * 100
    if days < 365:
        history_weight = days / 365.25
        annualized = annualized * history_weight + cumulative * (1 - history_weight)
    return round_number(annualized, 2)


def holdings_from_params_or_assets(assets: list[dict[str, str]], params: dict[str, Any]) -> list[dict[str, Any]]:
    raw_holdings = params.get("holdings")
    if isinstance(raw_holdings, list) and raw_holdings:
        holdings = []
        for item in raw_holdings:
            if isinstance(item, dict) and isinstance(item.get("stockId"), str):
                holdings.append({"stockId": item["stockId"], "weight": number_or_zero(item.get("weight"))})
        if holdings:
            return holdings
    weights = params.get("weights") if isinstance(params.get("weights"), dict) else {}
    equal_weight = 100 / len(assets)
    return [
        {
            "stockId": asset["assetId"],
            "weight": round_number(number_or_zero(weights.get(asset["assetId"])) if asset["assetId"] in weights else equal_weight, 2),
        }
        for asset in assets
    ]


def draft_holdings(
    db: dict[str, Any],
    user_id: str,
    market_id: MarketId,
    assets: list[dict[str, str]],
    params: dict[str, Any],
    capital: float,
) -> list[dict[str, Any]]:
    weights = params.get("weights") if isinstance(params.get("weights"), dict) else {}
    equal_weight = 100 / len(assets) if assets else 0
    start_date = string_param(params, "startDate")
    end_date = string_param(params, "endDate")
    holdings = []
    for selected in assets:
        asset = resolve_selected_asset(db, user_id, market_id, selected)
        start_price = historical_asset_price(db, market_id, selected, start_date, "forward")
        end_price = historical_asset_price(db, market_id, selected, end_date, "backward")
        price = end_price or number_or_zero(asset.get("latestPrice"))
        average_cost = start_price or price
        target_weight = number_or_zero(weights.get(asset.get("id"))) if asset.get("id") in weights else equal_weight
        market_value = capital * target_weight / 100
        quantity = 0 if average_cost <= 0 else market_value / average_cost
        holdings.append(
            {
                "id": f"calc-holding-{asset.get('id')}",
                "portfolioId": string_param(params, "portfolioId") or "draft-portfolio",
                "assetId": asset.get("id"),
                "assetType": normalize_asset_type(asset.get("assetType")),
                "marketId": market_id,
                "name": asset.get("name"),
                "symbol": asset.get("symbol"),
                "quantity": quantity,
                "averageCost": average_cost,
                "currentPrice": price,
                "targetWeight": target_weight,
                "sector": asset.get("sector") or asset.get("industry") or "Other",
                "createdAt": now_iso(),
                "updatedAt": now_iso(),
            }
        )
    return holdings


def portfolio_dca_plans(params: dict[str, Any]) -> dict[str, Any]:
    raw = params.get("dcaPlans")
    if not isinstance(raw, dict):
        return {}
    plans: dict[str, Any] = {}
    for asset_id, value in raw.items():
        if not isinstance(asset_id, str) or not isinstance(value, dict):
            continue
        enabled = bool(value.get("enabled"))
        plans[asset_id] = {
            "enabled": enabled,
            "initialAmount": number_or_zero(value.get("initialAmount")),
            "recurringAmount": number_or_zero(value.get("recurringAmount")),
            "frequency": value.get("frequency") if value.get("frequency") in DCA_FREQUENCIES else "monthly",
            "transactionCost": number_or_zero(value.get("transactionCost")),
            "reinvestDividends": value.get("reinvestDividends") is not False,
            "strategy": value.get("strategy") if value.get("strategy") in DCA_STRATEGIES else "standard",
        }
    return plans


def has_enabled_portfolio_dca_plan(plans: dict[str, Any]) -> bool:
    return any(isinstance(plan, dict) and bool(plan.get("enabled")) for plan in plans.values())


def draft_holdings_with_dca(
    db: dict[str, Any],
    user_id: str,
    market_id: MarketId,
    assets: list[dict[str, str]],
    params: dict[str, Any],
    capital: float,
    cash_balance: float,
    dca_plans: dict[str, Any],
) -> dict[str, Any]:
    weights = params.get("weights") if isinstance(params.get("weights"), dict) else {}
    equal_weight = 100 / len(assets) if assets else 0
    start_date = string_param(params, "startDate")
    end_date = string_param(params, "endDate")
    holdings: list[dict[str, Any]] = []
    value_histories: list[list[dict[str, Any]]] = []
    contribution_histories: list[list[dict[str, Any]]] = []
    dca_results: list[dict[str, Any]] = []

    for selected in assets:
        asset = resolve_selected_asset(db, user_id, market_id, selected)
        target_weight = number_or_zero(weights.get(asset.get("id"))) if asset.get("id") in weights else equal_weight
        plan = dca_plans.get(str(asset.get("id"))) if isinstance(dca_plans.get(str(asset.get("id"))), dict) else {}
        if plan.get("enabled"):
            dca_input = {
                "marketId": market_id,
                "fundId": str(asset.get("id")),
                "name": f"{asset.get('symbol')} portfolio DCA",
                "initialAmount": number_or_zero(plan.get("initialAmount")),
                "recurringAmount": number_or_zero(plan.get("recurringAmount")),
                "frequency": plan.get("frequency") if plan.get("frequency") in DCA_FREQUENCIES else "monthly",
                "startDate": start_date or first_asset_history_date(db, market_id, selected),
                "endDate": end_date or last_asset_history_date(db, market_id, selected),
                "reinvestDividends": plan.get("reinvestDividends") is not False,
                "transactionCost": number_or_zero(plan.get("transactionCost")),
                "strategy": plan.get("strategy") if plan.get("strategy") in DCA_STRATEGIES else "standard",
            }
            fund = real_market_asset(db, market_id, str(asset.get("id")))
            if not fund or not has_real_nav_history(fund):
                raise FundXApiError("invalid_request", f"{asset.get('symbol')} needs real price history before portfolio DCA can run.", 400)
            simulation = simulate_dca_plan(fund, dca_input)
            current_price = historical_asset_price(db, market_id, selected, dca_input["endDate"], "backward") or number_or_zero(asset.get("latestPrice"))
            shares = number_or_zero(simulation.get("sharesAccumulated"))
            total_invested = number_or_zero(simulation.get("totalInvested"))
            average_cost = 0 if shares <= 0 else total_invested / shares
            holding = portfolio_holding_from_asset(
                asset,
                selected,
                string_param(params, "portfolioId") or "draft-portfolio",
                market_id,
                shares,
                average_cost,
                current_price,
                target_weight,
            )
            holdings.append(holding)
            value_histories.append(normalize_value_history(simulation.get("valueHistory")))
            contribution_histories.append(normalize_value_history(simulation.get("contributionHistory")))
            dca_results.append({"assetId": asset.get("id"), "symbol": asset.get("symbol"), "input": dca_input, "simulation": simulation})
        else:
            start_price = historical_asset_price(db, market_id, selected, start_date, "forward")
            end_price = historical_asset_price(db, market_id, selected, end_date, "backward")
            price = end_price or number_or_zero(asset.get("latestPrice"))
            average_cost = start_price or price
            market_value = capital * target_weight / 100
            quantity = 0 if average_cost <= 0 else market_value / average_cost
            holding = portfolio_holding_from_asset(
                asset,
                selected,
                string_param(params, "portfolioId") or "draft-portfolio",
                market_id,
                quantity,
                average_cost,
                price,
                target_weight,
            )
            holdings.append(holding)
            value_histories.append(static_holding_value_history(db, market_id, selected, quantity, start_date, end_date))
            contribution_histories.append(static_contribution_history(market_value, start_date, value_histories[-1]))

    return {
        "holdings": holdings,
        "valueHistory": combine_histories(value_histories, cash_balance),
        "contributionHistory": combine_histories(contribution_histories, 0),
        "dcaResults": dca_results,
    }


def portfolio_holding_from_asset(
    asset: dict[str, Any],
    selected: dict[str, str],
    portfolio_id: str,
    market_id: MarketId,
    quantity: float,
    average_cost: float,
    current_price: float,
    target_weight: float,
) -> dict[str, Any]:
    return {
        "id": f"calc-holding-{asset.get('id')}",
        "portfolioId": portfolio_id,
        "assetId": asset.get("id"),
        "assetType": normalize_asset_type(asset.get("assetType") or selected.get("assetType")),
        "marketId": market_id,
        "name": asset.get("name"),
        "symbol": asset.get("symbol"),
        "quantity": quantity,
        "averageCost": average_cost,
        "currentPrice": current_price,
        "targetWeight": target_weight,
        "sector": asset.get("sector") or asset.get("industry") or "Other",
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
    }


def static_holding_value_history(
    db: dict[str, Any],
    market_id: MarketId,
    selected: dict[str, str],
    quantity: float,
    start_date: str | None,
    end_date: str | None,
) -> list[dict[str, Any]]:
    rows = [
        row
        for row in db.get("dailyPrices", [])
        if row.get("marketId") == market_id
        and row.get("assetId") == selected.get("assetId")
        and selected_asset_type_matches({"assetType": row.get("assetType")}, selected.get("assetType"))
        and history_row_price(row) > 0
        and (not start_date or str(row.get("date") or "") >= start_date)
        and (not end_date or str(row.get("date") or "") <= end_date)
    ]
    rows.sort(key=lambda item: str(item.get("date") or ""))
    history = [{"date": str(row.get("date")), "value": round_number(quantity * history_row_price(row), 2)} for row in rows]
    if start_date and history and history[0]["date"] != start_date:
        start_price = historical_asset_price(db, market_id, selected, start_date, "forward")
        if start_price > 0:
            history.insert(0, {"date": start_date, "value": round_number(quantity * start_price, 2)})
    return dedupe_history(history)


def static_contribution_history(market_value: float, start_date: str | None, value_history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if start_date:
        return [{"date": start_date, "value": round_number(market_value, 2)}]
    if value_history:
        return [{"date": str(value_history[0].get("date")), "value": round_number(market_value, 2)}]
    return []


def normalize_value_history(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    rows = [
        {"date": str(item.get("date")), "value": round_number(number_or_zero(item.get("value")), 2)}
        for item in value
        if isinstance(item, dict) and item.get("date") and number_or_zero(item.get("value")) >= 0
    ]
    return dedupe_history(rows)


def dedupe_history(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_date = {str(item.get("date")): item for item in history if item.get("date")}
    return [by_date[date] for date in sorted(by_date)]


def combine_histories(histories: list[list[dict[str, Any]]], base_value: float) -> list[dict[str, Any]]:
    clean_histories = [dedupe_history(history) for history in histories if history]
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


def first_asset_history_date(db: dict[str, Any], market_id: MarketId, selected: dict[str, str]) -> str:
    rows = asset_price_rows(db, market_id, selected)
    return str(rows[0].get("date")) if rows else now_iso()[:10]


def last_asset_history_date(db: dict[str, Any], market_id: MarketId, selected: dict[str, str]) -> str:
    rows = asset_price_rows(db, market_id, selected)
    return str(rows[-1].get("date")) if rows else now_iso()[:10]


def asset_price_rows(db: dict[str, Any], market_id: MarketId, selected: dict[str, str]) -> list[dict[str, Any]]:
    rows = [
        row
        for row in db.get("dailyPrices", [])
        if row.get("marketId") == market_id
        and row.get("assetId") == selected.get("assetId")
        and selected_asset_type_matches({"assetType": row.get("assetType")}, selected.get("assetType"))
        and history_row_price(row) > 0
    ]
    rows.sort(key=lambda item: str(item.get("date") or ""))
    return rows


def historical_asset_price(
    db: dict[str, Any],
    market_id: MarketId,
    selected: dict[str, str],
    target_date: str | None,
    direction: str,
) -> float:
    asset_id = selected.get("assetId")
    if not asset_id:
        return 0
    rows = [
        row
        for row in db.get("dailyPrices", [])
        if row.get("marketId") == market_id
        and row.get("assetId") == asset_id
        and selected_asset_type_matches({"assetType": row.get("assetType")}, selected.get("assetType"))
        and history_row_price(row) > 0
    ]
    if not rows:
        return 0
    rows.sort(key=lambda item: str(item.get("date") or ""))
    if not target_date:
        row = rows[-1] if direction == "backward" else rows[0]
        return history_row_price(row)
    if direction == "backward":
        candidates = [row for row in rows if str(row.get("date") or "") <= target_date]
        row = candidates[-1] if candidates else rows[0]
        return history_row_price(row)
    candidates = [row for row in rows if str(row.get("date") or "") >= target_date]
    row = candidates[0] if candidates else rows[-1]
    return history_row_price(row)


def history_row_price(row: dict[str, Any]) -> float:
    return number_or_zero(row.get("nav") if row.get("nav") is not None else row.get("close"))


def first_history_date(fund: dict[str, Any]) -> str:
    history = fund.get("navHistory") if isinstance(fund.get("navHistory"), list) else []
    return str((history[0] if history else {}).get("date") or now_iso()[:10])


def last_history_date(fund: dict[str, Any]) -> str:
    history = fund.get("navHistory") if isinstance(fund.get("navHistory"), list) else []
    return str((history[-1] if history else {}).get("date") or now_iso()[:10])


def string_param(params: dict[str, Any], key: str) -> str | None:
    value = params.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def number_param(params: dict[str, Any], key: str, default: float) -> float:
    value = params.get(key)
    if value in (None, ""):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def choice_param(params: dict[str, Any], key: str, choices: set[str], default: str) -> str:
    value = params.get(key)
    return value if isinstance(value, str) and value in choices else default
