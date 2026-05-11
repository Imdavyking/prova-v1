# PROVA

> **Trustless cross-chain automation.**  
> Prove a condition on Ethereum Sepolia. Execute an action on Solana Devnet.  
> No oracles. No relayers. No trusted parties.

Built for the **Solana Frontier Hackathon 2026**.

---

## Table of Contents

- [What is Prova?](#what-is-prova)
- [How it Works](#how-it-works)
- [Architecture](#architecture)
- [Sponsor Tech](#sponsor-tech)
- [Repository Structure](#repository-structure)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Build](#build)
- [Deploy](#deploy)
- [Run](#run)
- [Testing](#testing)
- [SDK Usage](#sdk-usage)
- [ZK Proof Deep Dive](#zk-proof-deep-dive)
- [Arcium Confidential Execution](#arcium-confidential-execution)
- [Rule Status Lifecycle](#rule-status-lifecycle)
- [Security Considerations](#security-considerations)
- [Common Errors](#common-errors)
- [Limitations](#limitations)

---

## What is Prova?

Every existing cross-chain automation system — Gelato, Chainlink, Wormhole — asks you to trust something: a bot, a validator set, a committee. If that thing goes offline, lies, or gets hacked, your automation breaks.

Prova is different. Instead of trusting a messenger to tell Solana what happened on Ethereum, Prova **proves** it happened using a ZK state proof. The Solana program verifies the math on-chain — only then does it execute your action, privately, through an Arcium MXE.

---

## How it Works

```
User registers rule:  "IF ETH balance < 0.5 ETH → transfer 100 USDC on Solana"
                                    ↓
Ethereum Sepolia condition triggers at a specific block
                                    ↓
SP1 Groth16 proof generated: cryptographic proof that the balance dropped
                                    ↓
Proof verified on Solana Devnet by the prova_executor program
                                    ↓
Arcium MXE evaluates transfer params privately (no MEV, no front-running)
                                    ↓
100 USDC transferred to recipient. Fee released to executor. Rule marked done.
```

Zero trusted parties. ~28 seconds end-to-end. Any EVM chain → Solana.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         SOURCE CHAIN                            │
│                       (Ethereum Sepolia)                        │
│                                                                 │
│  User's wallet ──── condition: balance < threshold              │
│  Lock contract ──── stores rule params + escrow                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │  block header + account proof
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                       SP1 PROVER (off-chain)                    │
│                                                                 │
│  Reads:  block header RLP + Merkle-Patricia account proof       │
│  Proves: balance < threshold at block N (Groth16 / BN254)       │
│  Output: 264-byte proof + public inputs                         │
└──────────────────────────┬──────────────────────────────────────┘
                           │  proof bytes + public inputs
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      SOLANA DEVNET                              │
│                                                                 │
│  prova_registry  ── stores rules, holds fee escrow              │
│       │                                                         │
│  prova_executor  ── verifies SP1 proof (BN254 precompiles)      │
│       │               matches public inputs to registered rule  │
│       │                                                         │
│  Arcium MXE      ── receives encrypted transfer params          │
│       │               MPC nodes validate privately              │
│       │               no single node sees plaintext             │
│       │                                                         │
│  SPL Transfer    ── vault → recipient                           │
│  Fee release     ── escrowed lamports → executor                │
└─────────────────────────────────────────────────────────────────┘
```

### Component Summary

| Layer                               | What it does                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `sp1-prover/program`                | zkVM circuit (RISC-V). Verifies MPT account proof, asserts balance < threshold, commits public inputs               |
| `sp1-prover/script`                 | CLI: fetches ETH state via `eth_getProof`, feeds it to the prover, outputs Groth16 proof JSON                       |
| `programs/prova_registry`           | Anchor program. Stores rules, holds fee escrow, tracks rule status lifecycle                                        |
| `programs/prova_executor`           | Arcium MXE program. Verifies SP1 proof on-chain, queues confidential computation, performs SPL transfer in callback |
| `encrypted-ixs/execute_transfer.rs` | Arcis circuit. Runs inside MPC cluster. Validates transfer params privately                                         |
| `monitor/`                          | TypeScript service. Watches Ethereum Sepolia, triggers proof generation, submits to Solana                          |
| `sdk/`                              | TypeScript SDK. Register rules, query status, subscribe to events                                                   |

---

## Sponsor Tech

| Sponsor             | Where it's used                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Arcium**          | MXE confidential execution — transfer params are encrypted with x25519+RescueCipher, evaluated privately across MPC nodes, no MEV possible |
| **SP1 by Succinct** | Groth16 zkVM prover — proves Ethereum account state on-chain using BN254 precompiles on Solana                                             |
| **Phantom**         | Wallet UX for rule registration and status tracking                                                                                        |
| **Privy**           | Embedded wallet auth — single login for both source chain and Solana                                                                       |
| **Coinbase**        | Base as source chain support + multi-chain settlement via their SDK                                                                        |

---

## Repository Structure

```
prova/
├── backend/
│   ├── prova/                          # Anchor + Arcium workspace
│   │   ├── Anchor.toml
│   │   ├── Arcium.toml
│   │   ├── Cargo.toml                  # Workspace root
│   │   │
│   │   ├── programs/
│   │   │   ├── prova_registry/src/lib.rs   # Anchor: rule storage, fee escrow
│   │   │   └── prova_executor/src/lib.rs   # Arcium MXE: proof verify + transfer
│   │   │
│   │   ├── encrypted-ixs/
│   │   │   └── execute_transfer.rs         # Arcis circuit: confidential transfer
│   │   │
│   │   └── sp1-prover/
│   │       ├── program/src/main.rs         # zkVM circuit: proves ETH balance < threshold
│   │       └── script/src/main.rs          # CLI: fetch ETH state, generate proof
│   │
│   └── nodejs/
│       ├── monitor/src/                # TypeScript off-chain monitor
│       │   ├── index.ts                # Entry point
│       │   ├── config.ts               # Env config
│       │   ├── ethWatcher.ts           # Polls Ethereum Sepolia for triggers
│       │   ├── proofGenerator.ts       # Calls SP1 prover subprocess
│       │   ├── solanaSubmitter.ts      # Submits proof + queues Arcium computation
│       │   └── registryLoader.ts       # Loads active rules from Solana
│       │
│       └── sdk/src/                    # TypeScript SDK
│           ├── ProvaSDK.ts             # Main SDK class
│           ├── registerRule.ts         # Register a rule on Solana
│           └── ruleStatus.ts           # Query rule status + polling util
│
└── frontend/                           # React/Vite landing page
    └── src/
        ├── components/                 # Hero, Demo, Architecture, etc.
        └── lib/                        # Actions, types, utilities
```

---

## Prerequisites

| Tool       | Version    | Install                                                                            |
| ---------- | ---------- | ---------------------------------------------------------------------------------- |
| Rust       | stable     | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh`                  |
| Solana CLI | **2.3.0**  | `sh -c "$(curl -sSfL https://release.solana.com/stable/install)"`                  |
| Anchor CLI | **0.32.1** | `cargo install --git https://github.com/coral-xyz/anchor anchor-cli --tag v0.32.1` |
| Arcium CLI | **0.9.7**  | `curl --proto '=https' --tlsv1.2 -sSfL https://install.arcium.com/ \| bash`        |
| SP1        | 6.1.0      | `curl -L https://sp1.succinct.xyz \| bash && sp1up`                                |
| Docker     | latest     | Required by Arcium — [docs.docker.com](https://docs.docker.com/engine/install/)    |
| Node.js    | **20+**    | via `nvm`                                                                          |

> **Windows:** Arcium does not support Windows. Use WSL2 with Ubuntu.

---

## Getting Started

### 1. Install Tools

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

# Solana CLI
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Anchor
cargo install --git https://github.com/coral-xyz/anchor anchor-cli --tag v0.32.1

# Arcium
curl --proto '=https' --tlsv1.2 -sSfL https://install.arcium.com/ | bash
arcium --version   # verify

# SP1
curl -L https://sp1.succinct.xyz | bash && sp1up

# Node / Yarn
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20
npm install -g yarn
```

### 2. Clone and Install

```bash
git clone https://github.com/Imdavyking/prova
cd prova

cd backend/nodejs/monitor && yarn && cd ../../..
cd backend/nodejs/sdk    && yarn && cd ../../..
```

### 3. Wallet Setup

```bash
# Main deploy wallet
solana-keygen new -o ~/.config/solana/id.json

# Separate monitor keypair (the off-chain bot that submits proofs)
solana-keygen new -o ~/.config/solana/monitor.json

# Point CLI to devnet and fund both
solana config set --url devnet
solana airdrop 4 ~/.config/solana/id.json
solana airdrop 4 ~/.config/solana/monitor.json

# Confirm balances
solana balance ~/.config/solana/id.json
solana balance ~/.config/solana/monitor.json
```

### 4. Configure Environment

Copy the example file and fill in your values:

```bash
cp frontend/.env.example frontend/.env
```

```bash
# monitor/.env
ETH_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
ETH_RPC_WS_URL=wss://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
SOLANA_RPC_URL=https://api.devnet.solana.com
MONITOR_KEYPAIR_PATH=~/.config/solana/monitor.json
REGISTRY_PROGRAM_ID=REGSpRoVaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
EXECUTOR_PROGRAM_ID=EXECpRoVaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
PROVER_MODE=local
ARCIUM_CLUSTER=devnet

# Optional: Succinct Prover Network key (proving: ~20s vs ~90s local)
SP1_PRIVATE_KEY=
```

> Get a free Alchemy Sepolia key at [dashboard.alchemy.com](https://dashboard.alchemy.com/).

---

## Build

### 1. SP1 Prover Circuit

```bash
cd backend/prova/sp1-prover/

cargo build --release -p prova-prove

cd backend/prova/sp1-prover/program

# Compile zkVM circuit to RISC-V ELF
cargo prove build

# Get the verification key hash
# The ELF lands in the parent sp1-prover/target/ directory, not program/target/
cargo prove vkey --elf ../target/elf-compilation/riscv64im-succinct-zkvm-elf/release/balance-prover
```

The output looks like:

```
Verification Key Hash:
0x007153c5b0763478a99a517ba9d7c55c9970c7aa01fc5bf7d49514115e4309e4
```

Paste that hash into `programs/prova_executor/src/lib.rs` as `BALANCE_PROVER_VK_HASH`:

```rust
const BALANCE_PROVER_VK_HASH: &str =
    "0x007153c5b0763478a99a517ba9d7c55c9970c7aa01fc5bf7d49514115e4309e4";
```

This ties the on-chain verifier to your compiled circuit — a mismatch causes every proof to be rejected.

```bash
cd ../../../..
```

### 2. Solana + Arcium Programs

```bash
# Builds prova_registry, prova_executor, and the Arcis execute_transfer circuit
arcium build
```

Two IDL files appear at `target/idl/` after a successful build — used automatically by the monitor and SDK.

### 3. Monitor

```bash
cd backend/nodejs/monitor && yarn build && cd ../../..
```

---

## Deploy

### 1. Deploy Programs

```bash
arcium deploy \
  --keypair-path ~/.config/solana/id.json \
  --cluster-offset 456 \
  --recovery-set-size 4 \
  --rpc-url https://solana-devnet.g.alchemy.com/v2/YOUR_KEY
```

```bash
arcium init-mxe \
  --keypair-path ~/.config/solana/id.json \
  --callback-program 3KNFsYY4FC5PVxCq9dGV8v7izGKs6zRyEaUqq17C8fdA \
  --cluster-offset 456 \
  --recovery-set-size 4 \
  --rpc-url https://api.devnet.solana.com
```

Note the three output values:

```
Registry Program ID:  REGSxxxx...
Executor Program ID:  EXECxxxx...
MXE Key:              mxe_xxxx...
Cluster Offset:       456
```

### 2. Update Config Files

**`backend/prova/Anchor.toml`**

```toml
[programs.devnet]
prova_registry = "REGSxxxx..."
prova_executor = "EXECxxxx..."
```

**`backend/prova/Arcium.toml`**

```toml
[mxe]
name    = "prova_executor"
mxe_key = "mxe_xxxx..."

[clusters.devnet]
offset = 456
```

Also update `REGISTRY_PROGRAM_ID` and `EXECUTOR_PROGRAM_ID` in `monitor/.env`.

### 3. Initialize On-Chain State

Run these scripts once after each fresh deploy:

```bash
# Initialize the registry global state (sets protocol fee, authority)
yarn ts-node scripts/initialize_registry.ts

# Register the execute_transfer computation definition with Arcium
yarn ts-node scripts/init_comp_def.ts

# Fund the vault token account with USDC for payouts
yarn ts-node scripts/fund_vault.ts --amount 10000
```

<details>
<summary><code>initialize_registry.ts</code> — example</summary>

```typescript
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import RegistryIDL from "../target/idl/prova_registry.json";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = new anchor.Program(
  RegistryIDL as anchor.Idl,
  new PublicKey(process.env.REGISTRY_PROGRAM_ID!),
  provider,
);

const [registryStatePda] = PublicKey.findProgramAddressSync(
  [Buffer.from("prova_registry")],
  program.programId,
);

await program.methods
  .initialize(50) // 50 bps = 0.5% protocol fee
  .accounts({
    registryState: registryStatePda,
    authority: provider.wallet.publicKey,
  })
  .rpc();

console.log("Registry initialized:", registryStatePda.toBase58());
```

</details>

---

## Run

### Start the Monitor

```bash
cd backend/nodejs/monitor
yarn start
```

The monitor loads all active rules, subscribes to new `RuleRegistered` events, then polls Ethereum Sepolia every ~12 seconds:

```
2026-05-04T12:00:00Z [info] 🚀 Prova Monitor starting...
2026-05-04T12:00:01Z [info] Loaded 3 active rules
2026-05-04T12:00:01Z [info] ETH watcher started { interval: 12000 }
2026-05-04T12:01:13Z [info] 🔔 Condition triggered! { ruleId: '0xdeadbeef...', block: 7234891 }
2026-05-04T12:01:13Z [info] Generating ZK proof...
2026-05-04T12:02:41Z [info] ✓ Proof generated in 88.2s
2026-05-04T12:02:43Z [info] Rule → Triggered  { sig: '5xGH...' }
2026-05-04T12:02:44Z [info] Rule → Proving    { sig: '7rKP...' }
2026-05-04T12:02:45Z [info] Proof tx queued   { queueSig: '3mNQ...' }
2026-05-04T12:02:45Z [info] Waiting for Arcium MXE computation...
2026-05-04T12:03:10Z [info] ✓ Arcium computation finalized { finalizeSig: '9wBZ...' }
2026-05-04T12:03:10Z [info] ✅ Rule fully executed! { ruleId: '0xdeadbeef...' }
```

### Generate a Proof Manually

```bash
cd backend/prova/sp1-prover/script

cargo run --release -- \
  --rpc-url https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY \
  --block 7234891 \
  --wallet 0x4F8a...9B2c \
  --threshold 500000000000000000 \
  --rule-id 0xdeadbeef... \
  --output proof.json
```

---

## Testing

### Anchor Tests

```bash
# Full test suite against localnet
anchor test
```

Covers: initialize registry, register rule, mark triggered / proving / executed, cancel rule, executor proof verification.

### Register a Test Rule

```typescript
// scripts/register_test_rule.ts
import { ProvaSDK, SourceChain, ConditionType, ActionType } from "../sdk/src";
import { Connection, Keypair } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const rawKp = JSON.parse(
  fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf8"),
);
const keypair = Keypair.fromSecretKey(Uint8Array.from(rawKp));
const sdk = new ProvaSDK(new anchor.Wallet(keypair), connection, {
  registryProgramId: process.env.REGISTRY_PROGRAM_ID!,
  executorProgramId: process.env.EXECUTOR_PROGRAM_ID!,
  cluster: "devnet",
});

const result = await sdk.registerRule({
  sourceChain: SourceChain.Ethereum,
  conditionType: ConditionType.BalanceBelow,
  watchAddress: "0xYOUR_SEPOLIA_WALLET",
  tokenAddress: "0x0000000000000000000000000000000000000000",
  thresholdWei: "500000000000000000", // 0.5 ETH
  actionType: ActionType.TransferSpl,
  recipient: keypair.publicKey.toBase58(),
  tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  actionAmount: "1000000", // 1 USDC
  escrowedFeeLamports: 50_000,
});

console.log("Rule registered:", result);
```

```bash
yarn ts-node scripts/register_test_rule.ts
```

The monitor terminal should immediately print:

```
[info] New rule registered { ruleId: '0xabcd...' }
[info] Watching rule { address: '0xYOUR_SEPOLIA_WALLET' }
```

### Trigger the Condition Without Spending Real ETH

Use Anvil to fork Sepolia locally and drain the watched wallet in a controlled way:

```bash
# Terminal 1 — fork Sepolia at a specific block
anvil \
  --fork-url https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY \
  --fork-block-number 7234891

# Terminal 2 — drain the watched wallet below threshold
cast send 0xRECIPIENT \
  --value 0.2ether \
  --from 0xYOUR_WATCHED_WALLET \
  --rpc-url http://localhost:8545
```

Set `ETH_RPC_URL=http://localhost:8545` in `monitor/.env` and restart the monitor. The condition triggers on the next poll cycle.

### Query Rule Status

```bash
yarn ts-node -e "
const { ProvaSDK } = require('./sdk/src');
const { Connection, Keypair } = require('@solana/web3.js');
const anchor = require('@coral-xyz/anchor');
const fs = require('fs');

const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf8'))));
const sdk = new ProvaSDK(new anchor.Wallet(kp), connection, {
  registryProgramId: process.env.REGISTRY_PROGRAM_ID,
  executorProgramId: process.env.EXECUTOR_PROGRAM_ID,
  cluster: 'devnet',
});

const rules = await sdk.getUserRules(kp.publicKey);
console.log(rules.map(r => ({ id: r.ruleId.slice(0, 10), status: r.status })));
"
```

---

## SDK Usage

```typescript
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { ProvaSDK, SourceChain, ConditionType, ActionType } from "@prova/sdk";

function useProva() {
  const wallet = useAnchorWallet();
  const { connection } = useConnection();
  return wallet ? new ProvaSDK(wallet, connection) : null;
}

// Register a rule
const { txSig, ruleId, rulePda } = await sdk.registerRule({
  sourceChain: SourceChain.Ethereum,
  conditionType: ConditionType.BalanceBelow,
  watchAddress: "0x4F8a...9B2c",
  tokenAddress: "0x0000000000000000000000000000000000000000",
  thresholdWei: "500000000000000000",
  actionType: ActionType.TransferSpl,
  recipient: "7GsnYmPq...",
  tokenMint: "EPjFWdd5...",
  actionAmount: "100000000",
  escrowedFeeLamports: 50_000,
});

// Fetch all rules for the connected wallet
const rules = await sdk.getUserRules(wallet.publicKey);

// Poll until executed — drives the progress UI
import { pollUntilExecuted } from "@prova/sdk";
await pollUntilExecuted(sdk, new PublicKey(rulePda), (status) => {
  console.log("Status update:", status);
  // Active → Triggered → Proving → Executed
});

// Subscribe to execution events in real time
const unsubscribe = sdk.onRuleExecuted(({ ruleId, executedAt }) => {
  console.log(`Rule ${ruleId} executed at ${executedAt}`);
});
```

---

## ZK Proof Deep Dive

The SP1 circuit (`sp1-prover/program/src/main.rs`) runs inside the SP1 zkVM and proves three things in zero knowledge:

1. **Block header integrity** — the RLP-encoded block header hashes to the claimed `state_root`
2. **Account inclusion** — the account at `wallet_address` exists in the state trie (Merkle-Patricia proof)
3. **Balance condition** — the account's balance decoded from RLP is strictly less than `threshold_wei`

The proof commits four public values: `block_number`, `state_root`, `wallet_address`, `threshold_wei`. The Solana verifier checks these against the registered rule — mismatched proofs revert.

**Proof stats:**

| Metric                          | Value               |
| ------------------------------- | ------------------- |
| Circuit                         | Groth16 on BN254    |
| Proof size                      | ~264 bytes          |
| Verification cost               | ~280k compute units |
| Proving time (local CPU)        | ~90s                |
| Proving time (Succinct Network) | ~20s                |

---

## Arcium Confidential Execution

Without Arcium, anyone watching the Solana mempool could see the rule is about to execute and front-run the USDC transfer. With Arcium:

1. The monitor encrypts `(amount, recipient_tag)` with x25519 + RescueCipher before submitting
2. The `execute_transfer` Arcis circuit runs across MPC nodes — no single node reconstructs the plaintext
3. The circuit validates constraints privately: `amount > 0`, `amount <= MAX_TRANSFER_AMOUNT`, `recipient_tag != 0`
4. Only after MPC consensus does the Solana callback fire the actual SPL transfer

The transfer is MEV-resistant and rule parameters stay private until settlement.

---

## Rule Status Lifecycle

```
ACTIVE
  │  condition detected by monitor
  ▼
TRIGGERED
  │  proof generation started
  ▼
PROVING
  │  proof submitted, Arcium computation queued
  ▼
EXECUTED  ──── escrowed fee released to executor
```

A rule can also transition to `CANCELLED` from `ACTIVE` (owner calls `cancel_rule`, escrowed fee returned).

---

## Security Considerations

**Double-execution prevention** — the registry rejects any status transition that skips a step. A proof cannot be submitted for a rule that is not in `Triggered` status.

**Public input binding** — the executor checks that `wallet_address`, `threshold_wei`, and `rule_id` in the proof public values exactly match the registered rule. Mismatched proofs are rejected.

**Fee slashing (TODO)** — in production, executor nodes should stake and be slashable for submitting invalid proofs. Currently the monitor keypair is trusted.

**Proof replay** — rule IDs are unique and status transitions are one-way. A proof for an already-executed rule fails the `RuleNotProving` check.

**Arcium MXE output** — the callback verifies the computation output against the cluster account before executing. A failed MPC computation returns an error, not a silent no-op.

---

## Common Errors

| Error                                | Fix                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `cargo prove vk` not found           | Use `cargo prove vkey --elf ../target/elf-compilation/riscv64im-succinct-zkvm-elf/release/balance-prover`                |
| `arcium localnet` times out on macOS | macOS file descriptor limit — see fix below                                                                              |
| `Account not found` on registry init | Run `initialize_registry.ts` first                                                                                       |
| `InvalidProof` from executor         | `BALANCE_PROVER_VK_HASH` mismatch — re-run `cargo prove vkey --elf ../target/.../balance-prover` and update the constant |
| `getMXEPublicKeyWithRetry` times out | Arcium devnet MXE isn't ready — wait 30s and retry, or run `arcium status`                                               |
| Monitor not detecting condition      | `ETH_RPC_URL` doesn't support `debug_getRawHeader` — use an Alchemy archive endpoint                                     |
| `RuleNotActive` on `markTriggered`   | Rule was already triggered — check status with `getRuleStatus()`                                                         |
| Proof generation hangs               | Normal for local CPU — Groth16 takes 90–120s. Set `PROVER_MODE=network` for Succinct Network (~20s)                      |

### macOS: `arcium localnet` Times Out

The real cause is the macOS kernel file descriptor cap. The Solana validator opens thousands of files during startup (RocksDB + account hash cache). When `kern.maxfilesperproc` is too low, all validator threads panic with `Too many open files (os error 24)`.

**Fix (run once, requires sudo):**

```bash
sudo sysctl -w kern.maxfiles=1048576
sudo sysctl -w kern.maxfilesperproc=1048576
ulimit -n 1048576
arcium localnet
```

**Make it permanent:**

```bash
# Add to /etc/sysctl.conf
echo "kern.maxfiles=1048576"      | sudo tee -a /etc/sysctl.conf
echo "kern.maxfilesperproc=1048576" | sudo tee -a /etc/sysctl.conf

# Add to ~/.zshrc (or ~/.bashrc)
echo "ulimit -n 1048576" >> ~/.zshrc
```

---

## Limitations

- **EVM source chains only** — the SP1 circuit understands Ethereum's MPT structure. Cosmos/Substrate require different proof circuits.
- **SPL token actions only** — native SOL transfers and arbitrary CPI calls are not yet supported.
- **Single condition per rule** — composite conditions (AND/OR) are not implemented.
- **Single trusted monitor** — the executor node network is currently one keypair. A decentralized staked executor network is the next step.

---

## License

MIT — built for the Solana Frontier Hackathon 2026.
