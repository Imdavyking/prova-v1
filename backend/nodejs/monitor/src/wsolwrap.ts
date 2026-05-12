// fund_vault.mjs
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAccount,
  createInitializeAccountInstruction,
  createTransferInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  ACCOUNT_SIZE,
} from "@solana/spl-token";
import { readFileSync } from "fs";
import { homedir } from "os";

// ── Config ────────────────────────────────────────────────────────────────────
const RPC = "https://api.devnet.solana.com"; // change if mainnet
const PROGRAM = new PublicKey("3KNFsYY4FC5PVxCq9dGV8v7izGKs6zRyEaUqq17C8fdA");
const WRAP_SOL = 5; // amount to wrap
// ─────────────────────────────────────────────────────────────────────────────

const connection = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8")),
  ),
);

// Derive vault PDA  →  seeds: ["prova_vault", WSOL_MINT]
const [vaultTokenAccount] = PublicKey.findProgramAddressSync(
  [Buffer.from("prova_vault"), NATIVE_MINT.toBuffer()],
  PROGRAM,
);

// Vault authority PDA  →  seeds: ["prova_vault"]
const [vaultAuthority] = PublicKey.findProgramAddressSync(
  [Buffer.from("prova_vault")],
  PROGRAM,
);

console.log("Payer:              ", payer.publicKey.toBase58());
console.log("Vault token account:", vaultTokenAccount.toBase58());
console.log("Vault authority:    ", vaultAuthority.toBase58());

async function main() {
  const tx = new Transaction();
  const lamports = WRAP_SOL * LAMPORTS_PER_SOL;

  // ── 1. Create your WSOL ATA if needed ─────────────────────────────────────
  const payerWSOL = getAssociatedTokenAddressSync(NATIVE_MINT, payer.publicKey);
  try {
    await getAccount(connection, payerWSOL);
  } catch {
    tx.add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        payerWSOL,
        payer.publicKey,
        NATIVE_MINT,
      ),
    );
  }

  // ── 2. Wrap SOL into your WSOL ATA ────────────────────────────────────────
  tx.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: payerWSOL,
      lamports,
    }),
    createSyncNativeInstruction(payerWSOL),
  );

  // ── 3. Init vault token account if it doesn't exist ───────────────────────
  let vaultExists = false;
  try {
    await getAccount(connection, vaultTokenAccount);
    vaultExists = true;
  } catch {
    // Need rent for a token account
    const rentLamports =
      await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
    tx.add(
      SystemProgram.createAccountWithSeed({
        // Can't create PDA account directly;
        fromPubkey: payer.publicKey, // use a raw createAccount pointing at
        newAccountPubkey: vaultTokenAccount, // the PDA address.
        basePubkey: payer.publicKey, // ← won't work for PDA, see note below
        seed: "",
        lamports: rentLamports,
        space: ACCOUNT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccountInstruction(
        vaultTokenAccount,
        NATIVE_MINT,
        vaultAuthority, // authority = vault authority PDA
      ),
    );
  }

  // ── 4. Transfer WSOL from your ATA → vault ────────────────────────────────
  tx.add(
    createTransferInstruction(
      payerWSOL,
      vaultTokenAccount,
      payer.publicKey,
      lamports,
    ),
  );

  const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
  console.log("Done:", sig);
}

main().catch(console.error);
