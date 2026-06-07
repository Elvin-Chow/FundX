import type { AssetRecord, MarketId } from "./types";
import type { Language } from "./i18n";

const sectorCopy: Record<string, Record<Exclude<Language, "en">, string>> = {
  technology: { "zh-CN": "科技", "zh-TW": "科技" },
  healthcare: { "zh-CN": "医疗保健", "zh-TW": "醫療保健" },
  financials: { "zh-CN": "金融", "zh-TW": "金融" },
  "consumer staples": { "zh-CN": "必需消费", "zh-TW": "必需消費" },
  "consumer discretionary": { "zh-CN": "可选消费", "zh-TW": "非必需消費" },
  industrials: { "zh-CN": "工业", "zh-TW": "工業" },
  energy: { "zh-CN": "能源", "zh-TW": "能源" },
  utilities: { "zh-CN": "公用事业", "zh-TW": "公用事業" },
  "communication services": { "zh-CN": "通信服务", "zh-TW": "通訊服務" },
  materials: { "zh-CN": "材料", "zh-TW": "材料" },
  "real estate": { "zh-CN": "房地产", "zh-TW": "房地產" },
  diversified: { "zh-CN": "多元综合", "zh-TW": "多元綜合" },
  "broad market": { "zh-CN": "宽基市场", "zh-TW": "寬基市場" },
  "fixed income": { "zh-CN": "固定收益", "zh-TW": "固定收益" },
  treasury: { "zh-CN": "国债/现金", "zh-TW": "國債/現金" },
  equity: { "zh-CN": "股票型", "zh-TW": "股票型" },
  alternatives: { "zh-CN": "另类资产", "zh-TW": "另類資產" },
  "private credit": { "zh-CN": "私募信贷", "zh-TW": "私募信貸" },
  "index fund": { "zh-CN": "指数基金", "zh-TW": "指數基金" },
  growth: { "zh-CN": "成长", "zh-TW": "成長" },
  dividend: { "zh-CN": "红利", "zh-TW": "紅利" },
  "large blend": { "zh-CN": "大盘均衡", "zh-TW": "大盤均衡" },
  "large growth": { "zh-CN": "大盘成长", "zh-TW": "大盤成長" },
  "large value": { "zh-CN": "大盘价值", "zh-TW": "大盤價值" },
  "low volatility": { "zh-CN": "低波动", "zh-TW": "低波動" },
  "low-volatility fund": { "zh-CN": "低波动基金", "zh-TW": "低波動基金" },
  "quality value": { "zh-CN": "质量价值", "zh-TW": "品質價值" },
  "value fund": { "zh-CN": "价值基金", "zh-TW": "價值基金" },
  "bond fund": { "zh-CN": "债券基金", "zh-TW": "債券基金" },
  "defensive equity": { "zh-CN": "防御型股票", "zh-TW": "防禦型股票" },
  software: { "zh-CN": "软件", "zh-TW": "軟體" },
  semiconductors: { "zh-CN": "半导体", "zh-TW": "半導體" },
  pharma: { "zh-CN": "制药", "zh-TW": "製藥" },
  banking: { "zh-CN": "银行", "zh-TW": "銀行" },
  "integrated energy": { "zh-CN": "综合能源", "zh-TW": "綜合能源" },
  "household products": { "zh-CN": "家庭用品", "zh-TW": "家庭用品" },
  beverages: { "zh-CN": "饮料", "zh-TW": "飲料" },
  payments: { "zh-CN": "支付网络", "zh-TW": "支付網路" },
  conglomerate: { "zh-CN": "综合控股", "zh-TW": "綜合控股" },
  "reit—hotel & motel": { "zh-CN": "酒店 REIT", "zh-TW": "飯店 REIT" },
  "consumer cyclical": { "zh-CN": "周期消费", "zh-TW": "週期消費" },
  "auto & truck dealerships": { "zh-CN": "汽车经销", "zh-TW": "汽車經銷" },
  "consumer electronics": { "zh-CN": "消费电子", "zh-TW": "消費電子" },
};

const companyCopy: Record<string, Record<Exclude<Language, "en">, string>> = {
  vanguard: { "zh-CN": "先锋领航", "zh-TW": "先鋒領航" },
  ishares: { "zh-CN": "贝莱德 iShares", "zh-TW": "貝萊德 iShares" },
  schwab: { "zh-CN": "嘉信理财", "zh-TW": "嘉信理財" },
  invesco: { "zh-CN": "景顺", "zh-TW": "景順" },
  "state street": { "zh-CN": "道富", "zh-TW": "道富" },
};

