from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import Response

from .auth import current_user_id
from .errors import FundXApiError, validation_error
from .portfolio_read import build_portfolio_summary, get_active_portfolio
from .provider_accounts import list_provider_accounts, save_provider_account
from .services import (
    LOCAL_USER_ID,
    MARKET_CONFIGS,
    MarketId,
    browser_local_user_data_enabled,
    clone_json,
    create_id,
    get_market_data_meta,
    now_iso,
    parse_market,
    read_db,
    record_audit,
    set_cached_value,
    update_db,
)

router = APIRouter()


@router.get("/api/reports")
def list_reports_route(request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    user_id = current_user_id(request)
    db = read_db()
    if browser_local_user_data_enabled():
        return {
            **get_market_data_meta(db, market_id),
            "generatedAt": now_iso(),
            "reports": [],
            "portfolioSummary": None,
            "templates": list_report_templates(market_id),
        }
    reports = [item for item in db.get("reports", []) if item.get("userId") == user_id and item.get("marketId") == market_id]
    portfolio = get_active_portfolio(db, user_id, market_id, request.query_params.get("portfolioId") or None)
    return {
        **get_market_data_meta(db, market_id),
        "generatedAt": now_iso(),
        "reports": reports,
        "portfolioSummary": build_portfolio_summary(portfolio) if portfolio else None,
        "templates": list_report_templates(market_id),
    }


@router.post("/api/reports", status_code=201)
async def create_report_route(request: Request) -> dict[str, Any]:
    body = await read_json_body(request)
    raw_market = body.get("marketId") or request.query_params.get("market")
    if not raw_market:
        raise FundXApiError("invalid_request", "marketId is required.", 400)
    market_id = parse_market(str(raw_market))
    assert_query_market_matches(request, market_id)
    report_type = require_choice(body.get("type"), "type", {"portfolio", "dca", "custom-fund"})
    params = body.get("params") if isinstance(body.get("params"), dict) else {}
    report = generate_report(current_user_id(request), market_id, report_type, params)
    return {"ok": True, **get_market_data_meta(read_db(), market_id), "message": "Report generated.", "report": report}


@router.get("/api/reports/{report_id}")
def get_report_route(report_id: str, request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market")) if request.query_params.get("market") else None
    report = find_report(read_db(), current_user_id(request), report_id, market_id)
    return {"marketId": report.get("marketId"), "report": report}


@router.get("/api/reports/{report_id}/export")
def export_report_route(report_id: str, request: Request) -> Response:
    market_id = parse_market(request.query_params.get("market")) if request.query_params.get("market") else None
    export_format = request.query_params.get("format") or "json"
    if export_format not in {"json", "csv", "pdf"}:
        raise validation_error("format must be one of: json, csv, pdf.")
    report = find_report(read_db(), current_user_id(request), report_id, market_id)
    exports = report.get("exports") if isinstance(report.get("exports"), dict) else {}
    body = exports.get(export_format)
    if body is None:
        body = build_export_body(report.get("payload") if isinstance(report.get("payload"), dict) else report, export_format, str(report.get("title") or "FundX report"))
    media_type = "application/json; charset=utf-8" if export_format == "json" else "text/csv; charset=utf-8" if export_format == "csv" else "application/pdf"
    content = body.encode("utf-8") if isinstance(body, str) else body
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f"attachment; filename={report_id}.{export_format}"},
    )


