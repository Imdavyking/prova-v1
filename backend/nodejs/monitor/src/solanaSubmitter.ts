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

    await this.markTriggered(rulePda, proof.publicInputs.blockNumber);
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
    const sig = await this.registryProgram.methods
      .markTriggered(new BN(blockNumber))
      .accounts({ rule: rulePda, monitor: this.monitorKeypair.publicKey })
      .signers([this.monitorKeypair])
      .rpc();
    logger.info("Rule → Triggered", { sig });
  }

  private async markProving(rulePda: PublicKey): Promise<void> {
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

    return this.executorProgram.methods
      .submitProofAndExecute(
        Array.from(proof.proofBytes),
        this.encodePublicInputs(proof),
        computationOffset,
        encryptedAmount,
        encryptedRecipient,
        pubKey,
        nonce,
      )
      .accountsPartial({
        feePayer: this.monitorKeypair.publicKey,
        rule: rulePda,
        pendingExecution,
        vaultTokenAccount,
        vaultAuthority,
        recipientTokenAccount,
        tokenMint,
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

  private encodePublicInputs(proof: GeneratedProof): object {
    const pi = proof.publicInputs;
    const pad = (hex: string, len: number) =>
      hex.replace("0x", "").padStart(len * 2, "0");
    return {
      blockNumber: new BN(pi.blockNumber),
      stateRoot: Array.from(Buffer.from(pad(pi.stateRoot, 32), "hex")),
      walletAddress: Array.from(Buffer.from(pad(pi.walletAddress, 20), "hex")),
      thresholdWei: Array.from(Buffer.from(pad(pi.thresholdWei, 32), "hex")),
      ruleId: Array.from(Buffer.from(pad(pi.ruleId, 32), "hex")),
    };
  }
}
