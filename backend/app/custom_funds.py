from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, Request

from .auth import current_user_id
from .errors import FundXApiError, invalid_market, validation_error
from .services import (
    LOCAL_USER_ID,
    MarketId,
    asset_kind,
    browser_local_user_data_enabled,
    calculate_drawdown,
    daily_price_history_index,
    get_db_path,
    is_public_market_asset,
    get_market_data_meta,
    normalize_db,
    now_iso,
    number_or_zero,
    parse_market,
    read_db,
    round_number,
)

router = APIRouter(prefix="/api/custom-funds", tags=["custom-funds"])


@router.get("")
def list_custom_funds_route(request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    user_id = current_user_id(request)
    db = read_db()
    return {
        **get_market_data_meta(db, market_id),
        "universe": list_custom_fund_universe(db, market_id, limit=60),
        "universeCount": count_custom_fund_universe(db, market_id),
        "customFunds": [] if browser_local_user_data_enabled() else list_custom_funds(db, user_id, market_id),
        "draft": get_custom_fund_draft(db, market_id),
    }


@router.post("", status_code=201)
async def create_custom_fund_route(request: Request) -> dict[str, Any]:
    body = await read_json_body(request)
    input_data = parse_custom_fund_save_body(body)
    market_id = input_data["marketId"]
    assert_query_market_matches(request, market_id)
    user_id = current_user_id(request)
    saved_fund: dict[str, Any] = {}

    def mutate(db: dict[str, Any]) -> None:
        fund = create_custom_fund(db, user_id, input_data)
        saved_fund.update(fund)

    db = update_db(mutate)
    return {
        "ok": True,
        **get_market_data_meta(db, market_id),
        "message": "Custom fund saved.",
        "customFund": saved_fund,
    }


@router.patch("")
async def patch_custom_fund_route(request: Request) -> dict[str, Any]:
    body = await read_json_body(request)
    action = body.get("action")

    if action == "restore-version":
        input_data = parse_custom_fund_restore_body(body)
        market_id = input_data["marketId"]
        assert_query_market_matches(request, market_id)
        user_id = current_user_id(request)
        saved_fund: dict[str, Any] = {}

        def mutate(db: dict[str, Any]) -> None:
            fund = restore_custom_fund_version(db, user_id, input_data["id"], market_id, input_data["version"])
            saved_fund.update(fund)

        db = update_db(mutate)
        return {
            "ok": True,
            **get_market_data_meta(db, market_id),
            "customFund": saved_fund,
        }

    if action not in (None, "update"):
        raise validation_error("action must be one of: update, restore-version.")

    input_data = parse_custom_fund_update_body(body)
    market_id = input_data["marketId"]
    assert_query_market_matches(request, market_id)
    user_id = current_user_id(request)
    saved_fund: dict[str, Any] = {}

    def mutate(db: dict[str, Any]) -> None:
        fund = update_custom_fund(db, user_id, input_data["id"], input_data)
        saved_fund.update(fund)

    db = update_db(mutate)
    return {
        "ok": True,
        **get_market_data_meta(db, market_id),
        "customFund": saved_fund,
    }


@router.delete("")
def delete_custom_fund_route(request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    user_id = current_user_id(request)
    custom_fund_id = request.query_params.get("id")
    if not custom_fund_id:
        raise FundXApiError("invalid_request", "id query parameter is required.", 400)

    def mutate(db: dict[str, Any]) -> None:
        delete_custom_fund(db, user_id, custom_fund_id, market_id)

    update_db(mutate)
    return {"ok": True, "customFundId": custom_fund_id}


def list_custom_fund_universe(
    db: dict[str, Any],
    market_id: MarketId,
    limit: int | None = None,
    *,
    include_history: bool = False,
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    stock_by_id = {stock.get("id"): stock for stock in db.get("stocks", []) if stock.get("marketId") == market_id}
    history_index = daily_price_history_index(db, market_id)
    for asset in iter_custom_fund_assets(db, market_id):
        stock = stock_by_id.get(asset.get("id"), {})
        history = real_stock_history(db, market_id, str(asset.get("id") or ""), history_index)
        latest_price = (
            asset.get("latestPrice")
            if isinstance(asset.get("latestPrice"), (int, float))
            else stock.get("price")
            if isinstance(stock.get("price"), (int, float))
            else history_value(history[-1])
            if history
            else 0
        )
        previous_price = history_value(history[-2]) if len(history) > 1 else latest_price
        daily_change = asset.get("dailyChange")
        if (not isinstance(daily_change, (int, float)) or abs(float(daily_change)) < 0.05) and previous_price:
            daily_change = ((number_or_zero(latest_price) - number_or_zero(previous_price)) / number_or_zero(previous_price)) * 100
        sector = asset.get("sector") or stock.get("sector") or asset.get("industry") or asset.get("category") or "Other"
        industry = asset.get("industry") or stock.get("industry") or sector
        result.append(
            {
                "id": asset.get("id"),
                "marketId": market_id,
                "name": asset.get("name") or stock.get("name"),
                "symbol": asset.get("symbol") or stock.get("symbol"),
                "assetType": "stock",
                "kind": "stock",
                "sector": sector,
                "industry": industry,
                "price": round_number(number_or_zero(latest_price), 4),
                "dailyChange": round_number(number_or_zero(daily_change), 2),
                "marketCap": stock.get("marketCap"),
                "peRatio": stock.get("peRatio"),
                "pbRatio": stock.get("pbRatio"),
                "dividendYield": stock.get("dividendYield"),
                "roe": stock.get("roe"),
                "grossMargin": stock.get("grossMargin"),
                "debtRatio": stock.get("debtRatio"),
                "freeCashFlowYield": stock.get("freeCashFlowYield"),
                "revenueGrowth": stock.get("revenueGrowth"),
                "profitGrowth": stock.get("profitGrowth"),
                "volatility": stock.get("volatility"),
                "valueScore": stock.get("valueScore"),
                "qualityScore": stock.get("qualityScore"),
                "riskScore": stock.get("riskScore"),
                **({"priceHistory": history} if include_history else {}),
                "valueLabel": "" if stock.get("valueScore") is None else str(stock.get("valueScore")),
                "qualityLabel": "" if stock.get("qualityScore") is None else str(stock.get("qualityScore")),
                "priceLabel": "" if not latest_price else f"{round_number(number_or_zero(latest_price), 2)}",
            }
        )
        if limit is not None and len(result) >= limit:
            break
    return result


def iter_custom_fund_assets(db: dict[str, Any], market_id: MarketId):
    for asset in db.get("assets", []):
        if asset.get("marketId") != market_id:
            continue
        if asset_kind(asset) != "stock":
            continue
        if not is_public_market_asset(asset):
            continue
        yield asset


def count_custom_fund_universe(db: dict[str, Any], market_id: MarketId) -> int:
    return sum(1 for _ in iter_custom_fund_assets(db, market_id))


def list_custom_funds(db: dict[str, Any], user_id: str, market_id: MarketId) -> list[dict[str, Any]]:
    return [
        fund
        for fund in db.get("customFunds", [])
        if fund.get("userId") == user_id and fund.get("marketId") == market_id
    ]


def get_custom_fund_draft(db: dict[str, Any], market_id: MarketId) -> dict[str, Any]:
    stocks = [stock for stock in db.get("stocks", []) if stock.get("marketId") == market_id]
    holdings = [{"stockId": stock.get("id"), "weight": 20} for stock in stocks[:5] if stock.get("id")]
    return {
        "name": "Quality Value Custom Fund" if market_id == "us" else "\u8d28\u91cf\u7ea2\u5229\u81ea\u9009\u57fa\u91d1",
        "style": "Quality Value" if market_id == "us" else "\u7ea2\u5229\u4ef7\u503c",
        "holdings": holdings,
        "score": score_custom_fund(market_id, holdings, stocks, include_backtest=False),
    }


def create_custom_fund(db: dict[str, Any], user_id: str, input_data: dict[str, Any]) -> dict[str, Any]:
    score = score_custom_fund(input_data["marketId"], input_data["holdings"], market_stocks(db, input_data["marketId"]))
    validate_custom_fund(db, input_data, score["totalWeight"])
    now = now_iso()
    fund = {
        "id": f"custom-fund-{uuid.uuid4()}",
        "userId": user_id,
        "marketId": input_data["marketId"],
        "name": input_data["name"],
        "style": input_data["style"],
        "holdings": input_data["holdings"],
        "score": score,
        "version": 1,
        "versions": [{"version": 1, "name": "Initial custom fund", "savedAt": now, "data": input_data}],
        "createdAt": now,
        "updatedAt": now,
    }
    db.setdefault("customFunds", []).insert(0, fund)
    record_audit(db, input_data["marketId"], "custom-fund.create", "customFund", fund["id"], user_id=user_id)
    return fund


def update_custom_fund(db: dict[str, Any], user_id: str, custom_fund_id: str, input_data: dict[str, Any]) -> dict[str, Any]:
    fund = owned_custom_fund(db, user_id, custom_fund_id)
    if input_data["marketId"] != fund.get("marketId"):
        raise FundXApiError("invalid_request", "Custom fund market cannot be changed.", 400)

    next_data = {
        "marketId": fund["marketId"],
        "name": input_data.get("name", fund.get("name")),
        "style": input_data.get("style", fund.get("style")),
        "holdings": input_data.get("holdings", fund.get("holdings") or []),
    }
    score = score_custom_fund(fund["marketId"], next_data["holdings"], market_stocks(db, fund["marketId"]))
    validate_custom_fund(db, next_data, score["totalWeight"])
    fund["name"] = next_data["name"]
    fund["style"] = next_data["style"]
    fund["holdings"] = next_data["holdings"]
    fund["score"] = score
    fund["version"] = int(number_or_zero(fund.get("version"))) + 1
    fund["updatedAt"] = now_iso()
    fund.setdefault("versions", []).append(
        {"version": fund["version"], "name": "Updated custom fund", "savedAt": now_iso(), "data": next_data}
    )
    record_audit(db, fund["marketId"], "custom-fund.update", "customFund", fund["id"], user_id=user_id)
    return fund


def delete_custom_fund(
    db: dict[str, Any],
    user_id: str,
    custom_fund_id: str,
    market_id: MarketId | None,
) -> None:
    fund = owned_custom_fund(db, user_id, custom_fund_id)
    if market_id and fund.get("marketId") != market_id:
        raise FundXApiError("not_found", "Custom fund was not found in the selected market.", 404)
    db["customFunds"] = [item for item in db.get("customFunds", []) if not (item.get("userId") == user_id and item.get("id") == fund.get("id"))]
    record_audit(db, fund["marketId"], "custom-fund.delete", "customFund", fund["id"], user_id=user_id)


def restore_custom_fund_version(
    db: dict[str, Any],
    user_id: str,
    custom_fund_id: str,
    market_id: MarketId,
    version: int,
) -> dict[str, Any]:
    fund = owned_custom_fund(db, user_id, custom_fund_id)
    if fund.get("marketId") != market_id:
        raise FundXApiError("not_found", "Custom fund was not found in the selected market.", 404)
    target = next((item for item in fund.get("versions", []) if item.get("version") == version), None)
    if not target or not isinstance(target.get("data"), dict):
        raise FundXApiError("not_found", "Custom fund version was not found.", 404)

    data = target["data"]
    score = score_custom_fund(fund["marketId"], data.get("holdings") or [], market_stocks(db, fund["marketId"]))
    fund["name"] = data.get("name")
    fund["style"] = data.get("style")
    fund["holdings"] = data.get("holdings") or []
    fund["score"] = score
    fund["version"] = int(number_or_zero(fund.get("version"))) + 1
    fund["updatedAt"] = now_iso()
    fund.setdefault("versions", []).append(
        {"version": fund["version"], "name": f"Restored version {version}", "savedAt": now_iso(), "data": data}
    )
    record_audit(
        db,
        fund["marketId"],
        "custom-fund.restore-version",
        "customFund",
        fund["id"],
        user_id=user_id,
        metadata={"version": version},
    )
    return fund


def score_custom_fund(
    market_id: MarketId,
    holdings: list[dict[str, Any]],
    stock_universe: list[dict[str, Any]],
    *,
    include_backtest: bool = True,
) -> dict[str, Any]:
    stock_by_id = {stock.get("id"): stock for stock in stock_universe}
    selected = [
        {"holding": holding, "stock": stock_by_id.get(holding.get("stockId"))}
        for holding in holdings
    ]
    selected = [
        item
        for item in selected
        if isinstance(item.get("stock"), dict) and item["stock"].get("marketId") == market_id
    ]
    total_weight = sum(number_or_zero(holding.get("weight")) for holding in holdings)
    sector_exposure = calculate_sector_exposure(selected)
    top_weight = max((number_or_zero(holding.get("weight")) for holding in holdings), default=0)
    backtest_history = build_custom_fund_backtest(selected) if include_backtest else []
    drawdown = calculate_drawdown(backtest_history)

    return {
        "totalWeight": round_number(total_weight, 2),
        "peRatio": round_number(weighted_average(selected, "peRatio"), 2),
        "pbRatio": round_number(weighted_average(selected, "pbRatio"), 2),
        "dividendYield": round_number(weighted_average(selected, "dividendYield"), 2),
        "roe": round_number(weighted_average(selected, "roe"), 2),
        "volatility": round_number(weighted_average(selected, "volatility"), 2),
        "valueScore": round_number(weighted_average(selected, "valueScore"), 1),
        "qualityScore": round_number(weighted_average(selected, "qualityScore"), 1),
        "dividendScore": round_number(weighted_average(selected, "dividendYield", transform=lambda value: clamp(value * 18, 0, 100)), 1),
        "riskScore": round_number(weighted_average(selected, "riskScore"), 1),
        "concentrationScore": round_number(clamp(100 - top_weight, 0, 100), 1),
        "sectorExposure": sector_exposure,
        "backtestHistory": backtest_history,
        "maxDrawdown": drawdown["maxDrawdown"],
    }


def calculate_sector_exposure(selected: list[dict[str, Any]]) -> list[dict[str, Any]]:
    total = sum(number_or_zero(item["holding"].get("weight")) for item in selected) or 1
    grouped: dict[str, float] = {}
    for item in selected:
        name = str(item["stock"].get("sector") or "Other")
        grouped[name] = grouped.get(name, 0) + number_or_zero(item["holding"].get("weight")) / total
    return [
        {"name": name, "sector": name, "weight": round_number(weight * 100, 2)}
        for name, weight in sorted(grouped.items(), key=lambda entry: entry[1], reverse=True)
    ]


def build_custom_fund_backtest(selected: list[dict[str, Any]]) -> list[dict[str, Any]]:
    base_history = price_history(selected[0]["stock"]) if selected else []
    history = []
    for index, point in enumerate(base_history):
        value = 0.0
        for item in selected:
            holding = item["holding"]
            stock = item["stock"]
            stock_history = price_history(stock)
            base = history_value(stock_history[0]) if stock_history else number_or_zero(stock.get("price"))
            current = (
                history_value(stock_history[index])
                if index < len(stock_history)
                else history_value(stock_history[-1])
                if stock_history
                else number_or_zero(stock.get("price"))
            )
            value += (number_or_zero(holding.get("weight")) / 100) * 100 * (1 if base == 0 else current / base)
        history.append({"date": point.get("date"), "value": round_number(value, 2)})
    return history


def weighted_average(
    selected: list[dict[str, Any]],
    field: str,
    *,
    transform: Callable[[float], float] | None = None,
) -> float:
    total_weight = sum(number_or_zero(item["holding"].get("weight")) for item in selected)
    if total_weight == 0:
        return 0
    total = 0.0
    for item in selected:
        value = number_or_zero(item["stock"].get(field))
        if transform:
            value = transform(value)
        total += value * number_or_zero(item["holding"].get("weight"))
    return total / total_weight


def validate_custom_fund(db: dict[str, Any], input_data: dict[str, Any], total_weight: float) -> None:
    valid_stock_ids = {stock.get("id") for stock in market_stocks(db, input_data["marketId"])}
    if any(holding.get("stockId") not in valid_stock_ids for holding in input_data["holdings"]):
        raise FundXApiError("invalid_request", "Custom fund contains assets outside the selected market.", 400)
    if abs(total_weight - 100) > 0.01:
        raise FundXApiError("invalid_request", f"Custom fund weights must sum to 100%. Current total is {total_weight}%.", 400)


def market_stocks(db: dict[str, Any], market_id: MarketId) -> list[dict[str, Any]]:
    return list_custom_fund_universe(db, market_id, include_history=True)


def real_stock_history(
    db: dict[str, Any],
    market_id: MarketId,
    stock_id: str,
    history_index: dict[tuple[str, str], list[dict[str, Any]]] | None = None,
) -> list[dict[str, Any]]:
    if history_index is not None:
        return list(history_index.get((stock_id, "stock"), []))
    points = sorted(
        (
            point
            for point in db.get("dailyPrices", [])
            if point.get("marketId") == market_id
            and point.get("assetId") == stock_id
            and point.get("assetType") == "stock"
            and isinstance(point.get("close"), (int, float))
        ),
        key=lambda point: str(point.get("date") or ""),
    )
    return [{"date": point.get("date"), "value": point.get("close")} for point in points]


def owned_custom_fund(db: dict[str, Any], user_id: str, custom_fund_id: str) -> dict[str, Any]:
    fund = next(
        (
            item
            for item in db.get("customFunds", [])
            if item.get("userId") == user_id and item.get("id") == custom_fund_id
        ),
        None,
    )
    if not fund:
        raise FundXApiError("not_found", "Custom fund was not found.", 404)
    return fund


async def read_json_body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception as exc:
        raise FundXApiError("invalid_json", "Request body must be valid JSON.", 400) from exc
    if not isinstance(body, dict):
        raise validation_error("Request body must be a JSON object.")
    return body


def parse_custom_fund_save_body(body: dict[str, Any]) -> dict[str, Any]:
    return {
        "marketId": require_market_id(body.get("marketId")),
        "name": require_string(body.get("name"), "name", max_length=80),
        "style": require_string(body.get("style"), "style", max_length=60),
        "holdings": require_holdings(body.get("holdings")),
    }


def parse_custom_fund_update_body(body: dict[str, Any]) -> dict[str, Any]:
    input_data = {
        "id": require_string(body.get("id"), "id", max_length=160),
        "marketId": require_market_id(body.get("marketId")),
    }
    if "name" in body:
        input_data["name"] = require_string(body.get("name"), "name", max_length=80)
    if "style" in body:
        input_data["style"] = require_string(body.get("style"), "style", max_length=60)
    if "holdings" in body:
        input_data["holdings"] = require_holdings(body.get("holdings"))
    return input_data


def parse_custom_fund_restore_body(body: dict[str, Any]) -> dict[str, Any]:
    return {
        "action": "restore-version",
        "id": require_string(body.get("id"), "id", max_length=160),
        "marketId": require_market_id(body.get("marketId")),
        "version": require_positive_int(body.get("version"), "version"),
    }


def require_holdings(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not value:
        raise validation_error("holdings must contain at least one item.")
    return [require_holding(item, index) for index, item in enumerate(value)]


def require_holding(value: Any, index: int) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise validation_error(f"holdings[{index}] must be an object.")
    holding = {
        "stockId": require_string(value.get("stockId"), f"holdings[{index}].stockId", max_length=160),
        "weight": require_number(value.get("weight"), f"holdings[{index}].weight", minimum=0, maximum=100),
    }
    if "locked" in value:
        if not isinstance(value.get("locked"), bool):
            raise validation_error(f"holdings[{index}].locked must be a boolean.")
        holding["locked"] = value["locked"]
    return holding


def require_market_id(value: Any) -> MarketId:
    if value == "us":
        return value
    raise invalid_market()


def assert_query_market_matches(request: Request, market_id: MarketId) -> None:
    if request.query_params.get("market") and parse_market(request.query_params.get("market")) != market_id:
        raise FundXApiError("market_mismatch", "Request query market and body marketId must match.", 400)


def require_string(value: Any, field: str, *, max_length: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise validation_error(f"{field} is required.")
    stripped = value.strip()
    if len(stripped) > max_length:
        raise validation_error(f"{field} must contain at most {max_length} characters.")
    return stripped


def require_number(value: Any, field: str, *, minimum: float, maximum: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise validation_error(f"{field} must be a number.") from exc
    if number < minimum:
        raise validation_error(f"{field} must be greater than or equal to {minimum}.")
    if number > maximum:
        raise validation_error(f"{field} must be less than or equal to {maximum}.")
    return round_number(number, 4)


def require_positive_int(value: Any, field: str) -> int:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise validation_error(f"{field} must be an integer.") from exc
    if not number.is_integer():
        raise validation_error(f"{field} must be an integer.")
    parsed = int(number)
    if parsed <= 0:
        raise validation_error(f"{field} must be greater than 0.")
    return parsed


def update_db(mutator: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
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
    for key in ("stocks", "customFunds", "auditEvents"):
        db.setdefault(key, [])


def record_audit(
    db: dict[str, Any],
    market_id: MarketId,
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
            **({"metadata": metadata} if metadata else {}),
            "createdAt": now_iso(),
        },
    )
    db["auditEvents"] = db["auditEvents"][:1000]


def price_history(stock: dict[str, Any]) -> list[dict[str, Any]]:
    history = stock.get("priceHistory")
    return history if isinstance(history, list) else []


def history_value(point: Any) -> float:
    return number_or_zero(point.get("value") if isinstance(point, dict) else None)


def clamp(value: float, minimum: float, maximum: float) -> float:
    return min(max(value, minimum), maximum)
