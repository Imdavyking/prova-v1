// src/pages/AppPage.tsx
import { useState, useEffect, useCallback } from "react";
import {
  useWallet,
  useConnection,
  useAnchorWallet,
} from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  registerRule,
  getUserRules,
  cancelRule,
  pollRuleStatus,
  SourceChain,
  ConditionType,
  ActionType,
  RuleStatus,
  type Rule,
  type RegisterRuleParams,
} from "../lib/actions";
import Navbar from "../components/Navbar";
import { NATIVE_ETH_ADDRESS, MIN_FEE_LAMPORTS } from "../utils/constants";

// Devnet Mint Addresses
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

// ── Status helpers ────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  RuleStatus,
  { label: string; color: string; bg: string; dot: string }
> = {
  [RuleStatus.Active]: {
    label: "Active",
    color: "#14F195",
    bg: "rgba(20,241,149,0.08)",
    dot: "animate-pulse bg-emerald-400",
  },
  [RuleStatus.Triggered]: {
    label: "Triggered",
    color: "#FFB800",
    bg: "rgba(255,184,0,0.08)",
    dot: "animate-pulse bg-amber-400",
  },
  [RuleStatus.Proving]: {
    label: "Proving ZK",
    color: "#A855F7",
    bg: "rgba(168,85,247,0.08)",
    dot: "animate-spin bg-purple-400",
  },
  [RuleStatus.Executed]: {
    label: "Executed",
    color: "#FF5500",
    bg: "rgba(255,85,0,0.08)",
    dot: "bg-orange-500",
  },
  [RuleStatus.Cancelled]: {
    label: "Cancelled",
    color: "#555",
    bg: "rgba(255,255,255,0.03)",
    dot: "bg-[#444]",
  },
};

function ellipsify(str: string, len = 8) {
  if (str.length <= len * 2 + 3) return str;
  return `${str.slice(0, len)}...${str.slice(-len)}`;
}

