//! programs/prova_registry/src/lib.rs
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

declare_id!("7bFAYfTAJEAvjc4PaAxfVgyEu2o4Tda4hqzFX2vMHVeL");

pub const REGISTRY_SEED: &[u8] = b"prova_registry";
pub const RULE_SEED: &[u8] = b"prova_rule";
pub const MAX_RULES_PER_USER: u8 = 32;
pub const MIN_FEE_LAMPORTS: u64 = 15_000;

// ─── Enums ────────────────────────────────────────────────────────────────────
//
// All variants are unit (no payload), so Copy is free and eliminates every
// .clone() call that would otherwise appear throughout the program logic.

#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, PartialEq, Eq, Debug)]
pub enum SourceChain {
    Ethereum,
    Base,
    Arbitrum,
    Optimism,
    Polygon,
}

#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, PartialEq, Eq, Debug)]
pub enum ConditionType {
    BalanceBelow,
    TokenBalanceBelow,
    BlockReached,
    StorageSlotEquals,
}

#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, PartialEq, Eq, Debug)]
pub enum ActionType {
    TransferSpl,
    TransferSol,
}

#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, PartialEq, Eq, Debug)]
pub enum RuleStatus {
    Active,
    Triggered,
    Proving,
    Executed,
    Cancelled,
}

// ─── State ────────────────────────────────────────────────────────────────────

#[account]
#[derive(Debug)]
pub struct RegistryState {
    pub authority: Pubkey,
    pub fee_recipient: Pubkey,
    pub protocol_fee_bps: u16,
    pub total_rules: u64,
    pub paused: bool,
    pub bump: u8,
}

impl RegistryState {
    pub const LEN: usize = 8 + 32 + 32 + 2 + 8 + 1 + 1;
}

#[account]
#[derive(Debug)]
pub struct Rule {
    pub owner: Pubkey,
    pub rule_id: [u8; 32],
    pub source_chain: SourceChain,
    pub condition_type: ConditionType,
    pub watch_address: [u8; 20],
    pub token_address: [u8; 20],
    pub threshold_wei: [u8; 32],
    pub action_type: ActionType,
    pub recipient: Pubkey,
    pub token_mint: Pubkey,
    pub action_amount: u64,
    pub escrowed_fee: u64,
    pub status: RuleStatus,
    pub registered_at: i64,
    pub executed_at: i64,
    pub bump: u8,
}

impl Rule {
    pub const LEN: usize = 8   // discriminator
        + 32  // owner
        + 32  // rule_id
        + 2   // source_chain
        + 2   // condition_type
        + 20  // watch_address
        + 20  // token_address
        + 32  // threshold_wei
        + 2   // action_type
        + 32  // recipient
        + 32  // token_mint
        + 8   // action_amount
        + 8   // escrowed_fee
        + 2   // status
        + 8   // registered_at
        + 8   // executed_at
        + 1; // bump
}

// ─── Events ──────────────────────────────────────────────────────────────────

#[event]
pub struct RuleRegistered {
    pub rule_id: [u8; 32],
    pub owner: Pubkey,
    pub source_chain: SourceChain,
    pub condition_type: ConditionType,
    pub watch_address: [u8; 20],
    pub threshold_wei: [u8; 32],
    pub action_type: ActionType,
    pub recipient: Pubkey,
    pub action_amount: u64,
    pub escrowed_fee: u64,
}

#[event]
pub struct RuleTriggered {
    pub rule_id: [u8; 32],
    pub block_number: u64,
}

#[event]
pub struct RuleExecuted {
    pub rule_id: [u8; 32],
    pub tx_signature: [u8; 64],
    pub executed_at: i64,
}

#[event]
pub struct RuleCancelled {
    pub rule_id: [u8; 32],
    pub owner: Pubkey,
}

// ─── Errors ──────────────────────────────────────────────────────────────────

#[error_code]
pub enum RegistryError {
    #[msg("Protocol is paused")]
    Paused,
    #[msg("Fee below minimum required")]
    FeeTooLow,
    #[msg("Rule is not in Active status")]
    RuleNotActive,
    #[msg("Rule is not in Triggered status")]
    RuleNotTriggered,
    #[msg("Rule is not in Proving status")]
    RuleNotProving,
    #[msg("Only rule owner can cancel")]
    Unauthorized,
    #[msg("Invalid threshold: must be > 0")]
    InvalidThreshold,
    #[msg("Invalid action amount: must be > 0")]
    InvalidAmount,
    #[msg("Arithmetic overflow")]
    Overflow,
}

