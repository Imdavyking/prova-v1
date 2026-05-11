// monitor/src/solanaSubmitter.ts

import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js"; // tests/prova.ts
import {
  RescueCipher,
  getMXEPublicKey,
  getArciumEnv,
  awaitComputationFinalization,
  getComputationAccAddress,
  getClusterAccAddress,
  getMXEAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  x25519,
  deserializeLE,
} from "@arcium-hq/client";
import { randomBytes } from "crypto";
import * as fs from "fs";
import { logger } from "./logger";
import { config } from "./config";
import { GeneratedProof } from "./proofGenerator";
import { ActiveRule } from "./ethWatcher";

import RegistryIDL from "../../target/idl/prova_registry.json";
import ExecutorIDL from "../../target/idl/prova_executor.json";

export class SolanaSubmitter {
  private connection: Connection;
  private monitorKeypair: Keypair;
  private provider: anchor.AnchorProvider;
  private registryProgram: anchor.Program;
  private executorProgram: anchor.Program;
  private arciumEnv: ReturnType<typeof getArciumEnv>;

  constructor() {
    this.connection = new Connection(config.solanaRpcUrl, "confirmed");
    const rawKp = JSON.parse(
      fs.readFileSync(config.monitorKeypairPath, "utf8"),
    );
    this.monitorKeypair = Keypair.fromSecretKey(Uint8Array.from(rawKp));

    const wallet = new anchor.Wallet(this.monitorKeypair);
    this.provider = new anchor.AnchorProvider(this.connection, wallet, {
      commitment: "confirmed",
    });
    anchor.setProvider(this.provider);

    this.registryProgram = new anchor.Program(
      RegistryIDL as anchor.Idl,
      this.provider,
    );
    this.executorProgram = new anchor.Program(
      ExecutorIDL as anchor.Idl,
      this.provider,
    );
    this.arciumEnv = getArciumEnv();
  }

  async submit(rule: ActiveRule, proof: GeneratedProof): Promise<string> {
    logger.info("Submitting proof to Solana...", { ruleId: rule.ruleId });

    const ruleIdBytes = Buffer.from(rule.ruleId.replace("0x", ""), "hex");
    const ownerPubkey = new PublicKey(rule.owner);
    const [rulePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("prova_rule"), ownerPubkey.toBytes(), ruleIdBytes],
      this.registryProgram.programId,
    );

    logger.info("Marking rule as triggered on-chain...");

    await this.markTriggered(rulePda, proof.blockNumber || 0);
    await this.markProving(rulePda);

    const { encryptedAmount, encryptedRecipient, pubKey, nonce } =
      await this.encryptForArcium(rule);

    const computationOffset = new BN(randomBytes(8), "hex");

    const queueSig = await this.submitProofTx(
      rule,
      rulePda,
      proof,
      ruleIdBytes,
      computationOffset,
      encryptedAmount,
      encryptedRecipient,
      pubKey,
      nonce,
    );
    logger.info("Proof tx queued", { queueSig });

    logger.info("Waiting for Arcium MXE computation...");
    const finalizeSig = await awaitComputationFinalization(
      this.provider as anchor.AnchorProvider,
      computationOffset,
      this.executorProgram.programId,
      "confirmed",
    );
    logger.info("✓ Arcium computation finalized", { finalizeSig });
    return finalizeSig;
  }

  private async markTriggered(
    rulePda: PublicKey,
    blockNumber: number,
  ): Promise<void> {
    // check if triggered before
    const ruleData = await this.registryProgram.account.rule.fetch(rulePda);
    const status = Object.keys(ruleData.status)[0];
    logger.info(`Current rule status: ${status}`);
    if (
      status === "triggered" ||
      status === "proving" ||
      status === "executed"
    ) {
      logger.warn(
        "Rule is already in triggered/proving/executed state, skipping markTriggered",
      );
      return;
    }

    const sig = await this.registryProgram.methods
      .markTriggered(new BN(blockNumber))
      .accounts({ rule: rulePda, monitor: this.monitorKeypair.publicKey })
      .signers([this.monitorKeypair])
      .rpc();
    logger.info("Rule → Triggered", { sig });
  }

  private async markProving(rulePda: PublicKey): Promise<void> {
    // check if already proving before
    const ruleData = await this.registryProgram.account.rule.fetch(rulePda);
    const status = Object.keys(ruleData.status)[0];
    logger.info(`Current rule status: ${status}`);
    if (status === "proving" || status === "executed") {
      logger.warn(
        "Rule is already in proving/executed state, skipping markProving",
      );
      return;
    }
    const sig = await this.registryProgram.methods
      .markProving()
      .accounts({ rule: rulePda, monitor: this.monitorKeypair.publicKey })
      .signers([this.monitorKeypair])
      .rpc();
    logger.info("Rule → Proving", { sig });
  }

  private async encryptForArcium(rule: ActiveRule): Promise<{
    encryptedAmount: number[];
    encryptedRecipient: number[];
    pubKey: number[];
    nonce: BN;
  }> {
    // Exact pattern from Arcium hello-world docs
    const mxePublicKey = await getMXEPublicKey(
      this.provider as anchor.AnchorProvider,
      this.executorProgram.programId,
    );
    if (!mxePublicKey) {
      throw new Error("Failed to fetch Arcium MXE public key");
    }

    const privateKey = x25519.utils.randomSecretKey();
    const pubKey = x25519.getPublicKey(privateKey);
    const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
    if (!sharedSecret) {
      throw new Error("Failed to derive shared secret for Arcium encryption");
    }

    const nonceBuf = randomBytes(16);
    const cipher = new RescueCipher(sharedSecret);

    const amount = BigInt(rule.actionAmount.toString());
    const recipientTag = BigInt(
      "0x" +
        Buffer.from(
          new PublicKey(rule.recipient).toBytes().slice(0, 8),
        ).toString("hex"),
    );

    const ciphertext = cipher.encrypt([amount, recipientTag], nonceBuf);

    return {
      encryptedAmount: Array.from(ciphertext[0]),
      encryptedRecipient: Array.from(ciphertext[1]),
      pubKey: Array.from(pubKey),
      nonce: new BN(deserializeLE(nonceBuf).toString()),
    };
  }

  private async submitProofTx(
    rule: ActiveRule,
    rulePda: PublicKey,
    proof: GeneratedProof,
    ruleIdBytes: Buffer,
    computationOffset: BN,
    encryptedAmount: number[],
    encryptedRecipient: number[],
    pubKey: number[],
    nonce: BN,
  ): Promise<string> {
    const tokenMint = new PublicKey(rule.tokenMint);
    const clusterOffset = this.arciumEnv.arciumClusterOffset;

    const [vaultTokenAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("prova_vault"), tokenMint.toBytes()],
      this.executorProgram.programId,
    );
    const [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("prova_vault")],
      this.executorProgram.programId,
    );
    const [pendingExecution] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_exec"), ruleIdBytes],
      this.executorProgram.programId,
    );

    const { getAssociatedTokenAddress } = await import("@solana/spl-token");
    const recipientTokenAccount = await getAssociatedTokenAddress(
      tokenMint,
      new PublicKey(rule.recipient),
    );

    const pi = proof.publicWitness;
    const pad = (hex: string, len: number) =>
      hex.replace("0x", "").padStart(len * 2, "0");

    const publicInputsArg = {
      blockNumber: new BN(pi.block_number),
      stateRoot: (Buffer.from(pad(pi.state_root, 32), "hex")),
      walletAddress: (Buffer.from(pad(pi.wallet_address, 20), "hex")),
      thresholdWei: (Buffer.from(pad(pi.threshold_wei, 32), "hex")),
      ruleId: (Buffer.from(pad(pi.rule_id, 32), "hex")),
    };

    const piDebug = {
  stateRoot:    Buffer.from(pad(pi.state_root,     32), "hex").length,
  walletAddress: Buffer.from(pad(pi.wallet_address, 20), "hex").length,
  thresholdWei: Buffer.from(pad(pi.threshold_wei,  32), "hex").length,
  ruleId:       Buffer.from(pad(pi.rule_id,        32), "hex").length,
};

