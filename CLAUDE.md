# Jarvis — voice-driven Claude Code orchestrator (personal use)

A local app: a conversational "Conductor" (voice in M4) dispatches headless Claude Code
workers and reports on them, live and out loud. TypeScript, Node 24, minimal dependencies.

## Layout
- `src/engine/` — spawn workers (`claude -p --output-format stream-json --verbose --worktree`), parse the JSON-lines event stream
- `src/store/` — SQLite via built-in `node:sqlite` (no native deps) for the raw event firehose
- `src/vault/` — markdown writes into the Obsidian vault (rules below)
- `src/conductor/` — conversation loop + its tools (write_task, dispatch_agent, agent_status/log/cancel, vault search)
- `src/server/` — local HTTP + WebSocket server for the browser UI (M2+)
- The vault lives OUTSIDE this repo: `C:\Users\radkn\desktop\jarvis-vault` (path in `jarvis.config.json`)

## Engine facts (verified by smoke test 2026-07-09, CLI 2.1.206)
- Headless `-p` works on the user's Max subscription (`apiKeySource: "none"`); no API key involved.
- CLOSE STDIN when spawning, or the CLI waits 3s for piped input before starting.
- `--verbose` is required with `-p --output-format stream-json`.
- Event types observed: `system` (subtypes incl. `init`, `hook_started`), `assistant`, `rate_limit_event` (five-hour window status — surface this in the dashboard), `result` (duration_ms, ttft_ms, num_turns, total_cost_usd estimate, session_id, usage).
- Worker startup is ~2.5s once the stdin wait is removed.

## Vault write rules (non-negotiable — sourced from research into real corruption cases)
1. Append-only per-run log files under `Runs/`; never rewrite a note the user may have open (Obsidian is last-writer-wins, silently).
2. One summary note per task, written once at completion.
3. Validate YAML frontmatter before every write: spaces-only indentation, quote any value containing colons/brackets. Malformed YAML makes a note silently vanish from Obsidian dashboards.
4. Never rename or move vault files from code — external renames break Obsidian links.
5. Vault stays out of Obsidian Sync / OneDrive / iCloud.

## Task note frontmatter schema
`type: task | project | run-summary` · `status: todo | dispatched | running | review | done | failed` · `project: "[[name]]"` · `agent`, `worktree`, `created` (ISO date).

## Conductor constraint (the safety invariant)
The Conductor NEVER gets Edit/Write/Bash on repos. It writes prose (task notes in the vault)
and calls dispatch tools. All code changes happen in workers, in isolated worktrees.

## Milestones
M1 engine → M2 dashboard → M3 conductor (text) → M4 voice (barge-in, turn-taking policy) → M5 cockpit.
