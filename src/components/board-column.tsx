"use client";
import type { ReactNode } from "react";
import type { TaskStatus } from "@/server/tasks/state-machine";
import { useT } from "./i18n-provider";
import { statusLabelKey } from "./status-badge";

/**
 * One pipeline column. From md up every column shows side by side; on phones only the selected
 * status shows (the stacked view), switched with the filter chips.
 */
export function BoardColumn(props: { status: TaskStatus; count: number; selected: boolean; children: ReactNode }) {
  const { t } = useT();
  const empty = props.count === 0;
  return (
    <section
      data-testid={`column-${props.status}`}
      data-selected={props.selected}
      aria-labelledby={`column-title-${props.status}`}
      className={`${props.selected ? "flex" : "hidden md:flex"} min-w-0 flex-col gap-snug rounded-control bg-surface-muted p-snug`}
    >
      <h2 id={`column-title-${props.status}`} className="text-body font-semibold text-ink-soft">
        {t(statusLabelKey(props.status))} <span className="text-ink-muted">{props.count}</span>
      </h2>
      {empty ? <p className="text-caption text-ink-muted">{t("board.empty")}</p> : props.children}
    </section>
  );
}
