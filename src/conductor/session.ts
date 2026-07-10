import { spawn } from 'node:child_process';
import {
  agentCommand,
  conductorIdentities,
  config,
  defaultConductorIdentity,
  serverPort,
  type ConductorIdentityConfig,
} from '../config.js';
import { createLineParser } from '../engine/parser.js';
import { isAssistant, isInit, isResult, type ResultEvent } from '../engine/events.js';
import { killTree } from '../engine/run.js';
import * as store from '../store/db.js';
import * as bus from '../server/bus.js';
import { buildSystemPrompt } from './prompt.js';

const PORT = serverPort();
const MCP_CONFIG = JSON.stringify({
  mcpServers: { jarvis: { type: 'http', url: `http://localhost:${PORT}/mcp` } },
});
const ALLOWED_TOOLS = 'mcp__jarvis,Read,Glob,Grep';
const IDENTITY_KEY = 'conductor_identity';

let busy = false;
const pendingNotices: string[] = [];

function identities(): Record<string, ConductorIdentityConfig> {
  return conductorIdentities();
}

function activeIdentityId(): string {
  const saved = store.getKV(IDENTITY_KEY);
  return saved && identities()[saved] ? saved : defaultConductorIdentity();
}

function activeIdentity(): ConductorIdentityConfig {
  const id = activeIdentityId();
  return resolvedIdentity(id);
}

function modelKey(id: string): string {
  return `conductor_model_${id}`;
}

function modelOptions(identity: ConductorIdentityConfig) {
  return identity.models ?? (identity.model ? [{ id: identity.model, label: identity.model }] : []);
}

function selectedModel(id: string, identity = identities()[id]): string | undefined {
  const saved = store.getKV(modelKey(id));
  if (saved && modelOptions(identity).some((option) => option.id === saved)) return saved;
  return identity.model ?? modelOptions(identity)[0]?.id;
}

function resolvedIdentity(id: string): ConductorIdentityConfig {
  const identity = identities()[id];
  return { ...identity, model: selectedModel(id, identity) };
}

function scopedKey(prefix: string, id: string, identity: ConductorIdentityConfig): string {
  return `${prefix}_${id}_${identity.model ?? 'default'}`;
}

function getSession(id: string, identity = resolvedIdentity(id)): string | null {
  const scoped = store.getKV(scopedKey('conductor_session', id, identity));
  if (scoped != null) return scoped;
  const configured = identities()[id];
  if (identity.model !== configured.model) return null;
  // Fall back to session keys created before model-specific sessions existed.
  return store.getKV(`conductor_session_${id}`) ?? store.getKV(`conductor_session_${identity.provider}`);
}

function setSession(id: string, identity: ConductorIdentityConfig, value: string) {
  store.setKV(scopedKey('conductor_session', id, identity), value);
}

function handoffKey(id: string, identity: ConductorIdentityConfig): string {
  return scopedKey('conductor_handoff', id, identity);
}

function switchContextKey(id: string, identity: ConductorIdentityConfig): string {
  return scopedKey('conductor_switch_context', id, identity);
}

function recentContext(): string {
  return store
    .listConductorMessages(30)
    .filter((message) => message.role !== 'tool')
    .map((message) => `${message.role.toUpperCase()}: ${message.text}`)
    .join('\n')
    .slice(-12_000);
}

function identityPrompt(identity: ConductorIdentityConfig): string {
  const runtimeModel = identity.model
    ? `Your configured runtime model is ${identity.model}. When asked about your model or capabilities, report this exact configured model; do not substitute a generic model family from base instructions.`
    : 'Your runtime model is inherited from the provider configuration. Do not claim a specific model version unless it is present in runtime context.';
  return `${buildSystemPrompt()}\n\nYour active Jarvis identity is ${identity.label}. Remain consistent with that identity. ${runtimeModel}`;
}

export function isBusy(): boolean {
  return busy;
}

export function hasSession(): boolean {
  const id = activeIdentityId();
  return Boolean(getSession(id, activeIdentity()));
}

export function identityState() {
  const active = activeIdentityId();
  const identity = resolvedIdentity(active);
  return {
    active,
    model: identity.model ?? null,
    models: modelOptions(identity),
    busy,
    options: Object.entries(identities()).map(([id, identity]) => ({
      id,
      label: identity.label,
      provider: identity.provider,
      model: selectedModel(id, identity) ?? null,
    })),
  };
}

