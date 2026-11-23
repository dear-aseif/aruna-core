import { notFound } from "next/navigation";
import { ScreenPlaceholder } from "@/components/screen-placeholder";
import { loadShell, findPackScreen } from "@/server/workspace";
import { readSessionToken } from "@/server/workspace/session-cookie";

export const dynamic = "force-dynamic";

export default async function PackScreenPage({ params }: { params: Promise<{ screen: string }> }) {
  const { screen } = await params;
  const shell = await loadShell(await readSessionToken());
  const item = shell ? findPackScreen(shell.pack, screen) : null;
  if (!item) notFound();
  return <ScreenPlaceholder navId={item.id} navLabel={item.label} bodyKey="screen.notBuilt" />;
}
