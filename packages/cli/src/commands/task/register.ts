import { TaskType } from "@soroban-keeper-network/sdk";
import { UsageError, parseCommandArgs, type CommandContext } from "../../args.js";
import { type RunResult } from "../../output.js";
import { parseAmount, parseLedgers, parseTime } from "../parse.js";
import { finish, isRunResult, openSigned, requireMainnetConfirmation } from "../session.js";
import { taskLines, taskView } from "./view.js";

/** Accepts `liquidation`, `oracle-price-push`, ... or the numeric discriminant. */
function parseTaskType(value: string | undefined): TaskType {
  if (value === undefined) throw new UsageError("--type is required");
  if (/^\d+$/.test(value) && TaskType[Number(value)] !== undefined) return Number(value) as TaskType;
  const wanted = value.replace(/[-_ ]/g, "").toLowerCase();
  for (const [name, id] of Object.entries(TaskType)) {
    if (typeof id === "number" && name.toLowerCase() === wanted) return id;
  }
  const names = Object.keys(TaskType).filter((k) => Number.isNaN(Number(k)));
  throw new UsageError(`unknown task type '${value}'; expected one of ${names.join(", ")}`);
}

function parseCalldata(value: string | undefined): Uint8Array {
  const hex = (value ?? "").replace(/^0x/, "");
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new UsageError("--calldata must be hex, for example 0a1b2c");
  }
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

/** `skn task register`: escrows the reward and registers a task owned by the signing key. */
export async function runTaskRegister(
  args: readonly string[],
  context: CommandContext,
): Promise<RunResult> {
  const { values, positionals } = parseCommandArgs(args, {
    type: { type: "string" },
    reward: { type: "string" },
    deadline: { type: "string" },
    "ttl-ledgers": { type: "string" },
    "lock-ledgers": { type: "string" },
    calldata: { type: "string" },
    verifier: { type: "string" },
  });
  if (positionals.length > 0) throw new UsageError(`unexpected argument '${positionals[0]}'`);

  const taskType = parseTaskType(values.type as string | undefined);
  const reward = parseAmount(values.reward as string | undefined, "--reward");
  const deadline = parseTime(values.deadline as string | undefined, "--deadline");
  const ttlLedgers = parseLedgers(values["ttl-ledgers"] as string | undefined, "--ttl-ledgers");
  const lockLedgers = parseLedgers(values["lock-ledgers"] as string | undefined, "--lock-ledgers");
  const calldata = parseCalldata(values.calldata as string | undefined);
  const verifier = values.verifier as string | undefined;

  const session = await openSigned(values, context);
  if (isRunResult(session)) return session;
  requireMainnetConfirmation(session.settings);

  const taskId = await session.client.registerTask({
    owner: session.address,
    taskType,
    calldata,
    reward,
    deadline,
    ttlLedgers,
    lockLedgers,
    ...(verifier ? { verifier } : {}),
    signer: session.signer,
  });
  const view = taskView(taskId, await session.client.getTask(taskId));
  return finish(session, [`Registered task ${taskId}.`, ...taskLines(view)].join("\n"), {
    action: "register",
    task: view,
  });
}
