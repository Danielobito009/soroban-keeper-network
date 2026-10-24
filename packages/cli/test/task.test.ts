import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../src/exitCodes.js";
import { CONTRACT_ID, TEST_PUBLIC, TEST_SECRET, scratchDir } from "./support/env.js";
import { FakeRpc } from "./support/fakeRpc.js";
import { rawTask, skn } from "./support/run.js";

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await scratchDir());
});
afterEach(async () => {
  await cleanup();
});

const base = ["--contract-id", CONTRACT_ID];

describe("skn task cancel", () => {
  it("cancels and prints the resulting task state", async () => {
    const server = new FakeRpc({ results: { get_task: rawTask({ status: 3 }) } });
    const result = await skn(["task", "cancel", "7", ...base], server, dir);

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("Cancelled task 7");
    expect(result.stdout).toContain("status:   cancelled");
    expect(server.submitted).toHaveLength(1);
    expect(server.calls[0]).toMatchObject({ method: "cancel_task", args: [TEST_PUBLIC, 7n] });
  });

  it("explains when a claimed task can be cancelled, and submits nothing", async () => {
    const server = new FakeRpc({
      latestLedger: 1_000,
      simulationErrors: { cancel_task: "host invocation failed: Error(Contract, #9)" },
      results: {
        get_task: rawTask({ status: 1, claimer: TEST_PUBLIC, claim_ledger: 900, lock_ledgers: 200 }),
      },
    });
    const result = await skn(["task", "cancel", "7", ...base], server, dir);

    expect(result.exitCode).toBe(EXIT.contract);
    expect(result.stderr).toContain("LockPeriodActive");
    expect(result.stderr).toContain("once its lock lapses");
    // Claimed at 900 with a lock of 200 lapses at 1100, which is 100 ledgers from 1000.
    expect(result.stderr).toContain("ledger 1100");
    expect(result.stderr).toContain("100 ledgers");
    expect(server.submitted).toHaveLength(0);
  });

  it("says the lock has already lapsed when the ledger is past it", async () => {
    const server = new FakeRpc({
      latestLedger: 5_000,
      simulationErrors: { cancel_task: "host invocation failed: Error(Contract, #9)" },
      results: { get_task: rawTask({ status: 1, claimer: TEST_PUBLIC, claim_ledger: 100, lock_ledgers: 50 }) },
    });
    const result = await skn(["task", "cancel", "7", ...base], server, dir);
    expect(result.stderr).toContain("can retry");
  });

  it("reports a task that can never be cancelled", async () => {
    const server = new FakeRpc({
      simulationErrors: { cancel_task: "host invocation failed: Error(Contract, #5)" },
      results: { get_task: rawTask({ status: 2 }) },
    });
    const result = await skn(["task", "cancel", "7", ...base], server, dir);
    expect(result.exitCode).toBe(EXIT.contract);
    expect(result.stderr).toContain("already executed");
  });

  it("gives a machine-readable refusal with --json", async () => {
    const server = new FakeRpc({
      latestLedger: 1_000,
      simulationErrors: { cancel_task: "host invocation failed: Error(Contract, #9)" },
      results: { get_task: rawTask({ status: 1, claimer: TEST_PUBLIC, claim_ledger: 900, lock_ledgers: 200 }) },
    });
    const result = await skn(["task", "cancel", "7", "--json", ...base], server, dir);
    const body = JSON.parse(result.stdout) as { error: { contractError: string; lockedUntilLedger: number } };
    expect(body.error.contractError).toBe("LockPeriodActive");
    expect(body.error.lockedUntilLedger).toBe(1_100);
  });

  it("rejects a bad task id before touching the network", async () => {
    const server = new FakeRpc();
    const result = await skn(["task", "cancel", "seven", ...base], server, dir);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(server.calls).toHaveLength(0);
  });
});

describe("skn task expire", () => {
  it("expires as the signer and prints the state", async () => {
    const server = new FakeRpc({ results: { get_task: rawTask({ status: 4 }) } });
    const result = await skn(["task", "expire", "3", ...base], server, dir);

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("status:   expired");
    expect(server.calls[0]).toMatchObject({ method: "expire_task", args: [3n] });
    expect(server.submitted).toHaveLength(1);
  });

  it("explains a refusal using the contract's own error table", async () => {
    const server = new FakeRpc({
      simulationErrors: { expire_task: "host invocation failed: Error(Contract, #7)" },
    });
    const result = await skn(["task", "expire", "3", ...base], server, dir);
    expect(result.exitCode).toBe(EXIT.contract);
    expect(result.stderr).toContain("DeadlineNotPassed");
  });
});

