import { NextResponse } from "next/server";
import { loadChat } from "@/server/chat";
import { describeOwnerError } from "@/server/workspace/owner-errors";
import { readSessionToken } from "@/server/workspace/session-cookie";
export const dynamic = "force-dynamic";
/** Thin handler: the chat read model for the session's tenant; `?thread=` selects a thread. */
export async function GET(req: Request) {
  try {
    return NextResponse.json(await loadChat(await readSessionToken(), new URL(req.url).searchParams.get("thread")));
  } catch (e) {
    const d = describeOwnerError(e);
    if (!d) throw e;
    return NextResponse.json({ error: d.code }, { status: d.status });
  }
}
