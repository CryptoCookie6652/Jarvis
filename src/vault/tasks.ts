import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { frontmatter, parseFrontmatter, type Scalar } from './notes.js';
import { ensureProject } from './projects.js';

// Task notes are the one vault file the app rewrites (status transitions).
// The app is the sole writer of frontmatter; the user owns the body — updates
// re-emit frontmatter and preserve the body byte-for-byte.

export interface TaskNote {
  slug: string;
  title: string;
  status: string;
  project: string | null;
  cwd: string | null;
  run: string | null;
  created: string | null;
  spec: string;
  path: string;
}

function tasksDir(): string {
  return join(config.vaultPath, 'Tasks');
}

export function slugify(title: string): string {
  const base =
    title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'task';
  let slug = base;
  let n = 2;
  while (existsSync(join(tasksDir(), `${slug}.md`))) slug = `${base}-${n++}`;
  return slug;
}

export function createTask(fields: {
  title: string;
  spec: string;
  cwd: string;
  project?: string;
}): { slug: string; path: string } {
  mkdirSync(tasksDir(), { recursive: true });
  if (fields.project) ensureProject(fields.project);
  const slug = slugify(fields.title);
  const path = join(tasksDir(), `${slug}.md`);
  const head = frontmatter({
    type: 'task',
    title: fields.title,
    status: 'todo',
    project: fields.project ? `[[${fields.project}]]` : null,
    cwd: fields.cwd,
    run: null,
    created: new Date().toISOString(),
  });
  writeFileSync(path, `${head}\n# ${fields.title}\n\n## Spec\n\n${fields.spec}\n`, { flag: 'wx' });
  return { slug, path };
}

export function readTask(slug: string): TaskNote | null {
  const path = join(tasksDir(), `${slug}.md`);
  if (!existsSync(path)) return null;
  const parsed = parseFrontmatter(readFileSync(path, 'utf8'));
  if (!parsed) return null;
  const { fields, body } = parsed;
  const project =
    typeof fields.project === 'string' ? fields.project.replace(/^\[\[|\]\]$/g, '') : null;
  return {
    slug,
    title: typeof fields.title === 'string' ? fields.title : slug,
    status: typeof fields.status === 'string' ? fields.status : 'unknown',
    project,
    cwd: typeof fields.cwd === 'string' ? fields.cwd : null,
    run: typeof fields.run === 'string' ? fields.run : null,
    created: typeof fields.created === 'string' ? fields.created : null,
    spec: body,
    path,
  };
}

export function updateTask(slug: string, patch: Record<string, Scalar>): boolean {
  const path = join(tasksDir(), `${slug}.md`);
  if (!existsSync(path)) return false;
  const parsed = parseFrontmatter(readFileSync(path, 'utf8'));
  if (!parsed) return false;
  writeFileSync(path, frontmatter({ ...parsed.fields, ...patch }) + parsed.body);
  return true;
}

export function listTasks(project?: string): TaskNote[] {
  if (!existsSync(tasksDir())) return [];
  const notes: TaskNote[] = [];
  for (const file of readdirSync(tasksDir())) {
    if (!file.endsWith('.md')) continue;
    const note = readTask(file.slice(0, -3));
    if (note && (!project || note.project === project)) notes.push(note);
  }
  return notes;
}
