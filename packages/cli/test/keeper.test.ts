import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../src/exitCodes.js";
import { CONTRACT_ID, TEST_PUBLIC, scratchDir } from "./support/env.js";
import { FakeRpc } from "./support/fakeRpc.js";
import { skn } from "./support/run.js";

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await scratchDir());
});
afterEach(async () => {
  await cleanup();
});

const base = ["--contract-id", CONTRACT_ID];
const REPUTATION = { successes: 12n, missed_claims: 1n, score_bps: 9_200, last_updated_ledger: 500 };
const methods = (server: FakeRpc): string[] => server.calls.map((c) => c.method);

describe("skn keeper balance", () => {
  it("shows balance, stake and effective reputation", async () => {
    const server = new FakeRpc({
      results: {
        keeper_balance: 12_345n,
        keeper_stake: 500n,
        pending_unbond: null,
        effective_reputation: REPUTATION,
      },
    });
    const result = await skn(["keeper", "balance", ...base], server, dir);

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("balance:    12345");
    expect(result.stdout).toContain("stake:      500");
    expect(result.stdout).toContain("reputation: 92.00% (12 executed, 1 missed)");
    // The decayed view, not the stored record.
    expect(methods(server)).toContain("effective_reputation");
    expect(methods(server)).not.toContain("keeper_reputation");
    expect(server.submitted).toHaveLength(0);
  });

  it("shows a pending unbond with its wait", async () => {
    const server = new FakeRpc({
      latestLedger: 1_000,
      results: {
        keeper_balance: 0n,
        keeper_stake: 300n,
        pending_unbond: { amount: 200n, unlock_ledger: 1_500 },
        effective_reputation: REPUTATION,
      },
    });
    const result = await skn(["keeper", "balance", ...base], server, dir);
    expect(result.stdout).toContain("unbonding:  200, withdrawable at ledger 1500, in 500 ledgers");
  });

  it("looks up another keeper without needing a signing key", async () => {
    const server = new FakeRpc({
      results: { keeper_balance: 1n, keeper_stake: 0n, pending_unbond: null, effective_reputation: REPUTATION },
    });
    const result = await skn(["keeper", "balance", "--keeper", TEST_PUBLIC, ...base], server, dir, {
      SKN_SECRET_KEY: "",
    });
    expect(result.exitCode).toBe(EXIT.ok);
    expect(server.calls[0]?.args).toEqual([TEST_PUBLIC]);
  });

  it("asks which keeper when there is neither a key nor --keeper", async () => {
    const result = await skn(["keeper", "balance", ...base], new FakeRpc(), dir, { SKN_SECRET_KEY: "" });
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("--keeper");
  });

  it("still shows balance and stake when the reputation view is missing", async () => {
    const server = new FakeRpc({
      results: { keeper_balance: 7n, keeper_stake: 0n, pending_unbond: null },
      simulationErrors: { effective_reputation: "HostError: no such function" },
    });
    const result = await skn(["keeper", "balance", ...base], server, dir);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("balance:    7");
    expect(result.stdout).toContain("reputation: unavailable");
    expect(result.stderr).toContain("could not read reputation");
  });

  it("emits JSON with all three figures", async () => {
    const server = new FakeRpc({
      results: { keeper_balance: 9n, keeper_stake: 4n, pending_unbond: null, effective_reputation: REPUTATION },
    });
    const result = await skn(["keeper", "balance", "--json", ...base], server, dir);
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(body).toMatchObject({
      keeper: TEST_PUBLIC,
      balance: "9",
      stake: "4",
      reputation: { scoreBps: 9_200, successes: 12, missedClaims: 1 },
    });
  });
});

