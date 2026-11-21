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
  UncheckedRevisionError,
  transitionTask,
  retryTask,
  recoverStaleAttempt,
  StaleRecoveryNotPermittedError,
  AttemptNotStaleError,
  STALE_RECOVERY_REASON,
  STALE_EXHAUSTED_REASON,
  DEFAULT_STALE_ATTEMPT_SECONDS,
  MAX_STALE_RECOVERIES,
} from "./state-machine";
export type { TaskStatus, TaskRow, TransitionOptions } from "./state-machine";
export * from "./expiry";
export * from "./operations";
export * from "./recovery";
