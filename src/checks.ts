import { getAddress, type Address } from "viem";

/*//////////////////////////////////////////////////////////////////////////
                                   TYPES
//////////////////////////////////////////////////////////////////////////*/

export type Severity = "PASS" | "WARN" | "FAIL" | "INFO";

/** Outcome of a single on-chain read (success carries the decoded value). */
export type ReadResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** A bag of reads keyed by `contract.field` (e.g. `nlp.underlying`). */
export type Reads = Record<string, ReadResult<unknown>>;

export interface ReportLine {
  label: string;
  value: string;
  explain: string;
  status: Severity;
  note?: string;
}

export interface ReportSection {
  title: string;
  lines: ReportLine[];
}

export interface CheckContext {
  /** Label for the deployment (e.g. "QQQx"). */
  name: string;
  /** Chain id (used to look up the expected Sentinel V2 CreditVault owner). */
  chainId: number;
  /** Input addresses supplied on the CLI. */
  token: Address;
  nlp: Address;
  wnlp: Address;
  withdrawqueue: Address;
  /** CreditVault address discovered from `nlp.creditVault()` (may have failed). */
  creditVault: ReadResult<Address>;
  /** `getCode` existence results keyed by address (lowercased). */
  code: Record<string, ReadResult<boolean>>;
  /** All view reads keyed by `contract.field`. */
  reads: Reads;
}

/*//////////////////////////////////////////////////////////////////////////
                            CONTRACT-DERIVED BOUNDS
//////////////////////////////////////////////////////////////////////////*/

// From ConstantsLib.sol / contract setters.
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const MAX_EARLY_WITHDRAW_FEE_BIPS = 1000n; // ConstantsLib.MAX_EARLY_WITHDRAW_FEE_BIPS (10%)
const MAX_INSTANT_REDEEM_FEE_BIPS = 2500n; // WrappedNLP.setInstantRedeemFeeBips cap (25%)
const MAX_WITHDRAWAL_WINDOW = 14n * 24n * 60n * 60n; // WithdrawQueue.MAX_WITHDRAWAL_WINDOW (14 days)
const MAX_AFF_FEE_BPS_CAP = 1000n; // WithdrawQueue constructor cap on maxAffFeeBps
const EXPECTED_MIN_INSTANT_REDEEM_AMOUNT = 1000n; // WrappedNLP.MIN_INSTANT_REDEEM_AMOUNT
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Sentinel V2 owner contract that is expected to own the CreditVault, keyed by chain id.
 * The CreditVault is shared core infra, so its admin is governance (not the per-deployment owner).
 */
const SENTINEL_V2_CREDIT_VAULT_OWNER: Record<number, string> = {
  1: "0x4Df7557734B382EB542BEa6c74786D398DF4CC19", // Ethereum
  56: "0x4Df7557734B382EB542BEa6c74786D398DF4CC19", // BNB Chain
  8453: "0x4Df7557734B382EB542BEa6c74786D398DF4CC19", // Base
  42161: "0xd085195EDABf4b9f0673B8B8b7dA077c292967Cd", // Arbitrum One
};

/**
 * Expected Safe (multisig) that a pending ownership transfer should target, by chain id.
 * Applies to the per-deployment contracts (nlp/wnlp/withdrawqueue) when an Ownable2Step
 * transfer is in progress.
 */
const SAFE_OWNER: Record<number, string> = {
  1: "0x83fc28e6962E41e38F7854308eFF827E3f6b906B", // Ethereum
  56: "0x2F775775e7eB2F8b9a31d10400273308f6deeF0a", // BNB Chain
  42161: "0x48D5713904E194a27E5D57Eb76DEE4aD67b0198A", // Arbitrum One
  8453: "0x181fB7f2779b23F9f493ff7282F25AD39Ac6ba96", // Base
};

/*//////////////////////////////////////////////////////////////////////////
                              FORMAT HELPERS
//////////////////////////////////////////////////////////////////////////*/

export function eqAddr(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function shortAddr(a: string): string {
  try {
    return getAddress(a);
  } catch {
    return a;
  }
}

function fmtBips(b: bigint): string {
  return `${b} bips (${Number(b) / 100}%)`;
}

function fmtDuration(seconds: bigint): string {
  const s = Number(seconds);
  if (s === 0) return "0 s";
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins) parts.push(`${mins}m`);
  const human = parts.length ? parts.join(" ") : `${s}s`;
  return `${seconds} s (${human})`;
}

