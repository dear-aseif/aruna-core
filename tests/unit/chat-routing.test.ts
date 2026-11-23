import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signInWithPassword } from "@/server/auth";
import { hashPassword } from "@/server/auth/password";
import { withTenant, NotFoundError, type Caller } from "@/server/dal";
import { closeAllPools, withTenantSession } from "@/server/db";
import { createModelGateway } from "@/server/gateway";
import { activatePlaybook } from "@/server/playbook";
import { setUiLanguage } from "@/server/settings";
import { classifyQuestion } from "@/server/maestro";
import { InvalidMessageError } from "@/server/threads";
import { ShellForbiddenError } from "@/server/workspace";
import { loadChat, routeChatMessage, sendChatMessage, type GatewayFactory } from "@/server/chat";
import { createFakeAdapter } from "../support/fake-adapter";
import { trackTenant } from "../support/ledger";
try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}
// Task 9.4: the chat routing rule and bilingual question recognition. Synthetic tenants only.
const AGENTS = [
  { id: "maestro", label: "Aruna" },
  { id: "booking", label: "Booking" },
];
const route = (body: string, threadAgent = "maestro") => routeChatMessage({ threadAgent, body, agents: AGENTS });
describe("routing rule (pure)", () => {
  const QUESTIONS: [string, string, string][] = [
    // [language, text, expected intent]
    ["en", "What is waiting for my approval?", "pending_approvals"],
    ["en", "How many tasks are done?", "status_counts"],
    ["en", "What is the Booking agent doing?", "agent_activity"],
    ["en", "What happened recently?", "recent_activity"],
    ["en", "What are you up to?", "agent_activity"],
    ["id", "Apa yang menunggu persetujuan saya?", "pending_approvals"],
    ["id", "Ada berapa tugas yang selesai?", "status_counts"],
    ["id", "Berapa tugas yang gagal?", "status_counts"],
    ["id", "Apa yang sedang dikerjakan agen Booking?", "agent_activity"],
    ["id", "Lagi ngapain semua agen sekarang?", "agent_activity"],
    ["id", "Apa aktivitas terbaru?", "recent_activity"],
    ["id", "Apa yang sedang dikerjakan agen gudang?", "unknown_agent"],
  ];
  it.each(QUESTIONS)("%s question is recognized as a question: %s", (_lang, text, intent) => {
    expect(classifyQuestion(text, AGENTS).kind).toBe(intent);
    expect(route(text)).toBe("question");
  });
  it.each([
    "Confirm the booking for Sari tomorrow at 10:00",
    "Buat tugas konfirmasi booking untuk Sari besok jam 10",
    "Kirim tindak lanjut ke pemasok seragam",
    "Draft a follow-up to the supplier about the white shirts",
  ])("a command is not a question: %s", (text) => {
    expect(route(text)).toBe("command");
  });
  it("a question in a specialist thread is a command: answers are given in the Maestro thread only", () => {
    expect(route("What is waiting for my approval?", "booking")).toBe("command");
    expect(route("Apa yang menunggu persetujuan saya?", "booking")).toBe("command");
  });
});
// ---- routing through the real service: a question creates no task, a command does ----
const run = randomBytes(4).toString("hex");
const password = `pw-${randomBytes(12).toString("base64url")}`;
const mk = (n: string) => ({ n, id: randomUUID(), email: `chat-${n}-${run}@unit.example`, token: "" });
const A = mk("a");
const B = mk("b");
const system = (t: { id: string }): Caller => ({ tenantId: t.id, actor: "system", actorId: `chat-system-${run}` });
const asOwner = (t: { id: string }): Caller => ({ tenantId: t.id, actor: "owner", actorId: `chat-reader-${run}` });
const fake = createFakeAdapter({ kind: "success", text: JSON.stringify({ action_type: "chat.test.draft", fields: { item: "x" } }) });
const gatewayFor: GatewayFactory = async () => createModelGateway(fake);
let operatorToken = "";
const taskCount = (t: { id: string }) => withTenant(asOwner(t), async (tx) => Number((await tx.maybeOne<{ n: string }>("select count(*) n from tasks"))!.n));
const auditTypes = (t: { id: string }, type: string) => withTenant(asOwner(t), (tx) => tx.query<{ task_id: string | null }>("select task_id from audit_log where type = $1", [type]));
beforeAll(async () => {
  const doc = JSON.parse(readFileSync("playbooks/denana.json", "utf8"));
  for (const t of [A, B]) {
    trackTenant(t.id);
    await withTenantSession(t.id, async (c) => void (await c.query("insert into tenants (id, name, type, status) values ($1, $2, 'test', 'active')", [t.id, `Chat ${t.n} ${run}`])), "service");
    await withTenant(system(t), async (tx) => tx.insert("profiles", { email: t.email, password_hash: await hashPassword(password), role: "owner" }), "service");
    expect((await activatePlaybook(system(t), doc)).ok).toBe(true);
    t.token = (await signInWithPassword(t.email, password))!.sessionToken;
  }
  const opEmail = `chat-op-${run}@unit.example`;
  await withTenant(system(A), async (tx) => tx.insert("profiles", { email: opEmail, password_hash: await hashPassword(password), role: "operator" }), "service");
  operatorToken = (await signInWithPassword(opEmail, password))!.sessionToken;
}, 90_000);
afterAll(async () => {
  await closeAllPools();
});
describe("sendChatMessage", () => {
  it("loads one Maestro thread named with the live assistant name; nothing is stored in the thread", async () => {
    const chat = await loadChat(A.token);
    expect(chat.threads.map((t) => t.agent)).toEqual(["maestro"]);
    expect(chat.threads[0].displayName).toBe("Aruna");
    expect(chat.assistantName).toBe("Aruna");
    expect(chat.selectedThreadId).toBe(chat.threads[0].id);
    expect(chat.messages).toEqual([]);
  });
  it.each([
    ["en", "What is waiting for my approval?"],
    ["id", "Apa yang menunggu persetujuan saya?"],
  ])("%s question: answered from live data, no task created, no model call", async (_l, text) => {
    const { selectedThreadId } = await loadChat(A.token);
    const before = await taskCount(A);
    const calls = fake.calls.length;
    const r = await sendChatMessage(A.token, { threadId: selectedThreadId, body: text }, gatewayFor);
    expect(r).toEqual({ route: "question", threadId: selectedThreadId, task: null });
    expect(await taskCount(A)).toBe(before);
    expect(fake.calls.length).toBe(calls);
    const chat = await loadChat(A.token, selectedThreadId);
    const last = chat.messages.slice(-2);
    expect(last.map((m) => m.sender)).toEqual(["owner", "agent"]);
    expect(last[0].body).toBe(text);
    expect(last[0].taskId).toBeNull();
    expect(last[1].body).toBe("Nothing is waiting for your approval.");
    expect(last[1].senderName).toBe("Aruna");
  });
  it("answers follow the tenant's ui_language, whatever language the question is in", async () => {
    const ask = async (t: typeof A, body: string) => {
      const { selectedThreadId } = await loadChat(t.token);
      await sendChatMessage(t.token, { threadId: selectedThreadId, body }, gatewayFor);
      return (await loadChat(t.token, selectedThreadId)).messages.at(-1)!.body;
    };
    // EN tenant (default): English answers, even to an Indonesian question.
    expect(await ask(A, "Apa yang menunggu persetujuan saya?")).toBe("Nothing is waiting for your approval.");
    expect(await ask(A, "Ada berapa tugas yang selesai?")).toMatch(/^\d+ tasks? (is|are) Done\.$/);
    // ID tenant: Indonesian answers, even to an English question.
    await withTenant(asOwner(B), (tx) => setUiLanguage(tx, "id"));
    expect(await ask(B, "What is waiting for my approval?")).toBe("Tidak ada yang menunggu persetujuan Anda.");
    expect(await ask(B, "How many tasks are done?")).toMatch(/^\d+ tugas berstatus Selesai\.$/);
    expect(await ask(B, "How many tasks are there?")).toMatch(/^Tugas menurut status: Antrean \d+, Dikerjakan \d+,/);
    expect(await ask(B, "What is the gudang agent doing?")).toMatch(/^Saya tidak punya agen bernama "gudang"/);
    expect(await taskCount(B)).toBe(0);
  }, 120_000);
  it("command: creates a task linked to the owner message, audited, through the runtime", async () => {
    const { selectedThreadId } = await loadChat(A.token);
    const before = await taskCount(A);
    const commands = (await auditTypes(A, "command.received")).length;
    const r = await sendChatMessage(A.token, { threadId: selectedThreadId, body: "Confirm the booking for Sari tomorrow at 10:00" }, gatewayFor);
    expect(r.route).toBe("command");
    expect(r.task?.id).toBeTruthy();
    expect(await taskCount(A)).toBe(before + 1);
    expect((await auditTypes(A, "command.received")).length).toBe(commands + 1);
    const chat = await loadChat(A.token, selectedThreadId);
    expect(chat.messages.find((m) => m.taskId === r.task!.id)?.body).toBe("Confirm the booking for Sari tomorrow at 10:00");
    // the other tenant saw nothing
    expect(await taskCount(B)).toBe(0);
  });
  it("refuses an empty message, another tenant's thread, an operator session and a missing session", async () => {
    const mine = (await loadChat(A.token)).selectedThreadId;
    const theirs = (await loadChat(B.token)).selectedThreadId;
    await expect(sendChatMessage(A.token, { threadId: mine, body: "   " }, gatewayFor)).rejects.toBeInstanceOf(InvalidMessageError);
    await expect(sendChatMessage(A.token, { threadId: theirs, body: "What is waiting for my approval?" }, gatewayFor)).rejects.toBeInstanceOf(NotFoundError);
    await expect(sendChatMessage(operatorToken, { threadId: mine, body: "hello" }, gatewayFor)).rejects.toBeInstanceOf(ShellForbiddenError);
    await expect(sendChatMessage(undefined, { threadId: mine, body: "hello" }, gatewayFor)).rejects.toThrow();
    expect(await taskCount(B)).toBe(0);
  });
});
