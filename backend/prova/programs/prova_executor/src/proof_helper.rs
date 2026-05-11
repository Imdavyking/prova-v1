use crate::errors::*;
use anchor_lang::prelude::*;
use gnark_verifier_solana::vk::GnarkVerifyingkey;
use gnark_verifier_solana::{proof::GnarkProof, verifier::GnarkVerifier, witness::GnarkWitness};

#[derive(Debug, Clone)]
pub struct ProvaPublicInputs {
    pub block_number:   u64,
    pub state_root:     [u8; 32],
    pub wallet_address: [u8; 20],
    pub threshold_wei:  [u8; 32],
    pub rule_id:        [u8; 32],
}

impl ProvaPublicInputs {
    pub fn from_entries(entries: &[[u8; 32]; 5]) -> Self {
        let mut wallet = [0u8; 20];
        wallet.copy_from_slice(&entries[2][12..32]);
        Self {
            block_number:   u64::from_be_bytes(entries[0][24..32].try_into().unwrap()),
            state_root:     entries[1],
            wallet_address: wallet,
            threshold_wei:  entries[3],
            rule_id:        entries[4],
        }
    }
}

pub struct ProofHelper;

impl ProofHelper {
    pub fn verify_and_extract(
        proof_bytes: &[u8],
        public_witness_bytes: &[u8],
        vk: &GnarkVerifyingkey,
    ) -> Result<ProvaPublicInputs> {
        const NR_INPUTS: usize = 5;

        let proof = GnarkProof::from_bytes(proof_bytes).map_err(|e| {
            msg!("Proof parse error: {:?}", e);
            error!(ProvaError::InvalidProof)
        })?;

        let public_witness = GnarkWitness::from_bytes(public_witness_bytes).map_err(|e| {
            msg!("Witness parse error: {:?}", e);
            error!(ProvaError::InvalidProof)
        })?;

        let entries: [[u8; 32]; NR_INPUTS] = public_witness.entries;

        let mut verifier: GnarkVerifier<NR_INPUTS> = GnarkVerifier::new(vk);
        verifier.verify(proof, public_witness).map_err(|e| {
            msg!("Proof verification failed: {:?}", e);
            error!(ProvaError::InvalidProof)
        })?;

        msg!("✅ ZK proof verified");
        let public_inputs = ProvaPublicInputs::from_entries(&entries);
        msg!("  block_number: {}", public_inputs.block_number);
        msg!("  rule_id: {:?}", public_inputs.rule_id);

        Ok(public_inputs)
    }
}
