# Jarvis repository guidance

Jarvis is a local, voice-driven agent orchestrator. The Conductor holds the conversation and dispatches isolated workers; workers perform repository changes. The app supports both Codex CLI and Claude Code, selected in `jarvis.config.json`.

## Setup and verification

- Requires Node.js 24 or newer because the store uses built-in `node:sqlite`.
- Install the locked dependencies with `npm ci`.
- Run the dashboard with `npm run dev`; it listens on `http://localhost:4747` by default.
- Run `npm run typecheck` after TypeScript changes.
- Run `npm run engine:test` only when an authenticated configured provider is available; it creates a small file in `data/playground` and writes a run log to the external vault.

## Architecture

- `src/engine/`: launches provider CLIs and normalizes their JSONL event streams.
- `src/store/`: SQLite event stream, run history, key/value state, and chat history.
- `src/vault/`: notes, tasks, projects, skills, and generated board files.
- `src/conductor/`: the conversational session, prompt, and Jarvis MCP tools.
- `src/server/`: HTTP API, static UI, server-sent events, and MCP endpoint.
- `public/`: no-build browser UI and voice layer.

## Provider rules

- Keep Codex and Claude behavior compatible. Provider-specific arguments and event shapes must stay behind the engine or conductor boundary.
- Codex workers use `read-only` or `workspace-write` sandboxes. Never use `danger-full-access` or bypass approvals.
- Claude workers use explicit allowed-tool lists. Do not pass Claude-only flags to Codex or Codex-only flags to Claude.
- Namespace resumable Conductor session state by provider so a session ID is never sent to the wrong CLI.
- Keep live Conductor identities, model versions, and supported effort levels configurable. Switching any of them must preserve independent identity-model-effort sessions, carry recent shared context forward, and be rejected while a turn is running.
- Preserve unknown JSONL events in the database and tolerate them without crashing.

## Vault safety invariants

- The vault path comes from `jarvis.config.json` and lives outside this repository.
- Append to per-run logs; never rewrite a note the user may have open.
- Write one summary note per completed task.
- Validate YAML frontmatter. Use spaces for indentation and quote values containing colons or brackets.
- Never rename or move vault files from application code.
- Keep the vault out of synced folders such as OneDrive, iCloud, or Obsidian Sync.

## Conductor safety invariant

The Conductor must not receive general repository write or shell access. Its write-capable actions go through the narrow Jarvis MCP tools. Repository changes belong to workers running in an explicitly selected sandbox.
