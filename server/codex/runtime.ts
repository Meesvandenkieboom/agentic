import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export function getCodexCommand(): string[] {
  // Prefer the runtime installed with Agentic, including in source releases.
  try {
    const pkg = createRequire(import.meta.url).resolve('@openai/codex/package.json');
    return [process.execPath, join(dirname(pkg), 'bin/codex.js')];
  } catch {
    return ['codex'];
  }
}