const symbolNameCopy: Record<string, Record<Exclude<Language, "en">, string>> = {
  AAPL: { "zh-CN": "苹果公司", "zh-TW": "蘋果公司" },
  MSFT: { "zh-CN": "微软", "zh-TW": "微軟" },
  NVDA: { "zh-CN": "英伟达", "zh-TW": "輝達" },
  TSLA: { "zh-CN": "特斯拉", "zh-TW": "特斯拉" },
  GOOGL: { "zh-CN": "Alphabet A 类", "zh-TW": "Alphabet A 類" },
  GOOG: { "zh-CN": "Alphabet C 类", "zh-TW": "Alphabet C 類" },
  AMZN: { "zh-CN": "亚马逊", "zh-TW": "亞馬遜" },
  META: { "zh-CN": "Meta Platforms", "zh-TW": "Meta Platforms" },
  BRK: { "zh-CN": "伯克希尔哈撒韦", "zh-TW": "波克夏海瑟威" },
  "BRK.B": { "zh-CN": "伯克希尔哈撒韦 B", "zh-TW": "波克夏海瑟威 B" },
  JPM: { "zh-CN": "摩根大通", "zh-TW": "摩根大通" },
  JNJ: { "zh-CN": "强生", "zh-TW": "嬌生" },
  XOM: { "zh-CN": "埃克森美孚", "zh-TW": "埃克森美孚" },
  PG: { "zh-CN": "宝洁", "zh-TW": "寶僑" },
  KO: { "zh-CN": "可口可乐", "zh-TW": "可口可樂" },
  V: { "zh-CN": "Visa", "zh-TW": "Visa" },
  AMD: { "zh-CN": "超威半导体", "zh-TW": "超微半導體" },
  MU: { "zh-CN": "美光科技", "zh-TW": "美光科技" },
  MRVL: { "zh-CN": "迈威尔科技", "zh-TW": "邁威爾科技" },
  APLE: { "zh-CN": "Apple Hospitality REIT", "zh-TW": "Apple Hospitality REIT" },
  SPY: { "zh-CN": "标普 500 ETF", "zh-TW": "標普 500 ETF" },
  VOO: { "zh-CN": "先锋标普 500 ETF", "zh-TW": "先鋒標普 500 ETF" },
  QQQ: { "zh-CN": "纳斯达克 100 ETF", "zh-TW": "納斯達克 100 ETF" },
  SCHD: { "zh-CN": "嘉信美国红利 ETF", "zh-TW": "嘉信美國紅利 ETF" },
};

export function assetDisplayName(asset: Pick<AssetRecord, "name" | "symbol">, language: Language) {
  if (language !== "en") {
    const translated = symbolNameCopy[asset.symbol?.toUpperCase()]?.[language];
    if (translated) return translated;
  }
  return cleanAssetName(asset.name);
}

export function assetOriginalName(asset: Pick<AssetRecord, "name" | "symbol">, language: Language) {
  const display = assetDisplayName(asset, language);
  return display === cleanAssetName(asset.name) ? asset.symbol : cleanAssetName(asset.name);
}

export function localizedAssetSector(value: string | null | undefined, language: Language) {
  if (!value) return "";
  if (language === "en") return value;
  return sectorCopy[value.toLowerCase()]?.[language] ?? value;
}

export function localizedFundCompany(value: string | null | undefined, language: Language) {
  if (!value) return "";
  if (language === "en") return value;
  return companyCopy[value.toLowerCase()]?.[language] ?? value;
}

export function assetKindLabel(asset: Partial<Pick<AssetRecord, "kind" | "assetType" | "fundSubtype" | "fundType">>, language: Language) {
  const isFund = asset.kind === "fund" || asset.assetType === "fund" || asset.assetType === "etf";
  if (language === "en") return isFund ? (asset.fundType || asset.fundSubtype || "Fund") : "Stock";
  if (language === "zh-TW") return isFund ? (asset.fundSubtype === "etf" || asset.assetType === "etf" ? "ETF / 基金" : "基金") : "股票";
  return isFund ? (asset.fundSubtype === "etf" || asset.assetType === "etf" ? "ETF / 基金" : "基金") : "股票";
}

export function assetPrimaryCategory(asset: Pick<AssetRecord, "sector" | "industry" | "category" | "fundCompany">, language: Language) {
  return localizedAssetSector(asset.sector ?? asset.industry ?? asset.category, language)
    || localizedFundCompany(asset.fundCompany, language)
    || "";
}

export function quoteStatusLabel(asset: Pick<AssetRecord, "quoteStatus" | "latestPrice">, language: Language) {
  if (asset.quoteStatus === "fresh" && asset.latestPrice != null) {
    if (language === "zh-CN") return "已更新报价";
    if (language === "zh-TW") return "已更新報價";
    return "Quote ready";
  }
  if (language === "zh-CN") return "基础资料";
  if (language === "zh-TW") return "基礎資料";
  return "Profile only";
}

export function marketCurrencyHint(marketId: MarketId, language: Language) {
  if (language === "zh-CN") return "美元市场";
  if (language === "zh-TW") return "美元市場";
  return "USD market";
}

function cleanAssetName(value: string) {
  return value
    .replace(/\s+Class ([ABC]) Common Stock$/i, " Class $1")
    .replace(/\s+Common Stock$/i, "")
    .replace(/\s+Common Shares$/i, "")
    .replace(/\s+\(The\)/i, "")
    .trim();
}
