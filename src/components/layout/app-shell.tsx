"use client";

import {
  BarChart3,
  CandlestickChart,
  FileText,
  FlaskConical,
  Home,
  Layers3,
  ListChecks,
  PieChart,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";
import { useEffect } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useMarketLatestRefresh } from "@/hooks/use-market-latest-refresh";
import { MARKET_CONFIGS } from "@/lib/constants";
import { DEFAULT_LANGUAGE, getMarketCopy, languageToHtmlLang, parseLanguage, t } from "@/lib/i18n";
import { cn, parseMarket } from "@/lib/utils";
import { useMarketStore } from "@/stores/market-store";

const navItems = [
  { href: "/home", labelKey: "nav.home", icon: Home },
  { href: "/discover", labelKey: "nav.discover", icon: Search },
  { href: "/dca", labelKey: "nav.dca", icon: FlaskConical },
  { href: "/portfolio", labelKey: "nav.portfolio", icon: PieChart },
  { href: "/custom-fund", labelKey: "nav.customFund", icon: Layers3 },
  { href: "/insights", labelKey: "nav.insights", icon: Sparkles },
  { href: "/compare", labelKey: "nav.compare", icon: BarChart3 },
  { href: "/watchlist", labelKey: "nav.watchlist", icon: ListChecks },
  { href: "/reports", labelKey: "nav.reports", icon: FileText },
  { href: "/settings", labelKey: "nav.settings", icon: Settings }
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const pathname = location.pathname;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const storedMarket = useMarketStore((state) => state.marketId);
  const marketId = searchParams.has("market") ? parseMarket(searchParams.get("market")) : storedMarket;
  const urlLanguage = parseLanguage(searchParams.get("lang"));
  const hasLanguageParam = searchParams.has("lang");
  const market = MARKET_CONFIGS[marketId];
  const { language, setLanguage, setMarket, syncThemeMode, themeMode } = useMarketStore();
  const activeLanguage = hasLanguageParam ? urlLanguage : language;
  const marketCopy = getMarketCopy(activeLanguage, marketId);
  useMarketLatestRefresh(marketId);

  useEffect(() => {
    setMarket(marketId);
    if (hasLanguageParam) {
      setLanguage(urlLanguage);
      document.documentElement.lang = languageToHtmlLang(urlLanguage);
    } else {
      document.documentElement.lang = languageToHtmlLang(language);
      if (language !== DEFAULT_LANGUAGE) {
        const params = new URLSearchParams(searchParams.toString());
        params.set("lang", language);
        navigate(`${pathname}?${params.toString()}`, { replace: true });
      }
    }
  }, [hasLanguageParam, language, marketId, navigate, pathname, searchParams, setLanguage, setMarket, urlLanguage]);

  useEffect(() => {
    syncThemeMode();
    if (themeMode !== "auto") return;
    const timer = window.setInterval(() => syncThemeMode(), 60_000);
    return () => window.clearInterval(timer);
  }, [syncThemeMode, themeMode]);

  return (
    <div className="flex min-h-screen flex-col bg-white text-ink dark:bg-[#050706] dark:text-white">
      <aside className="fixed left-0 top-0 hidden h-screen w-64 border-r border-line bg-white/92 px-4 py-5 backdrop-blur-xl dark:border-white/10 dark:bg-[#050706]/90 lg:block">
        <Link to={`/home?market=${marketId}&lang=${activeLanguage}`} className="flex items-center gap-3 px-2">
          <span className="flex h-10 w-10 items-center justify-center rounded bg-ink text-white dark:bg-money dark:text-ink">
            <CandlestickChart size={21} />
          </span>
          <span>
            <span className="block text-lg font-semibold">FundX</span>
            <span className="block text-xs text-slate-500 dark:text-slate-400">{market.currency} {t(activeLanguage, "app.portfolioOs")}</span>
          </span>
        </Link>

        <nav className="mt-7 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = isActiveNavPath(pathname, item.href);
            return (
              <Link
                key={item.href}
                to={`${item.href}?market=${marketId}&lang=${activeLanguage}`}
                className={cn(
                  "flex h-10 items-center gap-3 rounded px-3 text-sm font-medium transition",
                  active
                    ? "bg-ink text-white dark:bg-white dark:text-ink"
                    : "text-slate-600 hover:bg-slate-100 hover:text-ink dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white"
                )}
              >
                <Icon size={18} />
                {t(activeLanguage, item.labelKey)}
              </Link>
            );
          })}
        </nav>
      </aside>

      <header className="sticky top-0 z-30 border-b border-line bg-white/88 px-4 py-3 backdrop-blur-xl dark:border-white/10 dark:bg-[#050706]/85 lg:ml-64">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">{marketCopy.name}</p>
            <p className="text-sm font-medium text-ink dark:text-white">{marketCopy.style}</p>
          </div>
          <div className="flex items-center gap-2" />
        </div>
      </header>

      <main className="flex flex-1 flex-col px-4 pb-24 pt-6 lg:ml-64 lg:px-8 lg:pb-0">
        <div className="mx-auto w-full max-w-7xl">{children}</div>
        <footer className="mx-auto mt-auto w-full max-w-7xl border-t border-line py-4 text-center text-xs text-slate-500 dark:border-white/10 dark:text-slate-400">
          {t(activeLanguage, "app.footerDeveloper")}
        </footer>
      </main>

      <nav className="fixed bottom-0 left-0 right-0 z-40 flex gap-1 overflow-x-auto border-t border-line bg-white/92 px-2 py-2 backdrop-blur-xl dark:border-white/10 dark:bg-[#050706]/92 lg:hidden">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = isActiveNavPath(pathname, item.href);
          return (
            <Link
              key={item.href}
              to={`${item.href}?market=${marketId}&lang=${activeLanguage}`}
              className={cn("flex min-w-[4.75rem] flex-col items-center gap-1 rounded py-1.5 text-[11px]", active ? "text-money" : "text-slate-500 dark:text-slate-400")}
            >
              <Icon size={18} />
              <span className="max-w-full truncate">{t(activeLanguage, item.labelKey)}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

function isActiveNavPath(pathname: string, href: string) {
  return pathname === href || (href !== "/home" && pathname.startsWith(`${href}/`));
}
