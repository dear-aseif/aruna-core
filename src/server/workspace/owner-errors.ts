import { describeBoardError } from "../board/service";
import { ExportUnavailableError } from "../exports";
import { InvalidAssistantNameError, RenameNotPermittedError } from "../settings";
import { InvalidMessageError } from "../threads";
import { NotMaestroThreadError, QuestionNotPermittedError } from "../maestro";
import { CommandNotPermittedError } from "../runtime";
/** HTTP mapping for the chat, settings and export routes (task 9.4). Null = not a known error; the caller rethrows. */
export function describeOwnerError(e: unknown): { status: number; code: string } | null {
  if (e instanceof InvalidMessageError || e instanceof InvalidAssistantNameError) return { status: 400, code: "invalid_input" };
  if (e instanceof QuestionNotPermittedError || e instanceof CommandNotPermittedError || e instanceof RenameNotPermittedError) return { status: 403, code: "forbidden" };
  if (e instanceof NotMaestroThreadError) return { status: 409, code: "not_maestro_thread" };
  if (e instanceof ExportUnavailableError) return { status: 503, code: "export_unavailable" };
  return describeBoardError(e);
}
