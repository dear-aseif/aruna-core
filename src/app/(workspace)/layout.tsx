import { redirect } from "next/navigation";
import { WorkspaceShell } from "@/components/workspace-shell";
import { signOut } from "@/server/auth/authjs";
import { AuthenticationError } from "@/server/auth";
import { loadShell, ShellForbiddenError } from "@/server/workspace";
import { readSessionToken } from "@/server/workspace/session-cookie";

export const dynamic = "force-dynamic";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  let shell;
  try {
    shell = await loadShell(await readSessionToken());
  } catch (e) {
    if (e instanceof AuthenticationError || e instanceof ShellForbiddenError) redirect("/sign-in");
    throw e;
  }
  if (!shell) {
    return (
      <main className="mx-auto max-w-md p-6">
        <h1 className="text-xl font-semibold">Workspace not ready</h1>
        <p className="mt-2 text-slate-600">This business has no active Playbook yet. Please contact the operator.</p>
      </main>
    );
  }
  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/sign-in" });
  }
  return (
    <WorkspaceShell businessName={shell.businessName} assistantName={shell.assistantName} signOut={doSignOut}
      nav={shell.nav.map(({ id, label, href }) => ({ id, label, href }))}>
      {children}
    </WorkspaceShell>
  );
}
