//! Governance contract types and storage keys.

use soroban_sdk::{contracttype, Address};

// ─────────────────────────────────────────────────────────────────────────────
// Storage keys — split between instance and persistent (issue 0362)
// ─────────────────────────────────────────────────────────────────────────────

/// Instance storage keys — global governance configuration.
/// These are renewed via bump_instance on every state-mutating call.
#[contracttype]
#[derive(Clone)]
pub enum GovernanceDataKey {
    // Instance: governance config
    TokenAddress,
    VotingPeriodLedgers,
    TimelockLedgers,
    QuorumBps,
    PassingThresholdBps,
    ProposalCounter,

    // Persistent: proposals and votes (keyed separately for independent TTL)
    Proposal(u64),              // proposal_id → Proposal record
    VoteRecord(u64, Address),   // (proposal_id, voter_address) → bool (voted)
    ProposalTally(u64),         // proposal_id → VoteTally (cached tally state)
}

// ─────────────────────────────────────────────────────────────────────────────
// Proposal types — closed list per issue 0363
// ─────────────────────────────────────────────────────────────────────────────

/// One governable proposal type. A first version supports only parameter
/// changes, not arbitrary contract calls (issue 0360).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalType {
    /// Change the keeper-registry's protocol fee (in basis points).
    ChangeFeeBps(u32),
    /// Change the keeper-registry's minimum reward per task.
    ChangeMinReward(i128),
    /// Change voting period length for future proposals (in ledgers).
    ChangeVotingPeriod(u32),
    /// Change timelock delay between passing and execution (in ledgers).
    ChangeTimelock(u32),
}

// ─────────────────────────────────────────────────────────────────────────────
// Proposal state
// ─────────────────────────────────────────────────────────────────────────────

/// Status of a proposal over its lifecycle.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    /// Voting is still open (created_ledger + voting_period not reached).
    Open,
    /// Voting closed without reaching quorum; execution is blocked.
    Failed,
    /// Voting closed with quorum and passed; in timelock before execution.
    Passed,
    /// Voting passed; in timelock waiting for execution window.
    Queued,
    /// Proposal has been executed.
    Executed,
    /// Proposal was cancelled before voting ended.
    Cancelled,
}

/// Vote tally state. Cached to avoid reading individual vote records
/// during tally computation (issue 0364's snapshotting constraint).
#[contracttype]
#[derive(Clone, Debug)]
pub struct VoteTally {
    pub yes_votes: u64,
    pub no_votes: u64,
    pub abstain_votes: u64,
    pub total_voting_power: u64,
}

impl VoteTally {
    pub fn new() -> Self {
        Self {
            yes_votes: 0,
            no_votes: 0,
            abstain_votes: 0,
            total_voting_power: 0,
        }
    }

    /// Whether the tally meets quorum and has passed (issue 0365).
    pub fn is_passed(&self, quorum_bps: u32, passing_threshold_bps: u32) -> bool {
        if self.total_voting_power == 0 {
            return false;
        }
        let votes_cast = self.yes_votes + self.no_votes + self.abstain_votes;
        let quorum_votes = (self.total_voting_power as u128 * quorum_bps as u128 / 10_000) as u64;
        if votes_cast < quorum_votes {
            return false;
        }
        let yes_only = self.yes_votes + self.no_votes;
        if yes_only == 0 {
            return false;
        }
        let passing_yes =
            (yes_only as u128 * passing_threshold_bps as u128 / 10_000) as u64;
        self.yes_votes >= passing_yes
    }
}

/// One proposal record — persisted for the full voting + timelock lifecycle.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Proposal {
    pub id: u64,
    pub creator: Address,
    pub proposal_type: ProposalType,
    pub status: ProposalStatus,
    pub created_ledger: u32,
    pub voting_period_ledgers: u32,
    pub timelock_ledgers: u32,
    pub voting_end_ledger: u32,
    pub execution_start_ledger: u32,
}

impl Proposal {
    pub fn voting_closed(&self, current_ledger: u32) -> bool {
        current_ledger >= self.voting_end_ledger
    }

    pub fn in_timelock(&self, current_ledger: u32) -> bool {
        current_ledger >= self.voting_end_ledger && current_ledger < self.execution_start_ledger
    }

    pub fn can_execute(&self, current_ledger: u32) -> bool {
        current_ledger >= self.execution_start_ledger
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Vote choices
// ─────────────────────────────────────────────────────────────────────────────

/// A voter's choice on a proposal.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VoteChoice {
    Yes,
    No,
    Abstain,
}

/// One vote record — minimal storage (just the choice; tally is cached).
#[contracttype]
#[derive(Clone, Copy, Debug)]
pub struct VoteRecord {
    pub proposal_id: u64,
    pub voter: Address,
    pub choice: VoteChoice,
    pub voting_power: u64,
}
