/**
 * GitHub API Routes
 * Handles GitHub OAuth, repository selection, and git operations
 */

import * as fs from 'fs';
import * as path from 'path';
import { getAppDataDirectory, getSessionPaths } from '../directoryUtils';
import { writeGitHubCredentialsToEnv, reloadEnvironmentVariables } from '../utils/envWriter';

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
          'User-Agent': 'Agentic'
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

    // Generate OAuth URL with full access scopes
    // The 'repo' scope includes push access to public and private repositories
    const scopes = [
      'repo',           // Full control of private repositories (includes push/pull)
      'user',           // Full access to user profile (includes user:email, user:follow, read:user)
      'delete_repo',    // Delete repositories
      'workflow',       // Update GitHub Action workflows
      'write:packages', // Upload/publish packages
      'read:packages',  // Download packages
      'admin:org',      // Full control of orgs and teams
      'gist',           // Create gists
      'project'         // Full control of projects
    ].join(' ');
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

  // POST /api/github/configure - Configure GitHub OAuth credentials
  if (url.pathname === '/api/github/configure' && req.method === 'POST') {
    try {
      const body = await req.json() as { clientId: string; clientSecret: string };
      const { clientId, clientSecret } = body;

      // Validate inputs
      if (!clientId || !clientSecret) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Client ID and Secret are required'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Validate format - Client ID should be alphanumeric, minimum 20 chars
      if (!/^[A-Za-z0-9]{20,}$/.test(clientId)) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Invalid Client ID format. Expected: alphanumeric, 20+ characters'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Validate format - Client Secret should be 40-character hex string
      if (!/^[a-f0-9]{40}$/.test(clientSecret)) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Invalid Client Secret format. Expected: 40 hexadecimal characters'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Write to .env file
      await writeGitHubCredentialsToEnv(clientId, clientSecret);

      // Reload process.env
      reloadEnvironmentVariables();

      return new Response(JSON.stringify({
        success: true,
        message: 'GitHub OAuth configured successfully'
      }), {
        headers: { 'Content-Type': 'application/json' },
      });

    } catch (error) {
      console.error('Failed to configure GitHub OAuth:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      return new Response(JSON.stringify({
        success: false,
        error: `Configuration failed: ${errorMsg}`
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
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
            'User-Agent': 'Agentic'
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
      const body = await req.json() as { repoUrl: string; targetDir?: string; sessionId?: string };
      const { repoUrl, sessionId } = body;
      let { targetDir } = body;

      // Phase 0.1: Clone into workspace/ subdirectory instead of session root
      // If sessionId is provided, look up the working directory and get workspace path
      let workspaceDir: string | undefined;
      if (!targetDir && sessionId) {
        const { sessionDb } = await import('../database');
        const session = sessionDb.getSession(sessionId);
        if (session) {
          // Session working_directory points to root, we want workspace/
          const paths = getSessionPaths(sessionId);
          workspaceDir = paths.workspace;
          targetDir = session.working_directory; // Keep for compatibility
        }
      } else if (targetDir) {
        // If targetDir is provided directly, assume it's session root and derive workspace
        const sessionIdMatch = path.basename(targetDir).match(/chat-(.+)/);
        if (sessionIdMatch) {
          const paths = getSessionPaths(sessionIdMatch[1]);
          workspaceDir = paths.workspace;
        } else {
          // Not a session directory, use as-is
          workspaceDir = targetDir;
        }
      }

      if (!repoUrl || !workspaceDir) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing repoUrl or targetDir/sessionId'
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

      // Check if workspace directory exists and is not empty
      const dirExists = fs.existsSync(workspaceDir);
      const dirContents = dirExists ? fs.readdirSync(workspaceDir) : [];
      const hasGitFolder = dirContents.includes('.git');

      if (hasGitFolder) {
        // Already a git repo - just pull latest
        console.log(`📂 Workspace already has .git, pulling latest...`);
        const { stdout, stderr } = await execAsync(
          `cd "${workspaceDir}" && git pull`,
          { timeout: 120000 }
        );
        if (stdout) console.log(stdout);
        if (stderr) console.log(stderr);
        console.log('✅ Repository updated');
      } else if (dirExists && dirContents.length > 0) {
        // Directory exists with content but no .git - clear it and clone fresh
        console.log(`📂 Workspace exists with content, clearing and cloning fresh...`);

        // Remove all existing files/folders in the directory
        for (const item of dirContents) {
          const itemPath = `${workspaceDir}/${item}`;
          fs.rmSync(itemPath, { recursive: true, force: true });
        }
        console.log(`🗑️ Cleared ${dirContents.length} items from workspace`);

        // Now clone into the empty directory
        const { stdout, stderr } = await execAsync(
          `git clone "${authenticatedUrl}" "${workspaceDir}"`,
          { timeout: 120000 }
        );
        if (stdout) console.log(stdout);
        if (stderr) console.log(stderr);
        console.log('✅ Repository cloned successfully to workspace/');
      } else {
        // Empty or non-existent directory - clone normally
        console.log(`🔄 Cloning repository to workspace: ${workspaceDir}...`);
        const { stdout, stderr } = await execAsync(
          `git clone "${authenticatedUrl}" "${workspaceDir}"`,
          { timeout: 120000 } // 2 minute timeout
        );
        if (stdout) console.log(stdout);
        if (stderr) console.log(stderr);
        console.log('✅ Repository cloned successfully to workspace/');
      }

      // Configure git credentials for push access (in workspace)
      try {
        await configureGitCredentials(workspaceDir);
      } catch (error) {
        console.warn('Warning: Failed to configure git credentials:', error);
        // Don't fail the whole operation if this fails
      }

      return new Response(JSON.stringify({
        success: true,
        message: 'Repository cloned successfully to workspace/ (with push access configured)',
        path: workspaceDir
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

  // POST /api/github/configure-credentials - Configure git credentials for a repository
  if (url.pathname === '/api/github/configure-credentials' && req.method === 'POST') {
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
      const body = await req.json() as { repoDir?: string; sessionId?: string };
      let { repoDir } = body;
      const { sessionId } = body;

      // If sessionId is provided, look up the working directory
      if (!repoDir && sessionId) {
        const { sessionDb } = await import('../database');
        const session = sessionDb.getSession(sessionId);
        if (session) {
          repoDir = session.working_directory;
        }
      }

      if (!repoDir) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing repoDir or sessionId'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Check if it's a git repository
      if (!fs.existsSync(path.join(repoDir, '.git'))) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Not a git repository'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      await configureGitCredentials(repoDir);

      return new Response(JSON.stringify({
        success: true,
        message: 'Git credentials configured for push access'
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Configure credentials error:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      return new Response(JSON.stringify({
        success: false,
        error: `Failed to configure git credentials: ${errorMsg}`
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
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

/**
 * Configure git credentials for a repository directory
 * This sets up git to use the GitHub OAuth token for push/pull operations
 * Uses Git Credential Manager for persistent, system-level credential storage
 */
export async function configureGitCredentials(repoDir: string): Promise<void> {
  const token = loadToken();
  if (!token) {
    throw new Error('Not connected to GitHub');
  }

  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  try {
    // Check if Git Credential Manager is installed
    let gcmInstalled = false;
    try {
      const { stdout } = await execAsync('git credential-manager --version', { timeout: 5000 });
      if (stdout) {
        gcmInstalled = true;
        console.log('✅ Git Credential Manager detected');
      }
    } catch {
      // GCM not installed, fall back to credential.helper
      console.log('ℹ️  Git Credential Manager not found, using credential.helper store');
    }

    if (gcmInstalled) {
      // Use Git Credential Manager (GCM) for persistent credential storage
      // GCM stores credentials in OS-level secure storage (Windows Credential Manager, macOS Keychain, Linux Secret Service)
      await execAsync(`cd "${repoDir}" && git config --local credential.helper manager`);

      // Also configure credential.helper for fallback
      await execAsync(`cd "${repoDir}" && git config --local credential.https://github.com.helper manager`);
    } else {
      // Fallback: Use credential.helper store with cache
      // Store credentials in ~/.git-credentials (persistent across updates)
      await execAsync(`cd "${repoDir}" && git config --local credential.helper 'store --file ~/.git-credentials'`);

      // Also add a cache layer for performance (credentials cached in memory for 1 hour)
      await execAsync(`cd "${repoDir}" && git config --local credential.helper 'cache --timeout=3600'`);
    }

    // Set the remote URL with embedded token for initial authentication
    const { stdout: remoteUrl } = await execAsync(`cd "${repoDir}" && git remote get-url origin`);
    const cleanUrl = remoteUrl.trim().replace(/https:\/\/(.*@)?github\.com\//, 'https://github.com/');
    const authenticatedUrl = cleanUrl.replace('https://github.com/', `https://x-access-token:${token.access_token}@github.com/`);

    await execAsync(`cd "${repoDir}" && git remote set-url origin "${authenticatedUrl}"`);

    // Manually store credentials in git credential store for persistence
    // This ensures credentials persist even if GCM is not installed
    if (!gcmInstalled) {
      const credentialInput = `protocol=https\nhost=github.com\nusername=x-access-token\npassword=${token.access_token}\n\n`;
      await execAsync(`cd "${repoDir}" && echo "${credentialInput.replace(/\n/g, '\\n')}" | git credential-store --file ~/.git-credentials store`, { timeout: 5000 });
    }

    console.log('✅ Git credentials configured for persistent push access');
  } catch (error) {
    console.error('Failed to configure git credentials:', error);
    throw error;
  }
}
