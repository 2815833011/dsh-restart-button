/**
 * Detached relaunch helper for dsh-restart-button.
 *
 * The Host half starts this file with `process.execPath` in Node mode
 * (`ELECTRON_RUN_AS_NODE=1`), detached, so it outlives the processes it stops.
 *
 * Three rules make the relaunch actually work; all are learned from failures,
 * two of them from the batch helper this replaces:
 *
 * 1. It must NOT pass `ELECTRON_RUN_AS_NODE` to the application. The Host is
 *    itself an `ELECTRON_RUN_AS_NODE` child of the Desktop main process
 *    (`main.js:3650-3658`), so every child it spawns inherits that variable.
 *    Handed to the application executable, it starts as `node`, prints a version
 *    and exits with no window — the application appeared to close and never
 *    come back.
 *
 * 2. It must not spawn console programs (cmd.exe, `timeout`, `tasklist`,
 *    `taskkill`) from a console-less detached parent: each gets a fresh, briefly
 *    visible console window, which is what made the old helper blink several
 *    black windows per restart. Stopping a process needs no program at all;
 *    `process.kill` is TerminateProcess on Windows.
 *
 * 3. It must not pass `windowsHide` when starting the application. That switch
 *    becomes `STARTF_USESHOWWINDOW` + `SW_HIDE` in the child's `STARTUPINFO`, and
 *    Win32 ignores the argument of the child's **first** `ShowWindow` call when
 *    that flag is set. The application's first `ShowWindow` is the one that
 *    presents its main window, so the window stays hidden for the life of the
 *    process: the backend runs, the window never appears, and only a second
 *    `ShowWindow` (from opening the app again, which fires `second-instance` →
 *    `focusPrimaryWindow`) makes it visible. That is the "窗口关了、后台还在"
 *    report. The executable is a GUI-subsystem image (`subsystem=2`), so it
 *    never allocates a console and there is nothing to hide.
 *
 * argv: `<mainPid> <hostPid> <exe> <logPath> [--no-launch]`
 *
 * Importing this module has no side effects; {@link main} runs only when the
 * file is executed directly, so tests can exercise the pure helpers.
 */

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Wait before stopping anything, so the HTTP reply reaches the renderer first.
 *
 * The route answers before it starts this helper, so this is only a flush guard;
 * every millisecond here is added to the time the window is gone.
 */
const REPLY_GRACE_MS = 120;
/** Liveness poll interval while waiting for a process to exit. */
const EXIT_POLL_MS = 60;
/** Give up waiting for the Desktop main process after this pause. */
const MAIN_EXIT_TIMEOUT_MS = 10_000;
/** Give up waiting for the application Host after this pause. */
const HOST_EXIT_TIMEOUT_MS = 5_000;
/**
 * Settle time after both processes are gone, before the new instance starts.
 *
 * `waitGone` already proved both processes exited, so this is only a short pause
 * for Windows to finish releasing their handles and the profile lock.
 */
const SETTLE_MS = 150;
/** How long the new instance must stay up before the relaunch counts as working. */
const LAUNCH_HEALTH_MS = 1_500;
/**
 * How many times the relaunch may be attempted.
 *
 * A fresh instance quits immediately when it loses the single-instance lock,
 * and the processes stopped above release that lock only when Windows has
 * finished tearing them down. One attempt is therefore not enough on a slow
 * teardown, and the retry is what turns "closed and never came back" into a
 * working restart.
 */
const LAUNCH_ATTEMPTS = 3;
/** Pause before the next relaunch attempt. */
const LAUNCH_RETRY_MS = 1_200;

/**
 * Sleep without any child process or console window.
 * @param {number} ms - pause length.
 * @returns {Promise<void>} resolves after the pause.
 */
export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Whether a process id currently exists.
 * @param {number} pid - candidate process id.
 * @returns {boolean} true when the process exists.
 */
