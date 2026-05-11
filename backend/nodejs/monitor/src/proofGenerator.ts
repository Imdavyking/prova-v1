// monitor/src/proofGenerator.ts

import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execFile } from "child_process";

const require = createRequire(import.meta.url);
import { Noir, type CompiledCircuit } from "@noir-lang/noir_js";

import circuitJson from "../../noir_prover.json";

import { logger } from "./logger";
import { config } from "./config";
import { TriggerEvent } from "./ethWatcher";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_PROOF_NODES = 10;
const MAX_NODE_LEN = 532;
const MAX_ACCOUNT_LEN = 110;
const MAX_HEADER_LEN = 700;

export interface GeneratedProof {
  proof: string;
  witness: string;
  publicInputs: string;
}

export class ProofGenerator {
  private wasmBuffer: Buffer;

  private noirInitialized = false;
  private gnarkInitialized = false;

  private noir!: Noir;

  constructor() {
    const wasmPath = path.resolve(__dirname, "../../proof.wasm");

    this.wasmBuffer = fs.readFileSync(wasmPath);

    logger.info("✅ Gnark WASM loaded", {
      size: this.wasmBuffer.length,
    });
  }

  // ─────────────────────────────────────────────
  // Public
  // ─────────────────────────────────────────────

  async generate(event: TriggerEvent): Promise<GeneratedProof> {
    const started = Date.now();

    logger.info("Generating proof...", {
      ruleId: event.rule.ruleId,
      wallet: event.rule.watchAddress,
      block: event.blockNumber,
    });

    await this.initNoir();

    await this.initGnarkRuntime();

    const input = await this.buildWitnessInput(event);

    logger.info("Executing Noir circuit...");

    const { witness } = await this.noir.execute(input);

    logger.info("✅ Witness generated");

    // ─────────────────────────────────────────────
    // ONLY CHANGE: CLI PROVER FLOW
    // ─────────────────────────────────────────────

    const ccsPath = path.resolve(__dirname, "../../noir_prover.ccs");
    const pkPath = path.resolve(__dirname, "../../noir_prover.pk");
    const acirPath = path.resolve(__dirname, "../../noir_prover.json");

    const tmpWitnessPath = path.resolve(__dirname, "../../tmp_witness.bin");
    const outPath = path.resolve(__dirname, "../../tmp_proof.bin");

    // write witness temporarily
    fs.writeFileSync(tmpWitnessPath, Buffer.from(witness));

    logger.info("Running CLI prover...");

    await new Promise<void>((resolve, reject) => {
      const proc = execFile(
        "./prover-cli",
        [
          "--ccs",
          ccsPath,
          "--pk",
          pkPath,
          "--witness",
          tmpWitnessPath,
          "--acir",
          acirPath,
          "--out",
          outPath,
        ],
        (err) => {
          if (err) return reject(err);
          resolve();
        },
      );

      proc.stdout?.on("data", (d) => logger.info(d.toString()));
      proc.stderr?.on("data", (d) => logger.error(d.toString()));
    });

    const { publicInputs, proof } = JSON.parse(
      fs.readFileSync(outPath, "utf8"),
    );

    // cleanup temp files
    fs.unlinkSync(tmpWitnessPath);

    const elapsed = ((Date.now() - started) / 1000).toFixed(2);

    logger.info(`✅ Proof generated in ${elapsed}s`);

    return {
      publicInputs,
      proof,
      witness: Buffer.from(witness).toString("hex"),
    };
  }

  // ─────────────────────────────────────────────
  // Noir Init (UNCHANGED)
  // ─────────────────────────────────────────────

  private async initNoir() {
    if (this.noirInitialized) return;

    logger.info("Initializing Noir...");

    const acvmPath = require.resolve("@noir-lang/acvm_js/web/acvm_js_bg.wasm");
    const noircPath =
      require.resolve("@noir-lang/noirc_abi/web/noirc_abi_wasm_bg.wasm");

    fs.readFileSync(acvmPath);
    fs.readFileSync(noircPath);

    this.noir = new Noir(circuitJson as CompiledCircuit);

    this.noirInitialized = true;

    logger.info("✅ Noir initialized");
  }

  // ─────────────────────────────────────────────
  // Gnark Runtime (UNCHANGED)
  // ─────────────────────────────────────────────

  private async initGnarkRuntime() {
    if (this.gnarkInitialized) return;

    const wasmExecPath = path.resolve(__dirname, "../../wasm_exec.js");
    const url = new URL(`file://${wasmExecPath}`);

    await import(url.href);

    const go = new (globalThis as any).Go();

    const wasm = await WebAssembly.instantiate(
      this.wasmBuffer,
      go.importObject,
    );

    go.run(wasm.instance);

    this.gnarkInitialized = true;

    logger.info("✅ Gnark runtime initialized");
  }

