import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllPools, withTenantSession } from "@/server/db";
import { withTenant, NotFoundError, type Caller } from "@/server/dal";
import { createTaskTx } from "@/server/tasks";
import {
  InvalidMessageError,
  ensureThreadsTx,
  getThreadViewTx,
  listMessagesTx,
  listThreadsTx,
  postMessageTx,
} from "@/server/threads";
import { registerSpecialist } from "@/server/agents";
import { trackTenant } from "../support/ledger";
import { registerTestSpecialists } from "../support/test-specialists";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}

// Synthetic tenants only; removed by the shared teardown.
const run = randomBytes(4).toString("hex");
interface Fx { id: string; pack: "services" | "retail" | null; name: string }
const mk = (pack: Fx["pack"], name: string): Fx => ({ id: randomUUID(), pack, name });
const S = mk("services", "Sari");
const R = mk("retail", "Rina");
const N = mk(null, "Nila");
const caller = (f: Fx): Caller => ({ tenantId: f.id, actor: "owner", actorId: `thr-owner-${run}` });

beforeAll(async () => {
  registerTestSpecialists();
  for (const f of [S, R, N]) {
    trackTenant(f.id);
    await withTenantSession(
      f.id,
      async (c) => {
        await c.query("insert into tenants (id, name, type, active_pack, status) values ($1, $2, 'test', $3, 'active')", [f.id, `Thr ${f.name} ${run}`, f.pack]);
        await c.query("insert into settings (tenant_id, assistant_name) values ($1, $2)", [f.id, f.name]);
      },
      "service",
    );
  }
}, 60_000);

afterAll(async () => {
  await closeAllPools();
});

const agents = (f: Fx) => withTenant(caller(f), async (tx) => (await listThreadsTx(tx)).map((t) => t.agent));
const threadId = (f: Fx, agent: string) =>
  withTenant(caller(f), async (tx) => (await listThreadsTx(tx)).find((t) => t.agent === agent)!.id);

