# Native Contract Deployment Checker

A self-contained TypeScript + [viem](https://viem.sh) CLI tool that reads on-chain state for a
`NativeLPToken` / `WrappedNLP` / `WithdrawQueue` deployment over a given RPC, explains each read,
and validates that the wiring and config are correct.

It prints a per-contract report with `[PASS]` / `[WARN]` / `[FAIL]` / `[INFO]` statuses, a final
summary, and exits with a non-zero code if any check fails.

## What it verifies

- **Existence**: each address (and the discovered `CreditVault`) actually has deployed bytecode.
- **Cross-wiring**: `nlp.underlying == token`, `wnlp.nlp == nlp`, `wnlp.withdrawQueue == withdrawqueue`,
  `withdrawqueue.wrappedNLP == wnlp`, matching decimals, etc.
- **wNLP redeem permissions on nlp** (critical): `nlp.trustedOperators(wnlp) == true` and
  `nlp.redeemCooldownExempt(wnlp) == true`, so wNLP can redeem anytime without a cooldown block or fee.
- **CreditVault market registration** (critical, discovered via `nlp.creditVault()`):
  `creditVault.supportedMarkets(nlp) == true` and `creditVault.lpTokens(token) == nlp`, otherwise
  redeems and yield distribution revert.
- **CreditVault owner** (critical): `creditVault.owner()` must equal the hardcoded Sentinel V2 owner
  contract for the chain (see `SENTINEL_V2_CREDIT_VAULT_OWNER` in `src/checks.ts`; configured for
  Ethereum, BNB, Base, and Arbitrum).
- **Config bounds**: fee bips and withdrawal window are within the contract-enforced maximums.
- **Pending ownership transfers**: if any of nlp/wnlp/withdrawqueue has a non-zero `pendingOwner`
  (an Ownable2Step transfer in progress), it must target the chain's expected Safe multisig
  (see `SAFE_OWNER` in `src/checks.ts`; configured for Ethereum, BNB, Arbitrum, Base) - otherwise it
  warns.
- **Soft checks**: queue name convention, per-deployment ownership consistency
  (nlp/wnlp/queue share one admin).

## Install

```bash
npm install
```

## Usage

```bash
npm run check -- \
  --rpc <url> \
  --token <addr> \
  --nlp <addr> \
  --wnlp <addr> \
  --withdrawqueue <addr> \
  [--name <label>] \
  [--chain-id <id>]
```

Or directly:

```bash
npx tsx src/check.ts --rpc <url> --token <addr> --nlp <addr> --wnlp <addr> --withdrawqueue <addr>
```

### Example: QQQx on BSC

```bash
npm run check -- \
  --name QQQx \
  --chain-id 56 \
  --rpc https://bsc-dataseed.bnbchain.org \
  --token 0xa753A7395cAe905Cd615Da0B82A53E0560f250af \
  --nlp 0x42a4a66D83834b9BE1087020F439A50949d6A245 \
  --wnlp 0x427fb58709c47Fb8794771BD2E17784c0CdA845a \
  --withdrawqueue 0x7768aa6322ab912bEe159191Ec3380DF13F6db37
```

## Flags

| Flag | Required | Default | Description |
| --- | --- | --- | --- |
| `--rpc` | yes | - | JSON-RPC HTTP endpoint |
| `--token` | yes | - | Underlying ERC20 token address |
| `--nlp` | yes | - | `NativeLPToken` address |
| `--wnlp` | yes | - | `WrappedNLP` address |
| `--withdrawqueue` | yes | - | `WithdrawQueue` address |
| `--name` | no | `deployment` | Label shown in the report header |
| `--chain-id` | no | `56` | Chain id used by the viem client |

## Exit codes

- `0` - all checks passed (warnings allowed)
- `1` - at least one check failed, or a fatal error (bad args, RPC unreachable)
