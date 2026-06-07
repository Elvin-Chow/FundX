import { t, type Language } from "@/lib/i18n";
import { normalizeMarket, type Market } from "../../components/types";
import { CustomFundBuilder } from "./custom-fund-builder";

export function CustomFundPage({ market = "us", marketId, language = "en" }: { market?: Market; marketId?: Market; language?: Language }) {
  const activeMarket = normalizeMarket(marketId ?? market);

  return (
    <div>
      <div className="mb-5">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-emerald-600">{t(language, "nav.customFund")}</div>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 sm:text-4xl">{t(language, "custom.title")}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-500 sm:text-base">{t(language, "custom.subtitle")}</p>
      </div>
      <CustomFundBuilder marketId={activeMarket} language={language} />
    </div>
  );
}
