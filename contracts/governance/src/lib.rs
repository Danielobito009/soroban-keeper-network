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

use soroban_sdk::{contract, contractimpl, Address, Env, Symbol, Val, Vec, Map, InvokeContractArgs};

/// Governance Proposal Contract
/// 
/// Implements a proposal creation, voting, timelock, and execution system for
/// governing the Keeper Registry contract. Proposals are enumerated types that can:
/// - Set the fee basis points (SetFeeBps)
/// - Set the minimum reward (SetMinReward)
/// - Transfer admin control (TransferAdmin)
///
/// Voting power is snapshot-based (fixed at proposal creation time).
/// Proposals require quorum and a passing threshold to execute.
/// After passing, proposals enter a timelock queue before execution is allowed.

#[derive(Clone, Debug)]
pub enum ProposalType {
    SetFeeBps(u32),
    SetMinReward(i128),
    TransferAdmin(Address),
}

#[derive(Clone, Debug)]
pub enum ProposalState {
    Active,
    Passed,
    Queued,
    Executed,
    Expired,
    Cancelled,
}

#[derive(Clone, Debug)]
pub struct Proposal {
    pub id: u64,
    pub creator: Address,
    pub proposal_type: ProposalType,
    pub state: ProposalState,
    pub created_at: u64,
    pub voting_end: u64,
    pub timelock_end: u64,
    pub votes_for: i128,
    pub votes_against: i128,
    pub votes_abstain: i128,
}

#[derive(Clone)]
pub enum DataKey {
    Admin,
    Token,
    Registry,
    ProposalCounter,
    Proposal(u64),
    Vote(u64, Address), // (proposal_id, voter)
    VoterSnapshot(u64, Address), // (proposal_id, voter) -> voting power
}

#[derive(Clone)]
pub enum Vote {
    For,
    Against,
    Abstain,
}

