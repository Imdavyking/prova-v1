// monitor/src/index.ts
//
// Prova Monitor — main entry point.
//
// Orchestration:
//   1. Load active rules from Solana registry
//   2. Subscribe to new rules as they're registered
//   3. Watch Ethereum for condition triggers
//   4. On trigger: generate SP1 ZK proof, submit to Solana, queue Arcium MXE
//
// Run: ts-node src/index.ts
//      (or: node dist/index.js in production)

import { Connection, Keypair } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import { logger } from "./logger";
import { config } from "./config";
import { EthWatcher, TriggerEvent } from "./ethWatcher";
import { ProofGenerator } from "./proofGenerator";
import { SolanaSubmitter } from "./solanaSubmitter";
import { RegistryLoader } from "./registryloader";

async function main(): Promise<void> {
  logger.info("🚀 Prova Monitor starting...");
  logger.info("Config", {
    solanaRpc: config.solanaRpcUrl,
    proverMode: config.proverMode,
    cluster: config.arciumCluster,
  });

  // ── Set up Anchor provider ───────────────────────────────────────────────
  const connection = new Connection(config.solanaRpcUrl, "confirmed");
  const rawKp = JSON.parse(fs.readFileSync(config.monitorKeypairPath, "utf8"));
  const keypair = Keypair.fromSecretKey(Uint8Array.from(rawKp));
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  logger.info("Monitor keypair", { pubkey: keypair.publicKey.toBase58() });

  // ── Initialize components ────────────────────────────────────────────────
  const watcher = new EthWatcher();
  logger.info("Initialized Ethereum watcher");
  const prover = new ProofGenerator();
  logger.info("Initialized proof generator");
  const submitter = new SolanaSubmitter();
  logger.info("Initialized Solana submitter");
  const loader = new RegistryLoader(provider);
  logger.info("Initialized registry loader");

  // ── Load active rules and start watching ─────────────────────────────────
  const activeRules = await loader.loadActiveRules();
  activeRules.forEach((rule) => watcher.addRule(rule));

  // ── Subscribe to new rules registered on Solana ──────────────────────────
  loader.subscribeToNewRules((rule) => {
    logger.info("Adding newly registered rule to watcher", {
      ruleId: rule.ruleId,
    });
    watcher.addRule(rule);
  });

  // ── Handle condition triggers ─────────────────────────────────────────────
  watcher.on("triggered", async (event: TriggerEvent) => {
    const { rule, blockNumber } = event;

    logger.info("⚡ Processing trigger", {
      ruleId: rule.ruleId,
      block: blockNumber,
      balance: event.balance.toString(),
      threshold: rule.thresholdWei.toString(),
    });

    // Retry wrapper for the full prove + submit flow
    let attempts = 0;
    while (attempts < config.maxRetries) {
      try {
        // Step 1: Generate SP1 Groth16 proof
        const proof = await prover.generate(event);

        // Step 2: Submit proof + queue Arcium computation on Solana
        const finalizeSig = await submitter.submit(rule, proof);

        logger.info("✅ Rule fully executed!", {
          ruleId: rule.ruleId,
          finalizeSig,
        });
        break;
      } catch (err) {
        attempts++;
        logger.error("Execution attempt failed", {
          attempt: attempts,
          max: config.maxRetries,
          ruleId: rule.ruleId,
          error: String(err),
        });

        if (attempts >= config.maxRetries) {
          logger.error("❌ Max retries reached. Rule not executed.", {
            ruleId: rule.ruleId,
          });
          // Re-add to watcher as fallback so it can be retried on next block
          // In production: emit an alert here
          watcher.addRule(rule);
        } else {
          await sleep(config.retryDelayMs * attempts);
        }
      }
    }
  });

  // ── Start polling Ethereum ────────────────────────────────────────────────
  watcher.start();

  logger.info("✓ Monitor running", {
    activeRules: activeRules.length,
    polling: `every ${config.ethPollIntervalMs / 1000}s`,
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  process.on("SIGINT", () => shutdown(watcher));
  process.on("SIGTERM", () => shutdown(watcher));
}

function shutdown(watcher: EthWatcher): void {
  logger.info("Shutting down monitor...");
  watcher.stop();
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  logger.error("Fatal error", { error: String(err) });
  process.exit(1);
});