export function switchIdentity(id: string) {
  if (busy) throw new Error('conductor is busy');
  const next = identities()[id];
  if (!next) throw new Error(`unknown Jarvis identity "${id}"`);
  const previousId = activeIdentityId();
  if (previousId === id) return identityState();

  const nextResolved = resolvedIdentity(id);
  store.setKV(switchContextKey(id, nextResolved), recentContext());
  store.setKV(IDENTITY_KEY, id);

  const notice = `— Jarvis switched to ${next.label} —`;
  store.addConductorMessage('event', notice);
  bus.broadcast({ kind: 'conductor-say', role: 'event', text: notice });
  const state = identityState();
  bus.broadcast({ kind: 'conductor-identity', ...state });
  return state;
}

export function switchModel(model: string) {
  if (busy) throw new Error('conductor is busy');
  const id = activeIdentityId();
  const configured = identities()[id];
  const option = modelOptions(configured).find((candidate) => candidate.id === model);
  if (!option) throw new Error(`unknown model "${model}" for ${configured.label}`);
  if (selectedModel(id, configured) === model) return identityState();

  store.setKV(modelKey(id), model);
  const next = resolvedIdentity(id);
  store.setKV(switchContextKey(id, next), recentContext());
  const notice = `— ${configured.label} switched to ${option.label} —`;
  store.addConductorMessage('event', notice);
  bus.broadcast({ kind: 'conductor-say', role: 'event', text: notice });
  const state = identityState();
  bus.broadcast({ kind: 'conductor-identity', ...state });
  return state;
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
    .map((notice) => `[EVENT] ${notice}`)
    .join('\n');
  try {
    await runTurn(combined, 'event');
  } catch (err) {
    console.error('conductor event turn failed:', err);
  }
}

