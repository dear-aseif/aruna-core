"use client";
import { useState } from "react";
import type { StringKey } from "@/i18n/strings";
import type { BoardModel } from "@/server/board/service";
import type { TaskStatus } from "@/server/tasks/state-machine";
import { ApprovalTaskCard } from "./approval-task-card";
import { BoardColumn } from "./board-column";
import { ButtonLink } from "./button-link";
import { useT } from "./i18n-provider";
import { StatusFilterChips } from "./status-filter-chips";
import { TaskCard } from "./task-card";

const ERROR_KEY: Record<string, StringKey> = {
  expired: "board.err.expired",
  not_awaiting: "board.err.notAwaiting",
  revision_changed: "board.err.revisionChanged",
  cannot_approve: "board.err.cannotApprove",
};

/** Where the phone view starts: the status that needs the owner. */
export const DEFAULT_STATUS: TaskStatus = "pending_approval";

/**
 * The task board (design §2.12). Wide viewports show every status as a column; phone viewports
 * show one status at a time with filter chips. Cards come from the server model as sent.
 */
export function TaskBoard({ model }: { model: BoardModel }) {
  const { t, nav } = useT();
  const [selected, setSelected] = useState(DEFAULT_STATUS);
  const [errorCode, setErrorCode] = useState(null as string | null);
  return (
    <section className="flex flex-col gap-cozy">
      <div className="flex flex-wrap items-center justify-between gap-snug">
        <h1 className="text-title font-semibold">{nav({ id: "board", label: "board" })}</h1>
        <nav aria-label={t("board.quickActions")} className="flex gap-snug">
          <ButtonLink href="/chat" size="sm">{t("board.openChat")}</ButtonLink>
          <ButtonLink href="/briefings" size="sm">{t("board.openBriefing")}</ButtonLink>
        </nav>
      </div>
      {errorCode ? (
        <p role="alert" data-testid="board-notice" className="rounded-control border border-danger p-cozy text-body text-danger">
          {t(ERROR_KEY[errorCode] ?? "board.err.generic")}
        </p>
      ) : null}
      <StatusFilterChips statuses={model.statuses} counts={model.counts} selected={selected} onSelect={setSelected} />
      <div aria-label={t("board.pipelineLabel")} role="region" data-testid="board-columns" className="grid gap-cozy md:grid-cols-4 xl:grid-cols-8">
        {model.statuses.map((s) => (
          <BoardColumn key={s} status={s} count={model.columns[s].length} selected={s === selected}>
            {model.columns[s].map((task) =>
              task.status === "pending_approval" ? (
                <ApprovalTaskCard key={task.id} task={task} onResult={(_, code) => setErrorCode(code)} />
              ) : (
                <TaskCard key={task.id} task={task} />
              ),
            )}
          </BoardColumn>
        ))}
      </div>
    </section>
  );
}
