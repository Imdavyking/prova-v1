// monitor/src/registryLoader.ts
//
// Loads active rules from the prova_registry Solana program
// and feeds them into the EthWatcher.

import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { logger } from "./logger";
import { config } from "./config";
import { ActiveRule } from "./ethWatcher";
import RegistryIDL from "../../target/idl/prova_registry.json";

const RULE_SEED = Buffer.from("prova_rule");
const REGISTRY_SEED = Buffer.from("prova_registry");

// Status discriminant values (must match the Rust enum order)
const STATUS_ACTIVE = 0;

export class RegistryLoader {
  private program: anchor.Program;

  constructor(provider: anchor.AnchorProvider) {
    this.program = new anchor.Program(RegistryIDL as anchor.Idl, provider);
  }

  /** Fetch all Rule accounts with status == Active */
  async loadActiveRules(): Promise<ActiveRule[]> {
    logger.info("Loading active rules from registry...");

    try {
      // Fetch all Rule accounts — filter by status byte (offset 8 + 32 + 32 + ... = status position)
      // Anchor provides getProgramAccounts with filter support
      const accounts = await (this.program.account as any)["rule"].all([
        {
          // status field is at a known offset in the Rule account
          // Status::Active = 0 (first enum variant)
          memcmp: {
            offset: getRuleStatusOffset(),
            bytes: "1", // base58 encoded [0] = "1" in bs58
          },
        },
      ]);

      const rules: ActiveRule[] = accounts.map((acc: any) => {
        const data = acc.account as any;
        return {
          ruleId: "0x" + Buffer.from(data.ruleId).toString("hex"),
          owner: data.owner.toBase58(),
          watchAddress: "0x" + Buffer.from(data.watchAddress).toString("hex"),
          tokenAddress: "0x" + Buffer.from(data.tokenAddress).toString("hex"),
          thresholdWei: bufferToBigInt(Buffer.from(data.thresholdWei)),
          recipient: data.recipient.toBase58(),
          tokenMint: data.tokenMint.toBase58(),
          actionAmount: BigInt(data.actionAmount.toString()),
        };
      });

      logger.info(`Loaded ${rules.length} active rules`);
      return rules;
    } catch (err) {
      logger.error("Failed to load rules", { error: String(err) });
      return [];
    }
  }

  /** Subscribe to RuleRegistered events and add new rules dynamically */
  subscribeToNewRules(onNewRule: (rule: ActiveRule) => void): void {
    this.program.addEventListener("ruleRegistered", (event: any) => {
      logger.info("New rule registered", {
        ruleId: Buffer.from(event.ruleId).toString("hex"),
      });

      const rule: ActiveRule = {
        ruleId: "0x" + Buffer.from(event.ruleId).toString("hex"),
        owner: event.owner.toBase58(),
        watchAddress: "0x" + Buffer.from(event.watchAddress).toString("hex"),
        tokenAddress: "0x0000000000000000000000000000000000000000",
        thresholdWei: bufferToBigInt(Buffer.from(event.thresholdWei)),
        recipient: event.recipient.toBase58(),
        tokenMint: event.tokenMint?.toBase58() ?? "",
        actionAmount: BigInt(event.actionAmount.toString()),
      };
      onNewRule(rule);
    });
  }
}

/** Calculate byte offset of the `status` field in the Rule account */
function getRuleStatusOffset(): number {
  // 8 (discriminator) + 32 (owner) + 32 (rule_id) + 2 (source_chain)
  // + 2 (condition_type) + 20 (watch_address) + 20 (token_address)
  // + 32 (threshold_wei) + 2 (action_type) + 32 (recipient) + 32 (token_mint)
  // + 8 (action_amount) + 8 (escrowed_fee) = 230
  return 230;
}

function bufferToBigInt(buf: Buffer): bigint {
  return BigInt("0x" + (buf.toString("hex") || "00"));
}
