import { getCheckerPack, registerCheckerPack } from "../checker/registry";
import { setReviseCheckOverride } from "../board/check-deps";
import { getActionHandler, registerActionHandler } from "./actions";

/**
 * Non-production approval handler for the phone-viewport end-to-end tests (task 9.2).
 *
 * The real pack handlers (bookings, goods receipt, follow-ups) arrive in groups 12 and 13. Until
 * then the dev server used by Playwright has no handler for any action type, so an owner approval
 * could not run. This registers one synthetic gated action, `e2e.board.confirm`, and ONLY when
 * NODE_ENV is not "production". Its effect is an audit entry (`e2e.action.executed`) written in the
 * approval transaction, which lets a test count executions from the database. Imported only by the
 * approve and reject route handlers; unit tests never import it.
 */
export const E2E_ACTION_TYPE = "e2e.board.confirm";
export const E2E_EXECUTED_AUDIT_TYPE = "e2e.action.executed";

if (process.env.NODE_ENV !== "production" && !getActionHandler(E2E_ACTION_TYPE)) {
  registerActionHandler({
    type: E2E_ACTION_TYPE,
    gated: true,
    execute: async (ctx) => {
      await ctx.tx.audit(E2E_EXECUTED_AUDIT_TYPE, { revision: ctx.revision, fields: ctx.fields }, ctx.task.id);
      return { confirmed: true };
    },
    cancel: async () => 1,
  });
}

/**
 * Task 9.2 gate fix: a revised draft is re-checked in the same request. The dev server has no real
 * pack rules or provider account, so (non-production only) the re-check uses an empty rule set under
 * the pack id below and a model review that answers "ok" without any provider call.
 */
export const E2E_CHECK_PACK = "e2e-board";
if (process.env.NODE_ENV !== "production") {
  if (!getCheckerPack(E2E_CHECK_PACK)) registerCheckerPack({ packId: E2E_CHECK_PACK, rules: [] });
  setReviseCheckOverride({
    check: { packId: E2E_CHECK_PACK },
    gateway: { complete: async () => ({ text: '{"verdict":"ok","issues":[]}', parsed: { verdict: "ok", issues: [] } }) },
  });
}
