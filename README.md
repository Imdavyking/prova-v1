# PROVA

> **Trustless cross-chain automation.**
> Prove a condition on Ethereum. Execute an action on Solana.
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

Prova is different. Instead of trusting a messenger to tell Solana what happened on Ethereum, Prova **proves** it happened using a ZK state proof. A Noir circuit generates the proof using Barretenberg's UltraHonk backend — Garaga converts it into Solana-compatible calldata and the Solana program verifies the math on-chain. Only then does it execute your action, privately, through an Arcium MXE.

---

## How it Works

```
User registers rule:  "IF ETH balance < 0.5 ETH → transfer 100 USDC on Solana"
                                    ↓
Ethereum Sepolia condition triggers at a specific block
                                    ↓
Noir circuit generates a proof: cryptographic proof that the balance dropped
(proving backend — proof converted to Solana calldata via Garaga)
                                    ↓
Proof verified on Solana Devnet by the prova_executor program
(gnark-verifier-solana handles on-chain verification)
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
│              NOIR PROVER + BARRETENBERG (off-chain)             │
│                                                                 │
│  Reads:  block header RLP + Merkle-Patricia account proof       │
│  Circuit: Noir (main.nr) proves balance < threshold             │
│                      │
│  Output: proof bytes converted to Solana calldata via Garaga    │
└──────────────────────────┬──────────────────────────────────────┘
                           │  proof calldata + public inputs
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      SOLANA DEVNET                              │
│                                                                 │
│  prova_registry  ── stores rules, holds fee escrow              │
│       │                                                         │
│  prova_executor  ── verifies Noir/Honk proof                    │
│       │               (gnark-verifier-solana)                   │
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

| Layer                               | What it does                                                                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `noir_prover/src/main.nr`           | Noir circuit. Verifies MPT account proof, asserts balance < threshold, commits public inputs                                                 |
| `noir_prover/scripts/fetch_witness` | CLI: fetches ETH state via `eth_getProof`, builds witness for the Noir circuit                                                               |
| `frontend/src/helpers/gen_proof.ts` | In-browser proving: Garaga calldata conversion                                                      |
| `programs/prova_registry`           | Anchor program. Stores rules, holds fee escrow, tracks rule status lifecycle                                                                 |
| `programs/prova_executor`           | Arcium MXE program. Verifies Noir proof on-chain (gnark-verifier-solana), queues confidential computation, performs SPL transfer in callback |
| `encrypted-ixs/execute_transfer.rs` | Arcis circuit. Runs inside MPC cluster. Validates transfer params privately                                                                  |
| `monitor/`                          | TypeScript service. Watches Ethereum Sepolia, triggers proof generation, submits to Solana                                                   |
| `sdk/`                              | TypeScript SDK. Register rules, query status, subscribe to events                                                                            |

---

## What Are We Building, and Who Is It For?

**What:** Prova is a trustless cross-chain automation protocol. Users define rules like "if my ETH balance drops below 0.5 ETH, send 100 USDC to my Solana wallet" — and Prova executes them without any trusted intermediary.

**How:** A Noir circuit running in the browser generates a zero-knowledge proof that an on-chain condition was met on Ethereum. Garaga converts that proof into calldata the Solana program can verify. Arcium's MXE then executes the action privately, preventing MEV and front-running.

**Who it's for:** DeFi users and developers who want to automate cross-chain actions — stop-loss orders, yield rebalancing, liquidation protection, conditional token transfers — without handing control to a bot, relayer, or trusted committee.

---

## Why Build This, and Why Now?

Every cross-chain automation tool today has a trust assumption baked in. Gelato relies on a network of bots. Chainlink Automation trusts DON validators. Wormhole relies on a guardian set. If any of those go offline, lie, or get exploited, your automation silently fails or executes incorrectly.

ZK proof systems have matured enough to make the trustless version practical. Noir gives us a clean, auditable circuit language. Backend produces compact proofs fast enough for real user flows. Garaga bridges the proof format gap between EVM and Solana. Arcium adds confidential execution so the action itself can't be front-run.

The Solana Frontier Hackathon is the right moment: Solana's BN254 precompile support and Arcium's devnet availability finally make the full stack feasible in a hackathon timeframe.

---

## Sponsor Tech

| Sponsor                  | Where it's used                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Arcium**               | MXE confidential execution — transfer params are encrypted with x25519+RescueCipher, evaluated privately across MPC nodes, no MEV possible |
| **Noir**                 | ZK circuit language — `main.nr` proves Ethereum account state: block header integrity, MPT account inclusion, balance < threshold          |
| **Garaga**               | Converts proof output into Solana-compatible calldata for on-chain verification                                                  |
| **Phantom**              | Wallet UX for rule registration and status tracking                                                                                        |
| **Privy**                | Embedded wallet auth — single login for both source chain and Solana                                                                       |
| **Coinbase**             | Base as source chain support + multi-chain settlement via their SDK                                                                        |

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
│   │   ├── noir_prover/
│   │   │   ├── src/main.nr                 # Noir ZK circuit: proves ETH balance < threshold
│   │   │   ├── Nargo.toml
│   │   │   └── scripts/fetch_witness.js    # Fetches ETH state + builds witness
│   │   │
│   │   └── solana_gen_vk/
│   │       └── src/main.rs                 # Generates verifying key file for on-chain use
│   │
│   └── nodejs/
│       ├── monitor/src/                # TypeScript off-chain monitor
│       │   ├── index.ts                # Entry point
│       │   ├── config.ts               # Env config
│       │   ├── ethWatcher.ts           # Polls Ethereum Sepolia for triggers
│       │   ├── proofGenerator.ts       # Calls Noir prover subprocess
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
        ├── helpers/
        │   ├── gen_proof.ts            # In-browser Noir proving (Garaga)
        │   └── merkle_tree.ts          # MPT helper
        └── lib/                        # Actions, types, utilities
```