export function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/**
 * Build the environment for a fresh, user-equivalent application launch.
 *
 * Only the Desktop Host's own startup switches are removed; everything else
 * (profile location, credentials, PATH) is the caller's, so plugins and the
 * signed-in account survive the restart.
 *
 * @param {NodeJS.ProcessEnv} environment - the helper's environment.
 * @returns {NodeJS.ProcessEnv} an environment that starts the GUI, not node.
 */
export function relaunchEnvironment(environment) {
  const clean = { ...environment };
  // Makes the executable run as Node instead of the application.
  delete clean.ELECTRON_RUN_AS_NODE;
  // Set by Electron when the process owns no console; kept out of a GUI launch.
  delete clean.ELECTRON_NO_ATTACH_CONSOLE;
  // Points package scripts at the bundled shell launcher, not a user session.
  delete clean.DSH_DESKTOP_NODE_EXECUTABLE;
  return clean;
}

/**
 * Run the restart.
 * @param {{mainPid: number, hostPid: number, exe: string, logPath: string, noLaunch: boolean}} options - restart facts.
 * @param {(line: string) => void} log - receives progress lines.
 * @returns {Promise<{ok: boolean, error?: string}>} the outcome.
 */
export async function restart(options, log) {
  const { mainPid, hostPid, exe, noLaunch } = options;

  log(`helper start main=${String(mainPid)} host=${String(hostPid)} exe=${String(exe)}`);

  if (typeof exe !== 'string' || exe === '' || !existsSync(exe)) {
    return { ok: false, error: 'application executable is missing; nothing was stopped' };
  }
  if (!Number.isSafeInteger(mainPid) || mainPid <= 0) {
    return { ok: false, error: 'no Desktop main process was given; nothing was stopped' };
  }

  await sleep(REPLY_GRACE_MS);

  // The main process goes first: it owns the fatal-recovery dialog and the
  // single-instance lock, so stopping it before the Host avoids a "host
  // stopped" report, and its Chromium children follow it down.
  const mainStopped = stopProcess(mainPid, log);
  const mainGone = await waitGone(mainPid, MAIN_EXIT_TIMEOUT_MS);
  log(`main ${String(mainPid)} requested=${String(mainStopped)} gone=${String(mainGone)}`);

  const hostStopped = stopProcess(hostPid, log);
  const hostGone = await waitGone(hostPid, HOST_EXIT_TIMEOUT_MS);
  log(`host ${String(hostPid)} requested=${String(hostStopped)} gone=${String(hostGone)}`);

  if (!mainGone) log('main process outlived its deadline; the relaunch may hit the single-instance lock');
  if (!hostGone) log('host outlived its deadline; the new instance may fail to bind its port');

  await sleep(SETTLE_MS);

  if (noLaunch) {
    log('no-launch requested; stopping before the relaunch step');
    return { ok: true };
  }

  try {
    for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt += 1) {
      if (attempt > 1) {
        log(`relaunch attempt ${String(attempt)} of ${String(LAUNCH_ATTEMPTS)}`);
        await sleep(LAUNCH_RETRY_MS);
      }

      const outcome = await launchOnce(exe, log);
      if (outcome.error !== undefined) return { ok: false, error: outcome.error };

      // A window that never appears is the failure this helper exists to fix, so
      // each attempt ends by checking that the new instance survived its own
      // startup instead of stopping at "spawn returned". No console child and no
      // polling program is involved: liveness is a signal-0 probe.
      const survived = await confirmLaunch(outcome.pid, log);
      if (survived) return { ok: true };
    }
    return { ok: false, error: 'the application exited during startup; see the helper log' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`relaunch threw: ${message}`);
    return { ok: false, error: message };
  }
}

/**
 * The spawn options for the application itself.
 *
 * `windowsHide` is deliberately absent. Node turns it into
 * `STARTF_USESHOWWINDOW` + `SW_HIDE` in the child's `STARTUPINFO`, and Win32
 * then ignores the argument of the child's **first** `ShowWindow` call — which
 * for this application is the call that presents the main window. The window
 * would stay hidden for the life of the process (backend running, nothing on
 * screen) until a second `ShowWindow`, i.e. until the user opened the app again
 * and hit the single-instance path. The executable is a GUI-subsystem image
 * (`subsystem=2`), so it never allocates a console that could need hiding.
 *
 * @param {string} exe - the application executable.
 * @returns {import('node:child_process').SpawnOptions} spawn options.
 */
