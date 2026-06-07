from __future__ import annotations

import re
from typing import Any


Classification = dict[str, str]


COMMON_STOCK_SUFFIXES = (
    " common stock",
    " common shares",
    " class a ordinary share",
    " class a ordinary shares",
    " class b ordinary share",
    " class b ordinary shares",
    " ordinary shares",
    " american depositary shares",
    " american depository shares",
)


def infer_asset_classification(asset: dict[str, Any]) -> Classification:
    existing_sector = clean_text(asset.get("sector"))
    existing_industry = clean_text(asset.get("industry"))
    existing_category = clean_text(asset.get("category"))

    if existing_sector and existing_industry:
        return {
            "sector": existing_sector,
            "industry": existing_industry,
            "category": existing_category or default_category(asset),
        }

    base = classify_us_asset(asset)
    return {
        "sector": existing_sector or base["sector"],
        "industry": existing_industry or base["industry"],
        "category": existing_category or base["category"],
    }


def enrich_asset_classification(asset: dict[str, Any]) -> dict[str, Any]:
    classification = infer_asset_classification(asset)
    return {
        **asset,
        "sector": classification["sector"],
        "industry": classification["industry"],
        "category": classification["category"],
    }


def classify_us_asset(asset: dict[str, Any]) -> Classification:
    if is_fund_like(asset):
        return classify_us_fund(asset)
    return classify_us_stock(asset)


def classify_us_fund(asset: dict[str, Any]) -> Classification:
    text = searchable_text(asset)

    for sector, industry, patterns in FUND_SECTOR_RULES:
        if any(pattern.search(text) for pattern in patterns):
            return {"sector": sector, "industry": industry, "category": default_category(asset)}

    return {"sector": "Broad Market", "industry": "Broad Market Fund", "category": default_category(asset)}


def classify_us_stock(asset: dict[str, Any]) -> Classification:
    text = searchable_text(asset)

    for sector, industry, patterns in STOCK_SECTOR_RULES:
        if any(pattern.search(text) for pattern in patterns):
            return {"sector": sector, "industry": industry, "category": default_category(asset)}

    return {"sector": "Diversified", "industry": "Diversified Equity", "category": default_category(asset)}


def default_category(asset: dict[str, Any]) -> str:
    if is_fund_like(asset):
        value = clean_text(asset.get("fundType") or asset.get("fundSubtype") or asset.get("category"))
        return value.upper() if value.lower() == "etf" else value or "Fund"
    return clean_text(asset.get("category")) or "Equity"


def is_fund_like(asset: dict[str, Any]) -> bool:
    asset_type = str(asset.get("assetType") or "").lower()
    kind = str(asset.get("kind") or "").lower()
    return kind == "fund" or asset_type in {"fund", "etf"}


def searchable_text(asset: dict[str, Any]) -> str:
    aliases = asset.get("aliases") if isinstance(asset.get("aliases"), list) else []
    values = [
        asset.get("name"),
        asset.get("symbol"),
        asset.get("exchange"),
        asset.get("assetType"),
        asset.get("kind"),
        asset.get("fundSubtype"),
        asset.get("fundType"),
        asset.get("category"),
        asset.get("industry"),
        asset.get("sector"),
        *aliases,
    ]
    text = " ".join(str(value) for value in values if value).lower()
    for suffix in COMMON_STOCK_SUFFIXES:
        text = text.replace(suffix, " ")
    return re.sub(r"\s+", " ", text).strip()


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def rx(*patterns: str) -> list[re.Pattern[str]]:
    return [re.compile(pattern, re.IGNORECASE) for pattern in patterns]


EXCLUDED_CHINA_THEME_PATTERNS = rx(
    r"\bchina\b",
    r"\bchinese\b",
    r"\bgreater china\b",
    r"\bcsi\s*(?:300|500|1000|2000)?\b",
    r"\bsse\b",
    r"\bszse\b",
    r"\bstar market\b",
    r"\bchina\s+a[-\s]?shares?\b",
    r"沪深|中证|上证|深证|A股|A 股",
)


def is_excluded_china_theme_asset(asset: dict[str, Any]) -> bool:
    text = searchable_text(asset)
    return any(pattern.search(text) for pattern in EXCLUDED_CHINA_THEME_PATTERNS)


