#!/usr/bin/env node

const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const nextMode = process.argv[2] === 'start' ? 'start' : 'dev';
const port = Number(process.env.PORT || 3000);
const startUrl = process.env.ELECTRON_START_URL || `http://localhost:${port}`;

let isShuttingDown = false;
let nextProcess = null;
let electronProcess = null;

function shutdown(exitCode = 0) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  if (electronProcess && !electronProcess.killed) {
    electronProcess.kill('SIGTERM');
  }

  if (nextProcess && !nextProcess.killed) {
    nextProcess.kill('SIGTERM');
  }

  process.exit(exitCode);
}

function waitForServer(url, timeoutMs = 120000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }

      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });

      req.on('error', () => {
        setTimeout(tryConnect, 500);
      });

      req.setTimeout(2000, () => {
        req.destroy();
      });
    };

    tryConnect();
  });
}

function startNext() {
  const nextScript = path.join(__dirname, 'run-next.js');

  nextProcess = spawn(process.execPath, [nextScript, nextMode], {
    env: process.env,
    stdio: 'inherit',
  });

  nextProcess.on('close', (code) => {
    if (isShuttingDown) {
      return;
    }

    console.error(`[electron-launcher] Next process exited unexpectedly with code ${code ?? 'null'}.`);
    shutdown(code ?? 1);
  });
}

function startElectron() {
  const electronBinary = require('electron');

  electronProcess = spawn(electronBinary, ['.'], {
    env: {
      ...process.env,
      ELECTRON_START_URL: startUrl,
    },
    stdio: 'inherit',
  });

  electronProcess.on('close', (code) => {
    shutdown(code ?? 0);
  });
}

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

(async () => {
  startNext();
  await waitForServer(startUrl);
  startElectron();
})().catch((error) => {
  console.error(`[electron-launcher] ${error.message}`);
  shutdown(1);
});
