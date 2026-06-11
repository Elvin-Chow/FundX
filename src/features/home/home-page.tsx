"use client";

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { CustomSelect } from "@/components/custom-select";
import { useCustomFunds } from "@/hooks/use-custom-funds";
import { useResolvedLanguage } from "@/hooks/use-language";
import { apiGet } from "@/lib/api-client";
import type { AssetDetailResponse, MarketTopResponse, PortfolioResponse } from "@/lib/api-contracts";
import { localizedAssetSector } from "@/lib/asset-display";
import { formatCompactCurrency, formatCurrency, formatNumber, formatOptionalCompactCurrency, formatOptionalPercent, formatPercent } from "@/lib/formatters";
import { assetTypeLabel, getMarketCopy, t, type Language } from "@/lib/i18n";
import { buildLocalPortfolioResponse } from "@/lib/local-user-data";
import { createReturnToState, locationToReturnTo } from "@/lib/navigation-state";
import type { AssetRecord, CustomFundRecord, CustomFundUniverseItem, MarketId, PortfolioSummary, TimePoint } from "@/lib/types";
import { cn } from "@/lib/utils";
import { normalizeMarket, type Market } from "../../components/types";
import { readCustomFundResultCache } from "../custom-fund/custom-fund-result-store";
import { AssetList, LoadingRows, PageHeader, Section, StatusBanner } from "../shared/feature-shell";
import { useApiResource } from "@/hooks/use-api-resource";

type MarketTopsResponse = {
  marketId: MarketId;
  stocks: MarketTopResponse;
  funds: MarketTopResponse;
};

type HomeDisplaySelection = {
  kind: "portfolio" | "customFund";
  id: string;
};

type HomeAssetQuoteRequest = {
  id: string;
  assetType: AssetRecord["assetType"];
};

type HomeAssetQuote = {
  id: string;
  assetType: AssetRecord["assetType"];
  price: number | null;
  dailyChange: number | null;
  history: TimePoint[];
  updatedAt?: string;
};

type PortfolioDisplaySummary = {
  totalValue: number;
  holdings: PortfolioSummary["holdings"];
};

type CustomFundDisplayValue = {
  value: number | null;
  dailyChange: number | null;
  pricedCount: number;
  updatedAt?: string;
};

const autoTopRefreshInFlight = new Set<MarketId>();
const topMarketRefreshMemory = new Map<MarketId, number>();

