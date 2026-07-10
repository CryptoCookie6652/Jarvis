import type { ServerResponse } from 'node:http';
import type { RunHandle, RunSummary } from '../engine/run.js';
import type { WorkerEvent } from '../engine/events.js';

// Fan-out hub: live RunHandles on one side, SSE clients on the other.
// Also remembers the latest rate-limit info so new clients get it on connect.

const clients = new Set<ServerResponse>();
const active = new Map<string, RunHandle>();
let lastRateLimit: unknown = null;

function send(res: ServerResponse, msg: unknown) {
  res.write(`data: ${JSON.stringify(msg)}\n\n`);
}

export function broadcast(msg: unknown) {
  for (const client of clients) send(client, msg);
}

export function addClient(res: ServerResponse) {
  clients.add(res);
  if (lastRateLimit) send(res, { kind: 'rate-limit', info: lastRateLimit });
  send(res, { kind: 'active-runs', ids: [...active.keys()] });
}

export function removeClient(res: ServerResponse) {
  clients.delete(res);
}

setInterval(() => {
  for (const client of clients) client.write(': ping\n\n');
}, 25_000).unref();

export function track(
  handle: RunHandle,
  meta: { task?: string; project?: string; cwd: string },
) {
  active.set(handle.id, handle);
  broadcast({
    kind: 'run-started',
    run: {
      id: handle.id,
      task: meta.task ?? null,
      project: meta.project ?? null,
      cwd: meta.cwd,
      status: 'running',
      started_at: new Date().toISOString(),
    },
  });

  handle.on('event', (ev: WorkerEvent) => {
    if (ev.type === 'rate_limit_event' && 'rate_limit_info' in ev) {
      lastRateLimit = (ev as Record<string, unknown>).rate_limit_info;
      broadcast({ kind: 'rate-limit', info: lastRateLimit });
    }
  });
  handle.on('digest', (line: string) => {
    broadcast({ kind: 'digest', runId: handle.id, line });
  });
  handle.on('done', (summary: RunSummary) => {
    active.delete(handle.id);
    broadcast({ kind: 'run-done', runId: handle.id, summary });
  });
}

export function cancel(id: string): boolean {
  const handle = active.get(id);
  if (!handle) return false;
  handle.kill();
  return true;
}
