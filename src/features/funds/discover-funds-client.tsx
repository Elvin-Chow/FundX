"use client";

import { RefreshCw, Star, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { CustomSelect, type CustomSelectOption } from "@/components/custom-select";
import { useResolvedLanguage } from "@/hooks/use-language";
import { apiErrorMessage } from "@/lib/api-client";
import { assetDisplayName, assetKindLabel, assetOriginalName, assetPrimaryCategory, localizedAssetSector, localizedFundCompany, marketCurrencyHint, quoteStatusLabel } from "@/lib/asset-display";
import type { AssetSearchType, JobsResponse } from "@/lib/api-contracts";
import { formatOptionalPercent } from "@/lib/formatters";
import { assetTypeLabel, localeForLanguage, t, type Language } from "@/lib/i18n";
import { createReturnToState, locationToReturnTo } from "@/lib/navigation-state";
import { upsertLocalWatchlistItem } from "@/lib/local-user-data";
import type { AssetRecord, MarketId, SearchSortKey } from "@/lib/types";
import { LoadingRows, Section, StatusBanner, ToneText } from "../shared/feature-shell";
import { useAssetsSearch } from "@/hooks/use-assets-search";

const assetTypes: Array<{ value: AssetSearchType; labelKey: string }> = [
  { value: "all", labelKey: "assetType.all" },
  { value: "fund", labelKey: "assetType.fund" },
  { value: "stock", labelKey: "assetType.stock" },
];

const sortOptions: Array<{ value: SearchSortKey; labelKey: string }> = [
  { value: "relevance", labelKey: "discover.sort.relevance" },
  { value: "popularity", labelKey: "discover.sort.popularity" },
  { value: "return", labelKey: "discover.dailyReturn" },
  { value: "size", labelKey: "discover.size" },
  { value: "risk", labelKey: "discover.lowerRisk" },
];

function assetHref(asset: AssetRecord, marketId: MarketId, language: Language) {
  return `/assets/${asset.id}?market=${marketId}&type=${asset.assetType}&lang=${language}`;
}

function assetSubtitle(asset: AssetRecord, language: Language) {
  return [
    asset.symbol,
    assetKindLabel(asset, language),
    assetPrimaryCategory(asset, language),
    localizedFundCompany(asset.fundCompany, language),
  ].filter(Boolean).join(" · ");
}

function updatedLabel(value: string | undefined, language: Language) {
  if (!value) return t(language, "discover.notUpdated");
  return new Date(value).toLocaleString(localeForLanguage(language), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function quoteLabel(asset: AssetRecord, language: Language) {
  return quoteStatusLabel(asset, language);
}

export function DiscoverFundsClient({ marketId, language: languageProp = "en" }: { marketId: MarketId; language?: Language }) {
  const language = useResolvedLanguage(languageProp);
  const location = useLocation();
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const search = useAssetsSearch(marketId);
  const assets = useMemo(() => search.data?.items ?? [], [search.data?.items]);
  const selectedAssets = assets.filter((asset) => compareIds.includes(asset.id) && isFundAsset(asset));
  const sectorOptions = useMemo(() => search.data?.facets?.sectors ?? [], [search.data?.facets?.sectors]);
  const sectorCounts = useMemo(() => search.data?.facetCounts?.sectors ?? {}, [search.data?.facetCounts?.sectors]);
  const hasActiveFilters = Boolean(
    search.filters.q
    || search.filters.type !== "all"
    || search.filters.industry
    || search.filters.sort !== "relevance",
  );
  const libraryStats = useMemo(() => {
    const stats = search.data?.stats;
    const fallbackFunds = assets.filter((asset) => asset.kind === "fund").length;
    const fallbackStocks = assets.filter((asset) => asset.kind === "stock").length;
    return {
      total: stats?.total ?? search.data?.total ?? 0,
      funds: stats?.funds ?? fallbackFunds,
      stocks: stats?.stocks ?? fallbackStocks,
    };
  }, [assets, search.data?.stats, search.data?.total]);

  const resultTotal = search.data?.total ?? 0;
  const detailReturnState = createReturnToState(locationToReturnTo(location));
  const assetTypeSelectOptions = useMemo<Array<CustomSelectOption<AssetSearchType>>>(
    () => assetTypes.map((item) => ({
      value: item.value,
      label: t(language, item.labelKey),
    })),
    [language],
  );
  const sectorSelectOptions = useMemo<Array<CustomSelectOption<string>>>(
    () => [
      { value: "", label: t(language, "common.allSectors") },
      ...sectorOptions.map((item) => ({
        value: item,
        label: `${localizedAssetSector(item, language)}${sectorCounts[item] ? ` (${sectorCounts[item].toLocaleString(localeForLanguage(language))})` : ""}`,
      })),
    ],
    [language, sectorCounts, sectorOptions],
  );
  const sortSelectOptions = useMemo<Array<CustomSelectOption<SearchSortKey>>>(
    () => sortOptions.map((item) => ({
      value: item.value,
      label: t(language, item.labelKey),
    })),
    [language],
  );

  function toggleCompare(asset: AssetRecord) {
    if (!isFundAsset(asset)) return;
    setCompareIds((current) => {
      const id = asset.id;
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= 4) return [...current.slice(1), id];
      return [...current, id];
    });
  }

  async function addToWatchlist(asset: AssetRecord) {
    if (asset.latestPrice == null) {
      setStatus(t(language, "asset.noQuoteBody"));
      return;
    }
    setStatus(t(language, "discover.savingWatch", { symbol: asset.symbol }));
    try {
      upsertLocalWatchlistItem(marketId, {
        assetId: asset.id,
        assetType: asset.assetType,
        note: t(language, "discover.addedFrom"),
        target: Number((asset.latestPrice * 0.95).toFixed(2)),
      }, asset);
      setStatus(t(language, "discover.watchSaved", { symbol: asset.symbol }));
    } catch (error) {
      setStatus(apiErrorMessage(error));
    }
  }

  async function refreshPublicData() {
    setStatus(t(language, "discover.refreshingPublicData"));
    try {
      const response = await search.refreshPublicData();
      setStatus(publicDataRefreshStatus(response, language));
    } catch (error) {
      setStatus(apiErrorMessage(error));
    }
  }

  function clearFilters() {
    search.setFilters({ q: "", type: "all", industry: "", sort: "relevance" });
  }

  return (
    <>
      <Section
        title={t(language, "discover.search")}
        subtitle={t(language, "discover.searchSubtitle", { total: libraryStats.total, market: marketId.toUpperCase() })}
        action={
          <button
            type="button"
            onClick={refreshPublicData}
            disabled={search.reloading}
            className="inline-flex h-10 items-center gap-2 rounded bg-zinc-950 px-4 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400"
          >
            <RefreshCw size={16} />
            {t(language, "common.refreshPublicData")}
          </button>
        }
      >
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <LibraryStat label={t(language, "discover.libraryAssets")} value={libraryStats.total.toLocaleString(localeForLanguage(language))} />
          <LibraryStat label={t(language, "discover.libraryFunds")} value={libraryStats.funds.toLocaleString(localeForLanguage(language))} />
          <LibraryStat label={t(language, "discover.libraryStocks")} value={libraryStats.stocks.toLocaleString(localeForLanguage(language))} />
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-white/[0.03]">
          <div className="grid gap-3 md:grid-cols-[minmax(18rem,1fr)_10rem] xl:grid-cols-[minmax(18rem,1fr)_10rem_13rem_12rem]">
            <input
              className="h-11 rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-950 outline-none transition focus:border-emerald-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-white dark:placeholder:text-zinc-500"
              placeholder={t(language, "discover.placeholder")}
              value={search.filters.q}
              onChange={(event) => search.setFilters({ q: event.target.value })}
            />
            <CustomSelect
              ariaLabel={t(language, "common.type")}
              size="regular"
              value={search.filters.type}
              options={assetTypeSelectOptions}
              onChange={(nextType) => search.setFilters({ type: nextType, industry: "", fundType: "" })}
            />
            <CustomSelect
              ariaLabel={t(language, "discover.sector")}
              size="regular"
              value={search.filters.industry}
              options={sectorSelectOptions}
              onChange={(nextIndustry) => search.setFilters({ industry: nextIndustry })}
            />
            <CustomSelect
              ariaLabel={t(language, "dca.sort")}
              size="regular"
              value={search.filters.sort}
              options={sortSelectOptions}
              onChange={(nextSort) => search.setFilters({ sort: nextSort })}
            />
          </div>
          {hasActiveFilters ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex h-10 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-600 transition hover:border-zinc-300 hover:text-zinc-950 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-300 dark:hover:border-white/20 dark:hover:text-white"
              >
                <X size={16} />
                {t(language, "discover.clearFilters")}
              </button>
            </div>
          ) : null}
        </div>
        {search.error || status ? (
          <div className="mt-3">
            <StatusBanner
              title={search.error ?? status}
              tone={search.error ? "negative" : "neutral"}
            />
          </div>
        ) : null}
      </Section>

      {selectedAssets.length ? (
        <Section
          title={t(language, "discover.compareSelection")}
          subtitle={t(language, "discover.compareSubtitle")}
          action={
            <Link to={`/compare?market=${marketId}&ids=${compareIds.join(",")}&lang=${language}`} className="h-10 rounded bg-zinc-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200">
              {t(language, "discover.openCompare")}
            </Link>
          }
        >
          <div className="grid gap-3 md:grid-cols-3">
            {selectedAssets.map((asset) => (
              <div key={asset.id} className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-400/30 dark:bg-emerald-400/10">
                <div className="text-sm font-semibold text-zinc-950 dark:text-white">{asset.symbol}</div>
                <div className="mt-1 truncate text-sm text-zinc-600 dark:text-zinc-300">{assetDisplayName(asset, language)}</div>
                <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">{t(language, "common.type")}</div>
                    <div className="font-semibold text-zinc-950 dark:text-white">{assetTypeLabel(language, asset.assetType)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">{t(language, "common.popularity")}</div>
                    <div className="font-semibold text-zinc-950 dark:text-white">{asset.popularity}</div>
                  </div>
                  <div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">{t(language, "common.source")}</div>
                    <div className="font-semibold text-zinc-950 dark:text-white">{quoteLabel(asset, language)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title={t(language, "discover.results")} subtitle={t(language, "discover.resultsSubtitle", { count: assets.length, total: resultTotal, page: search.data?.page ?? 1, totalPages: search.data?.totalPages ?? 1 })}>
        {search.loading ? <LoadingRows rows={6} /> : null}
        {!search.loading && !assets.length ? (
          <StatusBanner
            title={t(language, "discover.noMatchingTitle")}
            body={t(language, "discover.noMatchingBody")}
            action={hasActiveFilters ? (
              <button
                type="button"
                onClick={clearFilters}
                className="h-9 rounded border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-200 dark:hover:bg-white/10"
              >
                {t(language, "discover.clearFilters")}
              </button>
            ) : undefined}
          />
        ) : null}
        <div className="grid gap-3">
          {assets.map((asset) => {
            const selected = compareIds.includes(asset.id);
            const canCompare = isFundAsset(asset);

            return (
              <div
                key={asset.id}
                className="grid gap-4 rounded-lg border border-zinc-200 bg-white p-4 transition hover:border-emerald-200 hover:bg-zinc-50 dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-emerald-400/40 dark:hover:bg-white/[0.06] lg:grid-cols-[minmax(0,1fr)_12rem_13rem] lg:items-center"
              >
                <Link to={assetHref(asset, marketId, language)} state={detailReturnState} className="min-w-0">
                  <div className="font-semibold text-zinc-950 dark:text-white">{assetDisplayName(asset, language)}</div>
                  <div className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                    {assetSubtitle(asset, language)}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                    <span className="rounded-full bg-zinc-100 px-2 py-1 dark:bg-white/10">{marketCurrencyHint(asset.marketId, language)}</span>
                    <span className="rounded-full bg-zinc-100 px-2 py-1 dark:bg-white/10">{quoteLabel(asset, language)}</span>
                    <span className="rounded-full bg-zinc-100 px-2 py-1 dark:bg-white/10">{t(language, "common.updatedAt", { date: updatedLabel(asset.updatedAt, language) })}</span>
                    {assetOriginalName(asset, language) !== asset.symbol ? <span className="rounded-full bg-zinc-100 px-2 py-1 dark:bg-white/10">{assetOriginalName(asset, language)}</span> : null}
                  </div>
                </Link>
                <div>
                  <div className="text-sm text-zinc-500 dark:text-zinc-400">{t(language, "discover.sector")}</div>
                  <div className="mt-1 font-semibold text-zinc-950 dark:text-white">{assetPrimaryCategory(asset, language) || "—"}</div>
                  {asset.dailyChange != null ? <ToneText tone={asset.dailyChange >= 0 ? "positive" : "negative"} marketTone>{formatOptionalPercent(asset.dailyChange)}</ToneText> : null}
                </div>
                <div className="flex flex-wrap gap-2 md:justify-end">
                  <button
                    type="button"
                    onClick={() => addToWatchlist(asset)}
                    className="inline-flex h-10 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-200 dark:hover:bg-white/10"
                  >
                    <Star size={16} />
                    {t(language, "discover.watch")}
                  </button>
                  {canCompare ? (
                    <button
                      type="button"
                      onClick={() => toggleCompare(asset)}
                      className={[
                        "h-10 rounded-lg border px-3 text-sm font-medium transition",
                        selected ? "border-emerald-500 bg-emerald-500 text-white" : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-200 dark:hover:bg-white/10",
                      ].join(" ")}
                    >
                      {selected ? t(language, "discover.selected") : t(language, "common.compare")}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        {search.data && search.data.totalPages > 1 ? (
          <div className="mt-4 flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-3 text-sm dark:border-white/10 dark:bg-white/[0.03]">
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
      </Section>
    </>
  );
}

function LibraryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-white/[0.03]">
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white">{value}</div>
    </div>
  );
}

function isFundAsset(asset: AssetRecord) {
  return asset.kind === "fund" || asset.assetType === "fund" || asset.assetType === "etf";
}

function publicDataRefreshStatus(response: JobsResponse, language: Language) {
  const result = response.job?.result;
  const syncedValue = result?.synced;
  const synced = typeof syncedValue === "number" ? syncedValue : null;
  const failedValue = result?.failed;
  const failed = Array.isArray(failedValue) ? failedValue : [];
  if (synced != null && synced > 0) {
    return t(language, "discover.publicDataRefreshedWithCount", { count: synced.toLocaleString(localeForLanguage(language)) });
  }
  if (failed.length) {
    return t(language, "discover.publicDataRefreshFailed", { reason: refreshFailureReason(failed[0]) });
  }
  return t(language, "discover.publicDataRefreshed");
}

function refreshFailureReason(value: unknown) {
  if (!value || typeof value !== "object") return String(value || "");
  const reason = (value as { reason?: unknown }).reason;
  if (typeof reason !== "string") return "";
  return reason.length > 220 ? `${reason.slice(0, 220)}...` : reason;
}