export function HomePage({ market = "us", marketId, language: languageProp = "en" }: { market?: Market; marketId?: Market; language?: Language }) {
  const activeMarket = normalizeMarket(marketId ?? market);
  const language = useResolvedLanguage(languageProp);
  const location = useLocation();
  const [cachedTopStocks, setCachedTopStocks] = useState<MarketTopResponse | null>(() => readTopStocksCache(activeMarket));
  const [cachedTopFunds, setCachedTopFunds] = useState<MarketTopResponse | null>(() => readTopAssetsCache(activeMarket, "fund"));
  const [topRefreshStatus, setTopRefreshStatus] = useState(() => topRefreshCopy(language, "ready"));
  const [topRefreshInFlight, setTopRefreshInFlight] = useState(false);
  const [homeSelection, setHomeSelection] = useState<HomeDisplaySelection | null>(() => readHomeDisplaySelection(activeMarket));
  const [customFundResultCache, setCustomFundResultCache] = useState(() => readCustomFundResultCache(activeMarket));
  const [topAutoRefreshTick, setTopAutoRefreshTick] = useState(0);
  const selectedPortfolioId = homeSelection?.kind === "portfolio" ? homeSelection.id : "";
  const selectedCustomFundId = homeSelection?.kind === "customFund" ? homeSelection.id : "";
  const load = useCallback(
    (_signal: AbortSignal) => Promise.resolve(buildLocalPortfolioResponse(activeMarket, selectedPortfolioId, "ALL") satisfies PortfolioResponse),
    [activeMarket, selectedPortfolioId],
  );
  const resource = useApiResource(load, [load], { keepPreviousData: true });
  const refreshPortfolioResource = resource.refresh;
  const customFunds = useCustomFunds(activeMarket);
  const loadMarketTops = useCallback(
    async (signal: AbortSignal): Promise<MarketTopsResponse> => {
      const cached = readFreshMarketTopsCache(activeMarket);
      if (cached) return cached;
      const [stocks, funds] = await Promise.all([
        apiGet<MarketTopResponse>("/api/market/top", { market: activeMarket, kind: "stock", limit: 10 }, signal),
        apiGet<MarketTopResponse>("/api/market/top", { market: activeMarket, kind: "fund", limit: 10 }, signal),
      ]);
      return { marketId: activeMarket, stocks, funds };
    },
    [activeMarket],
  );
  const marketTops = useApiResource(loadMarketTops, [loadMarketTops], {
    cacheKey: `home-market-tops:${activeMarket}`,
    keepPreviousData: true,
    staleTimeMs: TOP_CACHE_MAX_AGE_MS,
  });
  const liveTopStocks = useMemo(() => sanitizeTopAssetsResponse(marketTops.data?.marketId === activeMarket ? marketTops.data.stocks : null), [activeMarket, marketTops.data]);
  const liveTopFunds = useMemo(() => sanitizeTopAssetsResponse(marketTops.data?.marketId === activeMarket ? marketTops.data.funds : null), [activeMarket, marketTops.data]);
  const displayedTopStocks = useMemo(() => liveTopStocks ?? sanitizeTopAssetsResponse(cachedTopStocks), [cachedTopStocks, liveTopStocks]);
  const displayedTopFunds = useMemo(() => liveTopFunds ?? sanitizeTopAssetsResponse(cachedTopFunds), [cachedTopFunds, liveTopFunds]);
  const data = resource.data;
  const portfolioOptions = data?.portfolios ?? [];
  const customFundOptions = useMemo(() => customFunds.data?.customFunds ?? [], [customFunds.data?.customFunds]);
  const customFundUniverse = useMemo(() => customFunds.data?.universe ?? [], [customFunds.data?.universe]);
  const customFundById = useMemo(() => new Map(customFundOptions.map((fund) => [fund.id, fund])), [customFundOptions]);
  const universeById = useMemo(() => new Map(customFundUniverse.map((asset) => [asset.id, asset])), [customFundUniverse]);
  const rawPortfolio = selectedPortfolioId ? data?.portfolio : null;
  const portfolio = rawPortfolio && !isDisplayFixturePortfolio(rawPortfolio) ? rawPortfolio : undefined;
  const summary = portfolio?.id === selectedPortfolioId && data?.summary ? data.summary : undefined;
  const portfolioDataUpdatedAt = resource.updatedAt ?? data?.updatedAt ?? portfolio?.updatedAt;
  const selectedCustomFund = selectedCustomFundId ? customFundById.get(selectedCustomFundId) ?? null : null;
  const homeQuoteRequests = useMemo(
    () => buildHomeQuoteRequests(homeSelection, portfolio, selectedCustomFund),
    [homeSelection, portfolio, selectedCustomFund],
  );
  const homeQuoteCacheKey = useMemo(
    () => `home-quotes:${activeMarket}:${homeQuoteRequests.map((request) => `${request.assetType}:${request.id}`).join(",")}`,
    [activeMarket, homeQuoteRequests],
  );
  const loadHomeQuotes = useCallback(
    (signal: AbortSignal) => loadLatestHomeAssetQuotes(activeMarket, homeQuoteRequests, signal),
    [activeMarket, homeQuoteRequests],
  );
  const homeQuotes = useApiResource(loadHomeQuotes, [loadHomeQuotes], {
    cacheKey: homeQuoteCacheKey,
    enabled: homeQuoteRequests.length > 0,
    keepPreviousData: true,
    staleTimeMs: 60_000,
  });
  const homeQuoteById = useMemo(() => {
    const selectedIds = new Set(homeQuoteRequests.map((request) => request.id));
    const quotes = new Map<string, HomeAssetQuote>();
    for (const quote of homeQuotes.data ?? []) {
      if (selectedIds.has(quote.id)) quotes.set(quote.id, quote);
    }
    return quotes;
  }, [homeQuoteRequests, homeQuotes.data]);
  const portfolioDisplay = useMemo(
    () => (summary ? buildPortfolioDisplaySummary(summary, homeQuoteById) : null),
    [homeQuoteById, summary],
  );
  const selectedCustomFundSummary = useMemo(
    () => selectedCustomFund ? resolveCustomFundResultSummary(selectedCustomFund, customFundResultCache) : null,
    [customFundResultCache, selectedCustomFund],
  );
  const customFundDisplay = useMemo(
    () => (selectedCustomFund ? buildCustomFundDisplayValue(selectedCustomFund, selectedCustomFundSummary, homeQuoteById, universeById) : null),
    [homeQuoteById, selectedCustomFund, selectedCustomFundSummary, universeById],
  );
  const displayedPortfolioValue = portfolioDisplay?.totalValue ?? (summary ? currentPortfolioValue(summary) : null);
  const displayedCustomFundValue = customFundDisplay?.value ?? null;
  const portfolioAssets = (portfolioDisplay?.holdings ?? summary?.holdings ?? []).slice(0, 6).map((holding) => ({
    id: holding.id,
    name: holding.name,
    symbol: holding.symbol,
    subtitle: `${assetTypeLabel(language, holding.assetType)} · ${holding.sector}`,
    value: formatCurrency(holding.marketValue, activeMarket),
    delta: formatPercent(holding.gainPercent),
    tone: holding.gain >= 0 ? "positive" as const : "negative" as const,
  }));
  const customFundAssets = selectedCustomFund ? customFundRows(selectedCustomFund, universeById, homeQuoteById, activeMarket, language) : [];
  const assets = homeSelection?.kind === "customFund" ? customFundAssets : portfolioAssets;
  const hasPortfolioData = Boolean(portfolio && summary);
  const hasHomeDisplayData = homeSelection?.kind === "customFund" ? Boolean(selectedCustomFund && customFundAssets.length) : hasPortfolioData && portfolioAssets.length > 0;
  const refreshingMarketTops = topRefreshInFlight;
  const homeSelectionValue = homeSelection ? serializeHomeDisplaySelection(homeSelection) : "";
  const detailReturnState = createReturnToState(locationToReturnTo(location));
  const homeDisplayOptions = [
    { value: "", label: t(language, "home.portfolioPickerPlaceholder") },
    ...portfolioOptions.map((item) => ({
      value: serializeHomeDisplaySelection({ kind: "portfolio", id: item.id }),
      label: item.name,
      description: t(language, "portfolio.savedPortfolios"),
    })),
    ...customFundOptions.map((item) => ({
      value: serializeHomeDisplaySelection({ kind: "customFund", id: item.id }),
      label: item.name,
      description: t(language, "custom.savedFunds"),
    })),
  ];

  function selectHomeDisplay(value: string) {
    const nextSelection = parseHomeDisplaySelection(value);
    setHomeSelection(nextSelection);
    writeHomeDisplaySelection(activeMarket, nextSelection);
  }

  const refreshTopMarkets = useCallback(
    async (mode: "auto" | "force" = "force") => {
      if (mode === "auto") {
        if (!claimTopMarketAutoRefresh(activeMarket)) {
          setTopRefreshStatus(topRefreshCopy(language, "cached"));
          return;
        }
      }
      setTopRefreshInFlight(true);
      setTopRefreshStatus(topRefreshCopy(language, mode === "auto" ? "cached" : "refreshing"));
      try {
        const refreshValue = mode === "auto" ? "auto" : "true";
        const [stocks, funds] = await Promise.all([
          apiGet<MarketTopResponse>("/api/market/top", { market: activeMarket, kind: "stock", limit: 10, refresh: refreshValue }),
          apiGet<MarketTopResponse>("/api/market/top", { market: activeMarket, kind: "fund", limit: 10, refresh: refreshValue }),
        ]);
        marketTops.setData({ marketId: activeMarket, stocks, funds });
        const bothSkipped = stocks.refreshSkipped === "recent" && funds.refreshSkipped === "recent";
        const refreshSucceeded = didTopMarketRefreshSucceed(stocks, funds);
        if (refreshSucceeded) {
          writeTopMarketRefreshAt(activeMarket);
          void refreshPortfolioResource("reload");
        }
        setTopRefreshStatus(topRefreshCopy(language, bothSkipped ? "fresh" : refreshSucceeded ? "updated" : "failed"));
      } catch {
        setTopRefreshStatus(topRefreshCopy(language, "failed"));
      } finally {
        setTopRefreshInFlight(false);
        if (mode === "auto") autoTopRefreshInFlight.delete(activeMarket);
      }
    },
    [activeMarket, language, marketTops, refreshPortfolioResource],
  );

  useEffect(() => {
    purgeLegacyTopAssetCaches(activeMarket);
    setHomeSelection(readHomeDisplaySelection(activeMarket));
    setCustomFundResultCache(readCustomFundResultCache(activeMarket));
    setCachedTopStocks(readTopStocksCache(activeMarket));
    setCachedTopFunds(readTopAssetsCache(activeMarket, "fund"));
    setTopRefreshStatus(topRefreshCopy(language, isTopAssetsCacheFresh(activeMarket, "stock") || isTopAssetsCacheFresh(activeMarket, "fund") ? "cached" : "ready"));
  }, [activeMarket, language]);

  useEffect(() => {
    if (!homeSelection || resource.loading || customFunds.loading || !data?.portfolios || !customFunds.data?.customFunds) return;
    const selectionExists = homeSelection.kind === "portfolio"
      ? data.portfolios.some((item) => item.id === homeSelection.id)
      : customFunds.data.customFunds.some((item) => item.id === homeSelection.id);
    if (selectionExists) return;
    setHomeSelection(null);
    writeHomeDisplaySelection(activeMarket, null);
  }, [activeMarket, customFunds.data?.customFunds, customFunds.loading, data?.portfolios, homeSelection, resource.loading]);

  useEffect(() => {
    if (!liveTopStocks?.items.length) return;
    writeTopStocksCache(activeMarket, liveTopStocks);
    setCachedTopStocks(liveTopStocks);
  }, [activeMarket, liveTopStocks]);

  useEffect(() => {
    if (!liveTopFunds?.items.length) return;
    writeTopAssetsCache(activeMarket, "fund", liveTopFunds);
    setCachedTopFunds(liveTopFunds);
  }, [activeMarket, liveTopFunds]);

  useEffect(() => {
    if (marketTops.loading || marketTops.reloading || marketTops.data?.marketId !== activeMarket) return;
    const bothSkipped = marketTops.data.stocks.refreshSkipped === "recent" && marketTops.data.funds.refreshSkipped === "recent";
    const didRefresh = Boolean(marketTops.data.stocks.refreshed || marketTops.data.funds.refreshed);
    setTopRefreshStatus(topRefreshCopy(language, bothSkipped ? "fresh" : didRefresh && liveTopStocks && liveTopFunds ? "updated" : liveTopStocks && liveTopFunds ? "cached" : "failed"));
  }, [activeMarket, language, liveTopFunds, liveTopStocks, marketTops.data, marketTops.loading, marketTops.reloading]);

  useEffect(() => {
    if (marketTops.loading || marketTops.reloading || topRefreshInFlight) return;
    const waitMs = msUntilTopMarketAutoRefresh(activeMarket);
    if (waitMs > 0) {
      setTopRefreshStatus(topRefreshCopy(language, liveTopStocks && liveTopFunds ? "cached" : "ready"));
      const timeout = window.setTimeout(() => setTopAutoRefreshTick((current) => current + 1), waitMs);
      return () => window.clearTimeout(timeout);
    }
    if (isDocumentHidden()) {
      setTopRefreshStatus(topRefreshCopy(language, liveTopStocks && liveTopFunds ? "cached" : "ready"));
      return;
    }
    if (shouldAutoRefreshTopMarkets(activeMarket)) {
      const timeout = window.setTimeout(() => void refreshTopMarkets("auto"), TOP_AUTO_REFRESH_DELAY_MS);
      return () => window.clearTimeout(timeout);
    }
    setTopRefreshStatus(topRefreshCopy(language, liveTopStocks && liveTopFunds ? "cached" : "ready"));
    return;
  }, [activeMarket, language, liveTopFunds, liveTopStocks, marketTops.loading, marketTops.reloading, refreshTopMarkets, topAutoRefreshTick, topRefreshInFlight]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const recheck = () => setTopAutoRefreshTick((current) => current + 1);
    const recheckWhenVisible = () => {
      if (!isDocumentHidden()) recheck();
    };
    window.addEventListener("focus", recheck);
    window.addEventListener("pageshow", recheck);
    window.addEventListener("online", recheck);
    document.addEventListener("visibilitychange", recheckWhenVisible);
    return () => {
      window.removeEventListener("focus", recheck);
      window.removeEventListener("pageshow", recheck);
      window.removeEventListener("online", recheck);
      document.removeEventListener("visibilitychange", recheckWhenVisible);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const watchedKeys = new Set([
      topMarketRefreshKey(activeMarket),
      topAssetsCacheKey(activeMarket, "stock"),
      topAssetsCacheKey(activeMarket, "fund"),
    ]);
    const syncTopMarketState = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage || !event.key || !watchedKeys.has(event.key)) return;
      setCachedTopStocks(readTopStocksCache(activeMarket));
      setCachedTopFunds(readTopAssetsCache(activeMarket, "fund"));
      setTopAutoRefreshTick((current) => current + 1);
    };
    window.addEventListener("storage", syncTopMarketState);
    return () => window.removeEventListener("storage", syncTopMarketState);
  }, [activeMarket]);

  const topStockRows = (displayedTopStocks?.items ?? []).map((asset) => ({
    id: asset.id,
    name: asset.name,
    symbol: asset.symbol,
    href: assetDetailHref(asset, activeMarket, language),
    linkState: detailReturnState,
    subtitle: [asset.exchange, asset.sector ?? asset.industry].filter(Boolean).join(" · "),
    value: formatCompactCurrency(assetTurnover(asset), activeMarket),
    delta: `${formatOptionalCompactCurrency(asset.latestPrice, activeMarket)} · ${formatOptionalPercent(asset.dailyChange, 1, "")}`,
    tone: (asset.dailyChange ?? 0) >= 0 ? "positive" as const : "negative" as const,
  }));
  const topFundRows = (displayedTopFunds?.items ?? []).map((asset) => ({
    id: asset.id,
    name: asset.name,
    symbol: asset.symbol,
    href: assetDetailHref(asset, activeMarket, language),
    linkState: detailReturnState,
    subtitle: [asset.exchange, asset.fundSubtype ?? asset.category].filter(Boolean).join(" · "),
    value: formatCompactCurrency(assetTurnover(asset), activeMarket),
    delta: formatOptionalPercent(asset.dailyChange, 1, ""),
    tone: (asset.dailyChange ?? 0) >= 0 ? "positive" as const : "negative" as const,
  }));

  return (
    <div>
      <PageHeader
        eyebrow={`${getMarketCopy(language, activeMarket).shortName} ${t(language, "nav.portfolio")}`}
        title={homeSelection?.kind === "customFund"
          ? displayedCustomFundValue != null
            ? formatCurrency(displayedCustomFundValue, activeMarket)
            : (customFunds.loading || homeQuotes.loading) ? t(language, "home.loadingPortfolio") : t(language, "home.noPortfolioTitle")
          : selectedPortfolioId
            ? displayedPortfolioValue != null ? formatCurrency(displayedPortfolioValue, activeMarket) : resource.loading ? t(language, "home.loadingPortfolio") : t(language, "home.noPortfolioTitle")
            : t(language, "home.selectPortfolioTitle")}
        description={
          homeSelection?.kind === "customFund" && selectedCustomFund
            ? customFundDescription(selectedCustomFund, language, customFundDisplay)
            : selectedPortfolioId && portfolio && summary
            ? resource.reloading
              ? t(language, "home.rangeRefreshing", { range: portfolioPeriodLabel(summary, language, portfolio) })
              : portfolioDailyDescription(summary, language, activeMarket, homeQuotes.updatedAt ?? portfolioDataUpdatedAt ?? portfolio.updatedAt, portfolio)
            : homeSelection && (resource.loading || customFunds.loading)
              ? t(language, "home.readingPortfolio")
              : portfolioOptions.length || customFundOptions.length
                ? t(language, "home.selectPortfolioBody")
                : t(language, "home.noPortfolioBody")
        }
        action={
          <label className="block w-full sm:w-72">
            <span className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">{t(language, "home.portfolioPicker")}</span>
            <CustomSelect
              ariaLabel={t(language, "home.portfolioPicker")}
              value={homeSelectionValue}
              placeholder={t(language, "home.portfolioPickerPlaceholder")}
              options={homeDisplayOptions}
              onChange={selectHomeDisplay}
            />
          </label>
        }
      />
      {resource.error || customFunds.error ? (
        <Section>
          <StatusBanner title={resource.error ?? customFunds.error ?? ""} body={t(language, "home.errorBody")} tone="neutral" />
        </Section>
      ) : null}
      <Section
        title={t(language, "common.market")}
        subtitle={topRefreshStatus}
        action={
          <button
            type="button"
            onClick={() => void refreshTopMarkets("force")}
            disabled={refreshingMarketTops}
            className="inline-flex h-10 items-center gap-2 rounded border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-400 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-200 dark:hover:bg-white/10 dark:disabled:text-zinc-500"
          >
            <RefreshCw size={16} className={refreshingMarketTops ? "animate-spin" : ""} />
            {t(language, "common.reload")}
          </button>
        }
      >
        <div className={cn("grid gap-6 lg:grid-cols-2", refreshingMarketTops && "transition")}>
          <Section title={t(language, "home.topMarketStocks")}>
            {marketTops.loading && !topStockRows.length ? <LoadingRows rows={4} /> : topStockRows.length ? <AssetList assets={topStockRows} /> : <StatusBanner title={t(language, "home.noRealTopStocksTitle")} body={t(language, "home.noRealTopStocksBody")} />}
          </Section>
          <Section title={t(language, "home.topMarketFunds")}>
            {marketTops.loading && !topFundRows.length ? <LoadingRows rows={4} /> : topFundRows.length ? <AssetList assets={topFundRows} /> : <StatusBanner title={t(language, "home.noRealTopFundsTitle")} body={t(language, "home.noRealTopFundsBody")} />}
          </Section>
        </div>
      </Section>
      {resource.loading || customFunds.loading ? (
        <Section>
          <LoadingRows rows={4} />
        </Section>
      ) : null}
      {hasHomeDisplayData ? (
        <Section title={t(language, "home.topAssets")} subtitle={t(language, "home.topAssetsSubtitle")}>
          <AssetList assets={assets} />
        </Section>
      ) : null}
    </div>
  );
}

