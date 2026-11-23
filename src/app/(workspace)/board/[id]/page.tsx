import { notFound, redirect } from "next/navigation";
import { TaskDetailView } from "@/components/task-detail-view";
import { AuthenticationError } from "@/server/auth";
import { loadTaskDetail } from "@/server/board";
import { NotFoundError } from "@/server/dal/errors";
import { NoActivePlaybookError } from "@/server/playbook";
import { ShellForbiddenError } from "@/server/workspace";
import { readSessionToken } from "@/server/workspace/session-cookie";
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  try {
    return <TaskDetailView detail={await loadTaskDetail(await readSessionToken(), (await params).id)} />;
  } catch (e) {
    if (e instanceof AuthenticationError || e instanceof ShellForbiddenError) redirect("/sign-in");
    if (e instanceof NotFoundError) notFound();
    if (e instanceof NoActivePlaybookError) return null; // the layout already explains this state
    throw e;
  }
}
