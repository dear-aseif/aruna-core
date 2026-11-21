import type { TaskStatus } from "../tasks";
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
const GENERIC_SUBJECTS = new Set(["everyone", "everybody", "everything", "all", "agents", "agent", "you", "they", "we", "it", "that", "this", "each", "everyone's"]);

const STATUS_WORDS: [RegExp, TaskStatus][] = [
  [/\bpending approval\b|\bawaiting approval\b|\bwaiting for (?:my )?approval\b|\bneed(?:s|ing)? (?:my )?approval\b/, "pending_approval"],
  [/\bin review\b|\bunder review\b/, "in_review"],
  [/\bqueued\b/, "queued"],
  [/\bworking\b|\bin progress\b/, "working"],
  [/\bdone\b|\bcompleted\b|\bfinished\b/, "done"],
  [/\brejected\b/, "rejected"],
  [/\bexpired\b/, "expired"],
  [/\bfailed\b|\bfailures?\b/, "failed"],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Map a question to one of the question types the Maestro can answer, or `unsupported`. */
export function classifyQuestion(question: string, agents: readonly KnownAgent[]): Intent {
  const q = question.toLowerCase().replace(/\s+/g, " ").trim();
  const id = UUID_IN_TEXT.exec(q);
  if (id) return { kind: "task_status", taskId: id[0] };

  const statusWord = STATUS_WORDS.find(([re]) => re.test(q))?.[1] ?? null;
  const counting = /\bhow many\b|\bcount\b|\bnumber of\b/.test(q);
  if (counting && (statusWord || /\btasks?\b/.test(q))) return { kind: "status_counts", status: statusWord };
  if (/\bapprov/.test(q) && /\b(?:waiting|awaiting|pending|needs?|needing|to approve|for approval)\b/.test(q)) return { kind: "pending_approvals" };

  const named = agents.find((a) => new RegExp(`\\b${escapeRe(a.id.replace(/_/g, " "))}\\b|\\b${escapeRe(a.id)}\\b|\\b${escapeRe(a.label.toLowerCase())}\\b`).test(q));
  const asksActivity = /\bdoing\b|\bworking on\b|\bbusy\b|\bstatus\b|\bprogress\b|\bgoing on\b|\bcurrent(?:ly)?\b|\bopen tasks?\b|\bon the board\b|\bup to\b/.test(q);
  if (asksActivity) {
    if (named) return { kind: "agent_activity", agent: named.id };
    const subject = /\bwhat(?:'s| is| are)\s+(?:the\s+)?([a-z_]+)(?:\s+agent)?\s+(?:currently\s+)?(?:doing|working on)\b/.exec(q)?.[1];
    if (subject && !GENERIC_SUBJECTS.has(subject)) return { kind: "unknown_agent", name: subject };
    return { kind: "agent_activity", agent: null };
  }
  if (/\brecent\b|\blatest\b|\bhappened\b|\bhistory\b|\bactivity\b|\baudit\b/.test(q)) return { kind: "recent_activity" };
  return { kind: "unsupported" };
}

const iso = (d: Date) => d.toISOString();

function activityText(m: ActivityMark | null): string {
  return m ? `last activity: ${m.type} by ${m.actor} (${m.actorId}) at ${iso(m.at)}` : "no activity recorded";
}

function taskLine(t: OpenTaskFact): string {
  const expiry = t.status === "pending_approval" && t.approvalExpiresAt ? `; approval expires at ${iso(t.approvalExpiresAt)}` : "";
  return `- "${t.title}": ${STATUS_LABELS[t.status]} (${activityText(t.lastActivity)}${expiry})`;
}

export function renderAgentActivity(facts: AgentActivityFacts): string {
  const blocks = facts.agents.map((a) => {
    const head =
      a.openTotal === 0
        ? `${a.agent.label}: no open tasks.`
        : `${a.agent.label}: ${a.openTotal} open task${a.openTotal === 1 ? "" : "s"}${facts.truncated ? " (at least; only the newest were read)" : ""}.`;
    const more = a.openTotal > a.shown.length ? [`- and ${a.openTotal - a.shown.length} more`] : [];
    return [head, ...a.shown.map(taskLine), ...more].join("\n");
  });
  return blocks.join("\n");
}

export function renderPendingApprovals(f: PendingApprovalFacts): string {
  if (f.total === 0) return "Nothing is waiting for your approval.";
  const more = f.total > f.shown.length ? [`- and ${f.total - f.shown.length} more`] : [];
  return [`${f.total} task${f.total === 1 ? " is" : "s are"} waiting for your approval${f.total >= 200 ? " (at least)" : ""}:`, ...f.shown.map(taskLine), ...more].join("\n");
}

export function renderStatusCounts(counts: Record<TaskStatus, number>, status: TaskStatus | null): string {
  if (status) return `${counts[status]} task${counts[status] === 1 ? " is" : "s are"} ${STATUS_LABELS[status]}.`;
  const order: TaskStatus[] = ["queued", "working", "in_review", "pending_approval", "done", "rejected", "expired", "failed"];
  return `Tasks by status: ${order.map((s) => `${STATUS_LABELS[s]} ${counts[s]}`).join(", ")}.`;
}

export function renderRecentActivity(items: readonly RecentActivityFact[]): string {
  if (items.length === 0) return "No activity has been recorded yet.";
  return [
    `The latest ${items.length} recorded event${items.length === 1 ? "" : "s"}, newest first:`,
    ...items.map((i) => `- ${iso(i.at)}: ${i.type} by ${i.actor} (${i.actorId})${i.taskTitle ? ` on "${i.taskTitle}"` : ""}`),
  ].join("\n");
}

export const NOT_FOUND_TASK = "I could not find that task in your workspace.";

export function renderUnknownAgent(name: string, agents: readonly KnownAgent[]): string {
  return `I have no agent called "${name}" in your workspace. The agents I can report on are: ${agents.map((a) => a.label).join(", ")}.`;
}

/** The bounded reply for a question the Maestro cannot answer from its query functions. Nothing is guessed. */
export function renderUnsupported(agents: readonly KnownAgent[]): string {
  return [
    "I can't answer that from your workspace data, so I won't guess.",
    "I can tell you: what each agent is doing right now (" + agents.map((a) => a.label).join(", ") + "),",
    "which tasks are waiting for your approval, how many tasks are in each status, what happened recently, and the status of one task if you give me its id.",
  ].join(" ");
}
