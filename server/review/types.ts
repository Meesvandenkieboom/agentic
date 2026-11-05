import type { ChangedFile, Side } from './diff';
import type { ReviewJobKind, ReviewSettings } from '../../shared/review';

export type Scope = 'change' | 'intent' | 'preexisting';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type ReplyVerdict = 'fixed' | 'partially_fixed' | 'still_present' | 'withdrawn';

/** One of this bot's earlier inline threads on the PR (from GraphQL reviewThreads). */
export interface PriorThread {
  threadId: string;          // GraphQL node id, used to resolve the thread
  rootCommentId: number;     // REST id of the first comment, used to reply
  fingerprint: string | null;
  title: string;
  path: string;
  line: number | null;       // null when outdated
  originalCommit: string;
  resolved: boolean;
  outdated: boolean;
  comments: { author: string; isBot: boolean; body: string; createdAt: string }[];
}

export interface EngineInput {
  worktree: string;          // detached checkout at headSha; origin/<base> and the merge-base are available
  repo: { fullName: string; instructions: string };
  pr: { number: number; title: string; body: string; author: string; baseRef: string; headRef: string; commits: { sha: string; subject: string }[] };
  headSha: string;
  mergeBase: string;
  files: ChangedFile[];      // from GET /pulls/{n}/files; patch is GitHub's authoritative hunk source
  trigger: { kind: ReviewJobKind; focus: string };
  priorThreads: PriorThread[];
  lastReviewedSha: string | null;
  settings: ReviewSettings;
  signal: AbortSignal;
  log: (message: string) => void;
}

export interface Finding {
  scope: Scope;
  priority: Exclude<Priority, 'P3'>;
  title: string;
  body: string;
  path: string;
  startLine: number | null;
  line: number;
  side: Side;
  inline: boolean;           // anchor validated against GitHub hunks; false => goes in the review body with a permalink
  confidence: number;
  fingerprint: string;       // sha1(scope|path|normalized title)[:10]
  guidelineRef: { path: string; startLine: number; endLine: number; kind: 'written' | 'inferred' } | null;
  suggestion: string | null;
}

export interface Reply {
  thread: PriorThread;
  verdict: ReplyVerdict;
  body: string;
  evidence: string | null;   // path:line at HEAD
}

export interface EngineResult {
  summary: string;
  findings: Finding[];       // verified, deduped, capped, ordered by priority
  minorNotes: { path: string; line: number; title: string }[];
  replies: Reply[];          // verified; at most one per thread
  coverage: {
    reviewed: number; total: number;
    skipped: { path: string; reason: string }[];
    truncated: string[];
    guidance: string[];
    guidanceEditedByPr: string[];
    candidates: number; verified: number; unverified: number;
  };
  costUsd: number;
}
