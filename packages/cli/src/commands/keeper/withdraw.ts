import { KeeperErrorCode, isKeeperError } from "@soroban-keeper-network/sdk";
import { parseCommandArgs, UsageError, type CommandContext } from "../../args.js";
import { type RunResult } from "../../output.js";
import { finish, isRunResult, openSigned, requireMainnetConfirmation } from "../session.js";

/**
 * `skn keeper withdraw`: pays the signing keeper's accrued rewards out to it.
 * An empty balance reports "nothing to withdraw" and sends no transaction.
 */
export async function runKeeperWithdraw(
  args: readonly string[],
  context: CommandContext,
): Promise<RunResult> {
  const { values, positionals } = parseCommandArgs(args, {});
  if (positionals.length > 0) {
    throw new UsageError(`unexpected argument '${positionals[0]}'; usage: skn keeper withdraw`);
  }
  const session = await openSigned(values, context);
  if (isRunResult(session)) return session;
  const keeper = session.address;

  // Checked here, before the mainnet guard, so that an empty balance does not
  // demand --confirm-mainnet for a transaction that will never be sent.
  const available = await session.client.keeperBalance(keeper);
  if (available === 0n) {
    return finish(session, "Nothing to withdraw: the balance is zero.", { keeper, withdrawn: 0n });
  }

  requireMainnetConfirmation(session.settings);
  let withdrawn: bigint;
  try {
    // The SDK repeats the balance check and skips the transaction when it is
    // zero, so a balance emptied since the read above costs no fee either.
    withdrawn = (await session.client.withdrawRewards({ keeper, signer: session.signer })).amount;
  } catch (err) {
    // Emptied between the SDK's check and the transaction: same outcome.
    if (!isKeeperError(err, KeeperErrorCode.NoRewardsAvailable)) throw err;
    withdrawn = 0n;
  }
  const text =
    withdrawn === 0n
      ? "Nothing to withdraw: the balance was emptied before the withdrawal ran."
      : `Withdrew ${withdrawn} to ${keeper}.`;
  return finish(session, text, { keeper, withdrawn });
}
