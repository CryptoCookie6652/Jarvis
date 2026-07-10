import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { createLineParser } from './parser.js';
import { isAssistant, isInit, isResult, type ResultEvent, type WorkerEvent } from './events.js';
import * as store from '../store/db.js';
import * as vault from '../vault/notes.js';

export interface RunOptions {
  prompt: string;
  cwd: string;
  task?: string;
  project?: string;
  allowedTools?: string[];
  model?: string;
  worktree?: string; // pass-through; first real use comes in M3
  timeoutMs?: number;
}

export interface RunSummary {
  id: string;
  status: 'done' | 'failed' | 'cancelled' | 'timeout';
  sessionId: string | null;
  durationMs: number | null;
  numTurns: number | null;
  costUsd: number | null;
  resultText: string | null;
  error: string | null;
  notePath: string;
}

export interface RunHandle extends EventEmitter {
  id: string;
  notePath: string;
  done: Promise<RunSummary>;
  kill(): void;
}

function newRunId(): string {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return `run-${stamp}-${randomBytes(2).toString('hex')}`;
}

function clean(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').replace(/`/g, "'").trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

function timestamp(): string {
  return new Date().toLocaleTimeString('en-GB');
}

// child.kill() on Windows fells only the top process; claude spawns its own
// children (shells, subagents), so cancel must take down the whole tree.
function killTree(child: ReturnType<typeof spawn>) {
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
  } else {
    child.kill();
  }
}

// One human-readable digest line per interesting event; null = dashboard/DB only.
function digest(ev: WorkerEvent): string[] {
  if (isInit(ev)) {
    return [`- ${timestamp()} **init** — model \`${ev.model}\`, session \`${ev.session_id}\``];
  }
  if (isAssistant(ev)) {
    const lines: string[] = [];
    for (const block of ev.message.content) {
      if (block.type === 'text' && 'text' in block) {
        lines.push(`- ${timestamp()} said: ${clean(String(block.text), 300)}`);
      } else if (block.type === 'tool_use' && 'name' in block) {
        lines.push(
          `- ${timestamp()} tool **${String(block.name)}**: ${clean(JSON.stringify(block.input ?? {}), 160)}`,
        );
      }
    }
    return lines;
  }
  return [];
}

export function startRun(opts: RunOptions): RunHandle {
  const id = newRunId();
  const emitter = new EventEmitter() as RunHandle;

  store.createRun({
    id,
    task: opts.task ?? null,
    project: opts.project ?? null,
    prompt: opts.prompt,
    cwd: opts.cwd,
  });
  const notePath = vault.createRunNote(id, {
    task: opts.task ?? null,
    project: opts.project ?? null,
    cwd: opts.cwd,
  });

  const args = [...config.worker.baseArgs];
  if (opts.allowedTools?.length) args.push('--allowedTools', opts.allowedTools.join(','));
  if (opts.model) args.push('--model', opts.model);
  if (opts.worktree) args.push('--worktree', opts.worktree);

  // claude resolves to a native .exe, so no shell is needed. The prompt goes in
  // via stdin: no Windows arg-length limit, and closing stdin immediately skips
  // the CLI's 3-second wait for piped input.
  const child = spawn(config.worker.command, args, {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdin.end(opts.prompt);

  let sessionId: string | null = null;
  let resultEvent: ResultEvent | null = null;
  let killedAs: 'cancelled' | 'timeout' | null = null;
  const stderrChunks: string[] = [];

  const parser = createLineParser(
    (ev, raw) => {
      store.insertEvent(id, ev.type, ev.subtype ?? null, raw);
      if (isInit(ev)) {
        sessionId = ev.session_id ?? null;
        store.runStarted(id, sessionId, ev.model);
      }
      if (isResult(ev)) resultEvent = ev;
      for (const line of digest(ev)) {
        vault.appendRunNote(id, line);
        emitter.emit('digest', line);
      }
      emitter.emit('event', ev);
    },
    (junk) => store.insertEvent(id, 'junk', null, JSON.stringify(junk)),
  );

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => parser.push(chunk));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk));

  const timeout = setTimeout(() => {
    killedAs = 'timeout';
    killTree(child);
  }, opts.timeoutMs ?? 15 * 60_000);

  emitter.id = id;
  emitter.notePath = notePath;
  emitter.kill = () => {
    killedAs = 'cancelled';
    killTree(child);
  };

  emitter.done = new Promise<RunSummary>((resolve) => {
    child.on('close', (code) => {
      clearTimeout(timeout);
      parser.flush();

      const stderr = stderrChunks.join('').trim();
      let status: RunSummary['status'];
      let error: string | null = null;

      if (killedAs) {
        status = killedAs;
        error = killedAs === 'timeout' ? 'watchdog timeout' : 'cancelled by user';
      } else if (resultEvent && !resultEvent.is_error) {
        status = 'done';
      } else {
        status = 'failed';
        error =
          (resultEvent?.result ?? '') ||
          stderr.slice(-500) ||
          `process exited with code ${code}`;
      }

      const summary: RunSummary = {
        id,
        status,
        sessionId,
        durationMs: resultEvent?.duration_ms ?? null,
        numTurns: resultEvent?.num_turns ?? null,
        costUsd: resultEvent?.total_cost_usd ?? null,
        resultText: resultEvent?.result ?? null,
        error,
        notePath,
      };

      store.runFinished(id, {
        status,
        durationMs: summary.durationMs,
        numTurns: summary.numTurns,
        costUsd: summary.costUsd,
        inputTokens: resultEvent?.usage?.input_tokens ?? null,
        outputTokens: resultEvent?.usage?.output_tokens ?? null,
        resultText: summary.resultText,
        error,
      });

      vault.appendRunNote(id, '');
      vault.appendRunNote(id, '## Result');
      vault.appendRunNote(id, '');
      vault.appendRunNote(id, `- status: **${status}**${error ? ` — ${clean(error, 300)}` : ''}`);
      if (summary.durationMs != null)
        vault.appendRunNote(id, `- duration: ${(summary.durationMs / 1000).toFixed(1)}s over ${summary.numTurns ?? '?'} turns`);
      if (summary.costUsd != null)
        vault.appendRunNote(id, `- cost estimate: $${summary.costUsd.toFixed(4)}`);
      if (summary.resultText)
        vault.appendRunNote(id, `- said: ${clean(summary.resultText, 500)}`);

      emitter.emit('done', summary);
      resolve(summary);
    });
  });

  return emitter;
}
