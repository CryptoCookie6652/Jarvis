import { spawn } from 'node:child_process';
import { agentCommand, conductorProvider, config, serverPort } from '../config.js';
import { createLineParser } from '../engine/parser.js';
import { isAssistant, isInit, isResult, type ResultEvent } from '../engine/events.js';
import { killTree } from '../engine/run.js';
import * as store from '../store/db.js';
import * as bus from '../server/bus.js';
import { buildSystemPrompt } from './prompt.js';

// The Conductor: one long conversation, resumed turn by turn via `claude -p
// --resume`. Its cwd is the vault (native Read/Glob/Grep over notes) and its
// only write-capable tools are the jarvis MCP tools — no Edit/Write/Bash.
//
// Turn-taking skeleton for M4: user turns run immediately; [EVENT] notices
// queue while busy and flush — coalesced into one turn — the moment the
// conductor goes idle.

const PORT = serverPort();
const MCP_CONFIG = JSON.stringify({
  mcpServers: { jarvis: { type: 'http', url: `http://localhost:${PORT}/mcp` } },
});
const ALLOWED_TOOLS = 'mcp__jarvis,Read,Glob,Grep';
const PROVIDER = conductorProvider();
const SESSION_KEY = `conductor_session_${PROVIDER}`;

let busy = false;
const pendingNotices: string[] = [];

export function isBusy(): boolean {
  return busy;
}

export function history(limit = 200) {
  return store.listConductorMessages(limit);
}

export async function say(text: string): Promise<string> {
  if (busy) throw new Error('conductor is busy');
  return runTurn(text, 'user');
}

export function notify(notice: string) {
  pendingNotices.push(notice);
  void flushNotices();
}

async function flushNotices() {
  if (busy || pendingNotices.length === 0) return;
  const combined = pendingNotices
    .splice(0)
    .map((n) => `[EVENT] ${n}`)
    .join('\n');
  try {
    await runTurn(combined, 'event');
  } catch (err) {
    console.error('conductor event turn failed:', err);
  }
}

// Retire the current session: ask it for a handoff note, then clear the
// session id so the next turn starts fresh with the handoff injected.
export async function reset(): Promise<string> {
  if (busy) throw new Error('conductor is busy');
  const sessionId = store.getKV(SESSION_KEY);
  let handoff = '';
  if (sessionId) {
    busy = true;
    bus.broadcast({ kind: 'conductor-status', state: 'thinking' });
    try {
      handoff = await invoke(
        'We are rotating to a fresh conversation. Write a concise handoff note for your successor: ' +
          'durable user preferences, open threads, active or pending tasks, and anything mid-flight. ' +
          'Plain prose, no preamble.',
      );
    } catch (err) {
      console.error('handoff turn failed:', err);
    } finally {
      busy = false;
      bus.broadcast({ kind: 'conductor-status', state: 'idle' });
    }
  }
  store.setKV(SESSION_KEY, '');
  store.setKV('conductor_handoff', handoff);
  const notice = handoff
    ? '— new conversation started; handoff carried over —'
    : '— new conversation started —';
  store.addConductorMessage('event', notice);
  bus.broadcast({ kind: 'conductor-say', role: 'event', text: notice });
  void flushNotices();
  return handoff;
}

async function runTurn(text: string, role: 'user' | 'event'): Promise<string> {
  busy = true;
  store.addConductorMessage(role, text);
  bus.broadcast({ kind: 'conductor-say', role, text });
  bus.broadcast({ kind: 'conductor-status', state: 'thinking' });
  try {
    const handoff = store.getKV('conductor_handoff');
    const effective =
      handoff && !store.getKV(SESSION_KEY)
        ? `[CONTEXT FROM YOUR PREVIOUS CONVERSATION]\n${handoff}\n[END CONTEXT]\n\n${text}`
        : text;
    const reply = await invoke(effective);
    if (handoff) store.setKV('conductor_handoff', '');
    store.addConductorMessage('assistant', reply);
    // trigger tells the voice layer whether this reply answers the user or
    // announces an event — announcements get a chime.
    bus.broadcast({ kind: 'conductor-say', role: 'assistant', text: reply, trigger: role });
    return reply;
  } finally {
    busy = false;
    bus.broadcast({ kind: 'conductor-status', state: 'idle' });
    void flushNotices();
  }
}

function invoke(prompt: string): Promise<string> {
  return PROVIDER === 'codex' ? invokeCodex(prompt) : invokeClaude(prompt);
}

function invokeClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const command = agentCommand('claude');
    const args = [
      ...command.baseArgs,
      '--append-system-prompt', buildSystemPrompt(),
      '--mcp-config', MCP_CONFIG,
      '--strict-mcp-config',
      '--allowedTools', ALLOWED_TOOLS,
    ];
    // -p --resume forks a fresh session id each turn, so always chain from the
    // id captured out of the previous turn's result event.
    const sessionId = store.getKV(SESSION_KEY);
    if (sessionId) args.push('--resume', sessionId);

    const child = spawn(command.command, args, {
      cwd: config.vaultPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdin.end(prompt);

    let result: ResultEvent | null = null;
    const stderrChunks: string[] = [];

    const parser = createLineParser((ev) => {
      if (isInit(ev)) {
        const servers =
          (ev as unknown as { mcp_servers?: { name: string; status: string }[] }).mcp_servers ?? [];
        const jarvis = servers.find((s) => s.name === 'jarvis');
        if (!jarvis || jarvis.status !== 'connected') {
          console.warn('conductor: jarvis MCP server not connected:', JSON.stringify(servers));
        }
      }
      if (isAssistant(ev)) {
        for (const block of ev.message.content) {
          if (block.type === 'tool_use' && 'name' in block) {
            bus.broadcast({ kind: 'conductor-tool', name: block.name, input: block.input });
            store.addConductorMessage(
              'tool',
              `${String(block.name)} ${JSON.stringify(block.input ?? {})}`.slice(0, 400),
            );
          }
        }
      }
      if (isResult(ev)) {
        result = ev;
        if (ev.session_id) store.setKV(SESSION_KEY, ev.session_id);
      }
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => parser.push(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk));

    const watchdog = setTimeout(() => killTree(child), 5 * 60_000);

    child.on('close', (code) => {
      clearTimeout(watchdog);
      parser.flush();
      if (result && !result.is_error) {
        resolve(result.result ?? '(no reply)');
      } else {
        reject(
          new Error(
            result?.result || stderrChunks.join('').slice(-400) || `conductor exited ${code}`,
          ),
        );
      }
    });
  });
}

function invokeCodex(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const command = agentCommand('codex');
    const sessionId = store.getKV(SESSION_KEY);
    const base = [...command.baseArgs];
    const args = sessionId
      ? [base[0] ?? 'exec', 'resume', ...base.slice(1)]
      : base;
    // `codex exec resume` retains the original session sandbox and does not
    // accept the fresh-run `--sandbox` option in this command position.
    if (!sessionId) args.push('--sandbox', 'read-only');
    args.push('-c', `mcp_servers.jarvis.url="http://localhost:${PORT}/mcp"`);
    if (sessionId) args.push(sessionId);
    args.push('-');

    const child = spawn(command.command, args, {
      cwd: config.vaultPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdin.end(`${buildSystemPrompt()}\n\n[CURRENT TURN]\n${prompt}`);

    let reply = '';
    let completed = false;
    let failure = '';
    const stderrChunks: string[] = [];

    const parser = createLineParser((ev) => {
      if (ev.type === 'thread.started' && 'thread_id' in ev) {
        store.setKV(SESSION_KEY, String(ev.thread_id));
      }
      if ((ev.type === 'item.started' || ev.type === 'item.completed') && 'item' in ev) {
        const item = ev.item as Record<string, unknown>;
        if (ev.type === 'item.completed' && item.type === 'agent_message') {
          reply = String(item.text ?? '');
        }
        if (item.type === 'mcp_tool_call') {
          const name = String(item.tool ?? item.name ?? 'mcp_tool');
          const input = item.arguments ?? item.input ?? {};
          bus.broadcast({ kind: 'conductor-tool', name, input });
          if (ev.type === 'item.completed') {
            store.addConductorMessage(
              'tool',
              `${name} ${JSON.stringify(input)}`.slice(0, 400),
            );
          }
        }
      }
      if (ev.type === 'turn.completed') completed = true;
      if (ev.type === 'turn.failed' || ev.type === 'error') {
        failure = JSON.stringify(ev).slice(-500);
      }
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => parser.push(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk));

    const watchdog = setTimeout(() => killTree(child), 5 * 60_000);
    child.on('close', (code) => {
      clearTimeout(watchdog);
      parser.flush();
      if (completed) {
        resolve(reply || '(no reply)');
      } else {
        reject(
          new Error(
            failure || stderrChunks.join('').slice(-400) || `conductor exited ${code}`,
          ),
        );
      }
    });
  });
}