  // ─────────────────────────────────────────────
  // Build Witness Inputs (UNCHANGED)
  // ─────────────────────────────────────────────

  private async buildWitnessInput(event: TriggerEvent) {
    const { rule, blockNumber } = event;

    const provider = new ethers.JsonRpcProvider(config.ethRpcUrl);

    const blockHex = "0x" + blockNumber.toString(16);

    const block = await provider.send("eth_getBlockByNumber", [
      blockHex,
      false,
    ]);

    const stateRoot = this.hexToBytes(block.stateRoot);

    const proofResp = await provider.send("eth_getProof", [
      rule.watchAddress,
      [],
      blockHex,
    ]);

    const accountProofNodes = proofResp.accountProof.map((n: string) =>
      this.hexToBytes(n),
    );

    const nodesBytes = accountProofNodes.map((n: number[]) =>
      this.padArray(n, MAX_NODE_LEN),
    );

    const nodeLens = accountProofNodes.map((n: number[]) => n.length);

    while (nodesBytes.length < MAX_PROOF_NODES) {
      nodesBytes.push(new Array(MAX_NODE_LEN).fill(0));
    }

    while (nodeLens.length < MAX_PROOF_NODES) {
      nodeLens.push(0);
    }

    const accountRlp = this.encodeAccountRlp(
      proofResp.nonce.replace("0x", ""),
      proofResp.balance.replace("0x", ""),
      proofResp.storageHash.replace("0x", ""),
      proofResp.codeHash.replace("0x", ""),
    );

    const accountRlpPadded = this.padArray(accountRlp, MAX_ACCOUNT_LEN);

    let rawHeader: string;

    try {
      rawHeader = await provider.send("debug_getRawHeader", [blockHex]);
    } catch {
      throw new Error("debug_getRawHeader failed");
    }

    const headerRlp = this.hexToBytes(rawHeader);

    const headerRlpPadded = this.padArray(headerRlp, MAX_HEADER_LEN);

    return {
      block_number: blockNumber,
      state_root: stateRoot,
      wallet_address: this.hexToBytes(rule.watchAddress),
      threshold_wei: this.bigintTo32Bytes(BigInt(rule.thresholdWei)),
      rule_id: this.hexToBytes(rule.ruleId),

      account_rlp_len: accountRlp.length,
      account_rlp: accountRlpPadded,

      num_proof_nodes: accountProofNodes.length,
      proof_lens: nodeLens,
      proof_nodes: nodesBytes,

      header_rlp_len: headerRlp.length,
      header_rlp: headerRlpPadded,
    };
  }

  // helpers unchanged...

  private padArray(arr: number[], len: number, fill = 0): number[] {
    const result = [...arr];
    while (result.length < len) result.push(fill);
    return result.slice(0, len);
  }

  private hexToBytes(hex: string): number[] {
    const clean = hex.replace("0x", "");
    const padded = clean.length % 2 ? "0" + clean : clean;
    return Array.from(Buffer.from(padded, "hex"));
  }

  private bigintTo32Bytes(n: bigint): number[] {
    const hex = n.toString(16).padStart(64, "0");
    return this.hexToBytes("0x" + hex);
  }

  private rlpEncodeBytes(hex: string): number[] {
    const padded = hex.length % 2 ? "0" + hex : hex;

    if (!padded || padded === "00") return [0x80];

    const bytes = Array.from(Buffer.from(padded, "hex"));

    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;

    const stripped = bytes.slice(start);

    if (stripped.length === 1 && stripped[0] < 0x80) return stripped;

    return [0x80 + stripped.length, ...stripped];
  }

  private rlpEncodeHash(hex: string): number[] {
    const bytes = Array.from(Buffer.from(hex.replace("0x", ""), "hex"));
    return [0xa0, ...bytes];
  }

  private encodeAccountRlp(
    nonceHex: string,
    balanceHex: string,
    storageHex: string,
    codeHex: string,
  ): number[] {
    const nonce = this.rlpEncodeBytes(nonceHex || "00");
    const balance = this.rlpEncodeBytes(balanceHex || "00");
    const storage = this.rlpEncodeHash(storageHex);
    const code = this.rlpEncodeHash(codeHex);

    const payload = [...nonce, ...balance, ...storage, ...code];

    const prefix =
      payload.length <= 55
        ? [0xc0 + payload.length]
        : (() => {
            const lb = this.encodeLengthBytes(payload.length);
            return [0xf7 + lb.length, ...lb];
          })();

    return [...prefix, ...payload];
  }

  private encodeLengthBytes(len: number): number[] {
    const out: number[] = [];
    let n = len;

    while (n > 0) {
      out.unshift(n & 0xff);
      n >>= 8;
    }

    return out;
  }
}
