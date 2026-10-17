//! Governance error types.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum GovernanceError {
    NotInitialized = 1,
    Unauthorized = 2,
    InsufficientHoldings = 3,
    ProposalNotFound = 4,
    InvalidProposalType = 5,
    VotingClosed = 6,
    AlreadyVoted = 7,
    NotInTimelock = 8,
    CannotExecute = 9,
    ProposalNotPassed = 10,
    InvalidChoice = 11,
    QuorumNotMet = 12,
    AlreadyExecuted = 13,
    TokenTransferFailed = 14,
}