---

## Prerequisites

| Tool         | Version    | Install                                                                                     |
| ------------ | ---------- | ------------------------------------------------------------------------------------------- |
| Rust         | stable     | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh`                           |
| Solana CLI   | **2.3.0**  | `sh -c "$(curl -sSfL https://release.solana.com/stable/install)"`                           |
| Anchor CLI   | **0.32.1** | `cargo install --git https://github.com/coral-xyz/anchor anchor-cli --tag v0.32.1`          |
| Arcium CLI   | **0.9.7**  | `curl --proto '=https' --tlsv1.2 -sSfL https://install.arcium.com/ \| bash`                 |
| Nargo (Noir) | latest     | `curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install \| bash && noirup` |
| Docker       | latest     | Required by Arcium — [docs.docker.com](https://docs.docker.com/engine/install/)             |
| Node.js      | **20+**    | via `nvm`                                                                                   |

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

# Nargo (Noir toolchain)
curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
noirup

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
cd backend/prova/noir_prover/scripts && yarn && cd ../../../..
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
ARCIUM_CLUSTER=devnet
```

> Get a free Alchemy Sepolia key at [dashboard.alchemy.com](https://dashboard.alchemy.com/).

---

## Build

### 1. Compile the Noir Circuit

```bash
cd backend/prova/noir_prover

# Compile circuit and generate the verifying key
nargo compile
nargo info

cd ../../..
```

The compiled circuit JSON lands at `noir_prover/target/noir_prover.json` (also copied to `frontend/src/assets/circuit.json`).

### 2. Generate the Solana Verifying Key

```bash
cd backend/prova/solana_gen_vk

# Point to your compiled .vk file and generate the Rust constant
VK_PATH=../noir_prover/target/noir_prover.vk cargo run --release

cd ../../..
```

This writes `programs/prova_executor/src/vk.rs` — the on-chain verifier constant. Rebuilding after any circuit change is required.

### 3. Solana + Arcium Programs

```bash
# Builds prova_registry, prova_executor, and the Arcis execute_transfer circuit
arcium build
```

Two IDL files appear at `target/idl/` after a successful build — used automatically by the monitor and SDK.

### 4. Monitor

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
  --rpc-url https://solana-devnet.g.alchemy.com/v2/pkf1MmFFP3jrtqw0BR7vCInGmCeUFwO7 \
  --resume
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
2026-05-04T12:01:13Z [info] Generating ZK proof (Noir + Barretenberg)...
2026-05-04T12:02:41Z [info] ✓ Proof generated in 88.2s
2026-05-04T12:02:43Z [info] Rule → Triggered  { sig: '5xGH...' }
2026-05-04T12:02:44Z [info] Rule → Proving    { sig: '7rKP...' }
2026-05-04T12:02:45Z [info] Proof tx queued   { queueSig: '3mNQ...' }
2026-05-04T12:02:45Z [info] Waiting for Arcium MXE computation...
2026-05-04T12:03:10Z [info] ✓ Arcium computation finalized { finalizeSig: '9wBZ...' }
2026-05-04T12:03:10Z [info] ✅ Rule fully executed! { ruleId: '0xdeadbeef...' }
```

### Generate a Witness + Proof Manually

```bash
cd backend/prova/noir_prover/scripts

node fetch_witness.js \
  --rpc-url https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY \
  --block 7234891 \
  --wallet 0x4F8a...9B2c \
  --threshold 500000000000000000 \
  --rule-id 0xdeadbeef...

# Prove with Nargo (local)
cd ..
nargo prove
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

The Noir circuit (`noir_prover/src/main.nr`) proves three things in zero knowledge:

1. **Block header integrity** — the RLP-encoded block header hashes to the claimed `state_root`
2. **Account inclusion** — the account at `wallet_address` exists in the state trie (Merkle-Patricia proof)
3. **Balance condition** — the account's balance decoded from RLP is strictly less than `threshold_wei`

The circuit commits five public inputs: `block_number`, `state_root`, `wallet_address`, `threshold_wei`, `rule_id`. The Solana verifier checks these against the registered rule — mismatched proofs revert.

**Proof stack:**

| Layer                 | Technology                              |
| --------------------- | --------------------------------------- |
| Circuit language      | Noir (`main.nr`)                        |
| Proof ↔ Solana bridge | Garaga (`getZKHonkCallData`)            |
| On-chain verifier     | `gnark-verifier-solana`                 |

**Proof stats:**

| Metric                    | Value                    |
| ------------------------- | ------------------------ |
| Proof size                | ~264 bytes               |
| Verification cost         | ~280k compute units      |
| Proving time (local CPU)  | ~90s                     |
| Proving time (in-browser) | ~20–30s (WASM)           |

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
  │  proof generation started (Noir + Barretenberg)
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

**Public input binding** — the executor checks that `wallet_address`, `threshold_wei`, and `rule_id` in the proof public inputs exactly match the registered rule. Mismatched proofs are rejected.

**Fee slashing (TODO)** — in production, executor nodes should stake and be slashable for submitting invalid proofs. Currently the monitor keypair is trusted.

**Proof replay** — rule IDs are unique and status transitions are one-way. A proof for an already-executed rule fails the `RuleNotProving` check.

**Arcium MXE output** — the callback verifies the computation output against the cluster account before executing. A failed MPC computation returns an error, not a silent no-op.

---

## Common Errors

| Error                                | Fix                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `nargo compile` fails                | Ensure Nargo is installed: `noirup` to get the latest version                                  |
| `VK_PATH not found` in gen_vk        | Run `nargo compile` first so the `.vk` file exists at `noir_prover/target/`                    |
| `arcium localnet` times out on macOS | macOS file descriptor limit — see fix below                                                    |
| `Account not found` on registry init | Run `initialize_registry.ts` first                                                             |
| `InvalidProof` from executor         | Verifying key mismatch — re-run `solana_gen_vk` after any circuit change and redeploy          |
| `getMXEPublicKeyWithRetry` times out | Arcium devnet MXE isn't ready — wait 30s and retry, or run `arcium status`                     |
| Monitor not detecting condition      | `ETH_RPC_URL` doesn't support `debug_getRawHeader` — use an Alchemy archive endpoint           |
| `RuleNotActive` on `markTriggered`   | Rule was already triggered — check status with `getRuleStatus()`                               |
| Proof generation hangs               | Normal for local CPU on larger circuits — try running in-browser with the WASM backend instead |

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
echo "kern.maxfiles=1048576"        | sudo tee -a /etc/sysctl.conf
echo "kern.maxfilesperproc=1048576" | sudo tee -a /etc/sysctl.conf

# Add to ~/.zshrc (or ~/.bashrc)
echo "ulimit -n 1048576" >> ~/.zshrc
```

---

## Limitations

- **EVM source chains only** — the Noir circuit understands Ethereum's MPT structure. Cosmos/Substrate require different proof circuits.
- **SPL token actions only** — native SOL transfers and arbitrary CPI calls are not yet supported.
- **Single condition per rule** — composite conditions (AND/OR) are not implemented.
- **Single trusted monitor** — the executor node network is currently one keypair. A decentralized staked executor network is the next step.

---

## License

MIT — built for the Solana Frontier Hackathon 2026.
