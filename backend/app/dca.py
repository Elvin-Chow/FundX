from __future__ import annotations

import calendar
import json
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request

from .auth import current_user_id
from .errors import FundXApiError, validation_error
from .services import (
    LOCAL_USER_ID,
    MARKET_CONFIGS,
    asset_kind,
    browser_local_user_data_enabled,
    is_public_market_asset,
    get_db_path,
    get_market_data_meta,
    list_real_asset_history,
    normalize_db,
    now_iso,
    number_or_zero,
    parse_market,
    read_db,
    round_number,
)

TRADING_DAYS_PER_YEAR = 252
DCA_FREQUENCIES = {"weekly", "biweekly", "monthly", "quarterly", "yearly"}
DCA_STRATEGIES = {"standard", "drawdown-addon", "dividend-reinvest", "target-return", "custom"}
TARGET_RETURN_ANNUAL_RATE = 0.08

router = APIRouter(prefix="/api/dca", tags=["dca"])


@router.get("")
def get_dca(request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    user_id = current_user_id(request)
    fund_id = request.query_params.get("fundId")
    db = read_db()
    if fund_id:
        fund, input_data = get_dca_defaults(db, market_id, fund_id)
        plans = [] if browser_local_user_data_enabled() else list_dca_plans(db, user_id, market_id, fund.get("id"))
        simulation = simulate_dca_plan(fund, input_data) if has_real_nav_history(fund) else None
    else:
        input_data = default_dca_input(market_id)
        plans = [] if browser_local_user_data_enabled() else list_dca_plans(db, user_id, market_id)
        simulation = None

    return {
        **get_market_data_meta(db, market_id),
        "defaults": input_data,
        "plans": plans,
        "simulation": simulation,
    }


@router.post("", status_code=201)
async def create_dca(request: Request) -> dict[str, Any]:
    body = await read_json_body(request)
    input_data = validate_dca_plan_save(body)
    market_id = input_data["marketId"]
    assert_query_market_matches(request, market_id)
    user_id = current_user_id(request)

    saved_plan: dict[str, Any] = {}

    def mutate(db: dict[str, Any]) -> None:
        fund = resolve_fund(db, market_id, input_data["fundId"])
        require_real_nav_history(fund)
        simulation = simulate_dca_plan(fund, input_data)
        created_at = now_iso()
        plan = {
            "id": f"dca-{uuid.uuid4()}",
            "userId": user_id,
            "marketId": market_id,
            "name": input_data["name"],
            "fund": fund,
            "input": dict(input_data),
            "strategy": input_data["strategy"],
            "simulationSnapshot": simulation,
            "currencySymbol": MARKET_CONFIGS[market_id]["currencySymbol"],
            "versions": [{"version": 1, "name": "Initial plan", "savedAt": created_at, "data": dict(input_data)}],
            "createdAt": created_at,
            "updatedAt": created_at,
        }
        db.setdefault("dcaPlans", []).insert(0, plan)
        set_cached_value(db, f"dca:{plan['id']}:simulation", simulation, 1800)
        record_audit(db, market_id, "dca.create", "dcaPlan", plan["id"], user_id=user_id)
        saved_plan.update(plan)

    db = update_db(mutate)
    return {
        "ok": True,
        **get_market_data_meta(db, market_id),
        "message": "DCA plan saved and simulated.",
        "plan": saved_plan,
        "simulation": saved_plan.get("simulationSnapshot"),
    }


@router.patch("")
async def patch_dca(request: Request) -> dict[str, Any]:
    body = await read_json_body(request)
    action = body.get("action")
    user_id = current_user_id(request)
    if action == "restore-version":
        plan_id, market_id, version = validate_restore_body(body)
        assert_query_market_matches(request, market_id)
        plan = restore_dca_plan_version(user_id, plan_id, market_id, version)
    elif action in (None, "update"):
        plan_id, market_id, updates = validate_update_body(body)
        assert_query_market_matches(request, market_id)
        plan = update_dca_plan(user_id, plan_id, market_id, updates)
    else:
        raise validation_error("action must be one of: update, restore-version.")

    db = read_db()
    return {
        "ok": True,
        **get_market_data_meta(db, market_id),
        "plan": plan,
        "simulation": plan.get("simulationSnapshot"),
    }


@router.delete("")
def delete_dca(request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    user_id = current_user_id(request)
    plan_id = request.query_params.get("id")
    if not plan_id:
        raise FundXApiError("invalid_request", "id query parameter is required.", 400)

    removed: dict[str, Any] = {}

    def mutate(db: dict[str, Any]) -> None:
        plan = owned_dca_plan(db, user_id, plan_id)
        if plan.get("marketId") != market_id:
            raise FundXApiError("not_found", "DCA plan was not found in the selected market.", 404)
        db["dcaPlans"] = [item for item in db.get("dcaPlans", []) if item.get("id") != plan.get("id")]
        record_audit(db, market_id, "dca.delete", "dcaPlan", str(plan.get("id")), user_id=user_id)
        removed.update(plan)

    update_db(mutate)
    return {"ok": True, "planId": removed.get("id") or plan_id}


def real_market_funds(db: dict[str, Any], market_id: str) -> list[dict[str, Any]]:
    funds_by_id = {fund.get("id"): fund for fund in db.get("funds", []) if fund.get("marketId") == market_id}
    stocks_by_id = {stock.get("id"): stock for stock in db.get("stocks", []) if stock.get("marketId") == market_id}
    result: list[dict[str, Any]] = []
    for asset in db.get("assets", []):
        if asset.get("marketId") != market_id:
            continue
        kind = asset_kind(asset)
        if kind not in ("fund", "stock"):
            continue
        if not is_public_market_asset(asset):
            continue
        if asset.get("fundCompany") == "FundX Public Market Adapter" or asset.get("source") == "user-custom":
            continue
        base = funds_by_id.get(asset.get("id"), {}) if kind == "fund" else stocks_by_id.get(asset.get("id"), {})
        history = real_fund_history(db, market_id, str(asset.get("id"))) if kind == "fund" else list_real_asset_history(db, market_id, str(asset.get("id")), "stock")
        latest_price = asset.get("latestPrice") if isinstance(asset.get("latestPrice"), (int, float)) else base.get("nav" if kind == "fund" else "price")
        result.append(
            {
                **base,
                "id": asset.get("id"),
                "marketId": market_id,
                "name": asset.get("name"),
                "symbol": asset.get("symbol"),
                "type": asset.get("fundType") or asset.get("fundSubtype") or base.get("type") or ("Stock" if kind == "stock" else "Fund"),
                "category": asset.get("category") or asset.get("sector") or base.get("category") or "Unclassified",
                "style": asset.get("category") or asset.get("sector") or base.get("style") or "Unclassified",
                "nav": latest_price if isinstance(latest_price, (int, float)) else 0,
                "dailyChange": asset.get("dailyChange") or 0,
                "dividendYield": base.get("dividendYield") if base.get("dividendYield") is not None else asset.get("dividendYield"),
                "aum": asset.get("aum"),
                "expenseRatio": asset.get("expenseRatio"),
                "holdings": [],
                "sectorExposure": [],
                "navHistory": history,
                "dividends": base.get("dividends") if isinstance(base.get("dividends"), list) else [],
                "assetType": asset.get("assetType"),
                "kind": kind,
            }
        )
    return result


def real_market_asset(db: dict[str, Any], market_id: str, asset_id: str) -> dict[str, Any] | None:
    asset = next(
        (
            item
            for item in db.get("assets", [])
            if item.get("id") == asset_id
            and item.get("marketId") == market_id
            and asset_kind(item) in ("fund", "stock")
            and is_public_market_asset(item)
        ),
        None,
    )
    if not asset:
        return None
    kind = asset_kind(asset)
    if asset.get("fundCompany") == "FundX Public Market Adapter" or asset.get("source") == "user-custom":
        return None
    base = next(
        (
            item
            for item in db.get("funds" if kind == "fund" else "stocks", [])
            if item.get("id") == asset_id and item.get("marketId") == market_id
        ),
        {},
    )
    history = real_fund_history(db, market_id, asset_id) if kind == "fund" else list_real_asset_history(db, market_id, asset_id, "stock")
    latest_price = asset.get("latestPrice") if isinstance(asset.get("latestPrice"), (int, float)) else base.get("nav" if kind == "fund" else "price")
    return {
        **base,
        "id": asset.get("id"),
        "marketId": market_id,
        "name": asset.get("name"),
        "symbol": asset.get("symbol"),
        "type": asset.get("fundType") or asset.get("fundSubtype") or base.get("type") or ("Stock" if kind == "stock" else "Fund"),
        "category": asset.get("category") or asset.get("sector") or base.get("category") or "Unclassified",
        "style": asset.get("category") or asset.get("sector") or base.get("style") or "Unclassified",
        "nav": latest_price if isinstance(latest_price, (int, float)) else 0,
        "dailyChange": asset.get("dailyChange") or 0,
        "dividendYield": base.get("dividendYield") if base.get("dividendYield") is not None else asset.get("dividendYield"),
        "aum": asset.get("aum") or base.get("aum"),
        "expenseRatio": asset.get("expenseRatio") or base.get("expenseRatio"),
        "holdings": base.get("holdings") if isinstance(base.get("holdings"), list) else [],
        "sectorExposure": base.get("sectorExposure") if isinstance(base.get("sectorExposure"), list) else [],
        "navHistory": history,
        "dividends": base.get("dividends") if isinstance(base.get("dividends"), list) else [],
        "assetType": asset.get("assetType"),
        "kind": kind,
    }


def real_fund_history(db: dict[str, Any], market_id: str, fund_id: str) -> list[dict[str, Any]]:
    points = sorted(
        (
            point
            for point in db.get("dailyPrices", [])
            if point.get("marketId") == market_id
            and point.get("assetId") == fund_id
            and point.get("assetType") in ("fund", "etf")
            and (isinstance(point.get("nav"), (int, float)) or isinstance(point.get("close"), (int, float)))
        ),
        key=lambda point: str(point.get("date") or ""),
    )
    return [
        {"date": point.get("date"), "value": point.get("nav") if isinstance(point.get("nav"), (int, float)) else point.get("close")}
        for point in points
    ]


def has_real_nav_history(fund: dict[str, Any]) -> bool:
    history = fund.get("navHistory")
    return isinstance(history, list) and any(isinstance(point, dict) and isinstance(point.get("value"), (int, float)) for point in history)


def require_real_nav_history(fund: dict[str, Any]) -> None:
    if not has_real_nav_history(fund):
        raise FundXApiError("invalid_request", "Real NAV history is required before this DCA plan can be simulated.", 400)


def get_dca_defaults(db: dict[str, Any], market_id: str, fund_id: str | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    market_funds = [] if fund_id else real_market_funds(db, market_id)
    default_fund_id = "us-sp500-index"
    fund = resolve_fund(db, market_id, fund_id) if fund_id else None
    if not fund:
        fund = next((item for item in market_funds if item.get("id") == default_fund_id), None)
    if not fund_id and fund and not has_real_nav_history(fund):
        fund = None
    if not fund and market_funds:
        fund = next((item for item in market_funds if has_real_nav_history(item)), market_funds[0])
    if not fund:
        raise FundXApiError("not_found", "No DCA asset was found in the selected market.", 404)

    input_data = default_dca_input(market_id, fund)
    return fund, input_data


def default_dca_input(market_id: str, fund: dict[str, Any] | None = None) -> dict[str, Any]:
    history = fund.get("navHistory") if isinstance(fund, dict) and isinstance(fund.get("navHistory"), list) else []
    start_point = history[0] if history and isinstance(history[0], dict) else {}
    last_point = history[-1] if history and isinstance(history[-1], dict) else {}
    today = now_iso()[:10]
    input_data = {
        "fundId": fund.get("id") if isinstance(fund, dict) else "",
        "name": f"{fund.get('name')} DCA" if isinstance(fund, dict) else "DCA Plan",
        "initialAmount": 10000,
        "recurringAmount": 1000,
        "frequency": "monthly",
        "startDate": start_point.get("date") or today,
        "endDate": last_point.get("date") or today,
        "reinvestDividends": True,
        "transactionCost": 0,
        "strategy": "standard",
    }
    return input_data


def list_dca_plans(db: dict[str, Any], user_id: str, market_id: str, fund_id: str | None = None) -> list[dict[str, Any]]:
    return [
        plan
        for plan in db.get("dcaPlans", [])
        if plan.get("userId") == user_id
        and plan.get("marketId") == market_id
        and (not fund_id or (plan.get("input") or {}).get("fundId") == fund_id)
    ]


def update_dca_plan(user_id: str, plan_id: str, market_id: str, updates: dict[str, Any]) -> dict[str, Any]:
    saved_plan: dict[str, Any] = {}

    def mutate(db: dict[str, Any]) -> None:
        plan = owned_dca_plan(db, user_id, plan_id)
        if plan.get("marketId") != market_id:
            raise FundXApiError("invalid_request", "DCA plan market cannot be changed.", 400)

        current_input = plan.get("input") if isinstance(plan.get("input"), dict) else {}
        next_input = {**current_input, **updates, "fundId": updates.get("fundId") or current_input.get("fundId")}
        next_input["marketId"] = market_id
        fund = resolve_fund(db, market_id, str(next_input.get("fundId") or ""))
        require_real_nav_history(fund)
        simulation = simulate_dca_plan(fund, next_input)
        updated_at = now_iso()
        plan["name"] = updates.get("name") or plan.get("name")
        plan["fund"] = fund
        plan["input"] = next_input
        plan["strategy"] = next_input.get("strategy")
        plan["simulationSnapshot"] = simulation
        plan["updatedAt"] = updated_at
        versions = plan.get("versions") if isinstance(plan.get("versions"), list) else []
        last_version = versions[-1].get("version") if versions and isinstance(versions[-1], dict) else 0
        version = int(number_or_zero(last_version)) + 1
        plan["versions"] = [*versions, {"version": version, "name": "Updated plan", "savedAt": updated_at, "data": dict(next_input)}]
        set_cached_value(db, f"dca:{plan['id']}:simulation", simulation, 1800)
        record_audit(db, market_id, "dca.update", "dcaPlan", plan["id"], user_id=user_id)
        saved_plan.update(plan)

    update_db(mutate)
    return saved_plan


def restore_dca_plan_version(user_id: str, plan_id: str, market_id: str, version: int) -> dict[str, Any]:
    saved_plan: dict[str, Any] = {}

    def mutate(db: dict[str, Any]) -> None:
        plan = owned_dca_plan(db, user_id, plan_id)
        if plan.get("marketId") != market_id:
            raise FundXApiError("invalid_request", "DCA plan market cannot be changed.", 400)
        versions = plan.get("versions") if isinstance(plan.get("versions"), list) else []
        target = next((item for item in versions if isinstance(item, dict) and int(number_or_zero(item.get("version"))) == version), None)
        if not target:
            raise FundXApiError("not_found", "DCA plan version was not found.", 404)
        input_data = target.get("data") if isinstance(target.get("data"), dict) else {}
        fund = resolve_fund(db, market_id, str(input_data.get("fundId") or ""))
        require_real_nav_history(fund)
        simulation = simulate_dca_plan(fund, input_data)
        plan["input"] = input_data
        plan["fund"] = fund
        plan["strategy"] = input_data.get("strategy")
        plan["simulationSnapshot"] = simulation
        plan["updatedAt"] = now_iso()
        record_audit(db, market_id, "dca.restore-version", "dcaPlan", plan["id"], user_id=user_id, metadata={"version": version})
        saved_plan.update(plan)

    update_db(mutate)
    return saved_plan


def owned_dca_plan(db: dict[str, Any], user_id: str, plan_id: str) -> dict[str, Any]:
    plan = next((item for item in db.get("dcaPlans", []) if item.get("userId") == user_id and item.get("id") == plan_id), None)
    if not plan:
        raise FundXApiError("not_found", "DCA plan was not found.", 404)
    return plan


def resolve_fund(db: dict[str, Any], market_id: str, fund_id: str) -> dict[str, Any]:
    fund = real_market_asset(db, market_id, fund_id)
    if not fund:
        raise FundXApiError("not_found", "Asset was not found in the selected market.", 404)
    return fund


async def read_json_body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception as exc:
        raise FundXApiError("invalid_json", "Request body must be valid JSON.", 400) from exc
    if not isinstance(body, dict):
        raise validation_error("Request body must be a JSON object.")
    return body


def validate_dca_plan_save(body: dict[str, Any]) -> dict[str, Any]:
    return {
        "marketId": require_market_id(body.get("marketId")),
        "fundId": require_string(body.get("fundId"), "fundId", max_length=120),
        "name": require_string(body.get("name"), "name", max_length=80),
        "initialAmount": require_number(body.get("initialAmount"), "initialAmount", minimum=0),
        "recurringAmount": require_number(body.get("recurringAmount"), "recurringAmount", minimum=0),
        "frequency": require_choice(body.get("frequency"), "frequency", DCA_FREQUENCIES),
        "startDate": require_date_string(body.get("startDate"), "startDate"),
        "endDate": require_date_string(body.get("endDate"), "endDate"),
        "reinvestDividends": coerce_bool(body.get("reinvestDividends"), "reinvestDividends"),
        "transactionCost": require_number(body.get("transactionCost"), "transactionCost", minimum=0),
        "strategy": require_choice(body.get("strategy"), "strategy", DCA_STRATEGIES),
    }


def validate_update_body(body: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    plan_id = require_string(body.get("id"), "id", max_length=120)
    market_id = require_market_id(body.get("marketId"))
    updates = validate_dca_plan_partial(body)
    updates["marketId"] = market_id
    return plan_id, market_id, updates


def validate_restore_body(body: dict[str, Any]) -> tuple[str, str, int]:
    plan_id = require_string(body.get("id"), "id", max_length=120)
    market_id = require_market_id(body.get("marketId"))
    version = require_int(body.get("version"), "version", minimum=1)
    return plan_id, market_id, version


def validate_dca_plan_partial(body: dict[str, Any]) -> dict[str, Any]:
    updates: dict[str, Any] = {}
    if "fundId" in body:
        updates["fundId"] = require_string(body.get("fundId"), "fundId", max_length=120)
    if "name" in body:
        updates["name"] = require_string(body.get("name"), "name", max_length=80)
    if "initialAmount" in body:
        updates["initialAmount"] = require_number(body.get("initialAmount"), "initialAmount", minimum=0)
    if "recurringAmount" in body:
        updates["recurringAmount"] = require_number(body.get("recurringAmount"), "recurringAmount", minimum=0)
    if "frequency" in body:
        updates["frequency"] = require_choice(body.get("frequency"), "frequency", DCA_FREQUENCIES)
    if "startDate" in body:
        updates["startDate"] = require_date_string(body.get("startDate"), "startDate")
    if "endDate" in body:
        updates["endDate"] = require_date_string(body.get("endDate"), "endDate")
    if "reinvestDividends" in body:
        updates["reinvestDividends"] = coerce_bool(body.get("reinvestDividends"), "reinvestDividends")
    if "transactionCost" in body:
        updates["transactionCost"] = require_number(body.get("transactionCost"), "transactionCost", minimum=0)
    if "strategy" in body:
        updates["strategy"] = require_choice(body.get("strategy"), "strategy", DCA_STRATEGIES)
    return updates


def require_market_id(value: Any) -> str:
    if value != "us":
        raise validation_error("marketId must be: us.")
    return str(value)


def require_string(value: Any, field: str, *, max_length: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise validation_error(f"{field} is required.")
    text = value.strip()
    if len(text) > max_length:
        raise validation_error(f"{field} must contain at most {max_length} characters.")
    return text


def require_choice(value: Any, field: str, choices: set[str]) -> str:
    if not isinstance(value, str) or value not in choices:
        raise validation_error(f"{field} must be one of: {', '.join(sorted(choices))}.")
    return value


def require_date_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or len(value) != 10:
        raise validation_error(f"{field} must be a YYYY-MM-DD string.")
    return value


def require_number(value: Any, field: str, *, minimum: float, exclusive_minimum: bool = False) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise validation_error(f"{field} must be a number.") from exc
    if exclusive_minimum and number <= minimum:
        raise validation_error(f"{field} must be greater than {minimum}.")
    if not exclusive_minimum and number < minimum:
        raise validation_error(f"{field} must be greater than or equal to {minimum}.")
    return number


def require_int(value: Any, field: str, *, minimum: int) -> int:
    number = require_number(value, field, minimum=minimum)
    if not float(number).is_integer():
        raise validation_error(f"{field} must be an integer.")
    return int(number)


def coerce_bool(value: Any, field: str) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in ("true", "1", "yes", "on"):
            return True
        if normalized in ("false", "0", "no", "off"):
            return False
    raise validation_error(f"{field} must be a boolean.")


def assert_query_market_matches(request: Request, market_id: str) -> None:
    if request.query_params.get("market") and parse_market(request.query_params.get("market")) != market_id:
        raise FundXApiError("market_mismatch", "Request query market and body marketId must match.", 400)


def simulate_dca_plan(fund: dict[str, Any], input_data: dict[str, Any]) -> dict[str, Any]:
    history = filter_history_by_date_range(fund.get("navHistory") or [], str(input_data.get("startDate")), str(input_data.get("endDate")))
    contribution_dates = build_contribution_dates(str(input_data.get("startDate")), str(input_data.get("endDate")), str(input_data.get("frequency")))
    next_contribution_index = 0
    dividend_by_date = {
        str(dividend.get("date")): number_or_zero(dividend.get("amount"))
        for dividend in fund.get("dividends", [])
        if isinstance(dividend, dict) and dividend.get("date")
    }
    total_invested = 0.0
    accumulated_shares = 0.0
    total_fees = 0.0
    total_dividends = 0.0
    cash_dividends = 0.0
    cash_flow_history: list[dict[str, Any]] = []
    value_history: list[dict[str, Any]] = []
    contribution_history: list[dict[str, Any]] = []
    first_date = str(history[0].get("date")) if history else str(input_data.get("startDate"))

    for index, point in enumerate(history):
        point_date = str(point.get("date"))
        point_value = number_or_zero(point.get("value"))
        is_initial = index == 0
        scheduled_count = 0
        while next_contribution_index < len(contribution_dates) and contribution_dates[next_contribution_index] <= point_date:
            if contribution_dates[next_contribution_index] != str(input_data.get("startDate")):
                scheduled_count += 1
            next_contribution_index += 1
        contribution = 0.0
        fee = 0.0
        shares_purchased = 0.0
        if is_initial or scheduled_count > 0:
            base_contribution = (number_or_zero(input_data.get("initialAmount")) if is_initial else 0) + (number_or_zero(input_data.get("recurringAmount")) * scheduled_count)
            contribution = base_contribution * strategy_contribution_multiplier(
                input_data,
                point_date,
                point_value,
                accumulated_shares,
                total_invested,
                first_date,
                value_history,
            )
            transaction_count = (1 if is_initial and number_or_zero(input_data.get("initialAmount")) > 0 else 0) + scheduled_count
            fee = min(number_or_zero(input_data.get("transactionCost")) * transaction_count, contribution)
            shares_purchased = 0 if point_value == 0 else (contribution - fee) / point_value
            total_invested += contribution
            total_fees += fee
            accumulated_shares += shares_purchased

        dividend = 0.0
        dividend_shares = 0.0
        if point_value > 0 and accumulated_shares > 0:
            explicit_dividend_per_share = dividend_by_date.get(point_date)
            if explicit_dividend_per_share and explicit_dividend_per_share > 0:
                dividend = accumulated_shares * explicit_dividend_per_share
            if dividend > 0:
                total_dividends += dividend
                if should_reinvest_dividends(input_data):
                    dividend_shares = dividend / point_value
                    accumulated_shares += dividend_shares
                else:
                    cash_dividends += dividend
                if contribution <= 0:
                    cash_flow_history.append(
                        {
                            "date": point_date,
                            "nav": point_value,
                            "contribution": 0,
                            "fee": 0,
                            "dividend": round_number(dividend, 2),
                            "dividendShares": round_number(dividend_shares, 6),
                            "sharesPurchased": 0,
                            "accumulatedShares": round_number(accumulated_shares, 6),
                            "portfolioValue": round_number((accumulated_shares * point_value) + cash_dividends, 2),
                        }
                    )

        if contribution > 0:
            cash_flow_history.append(
                {
                    "date": point_date,
                    "nav": point_value,
                    "contribution": round_number(contribution, 2),
                    "fee": round_number(fee, 2),
                    "dividend": round_number(dividend, 2),
                    "dividendShares": round_number(dividend_shares, 6),
                    "sharesPurchased": round_number(shares_purchased, 6),
                    "accumulatedShares": round_number(accumulated_shares, 6),
                    "portfolioValue": round_number((accumulated_shares * point_value) + cash_dividends, 2),
                }
            )

        value_history.append({"date": point_date, "value": round_number((accumulated_shares * point_value) + cash_dividends, 2)})
        contribution_history.append({"date": point_date, "value": round_number(total_invested, 2)})

    final_value = number_or_zero(value_history[-1].get("value")) if value_history else 0
    drawdown = calculate_drawdown(value_history)
    last_date = str(history[-1].get("date")) if history else str(input_data.get("endDate"))
    average_cost = 0 if accumulated_shares == 0 else round_number((total_invested - total_fees) / accumulated_shares, 4)

    return {
        "id": f"{fund.get('id')}-dca-simulation",
        "marketId": fund.get("marketId"),
        "fundId": fund.get("id"),
        "name": input_data.get("name") or f"{fund.get('name')} DCA",
        "input": input_data,
        "totalInvested": round_number(total_invested, 2),
        "totalFees": round_number(total_fees, 2),
        "totalDividends": round_number(total_dividends, 2),
        "finalValue": round_number(final_value, 2),
        "totalReturn": round_number(final_value - total_invested, 2),
        "totalReturnPercent": round_number(calculate_return(total_invested, final_value), 2),
        "annualizedReturn": calculate_dca_annualized_return(cash_flow_history, final_value, last_date),
        "maxDrawdown": drawdown["maxDrawdown"],
        "averageCost": average_cost,
        "sharesAccumulated": round_number(accumulated_shares, 6),
        "valueHistory": value_history,
        "contributionHistory": contribution_history,
        "drawdownHistory": drawdown["drawdownHistory"],
        "cashFlowHistory": cash_flow_history,
        "annualReturns": [{"year": point["date"], "return": point["value"]} for point in calculate_period_returns(value_history, 4)],
        "monthlyReturns": [{"month": point["date"], "return": point["value"]} for point in calculate_period_returns(value_history, 7)],
    }


def should_reinvest_dividends(input_data: dict[str, Any]) -> bool:
    return bool(input_data.get("reinvestDividends")) or input_data.get("strategy") in ("dividend-reinvest", "custom")


def strategy_contribution_multiplier(
    input_data: dict[str, Any],
    point_date: str,
    point_value: float,
    accumulated_shares: float,
    total_invested: float,
    first_date: str,
    value_history: list[dict[str, Any]],
) -> float:
    strategy = input_data.get("strategy")
    current_value = accumulated_shares * point_value
    previous_value = number_or_zero(value_history[-1].get("value")) if value_history else current_value
    multiplier = 1.0

    if strategy in ("drawdown-addon", "custom") and previous_value > current_value:
        multiplier += 0.25

    if strategy in ("target-return", "custom") and total_invested > 0:
        years = max(0, days_between_at_least_one(first_date, point_date) / 365.25)
        target_value = total_invested * ((1 + TARGET_RETURN_ANNUAL_RATE) ** years)
        if current_value < target_value:
            multiplier += 0.15 if strategy == "custom" else 0.2

    return multiplier


def calculate_return(start_value: float, end_value: float) -> float:
    if start_value == 0:
        return 0
    return ((end_value - start_value) / start_value) * 100


def calculate_annualized_return(start_value: float, end_value: float, start_date: str, end_date: str) -> float:
    years = days_between_at_least_one(start_date, end_date) / 365.25
    if start_value <= 0 or end_value <= 0 or years <= 0:
        return 0
    return round_number(((end_value / start_value) ** (1 / years) - 1) * 100, 2)


def calculate_dca_annualized_return(cash_flow_history: list[dict[str, Any]], final_value: float, final_date: str) -> float:
    cash_flows = [
        {"date": str(row.get("date")), "amount": -number_or_zero(row.get("contribution"))}
        for row in cash_flow_history
        if number_or_zero(row.get("contribution")) > 0
    ]
    if final_value > 0:
        cash_flows.append({"date": final_date, "amount": final_value})
    return calculate_xirr(cash_flows)


def calculate_xirr(cash_flows: list[dict[str, Any]]) -> float:
    dated_flows = [
        {"date": parse_iso_date(str(flow.get("date")), "cashFlowDate"), "amount": number_or_zero(flow.get("amount"))}
        for flow in cash_flows
        if number_or_zero(flow.get("amount")) != 0
    ]
    if not any(flow["amount"] > 0 for flow in dated_flows) or not any(flow["amount"] < 0 for flow in dated_flows):
        return 0

    first_date = min(flow["date"] for flow in dated_flows)

    def npv(rate: float) -> float:
        return sum(
            flow["amount"] / ((1 + rate) ** (((flow["date"] - first_date).days or 0) / 365.25))
            for flow in dated_flows
        )

    low = -0.9999
    high = 10.0
    low_value = npv(low)
    high_value = npv(high)
    while low_value * high_value > 0 and high < 1000:
        high *= 2
        high_value = npv(high)
    if low_value * high_value > 0:
        return 0

    for _ in range(100):
        mid = (low + high) / 2
        mid_value = npv(mid)
        if abs(mid_value) < 0.000001:
            return round_number(mid * 100, 2)
        if low_value * mid_value <= 0:
            high = mid
            high_value = mid_value
        else:
            low = mid
            low_value = mid_value

    return round_number(((low + high) / 2) * 100, 2)


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
        point_date = str(point.get("date", ""))
        if value > peak:
            peak = value
            peak_date = point_date
        drawdown = 0 if peak == 0 else ((value - peak) / peak) * 100
        drawdown_history.append({"date": point_date, "value": round_number(drawdown, 2)})
        if drawdown < max_drawdown:
            max_drawdown = drawdown
            start_date = peak_date
            bottom_date = point_date
            recovery_date = None
        if not recovery_date and max_drawdown < 0 and point_date > bottom_date and value >= peak:
            recovery_date = point_date

    return {
        "maxDrawdown": round_number(max_drawdown, 2),
        "startDate": start_date,
        "bottomDate": bottom_date,
        "recoveryDate": recovery_date,
        "durationDays": days_between_at_least_one(start_date, recovery_date or str(sorted_history[-1].get("date", ""))),
        "drawdownHistory": drawdown_history,
    }


def calculate_period_returns(history: list[dict[str, Any]], key_length: int) -> list[dict[str, Any]]:
    buckets: dict[str, list[dict[str, Any]]] = {}
    for point in sort_history(history):
        key = str(point.get("date", ""))[:key_length]
        buckets.setdefault(key, []).append(point)
    return [
        {"date": key, "value": round_number(calculate_return(number_or_zero(points[0].get("value")), number_or_zero(points[-1].get("value"))), 2)}
        for key, points in buckets.items()
        if points
    ]


def sort_history(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted([point for point in history if isinstance(point, dict)], key=lambda point: str(point.get("date", "")))


def filter_history_by_date_range(history: list[dict[str, Any]], start_date: str, end_date: str) -> list[dict[str, Any]]:
    return [point for point in sort_history(history) if start_date <= str(point.get("date", "")) <= end_date]


def build_contribution_dates(start_date: str, end_date: str, frequency: str) -> list[str]:
    dates = []
    start = parse_iso_date(start_date, "startDate")
    cursor = start
    end = parse_iso_date(end_date, "endDate")
    month_offset = 0
    while cursor <= end:
        dates.append(cursor.isoformat())
        if frequency == "weekly":
            cursor += timedelta(days=7)
        elif frequency == "biweekly":
            cursor += timedelta(days=14)
        elif frequency == "quarterly":
            month_offset += 3
            cursor = add_months(start, month_offset)
        elif frequency == "yearly":
            month_offset += 12
            cursor = add_months(start, month_offset)
        else:
            month_offset += 1
            cursor = add_months(start, month_offset)
    return dates


def add_months(value: date, months: int) -> date:
    month_index = value.month - 1 + months
    year = value.year + month_index // 12
    month = month_index % 12 + 1
    day = min(value.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def days_between_at_least_one(start_date: str, end_date: str) -> int:
    start = parse_iso_date(start_date, "startDate")
    end = parse_iso_date(end_date, "endDate")
    return max(1, round((end - start).days))


def parse_iso_date(value: str, field: str) -> date:
    try:
        return date.fromisoformat(value[:10])
    except ValueError as exc:
        raise validation_error(f"{field} must be a valid YYYY-MM-DD date.") from exc


def update_db(mutator: Any) -> dict[str, Any]:
    path = get_db_path()
    if path is None:
        raise FundXApiError("database_not_found", "FundX local database was not found.", 500)
    with Path(path).open("r", encoding="utf-8") as handle:
        raw = json.load(handle)
    db = raw.get("data") if isinstance(raw.get("data"), dict) else raw
    ensure_collections(db)
    mutator(db)
    timestamp = now_iso()
    if isinstance(raw.get("data"), dict):
        raw["migratedAt"] = timestamp
    else:
        raw["updatedAt"] = timestamp
    temp_path = Path(f"{path}.tmp")
    temp_path.write_text(f"{json.dumps(raw, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
    temp_path.replace(path)
    return normalize_db(raw)


def ensure_collections(db: dict[str, Any]) -> None:
    for key in ("cache", "dcaPlans", "auditEvents"):
        db.setdefault(key, [])


def set_cached_value(db: dict[str, Any], key: str, value: Any, ttl_seconds: int) -> None:
    created_at = now_iso()
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    db["cache"] = [item for item in db.get("cache", []) if item.get("key") != key and str(item.get("expiresAt", "")) > created_at]
    db.setdefault("cache", []).append({"key": key, "value": value, "expiresAt": expires_at, "createdAt": created_at})


def record_audit(
    db: dict[str, Any],
    market_id: str,
    action: str,
    entity_type: str,
    entity_id: str,
    *,
    user_id: str = LOCAL_USER_ID,
    metadata: dict[str, Any] | None = None,
) -> None:
    db.setdefault("auditEvents", []).insert(
        0,
        {
            "id": f"audit-{uuid.uuid4()}",
            "userId": user_id,
            "marketId": market_id,
            "action": action,
            "entityType": entity_type,
            "entityId": entity_id,
            **({"metadata": metadata} if metadata is not None else {}),
            "createdAt": now_iso(),
        },
    )
    db["auditEvents"] = db["auditEvents"][:1000]
