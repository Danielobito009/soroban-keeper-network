# Task Conditions Design (E10)

This is the design document for task-attached conditions — on-chain predicates that gate claiming, answering whether an off-chain condition (e.g., a price crossing a threshold, a position becoming liquidatable) is actually true before a keeper commits to work.

**Status: core slice design**. This document establishes the architecture and resource-cost decisions that implementation issues 0391–0404 will execute against.

## Context

### E10 vs E04 (Verifiers): Two Distinct Mechanisms

**E04 (Verifiers)** — never implemented — designed an optional on-chain verification callback that runs *after* `execute_task`, checking a keeper-submitted proof against task-specific criteria. Its failure mode: a verifier can reject an execution or panic, leaving the task `Claimed` but not `Executed`, allowing retry or fallback to expiry.

**E10 (Conditions)** — this epic — is a different mechanism: an optional on-chain predicate that runs *before* `claim_task`, evaluating whether a task's underlying reason for existing (the condition it exists to react to) is true right now. Its failure mode: a false condition prevents claiming entirely, leaving the task `Pending` and retryable by any keeper once the condition later becomes true.

**Why they coexist:** A condition answers "should we attempt this task?" (gating the claim). A verifier answers "did we execute it correctly?" (gating the reward). A task owner can attach either, both, or neither:

- **No condition, no verifier:** today's MVP behavior — keeper claims freely and submits a proof; reward if trusted.
- **Condition only:** keeper must check the condition evaluates true before claiming; once claimed and executed, proof is trusted (no further verification).
- **Verifier only:** keeper can claim freely (no condition check); on execution, the verifier gate ensures the proof is valid before crediting the keeper.
- **Both:** keeper must pass the condition gate to claim, and the verifier gate to get paid.

The two decisions — condition choice (owner-set, claim-time check) and verifier choice (owner-set, execution-time check) — are orthogonal and non-interfering.

## 1. Interface shape

```rust
/// Implemented by any contract a task owner wants to use as a condition check.
/// Registered per-task via `register_task`'s optional `condition` parameter.
pub trait ITaskCondition {
    /// Returns `true` if the condition that triggered the need for this task
    /// is currently satisfied, `false` otherwise.
    ///
    /// Must not panic on a merely-false condition — return `false`. A panic
    /// is reserved for the condition being fundamentally broken (see §2),
    /// and `claim_task` treats it as equivalent to `false` regardless.
    fn is_ready(env: Env, task_id: u64) -> bool;
}
```

**Why `task_id` only, no keeper?** Unlike E04's verifier (which needed the keeper to bind a proof to the specific claimer), a condition is asking "is the underlying work ready?" — a purely objective question about the task's trigger, independent of who will claim it. Passing `task_id` alone is sufficient and keeps the interface minimal.

**No return-value error detail.** `is_ready` returns a plain `bool`, not a `Result` with a typed reason. A condition that wants to communicate diagnostic info (for debugging) should emit its own event before returning `false` — the registry's `ConditionCheckFailed` event (§8) intentionally does not relay condition-specific diagnostics.

## 2. Failure semantics

**If the condition call panics, `claim_task` catches it and returns a typed error rather than reverting the whole transaction.**

Soroban's `Env::try_invoke_contract` catches a callee panic and surfaces it as a `Result` to the caller, as opposed to `Env::invoke_contract`, which propagates the panic and aborts the calling transaction. `claim_task` uses `try_invoke_contract`, mapping any panic *or* an explicit `false` return to the same outcome: the claim attempt fails with `KeeperError::ConditionCheckFailed`, task state is unchanged (still `Pending`, unclaimed — enforced the same way every other rejection path in `claim_task` already works), and any keeper is free to retry once the condition later becomes true.

**Rationale for panic absorption:** A panicking condition is a severity-1 failure. If we propagated the panic (aborting the whole transaction), every claim attempt against that task would fail forever until the deadline (or owner manually cancels), making the task permanently unclaimable. By catching the panic and returning a typed error, keepers retain every existing recovery path: they can retry immediately (the task remains `Pending`), or wait for the deadline and call `expire_task` to recover escrow for the owner. This is strictly more forgiving than a panic abort.

## 3. Resource budget

**No in-contract budget ceiling can be reserved or enforced for the condition sub-call; the whole transaction's resource footprint (set by whoever submits it) is the only limit. The calling keeper bears the full resource cost of the attached condition.**

