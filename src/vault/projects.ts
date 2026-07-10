import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { frontmatter, parseFrontmatter } from './notes.js';

function projectsDir(): string {
  return join(config.vaultPath, 'Projects');
}

export interface Project {
  name: string;
  status: string;
}

export function ensureProject(name: string) {
  mkdirSync(projectsDir(), { recursive: true });
  const path = join(projectsDir(), `${name}.md`);
  if (existsSync(path)) return;
  const head = frontmatter({
    type: 'project',
    name,
    status: 'active',
    created: new Date().toISOString(),
  });
  writeFileSync(path, `${head}\n# ${name}\n`, { flag: 'wx' });
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
    projects.push({ name, status });
  }
  return projects;
}
