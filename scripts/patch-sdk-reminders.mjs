#!/usr/bin/env node
/**
 * Patch Claude Agent SDK to neutralize baked-in prompt nudges that over-trigger
 * Opus-class models for a local developer-agent use case, and to fix Opus 4.8+
 * thinking-block emission.
 *
 * Patches applied (all idempotent; safe to re-run after every `bun install`):
 *
 *   1. Remove the "malware on every Read" <system-reminder> appended to every
 *      Read tool result. SDK text: "Whenever you read a file, you should
 *      consider whether it would be considered malware..."
 *
 *   2. Remove the `pH9` "Refuse destructive techniques / detection evasion /
 *      supply chain compromise" security refusal block from the main system
 *      prompt. This block was written for a pentest-audit framing but causes
 *      Opus to refuse normal dev work (delete caches, remove telemetry, force
 *      push, etc.).
 *
 *   3. Weaken the periodic TodoWrite nag <system-reminder>. The original is
 *      verbose, conspiratorial ("NEVER mention this reminder to the user"),
 *      and pushes Opus to create todo lists for trivial tasks. Replaced with
 *      a single, non-meta line.
 *
 *   4. Soften the blanket "NEVER create files unless absolutely necessary" /
 *      "NEVER proactively create documentation" rules to a repo-hygiene
 *      principle. Opus reads "NEVER" as a hard ban and refuses reasonable
 *      scaffolding (new test files, new components). The principle version
 *      still discourages clutter without creating binary refusals.
 *
 *   5. Adaptive-thinking empty/rejected thinking fix (Opus 4.7+, Fable 5,
 *      Mythos). Starting with Opus 4.7, Anthropic changed the thinking API:
 *      manual {type:"enabled",budget_tokens:N} is legacy (rejected with 400
 *      on Opus 4.7+/Fable 5/Mythos 5), and `display` now defaults to
 *      "omitted" so the thinking field streams empty. We swap the SDK's
 *      request construction so models matching
 *      /opus-(?:4-(?:[7-9]|\d{2,})|[5-9])|fable-[5-9]|mythos/ get
 *      {type:"adaptive",display:"summarized"} instead, which populates
 *      thinking_delta events again. Older models keep the legacy
 *      enabled+budget_tokens form.
 *
 *   6. Opus 4.8+ output_config.effort (keep reasoning slider meaningful).
 *      Adaptive thinking removes budget_tokens, so the effort slider
 *      (low…max) loses its effect on 4.7+. We inject Anthropic's sibling
 *      `output_config.effort` field, mapping maxThinkingTokens → effort
 *      on the same scale (low/medium/high/xhigh/max).
 *
 *   7. Opus 4.8+ max_tokens cap (SSE streaming on fresh+xhigh/max).
 *      Opus 4.7+ enforces a hard `max_tokens <= 128000` limit at the API
 *      edge. The SDK computes max_tokens = max(maxThinkingTokens+1,
 *      wz0(model)); for opus-4-8 wz0 returns 32000, so at xhigh (B=128000)
 *      it sends max_tokens=128001 → 400 invalid_request_error. The SDK
 *      silently catches the streaming error and falls back to a
 *      non-streaming turn (Y.onStreamingFallback), which is why fresh
 *      xhigh/max turns show "everything at once, no deltas". At effort=max
 *      (B=200000) the default formula produces 200001, same failure mode.
 *      Fix: for adaptive-thinking models, pin max_tokens to 128000 (the
 *      Opus 4.7+ ceiling). Legacy/non-adaptive paths keep the original
 *      max(B+1, wz0(model)) formula untouched.
 *
 * Runs on `bun install` via the postinstall hook. The pristine cli.js is
 * preserved as cli.js.orig on first run; we always restore from this backup
 * before re-applying so patches stay idempotent even across version bumps.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync, statSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(
  __dirname,
  '..',
  'node_modules',
  '@anthropic-ai',
  'claude-agent-sdk',
  'cli.js',
);

const MARKER = '/* agentic:sdk-patched:v10 */';

function log(msg) {
  console.log(`[patch-sdk-reminders] ${msg}`);
}

if (!existsSync(CLI_PATH)) {
  log(`SDK not installed at ${CLI_PATH} — skipping (run after install).`);
  process.exit(0);
}

let currentSrc = readFileSync(CLI_PATH, 'utf8');

if (currentSrc.includes(MARKER)) {
  log('Already patched (v10). Skipping.');
  process.exit(0);
}

const ANY_MARKER = /\/\* agentic:sdk-patched:(?:v\d+|malware-reminder-removed) \*\//;
const isPatched = (src) => ANY_MARKER.test(src);

