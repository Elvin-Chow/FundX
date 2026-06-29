import type { PublicDataRefreshResult } from "@/lib/api-contracts";
import { t, type Language } from "@/lib/i18n";

export function publicDataRefreshStatus(result: PublicDataRefreshResult | null | undefined, language: Language, fallbackKey = "publicDataRefresh.noNewData") {
  if (!result) return t(language, fallbackKey);
  if (result.fetched > 0) return t(language, "publicDataRefresh.fetchedWithCount", { count: result.fetched });
  if (result.cached?.length && !result.failed?.length) return t(language, "publicDataRefresh.cachedWithCount", { count: result.cached.length });
  if (result.failed?.length) return t(language, "publicDataRefresh.failed", { reason: refreshFailureReason(result.failed[0]) });
  return t(language, "publicDataRefresh.noNewData");
}

export function refreshFailureReason(value: unknown) {
  if (!value || typeof value !== "object") return String(value || "");
  const reason = (value as { reason?: unknown }).reason;
  if (typeof reason !== "string") return "";
  return reason.length > 160 ? `${reason.slice(0, 160)}...` : reason;
}
