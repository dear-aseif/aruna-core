"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { LANGUAGES, type Language } from "@/i18n/strings";
import { Button } from "./button";
import { useT } from "./i18n-provider";

/** EN | ID switch. Saves the choice for the tenant through the server operation, then re-renders. */
export function LanguageToggle() {
  const { lang, t } = useT();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failed, setFailed] = useState(false);
  async function choose(next: Language) {
    if (next === lang) return;
    setFailed(false);
    const res = await fetch("/api/workspace/language", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language: next }),
    });
    if (!res.ok) return setFailed(true);
    start(() => router.refresh());
  }
  return (
    <div role="group" aria-label={t("shell.language")} className="flex items-center gap-tight" data-testid="language-toggle">
      {LANGUAGES.map((l) => (
        <Button key={l} size="sm" variant={l === lang ? "primary" : "outline"} aria-pressed={l === lang} disabled={pending}
          onClick={() => choose(l)}>
          {t(l === "en" ? "shell.languageEn" : "shell.languageId")}
        </Button>
      ))}
      {failed ? <span role="alert" className="text-caption text-danger">{t("shell.languageError")}</span> : null}
    </div>
  );
}
