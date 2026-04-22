#!/usr/bin/env node

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const nextBin = require.resolve('next/dist/bin/next');
const standaloneServerEntry = path.join(process.cwd(), '.next', 'standalone', 'server.js');
const standaloneStaticDir = path.join(process.cwd(), '.next', 'standalone', '.next', 'static');
const appStaticDir = path.join(process.cwd(), '.next', 'static');

function ensureStandaloneStaticAssets() {
  if (!fs.existsSync(appStaticDir)) {
    console.warn('[run-next] Root static assets were not found at .next/static.');
    return false;
  }

  try {
    fs.mkdirSync(path.dirname(standaloneStaticDir), { recursive: true });
    fs.cpSync(appStaticDir, standaloneStaticDir, { recursive: true, force: true });
    return true;
  } catch (error) {
    console.warn(
      `[run-next] Failed to sync standalone static assets: ${error instanceof Error ? error.message : error}`
    );
    return false;
  }
}

const isStandaloneStartCommand = args[0] === 'start' && args.length === 1;

if (isStandaloneStartCommand && fs.existsSync(standaloneServerEntry)) {
  ensureStandaloneStaticAssets();
}

const shouldUseStandaloneStart =
  isStandaloneStartCommand && fs.existsSync(standaloneServerEntry);

if (args[0] === 'start' && args.length === 1 && !shouldUseStandaloneStart) {
  console.warn(
    '[run-next] Standalone server entry was not found. Falling back to "next start". Run "npm run build" first.'
  );
}

const shouldDropLine = (line) =>
  line.includes('[baseline-browser-mapping] The data in this module is over two months old.') ||
  line.includes('To ensure accurate Baseline data, please update: `npm i baseline-browser-mapping@latest -D`');

function forwardWithFilter(stream, targetWrite) {
  let buffer = '';

  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;

    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!shouldDropLine(line)) {
        targetWrite(line + '\n');
      }
    }
  });

  stream.on('end', () => {
    if (buffer && !shouldDropLine(buffer)) {
      targetWrite(buffer);
    }
  });
}

let shuttingDown = false;
let workerProcess = null;
let workerRestartAttempts = 0;

const child = shouldUseStandaloneStart
  ? spawn(process.execPath, [standaloneServerEntry], {
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    })
  : spawn(process.execPath, [nextBin, ...args], {
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

if (shouldUseStandaloneStart) {
  console.log('[run-next] Starting Next.js from .next/standalone/server.js');
}

const nextChild = child;

forwardWithFilter(nextChild.stdout, (text) => process.stdout.write(text));
forwardWithFilter(nextChild.stderr, (text) => process.stderr.write(text));

nextChild.on('close', (code, signal) => {
  shuttingDown = true;
  if (workerProcess && !workerProcess.killed) {
    workerProcess.kill('SIGTERM');
  }

  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

// Spawn the background worker if we are running dev or start
if (args[0] === 'dev' || args[0] === 'start') {
  const workerVisibleEnv = String(process.env.WORKER_VISIBLE_BROWSER ?? '').trim().toLowerCase();
  const forceHeadless = workerVisibleEnv === 'false';
  const forceVisible = workerVisibleEnv === 'true';
  const useVisibleWorker = forceVisible || (args[0] === 'dev' && !forceHeadless);
  const workerScript = useVisibleWorker ? 'worker:visible' : 'worker:engine';
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npmExecPath = process.env.npm_execpath;
  const npmNodeExecPath = process.env.npm_node_execpath || process.execPath;
  const workerEnv = { ...process.env };

  if (useVisibleWorker) {
    if (!workerEnv.WORKER_SKIP_PREFLIGHT_IN_VISIBLE_MODE) {
      workerEnv.WORKER_SKIP_PREFLIGHT_IN_VISIBLE_MODE = 'true';
    }

    if (!workerEnv.WORKER_DEBUG_BROWSER_HOLD_FAILURE_ONLY) {
      workerEnv.WORKER_DEBUG_BROWSER_HOLD_FAILURE_ONLY = 'true';
    }

    if (!workerEnv.WORKER_DEBUG_BROWSER_HOLD_MS) {
      workerEnv.WORKER_DEBUG_BROWSER_HOLD_MS = '15000';
    }
  }

  const startWorker = () => {
    if (shuttingDown) {
      return;
    }

    console.log(
      `[worker-launcher] Starting ${workerScript} (${useVisibleWorker ? 'debug Chrome view enabled' : 'headless mode'})`
    );

    const startedAt = Date.now();
    if (npmExecPath) {
      workerProcess = spawn(npmNodeExecPath, [npmExecPath, 'run', workerScript], {
        env: workerEnv,
        stdio: 'inherit',
      });
    } else {
      workerProcess = spawn(npmCommand, ['run', workerScript], {
        env: workerEnv,
        stdio: 'inherit',
      });
    }

    workerProcess.on('error', (err) => {
      console.error(`Failed to start worker process: ${err}`);
    });

    workerProcess.on('close', (code, signal) => {
      if (shuttingDown) {
        return;
      }

      const runtimeMs = Date.now() - startedAt;
      if (runtimeMs > 30_000) {
        workerRestartAttempts = 0;
      }

      workerRestartAttempts += 1;
      const delayMs = Math.min(8_000, 1_000 * workerRestartAttempts);

      console.warn(
        `[worker-launcher] Worker exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}). Restarting in ${delayMs}ms...`
      );

      setTimeout(() => {
        startWorker();
      }, delayMs);
    });
  };

  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    if (workerProcess && !workerProcess.killed) {
      workerProcess.kill('SIGTERM');
    }
    if (!nextChild.killed) {
      nextChild.kill('SIGTERM');
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  startWorker();
}