function topStocksCacheKey(marketId: MarketId) {
  return `fundx-top-stocks-full-market-turnover-${marketId}`;
}

function topAssetsCacheKey(marketId: MarketId, kind: "stock" | "fund") {
  return kind === "stock" ? topStocksCacheKey(marketId) : `fundx-top-funds-full-market-turnover-${marketId}`;
}

function topMarketRefreshKey(marketId: MarketId) {
  return `fundx-top-market-refresh-at-${marketId}`;
}

function homePortfolioSelectionKey(marketId: MarketId) {
  return `fundx-home-portfolio-selection-${marketId}`;
}

function readHomeDisplaySelection(marketId: MarketId): HomeDisplaySelection | null {
  if (typeof window === "undefined") return null;
  try {
    return parseHomeDisplaySelection(window.localStorage.getItem(homePortfolioSelectionKey(marketId)) ?? "");
  } catch {
    return null;
  }
}

function writeHomeDisplaySelection(marketId: MarketId, selection: HomeDisplaySelection | null) {
  if (typeof window === "undefined") return;
  try {
    const key = homePortfolioSelectionKey(marketId);
    if (selection) window.localStorage.setItem(key, serializeHomeDisplaySelection(selection));
    else window.localStorage.removeItem(key);
  } catch {
    return;
  }
}

