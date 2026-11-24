import { NextResponse } from "next/server";
import { requestOwnExport } from "@/server/exports";
import { describeOwnerError } from "@/server/workspace/owner-errors";
import { readSessionToken } from "@/server/workspace/session-cookie";
export const dynamic = "force-dynamic";
/**
 * Thin handler: no body is read. The tenant to export is always the session's own. The response is
 * the archive itself (zip); the cutoff and the entity-count manifest travel in headers.
 */
export async function POST() {
  try {
    const { summary, archive } = await requestOwnExport(await readSessionToken());
    return new NextResponse(Buffer.from(archive), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${summary.fileName}"`,
        "Cache-Control": "no-store",
        "X-Export-Cutoff": summary.cutoff,
        "X-Export-Manifest": JSON.stringify(summary.manifest),
        "X-Export-File-Name": summary.fileName,
      },
    });
  } catch (e) {
    const d = describeOwnerError(e);
    if (!d) throw e;
    return NextResponse.json({ error: d.code }, { status: d.status });
  }
}
