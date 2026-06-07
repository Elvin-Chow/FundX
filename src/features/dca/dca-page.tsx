import { t, type Language } from "@/lib/i18n";
import { normalizeMarket, type Market } from "../../components/types";
import { DCASimulator } from "./dca-simulator";

export function DCAPage({ market = "us", marketId, fundId, language = "en" }: { market?: Market; marketId?: Market; fundId?: string; language?: Language }) {
  const activeMarket = normalizeMarket(marketId ?? market);

  return (
    <div>
      <div className="mb-5">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-emerald-600">{t(language, "nav.dca")}</div>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 sm:text-4xl">{t(language, "dca.title")}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-500 sm:text-base">{t(language, "dca.subtitle")}</p>
      </div>
      <DCASimulator marketId={activeMarket} fundId={fundId} language={language} />
    </div>
  );
}