describe("skn keeper withdraw", () => {
  it("reports nothing to withdraw without sending a transaction", async () => {
    const server = new FakeRpc({ results: { keeper_balance: 0n } });
    const result = await skn(["keeper", "withdraw", ...base], server, dir);

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("Nothing to withdraw");
    expect(methods(server)).toEqual(["keeper_balance"]);
    expect(server.submitted).toHaveLength(0);
  });

  it("does not need --confirm-mainnet when there is nothing to send", async () => {
    const server = new FakeRpc({ results: { keeper_balance: 0n } });
    const result = await skn(["keeper", "withdraw", "--network", "mainnet", ...base], server, dir);
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("withdraws a positive balance", async () => {
    const server = new FakeRpc({ results: { keeper_balance: 900n, withdraw_rewards: 900n } });
    const result = await skn(["keeper", "withdraw", ...base], server, dir);

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain(`Withdrew 900 to ${TEST_PUBLIC}`);
    expect(server.submitted).toHaveLength(1);
  });

  it("copes with the balance being drained between the check and the call", async () => {
    const server = new FakeRpc({
      results: { keeper_balance: 900n },
      simulationErrors: { withdraw_rewards: "host invocation failed: Error(Contract, #13)" },
    });
    const result = await skn(["keeper", "withdraw", ...base], server, dir);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("Nothing to withdraw");
  });

  it("emits JSON", async () => {
    const server = new FakeRpc({ results: { keeper_balance: 0n } });
    const result = await skn(["keeper", "withdraw", "--json", ...base], server, dir);
    expect(JSON.parse(result.stdout)).toEqual({ keeper: TEST_PUBLIC, withdrawn: "0" });
  });
});

describe("skn keeper stake and unbond", () => {
  it("deposits stake and reports the new total", async () => {
    const server = new FakeRpc({ results: { keeper_stake: 750n } });
    const result = await skn(["keeper", "stake", "250", ...base], server, dir);

    expect(result.exitCode).toBe(EXIT.ok);
    expect(server.calls[0]).toMatchObject({ method: "stake_deposit", args: [TEST_PUBLIC, 250n] });
    expect(result.stdout).toContain("Bonded stake is now 750");
  });

  it("rejects a zero or fractional amount", async () => {
    for (const amount of ["0", "1.5", "-1"]) {
      const result = await skn(["keeper", "stake", amount, ...base], new FakeRpc(), dir);
      expect(result.exitCode).toBe(EXIT.usage);
    }
  });

  it("prints when the unbonded stake becomes withdrawable", async () => {
    const server = new FakeRpc({
      latestLedger: 1_000,
      results: { pending_unbond: { amount: 200n, unlock_ledger: 87_400 } },
    });
    const result = await skn(["keeper", "unbond", "200", ...base], server, dir);

    expect(result.exitCode).toBe(EXIT.ok);
    expect(server.calls[0]).toMatchObject({ method: "initiate_unbond", args: [TEST_PUBLIC, 200n] });
    expect(result.stdout).toContain("withdrawable at ledger 87400");
    expect(result.stdout).toContain("86400 ledgers (about 5.0 days)");
    const json = await skn(["keeper", "unbond", "200", "--json", ...base], server, dir);
    expect(JSON.parse(json.stdout)).toMatchObject({ unlockLedger: 87_400, ledgersRemaining: 86_400 });
  });
});

describe("skn keeper withdraw-stake", () => {
  it("explains the remaining wait instead of sending a doomed transaction", async () => {
    const server = new FakeRpc({
      latestLedger: 1_000,
      results: { pending_unbond: { amount: 200n, unlock_ledger: 87_400 } },
    });
    const result = await skn(["keeper", "withdraw-stake", ...base], server, dir);

    expect(result.exitCode).toBe(EXIT.contract);
    expect(result.stderr).toContain("UnbondNotReady");
    expect(result.stderr).toContain("ledger 87400");
    expect(result.stderr).toContain("86400 ledgers (about 5.0 days)");
    expect(result.stderr).toContain("Nothing was sent");
    expect(methods(server)).not.toContain("withdraw_stake");
    expect(server.submitted).toHaveLength(0);
  });

  it("withdraws once the unlock ledger is reached, inclusive", async () => {
    const server = new FakeRpc({
      latestLedger: 87_400,
      results: { pending_unbond: { amount: 200n, unlock_ledger: 87_400 }, withdraw_stake: 200n },
    });
    const result = await skn(["keeper", "withdraw-stake", ...base], server, dir);

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain(`Withdrew 200 of stake to ${TEST_PUBLIC}`);
    expect(server.submitted).toHaveLength(1);
  });

  it("says so when there is nothing unbonding", async () => {
    const server = new FakeRpc({ results: { pending_unbond: null } });
    const result = await skn(["keeper", "withdraw-stake", ...base], server, dir);

    expect(result.exitCode).toBe(EXIT.contract);
    expect(result.stderr).toContain("NoPendingUnbond");
    expect(server.submitted).toHaveLength(0);
  });

  it("does not need --confirm-mainnet when it would not send anything", async () => {
    const server = new FakeRpc({
      latestLedger: 1,
      results: { pending_unbond: { amount: 1n, unlock_ledger: 100 } },
    });
    const result = await skn(["keeper", "withdraw-stake", "--network", "mainnet", ...base], server, dir);
    expect(result.stderr).toContain("UnbondNotReady");
    expect(result.stderr).not.toContain("--confirm-mainnet");
  });
});

describe("skn keeper unbonding", () => {
  it("shows the pending request", async () => {
    const server = new FakeRpc({
      latestLedger: 1_000,
      results: { pending_unbond: { amount: 200n, unlock_ledger: 1_500 } },
    });
    const result = await skn(["keeper", "unbonding", ...base], server, dir);
    expect(result.stdout).toContain("200 is unbonding");
    expect(result.stdout).toContain("500 ledgers");
  });

  it("shows nothing pending", async () => {
    const server = new FakeRpc({ results: { pending_unbond: null } });
    const result = await skn(["keeper", "unbonding", "--json", ...base], server, dir);
    expect(JSON.parse(result.stdout)).toEqual({ keeper: TEST_PUBLIC, unbonding: null });
  });
});