export async function reset(): Promise<string> {
  if (busy) throw new Error('conductor is busy');
  const id = activeIdentityId();
  const identity = resolvedIdentity(id);
  const sessionId = getSession(id, identity);
  let handoff = '';
  if (sessionId) {
    busy = true;
    bus.broadcast({ kind: 'conductor-status', state: 'thinking' });
    try {
      handoff = await invoke(
        id,
        identity,
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
  setSession(id, identity, '');
  store.setKV(handoffKey(id, identity), handoff);
  const notice = handoff
    ? `— new ${identity.label} conversation started; handoff carried over —`
    : `— new ${identity.label} conversation started —`;
  store.addConductorMessage('event', notice);
  bus.broadcast({ kind: 'conductor-say', role: 'event', text: notice });
  void flushNotices();
  return handoff;
}

async function runTurn(text: string, role: 'user' | 'event'): Promise<string> {
  const id = activeIdentityId();
  const identity = resolvedIdentity(id);
  busy = true;
  store.addConductorMessage(role, text);
  bus.broadcast({ kind: 'conductor-say', role, text });
  bus.broadcast({ kind: 'conductor-status', state: 'thinking' });
  bus.broadcast({ kind: 'conductor-identity', ...identityState(), busy: true });
  try {
    const handoff = store.getKV(handoffKey(id, identity));
    const switchContext = store.getKV(switchContextKey(id, identity));
    const contextBlocks: string[] = [];
    if (handoff && !getSession(id, identity)) {
      contextBlocks.push(`[CONTEXT FROM YOUR PREVIOUS ${identity.label.toUpperCase()} CONVERSATION]\n${handoff}\n[END CONTEXT]`);
    }
    if (switchContext) {
      contextBlocks.push(`[RECENT SHARED JARVIS CONVERSATION]\n${switchContext}\n[END SHARED CONVERSATION]`);
    }
    const effective = [...contextBlocks, text].join('\n\n');
    const reply = await invoke(id, identity, effective);
    if (handoff) store.setKV(handoffKey(id, identity), '');
    if (switchContext) store.setKV(switchContextKey(id, identity), '');
    store.addConductorMessage('assistant', reply);
    bus.broadcast({ kind: 'conductor-say', role: 'assistant', text: reply, trigger: role });
    return reply;
  } finally {
    busy = false;
    bus.broadcast({ kind: 'conductor-status', state: 'idle' });
    bus.broadcast({ kind: 'conductor-identity', ...identityState(), busy: false });
    void flushNotices();
  }
}

function invoke(id: string, identity: ConductorIdentityConfig, prompt: string): Promise<string> {
  return identity.provider === 'codex'
    ? invokeCodex(id, identity, prompt)
    : invokeClaude(id, identity, prompt);
}

function invokeClaude(
  id: string,
  identity: ConductorIdentityConfig,
  prompt: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const command = agentCommand('claude');
    const args = [
      ...command.baseArgs,
      '--append-system-prompt', identityPrompt(identity),
      '--mcp-config', MCP_CONFIG,
      '--strict-mcp-config',
      '--allowedTools', ALLOWED_TOOLS,
    ];
    if (identity.model) args.push('--model', identity.model);
    const sessionId = getSession(id, identity);
    if (sessionId) args.push('--resume', sessionId);

    const child = spawn(command.command, args, {
      cwd: config.vaultPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdin.end(prompt);

    let result: ResultEvent | null = null;
    const stderrChunks: string[] = [];
    const parser = createLineParser((event) => {
      if (isInit(event)) {
        const servers =
          (event as unknown as { mcp_servers?: { name: string; status: string }[] }).mcp_servers ?? [];
        const jarvis = servers.find((server) => server.name === 'jarvis');
        if (!jarvis || jarvis.status !== 'connected') {
          console.warn('conductor: jarvis MCP server not connected:', JSON.stringify(servers));
        }
      }
      if (isAssistant(event)) {
        for (const block of event.message.content) {
          if (block.type === 'tool_use' && 'name' in block) {
            bus.broadcast({ kind: 'conductor-tool', name: block.name, input: block.input });
            store.addConductorMessage(
              'tool',
              `${String(block.name)} ${JSON.stringify(block.input ?? {})}`.slice(0, 400),
            );
          }
        }
      }
      if (isResult(event)) {
        result = event;
        if (event.session_id) setSession(id, identity, event.session_id);
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
        reject(new Error(result?.result || stderrChunks.join('').slice(-400) || `conductor exited ${code}`));
      }
    });
  });
}

function invokeCodex(
  id: string,
  identity: ConductorIdentityConfig,
  prompt: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const command = agentCommand('codex');
    const sessionId = getSession(id, identity);
    const base = [...command.baseArgs];
    const args = sessionId ? [base[0] ?? 'exec', 'resume', ...base.slice(1)] : base;
    if (!sessionId) args.push('--sandbox', 'read-only');
    args.push('-c', `mcp_servers.jarvis.url="http://localhost:${PORT}/mcp"`);
    if (identity.model) args.push('--model', identity.model);
    if (sessionId) args.push(sessionId);
    args.push('-');

    const child = spawn(command.command, args, {
      cwd: config.vaultPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdin.end(`${identityPrompt(identity)}\n\n[CURRENT TURN]\n${prompt}`);

    let reply = '';
    let completed = false;
    let failure = '';
    const stderrChunks: string[] = [];
    const parser = createLineParser((event) => {
      if (event.type === 'thread.started' && 'thread_id' in event) {
        setSession(id, identity, String(event.thread_id));
      }
      if ((event.type === 'item.started' || event.type === 'item.completed') && 'item' in event) {
        const item = event.item as Record<string, unknown>;
        if (event.type === 'item.completed' && item.type === 'agent_message') {
          reply = String(item.text ?? '');
        }
        if (item.type === 'mcp_tool_call') {
          const name = String(item.tool ?? item.name ?? 'mcp_tool');
          const input = item.arguments ?? item.input ?? {};
          bus.broadcast({ kind: 'conductor-tool', name, input });
          if (event.type === 'item.completed') {
            store.addConductorMessage('tool', `${name} ${JSON.stringify(input)}`.slice(0, 400));
          }
        }
      }
      if (event.type === 'turn.completed') completed = true;
      if (event.type === 'turn.failed' || event.type === 'error') {
        failure = JSON.stringify(event).slice(-500);
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
        reject(new Error(failure || stderrChunks.join('').slice(-400) || `conductor exited ${code}`));
      }
    });
  });
}
