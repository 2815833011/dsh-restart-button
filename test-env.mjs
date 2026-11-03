/**
 * Unit checks for the pure parts of restart-helper.mjs.
 *
 * The relaunch step is the part that failed in the field, so it is asserted
 * directly: the environment handed to the application must not carry
 * `ELECTRON_RUN_AS_NODE`, or the executable starts as node with no window.
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { confirmLaunch, isAlive, launchOptions, relaunchEnvironment, sleep } from './restart-helper.mjs';

// --- relaunchEnvironment -----------------------------------------------------

{
  const source = {
    PATH: 'C:\\Windows\\system32',
    DSH_PROFILE: 'desktop',
    DSH_HOME: 'C:\\Users\\28158\\.dsh',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1',
    DSH_DESKTOP_NODE_EXECUTABLE: 'C:\\DSH\\node.exe',
    KEEP_ME: 'yes',
  };
  const env = relaunchEnvironment(source);

  assert.ok(!('ELECTRON_RUN_AS_NODE' in env), 'ELECTRON_RUN_AS_NODE must be stripped');
  assert.ok(!('ELECTRON_NO_ATTACH_CONSOLE' in env), 'ELECTRON_NO_ATTACH_CONSOLE must be stripped');
  assert.ok(!('DSH_DESKTOP_NODE_EXECUTABLE' in env), 'the bundled node pointer must be stripped');

  // Everything else is how the user's own session finds its profile and account.
  assert.strictEqual(env.DSH_PROFILE, 'desktop', 'profile must survive');
  assert.strictEqual(env.DSH_HOME, 'C:\\Users\\28158\\.dsh', 'home must survive');
  assert.strictEqual(env.KEEP_ME, 'yes', 'unrelated variables must survive');
  assert.strictEqual(env.PATH, 'C:\\Windows\\system32', 'PATH must survive');

  // The caller's object is not mutated: the helper's own environment stays usable.
  assert.strictEqual(source.ELECTRON_RUN_AS_NODE, '1', 'input must not be mutated');

  console.log('ok  relaunchEnvironment strips the node switches and keeps the session');
}

// --- launchOptions -----------------------------------------------------------

{
  // The regression this pins: `windowsHide` becomes STARTF_USESHOWWINDOW +
  // SW_HIDE, which makes Win32 ignore the child's first ShowWindow — the call
  // that presents the main window. The process then runs with no visible
  // window, which is reported as "只关窗口、后台还在".
  // The Host always carries the switch, so start from that state.
  const previous = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  const options = launchOptions('C:\\DSH\\DeepSeek Harness.exe');

  assert.ok(!('windowsHide' in options), 'the application must not be started with windowsHide');
  assert.strictEqual(options.detached, true, 'the application must outlive the helper');
  assert.strictEqual(options.stdio, 'ignore', 'the application owns no pipe of the helper');
  assert.ok(!('ELECTRON_RUN_AS_NODE' in options.env), 'the relaunched app must not run as node');
  assert.strictEqual(options.cwd, 'C:\\DSH', 'the app starts from its own directory');

  if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
  else process.env.ELECTRON_RUN_AS_NODE = previous;
  console.log('ok  launchOptions shows the window and does not run as node');
}

// --- isAlive -----------------------------------------------------------------

assert.strictEqual(isAlive(process.pid), true, 'the current process is alive');
assert.strictEqual(isAlive(0), false, 'pid 0 is not a process');
assert.strictEqual(isAlive(-1), false, 'negative pid is not a process');
assert.strictEqual(isAlive(Number.NaN), false, 'NaN is not a process');
assert.strictEqual(isAlive(2147483646), false, 'an unused pid is not alive');
console.log('ok  isAlive rejects invalid ids');

// --- sleep -------------------------------------------------------------------

{
  const started = Date.now();
  await sleep(120);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 110, `sleep(120) waited only ${String(elapsed)}ms`);
  console.log(`ok  sleep waits (${String(elapsed)}ms)`);
}

// --- confirmLaunch -----------------------------------------------------------

{
  // An instance that stays up is confirmed.
  const survivor = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  survivor.unref();
  await sleep(150);
  const confirmedLines = [];
  const alive = await confirmLaunch(survivor.pid, (line) => confirmedLines.push(line));
  assert.strictEqual(alive, true, 'a running instance must be confirmed');
  assert.ok(
    confirmedLines.some((line) => line.startsWith('relaunch confirmed')),
    'the log must record the confirmation',
  );
  process.kill(survivor.pid);

  // An instance that exits during startup is not: this is the Node-mode failure
  // that made the application look closed with no window coming back.
  const doomed = spawn(process.execPath, ['-e', 'process.exit(0)'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  doomed.unref();
  await sleep(150);
  const failedLines = [];
  const survived = await confirmLaunch(doomed.pid, (line) => failedLines.push(line));
  assert.strictEqual(survived, false, 'an instance that exited must not be confirmed');
  assert.ok(
    failedLines.some((line) => line.startsWith('relaunch unconfirmed')),
    'the log must record the failure',
  );
  console.log('ok  confirmLaunch distinguishes a real window from an immediate exit');
}

console.log('\nOK: helper pure functions behave');