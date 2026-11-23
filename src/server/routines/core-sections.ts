import { registerBriefingSection } from "./registry";

/**
 * Core briefing sections (design §2.11): yesterday's task outcomes and the tasks still Pending
 * Approval. Facts only, straight from task records; the briefing text and storage are task 10.2.
 */
interface OutcomeRow {
  id: string;
  title: string;
  status: string;
}
interface PendingRow {
  id: string;
  title: string;
  approval_expires_at: string | null;
}

export const CORE_SECTION_IDS = { yesterdayOutcomes: "core.yesterday_outcomes", pendingApprovals: "core.pending_approvals" } as const;

registerBriefingSection({
  id: CORE_SECTION_IDS.yesterdayOutcomes,
  pack: null,
  order: 10,
  async collect(tx, ctx) {
    // "Yesterday" is the tenant's local calendar day: [00:00, next 00:00) in its timezone.
    const tasks = await tx.query<OutcomeRow>(
      `select id, title, status from tasks
        where status in ('done', 'rejected', 'expired')
          and updated_at >= ($1::date)::timestamp at time zone $2
          and updated_at <  (($1::date) + 1)::timestamp at time zone $2
        order by updated_at, id`,
      [ctx.previousDate, ctx.timezone],
    );
    const count = (s: string) => tasks.filter((t) => t.status === s).length;
    return { date: ctx.previousDate, done: count("done"), rejected: count("rejected"), expired: count("expired"), tasks };
  },
});

registerBriefingSection({
  id: CORE_SECTION_IDS.pendingApprovals,
  pack: null,
  order: 20,
  async collect(tx) {
    // Always listed explicitly. The engine applies approval expiry before collecting, so no lapsed approval appears here.
    const tasks = await tx.query<PendingRow>(
      "select id, title, approval_expires_at from tasks where status = 'pending_approval' order by approval_expires_at nulls last, id",
    );
    return { count: tasks.length, tasks };
  },
});
