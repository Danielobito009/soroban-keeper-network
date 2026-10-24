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

# Epic E10: On-Chain Task Conditions Architecture

**Date**: October 2026  
**Status**: Design (pre-implementation)  
**Related Epics**: E04 (Verifier Design, shipped), E06 (Reputation System, shipped)

---

## Executive Summary

This document designs an **on-chain task condition** system that gates `claim_task`, checking whether a task is worth attempting before any off-chain work happens. Unlike the E04 verifier (which validates proof *after* execution), a condition checks whether the underlying off-chain event the task reacts to is actually true *before* claiming.

This is a **new mechanism**, distinct from E04 and orthogonal to it. Both will coexist:
- **Task Condition** (E10, this epic): `claim_task` gate. Answer: "Is the task even worth attempting?"
- **Proof Verifier** (E04, shipped): `execute_task` gate. Answer: "Did the keeper prove the work was done correctly?"

---

## Questions and Decisions

### Q1: Relationship to E04 Verifier Epic

**Question**: E04 designed an on-chain verification callback for `execute_task`, never implemented. Does E10's condition check reuse E04's design decisions, or start fresh?

**Decision**: **E10 and E04 are distinct, non-overlapping mechanisms. E10 starts fresh.**

**Rationale**:
- **E04 verifier** is an `execute_task` gate checking **proof of work** after the fact. It answers: "Did the keeper prove they executed the task correctly?" (binary: reject retryable/accept with settlement).
- **E10 condition** is a `claim_task` gate checking **off-chain event state** proactively. It answers: "Is the task's trigger condition actually true right now?" (binary: reject and remain Pending/accept and move to Claimed).
- **Different timing**: Verifier runs *after* claimed keeper does work; condition runs *before* any keeper commits.
- **Different contract flows**: Verifier is an optional proof validator; condition is an optional event-state checker.
- **Different interfaces**: They need different return semantics and failure handling (condition has no proof argument; verifier is tied to proof submission).

**E04 Reusable Elements** (optional, implementation decision):
- E04 used `try_invoke_contract` to catch panics (safe but verbose). E10 can adopt or simplify.
- E04's permissionless design (any address can be verifier) applies to conditions too: no curated allow-list in core.

**E04 Non-Reusable Elements**:
- E04's `IKeeperVerifier` trait signature (proof parameter) does not fit conditions.
- E04's "stays Claimed on rejection" does not fit conditions (which must reject before Claimed is set).
- E04's issue 0076 (gas budget for verifier calls) still unresolved and applies equally here; see Q4.

**Conclusion**: E10's condition interface and semantics are independently designed. Both mechanisms are shipped in the same registry contract version; keepers must simulate *both* before claiming if both are present on a task.

---

### Q2: Predicate Interface

**Question**: What is the exact interface for a task condition?

**Decision**: A condition is a **cross-contract call to a task-specified address**. The interface is:

```rust
pub trait IKeeperCondition {
    fn is_condition_met(env: Env, task_id: u64) -> bool;
}
```

**Rationale**:

