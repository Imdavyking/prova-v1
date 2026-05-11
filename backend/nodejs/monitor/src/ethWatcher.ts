// monitor/src/ethWatcher.ts
//
// Watches Ethereum for registered Prova rule conditions.
// Uses Multicall3 to batch all balance checks into a single RPC call per poll.
// Emits a "triggered" event when a condition is met.

import { ethers } from "ethers";
import { EventEmitter } from "events";
import { logger } from "./logger";
import { config } from "./config";

export interface ActiveRule {
  ruleId: string;
  owner: string;
  watchAddress: string;
  tokenAddress: string;
  thresholdWei: bigint;
  recipient: string;
  tokenMint: string;
  actionAmount: bigint;
}

export interface TriggerEvent {
  rule: ActiveRule;
  blockNumber: number;
  stateRoot: string;
  balance: bigint;
}

// Multicall3 — deployed at same address on all EVM chains
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

const MULTICALL3_ABI = [
  "function getEthBalance(address addr) view returns (uint256)",
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)",
];

const ERC20_ABI = ["function balanceOf(address owner) view returns (uint256)"];

export class EthWatcher extends EventEmitter {
  private provider: ethers.JsonRpcProvider;
  private multicall: ethers.Contract;
  private rules: Map<string, ActiveRule> = new Map();
  private polling: boolean = false;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.provider = new ethers.JsonRpcProvider(config.ethRpcUrl);
    this.multicall = new ethers.Contract(
      MULTICALL3_ADDRESS,
      MULTICALL3_ABI,
      this.provider,
    );
  }

  addRule(rule: ActiveRule): void {
    this.rules.set(rule.ruleId, rule);
    logger.info("Watching rule", {
      ruleId: rule.ruleId,
      address: rule.watchAddress,
    });
  }

  removeRule(ruleId: string): void {
    this.rules.delete(ruleId);
    logger.info("Stopped watching rule", { ruleId });
  }

  start(): void {
    if (this.polling) return;
    this.polling = true;
    logger.info("ETH watcher started", { interval: config.ethPollIntervalMs });
    this.poll();
  }

  stop(): void {
    this.polling = false;
    if (this.timer) clearTimeout(this.timer);
    logger.info("ETH watcher stopped");
  }

  private async poll(): Promise<void> {
    if (!this.polling) return;
    try {
      const block = await this.provider.getBlock("latest");
      if (!block) throw new Error("Null block response");
      await this.checkAllRules(block.number, block.stateRoot ?? "");
    } catch (err) {
      logger.error("Poll error", { error: String(err) });
    }
    this.timer = setTimeout(() => this.poll(), config.ethPollIntervalMs);
  }

  private async checkAllRules(
    blockNumber: number,
    stateRoot: string,
  ): Promise<void> {
    const rules = Array.from(this.rules.values());
    if (rules.length === 0) return;

    // Deduplicate: one call per unique (address, token) pair
    type BalanceKey = string;
    const uniqueKeys = new Map<BalanceKey, ActiveRule>();
    for (const rule of rules) {
      const key = `${rule.watchAddress}:${rule.tokenAddress}`;
      if (!uniqueKeys.has(key)) uniqueKeys.set(key, rule);
    }

    const keyList = Array.from(uniqueKeys.entries());

    // Separate native ETH vs ERC-20 — Multicall3 handles both
    const multicallIface = this.multicall.interface;
    const erc20Iface = new ethers.Interface(ERC20_ABI);

    const calls = keyList.map(([, rule]) => {
      const isNative =
        rule.tokenAddress === "0x0000000000000000000000000000000000000000" ||
        rule.tokenAddress === "";

      if (isNative) {
        return {
          target: MULTICALL3_ADDRESS,
          allowFailure: true,
          callData: multicallIface.encodeFunctionData("getEthBalance", [
            rule.watchAddress,
          ]),
        };
      } else {
        return {
          target: rule.tokenAddress,
          allowFailure: true,
          callData: erc20Iface.encodeFunctionData("balanceOf", [
            rule.watchAddress,
          ]),
        };
      }
    });

    // Single RPC call for all balances
    let results: { success: boolean; returnData: string }[];
    try {
      results = await this.multicall.aggregate3.staticCall(calls, {
        blockTag: blockNumber,
      });
    } catch (err) {
      logger.error("Multicall3 failed, skipping poll", { error: String(err) });
      return;
    }

    // Build balance map from results
    const balanceMap = new Map<BalanceKey, bigint>();
    keyList.forEach(([key, rule], i) => {
      const { success, returnData } = results[i];
      if (!success || returnData === "0x") {
        logger.warn("Multicall3 call failed for address", {
          address: rule.watchAddress,
        });
        return;
      }
      try {
        const [value] = ethers.AbiCoder.defaultAbiCoder().decode(
          ["uint256"],
          returnData,
        );
        balanceMap.set(key, BigInt(value));
      } catch {
        logger.warn("Failed to decode balance", { address: rule.watchAddress });
      }
    });

    logger.debug("Multicall3 batch complete", {
      uniqueAddresses: keyList.length,
      totalRules: rules.length,
      block: blockNumber,
    });

    // Evaluate all rules against fetched balances
    for (const rule of rules) {
      const key = `${rule.watchAddress}:${rule.tokenAddress}`;
      const balance = balanceMap.get(key);
      if (balance === undefined) continue;

      if (balance < rule.thresholdWei) {
        logger.info("🔔 Condition triggered!", {
          ruleId: rule.ruleId,
          balance: balance.toString(),
          threshold: rule.thresholdWei.toString(),
          block: blockNumber,
        });
        this.removeRule(rule.ruleId);
        this.emit("triggered", {
          rule,
          blockNumber,
          stateRoot,
          balance,
        } as TriggerEvent);
      }
    }
  }
}
