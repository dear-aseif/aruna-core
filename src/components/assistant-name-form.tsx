"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import type { StringKey } from "@/i18n/strings";
import { Button } from "./button";
import { useT } from "./i18n-provider";
/** Rename the assistant. The server validates and audits; on success the page re-renders with the new name everywhere. */
export function AssistantNameForm({ current }: { current: string }) {
  const { t } = useT();
  const router = useRouter();
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null as { key: StringKey; error: boolean } | null);
  const [refreshing, startRefresh] = useTransition();
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/workspace/settings/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        setName(((await res.json()) as { name: string }).name);
        setNotice({ key: "settings.renamed", error: false });
        startRefresh(() => router.refresh());
      } else {
        const code = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
        setNotice({ key: code === "invalid_input" ? "settings.err.name" : "settings.err.generic", error: true });
      }
    } catch {
      setNotice({ key: "settings.err.generic", error: true });
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-snug" data-testid="assistant-name-form">
      <label htmlFor="assistant-name" className="text-caption text-ink-muted">{t("settings.assistantName")}</label>
      <input
        id="assistant-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={60}
        className="min-h-tap w-full rounded-control border border-border-strong bg-surface px-cozy text-body text-ink"
      />
      <Button type="submit" disabled={busy || refreshing || !name.trim()} className="min-h-tap">{t("settings.rename")}</Button>
      {notice ? (
        <p role={notice.error ? "alert" : "status"} data-testid="assistant-name-notice" className={`text-caption ${notice.error ? "text-danger" : "text-ink-soft"}`}>
          {t(notice.key)}
        </p>
      ) : null}
    </form>
  );
}
