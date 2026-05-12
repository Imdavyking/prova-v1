// monitor/src/solanaSubmitter.ts

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
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
import { ALT_ADDRESS, config } from "./config";
import { GeneratedProof } from "./proofGenerator";
import { ActiveRule } from "./ethWatcher";

import RegistryIDL from "../../target/idl/prova_registry.json";
import ExecutorIDL from "../../target/idl/prova_executor.json";
import { TOKEN_PROGRAM_ID } from "@coral-xyz/anchor/dist/cjs/utils/token";

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
      nonce: new BN(nonceBuf.toString("hex"), 16),
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

    const watchbuf = Buffer.from(rule.watchAddress.replace(/^0x/, ""), "hex");

    console.log("watchAddress length:", watchbuf.length);
    const thresholdBuf = Buffer.from(
      BigInt(rule.thresholdWei).toString(16).padStart(64, "0"),
      "hex",
    );
    console.log("thresholdWei length:", thresholdBuf.length);

    console.log("encryptedAmount", encryptedAmount.length);
    console.log("encryptedRecipient", encryptedRecipient.length);
    console.log("pubKey", pubKey.length);

    const [signPdaAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("ArciumSignerAccount")],
      this.executorProgram.programId,
    );

    console.log("nonce byteLength", nonce.toArrayLike(Buffer, "le").length);

    console.log("nonce hex", nonce.toString(16));

    console.log(
      "computationOffset bytes",
      computationOffset.toArrayLike(Buffer, "le").length,
    );

    console.log("computationOffset", computationOffset.toString());

    const checkU8Array = (name: string, arr: number[], expected: number) => {
      console.log(name, "len =", arr.length);

      const bad = arr.find(
        (v) =>
          typeof v !== "number" || v < 0 || v > 255 || !Number.isInteger(v),
      );

      if (bad !== undefined) {
        console.error(name, "BAD VALUE:", bad);
      }

      if (arr.length !== expected) {
        console.error(name, "BAD LENGTH");
      }
    };

    checkU8Array("encryptedAmount", encryptedAmount, 32);
    checkU8Array("encryptedRecipient", encryptedRecipient, 32);
    checkU8Array("pubKey", pubKey, 32);
    checkU8Array("ruleId", Array.from(ruleIdBytes), 32);
    checkU8Array("watchbuf", Array.from(watchbuf), 20);
    checkU8Array("thresholdBuf", Array.from(thresholdBuf), 32);

    return await this.executorProgram.methods
      .submitProofAndExecute(
        Buffer.from(proof.proof.replace(/^0x/, ""), "hex"),

        Buffer.from(proof.publicInputs.replace(/^0x/, ""), "hex"),

        Array.from(ruleIdBytes),

        Array.from(watchbuf),

        Array.from(thresholdBuf),

        new PublicKey(rule.recipient),

        new PublicKey(rule.tokenMint),

        new BN(rule.actionAmount.toString()),

        computationOffset,

        Array.from(encryptedAmount),

        Array.from(encryptedRecipient),

        Array.from(pubKey),

        nonce,
      )
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 1,
        }),
      ])
      .accountsStrict({
        feePayer: this.monitorKeypair.publicKey,
        pendingExecution,
        vaultTokenAccount,
        vaultAuthority,
        recipientTokenAccount,
        ruleTokenMint: new PublicKey(rule.tokenMint),
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
        signPdaAccount,
        systemProgram: SystemProgram.programId,
        poolAccount: new PublicKey(
          "G2sRWJvi3xoyh5k2gY49eG9L8YhAEWQPtNb1zb1GXTtC",
        ),
        clockAccount: new PublicKey(
          "7EbMUTLo5DjdzbN7s8BXeZwXzEwNQb1hScfRvWg8a6ot",
        ),
        rent: SYSVAR_RENT_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        arciumProgram: new PublicKey(
          "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ",
        ),
      })
      .signers([this.monitorKeypair])
      .rpc({ commitment: "confirmed" });
  }
}
