import { notFound, redirect } from "next/navigation";
import { BriefingDetailView } from "@/components/briefing-detail-view";
import { AuthenticationError } from "@/server/auth";
import { loadBriefingDetail } from "@/server/briefings";
import { NotFoundError } from "@/server/dal/errors";
import { NoActivePlaybookError } from "@/server/playbook";
import { ShellForbiddenError } from "@/server/workspace";
import { readSessionToken } from "@/server/workspace/session-cookie";
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  try {
    return <BriefingDetailView briefing={await loadBriefingDetail(await readSessionToken(), (await params).id)} />;
  } catch (e) {
    if (e instanceof AuthenticationError || e instanceof ShellForbiddenError) redirect("/sign-in");
    if (e instanceof NotFoundError) notFound();
    if (e instanceof NoActivePlaybookError) return null; // the layout already explains this state
    throw e;
  }
}