function parseHomeDisplaySelection(value: string | null): HomeDisplaySelection | null {
  if (!value) return null;
  const [kind, ...rest] = value.split(":");
  const id = rest.join(":").trim();
  if ((kind === "portfolio" || kind === "customFund") && id) return { kind, id };
  return value.trim() ? { kind: "portfolio", id: value.trim() } : null;
}

function serializeHomeDisplaySelection(selection: HomeDisplaySelection) {
  return `${selection.kind}:${selection.id}`;
}

function readTopStocksCache(marketId: MarketId): MarketTopResponse | null {
  return readTopAssetsCache(marketId, "stock");
}

function readTopAssetsCache(marketId: MarketId, kind: "stock" | "fund"): MarketTopResponse | null {
  if (typeof window === "undefined") return null;
  purgeLegacyTopAssetCaches(marketId);
  try {
    const key = topAssetsCacheKey(marketId, kind);
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null") as MarketTopResponse | TopAssetsCacheEnvelope | null;
    const payload = isTopAssetsCacheEnvelope(parsed) ? parsed.payload : parsed;
    if (payload?.marketId === marketId && payload.kind === kind && payload.universe === "full-market" && payload.ranking === "turnover" && Array.isArray(payload.items)) {
      const sanitized = sanitizeTopAssetsResponse(payload);
      if (sanitized?.items.length) return sanitized;
      window.localStorage.removeItem(key);
    }
  } catch {
    return null;
  }
  return null;
}

