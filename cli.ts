#!/usr/bin/env bun
import { startOAuthFlow, exchangeCodeForTokens } from './server/oauth';
import { saveTokens, clearTokens, isLoggedIn, getAnthropicTokens } from './server/tokenStorage';
import * as readline from 'readline';

const args = process.argv.slice(2);
const command = args[0];

async function handleLogin() {
  console.log('\n🔐 Agent Smith - Claude OAuth Login\n');

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

async function handleLogout() {
  console.log('\n👋 Agent Smith - Claude OAuth Logout\n');

  const loggedIn = await isLoggedIn();
  if (!loggedIn) {
    console.log('ℹ️  You are not logged in.');
    process.exit(0);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question('Are you sure you want to log out? (y/N): ', resolve);
  });
  rl.close();

  if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
    console.log('Logout cancelled.');
    process.exit(0);
  }

  await clearTokens();
  console.log('\n💡 You will now use your API key (if set) for authentication.\n');
}

async function handleStatus() {
  console.log('\n📊 Agent Smith - Auth Status\n');

  const loggedIn = await isLoggedIn();

  if (loggedIn) {
    const tokens = await getAnthropicTokens();
    if (tokens) {
      const expiresDate = new Date(tokens.expiresAt).toLocaleString();
      const isExpired = Date.now() >= tokens.expiresAt;

      console.log('✅ Logged in with Claude OAuth');
      console.log(`   Status: ${isExpired ? '❌ Expired (will auto-refresh)' : '✅ Active'}`);
      console.log(`   Expires: ${expiresDate}`);
      console.log(`\n💡 API key usage: Disabled (using Claude Pro/Max subscription)\n`);
    }
  } else {
    console.log('❌ Not logged in with OAuth');
    console.log(`\n💡 Authentication method: ${process.env.ANTHROPIC_API_KEY ? 'API Key' : 'Not configured'}\n`);
  }
}

async function handleUpdate() {
  console.log('\n🔄 Agent Smith - Update\n');

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
    console.log('\n⏳ Downloading latest installer...\n');

    // Use Bun's built-in fetch to download the installer
    const response = await fetch('https://raw.githubusercontent.com/Meesvandenkieboom/agent-smith/main/install.sh');

    if (!response.ok) {
      throw new Error(`Failed to download installer: ${response.status} ${response.statusText}`);
    }

    const installScript = await response.text();

    // Write to a temporary file
    const tmpFile = '/tmp/agent-smith-update.sh';
    await Bun.write(tmpFile, installScript);

    console.log('📦 Running installer...\n');

    // Execute the installer with bash
    const proc = Bun.spawn(['bash', tmpFile], {
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'inherit',
    });

    const exitCode = await proc.exited;

    // Clean up temp file
    await Bun.$`rm -f ${tmpFile}`;

    if (exitCode === 0) {
      console.log('\n✅ Update completed successfully!');
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
🤖 Agent Smith - CLI

Commands:
  --login        Log in with Claude Pro/Max subscription (OAuth)
  --logout       Log out and clear OAuth tokens
  --status       Show current authentication status
  --update       Update to the latest version from GitHub
  --help         Show this help message

Examples:
  bun run cli.ts --login
  bun run cli.ts --logout
  bun run cli.ts --status
  bun run cli.ts --update

Note: Use 'agent-smith' command to launch the app (standalone binary).
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
