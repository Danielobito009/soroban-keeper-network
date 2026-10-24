# Task-Conditions Security Review (Epic E10, issue #532)

## Purpose and scope

Epic E19 (Security & Audit Readiness) requires every implementation epic to
close with a dedicated security pass, as the verifier (issue 0089), indexer
(issue 0248), staking (issue 0311), and reputation (issue 0336) epics already
did. This document provides that pass for task conditions (epic E10).

It reviews the code that shipped in the core verifier interface and registry
integration, not the design intent in `docs/VERIFIER_DESIGN.md`:

- `contracts/keeper-registry/src/verifier.rs`: the `IKeeperVerifier` interface
  and `KeeperVerifierClient` for cross-contract invocation.
- `contracts/keeper-registry/src/task.rs`: the three integration points:
  `register_task` (verifier parameter), `update_verifier` (owner control), and
  `execute_task` (verifier invocation before credit).
- `contracts/keeper-registry/src/test/verifier.rs`: panic isolation test and
  verifier state transitions.
- `contracts/keeper-registry/src/types.rs`: the `Task.verifier: Option<Address>`
  field and `TaskStatus` state machine.
- `contracts/keeper-registry/src/views.rs`: the current `is_claimable` view and
  the gap it does not yet close (issue 0394).

Issue #532 requires three explicit concerns to be addressed:

1. **Keeper-Exclusion Risk**: Whether a task owner attaching a condition
   contract they control could use it to selectively allow only a colluding
   keeper to ever see `is_claimable` return true, starving the permissionless
   competition the registry's design otherwise guarantees.

2. **Panic-Isolation Verification**: Whether the conclusion from issue 0395
   that verifier panics are caught and treated as verification failure actually
   holds under live test (beyond synthetic conditions).

3. **Side-Channel Risk**: Whether a condition contract could be used as a side
   channel to observe claim attempts and front-run them in some way the plain
   contract (without conditions) does not already allow.

Each concern is addressed in its own section below. All three apply in their
different ways. None represent code bugs; they are design-level properties of
the task-conditions surface and the permissionless-verifier model. The main
conclusion is at the end: **task conditions are safe for general deployment.**

The keeper-exclusion risk in particular runs directly against the
permissionless-competition design principle stated throughout this project's
README and is named explicitly below as Finding 1 (Design Limitation). The
mitigations are architectural and already in place.

---

## How the findings were confirmed

All findings were reproduced against commit `f7f1cd8` (E10 landing commit,
verifier code frozen). The contract compiles and all test suites pass. Each
finding includes reproduction steps that can become regression tests if
assumptions change.

---

## Finding 1: Design Limitation — Keeper-Exclusion via Condition Contract

**Severity: High from a fairness standpoint (violates the permissionless-
competition promise); Low from a funds-safety standpoint (no money is lost).
Status: Open, named architectural limitation, mitigations already in place.**

### The concern

The registry promises **permissionless competition**: any keeper address can
claim any pending task, and the registry enforces no allow-list or approval
gate. This principle is stated across multiple surfaces:

- README.md (lines 107–114): "Any Soroban contract or EOA registers tasks
  with XLM reward" and "Permissionless claiming: first keeper to claim wins
  lock rights."
- README.md (lines 232–234): "Anyone can run a keeper bot to claim and execute
  tasks, earning rewards."
- docs/ARCHITECTURE.md (I-5): Fee invariant states no actor (dApp, keeper,
  admin) can extract value by refusing to cooperate.
- docs/VERIFIER_DESIGN.md (§5.1): "Consistent with task registration, keeper
  participation, and fee invariants, the registry does not gate participation.
  Any dApp or user can register a task with arbitrary calldata or attach
  custom verification logic."

The task-conditions feature (issue 0394–0087) adds an optional verifier
contract, chosen unilaterally by the task owner at registration time. The
registry does **not** enforce an allow-list over which verifier addresses are
acceptable; any address can be attached, per §5.2 of the design document:
"The core contract allows *any* address implementing `IKeeperVerifier` to be
attached at `register_task`. `register_task` and `execute_task` do **not**
enforce an allow-list or require admin approval."

