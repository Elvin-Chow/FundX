from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from .auth import current_user_id
from .errors import FundXApiError, validation_error
from .portfolio_read import build_portfolio_summary, get_portfolios
from .services import (
    LOCAL_USER_ID,
    MARKET_CONFIGS,
    MarketId,
    clone_json,
    create_id,
    custom_fund_to_asset,
    get_market_data_meta,
    is_public_market_asset,
    normalize_asset_record,
    normalize_asset_type,
    now_iso,
    number_or_zero,
    parse_market,
    read_db,
    record_audit,
    round_number,
    set_cached_value,
    update_db,
)

router = APIRouter()


@router.get("/api/portfolios")
def list_portfolios_route(request: Request) -> dict[str, Any]:
    return get_portfolios(request)


@router.post("/api/portfolios", status_code=201)
async def portfolio_action_route(request: Request) -> dict[str, Any]:
    body = await read_json_body(request)
    action = body.get("action") if isinstance(body.get("action"), str) else "snapshot"
    user_id = current_user_id(request)
    if action == "create":
        market_id = parse_market(str(body.get("marketId") or ""))
        assert_query_market_matches(request, market_id)
        portfolio = create_portfolio(
            user_id,
            market_id,
            require_string(body.get("name"), "name", max_length=120),
            optional_string(body.get("goal"), "goal", max_length=240) or "Long-term value investing portfolio",
            optional_string(body.get("riskPreference"), "riskPreference", max_length=80) or "Balanced",
            optional_number(body.get("cashBalance"), "cashBalance") or 0,
            optional_number(body.get("capital"), "capital"),
            optional_string(body.get("startDate"), "startDate", max_length=20),
            optional_string(body.get("endDate"), "endDate", max_length=20),
            optional_dict(body.get("dcaPlans")),
            optional_list(body.get("valueHistory")),
            optional_list(body.get("contributionHistory")),
        )
        return {"ok": True, **get_market_data_meta(read_db(), market_id), "message": "Portfolio created.", "portfolio": portfolio}

    if action == "set-active":
        market_id = parse_market(str(body.get("marketId") or ""))
        assert_query_market_matches(request, market_id)
        portfolio = set_active_portfolio(user_id, market_id, require_string(body.get("portfolioId"), "portfolioId", max_length=120))
        return {"ok": True, **get_market_data_meta(read_db(), market_id), "message": "Active portfolio saved.", "portfolio": portfolio}

    if action == "rebalance":
        market_id = parse_market(str(body.get("marketId") or ""))
        assert_query_market_matches(request, market_id)
        portfolio_id = require_string(body.get("portfolioId"), "portfolioId", max_length=120)
        suggestion = generate_rebalance_suggestion(user_id, market_id, portfolio_id)
        return {"ok": True, **get_market_data_meta(read_db(), market_id), "message": "Rebalance suggestion generated.", "suggestion": suggestion}

    market_id = parse_market(str(body.get("marketId") or ""))
    assert_query_market_matches(request, market_id)
    portfolio_id = require_string(body.get("portfolioId"), "portfolioId", max_length=120)
    snapshot = save_portfolio_snapshot(user_id, market_id, portfolio_id, optional_string(body.get("note"), "note", max_length=400) or "")
    return {"ok": True, **get_market_data_meta(read_db(), market_id), "message": "Portfolio snapshot saved.", "snapshot": snapshot}


