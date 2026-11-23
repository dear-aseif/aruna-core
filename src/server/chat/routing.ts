import { classifyQuestion } from "../maestro/answers";
import type { KnownAgent } from "../maestro/queries";
import { MAESTRO_AGENT } from "../agents";
/**
 * The chat routing rule (task 9.4, gate note 8.3). One explicit, deterministic rule decides what an
 * owner message is. No model takes part.
 *
 *   - A message in the Maestro thread that the Maestro's question recognizer (Indonesian and
 *     English) recognizes goes to `askMaestro`: it is answered from live data and creates no task.
 *   - Every other message goes to `submitCommand`: it creates a task and is audited.
 *   - A message in a specialist thread is always a command: live-data answers are given in the
 *     Maestro thread only (askMaestro refuses any other thread).
 */
export type ChatRoute = "question" | "command";
export function routeChatMessage(input: { threadAgent: string; body: string; agents: readonly KnownAgent[] }): ChatRoute {
  if (input.threadAgent !== MAESTRO_AGENT) return "command";
  return classifyQuestion(input.body, input.agents).kind === "unsupported" ? "command" : "question";
}
