/** Agentic skill discovery and selection API. */

import { loadUserConfig, updateUserConfig } from '../userConfig';
import {
  discoverUserSkills,
  normalizeSkillPolicy,
  type SkillPolicyMode,
} from '../skills';

export async function handleSkillRoutes(req: Request, url: URL): Promise<Response | undefined> {
  if (url.pathname === '/api/skills' && req.method === 'GET') {
    const skills = await discoverUserSkills();
    const policy = normalizeSkillPolicy(loadUserConfig().skills);
    const enabledPaths = new Set(policy.enabledPaths);

    return Response.json({
      success: true,
      mode: policy.mode,
      skills: skills.map((skill) => ({
        ...skill,
        enabled: policy.mode === 'custom' ? enabledPaths.has(skill.path) : null,
      })),
    });
  }

  if (url.pathname === '/api/skills/config' && req.method === 'POST') {
    const body = await req.json() as { mode?: SkillPolicyMode; enabledPaths?: unknown };
    if (body.mode !== 'inherit' && body.mode !== 'custom') {
      return Response.json({ success: false, error: 'Mode must be inherit or custom' }, { status: 400 });
    }

    let requestedPaths: string[] = [];
    if (body.mode === 'custom') {
      if (!Array.isArray(body.enabledPaths)) {
        return Response.json({ success: false, error: 'enabledPaths must be an array' }, { status: 400 });
      }
      requestedPaths = body.enabledPaths.filter((entry: unknown): entry is string => typeof entry === 'string');
    }
    const availablePaths = new Set((await discoverUserSkills()).map((skill) => skill.path));
    const unknownPath = requestedPaths.find((skillPath) => !availablePaths.has(skillPath));
    if (unknownPath) {
      return Response.json({ success: false, error: 'Selection contains an unknown skill' }, { status: 400 });
    }

    const skills = {
      mode: body.mode,
      enabledPaths: [...new Set(requestedPaths)],
    };
    updateUserConfig({ skills });

    return Response.json({ success: true, skills });
  }

  return undefined;
}
