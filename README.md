# Jarvis

Jarvis is a local voice-driven dashboard that talks to a long-running Conductor and dispatches coding workers. It supports both Codex CLI and Claude Code; Codex is currently the default.

## Start

Requirements: Node.js 24+, an authenticated Codex CLI and/or Claude Code installation, and the external vault configured in `jarvis.config.json`.

```powershell
npm ci
npm run typecheck
npm run dev
```

Open `http://localhost:4747`. The manual dispatch form includes an agent-provider selector.

If that port is already in use, set `JARVIS_PORT` before starting (for example, `$env:JARVIS_PORT=4748`).

## Choose worker providers

`jarvis.config.json` contains both provider commands:

- `worker.defaultProvider` controls new workers unless the dashboard request chooses another provider.

Set `worker.defaultProvider` to `"codex"` or `"claude"`, then restart Jarvis. The conversational Conductor is selected live through the identity switch below.

Codex workers map Jarvis's write permission to Codex sandboxes:

- Writes off: `read-only`
- Writes on: `workspace-write`

Claude workers retain the original allowed-tool behavior.

## Live Jarvis identity switch

The Conductor header has a live two-way identity switch:

- **Fable / Opus** uses Claude Code with the Opus model.
- **Sol** uses Codex with its configured default model.

Each identity keeps an independent resumable session. When you switch, Jarvis carries recent shared conversation into the newly active identity, so you can continue without restarting the server or repeating context. The active identity persists across restarts.

## Important paths

- Application configuration: `jarvis.config.json`
- Codex repository instructions: `AGENTS.md`
- Claude repository instructions and project history: `CLAUDE.md`
- Local run database: `data/jarvis.db` (ignored by Git)
- External vault: configured by `vaultPath` and intentionally outside synced storage

The original recovered copy remains at `C:\Users\radkn\Desktop\jarvis` as a safety backup.
