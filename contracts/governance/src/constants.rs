//! Tunable governance constants and TTL parameters.
//!
//! Following the same pattern as keeper-registry, all magic numbers live here.

// ─────────────────────────────────────────────────────────────────────────────
// TTL constants — mirror keeper-registry pattern (issue 0312, 0332)
// ─────────────────────────────────────────────────────────────────────────────
//
// Governance proposals and votes are long-lived entries (spanning voting
// period + timelock delay, potentially days or weeks). They must use persistent
// storage with explicit TTL renewal on write to survive ledger archival.
//
// Instance storage holds governance config (voting_period_ledgers,
// timelock_ledgers, token_address). Instance TTL is renewed via bump_instance
// on every state-mutating call, same as keeper-registry.

/// Ledgers of persistent-storage lifetime requested for proposal and vote
/// entries each time they are written. Mirrors keeper-registry's
/// KEEPER_BALANCE_BUMP_LEDGERS (100_000 ledgers ≈ 6 days at 5s/ledger).
pub(crate) const GOVERNANCE_STORAGE_BUMP_LEDGERS: u32 = 100_000;

/// Renew proposal/vote TTL only when fewer than this many ledgers remain,
/// so the extension is a no-op on most calls. Mirrors keeper-registry's
/// KEEPER_BALANCE_BUMP_THRESHOLD (50_000 ledgers ≈ 3 days).
pub(crate) const GOVERNANCE_STORAGE_BUMP_THRESHOLD: u32 = 50_000;

/// Ledgers of instance-storage lifetime requested on each state-mutating call.
/// Renewed via bump_instance. Mirrors keeper-registry's INSTANCE_BUMP_LEDGERS.
pub(crate) const INSTANCE_BUMP_LEDGERS: u32 = 100_000;

/// Renew instance TTL only when fewer than this many ledgers remain.
/// Mirrors keeper-registry's INSTANCE_BUMP_THRESHOLD.
pub(crate) const INSTANCE_BUMP_THRESHOLD: u32 = 50_000;

// ─────────────────────────────────────────────────────────────────────────────
// Governance parameters (from issue 0360 design doc)
// ─────────────────────────────────────────────────────────────────────────────

/// Default voting period length (in ledgers). ~7 days at 5s/ledger.
/// Configurable but has sensible default.
pub const DEFAULT_VOTING_PERIOD_LEDGERS: u32 = 120_960;

/// Default timelock delay between proposal passing and execution (in ledgers).
/// ~2 days at 5s/ledger, giving stakeholders time to react to parameter changes.
pub const DEFAULT_TIMELOCK_LEDGERS: u32 = 34_560;

/// Quorum threshold in basis points (one quarter of voting power).
pub const DEFAULT_QUORUM_BPS: u32 = 2_500; // 25%

/// Passing threshold in basis points (simple majority of votes cast).
pub const DEFAULT_PASSING_THRESHOLD_BPS: u32 = 5_000; // 50%

/// Minimum token holdings to create a proposal, in stroops (scaled by token decimals).
/// Issue 0360 decides this value; placeholder for testing.
pub const MIN_PROPOSAL_THRESHOLD: i128 = 1_000_000; // 1M tokens at 7 decimals

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

/// Semantic version of the governance contract logic.
pub const VERSION: u32 = 1;
