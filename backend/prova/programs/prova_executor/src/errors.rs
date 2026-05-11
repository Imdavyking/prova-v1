// programs/prova_executor/src/errors.rs
//
// Prova-specific error codes used by proof_helper.rs.
// NOTE: Anchor's #[callback_accounts] macro hard-codes `ErrorCode::ClusterNotSet`,
// so the on-chain program keeps its own `ErrorCode` enum in lib.rs. This module
// defines `ProvaError`, which is used by proof_helper and maps 1-to-1 to the
// `ErrorCode` variants.

use anchor_lang::prelude::*;

#[error_code]
pub enum ProvaError {
    #[msg("Proof verification failed")]
    InvalidProof,
    #[msg("Proof public inputs do not match rule")]
    PublicInputMismatch,
    #[msg("The computation was aborted")]
    AbortedComputation,
    #[msg("Cluster not set")]
    ClusterNotSet,
    #[msg("Vault has insufficient balance")]
    InsufficientVaultBalance,
}
