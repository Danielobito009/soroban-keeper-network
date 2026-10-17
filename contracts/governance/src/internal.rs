//! Internal helpers shared by the contract's entry points.

use soroban_sdk::{token, Address, Env, Symbol};

use crate::constants::*;
use crate::errors::GovernanceError;
use crate::types::GovernanceDataKey;

// ─────────────────────────────────────────────────────────────────────────────
// Instance TTL renewal — mirrors keeper-registry's bump_instance pattern
// ─────────────────────────────────────────────────────────────────────────────

/// Renews instance-storage TTL on every state-mutating entry point.
/// Governance config (voting period, timelock, token address) is instance storage.
/// Called from every mutation to keep the contract alive during active voting.
pub(crate) fn bump_instance(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_LEDGERS);
}

// ─────────────────────────────────────────────────────────────────────────────
// Governance initialization checks
// ─────────────────────────────────────────────────────────────────────────────

/// Checks if governance has been initialized (token_address is set).
pub(crate) fn is_initialized(e: &Env) -> bool {
    e.storage()
        .instance()
        .get::<_, Address>(&GovernanceDataKey::TokenAddress)
        .is_ok()
}

/// Requires the contract to be initialized; fails with NotInitialized if not.
pub(crate) fn require_initialized(e: &Env) -> Result<(), GovernanceError> {
    if is_initialized(e) {
        Ok(())
    } else {
        Err(GovernanceError::NotInitialized)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistent storage TTL renewal — mirrors keeper-registry pattern
// ─────────────────────────────────────────────────────────────────────────────

/// Extends TTL for a persistent storage key after writing it.
/// Called immediately after e.storage().persistent().set(&key, &value).
/// This is the critical pattern from issue 0312/0332 that issue 0381 requires.
pub(crate) fn extend_persistent_ttl(e: &Env, key: &GovernanceDataKey) {
    e.storage()
        .persistent()
        .extend_ttl(key, GOVERNANCE_STORAGE_BUMP_THRESHOLD, GOVERNANCE_STORAGE_BUMP_LEDGERS);
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration readers
// ─────────────────────────────────────────────────────────────────────────────

pub(crate) fn token_address(e: &Env) -> Result<Address, GovernanceError> {
    e.storage()
        .instance()
        .get(&GovernanceDataKey::TokenAddress)
        .ok_or(GovernanceError::NotInitialized)
}

pub(crate) fn voting_period_ledgers(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&GovernanceDataKey::VotingPeriodLedgers)
        .unwrap_or(DEFAULT_VOTING_PERIOD_LEDGERS)
}

pub(crate) fn timelock_ledgers(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&GovernanceDataKey::TimelockLedgers)
        .unwrap_or(DEFAULT_TIMELOCK_LEDGERS)
}

pub(crate) fn quorum_bps(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&GovernanceDataKey::QuorumBps)
        .unwrap_or(DEFAULT_QUORUM_BPS)
}

pub(crate) fn passing_threshold_bps(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&GovernanceDataKey::PassingThresholdBps)
        .unwrap_or(DEFAULT_PASSING_THRESHOLD_BPS)
}

pub(crate) fn next_proposal_id(e: &Env) -> u64 {
    let id = e
        .storage()
        .instance()
        .get::<_, u64>(&GovernanceDataKey::ProposalCounter)
        .unwrap_or(0);
    e.storage()
        .instance()
        .set(&GovernanceDataKey::ProposalCounter, &(id + 1));
    id
}

// ─────────────────────────────────────────────────────────────────────────────
// Token interaction
// ─────────────────────────────────────────────────────────────────────────────

/// Returns a token client for the governance token (KPRS).
pub(crate) fn governance_token(e: &Env) -> Result<token::Client, GovernanceError> {
    let token_addr = token_address(e)?;
    Ok(token::Client::new(e, &token_addr))
}

/// Reads a voter's token balance at a specific ledger snapshot.
/// For now, reads current balance; issue 0364 specifies the snapshotting mechanism.
pub(crate) fn voter_balance(e: &Env, voter: &Address) -> Result<i128, GovernanceError> {
    let token = governance_token(e)?;
    Ok(token.balance(voter))
}

// ─────────────────────────────────────────────────────────────────────────────
// Imports for tests
// ─────────────────────────────────────────────────────────────────────────────

use crate::constants::DEFAULT_QUORUM_BPS;
use crate::constants::DEFAULT_TIMELOCK_LEDGERS;
use crate::constants::DEFAULT_VOTING_PERIOD_LEDGERS;