### 3.1 Investigation: In-band sub-call budget capping in Soroban

We investigated whether Soroban currently exposes any host function, SDK primitive, or transaction mechanism allowing a caller contract to bound or cap the gas/CPU/memory/storage resources consumed by an individual cross-contract sub-call (distinct from the transaction's overall resource limit).

**Conclusion: No such mechanism exists in Soroban today.** (This is identical to the conclusion E04's issue 0076 would have reached; the investigation was conducted for both epics to confirm the current state of Soroban's host.)

*Evidence & Technical Constraints:*
1. **Host invocation model:** In Soroban, cross-contract calls dispatched via `Env::invoke_contract` or `Env::try_invoke_contract` execute synchronously within the host environment sharing the active transaction's monolithic execution budget (`Budget`). The host meters instruction counters and memory allocations globally against the transaction envelope.
2. **SDK Budget types:** The `soroban_sdk::Env::cost_estimate().budget()` and `Budget` interfaces exist exclusively under `testutils` for local measurement and harness assertions. They are not compiled into the on-chain WASM guest environment and provide no runtime controls to meter or restrict callees.
3. **No gas/stipend forwarding parameter:** Unlike Ethereum's EVM (which allows passing explicit gas stipends to sub-calls, e.g. `call{gas: g}()`), Soroban's host invocation interface does not take a gas limit parameter.
4. **All-or-nothing resource metering:** If a condition's execution exceeds the transaction's configured resource limits or ledger network limits, the entire host invocation runs out of budget, resulting in a transaction-level failure. The condition cannot be throttled or halted mid-execution to protect the caller's remaining budget.

### 3.2 Economic impact: Who bears the cost?

Because the condition check is a cross-contract call executed as part of `claim_task`, **the claiming keeper bears the entire transaction fee and resource cost** incurred by running whatever condition contract the task owner attached.

An expensive or intentionally resource-intensive condition directly increases the CPU instructions and memory footprint charged to the keeper's `claim_task` transaction. If a keeper does not pre-inspect or simulate the condition, they may discover after submission that the claim cost far exceeds their expectation, turning what looked like a profitable task into a net loss.

**This is strictly *worse* than E04's analogous verifier risk.** With verifiers, an expensive check happened only on `execute_task` (after the keeper had already started work and committed to a claim lock). With conditions, the expensive check happens on every `claim_task` attempt, by any keeper, before they've even locked the task. A malicious task owner could attach an intentionally expensive condition to grief claiming keepers repeatedly.

### 3.3 Keeper bot cost estimation & Simulation ordering (Pre-claim vs. Post-claim)

To make an informed profitability decision, a keeper bot must be able to estimate the condition check resource footprint **before claiming** a task.

#### Simulation via `simulateTransaction`
Soroban RPC's `simulateTransaction` endpoint evaluates a contract invocation against current ledger state and returns exact estimated resource usage (`minResourceFee`, `cpuInsns`, `memBytes`, and read/write footprints).

#### The Pre-Claim Simulation Strategy
Unlike `execute_task` (which requires a `Claimed` precondition and is therefore not simulable until after a claim), `claim_task` can be simulated against a `Pending` task *if and only if* the simulation happens at ledger time ≤ (condition's evaluation ledger). Since conditions are typically fast checks (price crosses threshold, timestamp is past X), this is usually satisfied.

**Recommended Keeper-Bot Strategy:**
1. **Direct Condition Simulation (Pre-claim estimation):**
   Before committing to `claim_task`, the keeper bot knows:
   - `task_id`
   - the attached `condition` address (retrieved via `get_task`)
   
   If `task.condition` is `Some(condition_address)`, the bot can issue a `simulateTransaction` call directly to `ITaskCondition::is_ready(task_id)` on the condition contract. This yields the condition's isolated resource consumption and outcome (true or false) before the bot submits a real `claim_task` transaction.

2. **Known Condition Baselines / Catalog:**
   For standard reference conditions (e.g., simple price-threshold checks, timestamp comparisons — similar to the reference verifiers planned in E04 issues 0077–0079), the bot can refer to benchmarked gas deltas to compute an immediate heuristic cost without an extra simulation round-trip.

3. **Reject Expensive or Failing Conditions:**
   If a simulation shows:
   - The condition check costs more than a specified gas threshold (e.g., half the expected task reward), skip the task.
   - The condition returns `false`, do not claim (task is not ready yet); the bot can re-queue and check again later.
   - The condition times out or panics during simulation, treat it as high-risk and skip.

4. **Full Transaction Simulation (Post-Condition Check):**
   After confirming the condition check is fast and returns `true`, the bot can simulate the full `claim_task` transaction (including its condition sub-call) to finalize the fee bid and ensure no other surprises before broadcast.

### 3.4 Requirements Handoff to E15 (Keeper-Bot Task Selection)

E15's keeper-bot task-selection logic (epic E15, issue #0091 or its successor) must implement the following requirements based on these findings:

**On Task Discovery (TaskRegistered event):**
1. Fetch full task info via `get_task`.
2. If `condition` is present:
   - Retrieve the condition address.
   - Query off-chain allowlist/catalog of known-safe conditions and their baseline costs.
   - If the condition is unknown, mark the task as requiring pre-claim simulation or skip it.

**Pre-Claim Phase (Before Submitting `claim_task`):**
1. **Condition Check Simulation:**
   - If `task.condition` is `Some(addr)`, simulate `ITaskCondition::is_ready(task_id)`.
   - Record the simulated resource cost and boolean outcome.
   - If outcome is `false`, do not claim; re-check later.
   - If outcome is `true`, proceed to the next step.

2. **Cost Assessment:**
   - Sum the estimated `claim_task` base cost + condition simulation cost.
   - Verify: `Expected Reward ≥ Estimated Claim Cost + Off-chain Execution Cost + Profit Margin`.
   - If the condition check alone costs > 50% of the task reward (configurable threshold), skip or mark as high-risk.

3. **Untrusted Condition Policy:**
   - If a condition is unknown, costly, or fails simulation, apply a conservative heuristic:
     - Require explicit allowlist membership, or
     - Require a lower-bound reward multiplier (e.g., 3x the estimated gas cost vs. 1.5x for known conditions), or
     - Skip the task entirely.

**Post-Claim Recovery:**
- If a real `claim_task` tx is submitted and fails with `ConditionCheckFailed`, the bot should:
  - Log the failure with the task ID and condition address.
  - Update its local condition-cost model (the actual cost was higher or lower than simulated).
  - Decide whether to retry or mark the task as problematic for this bot.

## 4. Attachment timing

**A condition is chosen at `register_task` time and is immutable once a keeper has claimed the task (consistent with E04's verifier timing); the owner may still change it while the task is `Pending`.**

Rationale: a keeper decides whether a task is worth claiming partly based on the condition's cost and satisfaction likelihood. Locking the condition at claim time (per E04's issue 0082 pattern) prevents an owner from griefing a keeper by swapping in an impossible-to-satisfy condition post-claim. Allowing changes pre-claim keeps it consistent with every other owner-adjustable field (`increase_reward`, `extend_deadline` already work this way).

## 5. Trust model: Permissionless Execution Path

**The core registry allows any address implementing `ITaskCondition` to be attached at `register_task`. There is no admin allow-list or approval gate in the baseline design.**

Rationale: consistent with the protocol's permissionless philosophy (docs/ARCHITECTURE.md), the registry does not gate participation. Any dApp or user can register a task with a custom condition. This keeps the execution hot path simple and efficient.

**Advisory curated registry (future extension):** Similar to E04 issue 0092, an optional follow-up can expose an admin-curated list of vetted conditions for keeper bots and UIs to reference as a trust signal. This is strictly an off-chain advisory tool and does not gate `claim_task` execution.

## 6. Backward compatibility

**A task with no condition attached behaves identically to every existing task today.** `claim_task` performs the condition call only when `Task.condition` is `Some(_)`; when it's `None`, claiming proceeds exactly as it does on `main` right now, with no additional call, no additional gas cost, and no behavior change. Existing tasks registered before this epic ships have no `condition` field populated (backward-compatible storage migration: `Task.condition: Option<Address>` defaults to `None` for any task read that predates this field). Any dApp integration written against the current ABI continues to work with zero changes required — attaching a condition is opt-in per task, not a new required parameter with no default.

## 7. Interface specification summary

| Item | Value |
|------|-------|
| **Trait Name** | `ITaskCondition` |
| **Method** | `is_ready(env: Env, task_id: u64) -> bool` |
| **Panic Semantics** | Caught; treated as `false`; claim rejected with `ConditionCheckFailed`, task remains `Pending` |
| **Entry Point Affected** | `claim_task` — condition is checked before state mutation |
| **Resource Model** | Caller (claiming keeper) bears full cost; no sub-call budget cap available in Soroban today |
| **Storage Field** | `Task.condition: Option<Address>` |
| **Entry Point Signature Change** | `register_task` gains `condition: Option<Address>` parameter |
| **Immutability** | Condition is locked once task is claimed (per issue 0082 pattern) |
| **Backward Compat** | `None` path is unchanged; zero added cost when absent |

## 8. Events

**New event: `ConditionCheckFailed`**

Emitted when a condition check returns `false` or panics. Allows off-chain observers to track why a claim attempt failed.

```
Topic: ("cond_fail", task_id)
Fields: (task_id: u64, claimer: Address, reason: u32)
  - reason = 0: condition returned false
  - reason = 1: condition panicked
```

(Exact event schema to be finalized in issue 0398.)

## 9. Summary of decisions

| Question | Decision |
|---|---|
| **Distinct from E04?** | Yes — conditions gate `claim_task` (before work); verifiers gate `execute_task` (after work). Both optional, orthogonal. |
| **Interface shape** | `fn is_ready(env, task_id) -> bool` — minimal, objective check independent of claimer |
| **Panic semantics** | Caught; claim rejected with typed error; task remains `Pending` and retryable |
| **Resource budget** | No Soroban sub-call cap exists; keeper bears full cost; must simulate pre-claim |
| **Attachment timing** | Set at `register_task`, owner-changeable while `Pending`, immutable once `Claimed` |
| **Trust model** | Permissionless execution path (any address); optional advisory curated list for bots/UIs |
| **Backward compat** | `Task.condition: Option<Address>`, `None` behaves identically to today |
| **Cost estimation** | Keeper-bot must simulate `is_ready` pre-claim to estimate cost and outcome |

## 10. Acceptance criteria mapping

✅ **Mirrors E04 issue 0076's structure and depth:** This document parallels docs/VERIFIER_DESIGN.md but reframes every decision for conditions (claim-time gate vs. post-execution check).

✅ **Distinguishes from E04:** Section 1 (Context) and Section 4 (Attachment timing) explicitly clarify that conditions and verifiers are orthogonal mechanisms.

✅ **Resource cost documented:** Section 3.1–3.4 extensively covers who bears the cost, how keepers can estimate it, Soroban's limitations, and keeper-bot requirements.

✅ **Keeper-bot requirements:** Section 3.4 specifies E15's task-selection requirements, including pre-claim simulation strategy, cost thresholds, and untrusted condition policy.

✅ **Soroban budget investigation:** Section 3.1 documents the investigation into whether Soroban exposes sub-call resource caps, with evidence that no such mechanism exists today.

---

## Related Issues & Epics

- **E04 (Verifiers):** docs/VERIFIER_DESIGN.md — post-execution verification design (never implemented).
- **E10 (Conditions):** This epic — claim-time condition gating.
  - Issue 0390: Conditions design doc (this file).
  - Issue 0391: `Task.condition` field.
  - Issue 0392: `register_task` parameter addition.
  - Issue 0393: `claim_task` condition evaluation.
  - Issue 0394: `is_claimable` integration.
  - Issue 0395: Panic isolation policy (test).
  - Issue 0396: Resource cost documentation (this issue, accepted criteria met by this design doc).
  - Issue 0397: Reference price-threshold condition.
  - Issue 0398: Events schema.
  - Issue 0399: Property test (solvency).
  - Issues 0400–0404: SDK and integration support.
- **E15 (Keeper Bot V2):** Task-selection logic that consumes the requirements from this doc.

---

## Glossary

| Term | Definition |
|---|---|
| **Condition** | An optional on-chain predicate that answers "is the underlying work ready now?" Evaluated at `claim_task` time. |
| **Verifier** | An optional on-chain callback that answers "did the keeper execute this correctly?" Evaluated at `execute_task` time (E04, not yet implemented). |
| **`is_ready`** | The method on `ITaskCondition` that returns `true` if the condition is satisfied, `false` otherwise. |
| **`ConditionCheckFailed`** | Error returned when a condition check returns `false` or panics; claim is rejected, task remains `Pending`. |
| **Panic isolation** | The design pattern where a panicking condition does not abort the whole transaction; instead, `claim_task` catches it and returns a typed error. |
| **Pre-claim simulation** | Simulating `ITaskCondition::is_ready` via RPC before submitting a real `claim_task` tx, to estimate cost and verify the condition is true. |

