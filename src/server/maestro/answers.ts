import type { TaskStatus } from "../tasks";
import { translate, type Language } from "../../i18n/strings";
import type {
  ActivityMark,
  AgentActivityFacts,
  KnownAgent,
  OpenTaskFact,
  PendingApprovalFacts,
  RecentActivityFact,
} from "./queries";

/**
 * Question recognition and answer rendering for the Maestro (task 8.3, design amendment #11).
 *
 * Recognition is deterministic keyword matching: no model decides what a question means or what
 * the facts are. Rendering is a template over typed query results: every count, status, title,
 * name and time in an answer is copied from a query result. No model is called in this module.
 */
export const STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "Queued",
  working: "Working",
  in_review: "In Review",
  pending_approval: "Pending Approval",
  done: "Done",
  rejected: "Rejected",
  expired: "Expired",
  failed: "Failed",
};

export type Intent =
  | { kind: "task_status"; taskId: string }
  | { kind: "pending_approvals" }
  | { kind: "status_counts"; status: TaskStatus | null }
  | { kind: "agent_activity"; agent: string | null }
  | { kind: "unknown_agent"; name: string }
  | { kind: "recent_activity" }
  | { kind: "unsupported" };

const UUID_IN_TEXT = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const GENERIC_SUBJECTS = new Set([
  "everyone", "everybody", "everything", "all", "agents", "agent", "you", "they", "we", "it", "that", "this", "each", "everyone's",
  // Indonesian
  "semua", "semuanya", "mereka", "kamu", "anda", "kalian", "saat", "ini", "itu", "sekarang", "agen", "hari",
]);

