# Issue #509: Governance TTL Renewal Implementation Summary

## Overview

This implementation fulfills **issue 0381** acceptance criteria: ensuring proposal and vote-record storage entries are correctly TTL-renewed on write, so a long-running vote or queued timelock does not risk archival before it resolves.

The solution follows the exact discipline established by:
- **Issue 0312** (staking storage TTL)
- **Issue 0332** (reputation storage TTL)

## Architecture

### Storage Layout (Issue 0362 Decision)

**Instance Storage** (renewed via `bump_instance()` on every mutation):
- `TokenAddress` — KPRS token contract address
- `VotingPeriodLedgers` — voting period duration
- `TimelockLedgers` — timelock delay duration
- `QuorumBps` — quorum threshold in basis points
- `PassingThresholdBps` — passing threshold in basis points
- `ProposalCounter` — next proposal ID

**Persistent Storage** (renewed via `extend_persistent_ttl()` after each `set()`):
- `Proposal(u64)` — keyed by proposal_id, contains full proposal state
- `VoteRecord(u64, Address)` — keyed by (proposal_id, voter), tracks who voted
- `ProposalTally(u64)` — keyed by proposal_id, caches vote tallies for fast reads

### TTL Constants

Mirrors keeper-registry pattern exactly:

```rust
// Persistent storage renewal window
GOVERNANCE_STORAGE_BUMP_LEDGERS: u32 = 100_000;      // ~6 days at 5s/ledger
GOVERNANCE_STORAGE_BUMP_THRESHOLD: u32 = 50_000;     // renew when <50k remain

// Instance storage renewal window (via bump_instance)
INSTANCE_BUMP_LEDGERS: u32 = 100_000;
INSTANCE_BUMP_THRESHOLD: u32 = 50_000;
```

## Critical TTL Renewal Points

Every write to proposal or vote storage is immediately followed by `extend_persistent_ttl()`:

### 1. Proposal Creation (`create_proposal`)
```rust
let key = GovernanceDataKey::Proposal(proposal_id);
e.storage().persistent().set(&key, &proposal);
extend_persistent_ttl(&e, &key);  // ← CRITICAL (Issue 0381)

let tally_key = GovernanceDataKey::ProposalTally(proposal_id);
e.storage().persistent().set(&tally_key, &tally);
extend_persistent_ttl(&e, &tally_key);  // ← CRITICAL (Issue 0381)
```

### 2. Voting (`vote`)
Renews three keys:
- Vote record: `VoteRecord(proposal_id, voter)` → `extend_persistent_ttl()`
- Tally: `ProposalTally(proposal_id)` → `extend_persistent_ttl()`
- Proposal (re-write): `Proposal(proposal_id)` → `extend_persistent_ttl()`

All three entries renewed on every vote ensures:
- Individual vote-to-vote mapping survives voting period
- Cached tally stays accessible throughout voting
- Proposal metadata stays live during active voting

### 3. Execution (`execute_proposal`)
```rust
proposal.status = ProposalStatus::Executed;
e.storage().persistent().set(&key, &proposal);
extend_persistent_ttl(&e, &key);  // ← CRITICAL (Issue 0381)
```

Final state mutation renews proposal one last time, ensuring execution record persists.

## Compliance with Acceptance Criteria

### Criterion 1: Every write renews TTL appropriately

✅ **All persistent-storage writes followed by `extend_persistent_ttl()`:**
- `create_proposal`: proposal + tally written
- `vote`: vote record + tally + proposal written
- `execute_proposal`: proposal written (final state)

Each `extend_persistent_ttl()` call uses:
- **Threshold**: `GOVERNANCE_STORAGE_BUMP_THRESHOLD` (50_000 ledgers)
- **Duration**: `GOVERNANCE_STORAGE_BUMP_LEDGERS` (100_000 ledgers)

Instance-storage keys renewed via `bump_instance()` on all state mutations.

### Criterion 2: Test spans full voting period + timelock with no archival

Four regression tests in `src/test/ttl.rs`:

1. **`test_proposal_ttl_survives_full_voting_and_timelock_lifecycle`**
   - Creates proposal
   - Advances to near-TTL expiry (crosses threshold)
   - Votes (renews proposal + tally TTL)
   - Advances well past original TTL window (~6 days)
   - Verifies proposal still readable and executable
   - **Proves**: Proposal survives full lifecycle without archival

2. **`test_repeated_votes_renew_proposal_and_tally_ttl`**
   - Multiple votes spaced across the lifecycle
   - Each vote renews both proposal and tally TTL
   - Advances past total TTL window between votes
   - **Proves**: Active voting keeps all entries live

