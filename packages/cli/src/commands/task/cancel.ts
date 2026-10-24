import { type RpcServerLike } from "@soroban-keeper-network/sdk";
import { parseCommandArgs, type CommandContext } from "../../args.js";
import { EXIT } from "../../exitCodes.js";
import { fail, type RunResult } from "../../output.js";
import { describeWait, expectPositionals, parseTaskId } from "../parse.js";
import { finish, isRunResult, openSigned, requireMainnetConfirmation } from "../session.js";
import { statusName, taskLines, taskView } from "./view.js";

async function ledgerNow(server: RpcServerLike): Promise<number | undefined> {
  try {
    return (await server.getLatestLedger()).sequence;
  } catch {
    // The height only sharpens the wait estimate; the unlock ledger is enough.
    return undefined;
  }
}

/**
 * `skn task cancel <id>`: cancels a pending task, or a claimed one whose lock
 * has lapsed, and refunds the escrow. A refused cancel explains why instead of
 * just echoing the contract's error code.
 */
export async function runTaskCancel(
  args: readonly string[],
  context: CommandContext,
): Promise<RunResult> {
  const { values, positionals } = parseCommandArgs(args, {});
  expectPositionals(positionals, 1, "skn task cancel <task-id>");
  const taskId = parseTaskId(positionals[0]);
  const json = values.json === true;

  const session = await openSigned(values, context);
  if (isRunResult(session)) return session;
  requireMainnetConfirmation(session.settings);

  const outcome = await session.client.cancelTask({
    owner: session.address,
    taskId,
    signer: session.signer,
  });

  if (outcome.status === "lock_period_active") {
    const task = await session.client.getTask(taskId);
    const lockedUntil = (task.claimLedger ?? 0) + task.lockLedgers;
    const now = await ledgerNow(session.server);
    let when = `at ledger ${lockedUntil}`;
    if (now !== undefined) {
      when =
        now >= lockedUntil
          ? `at ledger ${lockedUntil}, which has now passed, so you can retry`
          : `in ${describeWait(lockedUntil - now)}, at ledger ${lockedUntil}`;
    }
    return fail(
      EXIT.contract,
      "CONTRACT_ERROR",
      `LockPeriodActive: task ${taskId} is claimed by ${task.claimer}, and a claimed task can only be cancelled once its lock lapses. ` +
        `The claim was made at ledger ${task.claimLedger} with a lock of ${task.lockLedgers} ledgers, so it lapses ${when}.`,
      json,
      { contractError: "LockPeriodActive", errorCode: 9, lockedUntilLedger: lockedUntil },
    );
  }

  const task = await session.client.getTask(taskId);
  if (outcome.status === "invalid_task_status") {
    return fail(
      EXIT.contract,
      "CONTRACT_ERROR",
      `InvalidTaskStatus: task ${taskId} is already ${statusName(task.status)} and can never be cancelled.`,
      json,
      { contractError: "InvalidTaskStatus", errorCode: 5 },
    );
  }

  const view = taskView(taskId, task);
  return finish(
    session,
    [`Cancelled task ${taskId}; the escrowed reward was refunded to ${session.address}.`, ...taskLines(view)].join("\n"),
    { action: "cancel", task: view },
  );
}
