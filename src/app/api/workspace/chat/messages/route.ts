import { NextResponse } from "next/server";
import { sendChatMessage } from "@/server/chat";
import { describeOwnerError } from "@/server/workspace/owner-errors";
import { readSessionToken } from "@/server/workspace/session-cookie";
export const dynamic = "force-dynamic";
/** Thin handler: the chat service routes the message (question to the Maestro, anything else to a command). */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { threadId?: unknown; body?: unknown } | null;
  try {
    return NextResponse.json(await sendChatMessage(await readSessionToken(), { threadId: body?.threadId, body: body?.body }));
  } catch (e) {
    const d = describeOwnerError(e);
    if (!d) throw e;
    return NextResponse.json({ error: d.code }, { status: d.status });
  }
}
