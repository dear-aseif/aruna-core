"use client";
import type { TaskStatus } from "@/server/tasks/state-machine";
import { useT } from "./i18n-provider";
import { statusLabelKey } from "./status-badge";

/** Phone-only status filter: one chip per status with its task count. Hidden from md up, where all columns show. */
export function StatusFilterChips(props: {
  statuses: readonly TaskStatus[];
  counts: Record<TaskStatus, number>;
  selected: TaskStatus;
  onSelect: (status: TaskStatus) => void;
}) {
  const { t } = useT();
  return (
    <div role="group" aria-label={t("board.filterLabel")} data-testid="status-chips" className="-mx-gutter flex gap-snug overflow-x-auto px-gutter pb-snug md:hidden">
      {props.statuses.map((s) => {
        const on = s === props.selected;
        return (
          <button
            key={s}
            type="button"
            data-status={s}
            aria-pressed={on}
            onClick={() => props.onSelect(s)}
            className={`min-h-tap shrink-0 whitespace-nowrap rounded-control px-cozy text-body ${on ? "bg-primary text-primary-ink" : "border border-border-strong bg-surface text-ink-soft"}`}
          >
            {t(statusLabelKey(s))} <span data-testid="chip-count">{props.counts[s]}</span>
          </button>
        );
      })}
    </div>
  );
}
