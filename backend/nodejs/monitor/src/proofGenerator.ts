// monitor/src/proofGenerator.ts
//
// Invokes the SP1 Rust proof generation script as a subprocess.
// Returns the raw Groth16 proof bytes and decoded public inputs.

import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { promisify } from "util";
import { logger } from "./logger";
import { config } from "./config";
import { TriggerEvent } from "./ethWatcher";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execFileAsync = promisify(execFile);

export interface GeneratedProof {
  proofBytes: Buffer; // Raw Groth16 proof bytes for Solana
  publicInputs: {
    blockNumber: number;
    stateRoot: string; // 0x-prefixed hex
    walletAddress: string; // 0x-prefixed hex
    thresholdWei: string; // decimal string
    ruleId: string; // 0x-prefixed hex
  };
  vkHash: string; // hex — must match BALANCE_PROVER_VK_HASH in Rust
}

export class ProofGenerator {
  private scriptBin: string;

  constructor() {
    this.scriptBin = config.sp1ScriptPath.startsWith("/")
      ? path.join(config.sp1ScriptPath, "target/release/prova-prove")
      : path.resolve(
          __dirname, // monitor/src/
          "../../../", // backend/
          config.sp1ScriptPath,
          "target/release/prova-prove",
        );

    logger.info("SP1 prover binary", { path: this.scriptBin });
  }

  async generate(event: TriggerEvent): Promise<GeneratedProof> {
    const { rule, blockNumber, stateRoot } = event;

    logger.info("Generating ZK proof...", {
      ruleId: rule.ruleId,
      block: blockNumber,
      wallet: rule.watchAddress,
      threshold: rule.thresholdWei.toString(),
    });

    // Write proof to a temp file
    const tmpDir = os.tmpdir();
    const outFile = path.join(
      tmpDir,
      `proof_${rule.ruleId.slice(2, 10)}_${blockNumber}.json`,
    );

    const args = [
      "--rpc-url",
      config.ethRpcUrl,
      "--block",
      blockNumber.toString(),
      "--wallet",
      rule.watchAddress,
      "--threshold",
      rule.thresholdWei.toString(),
      "--rule-id",
      rule.ruleId,
      "--output",
      outFile,
    ];

    if (config.proverMode === "network") {
      args.push("--use-network");
    }

    const env = {
      ...process.env,
      RUST_LOG: "info",
      // Succinct prover network key (if using network mode)
      SP1_PRIVATE_KEY: process.env["SP1_PRIVATE_KEY"] ?? "",
    };

    logger.info("Running SP1 prover...", { args: args.join(" ") });
    const start = Date.now();

    try {
      const { stdout, stderr } = await execFileAsync(this.scriptBin, args, {
        env,
        timeout: 300_000, // 5-minute timeout
        maxBuffer: 50 * 1024 * 1024,
      });

      if (stdout)
        logger.debug("Prover stdout", { stdout: stdout.slice(0, 500) });
      if (stderr)
        logger.debug("Prover stderr", { stderr: stderr.slice(0, 500) });
    } catch (err: any) {
      logger.error("Proof generation failed", {
        error: String(err.message),
        stderr: err.stderr?.slice(0, 1000),
      });
      throw new Error(`SP1 proof generation failed: ${err.message}`);
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logger.info(`✓ Proof generated in ${elapsed}s`);

    // ── Parse output file ──────────────────────────────────────────────
    if (!fs.existsSync(outFile)) {
      throw new Error(`Proof output file not found: ${outFile}`);
    }

    const raw = JSON.parse(fs.readFileSync(outFile, "utf8"));

    // Clean up temp file
    fs.unlinkSync(outFile);

    const proofBytes = Buffer.from(raw.proof_bytes as string, "hex");

    logger.info("Proof details", {
      size: proofBytes.length,
      vkHash: raw.vk_hash,
      block: raw.public_inputs.block_number,
    });

    return {
      proofBytes,
      publicInputs: {
        blockNumber: raw.public_inputs.block_number,
        stateRoot: raw.public_inputs.state_root,
        walletAddress: raw.public_inputs.wallet_address,
        thresholdWei: raw.public_inputs.threshold_wei.toString(),
        ruleId: raw.public_inputs.rule_id,
      },
      vkHash: raw.vk_hash,
    };
  }
}