3. **`test_execute_proposal_renews_ttl_on_final_state_mutation`**
   - Creation → voting → timelock → execution
   - Execute call renews proposal TTL one final time
   - **Proves**: Final state mutation has TTL coverage

4. **`test_proposal_survives_silent_period_then_executes`**
   - Creation → advance past voting → single vote near boundary → long silence
   - Demonstrates TTL survives with minimal renewal activity
   - **Proves**: Edge case of low-activity proposals

## Test Harness

`test/common.rs` provides:
- `TestEnv`: harness with initialized governance + mock KPRS token
- `setup()`: creates contract, token, initializes governance
- `advance(env, ledgers)`: advances simulated ledger
- `voter_with_balance()`: creates voter with specified token balance

Test pattern matches keeper-registry's TTL regression tests (issues 0122, 0312, 0332).

## Files Delivered

```
contracts/governance/
├── Cargo.toml                    # Package manifest, soroban-sdk 20.0
├── src/
│   ├── lib.rs                    # Main contract (Governance impl)
│   ├── constants.rs              # TTL + governance constants
│   ├── types.rs                  # GovernanceDataKey, Proposal, VoteTally, etc.
│   ├── errors.rs                 # GovernanceError enum
│   ├── internal.rs               # bump_instance(), extend_persistent_ttl(), config readers
│   └── test/
│       ├── mod.rs                # Test module organization
│       ├── common.rs             # setup(), advance(), voter_with_balance()
│       └── ttl.rs                # 4 TTL regression tests
└── TTL_IMPLEMENTATION_SUMMARY.md # This document
```

## Entry Points Summary

| Entry Point | Instance Bumped | Persistent TTL Renewed | Keys Renewed |
|---|---|---|---|
| `initialize` | ✓ | — | (config only, instance) |
| `create_proposal` | ✓ | ✓ | Proposal, ProposalTally |
| `vote` | ✓ | ✓ | VoteRecord, ProposalTally, Proposal |
| `execute_proposal` | ✓ | ✓ | Proposal |
| `queue_proposal` (internal) | ✓ | ✓ | Proposal |

## Key Design Decisions

1. **Persistent-first for proposals/votes**: Long-lived entries (days/weeks) must use persistent storage with explicit TTL renewal, not instance storage.

2. **Tally caching**: Vote counts cached in `ProposalTally` to avoid iterating individual `VoteRecord` entries. Tally renewed on every vote.

3. **Repeated proposal writes**: `vote()` re-writes the proposal record even though it doesn't modify it, triggering TTL renewal. This ensures the proposal stays live during active voting without requiring a separate "heartbeat" transaction.

4. **No separate vote-renewal transaction needed**: Every vote simultaneously renews vote record, tally, AND proposal TTL, providing triple coverage in a single user action.

## Relationship to Other Issues

- **Issue 0360** (design doc): Specifies governance architecture; this impl provides storage strategy
- **Issue 0362** (scaffolding): This impl IS the scaffolding with full proposal/vote lifecycle
- **Issue 0363** (proposal creation): Fully implemented with TTL renewal
- **Issue 0364** (voting): Fully implemented with TTL renewal, vote-duplicate prevention, tally tracking
- **Issue 0365** (quorum/passing): VoteTally.is_passed() implements both checks
- **Issue 0366** (timelock): Proposal.can_execute() checks timelock elapsed
- **Issue 0367** (execution): execute_proposal() with TTL renewal on final state mutation
- **Issue 0312/0332** (TTL patterns): This impl mirrors exact pattern for consistency

## Verification Checklist

- ✅ Every persistent storage write followed by `extend_persistent_ttl()`
- ✅ Instance storage bumped on all state mutations
- ✅ TTL constants match keeper-registry (100_000 / 50_000 ledgers)
- ✅ Test advances past full GOVERNANCE_STORAGE_BUMP_LEDGERS window
- ✅ Test confirms proposal accessible and executable throughout lifecycle
- ✅ Test covers proposal + tally + vote record entries
- ✅ Test spans voting period + timelock + execution
- ✅ No archival risk during any phase

## Future Extensions

This implementation provides the foundation for:
- Issue 0369: Event emission on proposal state transitions
- Issue 0370: View methods for governance queries
- Issue 0371: Reentrancy review (currently no cross-contract calls)
- Issue 0373-0380: Property tests, fuzz targets, SDK bindings, indexer schema

All downstream work inherits the TTL safety guarantees established here.