describe("skn task increase-reward", () => {
  it("adds to the reward and prints the state", async () => {
    const server = new FakeRpc({ results: { get_task: rawTask({ reward: 5_000_250n }) } });
    const result = await skn(["task", "increase-reward", "7", "--by", "250", ...base], server, dir);

    expect(result.exitCode).toBe(EXIT.ok);
    expect(server.calls[0]).toMatchObject({ method: "increase_reward", args: [TEST_PUBLIC, 7n, 250n] });
    expect(result.stdout).toContain("reward:   5000250");
  });

  it("insists on a positive whole-number amount", async () => {
    for (const by of ["1.5", "0", "-3"]) {
      const result = await skn(["task", "increase-reward", "7", "--by", by, ...base], new FakeRpc(), dir);
      expect(result.exitCode).toBe(EXIT.usage);
    }
  });
});

describe("skn task extend-deadline", () => {
  it("accepts an ISO time and passes Unix seconds to the contract", async () => {
    const server = new FakeRpc({ results: { get_task: rawTask() } });
    const result = await skn(
      ["task", "extend-deadline", "7", "--to", "2031-01-01T00:00:00Z", ...base],
      server,
      dir,
    );
    expect(result.exitCode).toBe(EXIT.ok);
    expect(server.calls[0]).toMatchObject({
      method: "extend_deadline",
      args: [TEST_PUBLIC, 7n, 1_924_992_000n],
    });
  });

  it("rejects a time it cannot read", async () => {
    const result = await skn(["task", "extend-deadline", "7", "--to", "someday", ...base], new FakeRpc(), dir);
    expect(result.exitCode).toBe(EXIT.usage);
  });
});

describe("skn task register", () => {
  it("registers as the signer and prints the new task", async () => {
    const server = new FakeRpc({ results: { register_task: 12n, get_task: rawTask() } });
    const result = await skn(
      [
        "task", "register", "--type", "oracle-price-push", "--reward", "5000000",
        "--deadline", "2031-01-01T00:00:00Z", "--ttl-ledgers", "17280", "--lock-ledgers", "100",
        "--calldata", "0a1b", ...base,
      ],
      server,
      dir,
    );
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("Registered task 12");
    expect(server.calls[0]?.method).toBe("register_task");
    expect(server.calls[0]?.args[0]).toBe(TEST_PUBLIC);
  });

  it("lists the valid types for an unknown one", async () => {
    const result = await skn(
      ["task", "register", "--type", "nope", "--reward", "1", "--deadline", "1900000000",
        "--ttl-ledgers", "1", "--lock-ledgers", "1", ...base],
      new FakeRpc(),
      dir,
    );
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("Liquidation");
  });
});

describe("shared behaviour of task commands", () => {
  it("prints one JSON document with --json", async () => {
    const server = new FakeRpc({ results: { get_task: rawTask({ status: 4 }) } });
    const result = await skn(["task", "expire", "3", "--json", ...base], server, dir);
    const body = JSON.parse(result.stdout) as { action: string; task: { id: string; status: string } };
    expect(body.action).toBe("expire");
    expect(body.task).toMatchObject({ id: "3", status: "expired" });
  });

  it("asks for a signing key and sends nothing without one", async () => {
    const server = new FakeRpc();
    const result = await skn(["task", "cancel", "7", ...base], server, dir, { SKN_SECRET_KEY: "" });
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("no signing key");
    expect(server.calls).toHaveLength(0);
  });

  it("refuses to send on mainnet without --confirm-mainnet", async () => {
    const server = new FakeRpc();
    const result = await skn(["task", "cancel", "7", "--network", "mainnet", ...base], server, dir);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("--confirm-mainnet");
    expect(server.submitted).toHaveLength(0);
  });

  it("never prints the signing key, even for a malformed one", async () => {
    const bad = `${TEST_SECRET.slice(0, 40)}XXXX`;
    const result = await skn(["task", "cancel", "7", ...base], new FakeRpc(), dir, { SKN_SECRET_KEY: bad });
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stdout + result.stderr).not.toContain(bad);
    expect(result.stdout + result.stderr).not.toContain(TEST_SECRET.slice(0, 20));
  });

  it("names the available commands for an unknown one", async () => {
    const result = await skn(["task", "frobnicate"], new FakeRpc(), dir);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("cancel");
  });
});
