import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AuthenticationError, signInWithPassword } from "@/server/auth";
import { hashPassword } from "@/server/auth/password";
import { listAuditEntries } from "@/server/audit";
import { loadBriefings } from "@/server/briefings";
import { loadChat, sendChatMessage } from "@/server/chat";
import { withTenant, type Caller } from "@/server/dal";
import { closeAllPools, withTenantSession } from "@/server/db";
import { ExportUnavailableError, requestOwnExport, setExportRunner } from "@/server/exports";
import { runOwnerExport } from "@/server/exports/service";
import { activatePlaybook } from "@/server/playbook";
import { ASSISTANT_RENAME_AUDIT_TYPE, InvalidAssistantNameError, RenameNotPermittedError, renameAssistant } from "@/server/settings";
import { loadSettings, renameAssistantForOwner } from "@/server/settings/owner";
import { ShellForbiddenError, loadShell } from "@/server/workspace";
import { trackTenant } from "../support/ledger";
try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}
// Task 9.4: settings (rename, Playbook and model views, export trigger) and the briefings empty state.
const run = randomBytes(4).toString("hex");
const password = `pw-${randomBytes(12).toString("base64url")}`;
const mk = (n: string) => ({ n, id: randomUUID(), email: `set-${n}-${run}@unit.example`, token: "", userId: "" });
const A = mk("a");
const B = mk("b");
const system = (t: { id: string }): Caller => ({ tenantId: t.id, actor: "system", actorId: `set-system-${run}` });
const reader = (t: { id: string }): Caller => ({ tenantId: t.id, actor: "owner", actorId: `set-reader-${run}` });
let operatorToken = "";
beforeAll(async () => {
  const doc = JSON.parse(readFileSync("playbooks/denana.json", "utf8"));
  for (const t of [A, B]) {
    trackTenant(t.id);
    await withTenantSession(t.id, async (c) => void (await c.query("insert into tenants (id, name, type, status) values ($1, $2, 'test', 'active')", [t.id, `Settings ${t.n} ${run}`])), "service");
    await withTenant(system(t), async (tx) => tx.insert("profiles", { email: t.email, password_hash: await hashPassword(password), role: "owner" }), "service");
    expect((await activatePlaybook(system(t), doc)).ok).toBe(true);
    const s = (await signInWithPassword(t.email, password))!;
    t.token = s.sessionToken;
    t.userId = s.context.userId;
  }
  const opEmail = `set-op-${run}@unit.example`;
  await withTenant(system(A), async (tx) => tx.insert("profiles", { email: opEmail, password_hash: await hashPassword(password), role: "operator" }), "service");
  operatorToken = (await signInWithPassword(opEmail, password))!.sessionToken;
}, 90_000);
afterEach(() => setExportRunner(runOwnerExport)); // restore the real service the tests may have swapped
afterAll(async () => {
  await closeAllPools();
});
const renameEntries = (t: { id: string }) => withTenant(reader(t), (tx) => listAuditEntries(tx, { type: ASSISTANT_RENAME_AUDIT_TYPE, limit: 50 }));
describe("assistant rename", () => {
  it("changes the displayed name everywhere and writes one audit entry: old -> new, actor owner", async () => {
    const chatThread = (await loadChat(A.token)).selectedThreadId;
    await sendChatMessage(A.token, { threadId: chatThread, body: "What is waiting for my approval?" }); // an agent message exists
    expect((await loadChat(A.token)).messages.at(-1)?.senderName).toBe("Aruna");
    expect(await renameAssistantForOwner(A.token, "  Sari   Asisten ")).toBe("Sari Asisten");
    // shell (header), chat thread name, chat message sender (an OLD message: the name is never stored in it), settings
    expect((await loadShell(A.token))!.assistantName).toBe("Sari Asisten");
    const chat = await loadChat(A.token);
    expect(chat.assistantName).toBe("Sari Asisten");
    expect(chat.threads[0].displayName).toBe("Sari Asisten");
    expect(chat.messages.at(-1)?.senderName).toBe("Sari Asisten");
    expect((await loadSettings(A.token)).assistantName).toBe("Sari Asisten");
    // the audit entry
    const entries = await renameEntries(A);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actor: "owner", actorId: A.userId, taskId: null });
    expect(entries[0].payload).toEqual({ field: "assistant_name", from: "Aruna", to: "Sari Asisten" });
    // the other tenant is untouched
    expect((await loadShell(B.token))!.assistantName).toBe("Aruna");
    expect(await renameEntries(B)).toHaveLength(0);
  });
  it("renaming to the current name writes nothing", async () => {
    await renameAssistantForOwner(A.token, "Sari Asisten");
    expect(await renameEntries(A)).toHaveLength(1);
  });
  it.each([[""], ["   "], ["x".repeat(61)], ["bad\u0007name"], [42], [null]])("refuses an invalid name %j and changes nothing", async (bad) => {
    await expect(renameAssistantForOwner(B.token, bad)).rejects.toBeInstanceOf(InvalidAssistantNameError);
    expect((await loadShell(B.token))!.assistantName).toBe("Aruna");
    expect(await renameEntries(B)).toHaveLength(0);
  });
  it("only an owner session renames: an operator or a signed-out call is refused", async () => {
    await expect(renameAssistantForOwner(operatorToken, "Hacked")).rejects.toBeInstanceOf(ShellForbiddenError);
    await expect(renameAssistantForOwner(undefined, "Hacked")).rejects.toBeInstanceOf(AuthenticationError);
    const op: Caller = { tenantId: A.id, actor: "operator", actorId: `set-op-${run}` };
    await expect(withTenant(op, (tx) => renameAssistant(tx, "Hacked"))).rejects.toBeInstanceOf(RenameNotPermittedError);
    expect((await loadShell(A.token))!.assistantName).toBe("Sari Asisten");
  });
});
describe("settings view", () => {
  it("shows the Playbook and the model configuration of the session's own tenant, read only", async () => {
    const s = await loadSettings(B.token);
    expect(s.playbook).toMatchObject({ version: 1, pack: "services", business: { name: "Denana Facial Studio (synthetic)", timezone: "Asia/Makassar" }, briefingTime: "07:30" });
    expect(s.playbook.hours).toHaveLength(6);
    expect(s.playbook.catalog).toEqual([{ group: "treatments", items: expect.arrayContaining(["Facial Dasar"]) }]);
    expect(s.playbook.templates.bookingConfirmation).toContain("{customer}");
    expect(s.model).toMatchObject({ ok: true, provider: "bedrock", source: "default" });
    expect(s.exportAvailable).toBe(true); // the export service (10.3) is installed
  });
  it("refuses an operator or signed-out caller", async () => {
    await expect(loadSettings(operatorToken)).rejects.toBeInstanceOf(ShellForbiddenError);
    await expect(loadSettings(undefined)).rejects.toBeInstanceOf(AuthenticationError);
  });
});
describe("export trigger", () => {
  it("answers unavailable, and exports nothing, when no runner is installed", async () => {
    setExportRunner(null);
    expect((await loadSettings(A.token)).exportAvailable).toBe(false);
    await expect(requestOwnExport(A.token)).rejects.toBeInstanceOf(ExportUnavailableError);
  });
  it("runs for the owner's OWN tenant only: the tenant comes from the session, never from input", async () => {
    const seen: Caller[] = [];
    setExportRunner(async (caller) => {
      seen.push(caller);
      return { archive: new Uint8Array(), summary: { cutoff: "2026-11-20T00:00:00.000Z", manifest: { tasks: 1 }, fileName: `${caller.tenantId}.zip` } };
    });
    expect(requestOwnExport.length).toBe(1); // the token is the only input
    expect(await requestOwnExport(A.token)).toMatchObject({ summary: { fileName: `${A.id}.zip` } });
    expect(await requestOwnExport(B.token)).toMatchObject({ summary: { fileName: `${B.id}.zip` } });
    expect(seen.map((c) => [c.tenantId, c.actor, c.actorId])).toEqual([
      [A.id, "owner", A.userId],
      [B.id, "owner", B.userId],
    ]);
    expect((await loadSettings(A.token)).exportAvailable).toBe(true);
  });
  it("is refused for an operator session and a signed-out caller; the runner is not called", async () => {
    let calls = 0;
    setExportRunner(async () => {
      calls++;
      return { archive: new Uint8Array(), summary: { cutoff: "", manifest: {}, fileName: "" } };
    });
    await expect(requestOwnExport(operatorToken)).rejects.toBeInstanceOf(ShellForbiddenError);
    await expect(requestOwnExport(undefined)).rejects.toBeInstanceOf(AuthenticationError);
    await expect(requestOwnExport("not-a-session")).rejects.toBeInstanceOf(AuthenticationError);
    expect(calls).toBe(0);
  });
});
describe("briefings empty state", () => {
  it("returns no briefing today and an empty archive, never sample content", async () => {
    expect(await loadBriefings(A.token)).toEqual({ today: null, archive: [] });
    await expect(loadBriefings(operatorToken)).rejects.toBeInstanceOf(ShellForbiddenError);
    await expect(loadBriefings(undefined)).rejects.toBeInstanceOf(AuthenticationError);
  });
});
