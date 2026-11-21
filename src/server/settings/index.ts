import type { TenantTx } from "../dal";

/**
 * The one reader of the assistant's display name (design §2.6, R4.4, R4.5). Every surface that
 * shows the name (chat now, briefings and the workspace later) calls this inside its own
 * transaction, so a rename in settings is visible on the next read and no copy can go stale.
 * The name is never written to any other table.
 */
export async function getAssistantName(tx: TenantTx): Promise<string> {
  const row = await tx.maybeOne<{ assistant_name: string }>("select assistant_name from settings where tenant_id = $1", [tx.tenantId]);
  if (!row) throw new Error("tenant has no settings row (activate a Playbook first)");
  return row.assistant_name;
}
