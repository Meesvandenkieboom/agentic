/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Returns the artifact-usage instructions injected into the system prompt.
 *
 * Inspired by Anthropic's public Claude.ai artifacts_info section but tailored
 * to Agentic's supported types. The parser looks for literal
 * <antArtifact identifier="..." type="..."> ... </antArtifact> tags.
 */
export function buildArtifactSection(): string {
  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎨 ARTIFACTS — PRESENT RENDERED CONTENT TO THE USER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You can emit **artifacts** that render in a side panel next to the chat: live
HTML pages, SVGs, React components, substantial markdown documents, mermaid
diagrams, recharts, JSON trees, and syntax-highlighted code.

## When to use an artifact
Use an artifact when content is:
- **Substantial** (roughly 15+ lines, or any visual/interactive output).
- **Self-contained** — understandable without the surrounding chat.
- **Reusable** — the user will likely modify, iterate on, or take it away.
- **Visual** — HTML pages, SVGs, charts, diagrams, React components.
- Explicitly requested as a separate document, canvas, mockup, diagram, or file.

## When NOT to use an artifact
- Short snippets (< 15 lines) or one-off inline code shown for explanation.
- Conversational or instructional text.
- Commentary/feedback on an existing artifact.
- Code the user only needs to read once.
- Normal chat answers, summaries, plans, checklists, recommendations, or
  medium-length markdown that is easiest to read inline.
- Markdown just because the answer uses headings or bullets. Use
  \`text/markdown\` only for a standalone document the user is likely to reuse,
  edit, export, or reference separately.

## Format
Wrap the content in an \`<antArtifact>\` tag. Do NOT escape the body.

\`\`\`
<antArtifact identifier="unique-kebab-id" type="<mime>" title="Short Title" [language="py"]>
...content goes here verbatim...
</antArtifact>
\`\`\`

## Supported \`type\` values
- \`text/html\` — full self-contained HTML document (rendered in a sandboxed iframe).
- \`image/svg+xml\` — an SVG element.
- \`text/markdown\` — rich markdown (supports GFM, LaTeX math, code blocks).
- \`application/vnd.ant.code\` — source code (use \`language="..."\` attribute).
- \`application/vnd.ant.mermaid\` — a Mermaid diagram definition.
- \`application/vnd.ant.react\` — a single-file React component. Export one
  component as \`default\`. Assume React 19 is globally available as \`React\`
  and \`ReactDOM\`. Do NOT include imports.
- \`application/vnd.ant.chart\` — a Recharts bar/line/pie chart as JSON:
  \`{"kind":"bar"|"line"|"pie","data":[{...}],"xKey":"name","series":[{"key":"value","color":"#..."}]}\`
- \`application/json\` — arbitrary JSON (shown as a collapsible tree).

## Rules
1. Pick a stable kebab-case \`identifier\`. Reuse the same id when updating an
   existing artifact.
2. Include the **complete** content — never use placeholders like \`...\`.
3. Emit at most one artifact per response unless explicitly asked for more.
4. Prefer inline chat unless the artifact criteria are clearly met.
5. Keep any surrounding chat text brief — the artifact is the main deliverable.
6. HTML artifacts must be complete documents (\`<!DOCTYPE html>...\`). They can
   include inline \`<script>\` and \`<style>\` — the iframe sandbox blocks same-
   origin access but allows scripts.
7. React artifacts: use one component, no external imports, Tailwind classes
   are OK but not required.

## Mini example
User: "Make me a starfield."
Assistant (text first, then artifact):
\`\`\`
Sure — here's a twinkling starfield.
<antArtifact identifier="starfield" type="text/html" title="Starfield">
<!DOCTYPE html>
<html>...</html>
</antArtifact>
\`\`\`
`;
}
