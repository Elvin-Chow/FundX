from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request

from .auth import current_user_id
from .errors import FundXApiError, validation_error
from .services import LOCAL_USER_ID, browser_local_user_data_enabled, get_market_data_meta, now_iso, parse_int, parse_market, read_db, round_number
from .services import update_db as update_normalized_db

router = APIRouter()


@router.get("/api/assets/custom-assets")
def list_custom_assets(request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    user_id = current_user_id(request)
    query = (request.query_params.get("q") or "").strip().lower()
    page = parse_int(request.query_params.get("page"), default=1, minimum=1, field="page")
    page_size = parse_int(request.query_params.get("pageSize"), default=50, minimum=1, maximum=100, field="pageSize")
    db = read_db()
    if browser_local_user_data_enabled():
        return {
            **get_market_data_meta(db, market_id, cached=False),
            "items": [],
            "total": 0,
            "page": page,
            "pageSize": page_size,
            "totalPages": 1,
        }
    items = [
        asset
        for asset in db.get("assets", [])
        if asset.get("marketId") == market_id
        and asset.get("assetType") == "customAsset"
        and owned_asset(asset, user_id)
        and (not query or query in searchable_text(asset))
    ]
    start = (page - 1) * page_size
    paged = items[start : start + page_size]
    total = len(items)

    return {
        **get_market_data_meta(db, market_id, cached=False),
        "items": paged,
        "total": total,
        "page": page,
        "pageSize": page_size,
        "totalPages": max(1, (total + page_size - 1) // page_size),
    }


@router.post("/api/assets/custom-assets", status_code=201)
async def create_custom_asset(request: Request) -> dict[str, Any]:
    await read_json_body(request)
    raise FundXApiError(
        "custom_assets_disabled",
        "Manual priced assets are disabled. Use market search so prices come from public market data providers.",
        400,
    )


@router.delete("/api/assets/custom-assets")
def delete_custom_asset(request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    user_id = current_user_id(request)
    asset_id = request.query_params.get("id")
    if not asset_id:
        raise FundXApiError("invalid_request", "id query parameter is required.", 400)

    removed: dict[str, Any] = {}

    def mutate(db: dict[str, Any]) -> None:
        asset = next(
            (
                item
                for item in db.get("assets", [])
                if item.get("id") == asset_id
                and item.get("marketId") == market_id
                and item.get("assetType") == "customAsset"
                and owned_asset(item, user_id)
            ),
            None,
        )
        if not asset:
            raise FundXApiError("not_found", "Custom asset was not found in the selected market.", 404)
        removed.update(asset)
        db["assets"] = [item for item in db.get("assets", []) if not (item.get("id") == asset_id and owned_asset(item, user_id))]
        db["watchlist"] = [item for item in db.get("watchlist", []) if not (item.get("userId") == user_id and item.get("assetId") == asset_id)]
        db["dailyPrices"] = [item for item in db.get("dailyPrices", []) if item.get("assetId") != asset_id]
        record_audit(db, market_id, "custom-asset.delete", "asset", asset_id, user_id=user_id)

    update_db(mutate)
    return {"ok": True, "assetId": removed["id"]}


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


def require_positive_number(value: Any, field: str) -> float:
    number = optional_number(value, field)
    if number is None or number <= 0:
        raise validation_error(f"{field} must be greater than 0.")
    return number


def optional_number(value: Any, field: str) -> float | None:
    if value in (None, ""):
        return None
    try:
        return round_number(float(value), 4)
    except (TypeError, ValueError) as exc:
        raise validation_error(f"{field} must be a number.") from exc


def update_db(mutator: Any) -> dict[str, Any]:
    return update_normalized_db(mutator)


def owned_asset(asset: dict[str, Any], user_id: str) -> bool:
    return (asset.get("userId") or LOCAL_USER_ID) == user_id


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


def searchable_text(asset: dict[str, Any]) -> str:
    return " ".join(
        str(value).lower()
        for value in [asset.get("name"), asset.get("symbol"), asset.get("id"), asset.get("industry"), asset.get("sector"), *(asset.get("aliases") or [])]
        if value
    )
