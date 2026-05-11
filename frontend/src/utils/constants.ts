// src/utils/constants.ts
// Prova protocol constants — loaded from Vite env vars.
// Copy .env.example → .env and fill in the values.

export const REGISTRY_PROGRAM_ID =
  (import.meta as any).env.VITE_REGISTRY_PROGRAM_ID ??
  "7bFAYfTAJEAvjc4PaAxfVgyEu2o4Tda4hqzFX2vMHVeL";

export const EXECUTOR_PROGRAM_ID =
  (import.meta as any).env.VITE_EXECUTOR_PROGRAM_ID ??
  "3KNFsYY4FC5PVxCq9dGV8v7izGKs6zRyEaUqq17C8fdA";

export const SOLANA_RPC_URL =
  (import.meta as any).env.VITE_SOLANA_RPC_URL ??
  "https://api.devnet.solana.com";

// Minimum fee the registry enforces (mirrors MIN_FEE_LAMPORTS in Rust)
export const MIN_FEE_LAMPORTS = 15_000;

// Native ETH sentinel (zero address = watch native balance)
export const NATIVE_ETH_ADDRESS = "0x0000000000000000000000000000000000000000";
