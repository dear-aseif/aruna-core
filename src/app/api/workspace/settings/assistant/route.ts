import { NextResponse } from "next/server";
import { renameAssistantForOwner } from "@/server/settings/owner";
import { describeOwnerError } from "@/server/workspace/owner-errors";
import { readSessionToken } from "@/server/workspace/session-cookie";
export const dynamic = "force-dynamic";
/** Thin handler: rename the assistant of the session's tenant. Only the name comes from the body. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
  try {
    return NextResponse.json({ name: await renameAssistantForOwner(await readSessionToken(), body?.name) });
  } catch (e) {
    const d = describeOwnerError(e);
    if (!d) throw e;
    return NextResponse.json({ error: d.code }, { status: d.status });
  }
}
