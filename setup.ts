#!/usr/bin/env bun

/**
 * Agent Smith - User Setup CLI
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { loadUserConfig, saveUserConfig, getUserDisplayName } from './server/userConfig';
import * as readline from 'readline';

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

function colorize(text: string, color: keyof typeof colors): string {
  return `${colors[color]}${text}${colors.reset}`;
}

function printBanner() {
  console.log('');
  console.log(colorize('╔═══════════════════════════════════════╗', 'cyan'));
  console.log(colorize('║     Agent Smith - User Setup         ║', 'cyan'));
  console.log(colorize('╚═══════════════════════════════════════╝', 'cyan'));
  console.log('');
}

function question(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function runSetup() {
  printBanner();

  // Load existing config
  const config = loadUserConfig();

  // Show current configuration if exists
  if (config.firstName || config.lastName || config.name) {
    console.log(colorize('Current configuration:', 'yellow'));
    console.log(colorize(`  Name: ${getUserDisplayName(config)}`, 'blue'));
    console.log('');
  }

  // Ask for name
  console.log(colorize('Let\'s personalize Agent Smith for you!', 'bright'));
  console.log('');

  const nameInput = await question(colorize('What is your name? (first and/or last name): ', 'cyan'));

  if (!nameInput) {
    console.log(colorize('\n❌ Name cannot be empty. Setup cancelled.', 'yellow'));
    process.exit(1);
  }

  // Parse name (simple split on space)
  const nameParts = nameInput.split(/\s+/).filter(Boolean);

  let firstName: string | undefined;
  let lastName: string | undefined;

  if (nameParts.length === 1) {
    // Single name - store as firstName
    firstName = nameParts[0];
  } else if (nameParts.length >= 2) {
    // Multiple parts - first is firstName, rest is lastName
    firstName = nameParts[0];
    lastName = nameParts.slice(1).join(' ');
  }

  // Save configuration
  saveUserConfig({
    firstName,
    lastName,
  });

  console.log('');
  console.log(colorize('✓ Configuration saved successfully!', 'green'));
  console.log('');
  console.log(colorize('Your settings:', 'bright'));
  console.log(colorize(`  Display Name: ${getUserDisplayName({ firstName, lastName })}`, 'blue'));
  console.log('');
  console.log(colorize('You can run this setup again anytime with:', 'yellow'));
  console.log(colorize('  agentic --setup', 'cyan'));
  console.log(colorize('  bun run setup', 'cyan'));
  console.log('');
}

// Run setup if executed directly
if (import.meta.main) {
  runSetup().catch((error) => {
    console.error(colorize('\n❌ Setup failed:', 'yellow'), error);
    process.exit(1);
  });
}