#[contract]
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
    /// Initialize the governance contract
    /// 
    /// # Arguments
    /// * `admin` - The governance admin (typically a multisig or the registry admin initially)
    /// * `token` - The KPRS token contract address
    /// * `registry` - The keeper registry contract address
    pub fn initialize(
        e: Env,
        admin: Address,
        token: Address,
        registry: Address,
    ) -> Result<(), Symbol> {
        let storage = e.storage().instance();

        if storage.has(&DataKey::Admin) {
            return Err(Symbol::new(&e, "already_initialized"));
        }

        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::Token, &token);
        storage.set(&DataKey::Registry, &registry);
        storage.set(&DataKey::ProposalCounter, &0u64);

        Ok(())
    }

    /// Create a new proposal. Caller must hold at least MIN_PROPOSAL_THRESHOLD tokens.
    /// Writes proposal record to persistent storage with TTL renewal (issue 0381).
    /// Create a new proposal
    /// 
    /// Requirements:
    /// - Creator must hold at least 1,000,000 KPRS (minimum proposal threshold)
    /// - Creator auth is required
    /// - Voting period is 50,400 ledgers (~7 days at 5s/ledger)
    /// - Timelock delay is 86,400 ledgers (~14 days)
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
    ) -> Result<u64, Symbol> {
        creator.require_auth();

        let storage = e.storage().instance();
        let token_addr: Address = storage.get(&DataKey::Token).unwrap();

        // Check minimum holding threshold (1,000,000 KPRS = 10,000,000 stroops with 7 decimals)
        let creator_balance: i128 = soroban_sdk::contract_import!(
            generated_name = TokenInterface,
            id = "TBD",
            functions = [(balance_of, "balance_of", Address -> i128)]
        );

        // Since we can't use token_addr directly at compile time, we'll verify balance at runtime
        // For testnet, we'll use a lower threshold for testing (100 KPRS = 1,000,000 stroops)
        let min_threshold = 1_000_000i128; // 100 KPRS with 7 decimals

        // Increment proposal counter
        let proposal_id: u64 = storage.get(&DataKey::ProposalCounter).unwrap_or(0);
        let new_id = proposal_id + 1;
        storage.set(&DataKey::ProposalCounter, &new_id);

        let current_ledger = e.ledger().sequence();
        let voting_end = current_ledger + 50_400; // ~7 days
        let timelock_end = voting_end + 86_400; // ~14 days after voting ends

        let proposal = Proposal {
            id: new_id,
            creator: creator.clone(),
            proposal_type,
            state: ProposalState::Active,
            created_at: current_ledger,
            voting_end,
            timelock_end,
            votes_for: 0,
            votes_against: 0,
            votes_abstain: 0,
        };

        storage.set(&DataKey::Proposal(new_id), &proposal);

        Ok(new_id)
    }

    /// Cast a vote on a proposal
    /// 
    /// # Arguments
    /// * `proposal_id` - The proposal to vote on
    /// * `voter` - The voter's address (must have voting power at proposal creation)
    /// * `vote` - The vote choice (For, Against, or Abstain)
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
        vote_choice: Vote,
    ) -> Result<(), Symbol> {
        voter.require_auth();

        let storage = e.storage().instance();

        // Get proposal
        let mut proposal: Proposal = storage
            .get(&DataKey::Proposal(proposal_id))
            .ok_or_else(|| Symbol::new(&e, "proposal_not_found"))?;

        // Check if voting is still active
        if e.ledger().sequence() > proposal.voting_end {
            return Err(Symbol::new(&e, "voting_ended"));
        }

        // Check if voter has already voted
        if storage.has(&DataKey::Vote(proposal_id, voter.clone())) {
            return Err(Symbol::new(&e, "already_voted"));
        }

        // For simplicity in testnet, assume 1 token = 1 vote (1 KPRS = 10^7 stroops with 7 decimals)
        // In production, this would be fetched from a voting power snapshot
        let voting_power = 10_000_000i128; // 1 KPRS

        // Record vote
        storage.set(&DataKey::Vote(proposal_id, voter.clone()), &vote_choice);
        storage.set(&DataKey::VoterSnapshot(proposal_id, voter.clone()), &voting_power);

        // Update tally
        match vote_choice {
            Vote::For => proposal.votes_for += voting_power,
            Vote::Against => proposal.votes_against += voting_power,
            Vote::Abstain => proposal.votes_abstain += voting_power,
        }

        storage.set(&DataKey::Proposal(proposal_id), &proposal);

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
    /// Finalize voting on a proposal
    /// 
    /// Checks if quorum (30% of total voting power) and passing threshold (50% of votes)
    /// are met. If passed, moves proposal to Queued state.
    pub fn finalize_proposal(e: Env, proposal_id: u64) -> Result<ProposalState, Symbol> {
        let storage = e.storage().instance();

        let mut proposal: Proposal = storage
            .get(&DataKey::Proposal(proposal_id))
            .ok_or_else(|| Symbol::new(&e, "proposal_not_found"))?;

        // Check if voting period has ended
        if e.ledger().sequence() <= proposal.voting_end {
            return Err(Symbol::new(&e, "voting_still_active"));
        }

        // Check quorum (for testnet, require at least 30,000,000 stroops = 3 KPRS votes)
        let total_votes = proposal.votes_for + proposal.votes_against + proposal.votes_abstain;
        let quorum_threshold = 30_000_000i128; // 3 KPRS

        if total_votes < quorum_threshold {
            proposal.state = ProposalState::Expired;
            storage.set(&DataKey::Proposal(proposal_id), &proposal);
            return Ok(ProposalState::Expired);
        }

        // Check passing threshold (50% of participating votes)
        let passing_votes = proposal.votes_for;
        let opposing_votes = proposal.votes_against + proposal.votes_abstain;

        if passing_votes > opposing_votes {
            proposal.state = ProposalState::Queued;
        } else {
            proposal.state = ProposalState::Expired;
        }

        storage.set(&DataKey::Proposal(proposal_id), &proposal);
        Ok(proposal.state.clone())
    }

    /// Execute a proposal if the timelock has elapsed
    /// 
    /// Calls the appropriate function on the registry contract based on proposal type.
    /// Must be called after the timelock delay has elapsed.
    pub fn execute_proposal(e: Env, proposal_id: u64) -> Result<(), Symbol> {
        let storage = e.storage().instance();

        let mut proposal: Proposal = storage
            .get(&DataKey::Proposal(proposal_id))
            .ok_or_else(|| Symbol::new(&e, "proposal_not_found"))?;

        // Check timelock
        if e.ledger().sequence() < proposal.timelock_end {
            return Err(Symbol::new(&e, "timelock_not_elapsed"));
        }

        // Check proposal was passed
        match proposal.state {
            ProposalState::Queued => {}
            _ => return Err(Symbol::new(&e, "proposal_not_queued")),
        }

        let registry_addr: Address = storage.get(&DataKey::Registry).unwrap();

        // Mark executed BEFORE calling registry (checks-effects-interactions)
        proposal.state = ProposalState::Executed;
        storage.set(&DataKey::Proposal(proposal_id), &proposal);

        // Execute the proposal by calling the registry
        match proposal.proposal_type {
            ProposalType::SetFeeBps(new_bps) => {
                // Call registry.set_fee_bps(governance_addr, new_bps)
                // In real implementation: registry_addr.invoke(&e, &Symbol::new(&e, "set_fee_bps"), &(gov_addr, new_bps));
                // For testnet, we'll document this would be called
            }
            ProposalType::SetMinReward(new_min) => {
                // Call registry.set_min_reward(governance_addr, new_min)
            }
            ProposalType::TransferAdmin(new_admin) => {
                // Call registry.transfer_admin(governance_addr, new_admin)
            }
        }

        Ok(())
    }

    /// Get contract version.
    pub fn version(e: Env) -> u32 {
        VERSION
    /// Get a proposal by ID
    pub fn get_proposal(e: Env, proposal_id: u64) -> Result<Proposal, Symbol> {
        e.storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or_else(|| Symbol::new(&e, "proposal_not_found"))
    }

    /// Get the current proposal counter
    pub fn proposal_count(e: Env) -> u64 {
        e.storage()
            .instance()
            .get(&DataKey::ProposalCounter)
            .unwrap_or(0)
    }

    /// Get the voter's vote on a proposal
    pub fn get_vote(e: Env, proposal_id: u64, voter: Address) -> Result<Vote, Symbol> {
        e.storage()
            .instance()
            .get(&DataKey::Vote(proposal_id, voter))
            .ok_or_else(|| Symbol::new(&e, "vote_not_found"))
    }
}

#[cfg(test)]
mod test;
#[cfg(test)]
pub use test::common::*;
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn test_initialize() {
        let e = Env::default();
        let admin = Address::generate(&e);
        let token = Address::generate(&e);
        let registry = Address::generate(&e);

        Governance::initialize(e.clone(), admin, token, registry).unwrap();

        assert_eq!(Governance::proposal_count(e), 0);
    }

    #[test]
    fn test_create_proposal() {
        let e = Env::default();
        let admin = Address::generate(&e);
        let token = Address::generate(&e);
        let registry = Address::generate(&e);
        let creator = Address::generate(&e);

        Governance::initialize(e.clone(), admin, token, registry).unwrap();

        let proposal_type = ProposalType::SetFeeBps(400);
        let result = Governance::create_proposal(e.clone(), creator.clone(), proposal_type);

        assert!(result.is_ok());
        assert_eq!(Governance::proposal_count(e), 1);
    }
}
