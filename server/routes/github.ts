/**
 * GitHub API Routes
 * Handles GitHub OAuth, repository selection, and git operations
 */

import * as fs from 'fs';
import * as path from 'path';
import { getAppDataDirectory } from '../directoryUtils';

// GitHub OAuth configuration
// Users should set these in their environment or through the setup wizard
// NOTE: These are functions to read env vars dynamically AFTER .env is loaded by initializeStartup()
function getGitHubClientId(): string {
  return process.env.GITHUB_CLIENT_ID || '';
}

function getGitHubClientSecret(): string {
  return process.env.GITHUB_CLIENT_SECRET || '';
}

function getGitHubRedirectUri(): string {
  return process.env.GITHUB_REDIRECT_URI || 'http://localhost:3001/api/github/callback';
}

interface GitHubTokenData {
  access_token: string;
  token_type: string;
  scope: string;
  refresh_token?: string;
  expires_at?: number;
}

interface GitHubUser {
  login: string;
  id: number;
  avatar_url: string;
  name: string | null;
  email: string | null;
}

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  default_branch: string;
  owner: {
    login: string;
    avatar_url: string;
  };
}

// Token storage path
function getTokenPath(): string {
  const appDataDir = getAppDataDirectory();
  return path.join(appDataDir, 'github-token.json');
}

// Save token to file
function saveToken(tokenData: GitHubTokenData): void {
  const tokenPath = getTokenPath();
  fs.writeFileSync(tokenPath, JSON.stringify(tokenData, null, 2));
  console.log('✅ GitHub token saved');
}

// Load token from file
function loadToken(): GitHubTokenData | null {
  const tokenPath = getTokenPath();
  if (!fs.existsSync(tokenPath)) {
    return null;
  }
  try {
    const data = fs.readFileSync(tokenPath, 'utf-8');
    return JSON.parse(data) as GitHubTokenData;
  } catch {
    return null;
  }
}

// Delete token file
function deleteToken(): void {
  const tokenPath = getTokenPath();
  if (fs.existsSync(tokenPath)) {
    fs.unlinkSync(tokenPath);
    console.log('✅ GitHub token deleted');
  }
}

// Check if GitHub is configured
function isGitHubConfigured(): boolean {
  return !!(getGitHubClientId() && getGitHubClientSecret());
}

/**
 * Handle GitHub-related API routes
 */
