"use client";
import { STRINGS, type StringKey } from "@/i18n/strings";
import type { ApprovalItem, CheckItem } from "@/server/board/history";
import { useT } from "./i18n-provider";
/**
 * The check and approval history of one task, oldest first, as the card and the detail show it.
 * Times arrive already formatted in the business timezone. Renders what the server sent.
 */
export function TaskHistorySummary({ checks, approvals }: { checks: CheckItem[]; approvals: ApprovalItem[] }) {
  const { t, lang } = useT();
  const stage = (s: string | null) => (s && `task.stage.${s}` in STRINGS[lang] ? t(`task.stage.${s}` as StringKey) : s);
  const decision = (a: ApprovalItem) => t(a.blocked ? "task.decision.blocked" : a.decision === "approve" ? "task.decision.approve" : "task.decision.reject");
  return (
    <div data-testid="task-history" className="flex flex-col gap-snug text-caption">
      <section aria-label={t("task.checks")} data-testid="task-checks" className="flex flex-col gap-tight">
        <h4 className="font-semibold text-ink-soft">{t("task.checks")}</h4>
        {checks.length === 0 ? <p className="text-ink-muted">{t("task.history.none")}</p> : null}
        {checks.map((c) => (
          <div key={c.id} data-testid="task-check" data-outcome={c.outcome} className="flex flex-col text-ink">
            <p>
              <span className={c.outcome === "pass" ? "font-semibold" : "font-semibold text-danger"}>{t(c.outcome === "pass" ? "task.check.pass" : "task.check.fail")}</span>
              {stage(c.stage) ? ` · ${stage(c.stage)}` : ""}
              {c.revision !== null ? ` · ${t("task.rev")} ${c.revision}` : ""}
            </p>
            <time dateTime={c.atIso} className="text-ink-muted">{c.at}</time>
            {c.anomalies.map((a, i) => (
              <p key={i} className="text-danger">{a}</p>
            ))}
          </div>
        ))}
      </section>
      <section aria-label={t("task.approvals")} data-testid="task-approvals" className="flex flex-col gap-tight">
        <h4 className="font-semibold text-ink-soft">{t("task.approvals")}</h4>
        {approvals.length === 0 ? <p className="text-ink-muted">{t("task.history.none")}</p> : null}
        {approvals.map((a) => (
          <div key={a.id} data-testid="task-approval" data-decision={a.decision} className="flex flex-col text-ink">
            <p>
              <span className="font-semibold">{decision(a)}</span>
              {a.revision !== null ? ` · ${t("task.rev")} ${a.revision}` : ""} · {t("task.decidedBy")} {a.decidedBy}
            </p>
            <time dateTime={a.atIso} className="text-ink-muted">{a.at}</time>
            {a.reason ? <p className="text-ink-muted">{a.reason}</p> : null}
          </div>
        ))}
      </section>
    </div>
  );
}
