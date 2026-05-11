//! programs/prova_executor/src/lib.rs
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

pub mod errors;
pub mod proof_helper;
pub mod vk;

use proof_helper::{ProofHelper, ProvaPublicInputs};

// Re-export everything needed by macros
pub use errors::ProvaError;

declare_id!("3KNFsYY4FC5PVxCq9dGV8v7izGKs6zRyEaUqq17C8fdA");

// ─── Constants ────────────────────────────────────────────────────────────────
pub const COMP_DEF_OFFSET_EXECUTE_TRANSFER: u32 = comp_def_offset("execute_transfer");

pub const VAULT_SEED: &[u8] = b"prova_vault";
pub const PENDING_SEED: &[u8] = b"pending_exec";
pub const SIGN_PDA_SEED: &[u8] = b"arcium_signer";

// ─── Events ──────────────────────────────────────────────────────────────────
#[event]
pub struct ProofVerified {
    pub rule_id: [u8; 32],
    pub block_number: u64,
}

#[event]
pub struct TransferExecuted {
    pub rule_id: [u8; 32],
    pub recipient: Pubkey,
    pub amount: u64,
}

// ─── Stack Helpers ───────────────────────────────────────────────────────────
#[inline(never)]
fn verify_noir_proof(proof_bytes: &[u8], public_values: &[u8]) -> Result<ProvaPublicInputs> {
    ProofHelper::verify_and_extract(proof_bytes, public_values, &vk::VK)
        .map_err(|_| ProvaError::InvalidProof.into())
}

#[inline(never)]
fn validate_inputs(
    public_inputs: &ProvaPublicInputs,
    rule_watch_address: &[u8; 20],
    rule_threshold_wei: &[u8; 32],
) -> Result<()> {
    require!(
        public_inputs.wallet_address == *rule_watch_address,
        ProvaError::PublicInputMismatch
    );
    require!(
        public_inputs.threshold_wei == *rule_threshold_wei,
        ProvaError::PublicInputMismatch
    );
    Ok(())
}

// ─── Program Module ──────────────────────────────────────────────────────────

#[arcium_program]
pub mod prova_executor {
    use super::*;

    pub fn init_execute_transfer_comp_def(ctx: Context<InitExecuteTransferCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn submit_proof_and_execute(
        ctx: Context<SubmitProofAndExecute>,
        proof_bytes: Vec<u8>,
        public_values: Vec<u8>,
        rule_watch_address: [u8; 20],
        rule_threshold_wei: [u8; 32],
        rule_recipient: Pubkey,
        rule_token_mint: Pubkey,
        rule_action_amount: u64,
        computation_offset: u64,
        ciphertext_amount: [u8; 32],
        ciphertext_recipient: [u8; 32],
        pub_key: [u8; 32],
        nonce: u128,
        rule_id: [u8; 32], // ← Added for seeds
    ) -> Result<()> {
        let public_inputs = verify_noir_proof(&proof_bytes, &public_values)?;

        validate_inputs(&public_inputs, &rule_watch_address, &rule_threshold_wei)?;

        emit!(ProofVerified {
            rule_id: public_inputs.rule_id,
            block_number: public_inputs.block_number,
        });

        // Store pending execution
        let pending = &mut ctx.accounts.pending_execution;
        pending.rule_id = rule_id; // Use passed rule_id
        pending.recipient = rule_recipient;
        pending.token_mint = rule_token_mint;
        pending.action_amount = rule_action_amount;
        pending.fee_payer = ctx.accounts.fee_payer.key();
        pending.bump = ctx.bumps.pending_execution;

        // Queue Arcium computation
        let args = ArgBuilder::new()
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u64(ciphertext_amount)
            .encrypted_u64(ciphertext_recipient)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![ExecuteTransferCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount {
                        pubkey: ctx.accounts.pending_execution.key(),
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: ctx.accounts.vault_token_account.key(),
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: ctx.accounts.recipient_token_account.key(),
                        is_writable: true,
                    },
                ],
            )?],
            1,
            5_000,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "execute_transfer")]
    pub fn execute_transfer_callback(
        ctx: Context<ExecuteTransferCallback>,
        output: SignedComputationOutputs<ExecuteTransferOutput>,
    ) -> Result<()> {
        let _result = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(ExecuteTransferOutput { field_0 }) => field_0,
            Err(e) => {
                msg!("Computation failed: {}", e);
                return Err(ProvaError::AbortedComputation.into());
            }
        };

        let pending = &ctx.accounts.pending_execution;

        require!(
            ctx.accounts.vault_token_account.amount >= pending.action_amount,
            ProvaError::InsufficientVaultBalance
        );

        let seeds = &[VAULT_SEED, &[ctx.bumps.vault_authority]];
        let signer = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    to: ctx.accounts.recipient_token_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer,
            ),
            pending.action_amount,
        )?;

        emit!(TransferExecuted {
            rule_id: pending.rule_id,
            recipient: pending.recipient,
            amount: pending.action_amount,
        });

        Ok(())
    }
}

// Account structs remain the same (with small fix on seeds)

// ─── Accounts ────────────────────────────────────────────────────────────────

#[init_computation_definition_accounts("execute_transfer", payer)]
#[derive(Accounts)]
pub struct InitExecuteTransferCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[queue_computation_accounts("execute_transfer", fee_payer)]
#[derive(Accounts)]
#[instruction(
    rule_recipient: Pubkey,
    rule_token_mint: Pubkey,
    rule_action_amount: u64,
    computation_offset: u64,
)]
pub struct SubmitProofAndExecute<'info> {
    #[account(mut)]
    pub fee_payer: Signer<'info>,

    #[account(
        init,
        payer = fee_payer,
        space = PendingExecution::LEN,
        seeds = [PENDING_SEED, rule_id],           // ← We pass rule_id as extra instruction arg
        bump,
    )]
    pub pending_execution: Account<'info, PendingExecution>,

    #[account(
        mut,
        seeds = [VAULT_SEED, rule_token_mint.key().as_ref()],
        bump,
        token::mint = rule_token_mint,
        token::authority = vault_authority,
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    #[account(seeds = [VAULT_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub recipient_token_account: Box<Account<'info, TokenAccount>>,

    pub rule_token_mint: Box<Account<'info, anchor_spl::token::Mint>>,

    // Arcium accounts...
    #[account(
        init_if_needed,
        space = 9,
        payer = fee_payer,
        seeds = [SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,

    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,

    #[account(mut, address = derive_mempool_pda!(mxe_account, ProvaError::ClusterNotSet))]
    pub mempool_account: UncheckedAccount<'info>,

    #[account(mut, address = derive_execpool_pda!(mxe_account, ProvaError::ClusterNotSet))]
    pub executing_pool: UncheckedAccount<'info>,

    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ProvaError::ClusterNotSet))]
    pub computation_account: UncheckedAccount<'info>,

    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_EXECUTE_TRANSFER))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,

    #[account(mut, address = derive_cluster_pda!(mxe_account, ProvaError::ClusterNotSet))]
    pub cluster_account: Box<Account<'info, Cluster>>,

    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,

    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub arcium_program: Program<'info, Arcium>,
}

// Add this helper to proof_helper.rs later if needed
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct RuleIdInput {
    pub rule_id: [u8; 32],
}