export async function handleGitHubRoutes(
  req: Request,
  url: URL
): Promise<Response | undefined> {

  // GET /api/github/status - Check GitHub connection status
  if (url.pathname === '/api/github/status' && req.method === 'GET') {
    const token = loadToken();
    const configured = isGitHubConfigured();

    if (!configured) {
      return new Response(JSON.stringify({
        connected: false,
        configured: false,
        message: 'GitHub OAuth not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.'
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!token) {
      return new Response(JSON.stringify({
        connected: false,
        configured: true,
        message: 'Not connected to GitHub'
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Verify token is still valid by fetching user info
    try {
      const userResponse = await fetch('https://api.github.com/user', {
        headers: {
          'Authorization': `Bearer ${token.access_token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Agent-Mees'
        }
      });

      if (!userResponse.ok) {
        deleteToken();
        return new Response(JSON.stringify({
          connected: false,
          configured: true,
          message: 'Token expired or invalid'
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const user = await userResponse.json() as GitHubUser;

      return new Response(JSON.stringify({
        connected: true,
        configured: true,
        user: {
          login: user.login,
          name: user.name,
          avatar_url: user.avatar_url
        }
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('GitHub API error:', error);
      return new Response(JSON.stringify({
        connected: false,
        configured: true,
        message: 'Failed to verify GitHub connection'
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // GET /api/github/auth - Start OAuth flow
  if (url.pathname === '/api/github/auth' && req.method === 'GET') {
    if (!isGitHubConfigured()) {
      return new Response(JSON.stringify({
        success: false,
        error: 'GitHub OAuth not configured'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Generate OAuth URL with necessary scopes for full repo access
    const scopes = ['repo', 'read:user', 'user:email'].join(' ');
    const state = Math.random().toString(36).substring(7);

    const authUrl = new URL('https://github.com/login/oauth/authorize');
    authUrl.searchParams.set('client_id', getGitHubClientId());
    authUrl.searchParams.set('redirect_uri', getGitHubRedirectUri());
    authUrl.searchParams.set('scope', scopes);
    authUrl.searchParams.set('state', state);

    return new Response(JSON.stringify({
      success: true,
      authUrl: authUrl.toString()
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // GET /api/github/callback - OAuth callback
  if (url.pathname === '/api/github/callback' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      // Redirect to app with error
      return new Response(null, {
        status: 302,
        headers: {
          'Location': `/?github_error=${encodeURIComponent(error)}`
        }
      });
    }

    if (!code) {
      return new Response(null, {
        status: 302,
        headers: {
          'Location': '/?github_error=no_code'
        }
      });
    }

    try {
      // Exchange code for token
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: getGitHubClientId(),
          client_secret: getGitHubClientSecret(),
          code,
          redirect_uri: getGitHubRedirectUri()
        })
      });

      const tokenData = await tokenResponse.json() as GitHubTokenData & { error?: string };

      if (tokenData.error) {
        return new Response(null, {
          status: 302,
          headers: {
            'Location': `/?github_error=${encodeURIComponent(tokenData.error)}`
          }
        });
      }

      // Save token
      saveToken(tokenData);

      // Redirect back to app with success
      return new Response(null, {
        status: 302,
        headers: {
          'Location': '/?github_connected=true'
        }
      });
    } catch (error) {
      console.error('GitHub OAuth error:', error);
      return new Response(null, {
        status: 302,
        headers: {
          'Location': '/?github_error=exchange_failed'
        }
      });
    }
  }

  // POST /api/github/disconnect - Disconnect GitHub
  if (url.pathname === '/api/github/disconnect' && req.method === 'POST') {
    deleteToken();
    return new Response(JSON.stringify({
      success: true,
      message: 'Disconnected from GitHub'
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // GET /api/github/repos - List user's repositories
  if (url.pathname === '/api/github/repos' && req.method === 'GET') {
    const token = loadToken();
    if (!token) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Not connected to GitHub'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const page = url.searchParams.get('page') || '1';
      const perPage = url.searchParams.get('per_page') || '30';
      const sort = url.searchParams.get('sort') || 'updated';

      const reposResponse = await fetch(
        `https://api.github.com/user/repos?page=${page}&per_page=${perPage}&sort=${sort}&affiliation=owner,collaborator,organization_member`,
        {
          headers: {
            'Authorization': `Bearer ${token.access_token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Agent-Mees'
          }
        }
      );

      if (!reposResponse.ok) {
        throw new Error(`GitHub API error: ${reposResponse.status}`);
      }

      const repos = await reposResponse.json() as GitHubRepo[];

      return new Response(JSON.stringify({
        success: true,
        repos: repos.map(repo => ({
          id: repo.id,
          name: repo.name,
          full_name: repo.full_name,
          private: repo.private,
          description: repo.description,
          html_url: repo.html_url,
          clone_url: repo.clone_url,
          default_branch: repo.default_branch,
          owner: {
            login: repo.owner.login,
            avatar_url: repo.owner.avatar_url
          }
        }))
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('GitHub repos error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to fetch repositories'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // POST /api/github/clone - Clone a repository to session directory
  if (url.pathname === '/api/github/clone' && req.method === 'POST') {
    const token = loadToken();
    if (!token) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Not connected to GitHub'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const body = await req.json() as { repoUrl: string; targetDir: string };
      const { repoUrl, targetDir } = body;

      if (!repoUrl || !targetDir) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing repoUrl or targetDir'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Inject token into clone URL for authentication
      const authenticatedUrl = repoUrl.replace(
        'https://github.com/',
        `https://${token.access_token}@github.com/`
      );

      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Clone the repository
      console.log(`🔄 Cloning repository to ${targetDir}...`);
      const { stdout, stderr } = await execAsync(
        `git clone "${authenticatedUrl}" "${targetDir}"`,
        { timeout: 120000 } // 2 minute timeout
      );

      console.log('✅ Repository cloned successfully');
      if (stdout) console.log(stdout);
      if (stderr) console.log(stderr);

      return new Response(JSON.stringify({
        success: true,
        message: 'Repository cloned successfully',
        path: targetDir
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Clone error:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      return new Response(JSON.stringify({
        success: false,
        error: `Failed to clone repository: ${errorMsg}`
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // GET /api/github/token - Get access token (for agent use)
  if (url.pathname === '/api/github/token' && req.method === 'GET') {
    const token = loadToken();
    if (!token) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Not connected to GitHub'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      success: true,
      token: token.access_token
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Route not handled by this module
  return undefined;
}

/**
 * Get GitHub token for use in git operations
 * Returns null if not connected
 */
export function getGitHubToken(): string | null {
  const token = loadToken();
  return token?.access_token || null;
}

/**
 * Check if GitHub is connected
 */
export function isGitHubConnected(): boolean {
  return loadToken() !== null;
}
