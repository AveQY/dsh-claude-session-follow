import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createRunner } from '../runner.mjs';

const root = await mkdtemp(join(process.cwd(), 'test', 'live-'));
const nonce = randomUUID();
await writeFile(join(root, 'input.txt'), nonce);
let selected = { provider: 'magpie', model: 'magpie-2/auto/deepseek-v4.1-flash-1017', reasoningEffort: 'low' };
const switched = { provider: 'magpie', model: 'magpie-2/auto/gpt-6-luna', reasoningEffort: 'low' };
const agent = { id: `claude-follow-test-${randomUUID()}`, session: {}, model: { current: () => selected } };
const processes = new Set();
let changed = false;
const ctx = {
  sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
  workingDirectory: { ensure: async () => root },
  credentials: { resolve: async () => ({ value: process.env.MAGPIE_GATEWAY_KEY }) },
  subprocess: { spawn(spec) {
    const env = { ...process.env };
    for (const [key, value] of Object.entries(spec.env || {})) { if (value === undefined) delete env[key]; else env[key] = value; }
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    processes.add(child);
    let buffer = '';
    child.stdout.on('data', data => {
      buffer += data.toString();
      while (buffer.includes('\n')) {
        const at = buffer.indexOf('\n'); const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'system' && event.subtype === 'init') console.log('Claude initialized');
        if (event.type === 'assistant') for (const block of event.message?.content || []) {
          if (block.type === 'tool_use') {
            console.log(`Native tool: ${block.name}`);
            if (!changed) { selected = switched; changed = true; console.log(`Selection switched to ${selected.model}`); }
          }
        }
        if (event.type === 'system' && event.subtype === 'api_retry') console.log(`Retry status: ${event.status || event.error || 'unknown'}`);
      }
    });
    const terminate = () => { if (child.exitCode === null && child.signalCode === null) child.kill(); };
    const abort = () => terminate();
    spec.signal?.addEventListener('abort', abort, { once: true });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => { processes.delete(child); spec.signal?.removeEventListener('abort', abort); resolve({ exitCode, signal }); });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(spec.stdio.stdin.data);
    if (spec.signal?.aborted) terminate();
    return { stdout: child.stdout, stderr: child.stderr, done, terminate, waitForExit: async () => { await done.catch(() => {}); return true; } };
  } },
};
const runner = createRunner(ctx, { maxRunMs: 210000, requestTimeoutMs: 100000 });
const evidence = { root, models: [], verification: [] };
try {
  const first = await runner.start(agent, 'Use native tools to read input.txt. Then use the Write tool to write the EXACT content from input.txt to output.txt. The content is unknown until you read it. Do not modify other files. Finally reply FILE-OK.').done;
  evidence.first = first;
  console.log(JSON.stringify({ status: first.status, requests: first.requests, tools: first.tools, error: first.error, result: first.result }));
  assert.equal(first.status, 'completed');
  assert.equal((await readFile(join(root, 'output.txt'), 'utf8')).trim(), nonce);
  assert(first.tools.includes('Read') && first.tools.includes('Write'), 'Native Read and Write must run');
  assert(first.requests.some(row => row.model.includes('deepseek')) && first.requests.some(row => row.model.includes('gpt-6-luna')), 'Both selected routes must be observed');
  evidence.verification.push('native-file-tools', 'mid-task-model-switch');
  const second = await runner.start(agent, 'Without tools, recall the exact content you just wrote into output.txt. Reply with just that content.').done;
  evidence.second = second;
  console.log(JSON.stringify({ status: second.status, resumed: second.resumed, result: second.result, error: second.error }));
  assert.equal(second.status, 'completed'); assert.equal(second.resumed, true); assert(second.result.includes(nonce));
  evidence.verification.push('continued-context');
  const third = runner.start(agent, 'Read input.txt and reply with the content.');
  const cancelled = await runner.cancel(agent);
  await third.done;
  assert.equal(cancelled.status, 'cancelled');
  evidence.verification.push('cancellation');
} catch (error) {
  evidence.error = error.stack; process.exitCode = 1;
} finally {
  await runner.dispose();
  evidence.remainingProcesses = processes.size;
  await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ evidence: join(root, 'evidence.json'), verification: evidence.verification, remainingProcesses: processes.size, error: evidence.error }));
}
