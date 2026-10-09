import { configureProvider } from './providers';
import { getAnthropicTokens } from './tokenStorage';
import { isTokenExpired } from './oauth';
import { sessionStreamManager } from './sessionStreamManager';

// A chat's CLI keeps the OAuth token it was spawned with. Turns the CLI starts on
// its own (background task and Monitor notifications) never pass configureProvider,
// so without this they fail with "OAuth access token has expired". Settings env
// updates the running CLI's token; it re-reads it on the next request or 401.
let pushedToken: string | null = null;
let syncing = false;

export async function syncOAuthToken(): Promise<void> {
  const queries = sessionStreamManager.getQueries();
  if (syncing || queries.length === 0) return;
  syncing = true;
  try {
    let tokens = await getAnthropicTokens();
    if (tokens && isTokenExpired(tokens.expiresAt)) {
      await configureProvider('anthropic');
      tokens = await getAnthropicTokens();
    }
    if (!tokens || isTokenExpired(tokens.expiresAt) || tokens.accessToken === pushedToken) return;
    const env = { CLAUDE_CODE_OAUTH_TOKEN: tokens.accessToken };
    await Promise.allSettled(queries.map(q => q.applyFlagSettings({ env })));
    pushedToken = tokens.accessToken;
  } catch (error) {
    console.error('❌ OAuth token sync failed:', error);
  } finally {
    syncing = false;
  }
}

export function startOAuthTokenSync(): void {
  // isTokenExpired has a 5 minute margin, so a 1 minute tick refreshes before expiry.
  setInterval(() => void syncOAuthToken(), 60_000).unref();
}
