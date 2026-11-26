"use client";

import { createContext, useContext, useMemo } from "react";
import { translate, type Catalog, type Locale, type Messages, type Translate } from "./i18n-core";

export * from "./i18n-core";

const LocaleContext = createContext<Locale>("en");

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

/** The translate function for a catalog in the current locale. */
export function useT<T extends Catalog>(messages: Messages<T>): Translate<T> {
  const locale = useLocale();
  return useMemo(() => translate(messages, locale), [messages, locale]);
}
