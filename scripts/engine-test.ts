import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from '../src/config.js';
import { startRun } from '../src/engine/run.js';

const playground = join(projectRoot, 'data', 'playground');
mkdirSync(playground, { recursive: true });

console.log('Dispatching worker into', playground, '\n');

const run = startRun({
  prompt:
    'Create a file named hello.md containing a short haiku about orchestration. ' +
    'Then read it back and reply with the haiku only.',
  cwd: playground,
  task: 'engine-smoke',
  project: 'jarvis',
  allowedTools: ['Write', 'Read'],
  timeoutMs: 3 * 60_000,
});

console.log(`Run ${run.id}`);
console.log(`Vault note: ${run.notePath}\n`);

run.on('digest', (line: string) => console.log(line));

const summary = await run.done;

console.log('\n=== RUN COMPLETE ===');
console.log(`status:   ${summary.status}`);
console.log(`turns:    ${summary.numTurns}`);
console.log(`duration: ${summary.durationMs != null ? (summary.durationMs / 1000).toFixed(1) + 's' : '?'}`);
console.log(`cost est: ${summary.costUsd != null ? '$' + summary.costUsd.toFixed(4) : '?'}`);
if (summary.error) console.log(`error:    ${summary.error}`);
console.log(`\nresult:\n${summary.resultText ?? '(none)'}`);
