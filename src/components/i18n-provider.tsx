"use client";
import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_LANGUAGE, navLabel, translate, type Language, type StringKey } from "@/i18n/strings";

const LanguageContext = createContext<Language>(DEFAULT_LANGUAGE);

/** Makes the tenant's language available to client components. Strings still come only from the table. */
export function I18nProvider(props: { language: Language; children: ReactNode }) {
  return <LanguageContext.Provider value={props.language}>{props.children}</LanguageContext.Provider>;
}

export function useLanguage(): Language {
  return useContext(LanguageContext);
}

export function useT() {
  const lang = useContext(LanguageContext);
  return {
    lang,
    t: (key: StringKey) => translate(lang, key),
    nav: (item: { id: string; label: string }) => navLabel(lang, item),
  };
}
