import { NextResponse } from "next/server";
import { AuthenticationError } from "@/server/auth";
import { InvalidLanguageError } from "@/server/settings";
import { setShellLanguage, ShellForbiddenError } from "@/server/workspace";
import { readSessionToken } from "@/server/workspace/session-cookie";
export const dynamic = "force-dynamic";
/** Thin handler: the tenant is resolved from the session cookie; only the language comes from the body. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { language?: unknown } | null;
  try {
    const language = await setShellLanguage(await readSessionToken(), body?.language);
    return NextResponse.json({ language });
  } catch (e) {
    if (e instanceof AuthenticationError) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    if (e instanceof ShellForbiddenError) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    if (e instanceof InvalidLanguageError) return NextResponse.json({ error: "invalid_language" }, { status: 400 });
    throw e;
  }
}
