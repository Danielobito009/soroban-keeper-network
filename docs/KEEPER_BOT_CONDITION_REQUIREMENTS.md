# Keeper-Bot Condition-Aware Task Selection Requirements

**Scope:** Requirements for keeper-bot task-selection logic (Epic E15) to factor in condition resource costs when deciding whether to claim a task.

**Related Documentation:**
- [TASK_CONDITIONS_DESIGN.md](TASK_CONDITIONS_DESIGN.md) — design and resource-cost analysis (§3.4 contains the source requirements this document summarizes).
- [KEEPER_BOT_V2_DESIGN.md](KEEPER_BOT_V2_DESIGN.md) — overall bot V2 architecture.

---

## Overview

When a task carries an optional `condition` (E10 feature), the claiming keeper's transaction must execute a cross-contract call to evaluate `ITaskCondition::is_ready(task_id)`. This check is mandatory before claiming and incurs a resource cost borne entirely by the claiming keeper.

Since:
1. **No Soroban sub-call budget cap exists** — a malicious or expensive condition can consume far more gas than anticipated,
2. **Every claim attempt triggers the check** — unlike verifiers (which only run once per claimed task), conditions run once per claim *attempt*, potentially costing many keepers money if the condition is expensive and never becomes true,
3. **Keepers can estimate this cost pre-claim** via `simulateTransaction` on the condition contract,

Keeper bots must implement condition-aware filtering logic to avoid griefing and maximize profitability.

---

## Core Requirements

### R1: Task Metadata Discovery

**On receiving a `TaskRegistered` event:**

1. Fetch the full task via `get_task(task_id)`.
2. Extract `task.condition` (an `Option<Address>`).
3. If `None`, treat the task as having no condition (unchanged baseline behavior).
4. If `Some(condition_address)`, proceed to R2.

### R2: Condition Vetting

**Before attempting to claim, classify the condition contract:**

1. **Known-Safe Allowlist Lookup:**
   - Maintain a local registry (file, database, or config) of trusted condition contracts with **benchmarked gas costs**.
   - Example structure:
     ```
     {
       "conditions": {
         "CBDJ_PRICE_THRESHOLD": { "name": "Price > X", "base_cpu": 50000, "base_mem": 8192 },
         "CBDJ_TIMESTAMP_CHECK": { "name": "After time T", "base_cpu": 20000, "base_mem": 2048 }
       }
     }
     ```
   - If `condition_address` exists in allowlist, record its baseline cost and proceed to R3 (skip simulation).
   - If unknown, mark the task as requiring pre-claim simulation (proceed to R3) or apply stricter validation (see R2.b).

2. **Risk Stratification (Unknown Conditions):**
   - **High Risk:** Treat an unknown condition as untrusted unless:
     - The task reward is **≥ 3x the estimated condition gas cost** (conservative multiplier for unknown contracts), OR
     - The condition address is explicitly allowlisted in a secondary "experimental" list with human review, OR
     - The bot is configured to skip unknown conditions entirely (recommended default).
   - **Strategy:** If a task has an unknown condition, either skip it or require a significantly higher reward margin to offset the risk.

### R3: Pre-Claim Condition Simulation

**Before submitting a real `claim_task` transaction:**

1. **Simulate the condition evaluation:**
   ```
   GET /simulateTransaction
   Body: {
     "transaction": XDR(call ITaskCondition::is_ready(task_id)),
     "resourceLeeway": 0  // optional: estimate exact cost
   }
   ```

2. **Record the simulated results:**
   - Boolean outcome: `is_ready` returns `true` or `false`.
   - Resource usage: `cpuInsns`, `memBytes`, `minResourceFee`.
   - Actual cost in XLM stroops: `minResourceFee`.

3. **Decision tree:**
   ```
   if simulated_is_ready == false:
       // Condition not currently satisfied
       do_not_claim()
       re_queue_for_later_check()
       return

   if simulated_cpu_cost > COST_THRESHOLD:  // e.g., 500k CPU (50% of max tx budget)
       log("Condition too expensive: $CPU insns")
       mark_as_high_risk()
       if reward >= 3x_estimated_cost:
           proceed_to_R4()  // marginally profitable but risky
       else:
           do_not_claim()
       return

   if simulated_panicked or timed_out:
       log("Condition simulation failed: $ERROR")
       mark_as_broken_or_malicious()
       do_not_claim()
       return

   // Condition looks good
   proceed_to_R4()
   ```

