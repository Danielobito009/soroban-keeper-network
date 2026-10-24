import { parseCommandArgs, type CommandContext } from "../../args.js";
import { type RunResult } from "../../output.js";
import { expectPositionals, parseTaskId } from "../parse.js";
import { finish, isRunResult, openSigned, requireMainnetConfirmation } from "../session.js";
import { taskLines, taskView } from "./view.js";

/**
 * `skn task expire <id>`: expires a task whose deadline has passed and returns
 * the escrow to its owner. Any account may do this; the signing key only pays
 * the fee.
 */
export async function runTaskExpire(
  args: readonly string[],
  context: CommandContext,
): Promise<RunResult> {
  const { values, positionals } = parseCommandArgs(args, {});
  expectPositionals(positionals, 1, "skn task expire <task-id>");
  const taskId = parseTaskId(positionals[0]);

  const session = await openSigned(values, context);
  if (isRunResult(session)) return session;
  requireMainnetConfirmation(session.settings);

  await session.client.expireTask({ taskId, caller: session.address, signer: session.signer });

  const view = taskView(taskId, await session.client.getTask(taskId));
  return finish(
    session,
    [`Expired task ${taskId}; the escrowed reward went back to its owner.`, ...taskLines(view)].join("\n"),
    { action: "expire", task: view },
  );
}
