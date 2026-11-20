// `returnToReviewOnRevision` (gate ruling 6.3) is deliberately NOT exported here: only approvals/service.ts
// imports it, directly from ./state-machine.
export {
  TASK_STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  TASK_AUDIT_TYPES,
  DEFAULT_APPROVAL_EXPIRY_MINUTES,
  isLegalTransition,
  IllegalTransitionError,
  RetryNotPermittedError,
  transitionTask,
  retryTask,
} from "./state-machine";
export type { TaskStatus, TaskRow, TransitionOptions } from "./state-machine";
export * from "./expiry";
export * from "./operations";
