import { NextResponse } from "next/server";
import { describeBoardError, loadTaskDetail } from "@/server/board";
import { readSessionToken } from "@/server/workspace/session-cookie";
export const dynamic = "force-dynamic";
/** Thin handler: one task with its audit trail. The tenant comes from the session; another tenant's task is a 404. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    return NextResponse.json(await loadTaskDetail(await readSessionToken(), (await ctx.params).id));
  } catch (e) {
    const d = describeBoardError(e);
    if (!d) throw e;
    return NextResponse.json({ error: d.code }, { status: d.status });
  }
}
