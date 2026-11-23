import { redirect } from "next/navigation";
import { BriefingsView } from "@/components/briefings-view";
import { AuthenticationError } from "@/server/auth";
import { loadBriefings } from "@/server/briefings";
import { ShellForbiddenError } from "@/server/workspace";
import { readSessionToken } from "@/server/workspace/session-cookie";
export const dynamic = "force-dynamic";
export default async function Page() {
  try {
    return <BriefingsView model={await loadBriefings(await readSessionToken())} />;
  } catch (e) {
    if (e instanceof AuthenticationError || e instanceof ShellForbiddenError) redirect("/sign-in");
    throw e;
  }
}
