export interface Hunk { oldStart: number; oldEnd: number; newStart: number; newEnd: number }
export interface ChangedFile { filename: string; status: string; additions: number; deletions: number; patch?: string; previous_filename?: string }
export type Side = 'LEFT' | 'RIGHT';

export function parseHunks(patch: string | undefined): Hunk[] {
  if (!patch) return [];
  const hunks: Hunk[] = [];
  for (const m of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldStart = Number(m[1]), oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]), newCount = m[4] === undefined ? 1 : Number(m[4]);
    hunks.push({ oldStart, oldEnd: oldStart + oldCount - 1, newStart, newEnd: newStart + newCount - 1 });
  }
  return hunks;
}

/** GitHub only accepts inline comments whose whole range sits inside one hunk on the chosen side. */
export function isCommentable(hunks: Hunk[], side: Side, start: number, end: number): boolean {
  if (start > end) return false;
  return hunks.some(h => side === 'RIGHT'
    ? start >= h.newStart && end <= h.newEnd
    : start >= h.oldStart && end <= h.oldEnd);
}

/** Prefixes each patch line with its line number on the side it belongs to, so the model can cite lines exactly. */
export function numberPatch(patch: string): string {
  let oldLine = 0, newLine = 0;
  const out: string[] = [];
  for (const line of patch.split('\n')) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) { oldLine = Number(header[1]); newLine = Number(header[2]); out.push(line); continue; }
    if (line.startsWith('-')) out.push(`L${String(oldLine++).padStart(5)}       ${line}`);
    else if (line.startsWith('+')) out.push(`      R${String(newLine++).padStart(5)} ${line}`);
    else if (line.startsWith('\\')) out.push(`             ${line}`);
    else { out.push(`L${String(oldLine++).padStart(5)} R${String(newLine++).padStart(5)} ${line}`); }
  }
  return out.join('\n');
}
