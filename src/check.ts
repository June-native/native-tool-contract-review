import { parseArgs } from "node:util";
import { createPublicClient, defineChain, getAddress, http, isAddress, type Address } from "viem";

import { creditVaultAbi, erc20Abi, nlpAbi, withdrawQueueAbi, wnlpAbi } from "./abis.js";
import { buildReport, MULTICALL3_ADDRESS, type CheckContext, type Reads, type ReadResult, type ReportSection, type Severity } from "./checks.js";

/*//////////////////////////////////////////////////////////////////////////
                                   CLI ARGS
//////////////////////////////////////////////////////////////////////////*/

interface Args {
  rpc: string;
  token: Address;
  nlp: Address;
  wnlp: Address;
  withdrawqueue: Address;
  name: string;
  chainId: number;
}

function fail(message: string): never {
  console.error(`Error: ${message}\n`);
  console.error(
    "Usage:\n" +
      "  npx tsx src/check.ts --rpc <url> --token <addr> --nlp <addr> --wnlp <addr> --withdrawqueue <addr> [--name <label>] [--chain-id <id>]",
  );
  process.exit(1);
}

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      rpc: { type: "string" },
      token: { type: "string" },
      nlp: { type: "string" },
      wnlp: { type: "string" },
      withdrawqueue: { type: "string" },
      name: { type: "string" },
      "chain-id": { type: "string" },
    },
    allowPositionals: false,
  });

  const requireAddr = (label: string, v: string | undefined): Address => {
    if (!v) fail(`missing required --${label}`);
    if (!isAddress(v)) fail(`--${label} is not a valid address: ${v}`);
    return getAddress(v);
  };

  if (!values.rpc) fail("missing required --rpc");

  let chainId = 56;
  if (values["chain-id"] !== undefined) {
    const parsed = Number(values["chain-id"]);
    if (!Number.isInteger(parsed) || parsed <= 0) fail(`--chain-id must be a positive integer: ${values["chain-id"]}`);
    chainId = parsed;
  }

  return {
    rpc: values.rpc,
    token: requireAddr("token", values.token),
    nlp: requireAddr("nlp", values.nlp),
    wnlp: requireAddr("wnlp", values.wnlp),
    withdrawqueue: requireAddr("withdrawqueue", values.withdrawqueue),
    name: values.name ?? "deployment",
    chainId,
  };
}

/*//////////////////////////////////////////////////////////////////////////
                                MULTICALL PLUMBING
//////////////////////////////////////////////////////////////////////////*/

interface Call {
  key: string;
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
}

type MulticallResult =
  | { status: "success"; result: unknown }
  | { status: "failure"; error: Error };

function shortError(error: unknown): string {
  if (error instanceof Error) {
    const firstLine = error.message.split("\n")[0] ?? error.message;
    return firstLine.slice(0, 160);
  }
  return String(error).slice(0, 160);
}

/** Queue every zero-argument view function declared in an ABI. */
function addZeroArgReads(calls: Call[], prefix: string, address: Address, abi: readonly unknown[]): void {
  for (const item of abi as ReadonlyArray<{ type: string; name: string; inputs: unknown[] }>) {
    if (item.type === "function" && item.inputs.length === 0) {
      calls.push({ key: `${prefix}.${item.name}`, address, abi, functionName: item.name });
    }
  }
}

async function runMulticall(
  client: ReturnType<typeof createPublicClient>,
  calls: Call[],
  reads: Reads,
): Promise<void> {
  if (calls.length === 0) return;
  const results = (await client.multicall({
    contracts: calls.map(({ address, abi, functionName, args }) => ({
      address,
      abi: abi as never,
      functionName,
      args: args as never,
    })),
    allowFailure: true,
  })) as unknown as MulticallResult[];

  calls.forEach((call, i) => {
    const r = results[i];
    if (r && r.status === "success") {
      reads[call.key] = { ok: true, value: r.result };
    } else {
      reads[call.key] = { ok: false, error: r ? shortError(r.error) : "no result returned" };
    }
  });
}

async function checkCode(
  client: ReturnType<typeof createPublicClient>,
  address: Address,
  code: Record<string, ReadResult<boolean>>,
): Promise<void> {
  try {
    const bytecode = await client.getCode({ address });
    code[address.toLowerCase()] = { ok: true, value: Boolean(bytecode && bytecode !== "0x") };
  } catch (error) {
    code[address.toLowerCase()] = { ok: false, error: shortError(error) };
  }
}

/*//////////////////////////////////////////////////////////////////////////
                                 RENDERING
//////////////////////////////////////////////////////////////////////////*/

const useColor = process.stdout.isTTY === true;

function colorize(status: Severity): string {
  const label = status.padEnd(4);
  if (!useColor) return `[${label}]`;
  const codes: Record<Severity, string> = {
    PASS: "32", // green
    WARN: "33", // yellow
    FAIL: "31", // red
    INFO: "36", // cyan
  };
  return `\u001b[${codes[status]}m[${label}]\u001b[0m`;
}