const STATUS_WORDS: [RegExp, TaskStatus][] = [
  [/\bpending approval\b|\bawaiting approval\b|\bwaiting for (?:my )?approval\b|\bneed(?:s|ing)? (?:my )?approval\b|\bmenunggu persetujuan\b|\b(?:butuh|perlu|minta) persetujuan\b|\bbelum (?:saya )?disetujui\b/, "pending_approval"],
  [/\bin review\b|\bunder review\b|\bditinjau\b/, "in_review"],
  [/\bqueued\b|\bantre(?:an)?\b/, "queued"],
  [/\bworking\b|\bin progress\b|\bdikerjakan\b|\bsedang berjalan\b/, "working"],
  [/\bdone\b|\bcompleted\b|\bfinished\b|\bselesai\b/, "done"],
  [/\brejected\b|\bditolak\b/, "rejected"],
  [/\bexpired\b|\bk[ae]d(?:a)?luwarsa\b|\bkadaluarsa\b/, "expired"],
  [/\bfailed\b|\bfailures?\b|\bgagal\b/, "failed"],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Map a question to one of the question types the Maestro can answer, or `unsupported`. */
export function classifyQuestion(question: string, agents: readonly KnownAgent[]): Intent {
  const q = question.toLowerCase().replace(/\s+/g, " ").trim();
  const id = UUID_IN_TEXT.exec(q);
  if (id) return { kind: "task_status", taskId: id[0] };

  const statusWord = STATUS_WORDS.find(([re]) => re.test(q))?.[1] ?? null;
  const counting = /\bhow many\b|\bcount\b|\bnumber of\b|\bberapa\b|\bjumlah\b|\bhitung\b/.test(q);
  if (counting && (statusWord || /\b(?:tasks?|tugas)\b/.test(q))) return { kind: "status_counts", status: statusWord };
  if (/\bapprov|\bpersetuju|\bdisetujui\b/.test(q) && /\b(?:waiting|awaiting|pending|needs?|needing|to approve|for approval|menunggu|tunggu|butuh|perlu|belum)\b/.test(q)) return { kind: "pending_approvals" };

  const named = agents.find((a) => new RegExp(`\\b${escapeRe(a.id.replace(/_/g, " "))}\\b|\\b${escapeRe(a.id)}\\b|\\b${escapeRe(a.label.toLowerCase())}\\b`).test(q));
  const asksActivity = /\bdoing\b|\bworking on\b|\bbusy\b|\bstatus\b|\bprogress\b|\bgoing on\b|\bcurrent(?:ly)?\b|\bopen tasks?\b|\bon the board\b|\bwhat(?:'s| is| are)\b[^?]*\bup to\b|\bsedang (?:apa|mengerjakan|dikerjakan|dilakukan|berjalan)\b|\blagi (?:apa|ngapain|ngerjain)\b|\bsibuk\b|\bprogres\b|\bkemajuan\b|\bapa yang (?:sedang )?(?:dikerjakan|dilakukan)\b|\btugas (?:yang )?(?:terbuka|aktif|berjalan)\b|\bdi papan\b/.test(q);
  if (asksActivity) {
    if (named) return { kind: "agent_activity", agent: named.id };
    const subject = /\bwhat(?:'s| is| are)\s+(?:the\s+)?([a-z_]+)(?:\s+agent)?\s+(?:currently\s+)?(?:doing|working on)\b/.exec(q)?.[1];
    const subjectId = /\bapa yang sedang (?:dikerjakan|dilakukan) (?:oleh )?(?:agen )?([a-z_]+)/.exec(q)?.[1];
    const who = subject ?? subjectId;
    if (who && !GENERIC_SUBJECTS.has(who)) return { kind: "unknown_agent", name: who };
    return { kind: "agent_activity", agent: null };
  }
  if (/\brecent\b|\blatest\b|\bhappened\b|\bhistory\b|\bactivity\b|\baudit\b|\bterbaru\b|\bterakhir\b|\bbaru saja\b|\briwayat\b|\baktivitas\b|\bkejadian\b|\bterjadi\b/.test(q)) return { kind: "recent_activity" };
  return { kind: "unsupported" };
}

const statusLabel = (s: TaskStatus, lang: Language): string => (lang === "id" ? translate("id", `status.${s}`) : STATUS_LABELS[s]);
const T = <V>(lang: Language, en: V, id: V): V => (lang === "id" ? id : en);

/** Localized status label for answers (English labels match STATUS_LABELS). */
export { statusLabel as maestroStatusLabel };

const iso = (d: Date) => d.toISOString();

function activityText(m: ActivityMark | null, lang: Language): string {
  return m
    ? T(lang, `last activity: ${m.type} by ${m.actor} (${m.actorId}) at ${iso(m.at)}`, `aktivitas terakhir: ${m.type} oleh ${m.actor} (${m.actorId}) pada ${iso(m.at)}`)
    : T(lang, "no activity recorded", "belum ada aktivitas tercatat");
}

function taskLine(t: OpenTaskFact, lang: Language): string {
  const expiry =
    t.status === "pending_approval" && t.approvalExpiresAt
      ? T(lang, `; approval expires at ${iso(t.approvalExpiresAt)}`, `; persetujuan kedaluwarsa pada ${iso(t.approvalExpiresAt)}`)
      : "";
  return `- "${t.title}": ${statusLabel(t.status, lang)} (${activityText(t.lastActivity, lang)}${expiry})`;
}

/** The one-task status line for a task id question. */
export function renderTaskStatus(
  t: { title: string; agent: string; status: TaskStatus; approvalExpiresAt: Date | null },
  last: { type: string; actor: string; actorId: string; at: Date } | null,
  lang: Language = "en",
): string {
  const expiry = t.status === "pending_approval" && t.approvalExpiresAt ? T(lang, `; approval expires at ${iso(t.approvalExpiresAt)}`, `; persetujuan kedaluwarsa pada ${iso(t.approvalExpiresAt)}`) : "";
  const lastText = last
    ? T(lang, `; last activity: ${last.type} by ${last.actor} (${last.actorId}) at ${iso(last.at)}`, `; aktivitas terakhir: ${last.type} oleh ${last.actor} (${last.actorId}) pada ${iso(last.at)}`)
    : "";
  return `"${t.title}" (${t.agent}): ${statusLabel(t.status, lang)}${expiry}${lastText}.`;
}

export function renderAgentActivity(facts: AgentActivityFacts, lang: Language = "en"): string {
  const blocks = facts.agents.map((a) => {
    const head =
      a.openTotal === 0
        ? T(lang, `${a.agent.label}: no open tasks.`, `${a.agent.label}: tidak ada tugas terbuka.`)
        : T(
            lang,
            `${a.agent.label}: ${a.openTotal} open task${a.openTotal === 1 ? "" : "s"}${facts.truncated ? " (at least; only the newest were read)" : ""}.`,
            `${a.agent.label}: ${a.openTotal} tugas terbuka${facts.truncated ? " (setidaknya; hanya yang terbaru dibaca)" : ""}.`,
          );
    const more = a.openTotal > a.shown.length ? [T(lang, `- and ${a.openTotal - a.shown.length} more`, `- dan ${a.openTotal - a.shown.length} lainnya`)] : [];
    return [head, ...a.shown.map((t) => taskLine(t, lang)), ...more].join("\n");
  });
  return blocks.join("\n");
}

export function renderPendingApprovals(f: PendingApprovalFacts, lang: Language = "en"): string {
  if (f.total === 0) return T(lang, "Nothing is waiting for your approval.", "Tidak ada yang menunggu persetujuan Anda.");
  const more = f.total > f.shown.length ? [T(lang, `- and ${f.total - f.shown.length} more`, `- dan ${f.total - f.shown.length} lainnya`)] : [];
  const atLeast = f.total >= 200;
  const head = T(
    lang,
    `${f.total} task${f.total === 1 ? " is" : "s are"} waiting for your approval${atLeast ? " (at least)" : ""}:`,
    `${f.total} tugas menunggu persetujuan Anda${atLeast ? " (setidaknya)" : ""}:`,
  );
  return [head, ...f.shown.map((t) => taskLine(t, lang)), ...more].join("\n");
}

export function renderStatusCounts(counts: Record<TaskStatus, number>, status: TaskStatus | null, lang: Language = "en"): string {
  if (status) {
    return T(
      lang,
      `${counts[status]} task${counts[status] === 1 ? " is" : "s are"} ${statusLabel(status, lang)}.`,
      `${counts[status]} tugas berstatus ${statusLabel(status, lang)}.`,
    );
  }
  const order: TaskStatus[] = ["queued", "working", "in_review", "pending_approval", "done", "rejected", "expired", "failed"];
  const list = order.map((s) => `${statusLabel(s, lang)} ${counts[s]}`).join(", ");
  return T(lang, `Tasks by status: ${list}.`, `Tugas menurut status: ${list}.`);
}

export function renderRecentActivity(items: readonly RecentActivityFact[], lang: Language = "en"): string {
  if (items.length === 0) return T(lang, "No activity has been recorded yet.", "Belum ada aktivitas yang tercatat.");
  return [
    T(lang, `The latest ${items.length} recorded event${items.length === 1 ? "" : "s"}, newest first:`, `${items.length} kejadian tercatat terbaru, dari yang paling baru:`),
    ...items.map((i) => `- ${iso(i.at)}: ${i.type} ${T(lang, "by", "oleh")} ${i.actor} (${i.actorId})${i.taskTitle ? ` ${T(lang, "on", "pada")} "${i.taskTitle}"` : ""}`),
  ].join("\n");
}

export const NOT_FOUND_TASK = "I could not find that task in your workspace.";
export const NOT_FOUND_TASK_ID = "Saya tidak dapat menemukan tugas itu di ruang kerja Anda.";
export const notFoundTask = (lang: Language = "en"): string => T(lang, NOT_FOUND_TASK, NOT_FOUND_TASK_ID);

export function renderUnknownAgent(name: string, agents: readonly KnownAgent[], lang: Language = "en"): string {
  const labels = agents.map((a) => a.label).join(", ");
  return T(
    lang,
    `I have no agent called "${name}" in your workspace. The agents I can report on are: ${labels}.`,
    `Saya tidak punya agen bernama "${name}" di ruang kerja Anda. Agen yang dapat saya laporkan: ${labels}.`,
  );
}

/** The bounded reply for a question the Maestro cannot answer from its query functions. Nothing is guessed. */
export function renderUnsupported(agents: readonly KnownAgent[], lang: Language = "en"): string {
  const labels = agents.map((a) => a.label).join(", ");
  if (lang === "id") {
    return [
      "Saya tidak dapat menjawab itu dari data ruang kerja Anda, jadi saya tidak akan menebak.",
      `Saya dapat memberi tahu: apa yang sedang dikerjakan tiap agen (${labels}),`,
      "tugas mana yang menunggu persetujuan Anda, berapa banyak tugas di tiap status, apa yang terjadi baru-baru ini, dan status satu tugas jika Anda memberi saya id-nya.",
    ].join(" ");
  }
  return [
    "I can't answer that from your workspace data, so I won't guess.",
    "I can tell you: what each agent is doing right now (" + labels + "),",
    "which tasks are waiting for your approval, how many tasks are in each status, what happened recently, and the status of one task if you give me its id.",
  ].join(" ");
}
