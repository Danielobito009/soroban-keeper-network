import { join } from "node:path";
import { run, type RunOptions } from "../../src/cli.js";
import type { RunResult } from "../../src/output.js";
import { TEST_PUBLIC, TEST_SECRET } from "./env.js";
import type { FakeRpc } from "./fakeRpc.js";

/** Runs `skn` against a fake RPC server, signing as TEST_KEYPAIR unless told otherwise. */
export function sknOptions(server: FakeRpc, dir: string, env: Record<string, string> = {}): RunOptions {
  return {
    server,
    env: { SKN_CONFIG: join(dir, "skn.config.json"), SKN_SECRET_KEY: TEST_SECRET, ...env },
    homeDir: dir,
    platform: "linux",
  };
}

export function skn(
  argv: string[],
  server: FakeRpc,
  dir: string,
  env: Record<string, string> = {},
): Promise<RunResult> {
  return run(argv, sknOptions(server, dir, env));
}

export { TEST_PUBLIC };

/** The contract's `Task` struct as the fake RPC returns it. */
export function rawTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    owner: TEST_PUBLIC,
    task_type: 0,
    calldata: new Uint8Array([1, 2]),
    reward: 5_000_000n,
    deadline: 1_900_000_000n,
    ttl_ledgers: 17_280,
    status: 0,
    claimer: undefined,
    claim_ledger: undefined,
    lock_ledgers: 100,
    ...overrides,
  };
}
