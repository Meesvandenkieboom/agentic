# Agentic UI preview

Run from the repository root:

```sh
bun run mockups/chatgpt-ui/server.ts
```

Open http://localhost:3002 for the production interface with 15 example conversations.

Builds the actual `client/index.tsx` entrypoint and production Tailwind stylesheet, including `client/styles/interface.css`. The preview and application share the same styling; there is no duplicate theme or component tree. Examples cover Markdown, code, checklists, tables, and rendered math.

Session fixtures and WebSocket responses live in memory. Chat switching, search, new messages, pinning, renaming and deletion operate on those fixtures. Restarting the preview resets its data. Provider calls, filesystem operations, GitHub and external integrations are not connected; unsupported actions return an explicit preview error. No production server modules or database are loaded.

The stylesheet export remains outside the repository. Port 3001 is not used.

Validation:

```sh
bunx tsc --noEmit
bunx tsc --noEmit -p mockups/chatgpt-ui/tsconfig.json
bunx eslint .
```