export function launchOptions(exe) {
  return {
    cwd: dirname(exe),
    detached: true,
    stdio: 'ignore',
    env: relaunchEnvironment(process.env),
  };
}

/**
 * Start the application once as a detached GUI process.
 *
 * `relaunchEnvironment` removes the switch that would make the executable run
 * as Node; without that removal the new process prints a version and exits with
 * no window, which is exactly the "closed and did not come back" failure.
 *
 * @param {string} exe - the application executable.
 * @param {(line: string) => void} log - receives progress lines.
 * @returns {Promise<{pid: number, error?: undefined} | {pid?: undefined, error: string}>} the started pid or the failure.
 */
async function launchOnce(exe, log) {
  const child = spawn(exe, [], launchOptions(exe));
  const failure = await new Promise((resolve) => {
    child.once('error', (error) => {
      resolve(error.message);
    });
    child.once('spawn', () => {
      resolve(null);
    });
  });
  if (failure !== null) {
    log(`relaunch failed: ${failure}`);
    return { error: failure };
  }
  const launchedPid = child.pid ?? 0;
  child.unref();
  log(`relaunched pid=${String(launchedPid)}`);
  return { pid: launchedPid };
}

/**
 * Check that the instance started a moment ago is still running.
 *
 * The old helper considered the restart finished as soon as `start` returned,
 * which is why a failing relaunch looked like a silent close. The application
 * that starts in Node mode exits within milliseconds, so a short wait separates
 * a real window from that failure without involving any console program.
 *
 * @param {number} pid - the freshly launched process id.
 * @param {(line: string) => void} log - receives progress lines.
 * @returns {Promise<boolean>} true when the instance is still alive.
 */
export async function confirmLaunch(pid, log) {
  await sleep(LAUNCH_HEALTH_MS);
  const survived = isAlive(pid);
  log(survived ? `relaunch confirmed: pid ${String(pid)} still running` : `relaunch unconfirmed: pid ${String(pid)} exited during startup`);
  return survived;
}

/**
 * Force-stop one process; on Windows this is TerminateProcess.
 * @param {number} pid - process id to stop.
 * @param {(line: string) => void} log - receives progress lines.
 * @returns {boolean} whether the signal was delivered.
 */
function stopProcess(pid, log) {
  if (!isAlive(pid)) return false;
  try {
    process.kill(pid);
    log(`stopped pid ${String(pid)}`);
    return true;
  } catch (error) {
    log(`could not stop pid ${String(pid)}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Wait until a process id disappears.
 * @param {number} pid - process id to watch.
 * @param {number} timeoutMs - longest acceptable wait.
 * @returns {Promise<boolean>} true when the process is gone.
 */
async function waitGone(pid, timeoutMs) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(EXIT_POLL_MS);
  }
  return !isAlive(pid);
}

/**
 * Parse the helper's argv and run it.
 * @returns {Promise<void>} resolves when the helper finishes.
 */
async function main() {
  const [mainPidArg, hostPidArg, exe, logPath, mode] = process.argv.slice(2);

  /** Append one line to the helper log, when a path was given. */
  const log = (line) => {
    if (typeof logPath !== 'string' || logPath === '') return;
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* a missing log never blocks the restart */
    }
  };

  const result = await restart(
    {
      mainPid: Number.parseInt(mainPidArg ?? '', 10),
      hostPid: Number.parseInt(hostPidArg ?? '', 10),
      exe: exe ?? '',
      logPath: logPath ?? '',
      noLaunch: mode === '--no-launch',
    },
    log,
  );

  process.exit(result.ok ? 0 : 1);
}

const executedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (executedDirectly) await main();
