//! programs/prova_executor/src/lib.rs
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
#[allow(unused_imports)]
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

pub mod errors;
pub mod proof_helper;
pub mod vk;

pub use errors::ProvaError;
use proof_helper::{ProofHelper, ProvaPublicInputs};

declare_id!("3KNFsYY4FC5PVxCq9dGV8v7izGKs6zRyEaUqq17C8fdA");

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

pub const BALANCE_PROVER_VK_HASH: &str =
    "0x0011223344556677889900112233445566778899001122334455667788990011";

pub const COMP_DEF_OFFSET_EXECUTE_TRANSFER: u32 = comp_def_offset("execute_transfer");

pub const VAULT_SEED: &[u8] = b"prova_vault";
pub const PENDING_SEED: &[u8] = b"pending_exec";

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

#[account]
pub struct PendingExecution {
    pub rule_id: [u8; 32],
    pub recipient: Pubkey,
    pub token_mint: Pubkey,
    pub action_amount: u64,
    pub fee_payer: Pubkey,
    pub bump: u8,
}

impl PendingExecution {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 32 + 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

#[error_code]
pub enum ErrorCode {
    #[msg("SP1 proof verification failed")]
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// #[inline(never)]
// fn verify_noir_proof(proof_bytes: &[u8], public_values: &[u8]) -> Result<ProvaPublicInputs> {
//     ProofHelper::verify_and_extract(proof_bytes, public_values, &vk::VK)
//         .map_err(|_| ProvaError::InvalidProof.into())
// }

// #[inline(never)]
// fn validate_inputs(
//     public_inputs: &ProvaPublicInputs,
//     rule_watch_address: &[u8; 20],
//     rule_threshold_wei: &[u8; 32],
//     rule_id: &[u8; 32],
// ) -> Result<()> {
//     require!(
//         public_inputs.wallet_address == *rule_watch_address,
//         ErrorCode::PublicInputMismatch
//     );

//     require!(
//         public_inputs.threshold_wei == *rule_threshold_wei,
//         ErrorCode::PublicInputMismatch
//     );

//     require!(
//         public_inputs.rule_id == *rule_id,
//         ErrorCode::PublicInputMismatch
//     );

//     Ok(())
// }

// ─────────────────────────────────────────────────────────────────────────────
// Program
// ─────────────────────────────────────────────────────────────────────────────

#[arcium_program]
pub mod prova_executor {
    use super::*;

    pub fn init_execute_transfer_comp_def(ctx: Context<InitExecuteTransferCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn submit_proof_and_execute(
        ctx: Context<SubmitProofAndExecute>,

        // proof_bytes: Vec<u8>,
        // public_values: Vec<u8>,

        rule_id: [u8; 32],
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
    ) -> Result<()> {
        // ─────────────────────────────────────────────────────────────────────
        // 1. Verify proof
        // ─────────────────────────────────────────────────────────────────────

        // let calc_public_inputs = verify_noir_proof(&proof_bytes, &public_values)?;

        // ─────────────────────────────────────────────────────────────────────
        // 2. Validate
        // ─────────────────────────────────────────────────────────────────────

        // validate_inputs(
        //     &calc_public_inputs,
        //     &rule_watch_address,
        //     &rule_threshold_wei,
        //     &rule_id,
        // )?;

        // emit!(ProofVerified {
        //     rule_id: calc_public_inputs.rule_id,
        //     block_number: calc_public_inputs.block_number,
        // });

        // ─────────────────────────────────────────────────────────────────────
        // 3. Store pending execution
        // ─────────────────────────────────────────────────────────────────────

        let pending = &mut ctx.accounts.pending_execution;

        pending.rule_id = rule_id;
        pending.recipient = rule_recipient;
        pending.token_mint = rule_token_mint;
        pending.action_amount = rule_action_amount;
        pending.fee_payer = ctx.accounts.fee_payer.key();
        pending.bump = ctx.bumps.pending_execution;

        // ─────────────────────────────────────────────────────────────────────
        // 4. Queue Arcium computation
        // ─────────────────────────────────────────────────────────────────────

        let args = ArgBuilder::new()
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u64(ciphertext_amount)
            .encrypted_u64(ciphertext_recipient)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let pending_pda = ctx.accounts.pending_execution.key();
        let vault_pda = ctx.accounts.vault_token_account.key();
        let recipient_ata = ctx.accounts.recipient_token_account.key();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![ExecuteTransferCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount {
                        pubkey: pending_pda,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: vault_pda,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: recipient_ata,
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
                msg!("Computation verification failed: {}", e);
                return Err(ErrorCode::AbortedComputation.into());
            }
        };

        let pending = &ctx.accounts.pending_execution;

        require!(
            ctx.accounts.vault_token_account.amount >= pending.action_amount,
            ErrorCode::InsufficientVaultBalance
        );

        let vault_bump = ctx.bumps.vault_authority;

        let seeds: &[&[u8]] = &[VAULT_SEED, &[vault_bump]];

        let signer = &[seeds];

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

        msg!(
            "Transfer executed: {} tokens → {}",
            pending.action_amount,
            pending.recipient,
        );

        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Init comp def accounts
// ─────────────────────────────────────────────────────────────────────────────

#[init_computation_definition_accounts("execute_transfer", payer)]
#[derive(Accounts)]
pub struct InitExecuteTransferCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,

    #[account(mut)]
    /// CHECK:
    pub comp_def_account: UncheckedAccount<'info>,

    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK:
    pub address_lookup_table: UncheckedAccount<'info>,

    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK:
    pub lut_program: UncheckedAccount<'info>,

    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Submit accounts
// ─────────────────────────────────────────────────────────────────────────────

#[queue_computation_accounts("execute_transfer", fee_payer)]
#[derive(Accounts)]
#[instruction(
    // proof_bytes: Vec<u8>,
    // public_values: Vec<u8>,

    rule_id: [u8; 32],
    rule_watch_address: [u8; 20],
    rule_threshold_wei: [u8; 32],

    rule_recipient: Pubkey,
    rule_token_mint: Pubkey,
    rule_action_amount: u64,

    computation_offset: u64,
)]
pub struct SubmitProofAndExecute<'info> {
    #[account(mut)]
    pub fee_payer: Signer<'info>,

