"use client";
import type { ChatMessage } from "@/server/chat/service";
import { ButtonLink } from "./button-link";
import { useT } from "./i18n-provider";
/** One chat message. Owner messages align right; agent messages carry the live sender name. A command links to its task. */
export function MessageBubble({ message }: { message: ChatMessage }) {
  const { t } = useT();
  const mine = message.sender === "owner";
  return (
    <li
      data-testid="chat-message"
      data-sender={message.sender}
      className={`flex max-w-full flex-col gap-tight rounded-control border p-cozy ${mine ? "self-end border-primary bg-surface" : "self-start border-border bg-surface-muted"}`}
    >
      <p className="text-caption text-ink-muted">
        <span data-testid="chat-sender">{mine ? t("chat.you") : message.senderName}</span> · {message.at}
      </p>
      <p className="whitespace-pre-wrap break-words text-body text-ink">{message.body}</p>
      {message.taskId ? <ButtonLink href={`/board/${message.taskId}`} size="sm" className="min-h-tap self-start">{t("chat.openTask")}</ButtonLink> : null}
    </li>
  );
}
