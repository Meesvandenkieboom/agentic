export type ReviewJobKind = 'opened' | 'ready' | 'pushed' | 'comment';
export type ReviewJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped';
export interface ReviewSettings { model: string }
export const defaultReviewSettings: ReviewSettings = { model: 'claude-opus-5-5' };
export const reviewModels = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
] as const;

export interface ReviewAppState {
  status: 'none' | 'created' | 'installed';
  app?: { slug: string; name: string; htmlUrl: string; owner: string; ownerType: string };
  installUrl?: string;
  trigger?: string;
  installations: { id: number; account: string; suspended: boolean }[];
  settings: ReviewSettings;
  lastPollAt: number | null;
  lastError: string | null;
  running: number | null;
}

export interface ReviewRepo {
  id: number; fullName: string; private: boolean; enabled: boolean; automatic: boolean; instructions: string;
  lastReview: { pr: number; status: ReviewJobStatus; at: number; url: string } | null;
}

export interface ReviewFindingCounts { P0: number; P1: number; P2: number; P3: number; preexisting: number; fixed: number }

export interface ReviewJob {
  id: number; repo: string; pr: number; prUrl: string; kind: ReviewJobKind; trigger: string; actor: string | null;
  focus: string; headSha: string | null; status: ReviewJobStatus; error: string | null; reviewUrl: string | null;
  findings: ReviewFindingCounts | null; costUsd: number | null; createdAt: number; startedAt: number | null; finishedAt: number | null;
}

export const triggerLabel = (kind: ReviewJobKind, actor: string | null): string =>
  kind === 'opened' ? 'PR opened' : kind === 'ready' ? 'Draft marked ready' : kind === 'pushed' ? 'Push to unreviewed PR' : `Requested by @${actor ?? 'unknown'}`;
