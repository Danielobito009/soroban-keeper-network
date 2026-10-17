#![no_std]

//! Governance contract for the Soroban Keeper Network.
//!
//! Implements proposal creation, voting, and execution with explicit TTL renewal
//! on all storage writes (issue 0381), following the pattern established by
//! staking (issue 0312) and reputation (issue 0332) storage.
//!
//! Storage layout (issue 0362):
//! - Instance storage: global governance config (voting period, timelock, token address)
//! - Persistent storage: individual proposals and vote records
//!
//! TTL renewal strategy:
//! - Instance: bumped via bump_instance() on every state-mutating call
//! - Persistent: extended via extend_ttl() immediately after set() on proposals/votes

mod constants;
mod errors;
mod internal;
mod types;

pub use constants::*;
pub use errors::GovernanceError;
pub use types::*;

use soroban_sdk::{contractimpl, Address, Env, Symbol};

use internal::*;
use types::*;

// ─────────────────────────────────────────────────────────────────────────────
// Contract implementation
// ─────────────────────────────────────────────────────────────────────────────

pub struct Governance;

#[contractimpl]
impl Governance {
    /// Initialize the governance contract with the KPRS token address.
    /// Sets up instance storage with default voting parameters.
    pub fn initialize(e: Env, token_address: Address) -> Result<(), GovernanceError> {
        bump_instance(&e);

        e.storage()
            .instance()
            .set(&GovernanceDataKey::TokenAddress, &token_address);
        e.storage()
            .instance()
            .set(&GovernanceDataKey::VotingPeriodLedgers, &DEFAULT_VOTING_PERIOD_LEDGERS);
        e.storage()
            .instance()
            .set(&GovernanceDataKey::TimelockLedgers, &DEFAULT_TIMELOCK_LEDGERS);
        e.storage()
            .instance()
            .set(&GovernanceDataKey::QuorumBps, &DEFAULT_QUORUM_BPS);
        e.storage()
            .instance()
            .set(&GovernanceDataKey::PassingThresholdBps, &DEFAULT_PASSING_THRESHOLD_BPS);
        e.storage()
            .instance()
            .set(&GovernanceDataKey::ProposalCounter, &0u64);

        Ok(())
    }

    /// Create a new proposal. Caller must hold at least MIN_PROPOSAL_THRESHOLD tokens.
    /// Writes proposal record to persistent storage with TTL renewal (issue 0381).
    pub fn create_proposal(
        e: Env,
        creator: Address,
        proposal_type: ProposalType,
    ) -> Result<u64, GovernanceError> {
        require_initialized(&e)?;
        bump_instance(&e);

        creator.require_auth();

        // Check creator has sufficient holdings (issue 0363).
        let balance = voter_balance(&e, &creator)?;
        if balance < MIN_PROPOSAL_THRESHOLD {
            return Err(GovernanceError::InsufficientHoldings);
        }

        let proposal_id = next_proposal_id(&e);
        let current_ledger = e.ledger().sequence();
        let voting_period = voting_period_ledgers(&e);
        let timelock = timelock_ledgers(&e);

        let proposal = Proposal {
            id: proposal_id,
            creator,
            proposal_type,
            status: ProposalStatus::Open,
            created_ledger: current_ledger,
            voting_period_ledgers: voting_period,
            timelock_ledgers: timelock,
            voting_end_ledger: current_ledger + voting_period,
            execution_start_ledger: current_ledger + voting_period + timelock,
        };

        let key = GovernanceDataKey::Proposal(proposal_id);
        e.storage().persistent().set(&key, &proposal);
        // ─── CRITICAL TTL RENEWAL (issue 0381) ───
        // Every write to proposal storage must renew its TTL immediately.
        extend_persistent_ttl(&e, &key);

        // Initialize tally for this proposal.
        let tally = VoteTally::new();
        let tally_key = GovernanceDataKey::ProposalTally(proposal_id);
        e.storage().persistent().set(&tally_key, &tally);
        extend_persistent_ttl(&e, &tally_key);

        Ok(proposal_id)
    }