// Keep a backup next to the original on first install — but NEVER back up an
// already-patched file as "pristine". This can happen when bun's global cache
// got contaminated by an earlier patch run (bun installs via hardlinks, so an
// in-place write to node_modules/.../cli.js can poison the shared cache copy)
// and a fresh install then delivers a pre-patched cli.js.
const backupPath = `${CLI_PATH}.orig`;
const backupContaminated = existsSync(backupPath) && isPatched(readFileSync(backupPath, 'utf8'));
if (backupContaminated) {
  log('WARNING: cli.js.orig backup is itself patched (contaminated) — deleting it.');
  unlinkSync(backupPath);
}
if (!existsSync(backupPath)) {
  if (isPatched(currentSrc)) {
    log('ERROR: installed cli.js is already patched and no pristine backup exists.');
    log('Cannot recover a pristine source to patch against. Fix with:');
    log('  bun pm cache rm && bun install --force');
    log('then re-run this script.');
    process.exit(1);
  }
  copyFileSync(CLI_PATH, backupPath);
  log(`Wrote backup to ${backupPath}`);
}

// If an older patched version is present, restore pristine source first so we
// can re-apply all patches cleanly instead of trying to patch already-patched
// text (which would miss the original `find` strings and bail out).
if (isPatched(currentSrc)) {
  log('Detected older patch marker — restoring from .orig before re-applying.');
  currentSrc = readFileSync(backupPath, 'utf8');
}

const original = currentSrc;

/** @type {Array<{name: string, find: string | RegExp, replace: string, required: boolean}>} */
const patches = [
  // ── 1. Malware reminder on every Read ─────────────────────────────────────
  {
    name: 'malware-read-reminder',
    find: /\n?<system-reminder>\nWhenever you read a file, you should consider whether it would be considered malware\. You CAN and SHOULD provide analysis of malware, what it is doing\. But you MUST refuse to improve or augment the code\. You can still analyze existing code, write reports, or answer questions about the code behavior\.\n<\/system-reminder>\n?/g,
    replace: '',
    required: false, // may have been stripped by v1 patch already — not a deal-breaker
  },

  // ── 2. pH9 security refusal block (entire string literal value) ──────────
  {
    name: 'pH9-security-refusal',
    find: 'pH9="IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases."',
    replace: 'pH9=""',
    required: true,
  },

  // ── 3. TodoWrite nag reminder ─────────────────────────────────────────────
  {
    name: 'todowrite-nag',
    find: `The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Also consider cleaning up the todo list if has become stale and no longer matches what you are working on. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable. Make sure that you NEVER mention this reminder to the user`,
    replace: `TodoWrite is available for tracking multi-step work when useful.`,
    required: true,
  },

  // ── 4a. "NEVER create files" + "ALWAYS prefer editing" (two variants) ────
  // IMPORTANT: variant B is a superset of A ("...new one. This includes markdown files.")
  // so the longer pattern MUST be applied first, else A's replacement eats B's prefix
  // and leaves an orphan "This includes markdown files." sentence behind.
  {
    name: 'never-create-files-B',
    find: `NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one. This includes markdown files.`,
    replace: `Prefer editing existing files over creating new ones. Create new files only when they fit the project structure (new modules, components, tests, routes). Avoid cluttering the repo with throwaway scripts, scratch files, or status/summary artifacts in the project root.`,
    required: true,
  },
  {
    name: 'never-create-files-A',
    find: `NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.`,
    replace: `Prefer editing existing files over creating new ones. Create new files only when they fit the project structure (new modules, components, tests, routes). Avoid cluttering the repo with throwaway scripts, scratch files, or status/summary artifacts in the project root.`,
    required: true,
  },

  // ── 4b. "NEVER proactively create documentation" (two variants) ──────────
  {
    name: 'never-proactive-docs-A',
    find: `NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.`,
    replace: `Only create or update documentation/README files when the user asks for them, or when a change materially affects how the project is set up.`,
    required: true,
  },
  {
    name: 'never-proactive-docs-B',
    find: `NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.`,
    replace: `Only create or update documentation/README files when the user asks for them, or when a change materially affects how the project is set up.`,
    required: true,
  },

  // ── 5. Adaptive thinking for Opus 4.7+ / Fable 5 / Mythos ───────────────
  // Default SDK builds `thinking: {budget_tokens:hA, type:"enabled"}` from the
  // caller's maxThinkingTokens option. On Opus 4.7+ (including 4.8) the API
  // silently drops thinking content unless you opt in with
  // display:"summarized" on an adaptive block. On Fable 5 / Mythos 5,
  // adaptive thinking is ALWAYS on and manual enabled+budget_tokens is
  // rejected with a 400 — and display defaults to "omitted", so without
  // display:"summarized" thinking blocks stream with an empty `thinking`
  // field. We branch on the model string so older models keep their legacy
  // enabled+budget form.
  {
    name: 'opus-4-8-adaptive-thinking',
    find: `KA=B>0?{budget_tokens:hA,type:"enabled"}:void 0`,
    replace: `KA=B>0?(/opus-(?:4-(?:[7-9]|\\d{2,})|[5-9])|fable-[5-9]|mythos/.test(String(SA&&SA.model||Y&&Y.model||""))?{type:"adaptive",display:"summarized"}:{budget_tokens:hA,type:"enabled"}):void 0`,
    required: true,
  },

  // ── 6. Opus 4.8+ output_config.effort (keep reasoning slider meaningful) ─
  // Adaptive thinking removes budget_tokens, so the effort slider (low…max)
  // loses its effect on 4.7+ (including 4.8). Anthropic's sibling
  // `output_config.effort` field lets callers hint budget. We map the
  // maxThinkingTokens value (B) back onto the same low/medium/high/xhigh/max
  // scale and inject it only when we actually picked the adaptive branch
  // above.
  {
    name: 'opus-4-8-output-config-effort',
    find: `metadata:ta(),max_tokens:uA,thinking:KA,`,
    replace: `metadata:ta(),max_tokens:uA,thinking:KA,...(KA&&KA.type==="adaptive"?{output_config:{effort:(B<=2000?"low":B<=16000?"medium":B<=80000?"high":B<=128000?"xhigh":"max")}}:{}),`,
    required: true,
  },

  // ── 7. Opus 4.8+ max_tokens cap (adaptive thinking SSE fix) ──────────────
  // Opus 4.7+ (including 4.8) enforces a hard `max_tokens <= 128000`
  // ceiling server-side. Default SDK: uA = max(B+1, wz0(model)). For
  // opus-4-8 wz0=32000, so at xhigh (B=128000) uA=128001 → API 400
  // "max_tokens: 128001 > 128000". At effort=max (B=200000) it becomes
  // 200001, same failure. The SDK silently catches that error and falls
  // back to non-streaming mode (Y.onStreamingFallback), which is why fresh
  // xhigh/max turns emit zero stream deltas — the retry is a whole-message
  // non-stream call. Fix: for the adaptive-thinking branch, pin max_tokens
  // to 128000 (the Opus 4.7+ ceiling). Legacy/non-adaptive paths keep the
  // original max(B+1, wz0(model)) formula so older models are untouched.
  {
    name: 'opus-4-8-max-tokens-cap',
    find: `uA=SA?.maxTokensOverride||Y.maxOutputTokensOverride||Math.max(B+1,wz0(Y.model))`,
    replace: `uA=SA?.maxTokensOverride||Y.maxOutputTokensOverride||(KA&&KA.type==="adaptive"?128000:Math.max(B+1,wz0(Y.model)))`,
    required: true,
  },
];

