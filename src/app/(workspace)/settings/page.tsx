import { redirect } from "next/navigation";
import { SettingsView } from "@/components/settings-view";
import { AuthenticationError } from "@/server/auth";
import { NoActivePlaybookError } from "@/server/playbook";
import { loadSettings } from "@/server/settings/owner";
import { ShellForbiddenError } from "@/server/workspace";
import { readSessionToken } from "@/server/workspace/session-cookie";
export const dynamic = "force-dynamic";
export default async function Page() {
  try {
    return <SettingsView model={await loadSettings(await readSessionToken())} />;
  } catch (e) {
    if (e instanceof AuthenticationError || e instanceof ShellForbiddenError) redirect("/sign-in");
    if (e instanceof NoActivePlaybookError) return null; // the layout already explains this state
    throw e;
  }
}