function weiToEth(wei: string): string {
  try {
    const val = BigInt(wei);
    const eth = Number(val) / 1e18;
    return eth.toLocaleString(undefined, { maximumFractionDigits: 4 });
  } catch {
    return wei;
  }
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: RuleStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm font-mono text-xs font-medium"
      style={{
        color: cfg.color,
        background: cfg.bg,
        border: `1px solid ${cfg.color}25`,
      }}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

// ── Status pipeline ───────────────────────────────────────────────────────────

const PIPELINE = [
  RuleStatus.Active,
  RuleStatus.Triggered,
  RuleStatus.Proving,
  RuleStatus.Executed,
];

function StatusPipeline({ status }: { status: RuleStatus }) {
  const currentIdx = PIPELINE.indexOf(status);
  if (status === RuleStatus.Cancelled) {
    return (
      <div className="flex items-center gap-1 mt-3">
        <span className="font-mono text-xs text-[#444]">Rule cancelled</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 mt-3">
      {PIPELINE.map((s, i) => {
        const cfg = STATUS_CONFIG[s];
        const active = i === currentIdx;
        const done = i < currentIdx;
        return (
          <div key={s} className="flex items-center gap-1">
            <div
              className="flex items-center gap-1 px-2 py-0.5 rounded-sm font-mono text-[10px] transition-all"
              style={{
                color: done || active ? cfg.color : "#333",
                background: active ? cfg.bg : "transparent",
                border: `1px solid ${done || active ? cfg.color + "30" : "#1a1a1a"}`,
              }}
            >
              {done && <span>✓</span>}
              {cfg.label}
            </div>
            {i < PIPELINE.length - 1 && (
              <span className="text-[#222] text-[10px]">›</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Rule card ─────────────────────────────────────────────────────────────────

function RuleCard({
  rule,
  onCancel,
  cancelling,
}: {
  rule: Rule;
  onCancel: (pda: string) => void;
  cancelling: boolean;
}) {
  const cfg = STATUS_CONFIG[rule.status];
  const isNative =
    rule.tokenAddress === NATIVE_ETH_ADDRESS ||
    rule.tokenAddress === "0x" + "00".repeat(20);

  const canCancel = rule.status === RuleStatus.Active;

  return (
    <div
      className="rounded-sm border transition-all duration-300 overflow-hidden"
      style={{ borderColor: `${cfg.color}20`, background: "#0A0A0A" }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b"
        style={{ borderColor: `${cfg.color}15`, background: cfg.bg }}
      >
        <div className="flex items-center gap-2">
          <StatusBadge status={rule.status} />
          <span className="font-mono text-xs text-[#333]">
            #{rule.ruleId.slice(2, 10).toUpperCase()}
          </span>
        </div>
        <span className="font-mono text-xs text-[#444]">
          {new Date(rule.registeredAt * 1000).toLocaleDateString()}
        </span>
      </div>

      {/* Body */}
      <div className="px-4 py-4 space-y-3">
        {/* Condition */}
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10px] text-[#444] uppercase tracking-widest">
            Condition
          </span>
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="font-mono text-xs px-2 py-0.5 rounded-sm"
              style={{
                color: "#627EEA",
                background: "rgba(98,126,234,0.08)",
                border: "1px solid rgba(98,126,234,0.15)",
              }}
            >
              {rule.sourceChain}
            </span>
            <span className="font-mono text-xs text-[#777]">
              {ellipsify(rule.watchAddress)}
            </span>
            <span className="font-mono text-xs text-[#555]">balance &lt;</span>
            <span className="font-mono text-xs text-amber-400">
              {weiToEth(rule.thresholdWei)} {isNative ? "ETH" : "tokens"}
            </span>
          </div>
        </div>

        {/* Action */}
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10px] text-[#444] uppercase tracking-widest">
            Action
          </span>
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="font-mono text-xs px-2 py-0.5 rounded-sm"
              style={{
                color: "#9945FF",
                background: "rgba(153,69,255,0.08)",
                border: "1px solid rgba(153,69,255,0.15)",
              }}
            >
              Solana
            </span>
            <span className="font-mono text-xs text-orange-500 font-semibold">
              {Number(rule.actionAmount).toLocaleString()}
            </span>
            <span className="font-mono text-xs text-[#555]">→</span>
            <span className="font-mono text-xs text-[#777]">
              {ellipsify(rule.recipient)}
            </span>
          </div>
        </div>

        {/* Pipeline */}
        <StatusPipeline status={rule.status} />
      </div>

      {/* Footer */}
      {canCancel && (
        <div className="px-4 pb-4">
          <button
            onClick={() => onCancel(rule.address)}
            disabled={cancelling}
            className="w-full font-mono text-xs text-[#555] hover:text-red-400 border border-[#1a1a1a] hover:border-red-900/50 px-3 py-2 rounded-sm transition-all disabled:opacity-40"
          >
            {cancelling ? "Cancelling..." : "Cancel Rule & Refund"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Form field ────────────────────────────────────────────────────────────────

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <label className="font-mono text-xs text-[#888] uppercase tracking-widest">
          {label}
        </label>
        {hint && (
          <span className="font-mono text-[10px] text-[#444]">{hint}</span>
        )}
      </div>
      {children}
    </div>
  );
}

const inputCls =
  "w-full bg-[#0A0A0A] border border-[rgba(255,85,0,0.15)] hover:border-[rgba(255,85,0,0.3)] focus:border-orange-500 outline-none rounded-sm px-3 py-2.5 font-mono text-xs text-[#CCC] placeholder-[#333] transition-all";

const selectCls =
  "w-full bg-[#0A0A0A] border border-[rgba(255,85,0,0.15)] hover:border-[rgba(255,85,0,0.3)] focus:border-orange-500 outline-none rounded-sm px-3 py-2.5 font-mono text-xs text-[#CCC] transition-all appearance-none cursor-pointer";

// ── Main page ─────────────────────────────────────────────────────────────────

const DEFAULT_FORM: RegisterRuleParams = {
  sourceChain: SourceChain.Ethereum,
  conditionType: ConditionType.BalanceBelow,
  watchAddress: "",
  tokenAddress: NATIVE_ETH_ADDRESS,
  thresholdWei: "",
  actionType: ActionType.TransferSpl,
  recipient: "",
  tokenMint: USDC_DEVNET_MINT, // Default to USDC on devnet
  actionAmount: "",
  escrowedFeeLamports: MIN_FEE_LAMPORTS,
};

type TxState = "idle" | "loading" | "success" | "error";

export default function AppPage() {
  const { connected, publicKey } = useWallet();
  const { connection } = useConnection();
  const anchorWallet = useAnchorWallet();

  const [form, setForm] = useState<RegisterRuleParams>(DEFAULT_FORM);
  const [thresholdEth, setThresholdEth] = useState("");
  const [feeSOL, setFeeSOL] = useState("0.001");

  const [txState, setTxState] = useState<TxState>("idle");
  const [txMsg, setTxMsg] = useState("");
  const [lastTxSig, setLastTxSig] = useState("");

  const [rules, setRules] = useState<Rule[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [cancellingPda, setCancellingPda] = useState<string | null>(null);

  // Convert ETH input → wei string
  useEffect(() => {
    try {
      const wei = BigInt(Math.round(parseFloat(thresholdEth || "0") * 1e18));
      setForm((f) => ({ ...f, thresholdWei: wei.toString() }));
    } catch {
      setForm((f) => ({ ...f, thresholdWei: "0" }));
    }
  }, [thresholdEth]);

  // Convert SOL input → lamports
  useEffect(() => {
    try {
      const lam = Math.round(parseFloat(feeSOL || "0") * 1e9);
      setForm((f) => ({ ...f, escrowedFeeLamports: lam }));
    } catch {
      setForm((f) => ({ ...f, escrowedFeeLamports: MIN_FEE_LAMPORTS }));
    }
  }, [feeSOL]);

  const loadRules = useCallback(async () => {
    if (!anchorWallet || !publicKey) return;
    setRulesLoading(true);
    try {
      const fetched = await getUserRules(anchorWallet, connection);
      setRules(fetched);
    } catch (e) {
      console.error("getUserRules failed:", e);
    } finally {
      setRulesLoading(false);
    }
  }, [anchorWallet, connection, publicKey]);

  useEffect(() => {
    if (connected) loadRules();
  }, [connected, loadRules]);

  const handleRegister = async () => {
    if (!anchorWallet) return;
    setTxState("loading");
    setTxMsg("Sending transaction...");
    try {
      const { txSig, ruleId, rulePda } = await registerRule(
        anchorWallet,
        connection,
        form,
      );
      setLastTxSig(txSig);
      setTxState("success");
      setTxMsg(`Rule ${ruleId.slice(0, 10)}... registered!`);
      setForm(DEFAULT_FORM);
      setThresholdEth("");
      setFeeSOL("0.001");
      await loadRules();
      pollRuleStatus(anchorWallet, connection, rulePda, () =>
        loadRules(),
      ).catch(() => {});
    } catch (e: any) {
      setTxState("error");
      setTxMsg(e?.message ?? "Transaction failed");
    }
  };

  const handleCancel = async (pda: string) => {
    if (!anchorWallet) return;
    setCancellingPda(pda);
    try {
      await cancelRule(anchorWallet, connection, pda);
      await loadRules();
    } catch (e: any) {
      console.error("cancel failed:", e);
    } finally {
      setCancellingPda(null);
    }
  };

  const set =
    (k: keyof RegisterRuleParams) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  const formValid =
    form.watchAddress.startsWith("0x") &&
    form.watchAddress.length === 42 &&
    form.thresholdWei !== "" &&
    form.thresholdWei !== "0" &&
    form.recipient.length >= 32 &&
    form.tokenMint.length >= 32 &&
    form.actionAmount !== "";

  return (
    <div className="bg-black min-h-screen">
      <Navbar />

      {/* Grid BG */}
      <div className="fixed inset-0 grid-bg opacity-30 pointer-events-none" />

      <div className="max-w-7xl mx-auto px-6 pt-28 pb-16 relative">
        {/* Top bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-10">
          <div>
            <p className="font-mono text-xs text-orange-500 tracking-[0.2em] uppercase mb-1">
              Prova Protocol
            </p>
            <h1 className="font-display font-black text-3xl text-white">
              Automation Console
            </h1>
          </div>

          <div className="flex items-center gap-3">
            {connected && publicKey && (
              <span className="font-mono text-xs text-[#555] border border-[#1a1a1a] px-3 py-2 rounded-sm">
                {ellipsify(publicKey.toBase58(), 6)}
              </span>
            )}
            <WalletMultiButton
              style={{
                background: connected ? "rgba(255,85,0,0.1)" : "#FF5500",
                border: connected ? "1px solid rgba(255,85,0,0.3)" : "none",
                color: connected ? "#FF5500" : "#000",
                fontFamily: "'Syne', sans-serif",
                fontWeight: 700,
                fontSize: "11px",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                borderRadius: "2px",
                height: "38px",
                padding: "0 16px",
              }}
            />
          </div>
        </div>

        {!connected ? (
          /* Not connected splash */
          <div className="flex flex-col items-center justify-center py-32 gap-8">
            <div className="w-16 h-16 rounded-sm bg-orange-500/10 border border-orange-500/20 flex items-center justify-center">
              <svg viewBox="0 0 32 32" fill="none" className="w-8 h-8">
                <rect width="32" height="32" rx="4" fill="#FF5500" />
                <path
                  d="M9 24V8h8.5C21.09 8 24 10.5 24 14c0 3.5-2.91 6-6.5 6H13v4H9z"
                  fill="#000"
                />
                <path
                  d="M13 16h4.5C19.43 16 20 14.9 20 14c0-.9-.57-2-2.5-2H13v4z"
                  fill="#FF5500"
                />
              </svg>
            </div>
            <div className="text-center">
              <p className="font-display font-black text-2xl text-white mb-2">
                Connect your wallet
              </p>
              <p className="font-body text-sm text-[#555] max-w-xs">
                Connect Phantom or Solflare on Solana Devnet to register and
                manage your automation rules.
              </p>
            </div>
            <WalletMultiButton
              style={{
                background: "#FF5500",
                color: "#000",
                fontFamily: "'Syne', sans-serif",
                fontWeight: 700,
                fontSize: "12px",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                borderRadius: "2px",
                height: "44px",
                padding: "0 28px",
              }}
            />
          </div>
        ) : (
          /* Connected: two-column layout */
          <div className="grid lg:grid-cols-5 gap-8">
            {/* LEFT: Register form */}
            <div className="lg:col-span-2">
              <div className="border border-[rgba(255,85,0,0.15)] rounded-sm overflow-hidden">
                <div className="flex items-center gap-3 px-5 py-4 border-b border-[rgba(255,85,0,0.1)] bg-[rgba(255,85,0,0.04)]">
                  <span className="w-2 h-2 rounded-full bg-orange-500" />
                  <span className="font-mono text-xs text-orange-500 uppercase tracking-widest">
                    Register New Rule
                  </span>
                </div>

                <div className="p-5 space-y-5">
                  {/* Source chain + condition */}
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Chain">
                      <select
                        className={selectCls}
                        value={form.sourceChain}
                        onChange={set("sourceChain")}
                      >
                        {Object.values(SourceChain).map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Condition">
                      <select
                        className={selectCls}
                        value={form.conditionType}
                        onChange={set("conditionType")}
                      >
                        <option value={ConditionType.BalanceBelow}>
                          Balance Below
                        </option>
                        <option value={ConditionType.TokenBalanceBelow}>
                          Token Balance Below
                        </option>
                      </select>
                    </Field>
                  </div>

                  {/* Watch address */}
                  <Field label="Watch Address" hint="EVM 0x...">
                    <input
                      className={inputCls}
                      placeholder="0x4F8a...9B2c"
                      value={form.watchAddress}
                      onChange={set("watchAddress")}
                    />
                  </Field>

                  {/* Token + threshold */}
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Token" hint="0x0...0 = ETH">
                      <input
                        className={inputCls}
                        placeholder={NATIVE_ETH_ADDRESS}
                        value={form.tokenAddress}
                        onChange={set("tokenAddress")}
                      />
                    </Field>
                    <Field label="Threshold" hint="ETH units">
                      <input
                        className={inputCls}
                        type="number"
                        step="0.001"
                        min="0"
                        placeholder="0.5"
                        value={thresholdEth}
                        onChange={(e) => setThresholdEth(e.target.value)}
                      />
                    </Field>
                  </div>

                  <div className="h-px bg-[#111]" />

                  {/* Action type */}
                  <Field label="Action">
                    <select
                      className={selectCls}
                      value={form.actionType}
                      onChange={(e) => {
                        const newType = e.target.value as ActionType;
                        setForm((f) => {
                          const updated = { ...f, actionType: newType };
                          if (newType === ActionType.TransferSol) {
                            updated.tokenMint = WSOL_MINT;
                          } else if (f.tokenMint === WSOL_MINT) {
                            updated.tokenMint = USDC_DEVNET_MINT;
                          }
                          return updated;
                        });
                      }}
                    >
                      <option value={ActionType.TransferSpl}>
                        Transfer SPL Token
                      </option>
                      <option value={ActionType.TransferSol}>
                        Transfer SOL (Native)
                      </option>
                    </select>
                  </Field>

                  {/* Recipient */}
                  <Field label="Recipient" hint="Solana pubkey">
                    <input
                      className={inputCls}
                      placeholder="7Gsn...3Ppz"
                      value={form.recipient}
                      onChange={set("recipient")}
                    />
                  </Field>

                  {/* Mint + amount */}
                  <div className="grid grid-cols-2 gap-3">
                    <Field
                      label="Token Mint"
                      hint={
                        form.actionType === ActionType.TransferSol
                          ? "WSOL"
                          : "USDC Devnet"
                      }
                    >
                      <input
                        className={inputCls}
                        placeholder={
                          form.actionType === ActionType.TransferSol
                            ? WSOL_MINT
                            : USDC_DEVNET_MINT
                        }
                        value={form.tokenMint}
                        onChange={set("tokenMint")}
                        disabled={form.actionType === ActionType.TransferSol}
                      />
                      {form.actionType === ActionType.TransferSol && (
                        <p className="font-mono text-[10px] text-emerald-400 mt-1">
                          ✓ Native SOL Transfer
                        </p>
                      )}
                    </Field>

                    <Field label="Amount" hint="smallest unit">
                      <input
                        className={inputCls}
                        type="number"
                        min="0"
                        placeholder={
                          form.actionType === ActionType.TransferSol
                            ? "1000000000"
                            : "1000000"
                        }
                        value={form.actionAmount}
                        onChange={set("actionAmount")}
                      />
                    </Field>
                  </div>

                  {/* Fee */}
                  <Field label="Escrow Fee" hint="SOL for executor">
                    <input
                      className={inputCls}
                      type="number"
                      step="0.001"
                      min="0.000015"
                      value={feeSOL}
                      onChange={(e) => setFeeSOL(e.target.value)}
                    />
                  </Field>

                  {/* Tx feedback */}
                  {txState !== "idle" && (
                    <div
                      className="p-3 rounded-sm border font-mono text-xs"
                      style={{
                        borderColor:
                          txState === "success"
                            ? "rgba(20,241,149,0.25)"
                            : txState === "error"
                              ? "rgba(239,68,68,0.25)"
                              : "rgba(255,184,0,0.2)",
                        background:
                          txState === "success"
                            ? "rgba(20,241,149,0.05)"
                            : txState === "error"
                              ? "rgba(239,68,68,0.05)"
                              : "rgba(255,184,0,0.05)",
                        color:
                          txState === "success"
                            ? "#14F195"
                            : txState === "error"
                              ? "#F87171"
                              : "#FFB800",
                      }}
                    >
                      <p>{txMsg}</p>
                      {lastTxSig && txState === "success" && (
                        <a
                          href={`https://explorer.solana.com/tx/${lastTxSig}?cluster=devnet`}
                          target="_blank"
                          rel="noreferrer"
                          className="underline opacity-70 hover:opacity-100 mt-1 block"
                        >
                          View on Explorer ↗
                        </a>
                      )}
                    </div>
                  )}

                  {/* Submit */}
                  <button
                    onClick={handleRegister}
                    disabled={!formValid || txState === "loading"}
                    className="w-full btn-orange py-3 rounded-sm text-xs disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {txState === "loading" ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="w-3 h-3 border border-black/50 border-t-black rounded-full animate-spin" />
                        Sending...
                      </span>
                    ) : (
                      "Register Rule →"
                    )}
                  </button>

                  <p className="font-mono text-[10px] text-[#333] text-center">
                    Min fee: {MIN_FEE_LAMPORTS.toLocaleString()} lamports ·
                    devnet
                  </p>
                </div>
              </div>
            </div>

            {/* RIGHT: Rules dashboard */}
            <div className="lg:col-span-3">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-[#888] uppercase tracking-widest">
                    My Rules
                  </span>
                  {rules.length > 0 && (
                    <span className="font-mono text-xs px-2 py-0.5 rounded-sm bg-orange-500/10 text-orange-500 border border-orange-500/20">
                      {rules.length}
                    </span>
                  )}
                </div>
                <button
                  onClick={loadRules}
                  disabled={rulesLoading}
                  className="font-mono text-xs text-[#444] hover:text-orange-500 transition-colors px-3 py-1.5 border border-[#111] rounded-sm hover:border-orange-500/20"
                >
                  {rulesLoading ? "Loading..." : "↻ Refresh"}
                </button>
              </div>

              {rulesLoading && rules.length === 0 ? (
                <div className="flex items-center justify-center py-20 border border-[#111] rounded-sm">
                  <div className="flex flex-col items-center gap-3">
                    <span className="w-6 h-6 border border-orange-500/30 border-t-orange-500 rounded-full animate-spin" />
                    <span className="font-mono text-xs text-[#444]">
                      Fetching rules...
                    </span>
                  </div>
                </div>
              ) : rules.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-24 border border-[#111] rounded-sm gap-4">
                  <div className="w-10 h-10 rounded-sm border border-[#1a1a1a] flex items-center justify-center">
                    <span className="text-[#333] text-lg">∅</span>
                  </div>
                  <div className="text-center">
                    <p className="font-mono text-sm text-[#555]">
                      No rules yet
                    </p>
                    <p className="font-mono text-xs text-[#333] mt-1">
                      Register your first automation rule on the left
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {rules.map((rule) => (
                    <RuleCard
                      key={rule.address}
                      rule={rule}
                      onCancel={handleCancel}
                      cancelling={cancellingPda === rule.address}
                    />
                  ))}
                </div>
              )}

              {rules.length > 0 && (
                <div className="mt-6 p-4 border border-[#111] rounded-sm">
                  <p className="font-mono text-[10px] text-[#444] uppercase tracking-widest mb-3">
                    Status Legend
                  </p>
                  <div className="flex flex-wrap gap-3">
                    {Object.entries(STATUS_CONFIG).map(([status, cfg]) => (
                      <span
                        key={status}
                        className="inline-flex items-center gap-1.5 font-mono text-[10px]"
                        style={{ color: cfg.color }}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${cfg.dot.replace("animate-pulse", "").replace("animate-spin", "")}`}
                        />
                        {cfg.label}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
