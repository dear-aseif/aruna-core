import { NextResponse } from "next/server";
import { approveFromBoard, describeBoardError } from "@/server/board";
import { readSessionToken } from "@/server/workspace/session-cookie";
import "@/server/approvals/e2e-handlers";

export const dynamic = "force-dynamic";

/** Thin handler: approve the revision the owner saw. The approval gate decides; the tenant comes from the session. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const body = (await req.json().catch(() => null)) as { revision?: unknown } | null;
  try {
    return NextResponse.json(await approveFromBoard(await readSessionToken(), (await ctx.params).id, body?.revision));
  } catch (e) {
    const d = describeBoardError(e);
    if (!d) throw e;
    return NextResponse.json({ error: d.code }, { status: d.status });
  }
}