    /// Cast a vote on an open proposal.
    /// Writes vote record to persistent storage with TTL renewal (issue 0381).
    pub fn vote(
        e: Env,
        proposal_id: u64,
        voter: Address,
        choice: VoteChoice,
    ) -> Result<(), GovernanceError> {
        require_initialized(&e)?;
        bump_instance(&e);

        voter.require_auth();

        // Load proposal.
        let proposal_key = GovernanceDataKey::Proposal(proposal_id);
        let mut proposal: Proposal = e
            .storage()
            .persistent()
            .get(&proposal_key)
            .ok_or(GovernanceError::ProposalNotFound)?;

        // Check voting is open.
        let current_ledger = e.ledger().sequence();
        if proposal.voting_closed(current_ledger) {
            return Err(GovernanceError::VotingClosed);
        }

        // Check voter hasn't already voted.
        let vote_key = GovernanceDataKey::VoteRecord(proposal_id, voter.clone());
        if e.storage().persistent().has(&vote_key) {
            return Err(GovernanceError::AlreadyVoted);
        }

        // Get voter's token balance (voting power).
        let voting_power = voter_balance(&e, &voter)? as u64;

        // Record the vote.
        e.storage().persistent().set(&vote_key, &true);
        // ─── CRITICAL TTL RENEWAL (issue 0381) ───
        extend_persistent_ttl(&e, &vote_key);

        // Update tally.
        let tally_key = GovernanceDataKey::ProposalTally(proposal_id);
        let mut tally: VoteTally = e
            .storage()
            .persistent()
            .get(&tally_key)
            .ok_or(GovernanceError::ProposalNotFound)?;

        match choice {
            VoteChoice::Yes => tally.yes_votes = tally.yes_votes.saturating_add(voting_power),
            VoteChoice::No => tally.no_votes = tally.no_votes.saturating_add(voting_power),
            VoteChoice::Abstain => {
                tally.abstain_votes = tally.abstain_votes.saturating_add(voting_power)
            }
        }
        tally.total_voting_power = tally.total_voting_power.saturating_add(voting_power);

        e.storage().persistent().set(&tally_key, &tally);
        // ─── CRITICAL TTL RENEWAL (issue 0381) ───
        extend_persistent_ttl(&e, &tally_key);

        // Renew proposal's TTL since it was accessed and tally was modified.
        e.storage().persistent().set(&proposal_key, &proposal);
        extend_persistent_ttl(&e, &proposal_key);

        Ok(())
    }

    /// Get the current vote tally for a proposal.
    pub fn get_tally(e: Env, proposal_id: u64) -> Result<VoteTally, GovernanceError> {
        require_initialized(&e)?;

        let tally_key = GovernanceDataKey::ProposalTally(proposal_id);
        e.storage()
            .persistent()
            .get(&tally_key)
            .ok_or(GovernanceError::ProposalNotFound)
    }

    /// Get a proposal's current state.
    pub fn get_proposal(e: Env, proposal_id: u64) -> Result<Proposal, GovernanceError> {
        require_initialized(&e)?;

        let key = GovernanceDataKey::Proposal(proposal_id);
        e.storage()
            .persistent()
            .get(&key)
            .ok_or(GovernanceError::ProposalNotFound)
    }

    /// Mark a proposal as passed and move it into timelock (internal state transition).
    /// Called internally when voting closes; updates proposal status with TTL renewal (issue 0381).
    pub(crate) fn queue_proposal(e: Env, proposal_id: u64) -> Result<(), GovernanceError> {
        bump_instance(&e);

        let key = GovernanceDataKey::Proposal(proposal_id);
        let mut proposal: Proposal = e
            .storage()
            .persistent()
            .get(&key)
            .ok_or(GovernanceError::ProposalNotFound)?;

        proposal.status = ProposalStatus::Queued;
        e.storage().persistent().set(&key, &proposal);
        // ─── CRITICAL TTL RENEWAL (issue 0381) ───
        extend_persistent_ttl(&e, &key);

        Ok(())
    }

    /// Execute a proposal after its timelock has elapsed.
    /// Final state mutation with TTL renewal (issue 0381).
    pub fn execute_proposal(
        e: Env,
        proposal_id: u64,
    ) -> Result<(), GovernanceError> {
        require_initialized(&e)?;
        bump_instance(&e);

        let key = GovernanceDataKey::Proposal(proposal_id);
        let mut proposal: Proposal = e
            .storage()
            .persistent()
            .get(&key)
            .ok_or(GovernanceError::ProposalNotFound)?;

        // Check proposal is ready for execution.
        let current_ledger = e.ledger().sequence();
        if !proposal.can_execute(current_ledger) {
            return Err(GovernanceError::CannotExecute);
        }

        // Check proposal has passed (quorum and threshold met).
        let tally_key = GovernanceDataKey::ProposalTally(proposal_id);
        let tally: VoteTally = e
            .storage()
            .persistent()
            .get(&tally_key)
            .ok_or(GovernanceError::ProposalNotFound)?;

        if !tally.is_passed(quorum_bps(&e), passing_threshold_bps(&e)) {
            return Err(GovernanceError::ProposalNotPassed);
        }

        if proposal.status == ProposalStatus::Executed {
            return Err(GovernanceError::AlreadyExecuted);
        }

        // Execute the proposal (placeholder — actual execution is out of scope for TTL issue).
        proposal.status = ProposalStatus::Executed;
        e.storage().persistent().set(&key, &proposal);
        // ─── CRITICAL TTL RENEWAL (issue 0381) ───
        extend_persistent_ttl(&e, &key);

        Ok(())
    }

    /// Get contract version.
    pub fn version(e: Env) -> u32 {
        VERSION
    }
}

#[cfg(test)]
mod test;
#[cfg(test)]
pub use test::common::*;