describe("thread uniqueness", () => {
  it("creates one Maestro thread plus one per active specialist, and nothing for other packs", async () => {
    const created = await withTenant(caller(S), (tx) => ensureThreadsTx(tx));
    expect(created.map((t) => t.agent)).toEqual(["maestro", "test_scribe"]);
    await withTenant(caller(R), (tx) => ensureThreadsTx(tx));
    await withTenant(caller(N), (tx) => ensureThreadsTx(tx));
    expect(await agents(S)).toEqual(["maestro", "test_scribe"]);
    expect(await agents(R)).toEqual(["maestro", "test_counter", "test_counter_two"]);
    expect(await agents(N)).toEqual(["maestro"]);
  });

  it("is idempotent and audits only real creations", async () => {
    expect(await withTenant(caller(S), (tx) => ensureThreadsTx(tx))).toEqual([]);
    expect(await agents(S)).toEqual(["maestro", "test_scribe"]);
    const n = await withTenant(caller(S), async (tx) =>
      Number((await tx.query<{ n: string }>("select count(*)::text n from audit_log where type = 'thread.created'"))[0].n),
    );
    expect(n).toBe(2);
  });

  it("stays unique under concurrent creation", async () => {
    await Promise.all(Array.from({ length: 5 }, () => withTenant(caller(N), (tx) => ensureThreadsTx(tx))));
    expect(await agents(N)).toEqual(["maestro"]);
  });

  it("the database refuses a second thread for the same agent and a second Maestro", async () => {
    await expect(
      withTenant(caller(S), (tx) => tx.insert("threads", { kind: "specialist", agent: "test_scribe", title: "Dup" })),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      withTenant(caller(S), (tx) => tx.insert("threads", { kind: "maestro", agent: "maestro", title: null })),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("a thread created for a newly registered specialist appears on the next ensure", async () => {
    registerSpecialist({ id: "test_late", pack: "services", label: "Test Late" });
    const created = await withTenant(caller(S), (tx) => ensureThreadsTx(tx));
    expect(created.map((t) => t.agent)).toEqual(["test_late"]);
  });
});

describe("cross-tenant isolation (threads and messages are invisible)", () => {
  it("another tenant's threads and messages are invisible and cannot be written to", async () => {
    const sThread = await threadId(S, "maestro");
    const rThread = await threadId(R, "maestro");
    await withTenant(caller(S), (tx) => postMessageTx(tx, { threadId: sThread, sender: "owner", body: "secret of S" }));

    await withTenant(caller(R), async (tx) => {
      for (const t of ["threads", "messages"]) {
        const leaked = await tx.query<{ n: string }>(`select count(*)::text n from "${t}" where tenant_id <> $1`, [R.id]);
        expect(Number(leaked[0].n), `${t} leaked`).toBe(0);
      }
      await expect(listMessagesTx(tx, sThread)).rejects.toBeInstanceOf(NotFoundError);
      await expect(getThreadViewTx(tx, sThread)).rejects.toBeInstanceOf(NotFoundError);
      await expect(postMessageTx(tx, { threadId: sThread, sender: "owner", body: "intrusion" })).rejects.toBeInstanceOf(NotFoundError);
    });
    // S's thread is untouched.
    const sMsgs = await withTenant(caller(S), (tx) => listMessagesTx(tx, sThread));
    expect(sMsgs.map((m) => m.body)).toEqual(["secret of S"]);
    expect(await withTenant(caller(R), (tx) => listMessagesTx(tx, rThread))).toEqual([]);
  });

  it("a message cannot reference another tenant's task", async () => {
    const sTask = await withTenant(caller(S), (tx) => createTaskTx(tx, { title: "S task", origin: "direct", agent: "maestro" }));
    const rThread = await threadId(R, "maestro");
    await expect(
      withTenant(caller(R), (tx) => postMessageTx(tx, { threadId: rThread, sender: "owner", body: "x", taskId: sTask.id })),
    ).rejects.toBeInstanceOf(NotFoundError);
    // The same-tenant link works.
    const m = await withTenant(caller(S), async (tx) =>
      postMessageTx(tx, { threadId: await threadId(S, "maestro"), sender: "agent", body: "queued it", taskId: sTask.id }),
    );
    expect(m.task_id).toBe(sTask.id);
  });

  it("messages are immutable for the runtime role", async () => {
    const id = await threadId(S, "maestro");
    await expect(withTenant(caller(S), (tx) => tx.query("update messages set body = 'edited' where thread_id = $1", [id]))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenant(caller(S), (tx) => tx.query("delete from messages where thread_id = $1", [id]))).rejects.toMatchObject({ code: "42501" });
  });
});

describe("assistant name is resolved live from settings", () => {
  it("a rename is reflected in the chat read model without touching any thread or message row", async () => {
    const id = await threadId(R, "maestro");
    await withTenant(caller(R), async (tx) => {
      await postMessageTx(tx, { threadId: id, sender: "owner", body: "hello" });
      await postMessageTx(tx, { threadId: id, sender: "agent", body: "hi there" });
    });
    const snapshot = () =>
      withTenant(caller(R), async (tx) => ({
        threads: await tx.query("select * from threads order by agent"),
        messages: await tx.query("select * from messages order by seq"),
      }));
    const view = () => withTenant(caller(R), (tx) => getThreadViewTx(tx, id));

    const before = await snapshot();
    const v1 = await view();
    expect(v1.thread.displayName).toBe("Rina");
    expect(v1.messages.map((m) => m.senderName)).toEqual(["Owner", "Rina"]);

    await withTenant(caller(R), (tx) => tx.updateById("settings", R.id, { assistant_name: "Ratu", updated_at: new Date() }, "tenant_id"));

    const v2 = await view();
    expect(v2.thread.displayName).toBe("Ratu");
    expect(v2.messages.map((m) => m.senderName)).toEqual(["Owner", "Ratu"]);
    expect((await withTenant(caller(R), (tx) => listThreadsTx(tx))).find((t) => t.id === id)!.displayName).toBe("Ratu");
    expect(await snapshot()).toEqual(before); // no thread or message row changed

    // The name appears in no stored thread or message column.
    const stored = JSON.stringify(before);
    expect(stored).not.toContain("Ratu");
    expect(stored).not.toContain("Rina");
  });

  it("a specialist thread shows its role label, not the assistant name", async () => {
    const list = await withTenant(caller(R), (tx) => listThreadsTx(tx));
    expect(list.find((t) => t.agent === "test_counter")).toMatchObject({ displayName: "Test Counter", active: true });
  });
});

describe("message order", () => {
  it("is stable for messages written in one transaction (equal created_at)", async () => {
    const id = await threadId(S, "test_scribe");
    const bodies = Array.from({ length: 12 }, (_, i) => `m${String(i).padStart(2, "0")}`);
    await withTenant(caller(S), async (tx) => {
      for (const b of bodies) await postMessageTx(tx, { threadId: id, sender: b.endsWith("1") ? "agent" : "owner", body: b });
    });
    const rows = await withTenant(caller(S), (tx) => tx.query<{ created_at: Date }>("select created_at from messages where thread_id = $1", [id]));
    expect(new Set(rows.map((r) => r.created_at.getTime())).size).toBe(1); // one transaction, one timestamp
    for (let i = 0; i < 3; i++) {
      const got = await withTenant(caller(S), (tx) => listMessagesTx(tx, id));
      expect(got.map((m) => m.body)).toEqual(bodies);
    }
  });

  it("a limited read returns the newest messages, still oldest first", async () => {
    const id = await threadId(S, "test_scribe");
    const got = await withTenant(caller(S), (tx) => listMessagesTx(tx, id, { limit: 3 }));
    expect(got.map((m) => m.body)).toEqual(["m09", "m10", "m11"]);
  });

  it("refuses malformed messages", async () => {
    const id = await threadId(S, "test_scribe");
    for (const body of ["   ", "x".repeat(4001)])
      await expect(withTenant(caller(S), (tx) => postMessageTx(tx, { threadId: id, sender: "owner", body }))).rejects.toBeInstanceOf(InvalidMessageError);
    await expect(withTenant(caller(S), (tx) => postMessageTx(tx, { threadId: id, sender: "robot" as never, body: "x" }))).rejects.toBeInstanceOf(InvalidMessageError);
    await expect(withTenant(caller(S), (tx) => listMessagesTx(tx, "not-a-uuid"))).rejects.toBeInstanceOf(NotFoundError);
  });
});
