import { NextResponse } from "next/server";
import { requestOwnExport } from "@/server/exports";
import { describeOwnerError } from "@/server/workspace/owner-errors";
import { readSessionToken } from "@/server/workspace/session-cookie";
export const dynamic = "force-dynamic";
/** Thin handler: no body is read. The tenant to export is always the session's own. */
export async function POST() {
  try {
    return NextResponse.json(await requestOwnExport(await readSessionToken()));
  } catch (e) {
    const d = describeOwnerError(e);
    if (!d) throw e;
    return NextResponse.json({ error: d.code }, { status: d.status });
  }
}