FUND_SECTOR_RULES: list[tuple[str, str, list[re.Pattern[str]]]] = [
    (
        "Alternatives",
        "Crypto and Derivatives Fund",
        rx(
            r"\b(bitcoin|ether|ethereum|crypto|blockchain|digital asset)\b",
            r"\b(yieldmax|covered call|options? income|buffer|defined protection|leveraged|inverse|2x|3x|short)\b",
        ),
    ),
    (
        "Fixed Income",
        "Fixed Income Fund",
        rx(
            r"\b(treasur|bond|fixed income|municipal|muni|high yield|loan|mortgage|debt|credit|note|bill|maturity|income)\b",
        ),
    ),
    ("Technology", "Technology Fund", rx(r"\b(technology|semiconductor|software|internet|cyber|cloud|ai|robotics|nasdaq)\b")),
    ("Healthcare", "Healthcare Fund", rx(r"\b(health|healthcare|biotech|pharma|medical|genomic|therapeutic)\b")),
    ("Financials", "Financials Fund", rx(r"\b(financial|bank|insurance|fintech|capital markets)\b")),
    ("Energy", "Energy Fund", rx(r"\b(energy|oil|gas|solar|uranium|renewable|pipeline)\b")),
    ("Real Estate", "Real Estate Fund", rx(r"\b(real estate|reit|property|properties|mortgage reit)\b")),
    ("Materials", "Materials and Commodity Fund", rx(r"\b(materials|commodity|gold|silver|copper|mining|metal|lithium)\b")),
    ("Utilities", "Utilities Fund", rx(r"\b(utilities|utility|water|electric)\b")),
    ("Consumer Staples", "Consumer Staples Fund", rx(r"\b(staples|food|beverage|grocery|tobacco|agriculture)\b")),
    ("Consumer Discretionary", "Consumer Discretionary Fund", rx(r"\b(consumer discretionary|retail|travel|leisure|automotive|internet retail)\b")),
    ("Communication Services", "Communication Services Fund", rx(r"\b(communication|media|telecom|entertainment|streaming)\b")),
    ("Industrials", "Industrials Fund", rx(r"\b(industrial|infrastructure|aerospace|defense|transportation)\b")),
    (
        "Broad Market",
        "International Equity Fund",
        rx(r"\b(international|global|emerging|developed|eafe|ex-us|europe|asia|latin america)\b"),
    ),
    (
        "Broad Market",
        "Broad Market Fund",
        rx(r"\b(s&p|russell|dow|total market|large cap|mid cap|small cap|growth|value|dividend|equity|index)\b"),
    ),
]


STOCK_SECTOR_RULES: list[tuple[str, str, list[re.Pattern[str]]]] = [
    (
        "Real Estate",
        "Real Estate",
        rx(r"\b(reit|realty|real estate|property|properties|apartment|apartments|homes|housing|assets trust|hotel reit)\b"),
    ),
    (
        "Healthcare",
        "Healthcare",
        rx(
            r"\b(pharma|pharmaceutical|therapeutics?|biotech|biopharma|biologics?|medical|health|healthcare|laborator|diagnostic|oncology|immun|vaccine|clinical|life sciences|cannabis)\b",
        ),
    ),
    (
        "Technology",
        "Technology",
        rx(
            r"\b(technology|software|semiconductor|microelectronics|electronics|optoelectronics|digital|data|cloud|cyber|ai|artificial intelligence|robotics|computer|systems|network|wireless|internet|worldwide inc)\b",
        ),
    ),
    (
        "Financials",
        "Financials",
        rx(
            r"\b(acquisition|blank check|spac|bancorp|bank|financial|finance|capital|asset management|investment|insurance|insurtech|mortgage|credit|lending|payments?|brokerage|exchange|wealth|trust company|preferred stock|depositary shares|senior notes?)\b",
        ),
    ),
    ("Energy", "Energy", rx(r"\b(energy|oil|gas|petroleum|drilling|shale|pipeline|lng|solar|renewable|uranium|fuel|frac|profrac)\b")),
    (
        "Materials",
        "Materials",
        rx(r"\b(materials|mining|gold|silver|copper|steel|alcoa|aluminum|chemical|chemicals|lithium|battery|minerals|metal|metals|cement|paper|forest)\b"),
    ),
    (
        "Utilities",
        "Utilities",
        rx(r"\b(utility|utilities|electric|water|power generation|regulated|renewables utility)\b"),
    ),
    (
        "Consumer Staples",
        "Consumer Staples",
        rx(r"\b(food|foods|beverage|beverages|grocery|supermarket|tobacco|household|consumer staples|agriculture|farm|dairy|beer|wine|spirits)\b"),
    ),
    (
        "Consumer Discretionary",
        "Consumer Discretionary",
        rx(r"\b(retail|restaurant|automotive|auto parts|apparel|fashion|hotel|resort|casino|gaming|leisure|travel|airbnb|cruise|consumer|education|creativity)\b"),
    ),
    (
        "Communication Services",
        "Communication Services",
        rx(r"\b(telecom|communications?|media|entertainment|broadcast|newswire|publishing|cable|streaming|advertising|marketing|games?)\b"),
    ),
    (
        "Industrials",
        "Industrials",
        rx(
            r"\b(aerospace|defense|aviation|airlines?|industrial|industries|manufacturing|construction|engineering|machinery|logistics|transport|transportation|freight|marine|shipping|packaging|security|staffing|consulting|environmental|waste|infrastructure|holdings limited|group holdings)\b",
        ),
    ),
]
