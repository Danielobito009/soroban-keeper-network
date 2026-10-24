import { type CommandContext } from "../../args.js";
import { usage, type RunResult } from "../../output.js";
import { runTaskCancel } from "./cancel.js";
import { runTaskExpire } from "./expire.js";
import { runTaskExtendDeadline } from "./extendDeadline.js";
import { runTaskIncreaseReward } from "./increaseReward.js";
import { runTaskRegister } from "./register.js";

export const TASK_COMMANDS = [
  "register",
  "cancel",
  "expire",
  "increase-reward",
  "extend-deadline",
] as const;

/** Task commands named in the help text that have no implementation yet. */
const PLANNED = ["show", "list", "claim", "execute"];

/** Routes `skn task <subcommand>`. */
export async function runTaskCommand(
  subcommand: string | undefined,
  args: readonly string[],
  context: CommandContext,
): Promise<RunResult> {
  const json = args.includes("--json");
  if (subcommand === undefined || subcommand.startsWith("-")) {
    return usage(`'skn task' needs a command: ${TASK_COMMANDS.join(", ")}`, json);
  }
  switch (subcommand) {
    case "register":
      return runTaskRegister(args, context);
    case "cancel":
      return runTaskCancel(args, context);
    case "expire":
      return runTaskExpire(args, context);
    case "increase-reward":
      return runTaskIncreaseReward(args, context);
    case "extend-deadline":
      return runTaskExtendDeadline(args, context);
    default:
      return usage(
        PLANNED.includes(subcommand)
          ? `'skn task ${subcommand}' is not implemented yet`
          : `unknown task command '${subcommand}'; expected one of ${TASK_COMMANDS.join(", ")}`,
        json,
      );
  }
}
