// monitor/src/proofGenerator.ts
import * as fs from "fs";
import * as path from "path";
import { logger } from "./logger";
import { config } from "./config";
import { TriggerEvent } from "./ethWatcher";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface GeneratedProof {
  proofBytes: Buffer;
  publicInputs: {
    blockNumber: number;
    stateRoot: string;
    walletAddress: string;
    thresholdWei: string;
    ruleId: string;
  };
  vkHash: string;
}

export class ProofGenerator {
  private wasmBuffer: Buffer | null = null;
  private isInitialized = false;

  constructor() {
    this.loadWasm();
  }

  private loadWasm() {
    const wasmPath = path.resolve(__dirname, "../../proof.wasm"); // Adjust path as needed
    this.wasmBuffer = fs.readFileSync(wasmPath);
    logger.info("Gnark WASM loaded", { size: this.wasmBuffer.length });
  }

  async init() {
    if (this.isInitialized) return;

    // Load wasm_exec.js (Go glue code)
    const wasmExecPath = path.resolve(__dirname, "../../wasm_exec.js");
    require(wasmExecPath); // This defines global Go()

    this.isInitialized = true;
    logger.info("✅ Gnark WASM + Go runtime initialized");
  }

  async generate(event: TriggerEvent): Promise<GeneratedProof> {
    await this.init();

    const { rule, blockNumber } = event;

    logger.info("Generating Gnark proof...", {
      ruleId: rule.ruleId,
      block: blockNumber,
      wallet: rule.watchAddress,
    });

    const start = Date.now();

    // Prepare input for your Go prover (adjust according to what your Go main expects)
    const inputData = {
      rpcUrl: config.ethRpcUrl,
      blockNumber: blockNumber,
      wallet: rule.watchAddress,
      threshold: rule.thresholdWei.toString(),
      ruleId: rule.ruleId,
      // Add any other fields your Gnark circuit / Go prover needs
    };

    // Call the global function exposed by your Go WASM
    const result = await this.callGoProver(inputData);

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logger.info(`✓ Gnark proof generated in ${elapsed}s`);

    const proofBytes = Buffer.from(result.proof, "hex"); // or whatever format your Go returns

    return {
      proofBytes,
      publicInputs: {
        blockNumber: result.publicInputs.blockNumber,
        stateRoot: result.publicInputs.stateRoot,
        walletAddress: result.publicInputs.walletAddress,
        thresholdWei: result.publicInputs.thresholdWei.toString(),
        ruleId: result.publicInputs.ruleId,
      },
      vkHash: result.vkHash || "your_vk_hash_here",
    };
  }

  private async callGoProver(input: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const go = new (globalThis as any).Go();

      WebAssembly.instantiate(this.wasmBuffer!, go.importObject)
        .then((result) => {
          go.run((result as any).instance);

          // Call the function your Go code exposes on the global scope
          // Example: assuming your Go code does something like:
          //   js.Global().Set("generateProof", js.FuncOf(...))
          const proofResult = (globalThis as any).generateProof?.(
            JSON.stringify(input),
          );

          if (proofResult) {
            resolve(
              typeof proofResult === "string"
                ? JSON.parse(proofResult)
                : proofResult,
            );
          } else {
            reject(new Error("generateProof function not found on global"));
          }
        })
        .catch(reject);
    });
  }
}
