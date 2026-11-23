import { redirect } from "next/navigation";
import { ChatView } from "@/components/chat-view";
import { AuthenticationError } from "@/server/auth";
import { loadChat } from "@/server/chat";
import { NoActivePlaybookError } from "@/server/playbook";
import { ShellForbiddenError } from "@/server/workspace";
import { readSessionToken } from "@/server/workspace/session-cookie";
export const dynamic = "force-dynamic";
export default async function Page({ searchParams }: { searchParams: Promise<{ thread?: string | string[] }> }) {
  const thread = (await searchParams).thread;
  try {
    return <ChatView model={await loadChat(await readSessionToken(), typeof thread === "string" ? thread : null)} />;
  } catch (e) {
    if (e instanceof AuthenticationError || e instanceof ShellForbiddenError) redirect("/sign-in");
    if (e instanceof NoActivePlaybookError) return null; // the layout already explains this state
    throw e;
  }
}
