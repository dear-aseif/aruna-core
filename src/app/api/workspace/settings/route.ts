import { NextResponse } from "next/server";
import { loadSettings } from "@/server/settings/owner";
import { describeOwnerError } from "@/server/workspace/owner-errors";
import { readSessionToken } from "@/server/workspace/session-cookie";
export const dynamic = "force-dynamic";
/** Thin handler: the read-only settings model for the session's tenant. */
export async function GET() {
  try {
    return NextResponse.json(await loadSettings(await readSessionToken()));
  } catch (e) {
    const d = describeOwnerError(e);
    if (!d) throw e;
    return NextResponse.json({ error: d.code }, { status: d.status });
  }
}
