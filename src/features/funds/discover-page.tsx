import { t, type Language } from "@/lib/i18n";
import { normalizeMarket, type Market } from "../../components/types";
import { PageHeader } from "../shared/feature-shell";
import { DiscoverFundsClient } from "./discover-funds-client";

export function DiscoverPage({ market = "us", marketId, language = "en" }: { market?: Market; marketId?: Market; language?: Language }) {
  const activeMarket = normalizeMarket(marketId ?? market);

  return (
    <div>
      <PageHeader
        eyebrow={t(language, "nav.discover")}
        title={t(language, "discover.findAssets")}
        description={t(language, "discover.subtitle")}
      />
      <DiscoverFundsClient marketId={activeMarket} language={language} />
    </div>
  );
}
