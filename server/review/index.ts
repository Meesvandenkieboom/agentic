import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getAppDataDirectory } from '../directoryUtils';
import { runReview } from './engine';
import { ReviewService } from './service';
import { ReviewStore } from './store';

let service: ReviewService | undefined;
export function getReviewService(): ReviewService {
  if (!service) {
    const directory = join(getAppDataDirectory(), 'review');
    // Holds the GitHub App private key (also in the -wal file) and private repo checkouts.
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const file = join(directory, 'review.db');
    const db = new Database(file, { create: true });
    chmodSync(file, 0o600);
    service = new ReviewService(new ReviewStore(db), directory, runReview);
  }
  return service;
}
export function startAgenticReview(): void {
  try { void getReviewService().start(); }
  catch (error) { console.warn('Agentic Review could not start:', error instanceof Error ? error.message : error); }
}
export function stopAgenticReview(): void { service?.stop(); }

const GIT_PUSH = /\bgit\b[^\n;&|]*\bpush\b|\bgh\s+pr\s+(?:create|ready)\b/;
/** Called for every shell command a chat agent runs (Claude or Codex). */
export function noteAgentCommand(command: unknown): void {
  if (service && typeof command === 'string' && GIT_PUSH.test(command)) service.pollSoon();
}