function fmtScaled1e18(x: bigint): string {
  const whole = x / 10n ** 18n;
  const frac = x % 10n ** 18n;
  const fracStr = frac.toString().padStart(18, "0").slice(0, 6);
  return `${x} (~${whole}.${fracStr})`;
}

/*//////////////////////////////////////////////////////////////////////////
                          TYPED READ ACCESSORS
//////////////////////////////////////////////////////////////////////////*/

function get(reads: Reads, key: string): ReadResult<unknown> {
  return reads[key] ?? { ok: false, error: "read not performed" };
}

function asAddress(reads: Reads, key: string): ReadResult<Address> {
  const r = get(reads, key);
  if (!r.ok) return r;
  return { ok: true, value: getAddress(r.value as string) };
}

function asBool(reads: Reads, key: string): ReadResult<boolean> {
  const r = get(reads, key);
  if (!r.ok) return r;
  return { ok: true, value: Boolean(r.value) };
}

function asBigInt(reads: Reads, key: string): ReadResult<bigint> {
  const r = get(reads, key);
  if (!r.ok) return r;
  return { ok: true, value: BigInt(r.value as bigint) };
}

function asString(reads: Reads, key: string): ReadResult<string> {
  const r = get(reads, key);
  if (!r.ok) return r;
  return { ok: true, value: String(r.value) };
}

/*//////////////////////////////////////////////////////////////////////////
                            LINE CONSTRUCTORS
//////////////////////////////////////////////////////////////////////////*/

function failLine(label: string, explain: string, error: string): ReportLine {
  return { label, value: "<read failed>", explain, status: "FAIL", note: error };
}

/** Build a line for a read whose value is informational only. */
function infoLine(
  reads: Reads,
  key: string,
  label: string,
  explain: string,
  fmt: (v: never) => string,
): ReportLine {
  const r = get(reads, key);
  if (!r.ok) return failLine(label, explain, r.error);
  return { label, value: fmt(r.value as never), explain, status: "INFO" };
}

/*//////////////////////////////////////////////////////////////////////////
                              REPORT BUILDER
//////////////////////////////////////////////////////////////////////////*/

