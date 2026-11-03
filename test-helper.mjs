/**
 * Offline exercise of restart-helper.mjs with --no-launch.
 *
 * Spawns two throwaway node processes to stand in for the Desktop main process
 * and the Host, runs the helper against them, and checks that both die while the
 * helper itself exits 0. Never touches the real application.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER = fileURLToPath(new URL('./restart-helper.mjs', import.meta.url));

/** A process that just sleeps, standing in for a DSH process. */
function sleeper() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    // `detached` is required: a hidden console child of a console-less parent is
    // killed at startup on Windows (STATUS_DLL_INIT_FAILED, 0xC0000142).
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'helper-test-'));
const logPath = join(dir, 'restart.log');
const fakeExe = process.execPath;

const main = sleeper();
const host = sleeper();
await new Promise((r) => setTimeout(r, 400));

console.log(`fake main=${main.pid} host=${host.pid} alive=${alive(main.pid)}/${alive(host.pid)}`);

const started = Date.now();
const child = spawn(process.execPath, [HELPER, String(main.pid), String(host.pid), fakeExe, logPath, '--no-launch'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});

const code = await new Promise((resolve) => {
  child.once('exit', (exitCode) => resolve(exitCode));
});
const elapsed = Date.now() - started;

// Give the OS a moment to reap the terminated processes.
await new Promise((r) => setTimeout(r, 300));

const mainGone = !alive(main.pid);
const hostGone = !alive(host.pid);
const log = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim() : '<no log>';

console.log(`helper exit=${String(code)} elapsed=${String(elapsed)}ms`);
console.log(`main gone=${String(mainGone)} host gone=${String(hostGone)}`);
console.log('--- helper log ---');
console.log(log);

if (code !== 0) throw new Error(`helper exited ${String(code)}`);
if (!mainGone) throw new Error('fake main process survived the restart');
if (!hostGone) throw new Error('fake host process survived the restart');
if (!log.includes('helper start')) throw new Error('helper never logged its start');
if (!log.includes('no-launch requested')) throw new Error('helper skipped the no-launch branch');

rmSync(dir, { recursive: true, force: true });
console.log('\nOK: helper stopped both stand-in processes and exited cleanly');
