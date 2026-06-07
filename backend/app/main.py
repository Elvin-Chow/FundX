from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .analytics import router as analytics_router
from .assets import router as assets_router
from .auth import current_user_id, prepare_api_request, rate_limit_headers
from .calculations_api import router as calculations_router
from .custom_assets import router as custom_assets_router
from .custom_funds import router as custom_funds_router
from .dca import router as dca_router
from .errors import (
    FundXApiError,
    fundx_error_handler,
    request_validation_error_handler,
    unhandled_error_handler,
)
from .portfolio import router as portfolio_router
from .reports_jobs_settings import router as reports_jobs_settings_router
from .services import (
    asset_search_payload,
    browser_local_user_data_enabled,
    funds_payload,
    health_payload,
    market_payload,
    market_top_payload,
    parse_market,
)
from .watchlist import router as watchlist_router

DIST_DIR = Path(__file__).resolve().parents[2] / "dist"

app = FastAPI(title="FundX API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        origin.strip()
        for origin in os.environ.get(
            "FUNDX_CORS_ORIGINS",
            "http://127.0.0.1:3000,http://localhost:3000,http://127.0.0.1:5173,http://localhost:5173",
        ).split(",")
        if origin.strip()
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["*"],
)

app.add_exception_handler(FundXApiError, fundx_error_handler)
app.add_exception_handler(RequestValidationError, request_validation_error_handler)
app.add_exception_handler(Exception, unhandled_error_handler)


@app.middleware("http")
async def api_guard_middleware(request: Request, call_next):
    if not request.url.path.startswith("/api"):
        return await call_next(request)
    if browser_local_user_data_enabled() and is_server_user_data_mutation(request):
        return JSONResponse(
            {
                "ok": False,
                "error": "browser_local_user_data",
                "message": "User portfolios, watchlists, plans, reports, and settings are stored in the browser in this deployment mode.",
                "status": 409,
            },
            status_code=409,
        )

    try:
        session, rate_limit = prepare_api_request(request)
    except FundXApiError as exc:
        return JSONResponse(exc.payload(), status_code=exc.status, headers=exc.headers)
    request.state.session = session
    response = await call_next(request)
    for key, value in rate_limit_headers(rate_limit).items():
        if key != "Retry-After":
            response.headers[key] = value
    return response


def is_server_user_data_mutation(request: Request) -> bool:
    if request.method not in {"POST", "PATCH", "DELETE"}:
        return False
    path = request.url.path
    blocked_prefixes = (
        "/api/portfolios",
        "/api/watchlist",
        "/api/dca",
        "/api/custom-funds",
        "/api/reports",
        "/api/assets/custom-assets",
        "/api/settings/import",
        "/api/settings/provider-accounts",
    )
    return any(path == prefix or path.startswith(f"{prefix}/") for prefix in blocked_prefixes)


app.include_router(custom_assets_router)
app.include_router(custom_funds_router)
app.include_router(dca_router)
app.include_router(calculations_router)
app.include_router(analytics_router)
app.include_router(portfolio_router)
app.include_router(reports_jobs_settings_router)
app.include_router(watchlist_router)


@app.get("/api/health")
def health() -> dict:
    return health_payload()


@app.get("/api/market")
def market(request: Request) -> dict:
    market_id = parse_market(request.query_params.get("market"))
    return market_payload(market_id, request.query_params.get("portfolioId"), current_user_id(request))


@app.get("/api/funds")
def funds(request: Request) -> dict:
    market_id = parse_market(request.query_params.get("market"))
    return funds_payload(market_id, request.query_params.get("refresh"), current_user_id(request))


@app.get("/api/market/top")
def market_top(request: Request) -> dict:
    market_id = parse_market(request.query_params.get("market"))
    return market_top_payload(
        market_id,
        request.query_params.get("kind"),
        request.query_params.get("limit"),
        request.query_params.get("refresh"),
        current_user_id(request),
    )


@app.get("/api/assets/search")
def assets_search(request: Request) -> dict:
    return asset_search_payload(dict(request.query_params), current_user_id(request))


app.include_router(assets_router)


if DIST_DIR.exists():
    assets_dir = DIST_DIR / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="frontend-assets")

    @app.get("/", include_in_schema=False)
    def frontend_index() -> FileResponse:
        return FileResponse(DIST_DIR / "index.html")

    @app.get("/{path:path}", include_in_schema=False)
    def frontend_route(path: str) -> FileResponse:
        if path.startswith("api/"):
            raise HTTPException(status_code=404)
        candidate = (DIST_DIR / path).resolve()
        if candidate.is_file() and DIST_DIR.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(DIST_DIR / "index.html")
