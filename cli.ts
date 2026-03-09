#!/usr/bin/env bun
import { startOAuthFlow, exchangeCodeForTokens } from './server/oauth';
import { saveTokens, clearTokens, isLoggedIn, getAnthropicTokens, saveCodexLoginMarker, isCodexLoggedIn, clearCodexTokens } from './server/tokenStorage';
import * as readline from 'readline';
import { execSync } from 'child_process';

const args = process.argv.slice(2);
const command = args[0];

async function handleLogin() {
  console.log('\n🔐 Agentic - Login\n');

  // Provider selection menu
  console.log('Select provider:');
  console.log('  1) Claude (Anthropic subscription)');
  console.log('  2) Codex (ChatGPT subscription)\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const choice = await new Promise<string>((resolve) => {
    rl.question('Choice (1/2): ', resolve);
  });
  rl.close();

  if (choice !== '1' && choice !== '2') {
    console.error('\n❌ Invalid choice. Login cancelled.');
    process.exit(1);
  }

  if (choice === '1') {
    await handleClaudeLogin();
  } else {
    await handleCodexLogin();
  }
}

async function handleClaudeLogin() {
  console.log('\n🔐 Claude OAuth Login\n');

  // Check if already logged in
  const alreadyLoggedIn = await isLoggedIn();
  if (alreadyLoggedIn) {
    const tokens = await getAnthropicTokens();
    const expiresDate = tokens ? new Date(tokens.expiresAt).toLocaleString() : 'Unknown';
    console.log('✅ You are already logged in!');
    console.log(`   Access token expires: ${expiresDate}\n`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const answer = await new Promise<string>((resolve) => {
      rl.question('Do you want to log in again? (y/N): ', resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      console.log('Login cancelled.');
      process.exit(0);
    }

    console.log('');
  }

  try {
    // Start OAuth flow
    const { pkce } = await startOAuthFlow();

    console.log('📋 After authorizing in your browser, you will be redirected to a page.');
    console.log('   Copy the authorization code from the URL or page and paste it here.\n');

    // Wait for user to paste the authorization code
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const code = await new Promise<string>((resolve) => {
      rl.question('Authorization code: ', resolve);
    });
    rl.close();

    if (!code || code.trim() === '') {
      console.error('\n❌ No authorization code provided. Login cancelled.');
      process.exit(1);
    }

    console.log('\n⏳ Exchanging code for tokens...');

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code.trim(), pkce.codeVerifier);

    // Save tokens
    await saveTokens(tokens);

    const expiresDate = new Date(tokens.expiresAt).toLocaleString();
    console.log(`✅ Successfully logged in with Claude!`);
    console.log(`   Access token expires: ${expiresDate}`);
    console.log(`\n💡 Your API key (if set) will be ignored when OAuth is active.`);
    console.log(`   This ensures you use your Claude Pro/Max subscription instead.\n`);

  } catch (error) {
    console.error('\n❌ Login failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function handleCodexLogin() {
  console.log('\n🔐 Codex Login\n');

  // Check if Codex CLI is installed
  let codexInstalled = false;
  try {
    execSync('codex --version', { encoding: 'utf8', stdio: 'pipe' });
    codexInstalled = true;
  } catch {
    codexInstalled = false;
  }

  if (!codexInstalled) {
    console.error('❌ Codex CLI is not installed.');
    console.log('\nTo install Codex CLI, run:');
    console.log('  npm install -g @openai/codex\n');
    console.log('After installation, run this command again.\n');
    process.exit(1);
  }

  try {
    console.log('🔄 Starting Codex login flow...\n');

    // Run codex login with inherited stdio
    const proc = Bun.spawn(['codex', 'login'], {
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'inherit',
    });

    const exitCode = await proc.exited;

    if (exitCode === 0) {
      // Save marker indicating Codex is logged in
      await saveCodexLoginMarker();
      console.log('\n✅ Successfully logged in with Codex!\n');
    } else {
      console.error(`\n❌ Codex login failed with exit code ${exitCode}\n`);
      process.exit(exitCode);
    }

  } catch (error) {
    console.error('\n❌ Codex login failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function handleLogout() {
  console.log('\n👋 Agentic - Logout\n');

  const claudeLoggedIn = await isLoggedIn();
  const codexLoggedIn = await isCodexLoggedIn();

  if (!claudeLoggedIn && !codexLoggedIn) {
    console.log('ℹ️  You are not logged in to any provider.');
    process.exit(0);
  }

  // Provider selection menu
  console.log('Select provider to log out:');
  console.log('  1) Claude');
  console.log('  2) Codex');
  console.log('  3) Both\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const choice = await new Promise<string>((resolve) => {
    rl.question('Choice (1/2/3): ', resolve);
  });

  if (choice !== '1' && choice !== '2' && choice !== '3') {
    rl.close();
    console.error('\n❌ Invalid choice. Logout cancelled.');
    process.exit(1);
  }

  const answer = await new Promise<string>((resolve) => {
    rl.question('\nAre you sure you want to log out? (y/N): ', resolve);
  });
  rl.close();

  if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
    console.log('Logout cancelled.');
    process.exit(0);
  }

  try {
    if (choice === '1' || choice === '3') {
      if (claudeLoggedIn) {
        await clearTokens();
        console.log('\n✅ Logged out from Claude.');
      }
    }

    if (choice === '2' || choice === '3') {
      if (codexLoggedIn) {
        // Run codex logout
        const proc = Bun.spawn(['codex', 'logout'], {
          stdout: 'inherit',
          stderr: 'inherit',
          stdin: 'inherit',
        });
        await proc.exited;
        await clearCodexTokens();
        console.log('\n✅ Logged out from Codex.');
      }
    }

    if (choice === '1') {
      console.log('\n💡 You will now use your API key (if set) for Claude authentication.\n');
    } else if (choice === '3') {
      console.log('\n💡 You will now use your API key (if set) for authentication.\n');
    } else {
      console.log('');
    }

  } catch (error) {
    console.error('\n❌ Logout failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function handleStatus() {
  console.log('\n📊 Agentic - Auth Status\n');

  // Claude status
  const claudeLoggedIn = await isLoggedIn();
  console.log('Claude:');
  if (claudeLoggedIn) {
    const tokens = await getAnthropicTokens();
    if (tokens) {
      const expiresDate = new Date(tokens.expiresAt).toLocaleString();
      const isExpired = Date.now() >= tokens.expiresAt;

      console.log('  ✅ Logged in with OAuth');
      console.log(`  Status: ${isExpired ? '❌ Expired (will auto-refresh)' : '✅ Active'}`);
      console.log(`  Expires: ${expiresDate}`);
    }
  } else {
    console.log('  ❌ Not logged in');
    console.log(`  💡 Run: bun run login → select Claude`);
  }

  console.log('');

  // Codex status
  const codexLoggedIn = await isCodexLoggedIn();
  console.log('Codex:');
  if (codexLoggedIn) {
    console.log('  ✅ Codex CLI authenticated');
  } else {
    console.log('  ❌ Not logged in');
    console.log(`  💡 Run: bun run login → select Codex`);
  }

  console.log('');

  // Show API key fallback info
  if (!claudeLoggedIn) {
    console.log(`💡 Claude authentication method: ${process.env.ANTHROPIC_API_KEY ? 'API Key' : 'Not configured'}\n`);
  }
}

async function handleUpdate() {
  console.log('\n🔄 Agentic - Update\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log('This will download and run the latest installer from GitHub.');
  const answer = await new Promise<string>((resolve) => {
    rl.question('Do you want to continue? (y/N): ', resolve);
  });
  rl.close();

  if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
    console.log('Update cancelled.');
    process.exit(0);
  }

  try {
    console.log('\n⏳ Downloading update script...\n');

    // Use Bun's built-in fetch to download the update script
    // Add cache-busting parameter to ensure we get the latest version
    const cacheBuster = Date.now();
    const response = await fetch(`https://raw.githubusercontent.com/Meesvandenkieboom/agentic/main/update.sh?${cacheBuster}`);

    if (!response.ok) {
      throw new Error(`Failed to download update script: ${response.status} ${response.statusText}`);
    }

    const updateScript = await response.text();

    // Write to a temporary file
    const tmpFile = '/tmp/agentic-update.sh';
    await Bun.write(tmpFile, updateScript);

    console.log('📦 Running update...\n');

    // Execute the update script with bash
    const proc = Bun.spawn(['bash', tmpFile], {
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'inherit',
    });

    const exitCode = await proc.exited;

    // Clean up temp file
    await Bun.$`rm -f ${tmpFile}`;

    if (exitCode === 0) {
      console.log('\n✅ Update completed!');
    } else {
      console.error(`\n❌ Update failed with exit code ${exitCode}`);
      process.exit(exitCode);
    }

  } catch (error) {
    console.error('\n❌ Update failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
🤖 Agentic - CLI

Commands:
  --login        Log in with provider (Claude or Codex)
  --logout       Log out and clear tokens
  --status       Show authentication status for all providers
  --update       Update to the latest version from GitHub
  --help         Show this help message

Examples:
  bun run cli.ts --login    # Select Claude or Codex provider
  bun run cli.ts --logout   # Logout from one or all providers
  bun run cli.ts --status   # Check auth status
  bun run cli.ts --update

Providers:
  Claude         Anthropic subscription (OAuth)
  Codex          ChatGPT subscription (requires @openai/codex CLI)

Note: Use 'agentic' command to launch the app (standalone binary).
`);
}

// Main
async function main() {
  switch (command) {
    case '--login':
    case 'login':
      await handleLogin();
      break;

    case '--logout':
    case 'logout':
      await handleLogout();
      break;

    case '--status':
    case 'status':
      await handleStatus();
      break;

    case '--update':
    case 'update':
      await handleUpdate();
      break;

    case '--help':
    case 'help':
      showHelp();
      break;

    case undefined:
      showHelp();
      break;

    default:
      console.error(`\n❌ Unknown command: ${command}\n`);
      showHelp();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error('\n❌ Error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