export function buildReport(ctx: CheckContext): ReportSection[] {
  const { reads } = ctx;
  const sections: ReportSection[] = [];

  /* --------------------------- existence -------------------------- */
  const existence: ReportLine[] = [];
  const existsLine = (label: string, addr: string): ReportLine => {
    const r = ctx.code[addr.toLowerCase()] ?? { ok: false, error: "not checked" };
    if (!r.ok) {
      return { label, value: shortAddr(addr), explain: "Bytecode present at address", status: "FAIL", note: r.error };
    }
    return {
      label,
      value: shortAddr(addr),
      explain: "Bytecode present at address",
      status: r.value ? "PASS" : "FAIL",
      note: r.value ? undefined : "no bytecode (not a contract / not deployed on this chain)",
    };
  };
  existence.push(existsLine("token", ctx.token));
  existence.push(existsLine("nlp", ctx.nlp));
  existence.push(existsLine("wnlp", ctx.wnlp));
  existence.push(existsLine("withdrawqueue", ctx.withdrawqueue));
  if (ctx.creditVault.ok) {
    existence.push(existsLine("creditVault (discovered)", ctx.creditVault.value));
  } else {
    existence.push(failLine("creditVault (discovered)", "Bytecode present at address", ctx.creditVault.error));
  }
  sections.push({ title: "Existence (bytecode)", lines: existence });

  /* ----------------------------- token ---------------------------- */
  const tokenLines: ReportLine[] = [
    infoLine(reads, "token.name", "name", "ERC20 token name", (v: string) => v),
    infoLine(reads, "token.symbol", "symbol", "ERC20 token symbol", (v: string) => v),
    infoLine(reads, "token.decimals", "decimals", "ERC20 token decimals", (v: number) => String(v)),
    infoLine(reads, "token.totalSupply", "totalSupply", "ERC20 total supply (raw)", (v: bigint) => String(v)),
  ];
  sections.push({ title: "Underlying token", lines: tokenLines });

  /* ------------------------------ nlp ----------------------------- */
  const nlpLines: ReportLine[] = [];
  nlpLines.push(infoLine(reads, "nlp.name", "name", "LP token name", (v: string) => v));
  nlpLines.push(infoLine(reads, "nlp.symbol", "symbol", "LP token symbol", (v: string) => v));

  // decimals == token.decimals
  {
    const nd = asBigInt(reads, "nlp.decimals");
    const td = asBigInt(reads, "token.decimals");
    if (!nd.ok) nlpLines.push(failLine("decimals", "Must equal underlying token decimals", nd.error));
    else if (!td.ok) nlpLines.push({ label: "decimals", value: String(nd.value), explain: "Must equal underlying token decimals", status: "WARN", note: "token decimals unavailable for comparison" });
    else
      nlpLines.push({
        label: "decimals",
        value: String(nd.value),
        explain: "Must equal underlying token decimals",
        status: nd.value === td.value ? "PASS" : "FAIL",
        note: nd.value === td.value ? undefined : `token decimals = ${td.value}`,
      });
  }

  // underlying == token
  pushAddrMatch(nlpLines, asAddress(reads, "nlp.underlying"), ctx.token, "underlying", "Underlying token; must equal the --token address");
  // creditVault non-zero
  {
    const cv = asAddress(reads, "nlp.creditVault");
    if (!cv.ok) nlpLines.push(failLine("creditVault", "CreditVault that custodies underlying; must be non-zero", cv.error));
    else
      nlpLines.push({
        label: "creditVault",
        value: shortAddr(cv.value),
        explain: "CreditVault that custodies underlying; must be non-zero",
        status: eqAddr(cv.value, ZERO_ADDRESS) ? "FAIL" : "PASS",
      });
  }

  pushPausedFlag(nlpLines, asBool(reads, "nlp.depositPaused"), "depositPaused", "Deposits paused when true");
  pushPausedFlag(nlpLines, asBool(reads, "nlp.redeemPaused"), "redeemPaused", "Redeems paused when true");

  pushBipsCap(nlpLines, asBigInt(reads, "nlp.earlyWithdrawFeeBips"), MAX_EARLY_WITHDRAW_FEE_BIPS, "earlyWithdrawFeeBips", "Early-withdraw fee; must be <= 1000 bips (MAX_EARLY_WITHDRAW_FEE_BIPS)");

  nlpLines.push(infoLine(reads, "nlp.accEarlyWithdrawFee", "accEarlyWithdrawFee", "Accumulated early-withdraw fees (raw)", (v: bigint) => String(v)));
  nlpLines.push(infoLine(reads, "nlp.minRedeemInterval", "minRedeemInterval", "Cooldown between deposit and penalty-free redeem", (v: bigint) => fmtDuration(v)));
  nlpLines.push(infoLine(reads, "nlp.minDeposit", "minDeposit", "Minimum deposit amount (raw)", (v: bigint) => String(v)));
  nlpLines.push(infoLine(reads, "nlp.totalUnderlying", "totalUnderlying", "Total underlying managed (raw)", (v: bigint) => String(v)));
  nlpLines.push(infoLine(reads, "nlp.totalShares", "totalShares", "Total shares issued (raw)", (v: bigint) => String(v)));
  nlpLines.push(infoLine(reads, "nlp.exchangeRate", "exchangeRate", "Underlying per share, scaled by 1e18", (v: bigint) => fmtScaled1e18(v)));

  // wNLP redeem-permission checks on nlp (CRITICAL)
  pushBoolMustBeTrue(
    nlpLines,
    asBool(reads, "nlp.trustedOperators(wnlp)"),
    "trustedOperators[wnlp]",
    "Must be true so wNLP can call nlp.redeemTo (else NotTrustedOperator)",
  );
  pushBoolMustBeTrue(
    nlpLines,
    asBool(reads, "nlp.redeemCooldownExempt(wnlp)"),
    "redeemCooldownExempt[wnlp]",
    "Must be true so wNLP redeems anytime with no cooldown block or early-withdraw fee",
  );

  pushOwner(nlpLines, asAddress(reads, "nlp.owner"));
  sections.push({ title: "NativeLPToken (nlp)", lines: nlpLines });

  /* ----------------------------- wnlp ----------------------------- */
  const wnlpLines: ReportLine[] = [];
  wnlpLines.push(infoLine(reads, "wnlp.name", "name", "Wrapped LP token name", (v: string) => v));
  wnlpLines.push(infoLine(reads, "wnlp.symbol", "symbol", "Wrapped LP token symbol", (v: string) => v));
  {
    const wd = asBigInt(reads, "wnlp.decimals");
    const nd = asBigInt(reads, "nlp.decimals");
    if (!wd.ok) wnlpLines.push(failLine("decimals", "Must equal nlp decimals", wd.error));
    else if (!nd.ok) wnlpLines.push({ label: "decimals", value: String(wd.value), explain: "Must equal nlp decimals", status: "WARN", note: "nlp decimals unavailable" });
    else
      wnlpLines.push({
        label: "decimals",
        value: String(wd.value),
        explain: "Must equal nlp decimals",
        status: wd.value === nd.value ? "PASS" : "FAIL",
        note: wd.value === nd.value ? undefined : `nlp decimals = ${nd.value}`,
      });
  }
  pushAddrMatch(wnlpLines, asAddress(reads, "wnlp.nlp"), ctx.nlp, "nlp", "Underlying NLP; must equal the --nlp address");
  pushAddrMatch(wnlpLines, asAddress(reads, "wnlp.underlying"), ctx.token, "underlying", "Underlying token; must equal the --token address");
  pushAddrMatch(wnlpLines, asAddress(reads, "wnlp.withdrawQueue"), ctx.withdrawqueue, "withdrawQueue", "Authorized queue; must equal the --withdrawqueue address (set via setWithdrawQueue)");
  pushNonZeroAddr(wnlpLines, asAddress(reads, "wnlp.feeRecipient"), "feeRecipient", "Receives instant-redeem fees; must be non-zero");
  wnlpLines.push(infoLine(reads, "wnlp.instantRedeemEnabled", "instantRedeemEnabled", "Whether instant redeem is open", (v: boolean) => String(v)));
  pushBipsCap(wnlpLines, asBigInt(reads, "wnlp.instantRedeemFeeBips"), MAX_INSTANT_REDEEM_FEE_BIPS, "instantRedeemFeeBips", "Instant-redeem fee; must be <= 2500 bips (25%)");
  {
    const m = asBigInt(reads, "wnlp.MIN_INSTANT_REDEEM_AMOUNT");
    if (!m.ok) wnlpLines.push(failLine("MIN_INSTANT_REDEEM_AMOUNT", "Constant minimum instant-redeem amount", m.error));
    else
      wnlpLines.push({
        label: "MIN_INSTANT_REDEEM_AMOUNT",
        value: String(m.value),
        explain: "Constant minimum instant-redeem amount (expected 1000)",
        status: m.value === EXPECTED_MIN_INSTANT_REDEEM_AMOUNT ? "PASS" : "WARN",
        note: m.value === EXPECTED_MIN_INSTANT_REDEEM_AMOUNT ? undefined : "differs from source constant 1000",
      });
  }
  pushOwner(wnlpLines, asAddress(reads, "wnlp.owner"));
  sections.push({ title: "WrappedNLP (wnlp)", lines: wnlpLines });

  /* -------------------------- withdrawqueue ----------------------- */
  const wqLines: ReportLine[] = [];
  // name == wnlp.symbol() + "-Queue"
  {
    const qn = asString(reads, "withdrawqueue.name");
    const ws = asString(reads, "wnlp.symbol");
    if (!qn.ok) wqLines.push(failLine("name", "Should equal wnlp.symbol() + \"-Queue\"", qn.error));
    else if (!ws.ok) wqLines.push({ label: "name", value: qn.value, explain: "Should equal wnlp.symbol() + \"-Queue\"", status: "WARN", note: "wnlp symbol unavailable for comparison" });
    else {
      const expected = `${ws.value}-Queue`;
      wqLines.push({
        label: "name",
        value: qn.value,
        explain: "Should equal wnlp.symbol() + \"-Queue\"",
        status: qn.value === expected ? "PASS" : "WARN",
        note: qn.value === expected ? undefined : `expected "${expected}"`,
      });
    }
  }
  pushAddrMatch(wqLines, asAddress(reads, "withdrawqueue.wrappedNLP"), ctx.wnlp, "wrappedNLP", "Wrapped NLP; must equal the --wnlp address");
  pushAddrMatch(wqLines, asAddress(reads, "withdrawqueue.underlying"), ctx.token, "underlying", "Underlying token; must equal the --token address");
  pushNonZeroAddr(wqLines, asAddress(reads, "withdrawqueue.feeRecipient"), "feeRecipient", "Receives excess yield / affiliate fees; must be non-zero");
  {
    const w = asBigInt(reads, "withdrawqueue.withdrawalWindow");
    if (!w.ok) wqLines.push(failLine("withdrawalWindow", "Delay before a request is claimable; must be <= 14 days", w.error));
    else
      wqLines.push({
        label: "withdrawalWindow",
        value: fmtDuration(w.value),
        explain: "Delay before a request is claimable; must be <= 14 days (MAX_WITHDRAWAL_WINDOW)",
        status: w.value <= MAX_WITHDRAWAL_WINDOW ? "PASS" : "FAIL",
        note: w.value <= MAX_WITHDRAWAL_WINDOW ? undefined : `exceeds max ${MAX_WITHDRAWAL_WINDOW}s`,
      });
  }
  pushBipsCap(wqLines, asBigInt(reads, "withdrawqueue.maxAffFeeBps"), MAX_AFF_FEE_BPS_CAP, "maxAffFeeBps", "Immutable affiliate-fee cap; must be <= 1000 bips (constructor limit)");
  wqLines.push(infoLine(reads, "withdrawqueue.totalUnclaimedAmount", "totalUnclaimedAmount", "Total wNLP escrowed in pending requests (raw)", (v: bigint) => String(v)));
  wqLines.push(infoLine(reads, "withdrawqueue.MIN_WITHDRAWAL_AMOUNT", "MIN_WITHDRAWAL_AMOUNT", "Constant minimum withdrawal amount", (v: bigint) => String(v)));
  wqLines.push(infoLine(reads, "withdrawqueue.MAX_WITHDRAWAL_WINDOW", "MAX_WITHDRAWAL_WINDOW", "Constant max withdrawal window", (v: bigint) => fmtDuration(v)));
  wqLines.push(infoLine(reads, "withdrawqueue.BPS_DENOMINATOR", "BPS_DENOMINATOR", "Constant basis-point denominator", (v: bigint) => String(v)));
  pushOwner(wqLines, asAddress(reads, "withdrawqueue.owner"));
  sections.push({ title: "WithdrawQueue (withdrawqueue)", lines: wqLines });

  /* ----------------------- credit vault registration -------------- */
  const cvLines: ReportLine[] = [];
  if (!ctx.creditVault.ok) {
    cvLines.push(failLine("creditVault", "Discovered from nlp.creditVault()", ctx.creditVault.error));
  } else {
    const cvAddr = ctx.creditVault.value;
    cvLines.push({ label: "address", value: shortAddr(cvAddr), explain: "CreditVault discovered from nlp.creditVault()", status: "INFO" });
    // supportedMarkets[nlp] == true
    pushBoolMustBeTrue(
      cvLines,
      asBool(reads, "creditVault.supportedMarkets(nlp)"),
      "supportedMarkets[nlp]",
      "Must be true; else CreditVault.pay reverts (OnlyLpToken) and ALL redeems fail",
    );
    // lpTokens[token] == nlp
    pushAddrMatch(
      cvLines,
      asAddress(reads, "creditVault.lpTokens(token)"),
      ctx.nlp,
      "lpTokens[token]",
      "Must equal nlp; required for epochUpdate/distributeYield to route yield",
    );
    // owner == hardcoded Sentinel V2 owner for this chain
    {
      const cvOwner = asAddress(reads, "creditVault.owner");
      const expected = SENTINEL_V2_CREDIT_VAULT_OWNER[ctx.chainId];
      if (!cvOwner.ok) {
        cvLines.push(failLine("owner", "Must equal the Sentinel V2 owner contract for this chain", cvOwner.error));
      } else if (!expected) {
        cvLines.push({
          label: "owner",
          value: shortAddr(cvOwner.value),
          explain: "Expected Sentinel V2 owner (no hardcoded value known for this chain id)",
          status: "INFO",
        });
      } else {
        const ok = eqAddr(cvOwner.value, expected);
        cvLines.push({
          label: "owner",
          value: shortAddr(cvOwner.value),
          explain: `Must equal the Sentinel V2 owner contract for chain ${ctx.chainId}`,
          status: ok ? "PASS" : "FAIL",
          note: ok ? undefined : `expected ${shortAddr(expected)}`,
        });
      }
    }
  }
  sections.push({ title: "CreditVault registration", lines: cvLines });

  /* --------------------------- ownership -------------------------- */
  // Only the per-deployment contracts are expected to share one admin.
  // CreditVault is shared governance and is validated against a hardcoded owner above.
  const owners: Array<{ who: string; r: ReadResult<Address> }> = [
    { who: "nlp", r: asAddress(reads, "nlp.owner") },
    { who: "wnlp", r: asAddress(reads, "wnlp.owner") },
    { who: "withdrawqueue", r: asAddress(reads, "withdrawqueue.owner") },
  ];
  const ownLines: ReportLine[] = [];
  const resolved = owners.filter((o) => o.r.ok) as Array<{ who: string; r: { ok: true; value: Address } }>;
  const distinct = new Set(resolved.map((o) => o.r.value.toLowerCase()));
  for (const o of owners) {
    if (!o.r.ok) {
      ownLines.push({ label: `${o.who}.owner`, value: "<read failed>", explain: "Contract admin (Ownable2Step)", status: "WARN", note: o.r.error });
    } else {
      ownLines.push({
        label: `${o.who}.owner`,
        value: shortAddr(o.r.value),
        explain: "Per-deployment admin (Ownable2Step); nlp/wnlp/queue should share one owner",
        status: distinct.size <= 1 ? "PASS" : "WARN",
        note: distinct.size <= 1 ? undefined : "owners differ across the deployment contracts",
      });
    }
  }
  // pendingOwner in-flight transfers: when set, must target the chain's Safe.
  for (const [who, key] of [
    ["nlp", "nlp.pendingOwner"],
    ["wnlp", "wnlp.pendingOwner"],
    ["withdrawqueue", "withdrawqueue.pendingOwner"],
  ] as const) {
    const p = asAddress(reads, key);
    if (p.ok && !eqAddr(p.value, ZERO_ADDRESS)) {
      const safe = SAFE_OWNER[ctx.chainId];
      const matchesSafe = safe !== undefined && eqAddr(p.value, safe);
      ownLines.push({
        label: `${who}.pendingOwner`,
        value: shortAddr(p.value),
        explain: `Ownable2Step transfer in progress; expected to target the Safe owner for chain ${ctx.chainId}`,
        status: matchesSafe ? "PASS" : "WARN",
        note: matchesSafe
          ? "pending transfer to the expected Safe"
          : safe === undefined
            ? "no Safe owner configured for this chain"
            : `expected pending owner ${shortAddr(safe)}`,
      });
    }
  }
  sections.push({ title: "Ownership", lines: ownLines });

  return sections;
}

