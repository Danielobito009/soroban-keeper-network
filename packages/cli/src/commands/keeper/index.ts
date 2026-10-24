import { type CommandContext } from "../../args.js";
import { usage, type RunResult } from "../../output.js";
import { runKeeperBalance } from "./balance.js";
import {
  runKeeperStake,
  runKeeperUnbond,
  runKeeperUnbonding,
  runKeeperWithdrawStake,
} from "./stake.js";
import { runKeeperWithdraw } from "./withdraw.js";

export const KEEPER_COMMANDS = [
  "balance",
  "withdraw",
  "stake",
  "unbond",
  "withdraw-stake",
  "unbonding",
] as const;

/** Routes `skn keeper <subcommand>`. */
export async function runKeeperCommand(
  subcommand: string | undefined,
  args: readonly string[],
  context: CommandContext,
): Promise<RunResult> {
  const json = args.includes("--json");
  if (subcommand === undefined || subcommand.startsWith("-")) {
    return usage(`'skn keeper' needs a command: ${KEEPER_COMMANDS.join(", ")}`, json);
  }
  switch (subcommand) {
    case "balance":
      return runKeeperBalance(args, context);
    case "withdraw":
      return runKeeperWithdraw(args, context);
    case "stake":
      return runKeeperStake(args, context);
    case "unbond":
      return runKeeperUnbond(args, context);
    case "withdraw-stake":
      return runKeeperWithdrawStake(args, context);
    case "unbonding":
      return runKeeperUnbonding(args, context);
    default:
      return usage(
        `unknown keeper command '${subcommand}'; expected one of ${KEEPER_COMMANDS.join(", ")}`,
        json,
      );
  }
}