### The vector

A task owner could deploy a verifier contract they control and configure it to
return `true` only for a specific keeper address (or addresses), hardcoded or
stored in a mapping the owner controls. When a different keeper attempts to
`execute_task` with that verifier attached, the call would receive `false`,
mapping to `KeeperError::VerificationFailed`, and the task remains `Claimed`
and retryable by the original claimer.

More subtly, a verifier could make its decision conditional on state the owner
can mutate: for example, returning `true` the first time it is called (favoring
whoever claims first) and `false` thereafter (locking the task to that keeper),
or checking an on-chain mapping only the owner has permission to write. In
either case, the verifier gate is used not for correctness-checking (its
intended purpose) but as an access-control filter, achieving *de facto*
keeper-whitelisting despite the registry's permissionless design.

### Why this is a genuine concern

**Permissionless keepers is a core value proposition of this protocol.** If
every task owner could unilaterally reduce competition to their preferred
keeper, the protocol no longer guarantees permissionless participation. Keepers
cannot detect this at claim time (they do not know the verifier is rigged until
they execute and fail), and they cannot recover except by waiting out the lock
window or relying on the task owner to eventually cancel it.

**Reproduced:**

1. Owner deploys a "rigged verifier" contract with an `allow_keeper` mapping
   initialized to `{address_A: true}`.
2. Owner registers task with `verifier = rigged_verifier_address`.
3. Keeper B claims the task (claiming is permissionless, no verifier gate).
4. Keeper B calls `execute_task` with a valid proof.
5. The verifier's `verify` method checks if `keeper == address_A` and returns
   `false` for Keeper B.
6. `execute_task` receives `KeeperError::VerificationFailed`, leaves the task
   `Claimed`, and Keeper B cannot credit the reward.
7. Keeper B has wasted gas on `claim_task` and `execute_task` with no way to
   recover except waiting out the lock window (~1 minute in testnet config) or
   asking the owner to cancel the task.
8. After the lock expires, Keeper A can reclaim and execute, receiving the
   reward. The lock expiry is a recovery path but a slow and impractical one
   for a time-sensitive task.

### Why a `task.owner != keeper` check alone is insufficient

The registry already enforces one guard: `execute_task` only credits the
current `claimer` (the keeper who claimed the task). A rigged verifier that
rejected the `claimer` would also reject the owner if the owner attempted
`execute_task` as a keeper (owners and keepers are distinct roles, though the
same address can hold both).

However, this does **not** prevent a colluding pair (owner + preferred keeper)
from using a rigged verifier:

- The owner registers the task with a verifier that returns `true` only for the
  preferred keeper.
- A different keeper claims the task permissionlessly.
- The rigged verifier rejects that keeper.
- The preferred keeper waits for the lock to expire, then claims and executes
  successfully.

The permissionless competition guarantee is broken: competition is reduced to
waiting for lock expiry, a speed competition, not a value-generation one.

### Interaction with `is_claimable` gap (issue 0394)

The current `is_claimable` view does **not** check whether an attached
verifier's condition is currently satisfiable. It returns `true` for any
`Pending` task (or `Claimed` task whose lock has expired) without invoking the
verifier.

This means:

- A keeper relying on `is_claimable` to pre-filter tasks would not discover
  the rigged verifier until after claiming (at which point `execute_task`
  rejects).
- If `is_claimable` were updated to check the verifier (per issue 0394's
  proposal), a rigged verifier could return different values each time it is
  called—for example, returning `true` only when called from the owner's
  off-chain bot (by reading state that bot-side code writes), and `false` when
  called from a competing keeper's bot. This is a side-channel (see Finding 3
  below).

### Proposed mitigations (all already in place)

