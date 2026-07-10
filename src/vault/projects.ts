import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { frontmatter, parseFrontmatter } from './notes.js';

function projectsDir(): string {
  return join(config.vaultPath, 'Projects');
}

export interface Project {
  name: string;
  status: string;
  cwd: string | null;
}

export function ensureProject(name: string, cwd?: string) {
  mkdirSync(projectsDir(), { recursive: true });
  const path = join(projectsDir(), `${name}.md`);
  if (existsSync(path)) return;
  const head = frontmatter({
    type: 'project',
    name,
    status: 'active',
    cwd: cwd ?? null,
    created: new Date().toISOString(),
  });
  writeFileSync(path, `${head}\n# ${name}\n`, { flag: 'wx' });
}

function bodyDirectory(body: string): string | null {
  const match = body.match(/^Working directory: `([^`]+)`\s*$/m);
  return match?.[1] ?? null;
}

export function registerProjectDirectory(name: string, cwd: string): Project {
  ensureProject(name, cwd);
  const path = join(projectsDir(), `${name}.md`);
  const text = readFileSync(path, 'utf8');
  const parsed = parseFrontmatter(text);
  if (!parsed) throw new Error(`project note has invalid frontmatter: ${name}`);
  const existing =
    typeof parsed.fields.cwd === 'string' ? parsed.fields.cwd : bodyDirectory(parsed.body);
  if (!existing) appendFileSync(path, `\nWorking directory: \`${cwd}\`\n`);
  else if (existing !== cwd) {
    throw new Error(`project "${name}" is already linked to ${existing}`);
  }
  return { name, status: String(parsed.fields.status ?? 'active'), cwd: existing ?? cwd };
}

export function listProjects(): Project[] {
  if (!existsSync(projectsDir())) return [];
  const projects: Project[] = [];
  for (const file of readdirSync(projectsDir())) {
    if (!file.endsWith('.md')) continue;
    const parsed = parseFrontmatter(readFileSync(join(projectsDir(), file), 'utf8'));
    const name =
      typeof parsed?.fields.name === 'string' ? parsed.fields.name : file.slice(0, -3);
    const status = typeof parsed?.fields.status === 'string' ? parsed.fields.status : 'active';
    const cwd =
      typeof parsed?.fields.cwd === 'string'
        ? parsed.fields.cwd
        : parsed
          ? bodyDirectory(parsed.body)
          : null;
    projects.push({ name, status, cwd });
  }
  return projects;
}
