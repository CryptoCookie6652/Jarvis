import type { WorkerEvent } from './events.js';

// The CLI's stdout is JSON-lines, but not purely: it sometimes prints plain-text
// notices (e.g. "Warning: no stdin data received in 3s..."). Non-JSON lines are
// routed to onJunk instead of crashing the run.
export function createLineParser(
  onEvent: (event: WorkerEvent, raw: string) => void,
  onJunk?: (line: string) => void,
) {
  let buffer = '';

  function handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      onEvent(JSON.parse(trimmed) as WorkerEvent, trimmed);
    } catch {
      onJunk?.(trimmed);
    }
  }

  return {
    push(chunk: string) {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handleLine(line);
      }
    },
    flush() {
      handleLine(buffer);
      buffer = '';
    },
  };
}