/*//////////////////////////////////////////////////////////////////////////
                          SHARED CHECK PRIMITIVES
//////////////////////////////////////////////////////////////////////////*/

function pushAddrMatch(lines: ReportLine[], got: ReadResult<Address>, expected: Address, label: string, explain: string): void {
  if (!got.ok) {
    lines.push(failLine(label, explain, got.error));
    return;
  }
  const ok = eqAddr(got.value, expected);
  lines.push({
    label,
    value: shortAddr(got.value),
    explain,
    status: ok ? "PASS" : "FAIL",
    note: ok ? undefined : `expected ${shortAddr(expected)}`,
  });
}

function pushNonZeroAddr(lines: ReportLine[], got: ReadResult<Address>, label: string, explain: string): void {
  if (!got.ok) {
    lines.push(failLine(label, explain, got.error));
    return;
  }
  const zero = eqAddr(got.value, ZERO_ADDRESS);
  lines.push({
    label,
    value: shortAddr(got.value),
    explain,
    status: zero ? "FAIL" : "PASS",
    note: zero ? "is the zero address" : undefined,
  });
}

function pushPausedFlag(lines: ReportLine[], got: ReadResult<boolean>, label: string, explain: string): void {
  if (!got.ok) {
    lines.push(failLine(label, explain, got.error));
    return;
  }
  lines.push({
    label,
    value: String(got.value),
    explain,
    status: got.value ? "WARN" : "PASS",
    note: got.value ? "feature is currently paused" : undefined,
  });
}

function pushBipsCap(lines: ReportLine[], got: ReadResult<bigint>, max: bigint, label: string, explain: string): void {
  if (!got.ok) {
    lines.push(failLine(label, explain, got.error));
    return;
  }
  const ok = got.value <= max;
  lines.push({
    label,
    value: fmtBips(got.value),
    explain,
    status: ok ? "PASS" : "FAIL",
    note: ok ? undefined : `exceeds max ${max} bips`,
  });
}

function pushBoolMustBeTrue(lines: ReportLine[], got: ReadResult<boolean>, label: string, explain: string): void {
  if (!got.ok) {
    lines.push(failLine(label, explain, got.error));
    return;
  }
  lines.push({
    label,
    value: String(got.value),
    explain,
    status: got.value ? "PASS" : "FAIL",
    note: got.value ? undefined : "expected true",
  });
}

function pushOwner(lines: ReportLine[], owner: ReadResult<Address>): void {
  if (!owner.ok) lines.push(failLine("owner", "Contract admin (Ownable2Step)", owner.error));
  else lines.push({ label: "owner", value: shortAddr(owner.value), explain: "Contract admin (Ownable2Step)", status: "INFO" });
}
