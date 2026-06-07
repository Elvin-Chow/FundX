from __future__ import annotations

import os
from typing import Any, Literal

from .errors import FundXApiError, validation_error
from .services import LOCAL_USER_ID, MarketId, clone_json, now_iso

ProviderName = Literal["longbridge"]
FieldSource = Literal["local", "environment", "missing"]

PROVIDER_ACCOUNT_DEFINITIONS: dict[ProviderName, dict[str, Any]] = {
    "longbridge": {
        "marketId": "us",
        "label": "Longbridge",
        "description": "US and HK-capable brokerage quote credentials for the Longbridge OpenAPI SDK.",
        "secretFields": [
            {"name": "appKey", "label": "App Key", "env": ["LONGBRIDGE_APP_KEY"], "required": True},
            {"name": "appSecret", "label": "App Secret", "env": ["LONGBRIDGE_APP_SECRET"], "required": True},
            {"name": "accessToken", "label": "Access Token", "env": ["LONGBRIDGE_ACCESS_TOKEN"], "required": True},
        ],
        "configFields": [
            {"name": "region", "label": "Region", "env": ["LONGBRIDGE_REGION"], "default": "", "options": ["", "hk"]},
        ],
    },
}


def provider_definitions_for_market(market_id: MarketId) -> list[dict[str, Any]]:
    return [
        {"provider": provider, **clone_json(definition)}
        for provider, definition in PROVIDER_ACCOUNT_DEFINITIONS.items()
        if definition.get("marketId") == market_id
    ]


def list_provider_accounts(user_id: str, market_id: MarketId) -> dict[str, Any]:
    return {
        "marketId": market_id,
        "updatedAt": now_iso(),
        "accounts": [provider_account_summary({"providerAccounts": []}, user_id, market_id, definition["provider"]) for definition in provider_definitions_for_market(market_id)],
    }


def save_provider_account(user_id: str, market_id: MarketId, payload: dict[str, Any]) -> dict[str, Any]:
    provider = parse_provider(payload.get("provider"))
    provider_definition(provider, market_id)
    if payload.get("clear") is True:
        return clear_provider_account(user_id, market_id, provider)

    return {
        "ok": True,
        "marketId": market_id,
        "updatedAt": now_iso(),
        "message": "Provider credentials are read from backend environment variables in browser-local user data mode.",
        "account": provider_account_summary({"providerAccounts": []}, user_id, market_id, provider),
        "accounts": list_provider_accounts(user_id, market_id)["accounts"],
    }


def clear_provider_account(user_id: str, market_id: MarketId, provider: ProviderName) -> dict[str, Any]:
    return {
        "ok": True,
        "marketId": market_id,
        "updatedAt": now_iso(),
        "message": "Provider credentials are read from backend environment variables in browser-local user data mode.",
        "account": provider_account_summary({"providerAccounts": []}, user_id, market_id, provider),
        "accounts": list_provider_accounts(user_id, market_id)["accounts"],
    }


def provider_account_summary(db: dict[str, Any], user_id: str, market_id: MarketId, provider: ProviderName) -> dict[str, Any]:
    definition = provider_definition(provider, market_id)
    account = find_provider_account(db, user_id, market_id, provider)
    enabled = provider_enabled_from_record(account)
    secret_fields = [field_summary(account, field, secret=True) for field in definition.get("secretFields", [])]
    config_fields = [field_summary(account, field, secret=False) for field in definition.get("configFields", [])]
    required_secret_fields = [field for field in secret_fields if field.get("required")]
    configured = enabled and all(field.get("configured") for field in required_secret_fields)
    if not required_secret_fields:
        configured = enabled
    source = account_source(secret_fields, config_fields)

    return {
        "provider": provider,
        "marketId": market_id,
        "label": definition.get("label"),
        "description": definition.get("description"),
        "enabled": enabled,
        "configured": configured,
        "source": source,
        "secretFields": secret_fields,
        "configFields": config_fields,
    }


def get_provider_secret(provider: ProviderName, field_name: str, market_id: MarketId, user_id: str | None = None) -> str:
    return provider_field_value(provider, field_name, market_id, user_id or LOCAL_USER_ID, secret=True)


def get_provider_config(provider: ProviderName, field_name: str, market_id: MarketId, user_id: str | None = None, default: str = "") -> str:
    value = provider_field_value(provider, field_name, market_id, user_id or LOCAL_USER_ID, secret=False)
    return value if value else default


