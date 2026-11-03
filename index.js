/**
 * Host half of dsh-restart-button.
 *
 * Registers one loopback-only route that the titlebar button calls. The route
 * answers first, then hands the restart to a detached Node helper
 * (`restart-helper.mjs`), which stops the Desktop main process and this Host,
 * waits for both to disappear, and starts the application again.
 *
 * The Host runs as an `ELECTRON_RUN_AS_NODE` child of the Desktop main process
 * (`main.js:3650-3658`), so it shares that process's executable and knows both
 * the image to stop and the executable to start without asking the main process.
 * `process.env` also carries `ELECTRON_RUN_AS_NODE=1` here; the helper must strip
 * it before relaunching, or the new instance starts as `node` and shows no window.
 */

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Route path served by this plugin. */
const ROUTE = '/dsh-restart-button/restart';

/** Request marker the client sets; a cross-site form cannot set custom headers. */
const MARKER_HEADER = 'x-dsh-restart-button';

/**
 * Delay between the HTTP reply and starting the helper, in milliseconds.
 *
 * The reply is already written before this timer fires, so this only covers the
 * flush to the renderer. It sits inside the time the window is gone, so it stays
 * as short as that one job allows.
 */
const REPLY_GRACE_MS = 100;

/** Helper script shipped beside this module. */
const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'restart-helper.mjs');

export const inject = ['webServer'];

/**
 * Write one JSON reply.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {object} body - JSON body.
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(text)),
  });
  res.end(text);
}

/**
 * Whether the peer is this machine.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {boolean} true for a loopback peer.
 */
function isLoopback(req) {
  const address = req.socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Find the Desktop main process that owns this Host.
 *
 * The Host is spawned with `stdio: [ignore, pipe, pipe, ipc]` from the main
 * process, so `process.ppid` is that main process on Windows. A negative or
 * zero parent means the Host was orphaned or started some other way; the
 * relaunch then has no safe target and reports that instead of guessing.
 *
 * @returns {number} the main process id, or 0 when it cannot be determined.
 */
function mainProcessId() {
  const parent = process.ppid;
  return Number.isSafeInteger(parent) && parent > 0 ? parent : 0;
}

/**
 * Whether this Host is running inside the Desktop application.
 *
 * The route must never stop processes in a plain `node` Host started from a
 * terminal: there would be no window to bring back. Electron's Node mode still
 * reports `process.versions.electron`, and the executable is the application
 * rather than a `node.exe`.
 *
 * @returns {boolean} true for the Desktop Host.
 */
function isDesktopHost() {
  return typeof process.versions.electron === 'string' && process.versions.electron !== '' && /\.exe$/iu.test(process.execPath);
}

/**
 * Start the detached helper that stops and restarts this application.
 * @returns {{ok: boolean, error?: string}} whether the helper was started.
 */
function launchRestart() {
  if (!isDesktopHost()) {
    return { ok: false, error: 'the restart button only works inside the DSH desktop application' };
  }
  const exe = process.execPath;

  const mainPid = mainProcessId();
  if (mainPid === 0) return { ok: false, error: 'the Desktop main process could not be identified' };

  try {
    const child = spawn(
      process.execPath,
      [HELPER, String(mainPid), String(process.pid), exe, join(tmpdir(), 'dsh-restart-button.log')],
      {
        // The helper outlives this Host and must not hold a handle on the plugin
        // directory (which the profile links from), so it runs from the temp dir.
        cwd: tmpdir(),
        // The executable is the application, so it has to be told to run as Node.
        // The Host normally inherits that switch from the main process
        // (`main.js:3650-3658`); setting it here keeps the helper a Node script
        // even on a launch path that did not.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        // `detached` is required together with `windowsHide` on Windows: a hidden
        // console child of a console-less parent dies at startup (0xC0000142).
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    child.on('error', () => {
      /* the helper is on its own from here; its log file records failures */
    });
    child.unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Mount the restart route.
 * @param {object} ctx - the Host plugin context.
 */
export function apply(ctx) {
  let pending = false;

  /**
   * One route entry: method and marker guard, then hand off to the helper.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   */
  function handler(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    if (req.headers[MARKER_HEADER] !== '1') {
      sendJson(res, 403, { ok: false, error: `missing ${MARKER_HEADER} header` });
      return;
    }
    if (!isLoopback(req)) {
      sendJson(res, 403, { ok: false, error: 'loopback only' });
      return;
    }
    req.resume();
    if (pending) {
      sendJson(res, 409, { ok: false, error: 'restart already scheduled' });
      return;
    }
    pending = true;
    setTimeout(() => {
      const result = launchRestart();
      if (!result.ok) {
        pending = false;
        ctx.logger?.warn?.(`dsh-restart-button: restart helper failed: ${String(result.error)}`);
      } else {
        ctx.logger?.info?.('dsh-restart-button: restart helper started');
      }
    }, REPLY_GRACE_MS);
    sendJson(res, 200, { ok: true, restarting: true });
  }

  ctx.effect(() => {
    const unregister = ctx.webServer.register({ kind: 'exact', path: ROUTE, handler });
    return () => {
      pending = false;
      unregister();
    };
  });
}