1. **Signature**: `(task_id: u64) -> bool`
   - Takes only `task_id` (unlike verifier's `task_id, keeper, proof`).
   - Returns plain bool: true = condition met, claim allowed; false = condition not met, reject.
   - No proof argument: the condition checker is responsible for proof if needed (e.g., oracle verifier fetches price on-chain; it's the verifier's burden, not the keeper's).

2. **Why task_id and not task object?**
   - Condition checker can load the task itself via the registry if needed (contract is in-chain).
   - task_id suffices to uniquely identify the task and its parameters (calldata, deadline, owner, etc.).
   - Keeps interface minimal and immutable.

3. **No keeper parameter?**
   - Unlike verifier (which binds proof to keeper to prevent replay), condition is *keeper-independent*.
   - Condition asks: "Is the market condition true?" not "Is this keeper's proof valid?"
   - Different keepers can independently verify the same condition is true; no keeper-binding needed.

4. **Single-step evaluation, no retry semantics**:
   - Condition returns bool. No partial/staged result or "try later" distinction.
   - If condition is false, task stays Pending; keeper may retry later if condition becomes true.
   - No gradation like verifier's "proof invalid but retryable" vs. "proof rejected final."

**Comparison to E04 Verifier**:
| Aspect | E04 Verifier | E10 Condition |
| --- | --- | --- |
| Trait name | `IKeeperVerifier` | `IKeeperCondition` |
| Signature | `verify(task_id, keeper, proof) -> bool` | `is_condition_met(task_id) -> bool` |
| Gate | `execute_task` (after claim) | `claim_task` (before claim) |
| Question | "Is keeper's proof valid?" | "Is the off-chain event true?" |
| Keeper parameter | Yes (proof binding) | No (event-independent) |
| Proof parameter | Yes | No |
| Failure semantics | Task stays Claimed (retryable) | Task stays Pending (can retry) |
| On panic | Treated as false | Treated as false |

---

### Q3: What Happens on a False Condition

**Question**: When `is_condition_met` returns false or panics, what happens to the task?

**Options**:
- **(A) Reject and remain Pending** (almost certainly correct)
- (B) Reject and mark as Expired/Terminal
- (C) Defer with error code (task knows it was attempted)

**Decision**: **(A) Reject and remain Pending. Task is left exactly as if no one had attempted to claim it.**

**Rationale**:

1. **Consistency with existing design**:
   - E04 verifier rejection leaves task `Claimed` (retryable, different keeper can reattempt).
   - Condition failure is *prior* to claim, so task stays `Pending` (symmetric: no claim was ever recorded).
   - No state is corrupted; next keeper's `claim_task` sees identical task state.

2. **Retry semantics**:
   - Condition false = task not worth attempting *right now*.
   - Condition may become true later (price crosses threshold, position becomes liquidatable).
   - Leaving task Pending allows future retry without manual admin intervention.

3. **No griefing path**:
   - Condition is read-only, no side effects (unlike a verifier proof which must be submitted).
   - Attacker cannot DOS the task by repeating false conditions; first false = immediate rejection (same as if keeper never tried).

4. **Event emission**:
   - `claim_task` will emit `TaskClaimed` on successful claim (current behavior).
   - On condition failure, `claim_task` rejects without state change; no event needed (task state unchanged, so no log entry needed to track failure).
   - Keeper can log the failure client-side for monitoring.

**Conclusion**: Task remains `Pending` and fully retryable. No record of the failed claim attempt is kept on-chain (to avoid bloat and log spam).

---

### Q4: Gas and Resource Cost

**Question**: Who pays for the condition check cross-contract call?

**Options**:
- **(A) Claiming keeper pays** (full cost)
- (B) Task owner escrows condition budget
- (C) Protocol absorbs it (fee_bps raised)

**Decision**: **(A) Claiming keeper pays the full cost of the condition check.**

**Rationale**:

1. **Consistency with E04 verifier**:
   - E04 issue 0076 (cost allocation for verifier) never resolved because E04 wasn't shipped.
   - Setting precedent now: keeper pays their own transaction cost, including any sub-calls.
   - Keeper chooses to claim a task; keeper bears cost.

2. **Incentive alignment**:
   - Keeper simulates condition locally (via `simulateTransaction`) before on-chain attempt.
   - If condition is expensive, keeper decides task is not profitable after gas cost; doesn't claim.
   - Permissionless condition design: any address can be a condition (malicious expensive logic is keeper's risk to avoid).

3. **No sub-call budget in Soroban**:
   - Soroban's `Env::invoke_contract` and `Env::try_invoke_contract` do not support per-call gas limits (unlike Ethereum's `call{gas: g}()`).
   - If condition exceeds transaction budget, entire `claim_task` fails (host budget exhaustion).
   - Keeper must estimate or simulate to avoid overruns; cost budgeting happens off-chain.

4. **Backward compatibility**:
   - Tasks without condition incur zero condition cost (no cross-contract call).
   - Existing tasks unaffected.

**Task Owner Responsibilities** (off-chain):
- Task owner should **choose a condition address that is efficient** and returns quickly.
- If owner attaches a pathological condition (expensive, DoS), keepers will refuse to claim (profit margin erodes).
- Market self-corrects: tasks with bad conditions go unclaimed; incentive for owner to fix.

**Protocol Considerations**:
- No protocol fee bump needed; condition cost is external to task execution.
- Task owner could optionally increase `reward` to compensate for expected condition cost (off-chain negotiation/market signal).

**Conclusion**: Keeper pays. Keeper simulates. Market corrects. No special subsidy or budget.

---

### Q5: Backward Compatibility

**Question**: Tasks registered without a condition (the overwhelming majority of existing and near-future tasks) must have zero added cost or behavior change.

**Decision**: **Tasks without a condition (condition field `None`) are treated identically to today.**

**Rationale**:

1. **Storage field is optional**:
   - Task struct gains a new field: `condition: Option<Address>`.
   - Migration: all existing tasks have `None` (no condition set).
   - Future tasks can set it at registration; existing tasks unaffected.

2. **No runtime cost**:
   - In `claim_task`, check `if task.condition.is_some()` before cross-contract call.
   - If `None`, skip condition check entirely (zero cost).
   - If `Some(addr)`, invoke condition as described above.

3. **Update semantics**:
   - Like `verifier`, condition can be updated by owner while task is `Pending` (lines in E04's `update_verifier` logic apply here too).
   - Once claimed, condition is immutable (no mid-execution surprises).

4. **No fee impact**:
   - Condition cost is not included in `fee_bps` calculation (condition is keeper-paid, not from reward).
   - Existing fee structure unchanged.

5. **Initialization**:
   - `register_task` gains new optional parameter: `condition: Option<Address>`.
   - Backward compatibility: old contract calls without condition parameter must still work (language bindings default to `None` or caller explicitly passes `None`).

**Example Timeline**:
- **Today**: All existing tasks have `condition: None`. `claim_task` skips condition check. Zero overhead.
- **Post-E10 ship**: New tasks can optionally include a condition address. Old tasks still have `None`, still skip check.
- **5 years later**: Ecosystem may adopt conditions widely, but each task's cost/behavior is independent; no lock-in.

**Conclusion**: Fully backward compatible. No cost, no behavior change for tasks without conditions.

---

## Design Decisions Summary

| Question | Decision | Rationale |
| --- | --- | --- |
| **Q1: E04 Reuse?** | No, start fresh. E10 and E04 are orthogonal. | Different timing (before vs. after claim), interfaces, semantics. |
| **Q2: Interface?** | `is_condition_met(task_id: u64) -> bool` | Minimal, keeper-independent, event-state check. |
| **Q3: False condition?** | Task stays Pending, no state change. | Consistency, retry-friendly, no griefing. |
| **Q4: Who pays?** | Keeper pays full condition cost. | Incentive alignment, simulation-before-claim, permissionless. |
| **Q5: Backward compat?** | Tasks without condition pay zero cost. | Optional field, optional check, no fee impact. |

---

## Implementation Details

### Storage Changes

**Task struct addition** (`types.rs`):
```rust
pub struct Task {
    // ... existing fields ...
    pub verifier: Option<Address>,
    pub condition: Option<Address>,  // NEW: optional on-chain condition checker
}
```

**Rationale**:
- Parallel to `verifier` field (same design pattern).
- Optional: `None` means no condition (backward compat).
- Immutable once claimed (like verifier).

### Entry Point Signature Changes

**register_task** (`task.rs`):
```rust
pub fn register_task(
    e: Env,
    owner: Address,
    reward: i128,
    calldata: Bytes,
    task_type: TaskType,
    deadline: u64,
    lock_ledgers: u32,
    ttl_ledgers: u32,
    verifier: Option<Address>,
    condition: Option<Address>,  // NEW
) -> Result<u64, KeeperError>
```

**Changes**:
- Add `condition: Option<Address>` as final parameter.
- Store in task struct.
- Validate (same as verifier validation; see below).

**Existing entry points affected**:
- `update_condition()` (new): owner can change condition while task is Pending.
  ```rust
  pub fn update_condition(
      e: Env,
      task_id: u64,
      new_condition: Option<Address>,
  ) -> Result<(), KeeperError>
  ```
  - Precondition: task exists and is Pending.
  - Owner must authenticate.
  - Idempotent (can set to same value).

### claim_task Logic Changes

**Updated `claim_task` implementation** (`task.rs`):
```rust
pub fn claim_task(
    e: Env,
    keeper: Address,
    task_id: u64,
) -> Result<(), KeeperError> {
    require_not_paused(&e)?;
    keeper.require_auth();

    let task = load_task(&e, task_id)?;
    require_deadline_not_passed(&e, &task)?;
    require_claimable(&e, &task)?;
    require_min_stake(&e, &keeper)?;
    require_reputation_floor(&e, &keeper)?;

    // NEW: check condition if present
    if let Some(condition_addr) = &task.condition {
        let condition_met = invoke_condition(&e, &condition_addr, task_id)?;
        if !condition_met {
            return Err(KeeperError::ConditionNotMet);
        }
    }

    // Existing mutation logic
    record_missed_claim_if_reclaim(&e, &task)?;
    let mut task = task;
    task.status = TaskStatus::Claimed;
    task.claimer = Some(keeper.clone());
    task.claim_ledger = Some(e.ledger().sequence());

    save_task(&e, task_id, &task);
    bump_instance(&e);
    emit_task_claimed(&e, task_id, &keeper);

    Ok(())
}
```

**New helper** (`task.rs`):
```rust
fn invoke_condition(
    e: &Env,
    condition_addr: &Address,
    task_id: u64,
) -> Result<bool, KeeperError> {
    let condition = IKeeperConditionClient::new(e, condition_addr);
    let result = condition.try_is_condition_met(&task_id);
    match result {
        Ok(Ok(bool_val)) => Ok(bool_val),
        Ok(Err(_)) => Ok(false),  // Condition reverted; treat as not met
        Err(_) => Err(KeeperError::ConditionInvocationFailed),  // Host error
    }
}
```

**Error handling**:
- **Condition returns false**: Reject claim, return `KeeperError::ConditionNotMet`.
- **Condition panics/reverts**: Treat as false (via `try_is_condition_met`), reject claim.
- **Host error (e.g., condition contract doesn't exist)**: Return `KeeperError::ConditionInvocationFailed` (hard error).

**Insertion point in flow**:
- Condition check happens *after* reputation/stake checks and *before* state mutations.
- Rationale: cost-effective ordering (cheap permission checks first, then condition which may be expensive).

### Event Changes

**New event** (`events.rs`):
```rust
pub fn emit_condition_not_met(e: &Env, task_id: u64, condition_addr: &Address) {
    let topics = (Symbol::new(&e, "condition_not_met"), task_id);
    e.events().publish(topics, condition_addr);
}
```

**When emitted**: If condition check fails (but no state change, so optional for logging). Can be omitted for simplicity; keeper monitors `claim_task` rejections.

### Error Codes

**New errors in `KeeperError` enum** (`errors.rs`):
```rust
pub enum KeeperError {
    // ... existing ...
    ConditionNotMet,              // Condition evaluated to false
    ConditionInvocationFailed,    // Host error calling condition
}
```

---

## Interface: IKeeperCondition

**Trait definition** (`condition.rs`, new file):
```rust
use soroban_sdk::{Env, contractclient};

#[contractclient(crate = "crate")]
pub trait IKeeperCondition {
    fn is_condition_met(env: Env, task_id: u64) -> bool;
}
```

**Notes**:
- Macro generates `IKeeperConditionClient` for `KeeperRegistryClient` to invoke.
- Same pattern as `IKeeperVerifier` from E04.
- Implementers (condition contracts) inherit responsibility for any proof validation or oracle fetching.

---

## Example Scenarios

### Scenario 1: Price-Based Condition
A liquidation task carries a condition contract that checks if an oracle price is below a liquidation threshold:

1. **Register task**: owner specifies `condition: Some(price_condition_contract)`.
2. **Keeper attempts claim**: `claim_task` invokes `price_condition_contract.is_condition_met(task_id)`.
3. **Price checker**:
   - Loads task via registry (or receives task params off-chain from keeper).
   - Fetches oracle price via Stellar/Soroban oracle.
   - Compares against threshold stored in task params (in `calldata`).
   - Returns `true` if price is below threshold, `false` otherwise.
4. **If true**: keeper claim succeeds, task moves to `Claimed`.
5. **If false**: keeper claim rejected with `ConditionNotMet`, task remains `Pending`.

### Scenario 2: Backward Compat (No Condition)
Existing task from pre-E10 era has `condition: None`:

1. **Keeper attempts claim**: `claim_task` checks `if task.condition.is_some()` → false, skips condition.
2. **No cross-contract call**, zero condition cost.
3. **Claim proceeds normally** (if all other checks pass).

### Scenario 3: Expensive Condition, Keeper Simulates
A condition contract is expensive (e.g., complex oracle aggregation):

1. **Keeper client simulates** `simulateTransaction(claim_task(...))` locally to estimate gas.
2. **Simulation includes condition sub-call** (full gas profile).
3. **Keeper estimates**: Gas cost is 50% of reward → profit margin too thin, doesn't submit.
4. **Keeper skips this task**, seeks more profitable opportunities.

### Scenario 4: Composition (Condition + Verifier)
A task has both `condition` and `verifier`:

1. **Keeper attempts claim**: `claim_task` checks condition first.
2. **If condition false**: claim rejected immediately (no state change).
3. **If condition true**: claim succeeds, task moves to `Claimed`.
4. **Keeper executes**: `execute_task` checks verifier on proof.
5. **If verifier fails**: task stays `Claimed` (retryable).
6. **If verifier passes**: task moves to `Executed`, keeper settled.

---

## Implementation Roadmap

### Phase 1: Core (Epic E10)
- [ ] Add `condition: Option<Address>` field to Task struct.
- [ ] Implement `update_condition()` entry point.
- [ ] Add condition check to `claim_task` (invoke, handle errors, reject on false).
- [ ] Add `ConditionNotMet` and `ConditionInvocationFailed` error codes.
- [ ] Create `condition.rs` with `IKeeperCondition` trait.
- [ ] Tests: unit and integration with mock condition contracts.
- [ ] Documentation: keeper integration guide (simulation, gas estimation).

### Phase 2: Reference Conditions (future epic, outside E10)
- [ ] Reference oracle-price condition (proof of concept).
- [ ] Reference TVL/utilization condition.
- [ ] SDK/binding for common condition patterns.

### Phase 3: Ecosystem (future)
- [ ] Condition aggregators/combinators (AND, OR logic).
- [ ] Condition marketplace/registry (advisory, not enforced in core).

---

## Testing Strategy

### Unit Tests
1. **Condition true**: `claim_task` succeeds.
2. **Condition false**: `claim_task` rejected, task stays Pending.
3. **Condition panics**: Treated as false, task stays Pending.
4. **No condition (None)**: Condition check skipped, claim proceeds normally.
5. **Update condition while Pending**: Succeeds, new condition used on next claim.
6. **Update condition while Claimed**: Fails with InvalidTaskStatus.
7. **Condition invocation error**: Rejected with ConditionInvocationFailed.

### Integration Tests
1. **Task with condition and verifier**: Both gates checked in order.
2. **Repeated attempts**: First false (condition), second true later (reraise via recovery path).
3. **Gas simulation**: Keeper simulates condition gas cost before on-chain attempt.
4. **Backward compat**: Old tasks without condition remain unaffected.

### Mock Condition Contracts
- `MockConditionTrue`: Always returns true (baseline).
- `MockConditionFalse`: Always returns false (rejection path).
- `MockConditionPanic`: Panics (panic handling).
- `MockConditionExpensive`: Simulates high gas usage.

---

## Distinction from E04 (Verifier)

To prevent future confusion, here is the explicit distinction:

| Aspect | E04 Verifier | E10 Condition |
| --- | --- | --- |
| **Purpose** | Validate proof of execution | Gate claim based on event state |
| **When checked** | During `execute_task` (after keeper claims) | During `claim_task` (before keeper claims) |
| **Question asked** | "Did the keeper prove they did the work?" | "Is the underlying event actually true?" |
| **Input** | task_id, keeper, proof | task_id only |
| **Output** | Boolean (pass/fail) | Boolean (condition met/not met) |
| **Failure mode** | Task stays Claimed (retryable by next keeper) | Task stays Pending (can retry later) |
| **On panic/error** | Treated as proof rejected, task stays Claimed | Treated as condition not met, task stays Pending |
| **Keeper submits** | Proof (off-chain data) | Nothing (condition is self-contained) |
| **Use case** | Signature verification, SNARK proofs, attestations | Oracle price checks, state validation, availability gates |
| **Permissionless?** | Yes (any address can be verifier) | Yes (any address can be condition) |
| **Composition possible?** | Verifier aggregators (AND/OR logic) | Condition aggregators (AND/OR logic) |

**Key Insight**: Verifier and condition are **independent predicates** on *different* parts of the task lifecycle. Both will often be present; neither supersedes the other.

---

## FAQs

### FAQ 1: Can a condition re-check mid-execution?
No. Condition is checked once at `claim_task`. If condition becomes false later, task stays `Claimed`. If keeper detects the condition is no longer true, keeper can cancel the task or wait for expiry. No in-execution re-check.

### FAQ 2: What if condition changes after claim?
Condition is immutable once claimed (like verifier). If owner needs to update, owner must cancel/reregister the task. Rationale: prevents griefing (owner cannot suddenly invalidate a claimed task).

### FAQ 3: Can a task have both condition and verifier?
Yes. Condition is checked at claim; verifier is checked at execute. Both gates must pass. Keeper simulates both before claiming.

### FAQ 4: Who is responsible for condition availability?
Task owner. If condition address is deleted/archived, `claim_task` fails with `ConditionInvocationFailed`. Owner should ensure condition contract is well-maintained and has sufficient TTL.

### FAQ 5: Can a condition call back to the registry?
Yes. Condition contract can invoke the registry to fetch task details. This is useful for price conditions that need to compare oracle price against task params stored in `calldata`. No special restrictions; standard cross-contract call pattern.

### FAQ 6: What if condition is very expensive?
Keeper evaluates via `simulateTransaction` before on-chain attempt. If gas cost erodes profit, keeper doesn't claim. Market self-corrects: expensive conditions go unclaimed; owner incentivized to optimize.

### FAQ 7: Is condition state-changing?
No. Condition is a **pure query**. It should have no side effects. If a condition modifies storage, behavior is undefined (Soroban may fail the transaction or allow it; keeper takes the risk). Best practice: condition contracts are read-only.

---

## Acceptance Criteria

- [x] **Q1 answered**: E10 and E04 are distinct, orthogonal mechanisms. Q1 rationale explains why they don't overlap.
- [x] **Q2 answered**: Exact interface specified: `IKeeperCondition::is_condition_met(task_id: u64) -> bool`.
- [x] **Q3 answered**: Explicit decision: task stays Pending on condition false, consistent with registry design.
- [x] **Q4 answered**: Keeper pays full condition cost; simulation-before-claim is keeper's responsibility; no sub-call budget in Soroban.
- [x] **Q5 answered**: Tasks without condition (`None`) incur zero cost, fully backward compatible.
- [x] **Storage changes pinned**: Task struct gains `condition: Option<Address>` field.
- [x] **Entry point changes pinned**: `register_task` gains `condition` parameter; `update_condition()` new entry point; `claim_task` adds condition check.
- [x] **Error codes defined**: `ConditionNotMet`, `ConditionInvocationFailed`.
- [x] **Interface specified**: `IKeeperCondition` trait with `is_condition_met` method.
- [x] **Distinction from E04 clear**: Detailed comparison table and FAQ address confusion risk.

---

## References

- **E04 Verifier Design**: `docs/VERIFIER_DESIGN.md` (shipped, source of truth on proof validation patterns).
- **Issue 0076 (never resolved)**: Gas budgeting for sub-calls (addressed by keeper simulation strategy in E10).
- **Soroban Invoke Docs**: No per-call gas limits; full transaction cost applies.
- **Task Lifecycle**: `contracts/keeper-registry/src/task.rs`, claim_task implementation (foundation for condition check insertion point).

---

## Sign-Off

**Design Lead**: [Chief]  
**Status**: Ready for implementation (all acceptance criteria met)  
**Next Phase**: Epic E10 task decomposition and coding.
# Task Conditions Design and E10 Retrospective

**Status:** implemented in keeper-registry VERSION 6.

## 1. Purpose

A task may name an optional contract that decides whether the task is ready to
be claimed. This gate runs before claim state is written. It is distinct from
the optional verifier: a condition gates `claim_task` before work starts, while
a verifier gates `execute_task` after a keeper submits proof.

An unconditional task stores `condition: None` and follows the original claim
path. A conditioned task stores `Some(address)` in its immutable task record.
Both `register_task` and each `BatchTaskParams` entry accept the same optional
field.

## 2. Interface

Condition contracts implement this exact interface:

```rust
pub trait ITaskCondition {
    fn is_met(env: Env, task_id: u64) -> bool;
}
```

The registry supplies only the task id. It does not supply the prospective
keeper, proof, or arbitrary caller data, so the result is uniform for every
keeper evaluating the same on-chain state. Conditions can use the task id to
look up configuration in their own storage.

Condition addresses are permissionless. Registration does not invoke the
address, maintain an allowlist, or claim that the contract is trustworthy.
This keeps registration bounded and prevents an untrusted callback from moving
funds during escrow creation.

## 3. Claim semantics

For a conditioned task, `claim_task` performs its ordinary lifecycle,
deadline, reputation, and stake checks, then calls `is_met(task_id)` before
changing the task's claimer or claim ledger.

- `true`: claim processing continues.
- `false`: the call returns `KeeperError::ConditionNotMet`.
- missing contract, malformed response, error, or panic: the call fails closed
  as `KeeperError::ConditionNotMet`.

Rejected evaluation emits `ConditionNotMet` with topics
`("condfail", "task")` and data `(task_id, condition)`. The task remains
`Pending` with no claimer, and no escrow moves. `is_claimable` applies the same
condition check and returns `false` for every rejected or failed evaluation.

Keepers pay the resources for the nested condition invocation and should
simulate before submitting. The registry does not impose a separate subcall
budget beyond Soroban transaction limits.

## 4. Registration, storage, and events

VERSION 6 changes these public shapes:

- `register_task(..., verifier, condition)` adds `condition: Option<Address>`.
- `Task` stores `condition: Option<Address>`.
- `BatchTaskParams` stores `condition: Option<Address>`.
- `TaskRegistered` data becomes
  `(task_id, owner, reward, deadline, condition)`.
- error code 40 is `ConditionNotMet`.

Single and batch registration both call `validate_task_params`, including the
condition field, so policy cannot diverge. A batch may mix `Some(address)` and
`None`; a test reads each resulting task and checks the stored value. The
indexer accepts both VERSION 6 registration events and historical four-field
events, which are represented with `condition: null`.

Because the stored `Task` contract type changed, VERSION 6 is a compatibility
boundary. Deployments must follow the repository's reviewed upgrade/migration
process rather than silently interpreting an older task record as the new
shape.

## 5. Security properties

The implementation guarantees that a rejected condition cannot write registry
claim state, move escrow, or emit `TaskClaimed`. It does not guarantee that a
permissionless condition is economically honest, available, side-effect-free,
or cheap. Owners and keepers must assess the selected contract.

The detailed review is in
[`TASK_CONDITIONS_SECURITY_REVIEW.md`](TASK_CONDITIONS_SECURITY_REVIEW.md).
Tests cover approving, rejecting, missing, and panicking condition contracts,
plus unchanged task state after rejection.

## 6. E10 retrospective

### Shipped against the design

- Optional per-task conditions on single and batch registration.
- Fail-closed evaluation before any claim-state mutation.
- A typed error and indexed rejection event.
- Read-only claimability using the same predicate.
- Mixed-batch persistence tests and adversarial failure tests.
- Indexer migration, event parser, REST representation, OpenAPI schema, and
  historical-event compatibility.

### Divergences and rationale

- The final callback receives only `task_id`; it does not receive the keeper.
  This prevents a task owner from selectively approving individual keepers and
  makes preflight results stable across callers.
- Callback errors and panics are normalized to `ConditionNotMet` rather than
  exposing condition-specific errors. This preserves a small registry ABI and
  avoids coupling it to arbitrary contracts.
- `TaskRegistered` was expanded rather than adding a second attachment event.
  A registration event is then a complete source for the task's immutable
  condition, while the indexer retains explicit four-field compatibility.
- Batch parity shipped as the closing E10 follow-up so batched tasks cannot
  silently lose a condition configured on the single-task path.

### Security review outcome

The review accepted a permissionless, owner-selected condition boundary. The
registry isolates false, missing, and panicking callbacks by failing closed and
writing no claim state first. The accepted tradeoffs are that the submitting
keeper pays callback resources, a malicious or unavailable condition can delay
claims until cancellation or expiry, and a condition may mutate its own state
within the outer invocation. No condition receives keeper identity from the
registry ABI.

### Deferred items

- Registry-managed condition allowlists or endorsements.
- Mutable condition replacement on an existing task.
- Composite AND/OR condition contracts.
- A registry-specific nested-call resource budget.
- Keeper-side preflight optimization beyond normal simulation.
- Reference oracle condition implementations; E11 is specified separately in
  [`ORACLE_DESIGN.md`](ORACLE_DESIGN.md).
- In-place migration tooling for deployed pre-VERSION-6 task records.
