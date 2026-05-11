// monitor/src/proofGenerator.ts
import * as fs from "fs";
import * as path from "path";
import { logger } from "./logger";
import { config } from "./config";
import { fileURLToPath } from "url";
import { TriggerEvent } from "./ethWatcher";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface GeneratedProof {
  proofBytes: Buffer;
  publicInputs: any;
}

export class ProofGenerator {
  private wasmBuffer: Buffer | null = null;
  private isWasmReady = false;
  private isCircuitReady = false;

  constructor() {
    this.loadWasm();
  }

  private loadWasm() {
    const wasmPath = path.resolve(__dirname, "../../proof.wasm");
    this.wasmBuffer = fs.readFileSync(wasmPath);
    logger.info("Gnark WASM loaded", { size: this.wasmBuffer.length });
  }

  private async initWasmRuntime() {
    if (this.isWasmReady) return;

    const wasmExecPath = path.resolve(__dirname, "../../wasm_exec.js");
    const url = new URL(`file://${wasmExecPath}`);
    await import(url.href);

    this.isWasmReady = true;
    logger.info("✅ Go WASM runtime initialized");
  }

  async generate(event: TriggerEvent): Promise<GeneratedProof> {
    const { rule, blockNumber } = event;

    await this.initWasmRuntime();

    logger.info("Generating Gnark proof...", {
      ruleId: rule.ruleId,
      block: blockNumber,
    });

    const start = Date.now();

    // 1. Prepare input data (same as before)
    const inputData = {
      rpcUrl: config.ethRpcUrl,
      blockNumber: blockNumber,
      wallet: rule.watchAddress,
      threshold: rule.thresholdWei.toString(),
      ruleId: rule.ruleId,
    };

    // 2. Generate witness (this is the key part you pointed out)
    const witnessResult = await this.generateWitness(inputData);
    const witnessBytes = witnessResult.witness || new Uint8Array(0);

    // 3. Initialize Circuit with witness
    if (!this.isCircuitReady) {
      await this.initCircuit(witnessBytes);
      this.isCircuitReady = true;
    }

    // 4. Generate Proof
    const result = await this.callGenerateProof();

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logger.info(`✅ Proof generated in ${elapsed}s`);

    return {
      proofBytes: Buffer.from(result.proof || result.proofBytes || "", "hex"),
      publicInputs: result.publicInputs || result,
    };
  }

  private async initCircuit(witnessBytes: Uint8Array): Promise<void> {
    const ccsBytes = fs.readFileSync(
      path.resolve(__dirname, "../../noir_prover.ccs"),
    );
    const pkBytes = fs.readFileSync(
      path.resolve(__dirname, "../../noir_prover.pk"),
    );

    return new Promise((resolve, reject) => {
      const go = new (globalThis as any).Go();

      WebAssembly.instantiate(this.wasmBuffer!, go.importObject)
        .then((result) => {
          go.run(result.instance);

          const success = (globalThis as any).initCircuit?.(
            ccsBytes,
            pkBytes,
            witnessBytes,
          );

          if (success === true || success === undefined) {
            // some WASM don't return value
            logger.info("✅ Circuit initialized with witness");
            resolve();
          } else {
            reject(new Error("initCircuit failed"));
          }
        })
        .catch(reject);
    });
  }

  private async generateWitness(input: any): Promise<any> {
    // If your Go WASM has a separate witness generation function, call it here.
    // Otherwise, if generateProof does everything internally, you can simplify this.
    return new Promise((resolve, reject) => {
      const go = new (globalThis as any).Go();

      WebAssembly.instantiate(this.wasmBuffer!, go.importObject)
        .then((result) => {
          go.run(result.instance);
          const witness = (globalThis as any).generateWitness?.(
            JSON.stringify(input),
          );
          resolve(witness || { witness: new Uint8Array(0) });
        })
        .catch(reject);
    });
  }

  private async callGenerateProof(): Promise<any> {
    return new Promise((resolve, reject) => {
      const go = new (globalThis as any).Go();

      WebAssembly.instantiate(this.wasmBuffer!, go.importObject)
        .then((result) => {
          go.run(result.instance);
          const proofResult = (globalThis as any).generateProof?.();
          resolve(proofResult || {});
        })
        .catch(reject);
    });
  }
}