### R4: Profitability Calculation

**After confirming the condition is ready and not too expensive:**

1. **Calculate total claim cost:**
   ```
   claim_cost = (
       base_claim_tx_gas +
       condition_simulated_gas +
       margin_for_network_variation
   ) * xendf_price_per_stroops
   ```

2. **Verify profitability:**
   ```
   if task.reward >= claim_cost + off_chain_execution_cost + keeper_profit_margin:
       proceed_to_claim()
   else:
       do_not_claim()  // Task not profitable even after condition check
   ```

3. **Off-Chain Execution Cost Estimate:**
   - Keeper bot should have a configured estimate or actual benchmark for the work the task will trigger (e.g., liquidation call cost, price push cost, etc.).
   - Add this to the total before comparing against reward.

### R5: Claim Submission & Failure Handling

**If the real `claim_task` transaction is submitted:**

1. **Success case:** Task is claimed. Proceed with normal execution logic.

2. **Failure case: `ConditionCheckFailed` error:**
   - The condition returned `false` or panicked in the real tx (despite passing simulation).
   - Update the bot's condition cost model:
     - If actual cost was significantly higher than simulated, flag for review.
     - If outcome changed (was `true` in simulation but `false` in real tx), log as a race condition — re-queue for immediate retry.
   - Decision:
     - Retry immediately if this looks like a transient false positive.
     - Skip the task for a configurable duration (e.g., 5 minutes) if condition is flaky.
     - Never claim again if the condition address is marked as malicious/broken.

3. **Other failures:** Handle as normal (e.g., network error, insufficient balance) — not condition-specific.

---

## Operational Configuration

Keeper bots should expose the following configuration parameters:

### Global Condition Settings

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `CONDITION_COST_THRESHOLD` | 500,000 | Max CPU insns allowed for a condition check (50% of typical tx budget) |
| `CONDITION_REWARD_MULTIPLIER_UNKNOWN` | 3.0 | Required reward multiplier for unknown conditions (reward ≥ 3x cost) |
| `CONDITION_REWARD_MULTIPLIER_KNOWN` | 1.5 | Required reward multiplier for known/allowlisted conditions |
| `CONDITION_SKIP_UNKNOWN` | true | If true, skip any task with an unknown condition entirely |
| `CONDITION_ALLOWLIST_PATH` | `./conditions.json` | Path to known-safe condition registry with benchmarked costs |

### Per-Task Overrides

Bots can optionally support per-task condition policies via config:

```json
{
  "task_overrides": {
    "CDOME_TASK_ID_123": {
      "condition_skip": true,
      "reason": "Known broken condition, owner informed"
    }
  }
}
```

---

## Example: Complete Workflow

```
1. Bot receives TaskRegistered event for task_id = 42
   └─ Fetch task via get_task(42)
   └─ task.condition = Some("CBDJ_ORACLE_CHECK")

2. Classify condition
   └─ Lookup "CBDJ_ORACLE_CHECK" in allowlist
   └─ Found: baseline_cost = 120,000 CPU, known_safe = true

3. Simulate condition (optional for known, but recommended)
   └─ simulateTransaction(is_ready(42)) on CBDJ_ORACLE_CHECK
   └─ Simulated result: is_ready = true, cpuInsns = 125,000

4. Verify cost threshold
   └─ 125,000 CPU < 500,000 threshold ✓

5. Calculate profitability
   └─ task.reward = 1,000,000 stroops
   └─ claim_cost = (base_claim_gas + 125k CPU) * $price = ~200k stroops
   └─ off_chain_cost = liquidation tx ≈ 300k stroops
   └─ total_cost = 500k, margin = 100k
   └─ required = 600k, actual_reward = 1,000,000 ✓

6. Submit claim_task(42)
   └─ On-chain condition check runs (should be similar to simulation)
   └─ Tx succeeds, task is claimed
   └─ Bot proceeds to execute_task workflow

7. Log successful claim and update condition cost model
   └─ "CBDJ_ORACLE_CHECK": actual_cost = 124,000 CPU (close to sim)
```

