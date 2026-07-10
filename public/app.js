const runs = new Map(); // id -> row {id, task, status, started_at, duration_ms, cost_usd, num_turns, lastLine, ...}

const cardsEl = document.getElementById('cards');
const feedEl = document.getElementById('feed');
const gaugeEl = document.getElementById('gauge');
const form = document.getElementById('dispatch-form');
const dispatchStatus = document.getElementById('dispatch-status');
const chatEl = document.getElementById('chat');
const chatForm = document.getElementById('chat-form');
const chatInput = chatForm.querySelector('textarea');
const chatButton = chatForm.querySelector('button');

function esc(text) {
  const div = document.createElement('div');
  div.textContent = String(text ?? '');
  return div.innerHTML;
}

function elapsedLabel(run) {
  if (run.duration_ms != null) return (run.duration_ms / 1000).toFixed(1) + 's';
  if (run.status === 'running' || run.status === 'starting') {
    const ms = Date.now() - new Date(run.started_at).getTime();
    return Math.max(0, Math.floor(ms / 1000)) + 's';
  }
  return '—';
}

function renderCards() {
  const order = { running: 0, starting: 0 };
  const sorted = [...runs.values()].sort((a, b) => {
    const oa = order[a.status] ?? 1;
    const ob = order[b.status] ?? 1;
    if (oa !== ob) return oa - ob;
    return String(b.started_at).localeCompare(String(a.started_at));
  });

  cardsEl.innerHTML = sorted
    .map((run) => {
      const live = run.status === 'running' || run.status === 'starting';
      return `
      <div class="card status-${esc(run.status)}${live ? ' live' : ''}" data-id="${esc(run.id)}">
        <div class="card-top">
          <span class="task">${esc(run.task || run.id)}</span>
          <span class="badge">${esc(run.status)}</span>
        </div>
        <div class="activity">${esc(run.lastLine || run.result_text || '')}</div>
        <div class="card-stats">
          <span class="elapsed">${elapsedLabel(run)}</span>
          <span>${run.num_turns != null ? run.num_turns + ' turns' : ''}</span>
          <span>${run.cost_usd != null ? '$' + Number(run.cost_usd).toFixed(3) : ''}</span>
          ${live ? `<button class="cancel" data-id="${esc(run.id)}">cancel</button>` : ''}
        </div>
      </div>`;
    })
    .join('');
}

function addFeedLine(runId, line) {
  const run = runs.get(runId);
  const tag = run?.task || runId;
  const el = document.createElement('div');
  el.className = 'feed-line';
  el.innerHTML = `<span class="feed-tag">${esc(tag)}</span> ${esc(line)}`;
  feedEl.prepend(el);
  while (feedEl.childElementCount > 200) feedEl.lastElementChild.remove();
}

cardsEl.addEventListener('click', async (event) => {
  const btn = event.target.closest('button.cancel');
  if (!btn) return;
  btn.disabled = true;
  await fetch(`/api/runs/${btn.dataset.id}/cancel`, { method: 'POST' });
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const allowWrite = data.get('allowWrite') === 'on';
  dispatchStatus.textContent = 'dispatching…';
  const res = await fetch('/api/dispatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      task: data.get('task') || undefined,
      cwd: data.get('cwd'),
      prompt: data.get('prompt'),
      allowedTools: allowWrite ? ['Read', 'Glob', 'Grep', 'Write', 'Edit'] : undefined,
    }),
  });
  const out = await res.json();
  dispatchStatus.textContent = out.id ? `dispatched ${out.id}` : `error: ${out.error}`;
  if (out.id) form.querySelector('textarea').value = '';
});

function renderGauge(info) {
  if (!info) return;
  const resets = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : '?';
  gaugeEl.textContent = `rate limit: ${info.status ?? '?'} · ${info.rateLimitType ?? ''} window resets ${resets}`;
}

async function init() {
  const meta = await fetch('/api/meta').then((r) => r.json());
  form.querySelector('[name=cwd]').value = meta.defaultCwd;

  const history = await fetch('/api/runs').then((r) => r.json());
  for (const row of history) runs.set(row.id, row);
  renderCards();

  const chat = await fetch('/api/conductor/history').then((r) => r.json());
  for (const row of chat) {
    addChatMessage(row.role === 'event' ? 'system' : row.role, row.text);
  }

  const source = new EventSource('/events');
  source.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.kind === 'run-started') {
      runs.set(msg.run.id, msg.run);
      renderCards();
    } else if (msg.kind === 'digest') {
      const run = runs.get(msg.runId);
      if (run) run.lastLine = msg.line;
      addFeedLine(msg.runId, msg.line);
      renderCards();
    } else if (msg.kind === 'run-done') {
      const run = runs.get(msg.runId) ?? { id: msg.runId };
      Object.assign(run, {
        status: msg.summary.status,
        duration_ms: msg.summary.durationMs,
        num_turns: msg.summary.numTurns,
        cost_usd: msg.summary.costUsd,
        result_text: msg.summary.resultText,
        lastLine: msg.summary.resultText || run.lastLine,
      });
      runs.set(msg.runId, run);
      renderCards();
    } else if (msg.kind === 'rate-limit') {
      renderGauge(msg.info);
    } else if (msg.kind === 'conductor-say') {
      addChatMessage(msg.role === 'event' ? 'system' : msg.role, msg.text);
    } else if (msg.kind === 'conductor-tool') {
      addChatMessage('tool', `⚙ ${msg.name} ${JSON.stringify(msg.input ?? {}).slice(0, 140)}`);
    } else if (msg.kind === 'conductor-status') {
      setThinking(msg.state === 'thinking');
    }
  };
}

setInterval(() => {
  for (const el of cardsEl.querySelectorAll('.card.live .elapsed')) {
    const run = runs.get(el.closest('.card').dataset.id);
    if (run) el.textContent = elapsedLabel(run);
  }
}, 1000);

function addChatMessage(role, text) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.textContent = text;
  chatEl.append(el);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function setThinking(on) {
  chatButton.disabled = on;
  chatButton.textContent = on ? '…' : 'Send';
}

async function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  setThinking(true);
  const res = await fetch('/api/conductor/say', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const out = await res.json().catch(() => ({}));
    addChatMessage('system', `error: ${out.error ?? res.status}`);
    setThinking(false);
  }
  // The reply itself arrives over SSE; conductor-status idle re-enables Send.
}

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  sendChat();
});
chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendChat();
  }
});

init();