@router.get("/api/portfolios/{portfolio_id}")
def get_portfolio_route(portfolio_id: str, request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    user_id = current_user_id(request)
    db = read_db()
    portfolio = owned_portfolio(db, user_id, portfolio_id, market_id)
    summary = build_portfolio_summary(
        portfolio,
        db,
        start_date=str(portfolio.get("startDate") or "") or None,
        end_date=str(portfolio.get("endDate") or "") or None,
    )
    return {
        "marketId": market_id,
        "portfolio": portfolio,
        "summary": summary,
        "cached": False,
        "versions": list_portfolio_versions(db, user_id, portfolio_id, market_id),
        "rebalanceSuggestions": list_rebalance_suggestions(db, user_id, portfolio_id, market_id),
        "snapshots": list_portfolio_snapshots(db, user_id, portfolio_id, market_id),
        "transactions": list_transactions(db, user_id, portfolio_id, market_id),
        "cashMovements": list_cash_movements(db, user_id, portfolio_id, market_id),
    }


@router.patch("/api/portfolios/{portfolio_id}")
async def patch_portfolio_route(portfolio_id: str, request: Request) -> dict[str, Any]:
    body = await read_json_body(request)
    market_id = parse_market(str(body.get("marketId") or request.query_params.get("market") or ""))
    assert_query_market_matches(request, market_id)
    user_id = current_user_id(request)
    action = body.get("action")
    if action == "restore-version":
        portfolio = restore_portfolio_version(user_id, market_id, portfolio_id, require_positive_int(body.get("version"), "version"))
        return {"ok": True, **get_market_data_meta(read_db(), market_id), "message": "Portfolio version restored.", "portfolio": portfolio}
    if action not in (None, "update"):
        raise validation_error("action must be one of: update, restore-version.")
    updates = {
        key: value
        for key, value in {
            "name": optional_string(body.get("name"), "name", max_length=120) if "name" in body else None,
            "goal": optional_string(body.get("goal"), "goal", max_length=240) if "goal" in body else None,
            "riskPreference": optional_string(body.get("riskPreference"), "riskPreference", max_length=80) if "riskPreference" in body else None,
            "cashBalance": optional_number(body.get("cashBalance"), "cashBalance") if "cashBalance" in body else None,
            "capital": optional_number(body.get("capital"), "capital") if "capital" in body else None,
            "startDate": optional_string(body.get("startDate"), "startDate", max_length=20) if "startDate" in body else None,
            "endDate": optional_string(body.get("endDate"), "endDate", max_length=20) if "endDate" in body else None,
            "dcaPlans": optional_dict(body.get("dcaPlans")) if "dcaPlans" in body else None,
            "valueHistory": optional_list(body.get("valueHistory")) if "valueHistory" in body else None,
            "contributionHistory": optional_list(body.get("contributionHistory")) if "contributionHistory" in body else None,
        }.items()
        if value is not None
    }
    portfolio = update_portfolio(user_id, market_id, portfolio_id, updates)
    return {"ok": True, **get_market_data_meta(read_db(), market_id), "message": "Portfolio updated.", "portfolio": portfolio}


@router.delete("/api/portfolios/{portfolio_id}")
def delete_portfolio_route(portfolio_id: str, request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market")) if request.query_params.get("market") else None
    removed = delete_portfolio(current_user_id(request), portfolio_id, market_id)
    return {"ok": True, "portfolioId": removed.get("id", portfolio_id)}


@router.get("/api/portfolios/{portfolio_id}/holdings")
def list_holdings_route(portfolio_id: str, request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    portfolio = owned_portfolio(read_db(), current_user_id(request), portfolio_id, market_id)
    return {"marketId": market_id, "portfolioId": portfolio_id, "holdings": portfolio.get("holdings", [])}


@router.post("/api/portfolios/{portfolio_id}/holdings", status_code=201)
async def upsert_holding_route(portfolio_id: str, request: Request) -> dict[str, Any]:
    body = await read_json_body(request)
    market_id = parse_market(str(body.get("marketId") or request.query_params.get("market") or ""))
    assert_query_market_matches(request, market_id)
    if str(body.get("portfolioId") or portfolio_id) != portfolio_id:
        raise FundXApiError("market_mismatch", "Request portfolioId and route portfolio id must match.", 400)
    holding = upsert_holding(
        current_user_id(request),
        market_id,
        portfolio_id,
        require_string(body.get("assetId"), "assetId", max_length=120),
        normalize_request_asset_type(require_string(body.get("assetType"), "assetType", max_length=40)),
        require_non_negative_number(body.get("quantity"), "quantity"),
        require_non_negative_number(body.get("averageCost"), "averageCost"),
        require_non_negative_number(body.get("targetWeight"), "targetWeight"),
        optional_number(body.get("currentPrice"), "currentPrice"),
    )
    return {"ok": True, "marketId": market_id, "portfolioId": portfolio_id, "holding": holding}


@router.delete("/api/portfolios/{portfolio_id}/holdings")
def delete_holding_route(portfolio_id: str, request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    holding_id = request.query_params.get("holdingId") or request.query_params.get("id")
    if not holding_id:
        raise FundXApiError("invalid_request", "holdingId query parameter is required.", 400)
    delete_holding(current_user_id(request), market_id, portfolio_id, holding_id)
    return {"ok": True, "holdingId": holding_id}


@router.get("/api/portfolios/{portfolio_id}/transactions")
def list_transactions_route(portfolio_id: str, request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    user_id = current_user_id(request)
    db = read_db()
    owned_portfolio(db, user_id, portfolio_id, market_id)
    return {"marketId": market_id, "portfolioId": portfolio_id, "transactions": list_transactions(db, user_id, portfolio_id, market_id)}


@router.post("/api/portfolios/{portfolio_id}/transactions", status_code=201)
async def record_transaction_route(portfolio_id: str, request: Request) -> dict[str, Any]:
    body = await read_json_body(request)
    market_id = parse_market(str(body.get("marketId") or request.query_params.get("market") or ""))
    assert_query_market_matches(request, market_id)
    transaction = record_transaction(
        current_user_id(request),
        market_id,
        portfolio_id,
        require_string(body.get("assetId"), "assetId", max_length=120),
        normalize_request_asset_type(require_string(body.get("assetType"), "assetType", max_length=40)),
        require_choice(body.get("side"), "side", {"buy", "sell"}),
        require_positive_number(body.get("quantity"), "quantity"),
        require_non_negative_number(body.get("price"), "price"),
        require_non_negative_number(body.get("fee"), "fee"),
        require_string(body.get("tradeDate"), "tradeDate", max_length=20),
        optional_string(body.get("note"), "note", max_length=400) or "",
    )
    return {"ok": True, "marketId": market_id, "portfolioId": portfolio_id, "transaction": transaction}


@router.get("/api/portfolios/{portfolio_id}/cash-movements")
def list_cash_movements_route(portfolio_id: str, request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    user_id = current_user_id(request)
    db = read_db()
    owned_portfolio(db, user_id, portfolio_id, market_id)
    return {"marketId": market_id, "portfolioId": portfolio_id, "cashMovements": list_cash_movements(db, user_id, portfolio_id, market_id)}


@router.post("/api/portfolios/{portfolio_id}/cash-movements", status_code=201)
async def record_cash_movement_route(portfolio_id: str, request: Request) -> dict[str, Any]:
    body = await read_json_body(request)
    market_id = parse_market(str(body.get("marketId") or request.query_params.get("market") or ""))
    assert_query_market_matches(request, market_id)
    movement = record_cash_movement(
        current_user_id(request),
        market_id,
        portfolio_id,
        require_choice(body.get("type"), "type", {"deposit", "withdrawal", "dividend", "fee", "interest", "adjustment"}),
        require_number(body.get("amount"), "amount"),
        require_string(body.get("date"), "date", max_length=20),
        optional_string(body.get("note"), "note", max_length=400) or "",
    )
    return {"ok": True, "marketId": market_id, "portfolioId": portfolio_id, "cashMovement": movement}


@router.post("/api/portfolios/{portfolio_id}/snapshots", status_code=201)
async def save_snapshot_route(portfolio_id: str, request: Request) -> dict[str, Any]:
    body = await read_json_body(request)
    market_id = parse_market(str(body.get("marketId") or request.query_params.get("market") or ""))
    assert_query_market_matches(request, market_id)
    snapshot = save_portfolio_snapshot(current_user_id(request), market_id, portfolio_id, optional_string(body.get("note"), "note", max_length=400) or "")
    return {"ok": True, **get_market_data_meta(read_db(), market_id), "message": "Portfolio snapshot saved.", "snapshot": snapshot}


async def read_json_body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception as exc:
        raise FundXApiError("invalid_json", "Request body must be valid JSON.", 400) from exc
    if not isinstance(body, dict):
        raise validation_error("Request body must be a JSON object.")
    return body


def create_portfolio(
    user_id: str,
    market_id: MarketId,
    name: str,
    goal: str,
    risk_preference: str,
    cash_balance: float,
    capital: float | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    dca_plans: dict[str, Any] | None = None,
    value_history: list[Any] | None = None,
    contribution_history: list[Any] | None = None,
) -> dict[str, Any]:
    saved: dict[str, Any] = {}

    def mutate(db: dict[str, Any]) -> None:
        now = now_iso()
        portfolio = {
            "id": create_id("portfolio"),
            "userId": user_id,
            "marketId": market_id,
            "name": name,
            "currency": MARKET_CONFIGS[market_id]["currency"],
            "goal": goal,
            "riskPreference": risk_preference,
            "cashBalance": cash_balance,
            "capital": capital,
            "startDate": start_date,
            "endDate": end_date,
            "dcaPlans": dca_plans or {},
            "valueHistory": value_history or [],
            "contributionHistory": contribution_history or [],
            "createdAt": now,
            "updatedAt": now,
            "holdings": [],
        }
        db.setdefault("portfolios", []).append(portfolio)
        save_portfolio_version_record(db, portfolio, "Created portfolio")
        record_audit(db, market_id, "portfolio.create", "portfolio", portfolio["id"], user_id=user_id)
        saved.update(clone_json(portfolio))

    update_db(mutate)
    return saved


def set_active_portfolio(user_id: str, market_id: MarketId, portfolio_id: str) -> dict[str, Any]:
    saved: dict[str, Any] = {}

    def mutate(db: dict[str, Any]) -> None:
        portfolio = owned_portfolio(db, user_id, portfolio_id, market_id)
        user = get_or_create_user(db, user_id)
        preferences = user.setdefault("preferences", {})
        active = preferences.setdefault("activePortfolioByMarket", {})
        active[market_id] = portfolio_id
        user["updatedAt"] = now_iso()
        record_audit(db, market_id, "portfolio.set-active", "portfolio", portfolio_id, user_id=user_id)
        saved.update(clone_json(portfolio))

    update_db(mutate)
    return saved


def update_portfolio(user_id: str, market_id: MarketId, portfolio_id: str, updates: dict[str, Any]) -> dict[str, Any]:
    saved: dict[str, Any] = {}

    def mutate(db: dict[str, Any]) -> None:
        portfolio = owned_portfolio(db, user_id, portfolio_id, market_id)
        portfolio.update(updates)
        portfolio["updatedAt"] = now_iso()
        save_portfolio_version_record(db, portfolio, "Updated portfolio config")
        record_audit(db, market_id, "portfolio.update", "portfolio", portfolio_id, user_id=user_id)
        saved.update(clone_json(portfolio))

    update_db(mutate)
    return saved


def delete_portfolio(user_id: str, portfolio_id: str, market_id: MarketId | None) -> dict[str, Any]:
    removed: dict[str, Any] = {}

    def mutate(db: dict[str, Any]) -> None:
        portfolio = owned_portfolio(db, user_id, portfolio_id, market_id)
        db["portfolios"] = [item for item in db.get("portfolios", []) if not (item.get("userId") == user_id and item.get("id") == portfolio_id)]
        db["transactions"] = [item for item in db.get("transactions", []) if not (item.get("userId") == user_id and item.get("portfolioId") == portfolio_id)]
        db["cashMovements"] = [item for item in db.get("cashMovements", []) if not (item.get("userId") == user_id and item.get("portfolioId") == portfolio_id)]
        db["portfolioVersions"] = [item for item in db.get("portfolioVersions", []) if not (item.get("userId") == user_id and item.get("portfolioId") == portfolio_id)]
        db["portfolioSnapshots"] = [item for item in db.get("portfolioSnapshots", []) if not (item.get("userId") == user_id and item.get("portfolioId") == portfolio_id)]
        db["rebalanceSuggestions"] = [item for item in db.get("rebalanceSuggestions", []) if not (item.get("userId") == user_id and item.get("portfolioId") == portfolio_id)]
        record_audit(db, portfolio.get("marketId"), "portfolio.delete", "portfolio", portfolio_id, user_id=user_id)
        removed.update(clone_json(portfolio))

    update_db(mutate)
    return removed


def restore_portfolio_version(user_id: str, market_id: MarketId, portfolio_id: str, version: int) -> dict[str, Any]:
    saved: dict[str, Any] = {}

    def mutate(db: dict[str, Any]) -> None:
        target = next(
            (
                item
                for item in db.get("portfolioVersions", [])
                if item.get("userId") == user_id
                and item.get("portfolioId") == portfolio_id
                and item.get("marketId") == market_id
                and item.get("version") == version
            ),
            None,
        )
        if not target:
            raise FundXApiError("not_found", "Portfolio version was not found.", 404)
        index = next((idx for idx, item in enumerate(db.get("portfolios", [])) if item.get("userId") == user_id and item.get("id") == portfolio_id), -1)
        if index < 0:
            raise FundXApiError("not_found", "Portfolio was not found.", 404)
        restored = {**clone_json(target.get("data") or {}), "updatedAt": now_iso()}
        db["portfolios"][index] = restored
        save_portfolio_version_record(db, restored, f"Restored version {version}")
        record_audit(db, market_id, "portfolio.restore-version", "portfolio", portfolio_id, user_id=user_id, metadata={"version": version})
        saved.update(clone_json(restored))

    update_db(mutate)
    return saved


def upsert_holding(
    user_id: str,
    market_id: MarketId,
    portfolio_id: str,
    asset_id: str,
    asset_type: str,
    quantity: float,
    average_cost: float,
    target_weight: float,
    current_price: float | None = None,
) -> dict[str, Any]:
    saved: dict[str, Any] = {}

    def mutate(db: dict[str, Any]) -> None:
        portfolio = owned_portfolio(db, user_id, portfolio_id, market_id)
        asset = resolve_owned_asset(db, user_id, market_id, asset_id, asset_type)
        price = round_number(current_price, 4) if current_price is not None and current_price > 0 else require_latest_price(asset, fallback_price=average_cost)
        holdings = portfolio.setdefault("holdings", [])
        existing = next((item for item in holdings if item.get("assetId") == asset_id and normalize_asset_type(item.get("assetType")) == normalize_asset_type(asset_type)), None)
        now = now_iso()
        holding = {
            "id": existing.get("id") if existing else create_id("holding"),
            "portfolioId": portfolio_id,
            "assetId": asset_id,
            "assetType": normalize_asset_type(asset_type),
            "marketId": market_id,
            "name": asset.get("name"),
            "symbol": asset.get("symbol"),
            "quantity": quantity,
            "averageCost": average_cost,
            "currentPrice": price,
            "targetWeight": target_weight,
            "sector": asset.get("sector") or asset.get("industry") or "Other",
            "createdAt": existing.get("createdAt") if existing else now,
            "updatedAt": now,
        }
        if existing:
            existing.update(holding)
        else:
            holdings.append(holding)
        portfolio["updatedAt"] = now
        save_portfolio_version_record(db, portfolio, "Updated holdings")
        record_audit(db, market_id, "holding.upsert", "holding", holding["id"], user_id=user_id)
        saved.update(clone_json(holding))

    update_db(mutate)
    return saved


def delete_holding(user_id: str, market_id: MarketId, portfolio_id: str, holding_id: str) -> None:
    def mutate(db: dict[str, Any]) -> None:
        portfolio = owned_portfolio(db, user_id, portfolio_id, market_id)
        before = len(portfolio.get("holdings", []))
        portfolio["holdings"] = [item for item in portfolio.get("holdings", []) if item.get("id") != holding_id]
        if len(portfolio["holdings"]) == before:
            raise FundXApiError("not_found", "Holding was not found.", 404)
        portfolio["updatedAt"] = now_iso()
        save_portfolio_version_record(db, portfolio, "Deleted holding")
        record_audit(db, market_id, "holding.delete", "holding", holding_id, user_id=user_id)

    update_db(mutate)


def record_transaction(
    user_id: str,
    market_id: MarketId,
    portfolio_id: str,
    asset_id: str,
    asset_type: str,
    side: str,
    quantity: float,
    price: float,
    fee: float,
    trade_date: str,
    note: str,
) -> dict[str, Any]:
    saved: dict[str, Any] = {}

    def mutate(db: dict[str, Any]) -> None:
        portfolio = owned_portfolio(db, user_id, portfolio_id, market_id)
        asset = resolve_owned_asset(db, user_id, market_id, asset_id, asset_type)
        current_price = require_latest_price(asset)
        holdings = portfolio.setdefault("holdings", [])
        existing = next((item for item in holdings if item.get("assetId") == asset_id), None)
        signed_quantity = quantity if side == "buy" else -quantity
        if existing:
            old_cost = number_or_zero(existing.get("averageCost")) * number_or_zero(existing.get("quantity"))
            next_quantity = max(0, number_or_zero(existing.get("quantity")) + signed_quantity)
            existing["quantity"] = next_quantity
            if side == "buy" and next_quantity > 0:
                existing["averageCost"] = round_number((old_cost + quantity * price + fee) / next_quantity, 4)
            existing["currentPrice"] = current_price
            existing["updatedAt"] = now_iso()
        elif side == "buy":
            holdings.append(
                {
                    "id": create_id("holding"),
                    "portfolioId": portfolio_id,
                    "assetId": asset_id,
                    "assetType": normalize_asset_type(asset_type),
                    "marketId": market_id,
                    "name": asset.get("name"),
                    "symbol": asset.get("symbol"),
                    "quantity": quantity,
                    "averageCost": price,
                    "currentPrice": current_price,
                    "targetWeight": 0,
                    "sector": asset.get("sector") or asset.get("industry") or "Other",
                    "createdAt": now_iso(),
                    "updatedAt": now_iso(),
                }
            )
        gross = quantity * price + fee
        portfolio["cashBalance"] = number_or_zero(portfolio.get("cashBalance")) + (-gross if side == "buy" else quantity * price - fee)
        portfolio["updatedAt"] = now_iso()
        transaction = {
            "id": create_id("txn"),
            "userId": user_id,
            "portfolioId": portfolio_id,
            "marketId": market_id,
            "assetId": asset_id,
            "assetType": normalize_asset_type(asset_type),
            "side": side,
            "quantity": quantity,
            "price": price,
            "fee": fee,
            "tradeDate": trade_date,
            "note": note,
            "createdAt": now_iso(),
        }
        db.setdefault("transactions", []).insert(0, transaction)
        save_portfolio_version_record(db, portfolio, f"Recorded {side}")
        record_audit(db, market_id, f"transaction.{side}", "transaction", transaction["id"], user_id=user_id)
        saved.update(clone_json(transaction))

    update_db(mutate)
    return saved


def record_cash_movement(user_id: str, market_id: MarketId, portfolio_id: str, movement_type: str, amount: float, movement_date: str, note: str) -> dict[str, Any]:
    saved: dict[str, Any] = {}

    def mutate(db: dict[str, Any]) -> None:
        portfolio = owned_portfolio(db, user_id, portfolio_id, market_id)
        movement = {
            "id": create_id("cash"),
            "userId": user_id,
            "portfolioId": portfolio_id,
            "marketId": market_id,
            "type": movement_type,
            "amount": amount,
            "date": movement_date,
            "note": note,
            "createdAt": now_iso(),
        }
        portfolio["cashBalance"] = number_or_zero(portfolio.get("cashBalance")) + amount
        portfolio["updatedAt"] = now_iso()
        db.setdefault("cashMovements", []).insert(0, movement)
        record_audit(db, market_id, "cash-movement.record", "cashMovement", movement["id"], user_id=user_id)
        saved.update(clone_json(movement))

    update_db(mutate)
    return saved


def save_portfolio_snapshot(user_id: str, market_id: MarketId, portfolio_id: str, note: str) -> dict[str, Any]:
    saved: dict[str, Any] = {}

    def mutate(db: dict[str, Any]) -> None:
        portfolio = owned_portfolio(db, user_id, portfolio_id, market_id)
        snapshot = {
            "id": create_id("snapshot"),
            "userId": user_id,
            "portfolioId": portfolio_id,
            "marketId": market_id,
            "note": note,
            "summary": build_portfolio_summary(portfolio),
            "createdAt": now_iso(),
        }
        db.setdefault("portfolioSnapshots", []).insert(0, snapshot)
        record_audit(db, market_id, "portfolio.snapshot", "portfolioSnapshot", snapshot["id"], user_id=user_id)
        saved.update(clone_json(snapshot))

    update_db(mutate)
    return saved


def generate_rebalance_suggestion(user_id: str, market_id: MarketId, portfolio_id: str) -> dict[str, Any]:
    saved: dict[str, Any] = {}

    def mutate(db: dict[str, Any]) -> None:
        portfolio = owned_portfolio(db, user_id, portfolio_id, market_id)
        summary = build_portfolio_summary(portfolio)
        trades = []
        for holding in summary.get("holdings", []):
            target_weight = normalize_target(number_or_zero(holding.get("targetWeight")))
            current_weight = number_or_zero(holding.get("currentWeight"))
            gap = target_weight - current_weight
            amount = (gap / 100) * number_or_zero(summary.get("totalValue"))
            current_price = number_or_zero(holding.get("currentPrice"))
            trades.append(
                {
                    "holdingId": holding.get("id"),
                    "assetId": holding.get("assetId"),
                    "symbol": holding.get("symbol"),
                    "action": "hold" if abs(gap) < 1 else "buy" if gap > 0 else "sell",
                    "currentWeight": current_weight,
                    "targetWeight": target_weight,
                    "gap": round_number(gap, 2),
                    "amount": round_number(amount, 2),
                    "quantity": round_number(abs(amount) / current_price, 4) if current_price else 0,
                }
            )
        suggestion = {
            "id": create_id("rebalance"),
            "userId": user_id,
            "portfolioId": portfolio_id,
            "marketId": market_id,
            "generatedAt": now_iso(),
            "trades": trades,
            "summary": {
                "driftScore": round_number(sum(abs(number_or_zero(trade.get("gap"))) for trade in trades), 2),
                "cashAfter": portfolio.get("cashBalance"),
                "turnover": round_number(sum(abs(number_or_zero(trade.get("amount"))) for trade in trades), 2),
            },
        }
        db.setdefault("rebalanceSuggestions", []).insert(0, suggestion)
        set_cached_value(db, f"analytics:portfolio:{portfolio_id}:{portfolio.get('updatedAt')}", summary, 600)
        record_audit(db, market_id, "rebalance.generate", "rebalanceSuggestion", suggestion["id"], user_id=user_id)
        saved.update(clone_json(suggestion))

    update_db(mutate)
    return saved


def owned_portfolio(db: dict[str, Any], user_id: str, portfolio_id: str, market_id: MarketId | None = None) -> dict[str, Any]:
    portfolio = next(
        (
            item
            for item in db.get("portfolios", [])
            if item.get("userId") == user_id
            and item.get("id") == portfolio_id
            and (market_id is None or item.get("marketId") == market_id)
        ),
        None,
    )
    if not portfolio:
        raise FundXApiError("not_found", "Portfolio was not found in the selected market.", 404)
    return portfolio


def resolve_owned_asset(db: dict[str, Any], user_id: str, market_id: MarketId, asset_id: str, asset_type: str) -> dict[str, Any]:
    if asset_type == "customFund":
        custom_fund = next(
            (item for item in db.get("customFunds", []) if item.get("userId") == user_id and item.get("marketId") == market_id and item.get("id") == asset_id),
            None,
        )
        if not custom_fund:
            raise FundXApiError("not_found", "Custom fund was not found in the selected market.", 404)
        return custom_fund_to_asset(custom_fund)
    normalized = normalize_asset_type(asset_type)
    asset = next(
        (
            normalize_asset_record(item)
            for item in db.get("assets", [])
            if item.get("marketId") == market_id
            and item.get("id") == asset_id
            and normalize_asset_type(item.get("assetType")) == normalized
            and asset_visible_to_user(item, user_id)
            and is_public_market_asset(item)
        ),
        None,
    )
    if not asset:
        raise FundXApiError("not_found", "Asset was not found in the selected market.", 404)
    return asset


def require_latest_price(asset: dict[str, Any], fallback_price: float | None = None) -> float:
    latest_price = asset.get("latestPrice")
    if asset.get("quoteStatus") == "fresh" and isinstance(latest_price, (int, float)) and latest_price > 0:
        return round_number(float(latest_price), 4)
    if fallback_price is not None and fallback_price > 0:
        return round_number(float(fallback_price), 4)
    if isinstance(latest_price, (int, float)) and latest_price > 0:
        return round_number(float(latest_price), 4)
    else:
        raise FundXApiError("invalid_request", "Asset has no refreshed real quote. Refresh this asset before using it in a priced workflow.", 400)


def asset_visible_to_user(asset: dict[str, Any], user_id: str) -> bool:
    if asset.get("assetType") != "customAsset":
        return True
    return (asset.get("userId") or LOCAL_USER_ID) == user_id


def save_portfolio_version_record(db: dict[str, Any], portfolio: dict[str, Any], name: str) -> None:
    user_id = str(portfolio.get("userId") or LOCAL_USER_ID)
    existing = [item for item in db.get("portfolioVersions", []) if item.get("userId") == user_id and item.get("portfolioId") == portfolio.get("id")]
    version = max((int(item.get("version") or 0) for item in existing), default=0) + 1
    db.setdefault("portfolioVersions", []).append(
        {
            "id": create_id("portfolio-version"),
            "userId": user_id,
            "portfolioId": portfolio.get("id"),
            "marketId": portfolio.get("marketId"),
            "version": version,
            "name": name,
            "savedAt": now_iso(),
            "data": clone_json(portfolio),
        }
    )


def list_portfolio_versions(db: dict[str, Any], user_id: str, portfolio_id: str, market_id: MarketId) -> list[dict[str, Any]]:
    return [
        item
        for item in db.get("portfolioVersions", [])
        if item.get("userId") == user_id and item.get("portfolioId") == portfolio_id and item.get("marketId") == market_id
    ]


def list_rebalance_suggestions(db: dict[str, Any], user_id: str, portfolio_id: str, market_id: MarketId) -> list[dict[str, Any]]:
    return [
        item
        for item in db.get("rebalanceSuggestions", [])
        if item.get("userId") == user_id and item.get("portfolioId") == portfolio_id and item.get("marketId") == market_id
    ]


def list_portfolio_snapshots(db: dict[str, Any], user_id: str, portfolio_id: str, market_id: MarketId) -> list[dict[str, Any]]:
    return [
        item
        for item in db.get("portfolioSnapshots", [])
        if item.get("userId") == user_id and item.get("portfolioId") == portfolio_id and item.get("marketId") == market_id
    ]


def list_transactions(db: dict[str, Any], user_id: str, portfolio_id: str, market_id: MarketId) -> list[dict[str, Any]]:
    return [
        item
        for item in db.get("transactions", [])
        if item.get("userId") == user_id and item.get("portfolioId") == portfolio_id and item.get("marketId") == market_id
    ]


def list_cash_movements(db: dict[str, Any], user_id: str, portfolio_id: str, market_id: MarketId) -> list[dict[str, Any]]:
    return [
        item
        for item in db.get("cashMovements", [])
        if item.get("userId") == user_id and item.get("portfolioId") == portfolio_id and item.get("marketId") == market_id
    ]


def get_or_create_user(db: dict[str, Any], user_id: str) -> dict[str, Any]:
    user = next((item for item in db.get("users", []) if item.get("id") == user_id), None)
    if user:
        return user
    now = now_iso()
    user = {
        "id": user_id,
        "email": "local@fundx.dev" if user_id == LOCAL_USER_ID else f"{user_id}@fundx.local",
        "name": "Local User" if user_id == LOCAL_USER_ID else user_id,
        "defaultMarket": "us",
        "preferences": {"defaultMarket": "us", "watchlistGroups": ["Ideas"], "riskFreeRate": 3, "benchmarkByMarket": {"us": "S&P 500"}, "activePortfolioByMarket": {}},
        "createdAt": now,
        "updatedAt": now,
    }
    db.setdefault("users", []).append(user)
    return user


def assert_query_market_matches(request: Request, market_id: MarketId) -> None:
    if request.query_params.get("market") and parse_market(request.query_params.get("market")) != market_id:
        raise FundXApiError("market_mismatch", "Request query market and body marketId must match.", 400)


def normalize_request_asset_type(value: str) -> str:
    if value not in {"fund", "stock", "etf", "customFund", "customAsset"}:
        raise validation_error("assetType must be one of: fund, stock, etf, customFund, customAsset.")
    return value


def normalize_target(value: float) -> float:
    return round_number(value * 100 if value <= 1 else value, 2)


def require_string(value: Any, field: str, *, max_length: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise validation_error(f"{field} is required.")
    return value.strip()[:max_length]


def optional_string(value: Any, field: str, *, max_length: int) -> str | None:
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise validation_error(f"{field} must be a string.")
    return value.strip()[:max_length]


def require_choice(value: Any, field: str, choices: set[str]) -> str:
    parsed = require_string(value, field, max_length=80)
    if parsed not in choices:
        raise validation_error(f"{field} must be one of: {', '.join(sorted(choices))}.")
    return parsed


def require_number(value: Any, field: str) -> float:
    parsed = optional_number(value, field)
    if parsed is None:
        raise validation_error(f"{field} is required.")
    return parsed


def require_positive_number(value: Any, field: str) -> float:
    parsed = require_number(value, field)
    if parsed <= 0:
        raise validation_error(f"{field} must be greater than 0.")
    return parsed


def require_non_negative_number(value: Any, field: str) -> float:
    parsed = require_number(value, field)
    if parsed < 0:
        raise validation_error(f"{field} must be greater than or equal to 0.")
    return parsed


def optional_number(value: Any, field: str) -> float | None:
    if value in (None, ""):
        return None
    try:
        return round_number(float(value), 4)
    except (TypeError, ValueError) as exc:
        raise validation_error(f"{field} must be a number.") from exc


def optional_dict(value: Any) -> dict[str, Any] | None:
    if value in (None, ""):
        return None
    if not isinstance(value, dict):
        raise validation_error("Expected object payload.")
    return clone_json(value)


def optional_list(value: Any) -> list[Any] | None:
    if value in (None, ""):
        return None
    if not isinstance(value, list):
        raise validation_error("Expected array payload.")
    return clone_json(value)


def require_positive_int(value: Any, field: str) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise validation_error(f"{field} must be an integer.") from exc
    if parsed <= 0:
        raise validation_error(f"{field} must be greater than 0.")
    return parsed