---

## Reference: Condition Interface

For context, the condition interface is defined in [TASK_CONDITIONS_DESIGN.md](TASK_CONDITIONS_DESIGN.md) §1:

```rust
pub trait ITaskCondition {
    fn is_ready(env: Env, task_id: u64) -> bool;
}
```

- Returns `true` if the underlying condition is satisfied, `false` otherwise.
- Must not panic on a merely-false condition — return `false`.
- Panics are caught by the registry and mapped to `ConditionCheckFailed` error.

---

## Reference: Known-Safe Condition Catalog

This section will be populated as reference conditions are implemented and benchmarked. Current placeholders:

- **PriceThresholdCondition:** Simple price oracle comparison (planned E10 issue 0397).
- **TimestampCondition:** Current time > deadline (simple arithmetic).
- **CustomBusinessLogicCondition:** dApp-specific conditions (user-provided, requires simulation).

See [VERIFIERS.md](VERIFIERS.md) for the analogous reference verifier catalog (E04). Conditions follow a similar pattern.

---

## Related Epic: E15 (Keeper Bot V2)

This document captures the condition-specific subset of E15's broader task-selection logic. E15 also covers:
- Multi-account support and concurrent task processing.
- General profitability checks (independent of conditions).
- Fee market adaptation and transaction prioritization.
- Indexer integration for event discovery.

See [KEEPER_BOT_V2_DESIGN.md](KEEPER_BOT_V2_DESIGN.md) for the full scope.

---

## Design Rationale

### Why simulate pre-claim?

Because `claim_task` requires a `Pending` task (no precondition of `Claimed` status), it can be safely simulated against the on-chain task state. A verifier check (E04), by contrast, requires a `Claimed` task and cannot be simulated until after claiming — that's why verifier cost estimation is harder. Conditions are cheaper to vet pre-claim.

### Why reject expensive conditions?

An expensive condition that returns `false` (or a condition that repeatedly oscillates between `true` and `false`) could become a grief vector: every keeper who attempts to claim pays the high gas cost and fails. By requiring either:
- Allowlist membership, or
- High reward multiplier (3x cost), or
- Explicit bot configuration,

we ensure that expensive conditions are either trusted (allowlisted) or sufficiently rewarded to justify the risk.

### Why distinguish known vs. unknown?

Known, allowlisted conditions have been benchmarked and reviewed. Trusting them with a lower reward multiplier (1.5x) is economically sensible. Unknown conditions are untrusted until proven otherwise, requiring either:
- Higher reward (3x) to justify the risk, or
- Explicit skip.

This mirrors how security researchers approach supply-chain auditing: trust known, audit unknowns.

---

## Future Enhancements

Potential future E15 or follow-up epics could extend this with:

1. **Condition performance monitoring:** Track actual vs. simulated costs over time; auto-downgrade high-variance conditions.
2. **Condition reputation scoring:** Similar to keeper reputation (E07), score conditions on reliability and gas efficiency.
3. **Composite conditions:** A single task with multiple independent condition checks (AND/OR logic).
4. **Conditional task composition:** Chain multiple tasks' conditions and outcomes as a DAG.

---

## Summary Checklist

A keeper bot claiming condition-attached tasks must:

- [ ] Fetch task metadata and extract `task.condition` address.
- [ ] Classify the condition as known/unknown/allowlisted.
- [ ] Simulate `ITaskCondition::is_ready(task_id)` pre-claim to confirm:
  - Condition returns `true` (work is ready).
  - Estimated CPU cost is below threshold (not a griefing vector).
  - Simulation does not panic or time out (not broken/malicious).
- [ ] Calculate total claim cost including the simulated condition gas.
- [ ] Verify task reward ≥ total cost + profit margin before claiming.
- [ ] Handle `ConditionCheckFailed` errors gracefully on tx failure.
- [ ] Log and monitor condition performance; update cost models based on actual vs. simulated deltas.

