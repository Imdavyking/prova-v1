import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  AddressLookupTableProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getArciumEnv,
  getClusterAccAddress,
  getMXEAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
} from "@arcium-hq/client";
import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import ExecutorIDL from "../../target/idl/prova_executor.json";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const connection = new Connection(
    "https://api.devnet.solana.com",
    "confirmed",
  );
  const rawKp = JSON.parse(
    fs.readFileSync("/Users/dave/.config/solana/monitor-keypair.json", "utf8"),
  );
  const payer = Keypair.fromSecretKey(Uint8Array.from(rawKp));

  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, {});
  const executorProgram = new anchor.Program(
    ExecutorIDL as anchor.Idl,
    provider,
  );
  const arciumEnv = getArciumEnv();
  const clusterOffset = arciumEnv.arciumClusterOffset;

  const [signPdaAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("ArciumSignerAccount")],
    executorProgram.programId,
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("prova_vault")],
    executorProgram.programId,
  );

  const staticAccounts = [
    executorProgram.programId, // arcium_program (Arcj82pX...)
    SystemProgram.programId,
    new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), // token_program
    new PublicKey("Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"),
    new PublicKey("G2sRWJvi3xoyh5k2gY49eG9L8YhAEWQPtNb1zb1GXTtC"), // pool_account
    new PublicKey("7EbMUTLo5DjdzbN7s8BXeZwXzEwNQb1hScfRvWg8a6ot"), // clock_account
    getMXEAccAddress(executorProgram.programId),
    getMempoolAccAddress(clusterOffset),
    getExecutingPoolAccAddress(clusterOffset),
    getClusterAccAddress(clusterOffset),
    getCompDefAccAddress(
      executorProgram.programId,
      Buffer.from(getCompDefAccOffset("execute_transfer")).readUInt32LE(),
    ),
    signPdaAccount,
    vaultAuthority,
  ];

  // Step 1: create the ALT
  const slot = await connection.getSlot();
  const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: slot,
  });

  // Step 2: extend it with all static accounts
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    lookupTable: altAddress,
    addresses: staticAccounts,
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [createIx, extendIx],
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  await connection.sendTransaction(tx, { skipPreflight: false });

  console.log("✅ ALT created:", altAddress.toBase58());
  // Save this address — you'll hardcode it in config
}

main();
