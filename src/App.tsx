import type { ReactNode } from "react";
import { Navigate, Route, Routes, useParams, useSearchParams } from "react-router-dom";
import { AppShell } from "@/components/layout/app-shell";
import { AssetDetailPage } from "@/features/assets";
import { ComparePage, CompareResultPage } from "@/features/compare";
import { CustomFundDcaPlanPage, CustomFundPage, CustomFundResultPage } from "@/features/custom-fund";
import { DCAPage, DCAResultPage } from "@/features/dca";
import { DiscoverPage } from "@/features/funds";
import { FundDetailPage } from "@/features/funds/fund-detail-page";
import { HomePage } from "@/features/home";
import { InsightsPage, InsightsResultPage } from "@/features/insights";
import { PortfolioDcaPlanPage, PortfolioPage, PortfolioResultPage } from "@/features/portfolio";
import { ReportsPage } from "@/features/reports";
import { SettingsPage } from "@/features/settings";
import { WatchlistPage } from "@/features/watchlist";
import { parseLanguage } from "@/lib/i18n";
import type { AssetType, MarketId } from "@/lib/types";
import { parseMarket } from "@/lib/utils";
import { useMarketStore } from "@/stores/market-store";

type RoutedProps = {
  children: (props: { marketId: MarketId; language: ReturnType<typeof parseLanguage>; searchParams: URLSearchParams }) => ReactNode;
};

function RoutedAppPage({ children }: RoutedProps) {
  const [searchParams] = useSearchParams();
  const storedMarket = useMarketStore((state) => state.marketId);
  const marketId = searchParams.has("market") ? parseMarket(searchParams.get("market")) : storedMarket;
  const language = parseLanguage(searchParams.get("lang"));

  return <AppShell>{children({ marketId, language, searchParams })}</AppShell>;
}

function AssetRoute() {
  const { id = "" } = useParams();
  return (
    <RoutedAppPage>
      {({ marketId, language, searchParams }) => (
        <AssetDetailPage
          assetId={id}
          assetType={parseAssetType(searchParams.get("type"))}
          marketId={marketId}
          language={language}
        />
      )}
    </RoutedAppPage>
  );
}

function FundRoute() {
  const { id = "" } = useParams();
  return (
    <RoutedAppPage>
      {({ marketId, language }) => <FundDetailPage fundId={id} marketId={marketId} language={language} />}
    </RoutedAppPage>
  );
}

function LegacyReportRedirect() {
  const [searchParams] = useSearchParams();
  const query = searchParams.toString();
  return <Navigate to={`/reports${query ? `?${query}` : ""}`} replace />;
}

function parseAssetType(value: string | null): AssetType | undefined {
  if (value === "fund" || value === "stock" || value === "etf" || value === "customFund" || value === "customAsset") {
    return value;
  }
  return undefined;
}

function parseIdList(searchParams: URLSearchParams) {
  return searchParams
    .getAll("ids")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function DefaultHomeRedirect() {
  const marketId = useMarketStore((state) => state.marketId);
  return <Navigate to={`/home?market=${marketId}`} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<DefaultHomeRedirect />} />
      <Route
        path="/home"
        element={<RoutedAppPage>{({ marketId, language }) => <HomePage marketId={marketId} language={language} />}</RoutedAppPage>}
      />
      <Route
        path="/discover"
        element={<RoutedAppPage>{({ marketId, language }) => <DiscoverPage marketId={marketId} language={language} />}</RoutedAppPage>}
      />
      <Route
        path="/dca"
        element={<RoutedAppPage>{({ marketId, language, searchParams }) => <DCAPage marketId={marketId} fundId={searchParams.get("fund") ?? undefined} language={language} />}</RoutedAppPage>}
      />
      <Route
        path="/dca/result"
        element={<RoutedAppPage>{({ marketId, language }) => <DCAResultPage marketId={marketId} language={language} />}</RoutedAppPage>}
      />
      <Route
        path="/portfolio"
        element={<RoutedAppPage>{({ marketId, language }) => <PortfolioPage marketId={marketId} language={language} />}</RoutedAppPage>}
      />
      <Route
        path="/portfolio/dca-plan"
        element={<RoutedAppPage>{({ marketId, language }) => <PortfolioDcaPlanPage marketId={marketId} language={language} />}</RoutedAppPage>}
      />
      <Route
        path="/portfolio/result"
        element={<RoutedAppPage>{({ marketId, language }) => <PortfolioResultPage marketId={marketId} language={language} />}</RoutedAppPage>}
      />
      <Route
        path="/custom-fund"
        element={<RoutedAppPage>{({ marketId, language }) => <CustomFundPage marketId={marketId} language={language} />}</RoutedAppPage>}
      />
      <Route
        path="/custom-fund/dca-plan"
        element={<RoutedAppPage>{({ marketId, language }) => <CustomFundDcaPlanPage marketId={marketId} language={language} />}</RoutedAppPage>}
      />
      <Route
        path="/custom-fund/result"
        element={<RoutedAppPage>{({ marketId, language }) => <CustomFundResultPage marketId={marketId} language={language} />}</RoutedAppPage>}
      />
      <Route
        path="/insights"
        element={<RoutedAppPage>{({ marketId, language }) => <InsightsPage marketId={marketId} language={language} />}</RoutedAppPage>}
      />
      <Route
        path="/insights/result"
        element={<RoutedAppPage>{({ marketId, language }) => <InsightsResultPage marketId={marketId} language={language} />}</RoutedAppPage>}
      />
      <Route
        path="/compare"
        element={<RoutedAppPage>{({ marketId, language, searchParams }) => <ComparePage marketId={marketId} initialIds={parseIdList(searchParams)} language={language} />}</RoutedAppPage>}
      />
      <Route
        path="/compare/result"
        element={<RoutedAppPage>{({ marketId, language, searchParams }) => <CompareResultPage marketId={marketId} initialIds={parseIdList(searchParams)} language={language} />}</RoutedAppPage>}
      />
      <Route
        path="/watchlist"
        element={<RoutedAppPage>{({ marketId, language }) => <WatchlistPage marketId={marketId} language={language} />}</RoutedAppPage>}
      />
      <Route
        path="/reports"
        element={<RoutedAppPage>{({ marketId, language }) => <ReportsPage marketId={marketId} language={language} />}</RoutedAppPage>}
      />
      <Route
        path="/settings"
        element={<RoutedAppPage>{({ marketId, language }) => <SettingsPage marketId={marketId} language={language} />}</RoutedAppPage>}
      />
      <Route path="/assets/:id" element={<AssetRoute />} />
      <Route path="/funds/:id" element={<FundRoute />} />
      <Route path="/reports/:id" element={<LegacyReportRedirect />} />
      <Route path="*" element={<DefaultHomeRedirect />} />
    </Routes>
  );
}
