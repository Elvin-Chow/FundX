"use client";

import { ChevronDown, Loader2, Search } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { apiErrorMessage, apiGet } from "@/lib/api-client";
import { assetDisplayName, assetKindLabel, assetPrimaryCategory, quoteStatusLabel } from "@/lib/asset-display";
import type { AssetSearchResponse, AssetSearchType } from "@/lib/api-contracts";
import { assetTypeLabel, t, type Language } from "@/lib/i18n";
import type { AssetRecord, MarketId } from "@/lib/types";

type AssetSearchSelectCopy = {
  placeholder: string;
  empty: string;
  error: string;
};

const copyByLanguage: Record<Language, AssetSearchSelectCopy> = {
  en: {
    placeholder: "Search by symbol, name, sector",
    empty: "No matching assets",
    error: "Asset search failed",
  },
  "zh-CN": {
    placeholder: "按代码、名称、板块搜索",
    empty: "没有匹配资产",
    error: "资产搜索失败",
  },
  "zh-TW": {
    placeholder: "按代碼、名稱、板塊搜尋",
    empty: "沒有匹配資產",
    error: "資產搜尋失敗",
  },
};

export type AssetSearchSelectProps = {
  marketId: MarketId;
  value?: string;
  selectedAsset?: AssetRecord | null;
  selectedLabel?: string;
  type?: AssetSearchType;
  language: Language;
  label?: string;
  placeholder?: string;
  pageSize?: number;
  debounceMs?: number;
  disabled?: boolean;
  className?: string;
  onChange: (asset: AssetRecord) => void;
};