function purgeLegacyTopAssetCaches(marketId: MarketId) {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(`fundx-top-stocks-${marketId}`);
  window.localStorage.removeItem(`fundx-top-funds-${marketId}`);
}

function writeTopStocksCache(marketId: MarketId, payload: MarketTopResponse) {
  writeTopAssetsCache(marketId, "stock", payload);
}

function writeTopAssetsCache(marketId: MarketId, kind: "stock" | "fund", payload: MarketTopResponse) {
  if (typeof window === "undefined") return;
  const key = topAssetsCacheKey(marketId, kind);
  const sanitized = sanitizeTopAssetsResponse(payload);
  if (!sanitized?.items.length) {
    window.localStorage.removeItem(key);
    return;
  }
  window.localStorage.setItem(key, JSON.stringify({ payload: sanitized, storedAt: Date.now() }));
}

function readFreshMarketTopsCache(marketId: MarketId): MarketTopsResponse | null {
  const stocks = readTopStocksCache(marketId);
  const funds = readTopAssetsCache(marketId, "fund");
  if (!stocks || !funds) return null;
  const cacheFresh = isTopAssetsCacheFresh(marketId, "stock") && isTopAssetsCacheFresh(marketId, "fund");
  if (!isTopMarketRefreshFresh(marketId) && !cacheFresh) return null;
  return {
    marketId,
    stocks: markTopAssetsAsCached(stocks),
    funds: markTopAssetsAsCached(funds),
  };
}

function isTopAssetsCacheFresh(marketId: MarketId, kind: "stock" | "fund") {
  if (typeof window === "undefined") return false;
  try {
    const key = topAssetsCacheKey(marketId, kind);
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null") as { storedAt?: number } | null;
    return typeof parsed?.storedAt === "number" && Date.now() - parsed.storedAt < TOP_CACHE_MAX_AGE_MS;
  } catch {
    return false;
  }
}

function isTopMarketRefreshFresh(marketId: MarketId) {
  const refreshedAt = readTopMarketRefreshAt(marketId);
  return Number.isFinite(refreshedAt) && Date.now() - refreshedAt <= TOP_CACHE_MAX_AGE_MS;
}

function shouldAutoRefreshTopMarkets(marketId: MarketId) {
  return !isTopMarketRefreshFresh(marketId);
}

function msUntilTopMarketAutoRefresh(marketId: MarketId) {
  const refreshedAt = readTopMarketRefreshAt(marketId);
  if (!Number.isFinite(refreshedAt) || refreshedAt <= 0) return 0;
  const elapsed = Date.now() - refreshedAt;
  return elapsed > TOP_CACHE_MAX_AGE_MS ? 0 : TOP_CACHE_MAX_AGE_MS - elapsed + 1;
}

function claimTopMarketAutoRefresh(marketId: MarketId) {
  if (!shouldAutoRefreshTopMarkets(marketId) || autoTopRefreshInFlight.has(marketId)) return false;
  autoTopRefreshInFlight.add(marketId);
  writeTopMarketRefreshAt(marketId);
  return true;
}

function isDocumentHidden() {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function writeTopMarketRefreshAt(marketId: MarketId) {
  const refreshedAt = Date.now();
  topMarketRefreshMemory.set(marketId, refreshedAt);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(topMarketRefreshKey(marketId), String(refreshedAt));
  } catch {
    return;
  }
}

function readTopMarketRefreshAt(marketId: MarketId) {
  const memoryValue = topMarketRefreshMemory.get(marketId) ?? 0;
  if (typeof window === "undefined") return memoryValue;
  try {
    const localValue = Number(window.localStorage.getItem(topMarketRefreshKey(marketId)));
    if (Number.isFinite(localValue) && localValue > 0) return Math.max(localValue, memoryValue);
  } catch {
    return memoryValue;
  }
  return memoryValue;
}

type TopAssetsCacheEnvelope = {
  payload?: MarketTopResponse;
  storedAt?: number;
};

