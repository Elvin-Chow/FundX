from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request

from .auth import current_user_id
from .errors import FundXApiError, validation_error
from .services import (
    LOCAL_USER_ID,
    browser_local_user_data_enabled,
    get_db_path,
    is_public_market_asset,
    normalize_asset_record,
    now_iso,
    parse_market,
    read_db,
    round_number,
)
from .services import update_db as update_normalized_db

router = APIRouter()


@router.get("/api/watchlist")
def list_watchlist_route(request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    if browser_local_user_data_enabled():
        return {"marketId": market_id, "watchlist": [], "view": []}
    items = list_watchlist(read_db(), current_user_id(request), market_id)
    return {
        "marketId": market_id,
        "watchlist": items,
        "view": [watchlist_view_item(item) for item in items],
    }


@router.post("/api/watchlist", status_code=201)
async def upsert_watchlist_route(request: Request) -> dict[str, Any]:
    body = await read_json_body(request)
    market_id = parse_market(str(body.get("marketId") or ""))
    assert_query_market_matches(request, market_id)
    asset_id = require_string(body.get("assetId"), "assetId", max_length=120)
    asset_type = normalize_asset_type(require_string(body.get("assetType"), "assetType", max_length=40))
    note = optional_string(body.get("note"), "note", max_length=240) or ""
    group = optional_string(body.get("group"), "group", max_length=80) or "Ideas"
    target = optional_number(body.get("target"), "target")
    user_id = current_user_id(request)

    saved_item: dict[str, Any] = {}

    def mutate(db: dict[str, Any]) -> None:
        asset = resolve_owned_asset(db, user_id, market_id, asset_id, asset_type)
        price = require_latest_price(asset)
        existing = next(
            (
                item
                for item in db.get("watchlist", [])
                if item.get("userId") == user_id and item.get("marketId") == market_id and item.get("assetId") == asset_id
            ),
            None,
        )
        now = now_iso()
        item = {
            "id": existing.get("id") if existing else f"watch-{uuid.uuid4()}",
            "userId": user_id,
            "marketId": market_id,
            "assetId": asset["id"],
            "assetType": normalize_asset_type(asset.get("assetType")),
            "name": asset.get("name"),
            "symbol": asset.get("symbol"),
            "price": price,
            "dailyChange": asset.get("dailyChange") or 0,
            "note": note or (existing.get("note") if existing else ""),
            "target": target if target is not None else (existing.get("target") if existing else round_number(price * 0.95, 2)),
            "group": group or (existing.get("group") if existing else "Ideas"),
            "sparkline": list_asset_sparkline(db, asset["id"]),
            "createdAt": existing.get("createdAt") if existing else now,
            "updatedAt": now,
        }
        if existing:
            existing.update(item)
            saved_item.update(existing)
        else:
            db.setdefault("watchlist", []).insert(0, item)
            saved_item.update(item)
        record_audit(db, market_id, "watchlist.upsert", "watchlist", item["id"], user_id=user_id)

    update_db(mutate)
    return {
        "ok": True,
        "message": "Watchlist item saved.",
        "item": saved_item,
    }


@router.post("/api/watchlist/refresh")
async def refresh_watchlist_route(request: Request) -> dict[str, Any]:
    body = await read_json_body(request)
    market_id = parse_market(str(body.get("marketId") or request.query_params.get("market") or ""))
    assert_query_market_matches(request, market_id)
    if browser_local_user_data_enabled():
        return {
            "ok": True,
            "marketId": market_id,
            "watchlist": [],
            "view": [],
            "refreshResult": {"fetched": 0, "failed": [], "source": "browser-local", "skipped": "browser-local-user-data"},
        }
    user_id = current_user_id(request)
    items = list_watchlist(read_db(), user_id, market_id)
    asset_ids = list(
        dict.fromkeys(
            str(item.get("assetId"))
            for item in items
            if item.get("assetId") and normalize_asset_type(item.get("assetType")) not in {"customAsset", "customFund"}
        )
    )
    if asset_ids:
        from .data_sources import refresh_market_data

        refresh_result = refresh_market_data(user_id=user_id, market_id=market_id, asset_ids=asset_ids, range_value="1mo", timeout_seconds=4)
    else:
        refresh_result = {"fetched": 0, "failed": [], "source": "watchlist", "skipped": "empty-watchlist"}

    updated_items = refresh_saved_watchlist_items(user_id, market_id)
    return {
        "ok": True,
        "marketId": market_id,
        "watchlist": updated_items,
        "view": [watchlist_view_item(item) for item in updated_items],
        "refreshResult": refresh_result,
    }


@router.delete("/api/watchlist")
def delete_watchlist_route(request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    user_id = current_user_id(request)
    item_id = request.query_params.get("id") or request.query_params.get("assetId")
    if not item_id:
        raise FundXApiError("invalid_request", "id or assetId query parameter is required.", 400)

    def mutate(db: dict[str, Any]) -> None:
        before = len(db.get("watchlist", []))
        db["watchlist"] = [
            item
            for item in db.get("watchlist", [])
            if not (
                item.get("userId") == user_id
                and item.get("marketId") == market_id
                and (item.get("id") == item_id or item.get("assetId") == item_id)
            )
        ]
        if len(db["watchlist"]) == before:
            raise FundXApiError("not_found", "Watchlist item was not found.", 404)
        record_audit(db, market_id, "watchlist.delete", "watchlist", item_id, user_id=user_id)

    update_db(mutate)
    return {"ok": True, "itemId": item_id}


def list_watchlist(db: dict[str, Any], user_id: str, market_id: str) -> list[dict[str, Any]]:
    return [
        item
        for item in db.get("watchlist", [])
        if item.get("userId") == user_id and item.get("marketId") == market_id
    ]


def refresh_saved_watchlist_items(user_id: str, market_id: str) -> list[dict[str, Any]]:
    def mutate(db: dict[str, Any]) -> None:
        touched = 0
        for item in db.get("watchlist", []):
            if item.get("userId") != user_id or item.get("marketId") != market_id:
                continue
            updates = refreshed_item_fields(db, user_id, market_id, item)
            if updates:
                item.update(updates)
                touched += 1
        if touched:
            record_audit(db, market_id, "watchlist.refresh", "watchlist", "all", user_id=user_id)

    db = update_db(mutate)
    return list_watchlist(db, user_id, market_id)


def refreshed_item_fields(db: dict[str, Any], user_id: str, market_id: str, item: dict[str, Any]) -> dict[str, Any]:
    asset_id = str(item.get("assetId") or "")
    asset_type = normalize_asset_type(item.get("assetType"))
    if not asset_id:
        return {}
    try:
        asset = resolve_owned_asset(db, user_id, market_id, asset_id, asset_type)
    except FundXApiError:
        return {}

    updates: dict[str, Any] = {
        "name": asset.get("name") or item.get("name"),
        "symbol": asset.get("symbol") or item.get("symbol"),
        "sparkline": list_asset_sparkline(db, asset_id),
        "updatedAt": now_iso(),
    }
    price = asset.get("latestPrice")
    if isinstance(price, (int, float)) and price > 0:
        updates["price"] = round_number(float(price), 4)
    daily_change = asset.get("dailyChange")
    if isinstance(daily_change, (int, float)):
        updates["dailyChange"] = round_number(float(daily_change), 2)
    return updates


def watchlist_view_item(item: dict[str, Any]) -> dict[str, Any]:
    daily_change = item.get("dailyChange") or 0
    return {
        "id": item.get("id"),
        "assetId": item.get("assetId"),
        "assetType": item.get("assetType"),
        "name": item.get("name"),
        "symbol": item.get("symbol"),
        "price": item.get("price"),
        "target": item.get("target"),
        "dailyChange": daily_change,
        "reason": item.get("note"),
        "performance": item.get("sparkline") or [],
        "group": item.get("group"),
        "signal": f"{daily_change:.2f}% today",
    }


async def read_json_body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception as exc:
        raise FundXApiError("invalid_json", "Request body must be valid JSON.", 400) from exc
    if not isinstance(body, dict):
        raise validation_error("Request body must be a JSON object.")
    return body


def assert_query_market_matches(request: Request, market_id: str) -> None:
    if request.query_params.get("market") and parse_market(request.query_params.get("market")) != market_id:
        raise FundXApiError("market_mismatch", "Request query market and body marketId must match.", 400)


def resolve_owned_asset(db: dict[str, Any], user_id: str, market_id: str, asset_id: str, asset_type: str) -> dict[str, Any]:
    if asset_type == "customFund":
        custom_fund = next(
            (
                item
                for item in db.get("customFunds", [])
                if item.get("userId") == user_id and item.get("marketId") == market_id and item.get("id") == asset_id
            ),
            None,
        )
        if not custom_fund:
            raise FundXApiError("not_found", "Custom fund was not found in the selected market.", 404)
        return custom_fund_to_asset(custom_fund)

    normalized_type = normalize_asset_type(asset_type)
    asset = next(
        (
            normalize_asset_record(item)
            for item in db.get("assets", [])
            if item.get("marketId") == market_id
            and item.get("id") == asset_id
            and normalize_asset_type(item.get("assetType")) == normalized_type
            and asset_visible_to_user(item, user_id)
            and is_public_market_asset(item)
        ),
        None,
    )
    if not asset:
        raise FundXApiError("not_found", "Asset was not found in the selected market.", 404)
    return asset


def custom_fund_to_asset(fund: dict[str, Any]) -> dict[str, Any]:
    history = ((fund.get("score") or {}).get("backtestHistory") or [])
    latest = history[-1].get("value") if history else None
    previous = history[-2].get("value") if len(history) > 1 else latest
    daily_change = None if latest is None or previous in (None, 0) else ((latest - previous) / previous) * 100
    return {
        "id": fund.get("id"),
        "marketId": fund.get("marketId"),
        "assetType": "customFund",
        "kind": "fund",
        "name": fund.get("name"),
        "symbol": fund.get("id"),
        "latestPrice": round_number(latest, 4) if isinstance(latest, (int, float)) else None,
        "dailyChange": round_number(daily_change, 2) if isinstance(daily_change, (int, float)) else 0,
    }


def asset_visible_to_user(asset: dict[str, Any], user_id: str) -> bool:
    if asset.get("assetType") != "customAsset":
        return True
    return (asset.get("userId") or LOCAL_USER_ID) == user_id


def require_latest_price(asset: dict[str, Any]) -> float:
    price = asset.get("latestPrice")
    if asset.get("quoteStatus") != "fresh" or not isinstance(price, (int, float)) or price <= 0:
        raise FundXApiError(
            "invalid_request",
            "Asset has no refreshed real quote. Refresh this asset before using it in a priced workflow.",
            400,
        )
    return round_number(float(price), 4)


def list_asset_sparkline(db: dict[str, Any], asset_id: str) -> list[dict[str, Any]]:
    points = sorted(
        [point for point in db.get("dailyPrices", []) if point.get("assetId") == asset_id],
        key=lambda point: str(point.get("date", "")),
    )[-40:]
    return [
        {
            "date": point.get("date"),
            "value": point.get("nav") if point.get("nav") is not None else point.get("close"),
        }
        for point in points
    ]


def normalize_asset_type(value: Any) -> str:
    return "fund" if value == "etf" else str(value)


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


def optional_number(value: Any, field: str) -> float | None:
    if value in (None, ""):
        return None
    try:
        return round_number(float(value), 4)
    except (TypeError, ValueError) as exc:
        raise validation_error(f"{field} must be a number.") from exc


def update_db(mutator: Any) -> dict[str, Any]:
    return update_normalized_db(mutator)


def record_audit(db: dict[str, Any], market_id: str, action: str, entity_type: str, entity_id: str, *, user_id: str = LOCAL_USER_ID) -> None:
    db.setdefault("auditEvents", []).insert(
        0,
        {
            "id": f"audit-{uuid.uuid4()}",
            "userId": user_id,
            "marketId": market_id,
            "action": action,
            "entityType": entity_type,
            "entityId": entity_id,
            "createdAt": now_iso(),
        },
    )
    db["auditEvents"] = db["auditEvents"][:1000]
