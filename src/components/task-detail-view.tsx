"use client";
import type { StringKey } from "@/i18n/strings";
import type { TaskDetailModel } from "@/server/board/service";
import { AuditTrail } from "./audit-trail";
import { ButtonLink } from "./button-link";
import { useT } from "./i18n-provider";
import { StatusBadge } from "./status-badge";
import { TaskHistorySummary } from "./task-history-summary";
/** One task: agent, origin, status, draft, check and approval history, and the full audit trail. Read only. */
export function TaskDetailView({ detail }: { detail: TaskDetailModel }) {
  const { t } = useT();
  const { task } = detail;
  const fields = Object.entries(detail.fields);
  return (
    <div data-testid="task-detail" data-task-id={task.id} data-status={task.status} className="flex flex-col gap-gutter p-gutter">
      <ButtonLink href="/board" size="sm" className="min-h-tap self-start">{t("task.detail.back")}</ButtonLink>
      <header className="flex items-start justify-between gap-snug">
        <h1 className="text-title font-semibold text-ink">{task.title}</h1>
        <StatusBadge status={task.status} />
      </header>
      <dl className="flex flex-col gap-tight text-caption">
        <div className="flex gap-cozy"><dt className="text-ink-muted">{t("board.agent")}</dt><dd data-testid="task-agent" className="text-ink">{task.agent}</dd></div>
        <div className="flex gap-cozy"><dt className="text-ink-muted">{t("task.origin")}</dt><dd data-testid="task-origin" className="text-ink">{t(`task.origin.${task.origin}` as StringKey)}</dd></div>
        <div className="flex gap-cozy"><dt className="text-ink-muted">{t("task.detail.created")}</dt><dd data-testid="task-created" className="text-ink">{detail.created}</dd></div>
        {task.deadline ? <div className="flex gap-cozy"><dt className="text-ink-muted">{t("board.decideBefore")}</dt><dd data-testid="task-deadline" className="text-ink">{task.deadline}</dd></div> : null}
      </dl>
      {task.error ? <p className="text-caption text-danger">{t("board.errorLabel")}: {task.error}</p> : null}
      {fields.length > 0 ? (
        <section className="flex flex-col gap-snug">
          <h2 className="text-body font-semibold text-ink-soft">{t("task.detail.draft")} · {t("task.rev")} {task.revision}</h2>
          <dl data-testid="task-draft" className="flex flex-col gap-tight text-caption">
            {fields.map(([k, v]) => (
              <div key={k} className="flex gap-cozy"><dt className="shrink-0 text-ink-muted">{k}</dt><dd className="text-ink">{String(v)}</dd></div>
            ))}
          </dl>
        </section>
      ) : null}
      <TaskHistorySummary checks={task.checks} approvals={task.approvals} />
      <section className="flex flex-col gap-snug">
        <h2 className="text-body font-semibold text-ink-soft">{t("task.detail.audit")}</h2>
        <p className="text-caption text-ink-muted">{t("task.detail.timezone")} {detail.timeZone}</p>
        <AuditTrail entries={detail.trail} />
      </section>
    </div>
  );
}