@router.get("/api/jobs")
def list_jobs_route(request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market")) if request.query_params.get("market") else None
    user_id = current_user_id(request)
    jobs = [
        item
        for item in read_db().get("jobs", [])
        if (item.get("userId") or LOCAL_USER_ID) == user_id and (not market_id or item.get("marketId") == market_id)
    ]
    return {"marketId": market_id, "jobs": jobs[:50]}


@router.post("/api/jobs", status_code=201)
async def run_job_route(request: Request) -> dict[str, Any]:
    body = await read_json_body(request)
    job_type = require_choice(
        body.get("type"),
        "type",
        {"sync-security-master", "sync-universe", "sync-prices", "sync-nav", "sync-holdings", "sync-market-latest", "recalculate-metrics", "cleanup-cache"},
    )
    market_id = parse_market(str(body.get("marketId") or request.query_params.get("market") or "")) if (body.get("marketId") or request.query_params.get("market")) else None
    job = run_background_job(job_type, market_id, current_user_id(request))
    return {"ok": True, "job": job}


@router.get("/api/settings/export")
def export_settings_route(request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    if browser_local_user_data_enabled():
        return {
            "marketId": market_id,
            "generatedAt": now_iso(),
            "portfolios": [],
            "activePortfolio": None,
            "portfolioSummary": None,
            "customFunds": [],
            "dcaPlans": [],
            "watchlist": [],
            "reports": [],
            "preferences": [],
        }
    return export_settings(current_user_id(request), market_id)


@router.post("/api/settings/import", status_code=201)
async def import_settings_route(request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    mode = request.query_params.get("mode") or "merge"
    if mode not in {"merge", "replace"}:
        raise FundXApiError("invalid_request", "mode must be one of: merge, replace", 400)
    body = await read_json_body(request)
    if body.get("marketId") != market_id:
        raise FundXApiError("market_mismatch", "Imported settings market does not match the active market.", 400)
    return import_settings(current_user_id(request), market_id, body, mode)


@router.get("/api/settings/provider-accounts")
def list_provider_accounts_route(request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    payload = list_provider_accounts(current_user_id(request), market_id)
    from .market_data_providers import MarketDataProviderManager

    payload["source"] = MarketDataProviderManager(user_id=current_user_id(request)).source_label(market_id)
    return payload


@router.patch("/api/settings/provider-accounts")
async def save_provider_account_route(request: Request) -> dict[str, Any]:
    market_id = parse_market(request.query_params.get("market"))
    body = await read_json_body(request)
    payload = save_provider_account(current_user_id(request), market_id, body)
    from .market_data_providers import MarketDataProviderManager

    payload["source"] = MarketDataProviderManager(user_id=current_user_id(request)).source_label(market_id)
    return payload


def generate_report(user_id: str, market_id: MarketId, report_type: str, params: dict[str, Any]) -> dict[str, Any]:
    saved: dict[str, Any] = {}

    def mutate(db: dict[str, Any]) -> None:
        title = "Portfolio report" if report_type == "portfolio" else "DCA report" if report_type == "dca" else "Custom fund report"
        payload = build_report_payload(db, user_id, market_id, report_type, params)
        report = {
            "id": create_id("report"),
            "userId": user_id,
            "marketId": market_id,
            "type": report_type,
            "params": params,
            "status": "ready",
            "exportStatus": "ready",
            "title": title,
            "payload": payload,
            "exports": {
                "json": json.dumps(payload, ensure_ascii=False, indent=2),
                "csv": report_payload_to_csv(payload),
                "pdf": build_simple_pdf(f"{MARKET_CONFIGS[market_id]['name']} {title}", report_payload_lines(payload)),
            },
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
        }
        db.setdefault("reports", []).insert(0, report)
        set_cached_value(db, f"report:{report['id']}", report, 3600)
        record_audit(db, market_id, "report.generate", "report", report["id"], user_id=user_id, metadata={"type": report_type})
        saved.update(clone_json(report))

    update_db(mutate)
    return saved


def run_background_job(job_type: str, market_id: MarketId | None, user_id: str = LOCAL_USER_ID) -> dict[str, Any]:
    saved: dict[str, Any] = {}
    external_result = execute_external_job(job_type, market_id, user_id)

    def mutate(db: dict[str, Any]) -> None:
        now = now_iso()
        result = external_result if external_result is not None else execute_job(db, job_type, market_id, user_id)
        job = {
            "id": create_id("job"),
            "userId": user_id,
            "type": job_type,
            "marketId": market_id,
            "status": "succeeded",
            "attempts": 1,
            "maxAttempts": 3,
            "scheduledAt": now,
            "startedAt": now,
            "finishedAt": now,
            "result": result,
        }
        db.setdefault("jobs", []).insert(0, job)
        record_audit(db, market_id, f"job.{job_type}.succeeded", "backgroundJob", job["id"], user_id=user_id, metadata=job["result"])
        saved.update(clone_json(job))

    update_db(mutate)
    return saved


def execute_external_job(job_type: str, market_id: MarketId | None, user_id: str) -> dict[str, Any] | None:
    if job_type in {"sync-security-master", "sync-universe"}:
        if not market_id:
            raise FundXApiError("invalid_request", "Market is required for security universe sync.", 400)
        from .asset_discovery import ensure_market_universe

        return ensure_market_universe(user_id=user_id, market_id=market_id, force=True)
    if job_type in {"sync-prices", "sync-nav"}:
        if not market_id:
            raise FundXApiError("invalid_request", "Market is required for bounded quote refresh.", 400)
        from .data_sources import refresh_market_top_assets

        return refresh_market_top_assets(user_id=user_id, market_id=market_id, kind="stock" if job_type == "sync-prices" else "fund", limit=10)
    if job_type == "sync-market-latest":
        if not market_id:
            raise FundXApiError("invalid_request", "Market is required for full-market latest quote refresh.", 400)
        from .data_sources import refresh_full_market_latest_data

        return refresh_full_market_latest_data(user_id=user_id, market_id=market_id)
    if job_type == "sync-holdings":
        if not market_id:
            raise FundXApiError("invalid_request", "Market is required for holdings quote refresh.", 400)
        db = read_db()
        asset_ids = [
            str(holding.get("assetId"))
            for portfolio in db.get("portfolios", [])
            if portfolio.get("userId") == user_id and portfolio.get("marketId") == market_id
            for holding in portfolio.get("holdings", [])
            if holding.get("assetId")
        ]
        if not asset_ids:
            from .market_data_providers import MarketDataProviderManager

            return {"fetched": 0, "failed": [], "source": MarketDataProviderManager(user_id=user_id).source_label(market_id), "skipped": "no-holdings"}
        from .data_sources import refresh_market_data

        return refresh_market_data(user_id=user_id, market_id=market_id, asset_ids=asset_ids, range_value="1mo", timeout_seconds=4)
    return None


def execute_job(db: dict[str, Any], job_type: str, market_id: MarketId | None, user_id: str = LOCAL_USER_ID) -> dict[str, Any]:
    if job_type in {"sync-security-master", "sync-universe"}:
        return {"synced": 0, "source": "local-db", "skipped": "security-master-static"}
    if job_type in {"sync-prices", "sync-nav"}:
        from .market_data_providers import MarketDataProviderManager

        return {"fetched": 0, "failed": [], "source": MarketDataProviderManager(user_id=user_id).source_label(market_id), "skipped": "handled-before-job-record"}
    if job_type == "sync-holdings":
        from .market_data_providers import MarketDataProviderManager

        return {"fetched": 0, "failed": [], "source": MarketDataProviderManager(user_id=user_id).source_label(market_id), "skipped": "handled-before-job-record"}
    if job_type == "sync-market-latest":
        return {"fetched": 0, "failed": [], "source": "market-universe", "skipped": "handled-before-job-record"}
    if job_type == "recalculate-metrics":
        portfolios = [
            item
            for item in db.get("portfolios", [])
            if item.get("userId") == user_id and (not market_id or item.get("marketId") == market_id)
        ]
        for portfolio in portfolios:
            set_cached_value(db, f"analytics:portfolio:{portfolio.get('id')}:{portfolio.get('updatedAt')}", build_portfolio_summary(portfolio), 1800)
        return {"recalculated": len(portfolios)}
    if job_type == "cleanup-cache":
        now = now_iso()
        before = len(db.get("cache", []))
        db["cache"] = [item for item in db.get("cache", []) if str(item.get("expiresAt", "")) > now]
        return {"deleted": before - len(db["cache"])}
    return {}


def export_settings(user_id: str, market_id: MarketId) -> dict[str, Any]:
    db = read_db()
    portfolios = [item for item in db.get("portfolios", []) if item.get("userId") == user_id and item.get("marketId") == market_id]
    active_portfolio = get_active_portfolio(db, user_id, market_id, None) if portfolios else None
    return {
        "marketId": market_id,
        "generatedAt": now_iso(),
        "portfolios": clone_json(portfolios),
        "activePortfolio": clone_json(active_portfolio) if active_portfolio else None,
        "portfolioSummary": build_portfolio_summary(active_portfolio) if active_portfolio else None,
        "customFunds": clone_json([item for item in db.get("customFunds", []) if item.get("userId") == user_id and item.get("marketId") == market_id]),
        "dcaPlans": clone_json([item for item in db.get("dcaPlans", []) if item.get("userId") == user_id and item.get("marketId") == market_id]),
        "watchlist": clone_json([item for item in db.get("watchlist", []) if item.get("userId") == user_id and item.get("marketId") == market_id]),
        "reports": clone_json([item for item in db.get("reports", []) if item.get("userId") == user_id and item.get("marketId") == market_id]),
        "preferences": clone_json([item for item in db.get("users", []) if item.get("id") == user_id]),
    }


def import_settings(user_id: str, market_id: MarketId, payload: dict[str, Any], mode: str) -> dict[str, Any]:
    counts = {"portfolios": 0, "customFunds": 0, "dcaPlans": 0, "watchlist": 0, "reports": 0, "preferences": 0}

    def mutate(db: dict[str, Any]) -> None:
        if mode == "replace":
            db["portfolios"] = [item for item in db.get("portfolios", []) if not owned_market_item(item, user_id, market_id)]
            db["portfolioVersions"] = [item for item in db.get("portfolioVersions", []) if not owned_market_item(item, user_id, market_id)]
            db["customFunds"] = [item for item in db.get("customFunds", []) if not owned_market_item(item, user_id, market_id)]
            db["dcaPlans"] = [item for item in db.get("dcaPlans", []) if not owned_market_item(item, user_id, market_id)]
            db["watchlist"] = [item for item in db.get("watchlist", []) if not owned_market_item(item, user_id, market_id)]
            db["reports"] = [item for item in db.get("reports", []) if not owned_market_item(item, user_id, market_id)]

        for key, db_key in (("portfolios", "portfolios"), ("customFunds", "customFunds"), ("dcaPlans", "dcaPlans"), ("watchlist", "watchlist"), ("reports", "reports")):
            records = sanitize_import_records(payload.get(key), user_id, market_id)
            db.setdefault(db_key, [])
            db[db_key] = [*records, *db[db_key]]
            counts[key] = len(records)
        record_audit(db, market_id, "settings.import", "settings", user_id=user_id, metadata={"mode": mode, **counts})

    update_db(mutate)
    return {"ok": True, "marketId": market_id, "mode": mode, "imported": counts, "idChanges": 0, "message": "Settings imported."}


def build_report_payload(db: dict[str, Any], user_id: str, market_id: MarketId, report_type: str, params: dict[str, Any]) -> dict[str, Any]:
    if report_type == "portfolio":
        portfolio_id = params.get("portfolioId") if isinstance(params.get("portfolioId"), str) else None
        portfolio = get_active_portfolio(db, user_id, market_id, portfolio_id)
        if not portfolio:
            raise FundXApiError("not_found", "Portfolio was not found in the selected market.", 404)
        return {
            "type": report_type,
            "generatedAt": now_iso(),
            "portfolio": {"id": portfolio.get("id"), "name": portfolio.get("name"), "goal": portfolio.get("goal")},
            "summary": build_portfolio_summary(portfolio),
            "benchmark": MARKET_CONFIGS[market_id]["benchmarks"][0],
        }
    if report_type == "dca":
        plan_id = params.get("planId") if isinstance(params.get("planId"), str) else None
        plan = next(
            (
                item
                for item in db.get("dcaPlans", [])
                if item.get("userId") == user_id
                and item.get("marketId") == market_id
                and (not plan_id or item.get("id") == plan_id)
            ),
            None,
        )
        if plan_id and not plan:
            raise FundXApiError("not_found", "DCA plan was not found in the selected market.", 404)
        fund = (plan or {}).get("fund") or next((item for item in db.get("funds", []) if item.get("marketId") == market_id), None)
        if not fund:
            raise FundXApiError("not_found", "Fund was not found in the selected market.", 404)
        return {"type": report_type, "generatedAt": now_iso(), "fund": {"id": fund.get("id"), "name": fund.get("name"), "symbol": fund.get("symbol")}, "simulation": (plan or {}).get("simulationSnapshot")}
    custom_fund_id = params.get("customFundId") if isinstance(params.get("customFundId"), str) else None
    custom_fund = next(
        (
            item
            for item in db.get("customFunds", [])
            if item.get("userId") == user_id
            and item.get("marketId") == market_id
            and (not custom_fund_id or item.get("id") == custom_fund_id)
        ),
        None,
    )
    if custom_fund_id and not custom_fund:
        raise FundXApiError("not_found", "Custom fund was not found in the selected market.", 404)
    if not custom_fund:
        stocks = [item for item in db.get("stocks", []) if item.get("marketId") == market_id]
        custom_fund = {
            "id": f"draft-custom-fund-{market_id}",
            "userId": user_id,
            "marketId": market_id,
            "name": "Quality Value Custom Fund" if market_id == "us" else "\u8d28\u91cf\u7ea2\u5229\u81ea\u9009\u57fa\u91d1",
            "style": "Quality Value" if market_id == "us" else "\u7ea2\u5229\u4ef7\u503c",
            "holdings": [{"stockId": stock.get("id"), "weight": 20} for stock in stocks[:5] if stock.get("id")],
            "score": score_custom_fund_draft(stocks[:5]),
            "version": 0,
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
        }
    return {"type": report_type, "generatedAt": now_iso(), "customFund": custom_fund}


def list_report_templates(market_id: MarketId) -> list[dict[str, Any]]:
    market = MARKET_CONFIGS[market_id]
    return [
        {"id": f"template-{market_id}-portfolio", "title": f"{market['name']} portfolio report", "subtitle": "Allocation, risk score, drawdown, and rebalance guidance", "status": "Ready", "href": f"/reports?market={market_id}&type=portfolio", "type": "portfolio"},
        {"id": f"template-{market_id}-dca", "title": "DCA simulation report", "subtitle": "Contribution curve, ending value, and cash-flow detail", "status": "Ready", "href": f"/reports?market={market_id}&type=dca", "type": "dca"},
        {"id": f"template-{market_id}-custom-fund", "title": "Custom fund draft", "subtitle": "Value score, quality score, sector exposure, and real-history checks", "status": "Draft", "href": f"/reports?market={market_id}&type=custom-fund", "type": "custom-fund"},
    ]


def find_report(db: dict[str, Any], user_id: str, report_id: str, market_id: MarketId | None) -> dict[str, Any]:
    report = next(
        (item for item in db.get("reports", []) if item.get("userId") == user_id and item.get("id") == report_id and (market_id is None or item.get("marketId") == market_id)),
        None,
    )
    if not report:
        raise FundXApiError("not_found", "Report was not found.", 404)
    return report


def build_export_body(payload: dict[str, Any], export_format: str, title: str) -> str:
    if export_format == "json":
        return json.dumps(payload, ensure_ascii=False, indent=2)
    if export_format == "csv":
        return report_payload_to_csv(payload)
    return build_simple_pdf(title, report_payload_lines(payload))


def report_payload_to_csv(payload: dict[str, Any]) -> str:
    lines = report_payload_lines(payload)
    return "\n".join(["metric,value", *[f"{csv(line.split(':', 1)[0])},{csv(line.split(':', 1)[1].strip() if ':' in line else '')}" for line in lines]])


def report_payload_lines(payload: dict[str, Any]) -> list[str]:
    summary = payload.get("summary") if isinstance(payload.get("summary"), dict) else None
    simulation = payload.get("simulation") if isinstance(payload.get("simulation"), dict) else None
    custom_fund = payload.get("customFund") if isinstance(payload.get("customFund"), dict) else None
    if summary:
        return [f"Total value: {summary.get('totalValue')}", f"Total gain: {summary.get('totalGain')}", f"Annualized return: {summary.get('annualizedReturn')}", f"Max drawdown: {summary.get('maxDrawdown')}", f"Volatility: {summary.get('volatility')}", f"Sharpe: {summary.get('sharpeRatio')}", f"Risk score: {summary.get('riskScore')}"]
    if simulation:
        return [f"Total invested: {simulation.get('totalInvested')}", f"Final value: {simulation.get('finalValue')}", f"Total return: {simulation.get('totalReturnPercent')}", f"Max drawdown: {simulation.get('maxDrawdown')}", f"Average cost: {simulation.get('averageCost')}"]
    if custom_fund:
        score = custom_fund.get("score") if isinstance(custom_fund.get("score"), dict) else {}
        return [f"Name: {custom_fund.get('name')}", f"Value score: {score.get('valueScore')}", f"Quality score: {score.get('qualityScore')}", f"Risk score: {score.get('riskScore')}", f"Max drawdown: {score.get('maxDrawdown')}"]
    return [f"{key}: {json.dumps(value, ensure_ascii=False)}" for key, value in payload.items()]


def score_custom_fund_draft(stocks: list[dict[str, Any]]) -> dict[str, Any]:
    if not stocks:
        return {
            "totalWeight": 0,
            "valueScore": 0,
            "qualityScore": 0,
            "riskScore": 0,
            "maxDrawdown": 0,
            "sectorExposure": [],
            "backtestHistory": [],
        }
    weight = 100 / len(stocks)
    sector_weights: dict[str, float] = {}
    for stock in stocks:
        sector = str(stock.get("sector") or "Other")
        sector_weights[sector] = sector_weights.get(sector, 0) + weight
    return {
        "totalWeight": 100,
        "valueScore": round(sum(float(stock.get("valueScore") or 0) for stock in stocks) / len(stocks), 1),
        "qualityScore": round(sum(float(stock.get("qualityScore") or 0) for stock in stocks) / len(stocks), 1),
        "riskScore": round(sum(float(stock.get("riskScore") or 0) for stock in stocks) / len(stocks), 1),
        "maxDrawdown": 0,
        "sectorExposure": [{"name": name, "sector": name, "weight": round(value, 2)} for name, value in sector_weights.items()],
        "backtestHistory": [],
    }


def build_simple_pdf(title: str, lines: list[str]) -> str:
    text = "\n".join([title, *lines]).replace("(", "").replace(")", "")
    stream = f"BT /F1 14 Tf 48 760 Td ({text.replace(chr(10), ') Tj T* (')}) Tj ET"
    objects = [
        "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
        "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
        "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
        "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
        f"5 0 obj << /Length {len(stream)} >> stream\n{stream}\nendstream endobj",
    ]
    pdf = "%PDF-1.4\n"
    offsets = [0]
    for obj in objects:
        offsets.append(len(pdf))
        pdf += f"{obj}\n"
    xref = len(pdf)
    pdf += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n"
    for offset in offsets[1:]:
        pdf += f"{offset:010d} 00000 n \n"
    pdf += f"trailer << /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF"
    return pdf


def sanitize_import_records(value: Any, user_id: str, market_id: MarketId) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    records = []
    for item in value:
        if not isinstance(item, dict):
            continue
        if item.get("marketId") != market_id:
            raise FundXApiError("market_mismatch", "Imported record market does not match the active market.", 400)
        record = clone_json(item)
        record["userId"] = user_id
        records.append(record)
    return records


def owned_market_item(item: dict[str, Any], user_id: str, market_id: MarketId) -> bool:
    return item.get("userId") == user_id and item.get("marketId") == market_id


async def read_json_body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception as exc:
        raise FundXApiError("invalid_json", "Request body must be valid JSON.", 400) from exc
    if not isinstance(body, dict):
        raise validation_error("Request body must be a JSON object.")
    return body


def assert_query_market_matches(request: Request, market_id: MarketId) -> None:
    if request.query_params.get("market") and parse_market(request.query_params.get("market")) != market_id:
        raise FundXApiError("market_mismatch", "Request query market and body marketId must match.", 400)


def require_choice(value: Any, field: str, choices: set[str]) -> str:
    if not isinstance(value, str) or not value:
        raise validation_error(f"{field} is required.")
    if value not in choices:
        raise validation_error(f"{field} must be one of: {', '.join(sorted(choices))}.")
    return value


def csv(value: str) -> str:
    return f"\"{value.replace('\"', '\"\"')}\""
