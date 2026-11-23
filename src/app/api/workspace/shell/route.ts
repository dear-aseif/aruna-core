import { NextResponse } from "next/server";
import { AuthenticationError } from "@/server/auth";
import { loadShell, ShellForbiddenError } from "@/server/workspace";
import { readSessionToken } from "@/server/workspace/session-cookie";

export const dynamic = "force-dynamic";

/** Thin handler: the tenant is resolved from the session cookie, never from the request. */
export async function GET() {
  try {
    const shell = await loadShell(await readSessionToken());
    if (!shell) return NextResponse.json({ error: "no_active_playbook" }, { status: 409 });
    return NextResponse.json(shell);
  } catch (e) {
    if (e instanceof AuthenticationError) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    if (e instanceof ShellForbiddenError) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    throw e;
  }
}
