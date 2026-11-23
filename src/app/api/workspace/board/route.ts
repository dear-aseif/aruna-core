import { NextResponse } from "next/server";
import { describeBoardError, loadBoard } from "@/server/board";
import { readSessionToken } from "@/server/workspace/session-cookie";

export const dynamic = "force-dynamic";

/** Thin handler: the tenant is resolved from the session cookie, never from the request. */
export async function GET() {
  try {
    return NextResponse.json(await loadBoard(await readSessionToken()));
  } catch (e) {
    const d = describeBoardError(e);
    if (!d) throw e;
    return NextResponse.json({ error: d.code }, { status: d.status });
  }
}
