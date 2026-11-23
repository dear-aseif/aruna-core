"use client";
import type { StringKey } from "@/i18n/strings";
import type { TaskStatus } from "@/server/tasks/state-machine";
import { useT } from "./i18n-provider";

const TONE: Record<TaskStatus, string> = {
  queued: "border border-border text-ink-soft",
  working: "border border-border text-ink-soft",
  in_review: "border border-border-strong text-ink-soft",
  pending_approval: "bg-primary text-primary-ink",
  done: "bg-ink-soft text-surface",
  rejected: "border border-border-strong text-ink-muted",
  expired: "border border-danger text-danger",
  failed: "bg-danger text-primary-ink",
};

export const statusLabelKey = (s: TaskStatus) => `status.${s}` as StringKey;

/** The task status as a small localized label. */
export function StatusBadge({ status }: { status: TaskStatus }) {
  const { t } = useT();
  return (
    <span data-testid="status-badge" data-status={status} className={`rounded-control px-snug py-tight text-caption font-semibold ${TONE[status]}`}>
      {t(statusLabelKey(status))}
    </span>
  );
}