function renderSections(sections: ReportSection[]): void {
  for (const section of sections) {
    console.log(`\n== ${section.title} ==`);
    for (const line of section.lines) {
      const base = `  ${colorize(line.status)} ${line.label.padEnd(26)} ${line.value}`;
      console.log(base);
      console.log(`        ${dim(line.explain)}`);
      if (line.note) console.log(`        ${dim("-> " + line.note)}`);
    }
  }
}

function dim(s: string): string {
  return useColor ? `\u001b[2m${s}\u001b[0m` : s;
}

/*//////////////////////////////////////////////////////////////////////////
                                    MAIN
//////////////////////////////////////////////////////////////////////////*/

async function main(): Promise<void> {
  const args = parseCliArgs();

  const chain = defineChain({
    id: args.chainId,
    name: `chain-${args.chainId}`,
    nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [args.rpc] } },
    contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
  });

  const client = createPublicClient({ chain, transport: http(args.rpc) });

  console.log(`Native Contract Deployment Checker`);
  console.log(`  deployment : ${args.name}`);
  console.log(`  chain id   : ${args.chainId}`);
  console.log(`  rpc        : ${args.rpc}`);
  console.log(`  token      : ${args.token}`);
  console.log(`  nlp        : ${args.nlp}`);
  console.log(`  wnlp       : ${args.wnlp}`);
  console.log(`  queue      : ${args.withdrawqueue}`);

  const reads: Reads = {};
  const code: Record<string, ReadResult<boolean>> = {};

  // Phase 1: existence + view reads on the 4 input contracts.
  await Promise.all([
    checkCode(client, args.token, code),
    checkCode(client, args.nlp, code),
    checkCode(client, args.wnlp, code),
    checkCode(client, args.withdrawqueue, code),
  ]);

  const phase1: Call[] = [];
  addZeroArgReads(phase1, "token", args.token, erc20Abi);
  addZeroArgReads(phase1, "nlp", args.nlp, nlpAbi);
  addZeroArgReads(phase1, "wnlp", args.wnlp, wnlpAbi);
  addZeroArgReads(phase1, "withdrawqueue", args.withdrawqueue, withdrawQueueAbi);
  // Address-parameterized reads on nlp.
  phase1.push({ key: "nlp.trustedOperators(wnlp)", address: args.nlp, abi: nlpAbi, functionName: "trustedOperators", args: [args.wnlp] });
  phase1.push({ key: "nlp.redeemCooldownExempt(wnlp)", address: args.nlp, abi: nlpAbi, functionName: "redeemCooldownExempt", args: [args.wnlp] });

  try {
    await runMulticall(client, phase1, reads);
  } catch (error) {
    fail(`RPC multicall failed (phase 1): ${shortError(error)}`);
  }

  // Discover CreditVault from nlp.creditVault().
  const cvRead = reads["nlp.creditVault"];
  let creditVault: ReadResult<Address>;
  if (cvRead && cvRead.ok) {
    creditVault = { ok: true, value: getAddress(cvRead.value as string) };
  } else {
    creditVault = { ok: false, error: cvRead && !cvRead.ok ? cvRead.error : "nlp.creditVault() unavailable" };
  }

  // Phase 2: CreditVault registration reads (only if discovered).
  if (creditVault.ok) {
    await checkCode(client, creditVault.value, code);
    const phase2: Call[] = [
      { key: "creditVault.supportedMarkets(nlp)", address: creditVault.value, abi: creditVaultAbi, functionName: "supportedMarkets", args: [args.nlp] },
      { key: "creditVault.lpTokens(token)", address: creditVault.value, abi: creditVaultAbi, functionName: "lpTokens", args: [args.token] },
      { key: "creditVault.owner", address: creditVault.value, abi: creditVaultAbi, functionName: "owner" },
    ];
    try {
      await runMulticall(client, phase2, reads);
    } catch (error) {
      // Non-fatal: surface as failed reads so the report still renders.
      for (const c of phase2) reads[c.key] = { ok: false, error: shortError(error) };
    }
  }

  const ctx: CheckContext = {
    name: args.name,
    chainId: args.chainId,
    token: args.token,
    nlp: args.nlp,
    wnlp: args.wnlp,
    withdrawqueue: args.withdrawqueue,
    creditVault,
    code,
    reads,
  };

  const sections = buildReport(ctx);
  renderSections(sections);

  // Totals + exit code.
  const totals: Record<Severity, number> = { PASS: 0, WARN: 0, FAIL: 0, INFO: 0 };
  for (const section of sections) for (const line of section.lines) totals[line.status]++;

  console.log(`\n== Summary ==`);
  console.log(`  ${colorize("PASS")} ${totals.PASS}   ${colorize("WARN")} ${totals.WARN}   ${colorize("FAIL")} ${totals.FAIL}   ${colorize("INFO")} ${totals.INFO}`);

  if (totals.FAIL > 0) {
    console.log(`\nResult: FAILED - ${totals.FAIL} check(s) failed for "${args.name}".`);
    process.exit(1);
  }
  if (totals.WARN > 0) {
    console.log(`\nResult: PASSED WITH WARNINGS - review ${totals.WARN} warning(s) for "${args.name}".`);
  } else {
    console.log(`\nResult: PASSED - "${args.name}" is correctly wired and configured.`);
  }
  process.exit(0);
}

main().catch((error) => {
  fail(shortError(error));
});
