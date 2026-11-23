import { notFound } from "next/navigation";
import { loadShell, findPackScreen } from "@/server/workspace";
import { readSessionToken } from "@/server/workspace/session-cookie";

export const dynamic = "force-dynamic";

export default async function PackScreenPage({ params }: { params: Promise<{ screen: string }> }) {
  const { screen } = await params;
  const shell = await loadShell(await readSessionToken());
  const item = shell ? findPackScreen(shell.pack, screen) : null;
  if (!item) notFound();
  return (
    <section>
      <h1 className="text-xl font-semibold">{item.label}</h1>
      <p className="mt-2 text-slate-600">This screen is not built yet.</p>
    </section>
  );
}
