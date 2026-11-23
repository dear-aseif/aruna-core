import { NextResponse } from "next/server";
import { loadBriefings } from "@/server/briefings";
import { describeOwnerError } from "@/server/workspace/owner-errors";
import { readSessionToken } from "@/server/workspace/session-cookie";
export const dynamic = "force-dynamic";
/** Thin handler: today's briefing and the archive for the session's tenant. */
export async function GET() {
  try {
    return NextResponse.json(await loadBriefings(await readSessionToken()));
  } catch (e) {
    const d = describeOwnerError(e);
    if (!d) throw e;
    return NextResponse.json({ error: d.code }, { status: d.status });
  }
}
