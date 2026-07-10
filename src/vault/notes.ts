import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

// Vault rules (CLAUDE.md): frontmatter must be bulletproof YAML — spaces only,
// every string quoted — because a malformed note silently vanishes from
// Obsidian queries instead of erroring. Run notes are append-only: created
// once with 'wx' (fails rather than overwrites), then only ever appended to.

export type Scalar = string | number | boolean | null;

function yamlScalar(value: Scalar): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function frontmatter(fields: Record<string, Scalar>): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${yamlScalar(value)}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseScalar(raw: string): Scalar {
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw;
    }
  }
  return raw;
}

export function parseFrontmatter(
  text: string,
): { fields: Record<string, Scalar>; body: string } | null {
  const match = text.match(FRONTMATTER_RE);
  if (!match) return null;
  const fields: Record<string, Scalar> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+): (.*)$/);
    if (kv) fields[kv[1]] = parseScalar(kv[2]);
  }
  return { fields, body: text.slice(match[0].length) };
}

export function runNotePath(runId: string): string {
  return join(config.vaultPath, 'Runs', `${runId}.md`);
}

export function createRunNote(
  runId: string,
  meta: { task: string | null; project: string | null; cwd: string },
): string {
  mkdirSync(join(config.vaultPath, 'Runs'), { recursive: true });
  const path = runNotePath(runId);
  const head =
    frontmatter({
      type: 'run-log',
      run: runId,
      task: meta.task,
      project: meta.project ? `[[${meta.project}]]` : null,
      cwd: meta.cwd,
      created: new Date().toISOString(),
    }) + `\n# Run ${runId}\n\n`;
  writeFileSync(path, head, { flag: 'wx' });
  return path;
}

export function appendRunNote(runId: string, line: string) {
  appendFileSync(runNotePath(runId), line + '\n');
}
