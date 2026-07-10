import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { config, projectRoot } from '../config.js';
import * as store from '../store/db.js';
import { startRun } from '../engine/run.js';
import * as bus from './bus.js';

const PORT = config.server?.port ?? 4747;
const publicDir = join(projectRoot, 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

// Runs left 'running' by a previous server process are unfinishable — say so.
store.markOrphans();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      bus.addClient(res);
      req.on('close', () => bus.removeClient(res));
      return;
    }

    if (url.pathname === '/api/meta' && req.method === 'GET') {
      return json(res, {
        defaultCwd: join(projectRoot, 'data', 'playground'),
        vaultPath: config.vaultPath,
      });
    }

    if (url.pathname === '/api/runs' && req.method === 'GET') {
      return json(res, store.listRuns(50));
    }

    if (url.pathname === '/api/dispatch' && req.method === 'POST') {
      const body = await readBody(req);
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      const cwd = typeof body.cwd === 'string' ? body.cwd.trim() : '';
      if (!prompt || !cwd) return json(res, { error: 'prompt and cwd are required' }, 400);

      const handle = startRun({
        prompt,
        cwd,
        task: typeof body.task === 'string' && body.task ? body.task : undefined,
        project: typeof body.project === 'string' && body.project ? body.project : undefined,
        // Read-only toolset unless the caller explicitly grants more.
        allowedTools: Array.isArray(body.allowedTools) && body.allowedTools.length
          ? (body.allowedTools as string[])
          : ['Read', 'Glob', 'Grep'],
        model: typeof body.model === 'string' && body.model ? body.model : undefined,
      });
      bus.track(handle, {
        task: typeof body.task === 'string' ? body.task : undefined,
        project: typeof body.project === 'string' ? body.project : undefined,
        cwd,
      });
      return json(res, { id: handle.id });
    }

    const cancelMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/cancel$/);
    if (cancelMatch && req.method === 'POST') {
      return json(res, { ok: bus.cancel(cancelMatch[1]) });
    }

    const eventsMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/events$/);
    if (eventsMatch && req.method === 'GET') {
      return json(res, store.getEvents(eventsMatch[1]));
    }

    // Static files, fenced inside public/.
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = normalize(join(publicDir, pathname));
    if (!file.startsWith(publicDir + sep) ) {
      return json(res, { error: 'forbidden' }, 403);
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  } catch (err) {
    json(res, { error: String(err) }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`Jarvis dashboard: http://localhost:${PORT}`);
});
