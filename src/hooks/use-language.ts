"use client";

import { useEffect } from "react";
import { type Language } from "@/lib/i18n";
import { useMarketStore } from "@/stores/market-store";

export function useResolvedLanguage(preferred?: Language): Language {
  const language = useMarketStore((state) => state.language);
  const setLanguage = useMarketStore((state) => state.setLanguage);

  useEffect(() => {
    if (preferred && preferred !== language) {
      setLanguage(preferred);
    }
  }, [language, preferred, setLanguage]);

  return preferred ?? language;
}