    #[account(
        init_if_needed,
        payer = fee_payer,
        space = PendingExecution::LEN,
        seeds = [PENDING_SEED, &rule_id],
        bump,
    )]
    pub pending_execution: Account<'info, PendingExecution>,

    #[account(
        init_if_needed,
        payer = fee_payer,
        seeds = [VAULT_SEED, rule_token_mint.key().as_ref()],
        bump,
        token::mint = rule_token_mint,
        token::authority = vault_authority,
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK:
    #[account(seeds = [VAULT_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub recipient_token_account: Box<Account<'info, TokenAccount>>,

    pub rule_token_mint: Box<Account<'info, Mint>>,

    #[account(
        init_if_needed,
        space = 9,
        payer = fee_payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,

    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,

    #[account(
        mut,
        address = derive_mempool_pda!(
            mxe_account,
            ErrorCode::ClusterNotSet
        )
    )]
    /// CHECK:
    pub mempool_account: UncheckedAccount<'info>,

    #[account(
        mut,
        address = derive_execpool_pda!(
            mxe_account,
            ErrorCode::ClusterNotSet
        )
    )]
    /// CHECK:
    pub executing_pool: UncheckedAccount<'info>,

    #[account(
        mut,
        address = derive_comp_pda!(
            computation_offset,
            mxe_account,
            ErrorCode::ClusterNotSet
        )
    )]
    /// CHECK:
    pub computation_account: UncheckedAccount<'info>,

    #[account(
        address = derive_comp_def_pda!(
            COMP_DEF_OFFSET_EXECUTE_TRANSFER
        )
    )]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,

    #[account(
        mut,
        address = derive_cluster_pda!(
            mxe_account,
            ErrorCode::ClusterNotSet
        )
    )]
    pub cluster_account: Box<Account<'info, Cluster>>,

    #[account(
        mut,
        address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS
    )]
    pub pool_account: Box<Account<'info, FeePool>>,

    #[account(
        mut,
        address = ARCIUM_CLOCK_ACCOUNT_ADDRESS
    )]
    pub clock_account: Account<'info, ClockAccount>,

    pub rent: Sysvar<'info, Rent>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub arcium_program: Program<'info, Arcium>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Callback accounts
// ─────────────────────────────────────────────────────────────────────────────

#[callback_accounts("execute_transfer")]
#[derive(Accounts)]
pub struct ExecuteTransferCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,

    #[account(
        address = derive_comp_def_pda!(
            COMP_DEF_OFFSET_EXECUTE_TRANSFER
        )
    )]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,

    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,

    /// CHECK:
    pub computation_account: UncheckedAccount<'info>,

    #[account(
        address = derive_cluster_pda!(
            mxe_account,
            ErrorCode::ClusterNotSet
        )
    )]
    pub cluster_account: Box<Account<'info, Cluster>>,

    /// CHECK:
    #[account(
        address = ::anchor_lang::solana_program
            ::sysvar::instructions::ID
    )]
    pub instructions_sysvar: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [
            PENDING_SEED,
            &pending_execution.rule_id
        ],
        bump = pending_execution.bump,
    )]
    pub pending_execution: Account<'info, PendingExecution>,

    #[account(
        mut,
        seeds = [
            VAULT_SEED,
            pending_execution.token_mint.as_ref()
        ],
        bump,
        token::mint = pending_execution.token_mint,
        token::authority = vault_authority,
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK:
    #[account(seeds = [VAULT_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub recipient_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}