export function AssetSearchSelect({
  marketId,
  value,
  selectedAsset,
  selectedLabel,
  type = "all",
  language,
  label,
  placeholder,
  pageSize = 12,
  debounceMs = 250,
  disabled = false,
  className,
  onChange,
}: AssetSearchSelectProps) {
  const inputId = useId();
  const listboxId = `${inputId}-listbox`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [items, setItems] = useState<AssetRecord[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const copy = copyByLanguage[language];
  const selectedDisplay = selectedAsset ? formatSelectedAsset(selectedAsset) : selectedLabel ?? "";
  const inputValue = isOpen ? query : selectedDisplay;
  const activeOptionId = activeIndex >= 0 ? `${listboxId}-${items[activeIndex]?.id}` : undefined;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), debounceMs);
    return () => window.clearTimeout(timer);
  }, [debounceMs, query]);

  useEffect(() => {
    setPage(1);
  }, [debouncedQuery, marketId, pageSize, type]);

  useEffect(() => {
    if (disabled) {
      setItems([]);
      setLoading(false);
      setError(null);
      setActiveIndex(-1);
      return;
    }

    let mounted = true;
    const controller = new AbortController();
    const q = debouncedQuery;

    setLoading(true);
    setError(null);

    apiGet<AssetSearchResponse>(
      "/api/assets/search",
      {
        market: marketId,
        q,
        type,
        sort: q ? "relevance" : "popularity",
        page,
        pageSize,
      },
      controller.signal,
    )
      .then((response) => {
        if (!mounted) return;
        setItems(response.items);
        setTotal(response.total);
        setTotalPages(response.totalPages);
        setActiveIndex(response.items.length ? 0 : -1);
      })
      .catch((searchError) => {
        if (!mounted || isAbortError(searchError)) return;
        setItems([]);
        setTotal(0);
        setTotalPages(1);
        setActiveIndex(-1);
        setError(apiErrorMessage(searchError) || copy.error);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
      controller.abort();
    };
  }, [copy.error, debouncedQuery, disabled, marketId, page, pageSize, type]);

  useEffect(() => {
    setQuery("");
    setIsOpen(false);
    setPage(1);
  }, [marketId, type, value]);

  function chooseAsset(asset: AssetRecord) {
    onChange(asset);
    setQuery("");
    setIsOpen(false);
    inputRef.current?.blur();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setIsOpen(false);
      setQuery("");
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIsOpen(true);
      if (items.length) setActiveIndex((current) => (current + 1 + items.length) % items.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setIsOpen(true);
      if (items.length) setActiveIndex((current) => (current <= 0 ? items.length - 1 : current - 1));
      return;
    }

    if (event.key === "Enter" && isOpen && activeIndex >= 0 && items[activeIndex]) {
      event.preventDefault();
      chooseAsset(items[activeIndex]);
    }
  }

  return (
    <div className={`relative text-sm ${className ?? ""}`}>
      <label htmlFor={inputId} className="font-medium text-zinc-950 dark:text-white">
        {label ?? t(language, "common.asset")}
      </label>
      <div className="relative mt-2">
        <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" size={16} />
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-controls={listboxId}
          aria-expanded={isOpen}
          aria-activedescendant={activeOptionId}
          autoComplete="off"
          disabled={disabled}
          value={inputValue}
          placeholder={placeholder ?? copy.placeholder}
          onFocus={() => setIsOpen(true)}
          onBlur={() => window.setTimeout(() => setIsOpen(false), 120)}
          onChange={(event) => {
            setQuery(event.target.value);
            setIsOpen(true);
          }}
          onKeyDown={handleKeyDown}
          className="h-10 w-full rounded border border-zinc-200 bg-white px-9 text-sm text-zinc-950 outline-none transition placeholder:text-zinc-400 focus:border-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-400 dark:border-white/10 dark:bg-white/[0.03] dark:text-white dark:placeholder:text-zinc-500 dark:disabled:bg-white/[0.02] dark:disabled:text-zinc-500"
        />
        {loading ? (
          <Loader2 className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-zinc-400" size={16} />
        ) : (
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400" size={16} />
        )}
      </div>
      {isOpen ? (
        <div
          id={listboxId}
          role="listbox"
          className="absolute z-30 mt-2 w-full overflow-hidden rounded border border-zinc-200 bg-white shadow-lg dark:border-white/10 dark:bg-zinc-950 dark:shadow-black/30"
        >
          <div className="max-h-72 overflow-y-auto">
            {error ? (
              <div className="px-3 py-3 text-sm text-red-600 dark:text-red-300">{error}</div>
            ) : null}
            {!error && loading ? (
              <div className="px-3 py-3 text-sm text-zinc-500 dark:text-zinc-400">{t(language, "common.loading")}...</div>
            ) : null}
            {!error && !loading && !items.length ? (
              <div className="px-3 py-3 text-sm text-zinc-500 dark:text-zinc-400">{copy.empty}</div>
            ) : null}
            {!error && items.map((asset, index) => (
              <button
                key={`${asset.assetType}-${asset.id}`}
                id={`${listboxId}-${asset.id}`}
                type="button"
                role="option"
                aria-selected={asset.id === value}
                onMouseDown={(event) => {
                  event.preventDefault();
                  chooseAsset(asset);
                }}
                className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition ${index === activeIndex ? "bg-zinc-50 dark:bg-white/[0.08]" : "hover:bg-zinc-50 dark:hover:bg-white/[0.06]"}`}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium text-zinc-950 dark:text-white">{asset.symbol} · {assetDisplayName(asset, language)}</span>
                  <span className="mt-0.5 block truncate text-xs text-zinc-500 dark:text-zinc-400">{assetMeta(asset, language)}</span>
                </span>
                <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">{quoteStatusLabel(asset, language)}</span>
              </button>
            ))}
          </div>
          {!error && totalPages > 1 ? (
            <div className="flex items-center justify-between gap-2 border-t border-zinc-100 bg-zinc-50 px-3 py-2 text-xs text-zinc-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-400">
              <button
                type="button"
                disabled={page <= 1 || loading}
                onMouseDown={(event) => {
                  event.preventDefault();
                  setPage((current) => Math.max(1, current - 1));
                }}
                className="h-8 rounded border border-zinc-200 bg-white px-2 font-medium text-zinc-700 disabled:cursor-not-allowed disabled:text-zinc-300 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-200 dark:disabled:text-zinc-500"
              >
                {t(language, "common.previous")}
              </button>
              <span className="min-w-0 truncate">
                {t(language, "common.pageOf", { page, totalPages })} · {total.toLocaleString()}
              </span>
              <button
                type="button"
                disabled={page >= totalPages || loading}
                onMouseDown={(event) => {
                  event.preventDefault();
                  setPage((current) => Math.min(totalPages, current + 1));
                }}
                className="h-8 rounded border border-zinc-200 bg-white px-2 font-medium text-zinc-700 disabled:cursor-not-allowed disabled:text-zinc-300 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-200 dark:disabled:text-zinc-500"
              >
                {t(language, "common.next")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function formatSelectedAsset(asset: AssetRecord) {
  return `${asset.symbol} · ${asset.name}`;
}

function assetMeta(asset: AssetRecord, language: Language) {
  return [
    assetKindLabel(asset, language) || (asset.kind === "fund" ? assetTypeLabel(language, "fund") : assetTypeLabel(language, "stock")),
    assetPrimaryCategory(asset, language),
  ].filter(Boolean).join(" · ");
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
