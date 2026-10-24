import { homedir } from "node:os";
import { SUPPORTED_CONTRACT_VERSIONS, type RpcServerLike } from "@soroban-keeper-network/sdk";
import { configPath } from "./config.js";
import { type CommandContext } from "./args.js";
import { runAdminCommand } from "./commands/admin/index.js";
import { runBatchRegister } from "./commands/batch/register.js";
import { runConfigInit, runConfigShow } from "./commands/config.js";
import { runDeploy } from "./commands/deploy.js";
import { runInspect, runInspectVersion } from "./commands/inspect.js";
import { runKeeperCommand } from "./commands/keeper/index.js";
import { runTaskCommand } from "./commands/task/index.js";
import type { ConfirmFn } from "./confirm.js";
import { commandError } from "./failures.js";
import { ok, usage, type RunResult } from "./output.js";
import { CLI_VERSION } from "./version.js";

export type { RunResult } from "./output.js";

export interface RunOptions {
  /**
   * RPC server to use instead of connecting to `--rpc-url`. Tests inject the
   * SDK's fake RPC through this seam; the bin never sets it.
   */
  server?: RpcServerLike | undefined;
  /** Environment for `SKN_CONFIG` and `SKN_SECRET_KEY`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Home directory for the config file and Stellar identities. Defaults to the OS home. */
  homeDir?: string | undefined;
  /** Platform for the key-file permission check. Defaults to `process.platform`. */
  platform?: NodeJS.Platform | undefined;
  /** Asks the user to confirm a transaction. The bin provides one when stdin is a terminal. */
  confirm?: ConfirmFn | undefined;
  /** Clock in Unix seconds, for deadline validation. Defaults to the system clock. */
  now?: (() => number) | undefined;
}

/** Command groups from `docs/CLI_DESIGN.md`. Each one appears in help. */
export const COMMAND_GROUPS = [
  "config",
  "task",
  "keeper",
  "admin",
  "batch",
  "deploy",
  "events",
  "inspect",
] as const;

export const HELP_TEXT = `skn ${CLI_VERSION}: command-line tool for the Soroban Keeper Network

Usage:
  skn <group> [command] [flags]
  skn --help | --version

Command groups:
  config    init | show: manage the config file and named profiles
  task      register | cancel | expire | increase-reward | extend-deadline (show, list, claim, execute: not yet)
  keeper    balance | withdraw | stake | unbond | withdraw-stake | unbonding
  admin     pause | unpause | set-fee-bps | set-min-reward | set-min-stake | set-dispute-window | sweep-fees
  batch     register: batch task registration from JSON or CSV
  deploy    registry | treasury | all: upload WASM, deploy and initialize contracts
  events    watch contract events
  inspect   [summary | version]: print protocol state and SDK compatibility

Global flags (accepted by every command):
  --profile <name>                       named profile from the config file
  --network <testnet|futurenet|mainnet>  network preset (default: the profile's, else testnet)
  --rpc-url <url>                        override the preset's RPC URL
  --contract-id <id>                     keeper-registry contract ID
  --treasury-contract-id <id>            treasury contract ID
  --key-file <path>                      read the signing key from a file (must not be readable by others)
  --identity <name>                      read the signing key from a Stellar CLI identity
  --confirm-mainnet                      required to send a transaction on mainnet
  --json                                 print machine-readable JSON

Signing key precedence: --key-file, then --identity, then SKN_SECRET_KEY.
Config file: SKN_CONFIG, or ~/.config/skn/skn.config.json.

Exit codes:
  0 success     1 internal error   2 usage error
  3 RPC error   4 contract error   5 not found
`;

/**
 * Runs `skn` with the given arguments (without the node and script path) and
 * returns what it would print and the exit code. Never throws and never calls
 * `process.exit`, so the bin and the tests share one code path.
 */
export async function run(argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const json = argv.includes("--json");
  const [first, second] = argv;

  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    return ok(HELP_TEXT);
  }
  if (first === "--version" || first === "-v") {
    const { min, max } = SUPPORTED_CONTRACT_VERSIONS;
    return ok(`skn ${CLI_VERSION}\nsupported contract VERSION: ${min} to ${max}\n`);
  }
  if (!isCommandGroup(first)) {
    return usage(`unknown command '${first}'`, json);
  }

  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const context: CommandContext = {
    server: options.server,
    env,
    homeDir,
    platform: options.platform ?? process.platform,
    configFile: configPath(env, homeDir),
  };
  const rest = argv.slice(2);

  try {
    if (first === "config" && second === "init") return await runConfigInit(rest, context);
    if (first === "config" && second === "show") return await runConfigShow(rest, context);

    if (first === "inspect") {
      if (second === undefined || second.startsWith("-")) {
        return await runInspect(argv.slice(1), context);
      }
      if (second === "summary") {
        return await runInspect(rest, context);
      }
      if (second === "version") {
        return await runInspectVersion(rest, context);
      }
      return usage(`unknown inspect command '${second}'; expected summary or version`, json);
    }

    if (first === "admin") {
      return await runAdminCommand(second, rest, context, { confirm: options.confirm });
    }

    if (first === "batch") {
      if (second === "register") {
        return await runBatchRegister(rest, context, { now: options.now });
      }
      if (second === undefined || second.startsWith("-")) {
        return usage("'skn batch' needs a command (for example 'skn batch register <file>')", json);
      }
      return usage(`'skn batch ${second}' is not implemented yet`, json);
    }

    if (first === "task") {
      return await runTaskCommand(second, rest, context);
    }

    if (first === "keeper") {
      return await runKeeperCommand(second, rest, context);
    }

    if (first === "deploy") {
      return await runDeploy(second, rest, context, { confirm: options.confirm });
    }
  } catch (err) {
    return commandError(err, json);
  }

  if (second === undefined || second.startsWith("-")) {
    return usage(`'skn ${first}' needs a command`, json);
  }
  return usage(`'skn ${first} ${second}' is not implemented yet`, json);
}

function isCommandGroup(value: string): value is (typeof COMMAND_GROUPS)[number] {
  return (COMMAND_GROUPS as readonly string[]).includes(value);
}