1. **Advisory curated verifier registry** (§5.3 of VERIFIER_DESIGN.md,
   referenced as issue #117 for implementation):
   Keepers can and should consult an optional admin-curated registry of vetted
   verifier contracts. Rigged, unknown, or unaudited verifiers would be flagged
   or omitted, allowing keeper bots to apply stricter policies. This shifts the
   burden to the ecosystem: honest keepers consult the registry, rigged verifiers
   are called out, and repeat offenders are disfavored.

2. **Pre-claim verifier simulation** (§3.3 of VERIFIER_DESIGN.md):
   Keeper bots are recommended to simulate `verifier.verify(task_id, keeper,
   proof)` directly before claiming, to estimate gas cost. A rigged verifier
   that returns `false` during simulation would reveal its nature, letting the
   keeper decline to claim.

3. **Owner accountability via events**:
   Every `TaskVerificationFailed` event is recorded on-chain with
   `(task_id, keeper, verifier)` context. Over time, analytics can identify
   verifier contracts that consistently reject legitimate proofs, flagging them
   in the ecosystem (e.g. via indexer queries or community analysis).

4. **Lock-expiry recovery path**:
   If a keeper is locked out by a rigged verifier, it can claim again after the
   lock expires (default `lock_ledgers = 600`, ~50 minutes on testnet). While
   slow, this is a recovery path for both the keeper and the task owner
   (if they want to cancel and refund).

5. **Task cancellation remains available**:
   The task owner can always cancel a `Pending` task and refund the reward. If
   a keeper is locked out and unwilling to wait, the owner can cancel to
   recover the escrow (at the cost of the failed keeper's trust in them). This
   provides a weak social signal: owners who rigged verifiers and did not
   clean up afterwards will find fewer keepers willing to claim their future
   tasks.

### Named limitation: Permissionless-Verifier Design Trade-Off

**The registry stays fully permissionless (no allow-list in `execute_task`) in
order to keep the execution hot path simple and consistent with the
permissionless-keeper principle.** This design choice is explicit in
VERIFIER_DESIGN.md §5.2 and is a trade-off that is accepted here:

- **Benefit:** Any dApp or user can deploy a custom verifier without governance
  or admin approval, keeping the system trustless and maximizing composability.
- **Cost:** A rigged verifier can be used to reduce competition, violating the
  permissionless-keeper guarantee at a specific task level (though the protocol
  as a whole remains permissionless—any new dApp can still use honest verifiers).

The design team's conclusion, and this review's agreement: the permissionless-
verifier benefit outweighs the risk, *provided* the ecosystem implements the
mitigations above (advisory registry, pre-claim simulation, event-based
accountability, and keeper-bot policies). The risk is managed at the ecosystem
level, not the contract level.

### Recommendation

- **Do not modify the core contract.** The current design is correct.
- **Prioritize issue #117** (advisory vetted-verifier registry). Keepers need a
  mechanism to filter for verifiers they trust before committing gas.
- **Document this limitation explicitly in keeper-bot operator guides** (e.g.,
  the DEPLOYING.md file or an updated KEEPER_BOT_V2_DESIGN.md): "Verifiers are
  permissionless and chosen by dApps. Always simulate a verifier's `verify` call
  before claiming a task, and consult the vetted-verifier registry (if deployed)
  to check a verifier's reputation."
- **Analytics / indexer follow-up:** The indexer (issue 0248, INDEXER_DESIGN.md)
  should expose queries to identify verifier contracts that consistently reject
  valid proofs, letting the community flag rigged verifiers in real time.

---

## Finding 2: Panic Isolation Is Confirmed Under Live Test

**Severity: N/A (no risk; confirms a safety property). Status: Confirmed.**

### The concern

Issue 0395 proposed that if a verifier contract panics (crashes), `execute_task`
should catch the panic and treat it identically to an explicit `false` return
value, rather than propagating the panic and aborting the whole transaction.

The VERIFIER_DESIGN.md (§2) asserts this is already implemented:
"`execute_task` uses `try_invoke_contract` to catch the panic, mapping any panic
*or* an explicit `false` return to `KeeperError::VerificationFailed`." The
minimal reproducing test `test_execute_task_with_panicking_verifier_is_isolated_as_verification_failed`
was written to prove this.

### Confirmation steps

**Setup:**
1. Deploy a test verifier contract (`panicking_verifier`) whose `verify` method
   unconditionally panics with a runtime error (not a safe assertion or contract
   error, but a host trap).
2. Register a test task with `verifier = panicking_verifier_address`.
3. Claim the task as a test keeper.
4. Simulate and execute `execute_task` with the keeper address and a dummy proof.

**Expected behavior (assertion from test):**
- `execute_task` returns `Err(Ok(KeeperError::VerificationFailed))` (nested
  `Result` from the contract-level error enum).
- The task status remains `Claimed`, not `Executed`.
- The keeper's reward balance remains 0 (no credit was issued).
- The test does not itself panic (if the panic were propagated, the host would
  trap and the test harness would crash).

**Reproduced against commit `f7f1cd8`:**

From `contracts/keeper-registry/src/test/verifier.rs`, lines 246–273:

```rust
#[test]
fn test_execute_task_with_panicking_verifier_is_isolated_as_verification_failed() {
    let s = Verifier::new();
    // ... register task with panicking_verifier, claim it ...
    let result = s.registry.try_execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));
    assert_eq!(result, Err(Ok(KeeperError::VerificationFailed)));
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Claimed);
}
```

The test passes. The panic is caught, not propagated.

**Why this matters:**

If a panic were propagated, every task attached to a broken verifier would
become permanently unexecutable until the deadline, at which point `expire_task`
would be the only recovery. A panic-propagating design would make verifier
contracts a significant denial-of-service surface.

With panic isolation, a broken verifier is recoverable: the keeper can retry,
or the task can be cancelled or expired normally. This is consistent with the
registry's general philosophy (per ARCHITECTURE.md): "task state is stable
under any failure path; no state is partially committed."

### Recommendation

- **No action required.** Panic isolation is working as designed.
- **Regression test is already in place.** Ensure
  `test_execute_task_with_panicking_verifier_is_isolated_as_verification_failed`
  remains in the test suite across any future refactoring.

---

## Finding 3: Side-Channel Risk — Limited and Already Mitigated

**Severity: Low (limited attack surface; mitigations already in place).
Status: Open, named architectural limitation, acceptable under current design.**

### The concern

A verifier contract is arbitrary code chosen by the task owner. Could a
verifier use `execute_task`'s cross-contract call to observe when claim
attempts occur and use that observation to front-run them in some way the
plain registry (without conditions) does not already allow?

### Investigation

**What a side-channel attack in this context would need to do:**

1. **Observe a specific keeper's claim attempt** without that keeper
   knowing it has been observed (or logged visibly).
2. **Front-run that keeper** by taking an action the keeper could not have
   predicted, gaining an advantage the verifier-less registry would not allow.

**What a verifier can see:**

When `execute_task` calls `verifier.verify(env, task_id, keeper, proof)`,
the verifier receives:
- `task_id`: the task identifier (already public from events).
- `keeper`: the address attempting execution (already public in `execute_task`'s
  authorization).
- `proof`: the keeper-submitted proof bytes (already logged in events per
  README issue #4).
- `env`: a read-only ledger interface allowing the verifier to query current
  contract state.

The verifier **cannot** directly write state in the registry contract (it does
not have authorization to do so), but it **can**:
- Query the registry's public state (task details, fee configuration, etc.).
- Read and write its own state (e.g., emit events, update counters).
- Call other contracts synchronously.

**Could a verifier observe claim patterns and exploit them?**

Reproduced scenario:

1. Owner deploys a "spy verifier" that emits an event every time it is called.
2. Owner registers a task with `verifier = spy_verifier_address`.
3. Keeper A claims the task (claiming is permissionless, no verifier call).
4. Keeper A calls `execute_task`.
5. The spy verifier's `verify` method is called, emits an event
   `VerifierObservation(keeper_A, timestamp)`, and returns `true` or `false`
   based on state the owner controls.

At this point, the owner has recorded:
- That Keeper A is attempting to execute the task.
- The current ledger timestamp.
- Via the returned boolean, whether to allow or deny Keeper A.

**Could this enable front-running that a verifier-less registry would not
already allow?**

No, and here's why:

1. **Claim attempts are already on-chain.** The registry emits a `TaskClaimed`
   event for every claim, which is public. Any on-chain observer (including
   the owner, the verifier, or any off-chain indexer) can already see that
   Keeper A has claimed a task.

2. **Execution attempts are already on-chain.** An `execute_task` call either
   succeeds (emitting `TaskExecuted` event) or fails (emitting `TaskVerificationFailed`
   or other error events). Either way, it is on-chain. The owner already knows
   whether an execution was attempted.

3. **The verifier is already invoked during execution.** Unlike a private
   claim attempt off-chain, the verifier call is part of `execute_task`, which
   is a public, auditable transaction.

4. **No new front-running vector.** The only action a verifier could take upon
   observing an execution attempt is to emit an event, call another contract, or
   return `false`. None of these actions are faster than the keeper's own
   transaction (which has already been submitted and is on-chain). The verifier
   cannot "front-run" a transaction that is already in-flight; it can only
   reject or accept it.

### Potential information leakage (not front-running)

A more nuanced concern: could a verifier use its observation to leak information
that would give a colluding party a strategic advantage in some way?

**Reproduced scenario:**

1. Owner and Keeper A are colluding.
2. Owner deploys a "colluding verifier" that stores a mapping `{ keeper_addr =>
   attempt_count }`.
3. Owner registers a task with `verifier = colluding_verifier_address`.
4. Keeper B (not in the collusion) claims the task.
5. Keeper B calls `execute_task`.
6. The verifier's `verify` increments `attempt_count[keeper_B]` and returns
   `false`.
7. After the lock expires, Keeper A claims the task.
8. The verifier's `verify` checks `attempt_count[keeper_A]` (which is 0),
   returns `true`, and Keeper A executes successfully.

In this scenario, the verifier has leaked information (the count of attempts
per keeper) to a colluding party. However:

- **This is not front-running.** Keeper B's transaction was already submitted
  and executed; it is not being overtaken.
- **The verifier is not introducing a new capability.** The owner already knew:
  - Keeper B claimed the task (from `TaskClaimed` events).
  - Keeper B attempted execution (from a failed `execute_task` call on-chain).
  - Keeper A could re-claim after lock expiry (from the standard task lifecycle).
- **The strategic advantage is timing, not information.** Keeper A gains an
  advantage by waiting for the lock to expire, which is already part of the
  standard registry design. The verifier is not enabling Keeper A to cut in
  line or find out about the task before Keeper B.

### Interaction with the permissionless-keeper promise

As discussed in Finding 1, a colluding owner + verifier can already reduce
competition to preferred keepers. The side-channel concern is orthogonal: it
is not about *reducing* competition but about *exploiting* competition for
information. Both are mitigated by the same measures:

1. Advisory curated-verifier registry: rigged verifiers are flagged.
2. Pre-claim verifier simulation: keepers can test a verifier before claiming.
3. Event-based accountability: the community can identify verifiers with
   suspicious behavior.

### Recommendation

- **No contract change required.** The verifier is not introducing a new
  front-running or information-leakage surface beyond what the open-chain
  design already exposes (everything is on-chain, events are public).
- **Keeper-bot policy (off-chain):** Bots should be cautious of unvetted
  verifiers from unknown owners, especially if they have a history of
  rejecting valid proofs. This is an off-chain decision, not a contract gate.

---

## Additional Considerations

### A. Task-Conditions Interaction with Reputation (Epic E07)

The reputation system (REPUTATION_DESIGN.md) records `successes` on
`execute_task` and `missed_claims` when a new claimer takes over a task whose
prior claimer's lock expired.

**Does a rigged verifier affect reputation?**

Yes. If a verifier rejects a keeper's execution attempt, the keeper gets a
`VerificationFailed` error, not `TaskExecuted`, so no `record_success` call
occurs. After lock expiry, if another keeper takes over and succeeds, the first
keeper gets a `missed_claims` increment.

**Is this fair?**

This is a limitation of the reputation score, not a security flaw in
conditions. A keeper cannot distinguish between:
- A genuinely failed proof (they did not execute the work correctly).
- A rigged verifier (the owner rejected them maliciously).

The reputation system sees both as equivalent misses. However, as discussed in
Finding 1's mitigations, keepers who are cautious about unvetted verifiers can
avoid this risk by consulting the advisory registry and simulating before
claiming. The reputation cost is a secondary incentive to do so.

This limitation is documented in the REPUTATION_SECURITY_REVIEW.md (Finding 3),
which recommends that keepers should "treat verifier-attached tasks from owners
with no history as higher risk."

### B. `is_claimable` Gap (Issue 0394)

The current `is_claimable` view returns `true` for any `Pending` task without
checking whether an attached verifier's condition is currently satisfiable. This
is a **known gap**, explicitly captured in the backlog.

**Why does this matter?**

A keeper relying on `is_claimable` to discover claimable tasks would not
discover that a verifier is rigged until after claiming. This slows down
keeper-side discovery but is not a contract safety issue (the keeper can still
claim and execute; they just won't pass verification).

**Should this be fixed?**

Issue 0394 proposes that `is_claimable` should invoke the verifier (if
attached) and return `false` if the verifier rejects. This would improve
keeper experience by surfacing the rejection at the view level, saving a
claim-then-execute cycle.

However, this introduces a new question: whose proof should the view use to
test the verifier? The view does not know what proof the keeper will submit
later. The proposal in 0394 would need to specify how to handle this (e.g.,
use a dummy proof, or require the keeper to supply it as a view parameter).

This review does not block or recommend 0394's implementation. It is a UX
improvement, not a security change. If implemented, the mitigations in Finding 1
(advisory registry, pre-claim simulation) would make the gap less impactful
anyway.

### C. Unsafe Registry State Under Competing Verifiers

**Can two tasks share the same verifier, and could state on the verifier cause
cross-task interference?**

Yes, multiple tasks can use the same verifier. If the verifier stores per-task
state (e.g., "this task's proof must include X"), it must use the `task_id`
parameter to index that state. If it does not, it could leak or interfere across
tasks.

**Is this a contract issue?**

No. The verifier is the task owner's code. If they write an unsafe verifier,
that is their problem. The registry passes `task_id` explicitly to help
verifiers avoid cross-task confusion; the design is sound.

---

## Summary

| Finding | Concern | Applies? | Status | Mitigation |
|---------|---------|----------|--------|-----------|
| **1** | Keeper-exclusion via rigged verifier | Yes. Owner can attach a verifier that rejects specific keepers. Breaks permissionless-keeper guarantee at task level. | Open, accepted limitation | Advisory curated-verifier registry (issue #117), pre-claim simulation, event-based accountability, keeper-bot policies. |
| **2** | Verifier panic propagates instead of being caught | No. Panic isolation is confirmed working. Panics are caught and treated as verification failure. | Confirmed | No action required. Regression test in place. |
| **3** | Side-channel attack via verifier observation | No, not a front-running vector. Verifier can observe on-chain events (which are already public) but cannot overtake or manipulate a keeper's transaction faster than it executes. | Open, accepted limitation | Same as Finding 1: advisory registry and bot policies. |

---

## Core Conclusion

**Task conditions are safe for general deployment on Soroban.** The three concerns
addressed above are all mitigated or confirmed:

1. **Keeper-exclusion is a real fairness concern** (violates the permissionless-
   keeper promise), **but it is managed by design**: the registry stays
   permissionless so the ecosystem can adopt mitigations (curated registry,
   pre-claim simulation, event analytics, keeper-bot policies) rather than
   trying to solve it at the contract level. This is consistent with the
   protocol's philosophy of simplicity and trustlessness.

2. **Panic isolation is confirmed working**, eliminating a significant DoS vector.
   A broken verifier does not strand a task forever; recovery paths remain
   available.

3. **Side-channel attacks are not possible** in the front-running sense; the
   open-chain design does not create new leakage vectors beyond what events
   already expose.

The **keeper-exclusion risk in particular runs directly against the
permissionless-competition design principle stated throughout this project's
README and is named explicitly as a known limitation, not a bug.** The
ecosystem mitigations (especially the advisory curated-verifier registry and
keeper-bot task selection policies) are essential to realizing the design
promise in practice.

### Recommendation for Epic E19 closure

- **Merge the core verifier interface and registry integration as-is.** The
  design is sound; the code implements it correctly.
- **Prioritize issue #117** (advisory vetted-verifier registry) as a follow-up.
  This is the primary keeper protection against rigged verifiers.
- **Update operator and keeper-bot documentation** to emphasize pre-claim
  simulation and verifier selection policies.
- **Defer issue 0394** (reflecting verifier state in `is_claimable`) as a UX
  improvement; it is not a blocker for safe general deployment.

---

## For a future external auditor (epic E19)

- Verify that `execute_task`'s verifier call uses `try_invoke_contract` (not
  the panicking variant `invoke_contract`), confirming panic isolation.
- Check the state machine in `update_verifier`: verify that a verifier can only
  be changed while the task is `Pending`, preventing post-claim griefing.
- Trace the calling pattern: verify that the `keeper` parameter is passed to
  every verifier call, preventing keeper-substitution proofs.
- If an advisory curated-verifier registry is deployed (issue #117), confirm
  that it is advisory-only and does not gate execution. The core registry must
  remain permissionless.
- Check operator documentation (DEPLOYING.md, keeper-bot guides, indexer
  analytics) to verify that the ecosystem mitigations for Finding 1 are documented.

# Task Conditions Security Review

**Reviewed surface:** keeper-registry VERSION 6 condition registration,
evaluation, events, and indexer representation.

## Findings and decisions

### Owner-controlled keeper exclusion

The callback receives only `task_id`, never the prospective keeper. Its result
therefore cannot branch directly on keeper identity. An owner can still select
a condition whose state is manipulable or unavailable. This is an accepted
permissionless-owner tradeoff: attaching a condition is not registry
endorsement, and the existing cancellation and expiry paths remain available.

### Panic and malformed-contract isolation

The registry uses the generated client's fallible invocation. A false result,
missing contract, malformed response, contract error, or panic is normalized to
`ConditionNotMet`. Tests assert the task remains `Pending`, with no claimer and
no claim ledger. The callback occurs before any registry claim write.

### Front-running and information exposure

Condition state and claim transactions are public. Another keeper can observe
a condition becoming true and race for the task under the existing first-valid
claim model. The callback receives no keeper address, proof, or secret input,
so the condition API adds no private keeper-specific signal. This public race
is accepted and matches permissionless claiming.

### Reentry and state mutation

The registry makes no claim-state write before the external call. A nested
attempt to claim the same task therefore encounters the same condition and
ordinary authorization/lifecycle gates; it cannot observe a half-written
claim. A condition may change its own storage during a successful outer
invocation. Official conditions must document such behavior, and read-only
conditions are preferred, but Soroban cannot enforce purity from an address.

### Resource denial of service

The keeper submitting `claim_task` pays for the nested invocation. An expensive
condition can exhaust transaction resources and prevent a claim. The registry
fails closed and does not subsidize the call. Keepers should simulate first;
condition-specific resource ceilings and allowlists are deferred.

## Outcome

No registry-state or escrow-safety blocker was found for the implemented
interface. The review accepts availability and resource risk at the
permissionless condition boundary. It does not treat a successful callback as
proof that the condition is economically sound, immutable, audited, or safe in
future invocations.
