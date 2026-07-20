import { describe, expect, it } from 'bun:test';
import { buildGithubContext } from './systemPrompt';

describe('buildGithubContext', () => {
  it('gives every provider Agentic-specific repository and credential recovery guidance', () => {
    const context = buildGithubContext('owner/repository', '/work/session');

    expect(context).toContain('Repository: owner/repository');
    expect(context).toContain('Local path: /work/session');
    expect(context).toContain('/api/github/configure-credentials');
    expect(context).not.toContain('gh auth');
  });
});
