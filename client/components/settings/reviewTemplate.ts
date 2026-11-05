export const reviewTemplate = `---
hot_paths: ["src/engine/**", "src/strategy/**", "src/stream/**"]
ignore: ["idl/**", "scripts/backtest/**"]
---
# Review guide

## Hot path
Entry points: \`Engine::on_account_update\`, \`Engine::on_slot\`, \`bundle::build_and_send\`; everything they call synchronously is hot. Budget: p99 ≤ 200µs from update to bundle sent.

## Forbidden on the hot path (P1)
- RPC/HTTP or any \`.await\` on network I/O — state comes from \`StateCache\` (geyser-fed).
- Locks held across \`.await\`; \`Mutex\` where an \`ArcSwap\` snapshot exists.
- Per-message heap allocation (\`format!\`, \`to_string\`, cloning account data); logging above \`debug!\`.

## Invariants (P0 if violated)
- Every swap instruction's \`min_amount_out\` derives from the same quote used to size it.
- Never sign a transaction built from state older than \`MAX_STATE_AGE_SLOTS\` (2).
- Keypairs only via \`keys::load()\` → \`Signer\`; never logged, serialized, or sent to I/O threads.

## Numbers & units
- Amounts are \`u64\` base units; \`f64\` for display only; prices \`u128\` Q64.64; bps, never percent; checked math in pricing; no truncating \`as\`.

## Slots, commitment, freshness
- Decisions use \`processed\` stream data tagged with its slot; drop updates whose slot is older than the last seen for that account.
- Off-hot-path RPC uses \`confirmed\`, never \`finalized\`, for pricing.
- On blockhash expiry, rebuild and re-sign; never resend an old signed transaction after rebuilding (double fill).

## Priority overrides
- Any change to fee or tip math is P0-sensitive.

## Don't flag
- \`unwrap()\` in \`tests/\` and \`benches/\`.
`;