function isTopAssetsCacheEnvelope(value: MarketTopResponse | TopAssetsCacheEnvelope | null): value is TopAssetsCacheEnvelope {
  return Boolean(value && typeof value === "object" && "storedAt" in value);
}

function sanitizeTopAssetsResponse(payload: MarketTopResponse | null): MarketTopResponse | null {
  if (!payload) return null;
  if (payload.universe !== "full-market" || payload.ranking !== "turnover") return null;
  const items = payload.items.filter(isRealTopAsset).sort((a, b) => assetTurnover(b) - assetTurnover(a)).slice(0, 10);
  if (!items.length) return null;
  return { ...payload, count: items.length, items };
}

function markTopAssetsAsCached(payload: MarketTopResponse): MarketTopResponse {
  const { refreshResult: _refreshResult, refreshSkipped: _refreshSkipped, ...rest } = payload;
  return { ...rest, refreshed: false, cached: true };
}

function didTopMarketRefreshSucceed(stocks: MarketTopResponse, funds: MarketTopResponse) {
  return didTopMarketResponseRefreshSucceed(stocks) && didTopMarketResponseRefreshSucceed(funds);
}

function didTopMarketResponseRefreshSucceed(response: MarketTopResponse) {
  if (response.refreshSkipped === "recent") return Boolean(sanitizeTopAssetsResponse(response));
  return response.refreshed === true && Boolean(sanitizeTopAssetsResponse(response));
}

function isRealTopAsset(asset: AssetRecord) {
  return asset.quoteStatus === "fresh" && asset.latestPrice != null && asset.latestPrice > 0 && assetTurnover(asset) > 0;
}

function assetTurnover(asset: AssetRecord) {
  if (asset.latestTurnover != null && asset.latestTurnover > 0) return Number(asset.latestTurnover);
  return Number(asset.latestPrice ?? 0) * Number(asset.latestVolume ?? 0);
}

function assetDetailHref(asset: AssetRecord, marketId: MarketId, language: Language) {
  const routeId = asset.assetType === "stock" && asset.id.startsWith(`market-top-${marketId}-`)
    ? `${marketId}-${symbolRouteSlug(asset.symbol)}`
    : asset.id;
  return `/assets/${routeId}?market=${marketId}&type=${asset.assetType}&lang=${language}`;
}

