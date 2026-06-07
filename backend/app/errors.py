from __future__ import annotations

from typing import Any

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class FundXApiError(Exception):
    def __init__(
        self,
        error: str,
        message: str,
        status: int = 400,
        *,
        fields: dict[str, list[str] | None] | None = None,
        details: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.error = error
        self.message = message
        self.status = status
        self.fields = fields
        self.details = details
        self.headers = headers

    def payload(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "ok": False,
            "error": self.error,
            "message": self.message,
            "status": self.status,
        }
        if self.fields:
            data["fields"] = self.fields
        if self.details:
            data["details"] = self.details
        return data


def invalid_market() -> FundXApiError:
    return FundXApiError("invalid_market", "market must be: us", 400)


def validation_error(message: str = "Request validation failed.") -> FundXApiError:
    return FundXApiError("validation_error", message, 400)


async def fundx_error_handler(_: Request, exc: FundXApiError) -> JSONResponse:
    return JSONResponse(exc.payload(), status_code=exc.status, headers=exc.headers)


async def request_validation_error_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    fields: dict[str, list[str]] = {}
    for error in exc.errors():
        loc = [str(item) for item in error.get("loc", []) if item not in ("query", "body")]
        field = ".".join(loc) or "request"
        fields.setdefault(field, []).append(str(error.get("msg", "Invalid value.")))

    api_error = FundXApiError(
        "validation_error",
        "Request validation failed.",
        400,
        fields=fields,
    )
    return JSONResponse(api_error.payload(), status_code=api_error.status)


async def unhandled_error_handler(_: Request, __: Exception) -> JSONResponse:
    api_error = FundXApiError(
        "internal_error",
        "Unable to complete the FundX API request.",
        500,
    )
    return JSONResponse(api_error.payload(), status_code=api_error.status)
