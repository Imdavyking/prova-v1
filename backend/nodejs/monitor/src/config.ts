// monitor/src/config.ts
import * as dotenv from "dotenv";
dotenv.config();

function require_env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const config = {
  // ── Ethereum ───────────────────────────────────────────────────────────
  ethRpcUrl: require_env("ETH_RPC_URL"),
  ethRpcWsUrl: process.env["ETH_RPC_WS_URL"] ?? "",
  ethPollIntervalMs: Number(process.env["ETH_POLL_INTERVAL_MS"] ?? 12_000),

  // ── Solana ─────────────────────────────────────────────────────────────
  solanaRpcUrl:
    process.env["SOLANA_RPC_URL"] ?? "https://api.devnet.solana.com",
  monitorKeypairPath:
    process.env["MONITOR_KEYPAIR_PATH"] ??
    `${process.env.HOME}/.config/solana/id.json`,

  // ── Program IDs ────────────────────────────────────────────────────────
  registryProgramId: require_env("REGISTRY_PROGRAM_ID"),
  executorProgramId: require_env("EXECUTOR_PROGRAM_ID"),

  // ── SP1 Prover ─────────────────────────────────────────────────────────
  // "local" | "network"
  proverMode: process.env["PROVER_MODE"] ?? "local",
  sp1ScriptPath: process.env["SP1_SCRIPT_PATH"] ?? "../prova/sp1-prover/target",

  // ── Arcium ─────────────────────────────────────────────────────────────
  arciumCluster: process.env["ARCIUM_CLUSTER"] ?? "devnet",

  // ── Retry settings ─────────────────────────────────────────────────────
  maxRetries: Number(process.env["MAX_RETRIES"] ?? 3),
  retryDelayMs: Number(process.env["RETRY_DELAY_MS"] ?? 5_000),
} as const;
