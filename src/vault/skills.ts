import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { frontmatter, parseFrontmatter } from './notes.js';

// A skill is a user-authored vault note: standing instructions applied to
// every worker prompt (apply: worker) or the conductor's system prompt
// (apply: conductor). The app only ever flips the `enabled` flag.

export interface Skill {
  slug: string;
  name: string;
  description: string;
  apply: 'worker' | 'conductor';
  enabled: boolean;
  body: string;
}

function skillsDir(): string {
  return join(config.vaultPath, 'Skills');
}

export function listSkills(): Skill[] {
  if (!existsSync(skillsDir())) return [];
  const skills: Skill[] = [];
  for (const file of readdirSync(skillsDir())) {
    if (!file.endsWith('.md')) continue;
    const slug = file.slice(0, -3);
    const parsed = parseFrontmatter(readFileSync(join(skillsDir(), file), 'utf8'));
    if (!parsed || parsed.fields.type !== 'skill') continue;
    skills.push({
      slug,
      name: typeof parsed.fields.name === 'string' ? parsed.fields.name : slug,
      description:
        typeof parsed.fields.description === 'string' ? parsed.fields.description : '',
      apply: parsed.fields.apply === 'conductor' ? 'conductor' : 'worker',
      enabled: parsed.fields.enabled !== false,
      body: parsed.body.trim(),
    });
  }
  return skills;
}

export function enabledSkills(scope: 'worker' | 'conductor'): Skill[] {
  return listSkills().filter((s) => s.enabled && s.apply === scope);
}

export function toggleSkill(slug: string): boolean | null {
  const path = join(skillsDir(), `${slug}.md`);
  if (!existsSync(path)) return null;
  const parsed = parseFrontmatter(readFileSync(path, 'utf8'));
  if (!parsed) return null;
  const enabled = !(parsed.fields.enabled !== false);
  writeFileSync(path, frontmatter({ ...parsed.fields, enabled }) + parsed.body);
  return enabled;
}

export function seedSkills() {
  mkdirSync(skillsDir(), { recursive: true });
  const seed = join(skillsDir(), 'worker-quality.md');
  if (existsSync(seed)) return;
  const head = frontmatter({
    type: 'skill',
    name: 'worker-quality',
    description: 'Baseline quality bar appended to every worker prompt',
    apply: 'worker',
    enabled: true,
  });
  writeFileSync(
    seed,
    `${head}
Prefer small, verifiable changes over sweeping ones. Never touch files outside the working directory. End your summary with two short lines: what files you touched, and how the user can verify the result.
`,
    { flag: 'wx' },
  );
}
