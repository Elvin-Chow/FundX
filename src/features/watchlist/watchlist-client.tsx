"use client";

import { CheckSquare, Loader2, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { CustomSelect } from "@/components/custom-select";
import { useAssetsSearch } from "@/hooks/use-assets-search";
import { useResolvedLanguage } from "@/hooks/use-language";
import { useWatchlist } from "@/hooks/use-watchlist";
import { apiErrorMessage } from "@/lib/api-client";
import type { AssetSearchType, WatchlistResponse } from "@/lib/api-contracts";
import { assetDisplayName, assetKindLabel, assetPrimaryCategory, localizedAssetSector, quoteStatusLabel } from "@/lib/asset-display";
import { formatOptionalCurrency, formatOptionalPercent } from "@/lib/formatters";
import { localeForLanguage, t, type Language } from "@/lib/i18n";
import { marketToneBadgeClass } from "@/lib/market-color-style";
import { createReturnToState, locationToReturnTo } from "@/lib/navigation-state";
import type { AssetRecord, MarketId, SearchSortKey } from "@/lib/types";
import { useMarketStore } from "@/stores/market-store";
import { LoadingRows, Section, StatusBanner } from "../shared/feature-shell";

const assetTypes: Array<{ value: AssetSearchType; labelKey: string }> = [
  { value: "all", labelKey: "assetType.all" },
  { value: "stock", labelKey: "assetType.stock" },
  { value: "fund", labelKey: "assetType.fund" },
];

const sortOptions: Array<{ value: SearchSortKey; labelKey: string }> = [
  { value: "popularity", labelKey: "discover.sort.popularity" },
  { value: "relevance", labelKey: "discover.sort.relevance" },
  { value: "return", labelKey: "discover.dailyReturn" },
  { value: "size", labelKey: "discover.size" },
  { value: "risk", labelKey: "discover.lowerRisk" },
];

const WATCHLIST_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const autoRefreshInFlight = new Set<MarketId>();
const watchlistRefreshMemory = new Map<MarketId, number>();

function assetHref(asset: AssetRecord, marketId: MarketId, language: Language) {
  return `/assets/${asset.id}?market=${marketId}&type=${asset.assetType}&lang=${language}`;
}

function rowAssetHref(item: { assetId: string; assetType: string }, marketId: MarketId, language: Language) {
  return `/assets/${item.assetId}?market=${marketId}&type=${item.assetType}&lang=${language}`;
}

function refreshStorageKey(marketId: MarketId) {
  return `fundx-watchlist-refresh:${marketId}`;
}

function readLastRefreshAt(marketId: MarketId) {
  const memoryValue = watchlistRefreshMemory.get(marketId) ?? 0;
  if (typeof window === "undefined") return memoryValue;
  try {
    const value = window.localStorage.getItem(refreshStorageKey(marketId));
    const parsed = value ? Number(value) : 0;
    return Number.isFinite(parsed) ? Math.max(parsed, memoryValue) : memoryValue;
  } catch {
    return memoryValue;
  }
}

function writeLastRefreshAt(marketId: MarketId) {
  watchlistRefreshMemory.set(marketId, Date.now());
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(refreshStorageKey(marketId), String(watchlistRefreshMemory.get(marketId) ?? Date.now()));
  } catch {
    return;
  }
}

function shouldAutoRefreshWatchlist(marketId: MarketId) {
  return Date.now() - readLastRefreshAt(marketId) > WATCHLIST_REFRESH_INTERVAL_MS;
}

function msUntilWatchlistAutoRefresh(marketId: MarketId) {
  const refreshedAt = readLastRefreshAt(marketId);
  if (!Number.isFinite(refreshedAt) || refreshedAt <= 0) return 0;
  const elapsed = Date.now() - refreshedAt;
  return elapsed > WATCHLIST_REFRESH_INTERVAL_MS ? 0 : WATCHLIST_REFRESH_INTERVAL_MS - elapsed + 1;
}

function claimWatchlistAutoRefresh(marketId: MarketId) {
  if (!shouldAutoRefreshWatchlist(marketId) || autoRefreshInFlight.has(marketId)) return false;
  autoRefreshInFlight.add(marketId);
  writeLastRefreshAt(marketId);
  return true;
}

