import { redirect } from "next/navigation";
import { TaskBoard } from "@/components/task-board";
import { AuthenticationError } from "@/server/auth";
import { loadBoard } from "@/server/board";
import { NoActivePlaybookError } from "@/server/playbook";
import { ShellForbiddenError } from "@/server/workspace";
import { readSessionToken } from "@/server/workspace/session-cookie";

export const dynamic = "force-dynamic";

export default async function Page() {
  try {
    return <TaskBoard model={await loadBoard(await readSessionToken())} />;
  } catch (e) {
    if (e instanceof AuthenticationError || e instanceof ShellForbiddenError) redirect("/sign-in");
    if (e instanceof NoActivePlaybookError) return null; // the layout already explains this state
    throw e;
  }
}
