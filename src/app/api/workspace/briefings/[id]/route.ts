import { NextResponse } from "next/server";
import { loadBriefingDetail } from "@/server/briefings";
import { describeOwnerError } from "@/server/workspace/owner-errors";
import { readSessionToken } from "@/server/workspace/session-cookie";
export const dynamic = "force-dynamic";
/** Thin handler: one stored briefing of the session's tenant, rendered. Another tenant's id is a 404. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return NextResponse.json(await loadBriefingDetail(await readSessionToken(), (await params).id));
  } catch (e) {
    const d = describeOwnerError(e);
    if (!d) throw e;
    return NextResponse.json({ error: d.code }, { status: d.status });
  }
}