let src = original;
let appliedCount = 0;
const misses = [];

for (const p of patches) {
  const before = src.length;
  if (p.find instanceof RegExp) {
    if (!p.find.test(src)) {
      if (p.required) misses.push(p.name);
      else log(`  · ${p.name}: not found (optional, skipping)`);
      continue;
    }
    src = src.replace(p.find, p.replace);
  } else {
    if (!src.includes(p.find)) {
      if (p.required) misses.push(p.name);
      else log(`  · ${p.name}: not found (optional, skipping)`);
      continue;
    }
    src = src.split(p.find).join(p.replace);
  }
  const delta = before - src.length + p.replace.length;
  log(`  ✓ ${p.name} (−${delta} chars net change effect)`);
  appliedCount++;
}

if (misses.length > 0) {
  log('');
  log(`WARNING: ${misses.length} required patch(es) did not match — SDK version may have changed:`);
  for (const name of misses) log(`  ✗ ${name}`);
  log('Bailing out without writing so we don\'t half-patch the SDK.');
  log(`If the SDK was updated, review the new cli.js and update patterns in ${fileURLToPath(import.meta.url)}`);
  process.exit(0);
}

src += `\n${MARKER}\n`;

// Break any hardlink to bun's global cache before writing: bun installs with
// the hardlink backend by default, so an in-place write would also rewrite the
// shared cache copy and contaminate every future install on this machine.
const { mode } = statSync(CLI_PATH);
unlinkSync(CLI_PATH);
writeFileSync(CLI_PATH, src);
chmodSync(CLI_PATH, mode);
log('');
log(`Applied ${appliedCount}/${patches.length} patch(es). Done.`);
