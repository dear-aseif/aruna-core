"use client";
import type { ReactNode } from "react";
import type { BoardTask } from "@/server/board/service";
import type { StringKey } from "@/i18n/strings";
import { ButtonLink } from "./button-link";
import { useT } from "./i18n-provider";
import { StatusBadge } from "./status-badge";
import { TaskHistorySummary } from "./task-history-summary";

/**
 * One task on the board: title, status, responsible agent, and (for Pending Approval) the decision
 * deadline and the checked draft the owner would approve. `actions` is the slot for the approval
 * variant's buttons. Renders what the server sent; no business rules here.
 */
export function TaskCard({ task, actions }: { task: BoardTask; actions?: ReactNode }) {
  const { t } = useT();
  const fields = task.draft ? Object.entries(task.draft.fields) : [];
  return (
    <article data-testid="task-card" data-task-id={task.id} data-status={task.status} className="flex flex-col gap-snug rounded-control border border-border bg-surface p-cozy">
      <div className="flex items-start justify-between gap-snug">
        <h3 className="text-body font-semibold text-ink">{task.title}</h3>
        <StatusBadge status={task.status} />
      </div>
      <p className="text-caption text-ink-muted">
        {t("board.agent")}: <span data-testid="task-agent">{task.agent}</span> · {t("task.origin")}: <span data-testid="task-origin">{t(`task.origin.${task.origin}` as StringKey)}</span>
      </p>
      {task.deadline ? (
        <p className="text-caption text-ink-soft">
          {t("board.decideBefore")} <span data-testid="task-deadline">{task.deadline}</span>
        </p>
      ) : null}
      {fields.length > 0 ? (
        <dl data-testid="task-draft" className="flex flex-col gap-tight text-caption">
          {fields.map(([k, v]) => (
            <div key={k} className="flex gap-cozy">
              <dt className="shrink-0 text-ink-muted">{k}</dt>
              <dd className="text-ink">{String(v)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {task.error ? (
        <p className="text-caption text-danger">
          {t("board.errorLabel")}: {task.error}
        </p>
      ) : null}
      <TaskHistorySummary checks={task.checks} approvals={task.approvals} />
      {actions}
      <ButtonLink href={`/board/${task.id}`} size="sm" className="min-h-tap">{t("task.detail.open")}</ButtonLink>
    </article>
  );
}
