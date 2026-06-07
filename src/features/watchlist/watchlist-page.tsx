import { t, type Language } from "@/lib/i18n";
import { normalizeMarket, type Market } from "../../components/types";
import { PageHeader } from "../shared/feature-shell";
import { WatchlistClient } from "./watchlist-client";

export function WatchlistPage({ market = "us", marketId, language = "en" }: { market?: Market; marketId?: Market; language?: Language }) {
  const activeMarket = normalizeMarket(marketId ?? market);

  return (
    <div>
      <PageHeader eyebrow={t(language, "nav.watchlist")} title={t(language, "watchlist.title")} description={t(language, "watchlist.subtitle")} showDivider={false} />
      <WatchlistClient marketId={activeMarket} language={language} />
    </div>
  );
}