const argsDebug = {
  proofBytes:       Buffer.from(proof.proof.replace(/^0x/, ""), "hex").length,
  publicValues:     Buffer.from(proof.publicInputs.replace(/^0x/, ""), "hex").length,
  watchAddress:     Buffer.from(rule.watchAddress.replace(/^0x/, ""), "hex").length,
  thresholdWei:     Buffer.from(BigInt(rule.thresholdWei).toString(16).padStart(64, "0"), "hex").length,
  encryptedAmount:  Buffer.from(encryptedAmount).length,
  encryptedRecipient: Buffer.from(encryptedRecipient).length,
  pubKey:           Buffer.from(pubKey).length,
};

console.log("publicInputsArg field lengths:", piDebug);
console.log("top-level arg lengths:", argsDebug);
console.log("raw pi values:", {
  state_root:    pi.state_root,
  wallet_address: pi.wallet_address,
  threshold_wei: pi.threshold_wei,
  rule_id:       pi.rule_id,
});

    return await this.executorProgram.methods
      .submitProofAndExecute(
        // proof_bytes (Vec<u8>)
        (Buffer.from(proof.proof.replace(/^0x/, ""), "hex")),

        // public_values (Vec<u8>)
        (Buffer.from(proof.publicInputs.replace(/^0x/, ""), "hex")),

        // public_inputs (struct)
        publicInputsArg,

        // rule_watch_address [u8;20]
        (Buffer.from(rule.watchAddress.replace(/^0x/, ""), "hex")),

        // rule_threshold_wei [u8;32]
        (
          Buffer.from(
            BigInt(rule.thresholdWei).toString(16).padStart(64, "0"),
            "hex",
          ),
        ),

        // rule_recipient (pubkey)
        new PublicKey(rule.recipient),

        // rule_token_mint (pubkey)
        new PublicKey(rule.tokenMint),

        // rule_action_amount (u64) → SAFE primitive (NOT BN)
        Number(rule.actionAmount),

        // computation_offset (u64)
        Number(computationOffset.toString()),

        Buffer.from(encryptedAmount),
        Buffer.from(encryptedRecipient),
        Buffer.from(pubKey),

        // nonce (u128) → safest as BigInt
        BigInt(nonce.toString()),
      )
      .accountsPartial({
        feePayer: this.monitorKeypair.publicKey,
        rule: rulePda,
        pendingExecution,
        vaultTokenAccount,
        vaultAuthority,
        recipientTokenAccount,
        tokenMint,
        ruleTokenMint: new PublicKey(rule.tokenMint),
        // Arcium PDA helpers — exact same pattern as hello-world test
        computationAccount: getComputationAccAddress(
          clusterOffset,
          computationOffset,
        ),
        clusterAccount: getClusterAccAddress(clusterOffset),
        mxeAccount: getMXEAccAddress(this.executorProgram.programId),
        mempoolAccount: getMempoolAccAddress(clusterOffset),
        executingPool: getExecutingPoolAccAddress(clusterOffset),
        compDefAccount: getCompDefAccAddress(
          this.executorProgram.programId,
          Buffer.from(getCompDefAccOffset("execute_transfer")).readUInt32LE(),
        ),
        systemProgram: SystemProgram.programId,
      })
      .signers([this.monitorKeypair])
      .rpc({ commitment: "confirmed" });
  }

}
