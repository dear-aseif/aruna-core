"use client";
import Link from "next/link";
import type { ChatThread } from "@/server/chat/service";
import { useT } from "./i18n-provider";
/** One link per chat thread (Maestro first). The selected thread is `aria-current`; names come from the server. */
export function ThreadTabs({ threads, selectedId }: { threads: ChatThread[]; selectedId: string }) {
  const { t } = useT();
  return (
    <nav aria-label={t("chat.threads")} data-testid="thread-tabs" className="-mx-gutter flex gap-snug overflow-x-auto px-gutter pb-snug">
      {threads.map((th) => {
        const on = th.id === selectedId;
        return (
          <Link
            key={th.id}
            href={`/chat?thread=${th.id}`}
            data-agent={th.agent}
            aria-current={on ? "page" : undefined}
            className={`min-h-tap shrink-0 whitespace-nowrap rounded-control px-cozy py-snug text-body ${on ? "bg-primary text-primary-ink" : "border border-border-strong bg-surface text-ink-soft"}`}
          >
            {th.displayName}
          </Link>
        );
      })}
    </nav>
  );
}
