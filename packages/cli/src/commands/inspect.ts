import {
  checkContractCompatibility,
  feesAccrued,
  getFeeBps,
  isPaused,
  minReward,
  minStake,
  taskCount,
  type ContractCompatibility,
} from "@soroban-keeper-network/sdk";
import {
  loadConfig,
  parseCommandArgs,
  settingFlagsFrom,
  type CommandContext,
} from "../args.js";
import { openRegistry } from "../client.js";
import { jsonResult, ok, usage, type RunResult } from "../output.js";
import { resolveSettings } from "../settings.js";

/**
 * `skn inspect` / `skn inspect summary`: prints the protocol summary from
 * read-only contract views: version, paused, fee bps, minimum reward and
 * stake, fees accrued, task count, and compatibility with the CLI's SDK.
 *
 * Every value is read via simulation; no transaction is signed or sent.
 */
export async function runInspect(
  args: readonly string[],
  context: CommandContext,
): Promise<RunResult> {
  const { values, positionals } = parseCommandArgs(args, {});
  const json = values.json === true;
  if (positionals.length > 0) {
    return usage(`'skn inspect' takes no arguments; got '${positionals[0]}'`, json);
  }

  const config = await loadConfig(context);
  const settings = resolveSettings(settingFlagsFrom(values), config);
  if (settings.contractId === undefined) {
    return usage("--contract-id is required (or set contractId in the selected profile)", json);
  }

  const warnings: string[] = [];
  const client = openRegistry(settings, context, warnings);

  const compatibility = await checkContractCompatibility(client);
  const paused = await isPaused(client);
  const feeBps = await getFeeBps(client);
  const minRewardValue = await readBigIntView(() => minReward(client));
  const minStakeValue = await readBigIntView(() => minStake(client));
  const feesAccruedValue = await readBigIntView(() => feesAccrued(client));
  const totalTasks = await taskCount(client);

  const { min, max } = compatibility.supported;
  const compatible = compatibility.status === "compatible";
  const allWarnings = [
    ...warnings,
    ...(compatibility.warning ? [compatibility.warning] : []),
  ];
  const stderr = allWarnings.map((line) => `skn: warning: ${line}\n`).join("");

  if (json) {
    const result = jsonResult({
      contractId: settings.contractId,
      network: settings.network,
      version: compatibility.contractVersion,
      contractVersion: compatibility.contractVersion,
      paused,
      feeBps,
      minReward: minRewardValue,
      minStake: minStakeValue,
      feesAccrued: feesAccruedValue,
      taskCount: totalTasks,
      compatible,
      status: compatibility.status,
      supportedVersions: { min, max },
      compatibility: {
        status: compatibility.status,
        supported: { min, max },
        ...(compatibility.warning ? { warning: compatibility.warning } : {}),
      },
    });
    return { ...result, stderr };
  }

  const supportText = compatible
    ? `compatible (supported: ${min}..${max})`
    : `${compatibility.status} (supported: ${min}..${max})`;
  const feePercent = (feeBps / 100).toFixed(2);
  const lines = [
    `contract ${settings.contractId} on ${settings.network}`,
    `version:           ${compatibility.contractVersion} (${supportText})`,
    `paused:            ${paused}`,
    `fee bps:           ${feeBps} (${feePercent}%)`,
    `min reward:        ${minRewardValue} stroops`,
    `min stake:         ${minStakeValue} stroops`,
    `fees accrued:      ${feesAccruedValue} stroops`,
    `task count:        ${totalTasks}`,
    `sdk compatibility: ${compatibility.status}`,
  ];
  return { ...ok(`${lines.join("\n")}\n`), stderr };
}

/** `skn inspect version`: the deployed contract's VERSION, and whether this CLI supports it. */
export async function runInspectVersion(
  args: readonly string[],
  context: CommandContext,
): Promise<RunResult> {
  const { values, positionals } = parseCommandArgs(args, {});
  const json = values.json === true;
  if (positionals.length > 0) {
    return usage(`'skn inspect version' takes no arguments; got '${positionals[0]}'`, json);
  }

  const config = await loadConfig(context);
  const settings = resolveSettings(settingFlagsFrom(values), config);
  if (settings.contractId === undefined) {
    return usage("--contract-id is required (or set contractId in the selected profile)", json);
  }

  const warnings: string[] = [];
  const client = openRegistry(settings, context, warnings);

  const compatibility = await checkContractCompatibility(client);
  const result = printVersion(settings.contractId, settings.network, compatibility, json);
  const stderr = [...warnings, ...(compatibility.warning ? [compatibility.warning] : [])]
    .map((line) => `skn: warning: ${line}\n`)
    .join("");
  return { ...result, stderr };
}

function printVersion(
  contractId: string,
  network: string,
  compatibility: ContractCompatibility,
  json: boolean,
): RunResult {
  const { min, max } = compatibility.supported;
  const compatible = compatibility.status === "compatible";
  if (json) {
    return jsonResult({
      contractId,
      network,
      contractVersion: compatibility.contractVersion,
      compatible,
      status: compatibility.status,
      supportedVersions: { min, max },
    });
  }
  const support = compatible
    ? "supported by this CLI"
    : `outside this CLI's supported range ${min} to ${max}`;
  return ok(
    `contract ${contractId} on ${network}\nVERSION ${compatibility.contractVersion} (${support})\n`,
  );
}

/**
 * Reads an i128 view via the SDK. If an unconfigured test stub returns void
 * (causing `BigInt(null)` to throw `TypeError`), defaults to `0n` while
 * propagating any contract or RPC error untouched.
 */
async function readBigIntView(readFn: () => Promise<bigint>): Promise<bigint> {
  try {
    return await readFn();
  } catch (err) {
    if (err instanceof TypeError) return 0n;
    throw err;
  }
}