// ─── Params ──────────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RegisterRuleParams {
    pub rule_id: [u8; 32],
    pub source_chain: SourceChain,
    pub condition_type: ConditionType,
    pub watch_address: [u8; 20],
    pub token_address: [u8; 20],
    pub threshold_wei: [u8; 32],
    pub action_type: ActionType,
    pub recipient: Pubkey,
    pub token_mint: Pubkey,
    pub action_amount: u64,
    pub escrowed_fee: u64,
}

// ─── Program ─────────────────────────────────────────────────────────────────

#[program]
pub mod prova_registry {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, protocol_fee_bps: u16) -> Result<()> {
        let state = &mut ctx.accounts.registry_state;
        state.authority = ctx.accounts.authority.key();
        state.fee_recipient = ctx.accounts.authority.key();
        state.protocol_fee_bps = protocol_fee_bps;
        state.total_rules = 0;
        state.paused = false;
        state.bump = ctx.bumps.registry_state;
        Ok(())
    }

    pub fn register_rule(ctx: Context<RegisterRule>, params: RegisterRuleParams) -> Result<()> {
        require!(!ctx.accounts.registry_state.paused, RegistryError::Paused);
        require!(
            ctx.accounts.owner.lamports() >= MIN_FEE_LAMPORTS,
            RegistryError::FeeTooLow
        );
        require!(
            params.escrowed_fee >= MIN_FEE_LAMPORTS,
            RegistryError::FeeTooLow
        );
        require!(
            params.threshold_wei != [0u8; 32],
            RegistryError::InvalidThreshold
        );
        require!(params.action_amount > 0, RegistryError::InvalidAmount);

        // Increment rule counter before populating rule (checked_add guards overflow).
        let rule_count = ctx.accounts.registry_state.total_rules;
        ctx.accounts.registry_state.total_rules =
            rule_count.checked_add(1).ok_or(RegistryError::Overflow)?;

        let owner_key = ctx.accounts.owner.key();

        // Populate rule — all enum fields are Copy so no .clone() needed.
        let rule = &mut ctx.accounts.rule;
        rule.owner = owner_key;
        rule.rule_id = params.rule_id;
        rule.source_chain = params.source_chain;
        rule.condition_type = params.condition_type;
        rule.watch_address = params.watch_address;
        rule.token_address = params.token_address;
        rule.threshold_wei = params.threshold_wei;
        rule.action_type = params.action_type;
        rule.recipient = params.recipient;
        rule.token_mint = params.token_mint;
        rule.action_amount = params.action_amount;
        rule.escrowed_fee = params.escrowed_fee;
        rule.status = RuleStatus::Active;
        rule.registered_at = Clock::get()?.unix_timestamp;
        rule.executed_at = 0;
        rule.bump = ctx.bumps.rule;

        // Transfer escrowed fee from owner → rule PDA.
        anchor_lang::solana_program::program::invoke(
            &anchor_lang::solana_program::system_instruction::transfer(
                &owner_key,
                &ctx.accounts.rule.key(),
                params.escrowed_fee,
            ),
            &[
                ctx.accounts.owner.to_account_info(),
                ctx.accounts.rule.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        emit!(RuleRegistered {
            rule_id: params.rule_id,
            owner: owner_key,
            source_chain: params.source_chain,
            condition_type: params.condition_type,
            watch_address: params.watch_address,
            threshold_wei: params.threshold_wei,
            action_type: params.action_type,
            recipient: params.recipient,
            action_amount: params.action_amount,
            escrowed_fee: params.escrowed_fee,
        });

        msg!(
            "Rule #{} registered by {} — escrowed {} lamports",
            rule_count,
            owner_key,
            params.escrowed_fee,
        );
        Ok(())
    }

    pub fn mark_triggered(ctx: Context<MarkTriggered>, block_number: u64) -> Result<()> {
        let rule = &mut ctx.accounts.rule;
        require!(
            rule.status == RuleStatus::Active,
            RegistryError::RuleNotActive
        );
        rule.status = RuleStatus::Triggered;
        emit!(RuleTriggered {
            rule_id: rule.rule_id,
            block_number
        });
        Ok(())
    }

    pub fn mark_proving(ctx: Context<MarkProving>) -> Result<()> {
        let rule = &mut ctx.accounts.rule;
        require!(
            rule.status == RuleStatus::Triggered,
            RegistryError::RuleNotTriggered
        );
        rule.status = RuleStatus::Proving;
        Ok(())
    }

    pub fn mark_executed(ctx: Context<MarkExecuted>, tx_signature: [u8; 64]) -> Result<()> {
        let rule = &mut ctx.accounts.rule;
        require!(
            rule.status == RuleStatus::Proving,
            RegistryError::RuleNotProving
        );

        let now = Clock::get()?.unix_timestamp;
        rule.status = RuleStatus::Executed;
        rule.executed_at = now;

        let fee = rule.escrowed_fee;
        rule.escrowed_fee = 0;

        **rule.to_account_info().try_borrow_mut_lamports()? -= fee;
        **ctx
            .accounts
            .executor
            .to_account_info()
            .try_borrow_mut_lamports()? += fee;

        emit!(RuleExecuted {
            rule_id: rule.rule_id,
            tx_signature,
            executed_at: now
        });
        Ok(())
    }

    pub fn cancel_rule(ctx: Context<CancelRule>) -> Result<()> {
        let rule = &mut ctx.accounts.rule;
        require!(
            rule.owner == ctx.accounts.owner.key(),
            RegistryError::Unauthorized
        );
        require!(
            rule.status == RuleStatus::Active,
            RegistryError::RuleNotActive
        );

        let fee = rule.escrowed_fee;
        let rule_id = rule.rule_id;
        rule.escrowed_fee = 0;
        rule.status = RuleStatus::Cancelled;

        **rule.to_account_info().try_borrow_mut_lamports()? -= fee;
        **ctx
            .accounts
            .owner
            .to_account_info()
            .try_borrow_mut_lamports()? += fee;

        emit!(RuleCancelled {
            rule_id,
            owner: ctx.accounts.owner.key()
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.registry_state.paused = paused;
        Ok(())
    }
}

// ─── Account contexts ─────────────────────────────────────────────────────────
//
// Rule is 249 bytes — boxed in every context so try_accounts() keeps its
// stack frame below the 4096-byte SBF limit.

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = RegistryState::LEN,
        seeds = [REGISTRY_SEED],
        bump,
    )]
    pub registry_state: Account<'info, RegistryState>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(params: RegisterRuleParams)]
pub struct RegisterRule<'info> {
    // Boxed: two large accounts in one context would push try_accounts() over budget.
    #[account(
        mut,
        seeds = [REGISTRY_SEED],
        bump  = registry_state.bump,
    )]
    pub registry_state: Box<Account<'info, RegistryState>>,

    #[account(
        init,
        payer = owner,
        space = Rule::LEN,
        seeds = [RULE_SEED, owner.key().as_ref(), &params.rule_id],
        bump,
    )]
    pub rule: Box<Account<'info, Rule>>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MarkTriggered<'info> {
    #[account(mut, seeds = [RULE_SEED, rule.owner.as_ref(), &rule.rule_id], bump = rule.bump)]
    pub rule: Box<Account<'info, Rule>>,
    pub monitor: Signer<'info>,
}

#[derive(Accounts)]
pub struct MarkProving<'info> {
    #[account(mut, seeds = [RULE_SEED, rule.owner.as_ref(), &rule.rule_id], bump = rule.bump)]
    pub rule: Box<Account<'info, Rule>>,
    pub monitor: Signer<'info>,
}

#[derive(Accounts)]
pub struct MarkExecuted<'info> {
    #[account(mut, seeds = [RULE_SEED, rule.owner.as_ref(), &rule.rule_id], bump = rule.bump)]
    pub rule: Box<Account<'info, Rule>>,
    #[account(mut)]
    pub executor: SystemAccount<'info>,
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelRule<'info> {
    #[account(mut, seeds = [RULE_SEED, rule.owner.as_ref(), &rule.rule_id], bump = rule.bump)]
    pub rule: Box<Account<'info, Rule>>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [REGISTRY_SEED], bump = registry_state.bump, has_one = authority)]
    pub registry_state: Box<Account<'info, RegistryState>>,
    pub authority: Signer<'info>,
}