export function WatchlistClient({ marketId, language: languageProp = "en" }: { marketId: MarketId; language?: Language }) {
  const language = useResolvedLanguage(languageProp);
  const location = useLocation();
  const watchlist = useWatchlist(marketId);
  const search = useAssetsSearch(marketId, { pageSize: 12, sort: "popularity" });
  const [status, setStatus] = useState("");
  const [busyAssetId, setBusyAssetId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [autoRefreshTick, setAutoRefreshTick] = useState(0);
  const watchlistRows = watchlist.data?.view;
  const rows = useMemo(() => watchlistRows ?? [], [watchlistRows]);
  const watchedAssetIds = useMemo(() => new Set(rows.map((row) => row.assetId)), [rows]);
  const selectedCount = selectedItemIds.length;
  const assets = useMemo(() => search.data?.items ?? [], [search.data?.items]);
  const candidates = useMemo(
    () => assets.filter((asset) => !watchedAssetIds.has(asset.id)),
    [assets, watchedAssetIds],
  );
  const sectorOptions = useMemo(() => search.data?.facets?.sectors ?? [], [search.data?.facets?.sectors]);
  const sectorCounts = useMemo(() => search.data?.facetCounts?.sectors ?? {}, [search.data?.facetCounts?.sectors]);
  const databaseStats = search.data?.stats;
  const resultTotal = search.data?.total ?? 0;
  const detailReturnState = createReturnToState(locationToReturnTo(location));
  const hasActiveFilters = Boolean(
    search.filters.q
    || search.filters.type !== "all"
    || search.filters.industry
    || search.filters.sort !== "popularity",
  );
  const numberFormat = useMemo(() => new Intl.NumberFormat(localeForLanguage(language)), [language]);

  function clearFilters() {
    search.setFilters({ q: "", type: "all", industry: "", fundType: "", sort: "popularity", page: 1 });
  }

  function toggleSelectedItem(id: string) {
    setSelectedItemIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  function toggleManageMode() {
    setManaging((current) => {
      const next = !current;
      if (!next) setSelectedItemIds([]);
      return next;
    });
  }

  async function addAsset(asset: AssetRecord) {
    if (asset.latestPrice == null) {
      setStatus(t(language, "asset.noQuoteBody"));
      return;
    }

    setBusyAssetId(asset.id);
    setStatus(t(language, "watchlist.adding", { symbol: asset.symbol }));
    try {
      await watchlist.addItem({
        assetId: asset.id,
        assetType: asset.assetType,
        note: t(language, "watchlist.addedFrom"),
        target: Number((asset.latestPrice * 0.95).toFixed(2)),
      });
      setStatus(t(language, "watchlist.added", { symbol: asset.symbol }));
      setAddOpen(false);
    } catch (error) {
      setStatus(apiErrorMessage(error));
    } finally {
      setBusyAssetId(null);
    }
  }

  async function removeItem(id: string) {
    setBusyAssetId(id);
    setStatus(t(language, "watchlist.removing"));
    try {
      await watchlist.removeItem(id);
      setSelectedItemIds((current) => current.filter((item) => item !== id));
      setStatus(t(language, "watchlist.removed"));
    } catch (error) {
      setStatus(apiErrorMessage(error));
    } finally {
      setBusyAssetId(null);
    }
  }

  async function removeSelectedItems() {
    if (!selectedItemIds.length) return;

    const count = selectedItemIds.length;
    setBulkDeleting(true);
    setStatus(t(language, "watchlist.bulkRemoving", { count }));
    try {
      for (const id of selectedItemIds) {
        await watchlist.removeItem(id);
      }
      setSelectedItemIds([]);
      setManaging(false);
      setStatus(t(language, "watchlist.bulkRemoved", { count }));
    } catch (error) {
      setStatus(apiErrorMessage(error));
    } finally {
      setBulkDeleting(false);
    }
  }

  const refreshQuotes = useCallback(async (automatic = false) => {
    if (!rows.length) {
      if (automatic) autoRefreshInFlight.delete(marketId);
      return;
    }

    setRefreshing(true);
    setStatus(t(language, "watchlist.refreshing"));
    try {
      const response = await watchlist.refreshPrices();
      writeLastRefreshAt(marketId);
      setStatus(refreshStatus(response, language));
      await search.refresh("reload");
    } catch (error) {
      setStatus(apiErrorMessage(error));
    } finally {
      setRefreshing(false);
      if (automatic) autoRefreshInFlight.delete(marketId);
    }
  }, [language, marketId, rows.length, search, watchlist]);

  useEffect(() => {
    if (watchlist.loading || watchlist.reloading || refreshing || !rows.length) return;
    const waitMs = msUntilWatchlistAutoRefresh(marketId);
    if (waitMs > 0) {
      const timeout = window.setTimeout(() => setAutoRefreshTick((current) => current + 1), waitMs);
      return () => window.clearTimeout(timeout);
    }
    if (!claimWatchlistAutoRefresh(marketId)) return;

    void refreshQuotes(true);
    return;
  }, [autoRefreshTick, marketId, refreshing, refreshQuotes, rows.length, watchlist.loading, watchlist.reloading]);

  useEffect(() => {
    setSelectedItemIds((current) => current.filter((id) => rows.some((row) => row.id === id)));
  }, [rows]);

  return (
    <>
      <Section
        title={t(language, "watchlist.listTitle")}
        flushTop
        action={
          <div className="flex flex-wrap items-center gap-2">
            {managing ? (
              <button
                type="button"
                onClick={() => void removeSelectedItems()}
                disabled={!selectedCount || bulkDeleting}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-red-600 px-3 text-sm font-medium text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:bg-red-200"
              >
                {bulkDeleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                {t(language, "watchlist.deleteSelected", { count: selectedCount })}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-zinc-950 px-3 text-sm font-medium text-white transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
            >
              <Plus size={16} />
              {t(language, "common.add")}
            </button>
            <button
              type="button"
              onClick={toggleManageMode}
              disabled={!rows.length}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-300 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-200 dark:hover:bg-white/10 dark:disabled:text-zinc-500"
            >
              <CheckSquare size={16} />
              {managing ? t(language, "common.cancelEdit") : t(language, "watchlist.batchManage")}
            </button>
            <button
              type="button"
              onClick={() => void refreshQuotes()}
              disabled={!rows.length || refreshing || watchlist.reloading}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-300 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-200 dark:hover:bg-white/10 dark:disabled:text-zinc-500"
            >
              <RefreshCw size={16} className={refreshing || watchlist.reloading ? "animate-spin" : ""} />
              {t(language, "common.reload")}
            </button>
          </div>
        }
      >
        {watchlist.error || status ? (
          <div className="mb-4">
            <StatusBanner title={watchlist.error ?? status} tone={watchlist.error ? "negative" : "neutral"} />
          </div>
        ) : null}
        {watchlist.loading ? <LoadingRows rows={5} /> : null}
        {!watchlist.loading && !rows.length ? (
          <StatusBanner
            title={t(language, "watchlist.noIdeasTitle")}
            body={t(language, "watchlist.noIdeasBody")}
            action={
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="h-9 rounded-lg bg-zinc-950 px-3 text-sm font-medium text-white transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
              >
                {t(language, "common.add")}
              </button>
            }
          />
        ) : null}
        {!watchlist.loading && rows.length ? (
          <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-white/10 dark:bg-white/[0.03]">
            <div className={[
              "hidden gap-4 border-b border-zinc-100 bg-zinc-50 px-4 py-3 text-xs font-medium uppercase text-zinc-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-400 md:grid",
              managing ? "grid-cols-[2rem_minmax(0,1fr)_9rem_8rem_4rem]" : "grid-cols-[minmax(0,1fr)_9rem_8rem_4rem]",
            ].join(" ")}>
              {managing ? <div /> : null}
              <div>{t(language, "common.asset")}</div>
              <div>{t(language, "common.price")}</div>
              <div>{t(language, "common.change")}</div>
              <div />
            </div>
            {rows.map((item) => {
              const selected = selectedItemIds.includes(item.id);
              return (
                <div key={item.id} className={[
                  "grid gap-3 border-b border-zinc-100 p-4 last:border-b-0 dark:border-white/10 md:items-center",
                  managing ? "md:grid-cols-[2rem_minmax(0,1fr)_9rem_8rem_4rem]" : "md:grid-cols-[minmax(0,1fr)_9rem_8rem_4rem]",
                  selected ? "bg-emerald-50/60 dark:bg-emerald-400/10" : "",
                ].join(" ")}>
                  {managing ? (
                    <label className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-200 bg-white dark:border-white/10 dark:bg-white/[0.04]">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleSelectedItem(item.id)}
                        className="h-4 w-4 accent-emerald-600"
                        aria-label={t(language, "watchlist.selectItem")}
                      />
                    </label>
                  ) : null}
                  <Link to={rowAssetHref(item, marketId, language)} state={detailReturnState} className="min-w-0">
                    <div className="truncate text-sm font-semibold text-zinc-950 dark:text-white">{item.name}</div>
                    <div className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">{item.symbol}</div>
                  </Link>
                  <div className="text-sm font-medium text-zinc-950 dark:text-white">{formatOptionalCurrency(item.price, marketId)}</div>
                  <ChangeBadge value={item.dailyChange} />
                  <button
                    type="button"
                    onClick={() => removeItem(item.id)}
                    disabled={busyAssetId === item.id || bulkDeleting}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 transition hover:bg-zinc-50 hover:text-red-500 disabled:cursor-not-allowed disabled:text-zinc-300 dark:border-white/10 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-red-300 dark:disabled:text-zinc-600"
                    aria-label={t(language, "common.remove")}
                    title={t(language, "common.remove")}
                  >
                    {busyAssetId === item.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
      </Section>

      {addOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-zinc-950/35 px-4 py-6 backdrop-blur-sm dark:bg-black/60 sm:py-10">
          <div className="w-full max-w-5xl rounded-lg border border-zinc-200 bg-white shadow-xl dark:border-white/10 dark:bg-[#080d0c] dark:shadow-black/40">
            <div className="flex items-start justify-between gap-4 border-b border-zinc-200 p-4 dark:border-white/10">
              <div>
                <h2 className="text-lg font-semibold text-zinc-950 dark:text-white">{t(language, "watchlist.addAsset")}</h2>
                <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                  {t(language, "watchlist.databaseSubtitle", {
                    total: numberFormat.format(databaseStats?.total ?? resultTotal),
                    funds: numberFormat.format(databaseStats?.funds ?? 0),
                    stocks: numberFormat.format(databaseStats?.stocks ?? 0),
                  })}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAddOpen(false)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 transition hover:bg-zinc-50 hover:text-zinc-950 dark:border-white/10 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-white"
                aria-label={t(language, "common.cancelEdit")}
                title={t(language, "common.cancelEdit")}
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(16rem,1fr)_9rem_13rem_10rem]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" size={18} />
              <input
                className="h-11 w-full rounded-lg border border-zinc-200 bg-white px-10 text-sm text-zinc-950 outline-none transition placeholder:text-zinc-400 focus:border-emerald-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-white dark:placeholder:text-zinc-500"
                placeholder={t(language, "discover.placeholder")}
                value={search.filters.q}
                onChange={(event) => search.setFilters({ q: event.target.value })}
              />
              {search.loading ? <Loader2 className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-zinc-400" size={18} /> : null}
            </div>
            <CustomSelect
              ariaLabel={t(language, "common.type")}
              size="regular"
              value={search.filters.type}
              options={assetTypes.map((item) => ({ value: item.value, label: t(language, item.labelKey) }))}
              onChange={(type) => search.setFilters({ type, industry: "", fundType: "" })}
            />
            <CustomSelect
              ariaLabel={t(language, "discover.sector")}
              size="regular"
              value={search.filters.industry}
              options={[
                { value: "", label: t(language, "common.allSectors") },
                ...sectorOptions.map((item) => ({
                  value: item,
                  label: `${localizedAssetSector(item, language)}${sectorCounts[item] ? ` (${numberFormat.format(sectorCounts[item])})` : ""}`,
                })),
              ]}
              onChange={(industry) => search.setFilters({ industry })}
            />
            <CustomSelect
              ariaLabel={t(language, "dca.sort")}
              size="regular"
              value={search.filters.sort}
              options={sortOptions.map((item) => ({ value: item.value, label: t(language, item.labelKey) }))}
              onChange={(sort) => search.setFilters({ sort })}
            />
          </div>

          <div className="mt-3 flex flex-col gap-2 text-xs text-zinc-500 dark:text-zinc-400 sm:flex-row sm:items-center sm:justify-between">
            <div>
              {t(language, "watchlist.databaseResults", {
                count: numberFormat.format(candidates.length),
                total: numberFormat.format(resultTotal),
                page: search.data?.page ?? search.filters.page,
                totalPages: search.data?.totalPages ?? 1,
              })}
            </div>
            {hasActiveFilters ? (
              <button
                type="button"
                onClick={clearFilters}
                className="h-8 rounded-lg border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-600 transition hover:border-zinc-300 hover:text-zinc-950 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-300 dark:hover:border-white/20 dark:hover:text-white"
              >
                {t(language, "discover.clearFilters")}
              </button>
            ) : null}
          </div>

          {watchlist.error || status ? (
            <div className="mt-3">
              <StatusBanner title={watchlist.error ?? status} tone={watchlist.error ? "negative" : "neutral"} />
            </div>
          ) : null}

          <div className="mt-4 overflow-hidden rounded-lg border border-zinc-200 dark:border-white/10">
            {search.loading ? <SearchLoadingRows /> : null}
            {!search.loading && !candidates.length ? (
              <div className="px-4 py-5 text-sm text-zinc-500 dark:text-zinc-400">{t(language, "watchlist.noSearchResults")}</div>
            ) : null}
            {!search.loading && candidates.map((asset) => (
              <div key={`${asset.assetType}-${asset.id}`} className="grid gap-3 border-b border-zinc-100 p-4 last:border-b-0 dark:border-white/10 md:grid-cols-[minmax(0,1fr)_8rem_8rem_6rem] md:items-center">
                <Link to={assetHref(asset, marketId, language)} state={detailReturnState} className="min-w-0">
                  <div className="truncate text-sm font-semibold text-zinc-950 dark:text-white">{assetDisplayName(asset, language)}</div>
                  <div className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {[asset.symbol, assetKindLabel(asset, language), assetPrimaryCategory(asset, language), quoteStatusLabel(asset, language)].filter(Boolean).join(" · ")}
                  </div>
                </Link>
                <div className="text-sm font-medium text-zinc-950 dark:text-white">{formatOptionalCurrency(asset.latestPrice, marketId)}</div>
                <ChangeBadge value={asset.dailyChange} />
                <button
                  type="button"
                  onClick={() => addAsset(asset)}
                  disabled={busyAssetId === asset.id}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-zinc-950 px-3 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400"
                >
                  {busyAssetId === asset.id ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                  {t(language, "common.add")}
                </button>
              </div>
            ))}
          </div>

          {search.data && search.data.totalPages > 1 ? (
            <div className="mt-3 flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-3 text-sm dark:border-white/10 dark:bg-white/[0.03]">
              <button
                type="button"
                disabled={search.filters.page <= 1}
                onClick={() => search.setPage(search.filters.page - 1)}
                className="h-9 rounded border border-zinc-200 px-3 font-medium text-zinc-700 disabled:cursor-not-allowed disabled:text-zinc-300 dark:border-white/10 dark:text-zinc-200 dark:disabled:text-zinc-500"
              >
                {t(language, "common.previous")}
              </button>
              <span className="text-zinc-500 dark:text-zinc-400">
                {t(language, "common.pageOf", { page: search.data.page, totalPages: search.data.totalPages })}
              </span>
              <button
                type="button"
                disabled={search.filters.page >= search.data.totalPages}
                onClick={() => search.setPage(search.filters.page + 1)}
                className="h-9 rounded border border-zinc-200 px-3 font-medium text-zinc-700 disabled:cursor-not-allowed disabled:text-zinc-300 dark:border-white/10 dark:text-zinc-200 dark:disabled:text-zinc-500"
              >
                {t(language, "common.next")}
              </button>
            </div>
          ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function SearchLoadingRows() {
  return (
    <div className="divide-y divide-zinc-100 dark:divide-white/10">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="grid gap-3 p-4 md:grid-cols-[minmax(0,1fr)_8rem_6rem] md:items-center">
          <div>
            <div className="h-4 w-44 animate-pulse rounded bg-zinc-100 dark:bg-white/10" />
            <div className="mt-2 h-3 w-56 animate-pulse rounded bg-zinc-100 dark:bg-white/10" />
          </div>
          <div className="h-8 animate-pulse rounded bg-zinc-100 dark:bg-white/10" />
          <div className="h-9 animate-pulse rounded bg-zinc-100 dark:bg-white/10" />
        </div>
      ))}
    </div>
  );
}

function ChangeBadge({ value }: { value: number | null | undefined }) {
  const marketColorStyle = useMarketStore((state) => state.marketColorStyle);
  const toneClass = marketToneBadgeClass(value == null ? "neutral" : value >= 0 ? "positive" : "negative", marketColorStyle);

  return (
    <span className={`inline-flex h-7 w-fit min-w-16 items-center justify-center rounded-full px-2.5 text-sm font-semibold ${toneClass}`}>
      {formatOptionalPercent(value)}
    </span>
  );
}

function refreshStatus(response: WatchlistResponse, language: Language) {
  const result = response.refreshResult;
  if (!result) return t(language, "watchlist.status.synced");
  if (result.fetched > 0) return t(language, "watchlist.refreshedWithCount", { count: result.fetched });
  if (result.failed?.length) return t(language, "watchlist.refreshFailed", { reason: refreshFailureReason(result.failed[0]) });
  return t(language, "watchlist.refreshed");
}

function refreshFailureReason(value: unknown) {
  if (!value || typeof value !== "object") return String(value || "");
  const reason = (value as { reason?: unknown }).reason;
  if (typeof reason !== "string") return "";
  return reason.length > 160 ? `${reason.slice(0, 160)}...` : reason;
}
