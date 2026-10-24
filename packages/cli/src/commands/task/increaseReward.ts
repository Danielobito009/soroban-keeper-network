import { parseCommandArgs, type CommandContext } from "../../args.js";
import { type RunResult } from "../../output.js";
import { expectPositionals, parsePositiveAmount, parseTaskId } from "../parse.js";
import { finish, isRunResult, openSigned, requireMainnetConfirmation } from "../session.js";
import { taskLines, taskView } from "./view.js";

/** `skn task increase-reward <id> --by <amount>`: escrows more reward for a task. */
export async function runTaskIncreaseReward(
  args: readonly string[],
  context: CommandContext,
): Promise<RunResult> {
  const { values, positionals } = parseCommandArgs(args, { by: { type: "string" } });
  expectPositionals(positionals, 1, "skn task increase-reward <task-id> --by <amount>");
  const taskId = parseTaskId(positionals[0]);
  const additional = parsePositiveAmount(values.by as string | undefined, "--by");

  const session = await openSigned(values, context);
  if (isRunResult(session)) return session;
  requireMainnetConfirmation(session.settings);

  await session.client.increaseReward({
    owner: session.address,
    taskId,
    additional,
    signer: session.signer,
  });

  const view = taskView(taskId, await session.client.getTask(taskId));
  return finish(
    session,
    [`Added ${additional} to the reward of task ${taskId}.`, ...taskLines(view)].join("\n"),
    { action: "increase-reward", added: additional, task: view },
  );
}