function symbolRouteSlug(symbol: string) {
  return symbol.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

const TOP_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const TOP_AUTO_REFRESH_DELAY_MS = 8_000;
type TopRefreshState = "ready" | "cached" | "refreshing" | "updated" | "fresh" | "failed";

function topRefreshCopy(language: Language, state: TopRefreshState) {
  const copy: Record<Language, Record<TopRefreshState, string>> = {
    en: {
      ready: "",
      cached: "",
      refreshing: "Refreshing",
      updated: "Updated",
      fresh: "Updated",
      failed: "Refresh failed",
    },
    "zh-CN": {
      ready: "",
      cached: "",
      refreshing: "刷新中",
      updated: "已刷新",
      fresh: "已刷新",
      failed: "刷新失败",
    },
    "zh-TW": {
      ready: "",
      cached: "",
      refreshing: "重新整理中",
      updated: "已重新整理",
      fresh: "已重新整理",
      failed: "重新整理失敗",
    },
  };
  return copy[language][state];
}

function buildHomeQuoteRequests(
  selection: HomeDisplaySelection | null,
  portfolio: NonNullable<PortfolioResponse["portfolio"]> | undefined,
  customFund: CustomFundRecord | null,
): HomeAssetQuoteRequest[] {
  if (selection?.kind === "portfolio" && portfolio) {
    return uniqueQuoteRequests(portfolio.holdings.map((holding) => ({
      id: holding.assetId,
      assetType: holding.assetType,
    })));
  }
  if (selection?.kind === "customFund" && customFund) {
    return [];
  }
  return [];
}

function uniqueQuoteRequests(requests: HomeAssetQuoteRequest[]) {
  const seen = new Set<string>();
  return requests.filter((request) => {
    const id = request.id.trim();
    if (!id) return false;
    const key = `${request.assetType}:${id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadLatestHomeAssetQuotes(marketId: MarketId, requests: HomeAssetQuoteRequest[], signal: AbortSignal) {
  const quotes = await Promise.all(requests.map(async (request) => {
    if (signal.aborted) return null;
    try {
      const response = await apiGet<AssetDetailResponse>(
        `/api/assets/${encodeURIComponent(request.id)}`,
        { market: marketId, type: request.assetType },
        signal,
      );
      return homeAssetQuoteFromDetail(response, request);
    } catch {
      return null;
    }
  }));
  return quotes.filter((quote): quote is HomeAssetQuote => quote !== null);
}

function homeAssetQuoteFromDetail(response: AssetDetailResponse, request: HomeAssetQuoteRequest): HomeAssetQuote | null {
  const asset = response.asset;
  const history = sanitizeTimePoints(response.history);
  const price = finitePositiveNumber(asset.latestPrice) ?? latestHistoryValue(history);
  if (price == null) return null;
  return {
    id: asset.id || request.id,
    assetType: asset.assetType || request.assetType,
    price,
    dailyChange: finiteNumber(asset.dailyChange) ?? historyDailyChange(history),
    history,
    updatedAt: response.updatedAt || asset.updatedAt,
  };
}

function buildPortfolioDisplaySummary(summary: PortfolioSummary, quoteById: Map<string, HomeAssetQuote>): PortfolioDisplaySummary {
  const holdings = summary.holdings.map((holding) => {
    const currentPrice = finitePositiveNumber(quoteById.get(holding.assetId)?.price) ?? holding.currentPrice;
    const marketValue = roundCurrency(holding.quantity * currentPrice);
    const cost = roundCurrency(holding.quantity * holding.averageCost);
    const gain = roundCurrency(marketValue - cost);
    const gainPercent = roundPercent(returnPercent(cost, marketValue));
    return {
      ...holding,
      currentPrice,
      marketValue,
      cost,
      gain,
      gainPercent,
    };
  });
  const totalValue = roundCurrency(holdings.reduce((total, holding) => total + holding.marketValue, 0) + summary.cashBalance);
  return {
    totalValue,
    holdings: holdings.map((holding) => {
      const currentWeight = totalValue === 0 ? 0 : roundPercent((holding.marketValue / totalValue) * 100);
      return {
        ...holding,
        currentWeight,
        targetGap: roundPercent(normalizeWeightPercent(holding.targetWeight) - currentWeight),
      };
    }),
  };
}

function buildCustomFundDisplayValue(
  fund: CustomFundRecord,
  resultSummary: PortfolioSummary | null,
  quoteById: Map<string, HomeAssetQuote>,
  universeById: Map<string, CustomFundUniverseItem>,
): CustomFundDisplayValue {
  if (resultSummary) {
    return {
      value: resultSummary.totalValue,
      dailyChange: historyDailyChange(resultSummary.valueHistory),
      pricedCount: resultSummary.holdings.length,
      updatedAt: fund.updatedAt,
    };
  }

  const baseValue = finitePositiveNumber(fund.capital) ?? CUSTOM_FUND_BASE_VALUE;
  if (!quoteById.size) {
    return {
      value: fund.capital ?? latestHistoryValue(fund.score.backtestHistory),
      dailyChange: historyDailyChange(fund.score.backtestHistory),
      pricedCount: 0,
      updatedAt: fund.updatedAt,
    };
  }

  const totalWeight = fund.holdings.reduce((total, holding) => total + Math.max(0, holding.weight), 0) || 100;
  let value = 0;
  let previousValue = 0;
  let pricedCount = 0;
  let latestUpdatedAt = "";

  for (const holding of fund.holdings) {
    const quote = quoteById.get(holding.stockId);
    const universeAsset = universeById.get(holding.stockId);
    const latestPrice = finitePositiveNumber(quote?.price) ?? finitePositiveNumber(universeAsset?.price);
    const dailyChange = finiteNumber(quote?.dailyChange) ?? finiteNumber(universeAsset?.dailyChange);
    const history = quote?.history.length ? quote.history : sanitizeTimePoints(universeAsset?.priceHistory ?? []);
    const weightShare = Math.max(0, holding.weight) / totalWeight;

    if (quote?.updatedAt && (!latestUpdatedAt || quote.updatedAt > latestUpdatedAt)) latestUpdatedAt = quote.updatedAt;
    if (latestPrice == null) {
      value += weightShare * baseValue;
      previousValue += weightShare * baseValue;
      continue;
    }

    const basePrice = firstHistoryValue(history) ?? latestPrice;
    const previousPrice = previousHistoryValue(history) ?? previousPriceFromChange(latestPrice, dailyChange) ?? latestPrice;
    value += weightShare * baseValue * (basePrice === 0 ? 1 : latestPrice / basePrice);
    previousValue += weightShare * baseValue * (basePrice === 0 ? 1 : previousPrice / basePrice);
    pricedCount += 1;
  }

  const roundedValue = roundCurrency(value);
  return {
    value: roundedValue,
    dailyChange: previousValue > 0 ? roundPercent(returnPercent(previousValue, value)) : historyDailyChange(fund.score.backtestHistory),
    pricedCount,
    updatedAt: latestUpdatedAt || fund.updatedAt,
  };
}

function resolveCustomFundResultSummary(fund: CustomFundRecord, cache: ReturnType<typeof readCustomFundResultCache>) {
  if (fund.summary) return fund.summary;
  if (!cache?.result?.summary) return null;
  if (!customFundCacheMatchesFund(cache, fund)) return null;
  if (isCacheOlderThanFund(cache.savedAt, fund.updatedAt)) return null;
  return cache.result.summary;
}

function customFundCacheMatchesFund(cache: NonNullable<ReturnType<typeof readCustomFundResultCache>>, fund: CustomFundRecord) {
  if (cache.editingId === fund.id || cache.input.customFundId === fund.id) return true;
  if (cache.input.name !== fund.name) return false;
  return sameCustomFundHoldings(cache.input.holdings, fund.holdings);
}

function sameCustomFundHoldings(left: CustomFundRecord["holdings"], right: CustomFundRecord["holdings"]) {
  if (left.length !== right.length) return false;
  const rightWeights = new Map(right.map((holding) => [holding.stockId, holding.weight]));
  return left.every((holding) => Math.abs((rightWeights.get(holding.stockId) ?? -1) - holding.weight) < 0.01);
}

function isCacheOlderThanFund(cacheSavedAt: string, fundUpdatedAt: string) {
  const cacheTime = Date.parse(cacheSavedAt);
  const fundTime = Date.parse(fundUpdatedAt);
  return Number.isFinite(cacheTime) && Number.isFinite(fundTime) && cacheTime + 1000 < fundTime;
}

function portfolioDailyDescription(summary: NonNullable<PortfolioResponse["summary"]>, language: Language, marketId: MarketId, updatedAt: string, portfolio?: NonNullable<PortfolioResponse["portfolio"]>) {
  const gain = formatSignedCurrency(summary.rangeGain ?? 0, marketId);
  const percent = formatPercent(summary.rangeGainPercent ?? 0);
  return t(language, "home.rangeSummary", {
    range: portfolioPeriodLabel(summary, language, portfolio),
    gain,
    percent,
    date: summary.rangeEndDate ?? updatedAt,
    updated: formatHktTimestamp(updatedAt),
  });
}

function customFundDescription(fund: CustomFundRecord, language: Language, display: CustomFundDisplayValue | null) {
  const summary = t(language, "home.customFundSummary", {
    style: fund.style,
    count: formatNumber(fund.holdings.length),
    returnValue: formatPercent(customFundBacktestReturn(fund), 1),
    dividend: formatPercent(fund.score.dividendYield),
    drawdown: formatPercent(fund.score.maxDrawdown),
    updated: formatHktTimestamp(display?.updatedAt ?? fund.updatedAt),
  });
  const dailyChange = display?.dailyChange == null ? null : `${t(language, "compare.dailyChange")} ${formatPercent(display.dailyChange)}`;
  return [fund.name, summary, dailyChange].filter(Boolean).join(" · ");
}

function customFundRows(
  fund: CustomFundRecord,
  universeById: Map<string, CustomFundUniverseItem>,
  quoteById: Map<string, HomeAssetQuote>,
  marketId: MarketId,
  language: Language,
) {
  return [...fund.holdings]
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 6)
    .map((holding) => {
      const asset = universeById.get(holding.stockId);
      const quote = quoteById.get(holding.stockId);
      const latestPrice = finitePositiveNumber(quote?.price) ?? finitePositiveNumber(asset?.price);
      const dailyChange = finiteNumber(quote?.dailyChange) ?? finiteNumber(asset?.dailyChange);
      const sector = localizedAssetSector(asset?.sector ?? asset?.industry ?? asset?.category, language);
      return {
        id: holding.stockId,
        name: asset?.name ?? holding.stockId,
        symbol: asset?.symbol ?? holding.stockId,
        subtitle: [assetTypeLabel(language, "stock"), sector].filter(Boolean).join(" · "),
        value: formatWeightValue(holding.weight),
        delta: latestPrice == null ? undefined : `${formatOptionalCompactCurrency(latestPrice, marketId)} · ${formatOptionalPercent(dailyChange, 1, "")}`,
        tone: (dailyChange ?? 0) >= 0 ? "positive" as const : "negative" as const,
      };
    });
}

function customFundBacktestReturn(fund: CustomFundRecord) {
  const history = fund.score.backtestHistory ?? [];
  const first = history[0]?.value;
  const last = history.at(-1)?.value;
  if (!Number.isFinite(first) || !Number.isFinite(last) || !first) return 0;
  return ((Number(last) - Number(first)) / Number(first)) * 100;
}

function portfolioPeriodLabel(summary: NonNullable<PortfolioResponse["summary"]>, language: Language, portfolio?: NonNullable<PortfolioResponse["portfolio"]>) {
  if (portfolio?.startDate && portfolio?.endDate) return `${portfolio.startDate} - ${portfolio.endDate}`;
  if (summary.rangeStartDate && summary.rangeEndDate) return `${summary.rangeStartDate} - ${summary.rangeEndDate}`;
  return t(language, `timeRange.${summary.range ?? "ALL"}`);
}

function currentPortfolioValue(summary: NonNullable<PortfolioResponse["summary"]>) {
  const history = summary.valueHistory ?? [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const value = Number(history[index]?.value);
    if (Number.isFinite(value)) return value;
  }
  return summary.totalValue;
}

const CUSTOM_FUND_BASE_VALUE = 100;

function sanitizeTimePoints(value: unknown): TimePoint[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((point) => {
      if (!point || typeof point !== "object") return null;
      const candidate = point as Partial<TimePoint>;
      const numericValue = finiteNumber(candidate.value);
      if (!candidate.date || numericValue == null) return null;
      return { date: String(candidate.date), value: numericValue };
    })
    .filter((point): point is TimePoint => Boolean(point))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function latestHistoryValue(history: TimePoint[] | undefined) {
  const sanitized = sanitizeTimePoints(history ?? []);
  for (let index = sanitized.length - 1; index >= 0; index -= 1) {
    const value = finitePositiveNumber(sanitized[index]?.value);
    if (value != null) return value;
  }
  return null;
}

function firstHistoryValue(history: TimePoint[]) {
  for (const point of sanitizeTimePoints(history)) {
    const value = finitePositiveNumber(point.value);
    if (value != null) return value;
  }
  return null;
}

function previousHistoryValue(history: TimePoint[]) {
  const sanitized = sanitizeTimePoints(history);
  for (let index = sanitized.length - 2; index >= 0; index -= 1) {
    const value = finitePositiveNumber(sanitized[index]?.value);
    if (value != null) return value;
  }
  return null;
}

function historyDailyChange(history: TimePoint[] | undefined) {
  const sanitized = sanitizeTimePoints(history ?? []);
  const latest = latestHistoryValue(sanitized);
  const previous = previousHistoryValue(sanitized);
  if (latest == null || previous == null || previous === 0) return null;
  return roundPercent(returnPercent(previous, latest));
}

function previousPriceFromChange(latestPrice: number, dailyChange: number | null | undefined) {
  const change = finiteNumber(dailyChange);
  if (change == null || change <= -100) return null;
  return latestPrice / (1 + change / 100);
}

function finiteNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function finitePositiveNumber(value: unknown) {
  const numeric = finiteNumber(value);
  return numeric != null && numeric > 0 ? numeric : null;
}

function returnPercent(startValue: number, endValue: number) {
  if (!Number.isFinite(startValue) || startValue === 0) return 0;
  return ((endValue - startValue) / startValue) * 100;
}

function roundCurrency(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function roundPercent(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeWeightPercent(value: number) {
  return value <= 1 ? value * 100 : value;
}

function formatHktTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day} ${byType.hour}:${byType.minute} HKT`;
}

function formatSignedCurrency(value: number, marketId: MarketId) {
  const formatted = formatCurrency(value, marketId);
  return value > 0 ? `+${formatted}` : formatted;
}

function formatWeightValue(value: number) {
  return `${value.toFixed(1)}%`;
}

function isDisplayFixturePortfolio(portfolio: NonNullable<PortfolioResponse["portfolio"]>) {
  const name = portfolio.name.trim().toLowerCase();
  const goal = portfolio.goal.trim().toLowerCase();
  if (name.startsWith("smoke portfolio") || goal === "smoke coverage") return true;
  return portfolio.holdings.some((holding) => holding.name.trim().toLowerCase().startsWith("smoke ") || holding.symbol.trim().toUpperCase().startsWith("SMK"));
}
