import { parseCommandArgs, type CommandContext } from "../../args.js";
import { type RunResult } from "../../output.js";
import { expectPositionals, parseTaskId, parseTime } from "../parse.js";
import { finish, isRunResult, openSigned, requireMainnetConfirmation } from "../session.js";
import { taskLines, taskView } from "./view.js";

/** `skn task extend-deadline <id> --to <time>`: moves a task's deadline later. */
export async function runTaskExtendDeadline(
  args: readonly string[],
  context: CommandContext,
): Promise<RunResult> {
  const { values, positionals } = parseCommandArgs(args, { to: { type: "string" } });
  expectPositionals(positionals, 1, "skn task extend-deadline <task-id> --to <time>");
  const taskId = parseTaskId(positionals[0]);
  const newDeadline = parseTime(values.to as string | undefined, "--to");

  const session = await openSigned(values, context);
  if (isRunResult(session)) return session;
  requireMainnetConfirmation(session.settings);

  await session.client.extendDeadline({
    owner: session.address,
    taskId,
    newDeadline,
    signer: session.signer,
  });

  const view = taskView(taskId, await session.client.getTask(taskId));
  return finish(
    session,
    [`Moved the deadline of task ${taskId} to ${newDeadline.toISOString()}.`, ...taskLines(view)].join("\n"),
    { action: "extend-deadline", task: view },
  );
}