def provider_credentials_ready(provider: ProviderName, market_id: MarketId, user_id: str | None = None) -> bool:
    definition = provider_definition(provider, market_id)
    if not provider_enabled(provider, market_id, user_id):
        return False
    required = [field for field in definition.get("secretFields", []) if field.get("required")]
    return all(get_provider_secret(provider, str(field.get("name")), market_id, user_id) for field in required)


def provider_enabled(provider: ProviderName, market_id: MarketId, user_id: str | None = None) -> bool:
    account = find_provider_account(read_provider_accounts_or_empty(), user_id or LOCAL_USER_ID, market_id, provider)
    return provider_enabled_from_record(account)


def provider_field_value(provider: ProviderName, field_name: str, market_id: MarketId, user_id: str, *, secret: bool) -> str:
    definition = provider_definition(provider, market_id)
    account = find_provider_account(read_provider_accounts_or_empty(), user_id, market_id, provider)
    if not provider_enabled_from_record(account):
        return ""
    fields_key = "secretFields" if secret else "configFields"
    field = next((item for item in definition.get(fields_key, []) if item.get("name") == field_name), None)
    if not field:
        return ""
    env_value = first_env_value(field.get("env", []))
    if env_value:
        return env_value
    return str(field.get("default") or "").strip()


def provider_definition(provider: ProviderName, market_id: MarketId | None = None) -> dict[str, Any]:
    definition = PROVIDER_ACCOUNT_DEFINITIONS.get(provider)
    if not definition:
        raise FundXApiError("invalid_request", "Unsupported provider account.", 400)
    if market_id and definition.get("marketId") != market_id:
        raise FundXApiError("market_mismatch", "Provider does not belong to the active market.", 400)
    return definition


def parse_provider(value: Any) -> ProviderName:
    provider = str(value or "").strip().lower().replace("_", "-")
    if provider not in PROVIDER_ACCOUNT_DEFINITIONS:
        raise validation_error("provider must be: longbridge.")
    return provider  # type: ignore[return-value]


def find_provider_account(db: dict[str, Any], user_id: str, market_id: MarketId, provider: ProviderName) -> dict[str, Any] | None:
    return next(
        (
            account
            for account in db.get("providerAccounts", [])
            if account.get("userId") == user_id and account.get("marketId") == market_id and account.get("provider") == provider
        ),
        None,
    )


def read_provider_accounts_or_empty() -> dict[str, Any]:
    return {"providerAccounts": []}


def field_summary(account: dict[str, Any] | None, field: dict[str, Any], *, secret: bool) -> dict[str, Any]:
    name = str(field.get("name"))
    _ = account
    env_value = first_env_value(field.get("env", []))
    default_value = str(field.get("default") or "").strip()
    value = env_value or ("" if secret else default_value)
    source: FieldSource = "environment" if env_value else "missing"
    return {
        "name": name,
        "label": field.get("label") or name,
        "secret": secret,
        "required": bool(field.get("required", False)),
        "configured": bool(value) if secret else True,
        "masked": mask_secret(value) if secret and value else "",
        "value": "" if secret else value,
        "source": source,
        **({"options": field.get("options")} if isinstance(field.get("options"), list) else {}),
    }


def provider_enabled_from_record(account: dict[str, Any] | None) -> bool:
    return not (isinstance(account, dict) and account.get("enabled") is False)


def first_env_value(names: Any) -> str:
    if not isinstance(names, list):
        return ""
    for name in names:
        value = str(os.environ.get(str(name)) or "").strip()
        if value:
            return value
    return ""


def account_source(secret_fields: list[dict[str, Any]], config_fields: list[dict[str, Any]]) -> FieldSource:
    fields = [*secret_fields, *config_fields]
    if any(field.get("source") == "local" for field in fields):
        return "local"
    if any(field.get("source") == "environment" for field in fields):
        return "environment"
    return "missing"


def mask_secret(value: str) -> str:
    text = str(value or "").strip()
    if len(text) <= 4:
        return "****"
    return f"**** {text[-4:]}"


def validate_config_value(field: dict[str, Any], value: str) -> None:
    options = field.get("options")
    if isinstance(options, list) and value not in [str(option) for option in options]:
        raise validation_error(f"{field.get('name')} is not a supported option.")
    if field.get("name") == "port":
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            raise validation_error("port must be a number.")
        if parsed <= 0 or parsed > 65535:
            raise validation_error("port must be between 1 and 65535.")
