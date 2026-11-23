import { NextResponse } from "next/server";
import { describeBoardError, reviseFromBoard } from "@/server/board";
import { readSessionToken } from "@/server/workspace/session-cookie";
import "@/server/approvals/e2e-handlers";

export const dynamic = "force-dynamic";

/** Thin handler: change draft fields of a Pending Approval task (reviseDraft), then re-check it in the same request. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const body = (await req.json().catch(() => null)) as { fields?: unknown } | null;
  try {
    return NextResponse.json(await reviseFromBoard(await readSessionToken(), (await ctx.params).id, body?.fields));
  } catch (e) {
    const d = describeBoardError(e);
    if (!d) throw e;
    return NextResponse.json({ error: d.code }, { status: d.status });
  }
}
