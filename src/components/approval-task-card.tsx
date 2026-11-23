"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { BoardTask } from "@/server/board/service";
import { Button } from "./button";
import { useT } from "./i18n-provider";
import { TaskCard } from "./task-card";

/**
 * The Pending Approval variant of `TaskCard`: Approve, Reject and Edit draft, sized for a phone.
 * Every action is a server operation (the approval gate decides); this component only sends the
 * revision the owner saw and shows the outcome. `onResult` reports the stable error code (or null).
 */
export function ApprovalTaskCard({ task, onResult }: { task: BoardTask; onResult: (taskId: string, errorCode: string | null) => void }) {
  const { t } = useT();
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const fields = task.draft?.fields ?? {};
  const disabled = busy || refreshing;

  async function send(action: "approve" | "reject" | "revise", body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch(`/api/workspace/tasks/${task.id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const code = res.ok ? null : (((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "generic");
      onResult(task.id, code);
      setEditing(false);
      startRefresh(() => router.refresh()); // also on failure: the task may have moved (expired, decided elsewhere)
    } catch {
      onResult(task.id, "generic");
    } finally {
      setBusy(false);
    }
  }

  function startEdit() {
    setDraft(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)])));
    setEditing(true);
  }

  function save() {
    const changed: Record<string, string | number | boolean> = {};
    for (const [k, original] of Object.entries(fields)) {
      const raw = draft[k] ?? String(original);
      if (raw === String(original)) continue;
      changed[k] = typeof original === "number" ? Number(raw) : typeof original === "boolean" ? raw === "true" : raw;
    }
    if (Object.keys(changed).length === 0) return setEditing(false);
    void send("revise", { fields: changed });
  }

  return (
    <TaskCard
      task={task}
      actions={
        editing ? (
          <form
            className="flex flex-col gap-snug"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            {Object.keys(fields).map((k) => (
              <label key={k} className="flex flex-col gap-tight text-caption text-ink-muted">
                {k}
                <input
                  name={k}
                  value={draft[k] ?? ""}
                  onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                  className="min-h-tap rounded-control border border-border-strong bg-surface p-snug text-body text-ink"
                />
              </label>
            ))}
            <div className="flex gap-snug">
              <Button type="submit" disabled={disabled} className="min-h-tap flex-1">{t("board.save")}</Button>
              <Button variant="outline" disabled={disabled} onClick={() => setEditing(false)} className="min-h-tap flex-1">{t("board.cancel")}</Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-snug">
            <div className="flex gap-snug">
              <Button disabled={disabled} onClick={() => send("approve", { revision: task.revision })} className="min-h-tap flex-1">{t("board.approve")}</Button>
              <Button variant="outline" disabled={disabled} onClick={() => send("reject", {})} className="min-h-tap flex-1">{t("board.reject")}</Button>
            </div>
            {Object.keys(fields).length > 0 ? (
              <Button variant="outline" size="sm" disabled={disabled} onClick={startEdit} className="min-h-tap">{t("board.edit")}</Button>
            ) : null}
          </div>
        )
      }
    />
  );
}
