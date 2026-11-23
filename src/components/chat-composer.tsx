"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import type { StringKey } from "@/i18n/strings";
import type { ChatSendResult } from "@/server/chat/service";
import { Button } from "./button";
import { useT } from "./i18n-provider";
/** The message box. Sends to the chat API, which decides question or command; shows the outcome and refreshes the thread. */
export function ChatComposer({ threadId }: { threadId: string }) {
  const { t } = useT();
  const router = useRouter();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null as { key: StringKey; error: boolean } | null);
  const [refreshing, startRefresh] = useTransition();
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/workspace/chat/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId, body }),
      });
      if (res.ok) {
        const sent = (await res.json()) as ChatSendResult;
        setBody("");
        if (sent.route === "command") setNotice({ key: sent.task?.status === "failed" ? "chat.sent.commandFailed" : "chat.sent.command", error: sent.task?.status === "failed" });
      } else {
        const code = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
        setNotice({ key: code === "invalid_input" ? "chat.err.invalid" : "chat.err.generic", error: true });
      }
      startRefresh(() => router.refresh());
    } catch {
      setNotice({ key: "chat.err.generic", error: true });
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-snug" data-testid="chat-composer">
      <label htmlFor="chat-input" className="text-caption text-ink-muted">{t("chat.inputLabel")}</label>
      <textarea
        id="chat-input"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        maxLength={4000}
        className="w-full rounded-control border border-border-strong bg-surface p-cozy text-body text-ink"
      />
      <Button type="submit" disabled={busy || refreshing || !body.trim()} className="min-h-tap">
        {busy ? t("chat.sending") : t("chat.send")}
      </Button>
      {notice ? (
        <p role={notice.error ? "alert" : "status"} data-testid="chat-notice" className={`text-caption ${notice.error ? "text-danger" : "text-ink-soft"}`}>
          {t(notice.key)}
        </p>
      ) : null}
    </form>
  );
}
