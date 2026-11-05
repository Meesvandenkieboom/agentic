// MEMBER/COLLABORATOR include read-only org members and outside collaborators; they go through the permission API.
const TRUSTED_ASSOCIATIONS = new Set(['OWNER']);

export const triggerPhrase = (slug: string) => `@${slug} review`;

/** Finds `@<slug> review [focus]` outside code and quotes; returns the focus text (possibly empty). */
export function parseTrigger(body: string, slug: string): string | null {
  const visible = body
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '')
    .split('\n').filter(line => !line.trimStart().startsWith('>')).join('\n');
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = visible.match(new RegExp(`(?:^|[^\\w@/-])@${escaped}(?:\\[bot\\])?\\s+review\\b[:,]?[ \\t]*(.*)$`, 'im'));
  return match ? match[1].trim().slice(0, 500) : null;
}

export interface Author { login: string; type?: string }

/** Cheap check from the payload; callers fall back to the collaborator-permission API when this says no. */
export function trustedByAssociation(association: string | undefined, user: Author | null, slug: string): boolean {
  if (!user || user.type === 'Bot' || user.login === `${slug}[bot]`) return false;
  return TRUSTED_ASSOCIATIONS.has(association ?? '');
}

export const isBot = (user: Author | null, slug: string) => !user || user.type === 'Bot' || user.login === `${slug}[bot]`;
