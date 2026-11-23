"use client";
import type { ChatModel } from "@/server/chat/service";
import { ChatComposer } from "./chat-composer";
import { useT } from "./i18n-provider";
import { MessageBubble } from "./message-bubble";
import { ThreadTabs } from "./thread-tabs";
/** The chat screen: thread tabs (Maestro plus one per active specialist), the selected thread's messages, the composer. */
export function ChatView({ model }: { model: ChatModel }) {
  const { t, nav } = useT();
  return (
    <section className="flex flex-col gap-cozy" data-testid="chat-view" data-thread-id={model.selectedThreadId}>
      <h1 className="text-title font-semibold">{nav({ id: "chat", label: "chat" })}</h1>
      <ThreadTabs threads={model.threads} selectedId={model.selectedThreadId} />
      <p className="text-caption text-ink-muted">{t("chat.hint")}</p>
      {model.messages.length === 0 ? (
        <p data-testid="chat-empty" className="rounded-control border border-border p-cozy text-body text-ink-muted">{t("chat.empty")}</p>
      ) : (
        <ul aria-label={t("chat.messages")} data-testid="chat-messages" className="flex flex-col gap-snug">
          {model.messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
        </ul>
      )}
      <ChatComposer threadId={model.selectedThreadId} />
    </section>
  );
}
