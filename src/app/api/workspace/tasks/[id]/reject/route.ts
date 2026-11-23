import { NextResponse } from "next/server";
import { describeBoardError, rejectFromBoard } from "@/server/board";
import { readSessionToken } from "@/server/workspace/session-cookie";
import "@/server/approvals/e2e-handlers";

export const dynamic = "force-dynamic";

/** Thin handler: reject a Pending Approval task through the approval gate. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const body = (await req.json().catch(() => null)) as { reason?: unknown } | null;
  try {
    return NextResponse.json(await rejectFromBoard(await readSessionToken(), (await ctx.params).id, body?.reason));
  } catch (e) {
    const d = describeBoardError(e);
    if (!d) throw e;
    return NextResponse.json({ error: d.code }, { status: d.status });
  }
}
