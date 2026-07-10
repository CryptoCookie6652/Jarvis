import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config, projectRoot } from '../config.js';
import * as store from '../store/db.js';
import * as bus from '../server/bus.js';
import { startRun } from '../engine/run.js';
import * as tasks from '../vault/tasks.js';
import { frontmatter, runNotePath } from '../vault/notes.js';
import { enabledSkills } from '../vault/skills.js';
import { renderBoard } from '../vault/board.js';

// The Conductor's hands. Every tool here lands in this process and reuses the
// same startRun/bus/store paths the dashboard uses — one door for everyone.

const READONLY_TOOLS = ['Read', 'Glob', 'Grep'];
const WRITE_TOOLS = [...READONLY_TOOLS, 'Write', 'Edit'];

function reply(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 1),
      },
    ],
  };
}

function brief(row: Record<string, unknown>) {
  return {
    id: row.id,
    task: row.task,
    status: row.status,
    turns: row.num_turns,
    cost: row.cost_usd,
    started: row.started_at,
    error: row.error,
    result: typeof row.result_text === 'string' ? row.result_text.slice(0, 200) : null,
  };
}

function workerPrompt(task: tasks.TaskNote): string {
  let prompt =
    `You are a worker agent executing the task "${task.title}". Work only in the current directory. ` +
    `Follow the spec exactly — you cannot ask questions. Finish with a concise summary of what you did ` +
    `and anything the user should review.\n\n${task.spec}`;
  const standing = enabledSkills('worker');
  if (standing.length) {
    prompt +=
      '\n\n## Standing instructions\n' +
      standing.map((s) => `### ${s.name}\n${s.body}`).join('\n\n');
  }
  return prompt;
}

export function createMcpServer(): McpServer {
  const mcp = new McpServer({ name: 'jarvis', version: '0.1.0' });

  mcp.registerTool(
    'write_task',
    {
      description:
        'Create a task note in the vault. Call when discussion has produced a concrete, dispatchable task.',
      inputSchema: {
        title: z.string().describe('Short imperative title'),
        spec: z
          .string()
          .describe('Full task spec in markdown: goal, constraints, acceptance criteria'),
        cwd: z.string().describe('Absolute path of the directory the worker will run in'),
        project: z.string().optional().describe('Project name to link, e.g. "jarvis"'),
      },
    },
    async ({ title, spec, cwd, project }) => {
      const { slug, path } = tasks.createTask({ title, spec, cwd, project });
      renderBoard();
      bus.broadcast({ kind: 'task-created', slug, title });
      return reply({ ok: true, task: slug, note: path });
    },
  );

  mcp.registerTool(
    'dispatch_agent',
    {
      description: 'Dispatch a worker agent to execute a task created with write_task.',
      inputSchema: {
        task: z.string().describe('Task slug returned by write_task'),
        allow_writes: z
          .boolean()
          .optional()
          .describe('Grant Write/Edit to the worker. Only with user approval.'),
      },
    },
    async ({ task, allow_writes }) => {
      const note = tasks.readTask(task);
      if (!note) return reply({ ok: false, error: `no task note named "${task}"` });

      if (note.run) {
        const prior = store.getRun(note.run) as { status?: string } | undefined;
        if (prior?.status === 'running' || prior?.status === 'starting') {
          return reply({ ok: false, error: `task is already running as ${note.run}` });
        }
      }

      const cwd = note.cwd ?? join(projectRoot, 'data', 'playground');
      if (!existsSync(cwd)) {
        if (cwd.startsWith(join(projectRoot, 'data'))) mkdirSync(cwd, { recursive: true });
        else return reply({ ok: false, error: `cwd does not exist: ${cwd}` });
      }

      const handle = startRun({
        prompt: workerPrompt(note),
        cwd,
        task,
        project: note.project ?? undefined,
        allowedTools: allow_writes ? WRITE_TOOLS : READONLY_TOOLS,
      });
      bus.track(handle, { task, project: note.project ?? undefined, cwd });
      tasks.updateTask(task, { status: 'dispatched', run: handle.id });
      renderBoard();
      bus.broadcast({ kind: 'task-updated', slug: task });
      return reply({ ok: true, run: handle.id, note: note.path });
    },
  );

  mcp.registerTool(
    'agent_status',
    {
      description: 'Status snapshot of worker runs (most recent first), or one run by id.',
      inputSchema: {
        run: z.string().optional().describe('Run id; omit for the 10 most recent'),
      },
    },
    async ({ run }) => {
      const rows = run ? [store.getRun(run)].filter(Boolean) : store.listRuns(10);
      return reply((rows as Record<string, unknown>[]).map(brief));
    },
  );

  mcp.registerTool(
    'agent_log',
    {
      description: 'Recent activity lines from one run\'s log.',
      inputSchema: {
        run: z.string().describe('Run id'),
        lines: z.number().optional().describe('How many lines from the end (default 30)'),
      },
    },
    async ({ run, lines }) => {
      const path = runNotePath(run);
      if (!existsSync(path)) return reply({ ok: false, error: `no run named "${run}"` });
      const tail = readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-(lines ?? 30))
        .join('\n');
      return reply(tail);
    },
  );

  mcp.registerTool(
    'cancel_agent',
    {
      description: 'Cancel a running worker.',
      inputSchema: { run: z.string().describe('Run id') },
    },
    async ({ run }) => reply({ ok: bus.cancel(run) }),
  );

  mcp.registerTool(
    'remember',
    {
      description:
        'Save a durable fact or preference to long-term memory (Memory/memory.md). ' +
        'Use when the user states something worth keeping across conversations.',
      inputSchema: { fact: z.string().describe('One self-contained sentence') },
    },
    async ({ fact }) => {
      const dir = join(config.vaultPath, 'Memory');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'memory.md');
      if (!existsSync(path)) {
        writeFileSync(path, frontmatter({ type: 'memory' }) + '\n# Memory\n\n', { flag: 'wx' });
      }
      appendFileSync(path, `- ${new Date().toISOString().slice(0, 10)}: ${fact.replace(/\r?\n/g, ' ')}\n`);
      return reply({ ok: true });
    },
  );

  return mcp;
}
