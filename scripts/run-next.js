#!/usr/bin/env node

const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
const nextBin = require.resolve('next/dist/bin/next');

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

const child = spawn(process.execPath, [nextBin, ...args], {
  env: process.env,
  stdio: ['inherit', 'pipe', 'pipe'],
});

forwardWithFilter(child.stdout, (text) => process.stdout.write(text));
forwardWithFilter(child.stderr, (text) => process.stderr.write(text));

child.on('close', (code, signal) => {
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

  console.log(
    `[worker-launcher] Starting ${workerScript} (${useVisibleWorker ? 'debug Chrome view enabled' : 'headless mode'})`
  );

  const workerProcess = spawn('npm', ['run', workerScript], {
    env: workerEnv,
    stdio: 'inherit',
    shell: true,
  });

  workerProcess.on('error', (err) => {
    console.error(`Failed to start worker process: ${err}`);
  });
}
