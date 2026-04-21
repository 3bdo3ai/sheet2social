const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const DEFAULT_SERVER_PORT = Number.parseInt(process.env.PORT ?? '3000', 10) || 3000;
const PRODUCTION_HOST = '127.0.0.1';
const SERVER_READY_TIMEOUT_MS = 120_000;
const SERVER_READY_POLL_MS = 500;
const SERVER_REQUEST_TIMEOUT_MS = 2_000;
const RUNTIME_ENV_KEYS = {
  userDataDir: 'SHEET2SOCIAL_USER_DATA_DIR',
  storageDir: 'SHEET2SOCIAL_STORAGE_DIR',
  dataDir: 'SHEET2SOCIAL_DATA_DIR',
  csvDir: 'SHEET2SOCIAL_CSV_DIR',
  imageDir: 'SHEET2SOCIAL_IMAGE_DIR',
  traceDir: 'SHEET2SOCIAL_TRACE_DIR',
};
const DEFAULT_AUTOMATION_STATE = {
  state: 'stopped',
  settings: {
    parallelAccounts: 3,
    waitIntervalMinutes: 5,
    delayBetweenAccountsMinutes: 1,
    postsPerGroup: 1,
    maxPostsPerAccountPerCycle: 10,
    postsPerSession: 20,
    commentWithPostImage: false,
    proxyRotationEnabled: false,
  },
};

let nextServerProcess = null;
let workerProcess = null;
let workerRestartAttempts = 0;
let isAppShuttingDown = false;
let hasRunShutdown = false;
let nextServerLogFilePath = null;
let cachedStartFacebookBot = undefined;

function resolveFacebookBotModuleCandidates() {
  return [
    path.join(__dirname, 'src', 'lib', 'facebookBotElectron.js'),
    path.join(process.cwd(), 'src', 'lib', 'facebookBotElectron.js'),
  ];
}

function resolveStartFacebookBot() {
  if (cachedStartFacebookBot !== undefined) {
    return cachedStartFacebookBot;
  }

  for (const candidate of resolveFacebookBotModuleCandidates()) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    try {
      const moduleValue = require(candidate);
      if (typeof moduleValue.startFacebookBot === 'function') {
        cachedStartFacebookBot = moduleValue.startFacebookBot;
        return cachedStartFacebookBot;
      }
    } catch {
      // Ignore invalid module candidates and keep searching.
    }
  }

  cachedStartFacebookBot = null;
  return cachedStartFacebookBot;
}

function resolveFirstExistingPath(candidates) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function resolvePackagedStandaloneDirCandidates() {
  return [
    path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'electron-resources', 'standalone'),
    path.join(process.resourcesPath, 'app.asar', 'dist', 'electron-resources', 'standalone'),
    path.join(process.resourcesPath, 'app', 'dist', 'electron-resources', 'standalone'),
    path.join(process.resourcesPath, 'dist', 'electron-resources', 'standalone'),
    path.join(process.resourcesPath, 'app', 'standalone'),
    path.join(process.resourcesPath, 'standalone'),
  ];
}

function resolvePackagedStandaloneDir() {
  const candidates = resolvePackagedStandaloneDirCandidates();
  return resolveFirstExistingPath(candidates) ?? candidates[0];
}

function resolvePackagedServerEntry() {
  const candidates = resolvePackagedStandaloneDirCandidates().map((dirPath) => path.join(dirPath, 'server.js'));
  return {
    serverEntry: resolveFirstExistingPath(candidates),
    candidates,
  };
}

function resolvePackagedStandaloneModulePathCandidates() {
  return [
    path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'electron-resources', 'standalone-node-modules'),
    path.join(process.resourcesPath, 'app.asar', 'dist', 'electron-resources', 'standalone-node-modules'),
    path.join(process.resourcesPath, 'app', 'dist', 'electron-resources', 'standalone-node-modules'),
    path.join(process.resourcesPath, 'dist', 'electron-resources', 'standalone-node-modules'),
    path.join(process.resourcesPath, 'app', 'standalone', 'node_modules'),
    path.join(process.resourcesPath, 'standalone', 'node_modules'),
    path.join(process.resourcesPath, 'app', 'standalone-node-modules'),
    path.join(process.resourcesPath, 'standalone-node-modules'),
  ];
}

function resolvePackagedWorkerModulePathCandidates() {
  return [
    path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'electron-resources', 'worker-node-modules'),
    path.join(process.resourcesPath, 'app.asar', 'dist', 'electron-resources', 'worker-node-modules'),
    path.join(process.resourcesPath, 'app', 'dist', 'electron-resources', 'worker-node-modules'),
    path.join(process.resourcesPath, 'dist', 'electron-resources', 'worker-node-modules'),
    ...resolvePackagedStandaloneModulePathCandidates(),
  ];
}

function resolvePackagedWorkerEntryCandidates() {
  return [
    path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'electron-resources', 'worker-runtime', 'worker', 'engine.js'),
    path.join(process.resourcesPath, 'app.asar', 'dist', 'electron-resources', 'worker-runtime', 'worker', 'engine.js'),
    path.join(process.resourcesPath, 'app', 'dist', 'electron-resources', 'worker-runtime', 'worker', 'engine.js'),
    path.join(process.resourcesPath, 'dist', 'electron-resources', 'worker-runtime', 'worker', 'engine.js'),
  ];
}

function resolvePackagedWorkerEntry() {
  const candidates = resolvePackagedWorkerEntryCandidates();
  return {
    workerEntry: resolveFirstExistingPath(candidates),
    candidates,
  };
}

function applyNodePath(targetEnv, modulePaths) {
  const existingEntries = String(targetEnv.NODE_PATH ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const mergedEntries = [...new Set([...modulePaths, ...existingEntries])];
  if (mergedEntries.length > 0) {
    targetEnv.NODE_PATH = mergedEntries.join(path.delimiter);
  }
}

function resolvePackagedChromedriverPath() {
  return resolveFirstExistingPath([
    path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'electron-resources', 'drivers', 'chromedriver.exe'),
    path.join(process.resourcesPath, 'app.asar', 'dist', 'electron-resources', 'drivers', 'chromedriver.exe'),
    path.join(process.resourcesPath, 'app', 'dist', 'electron-resources', 'drivers', 'chromedriver.exe'),
    path.join(process.resourcesPath, 'dist', 'electron-resources', 'drivers', 'chromedriver.exe'),
    path.join(process.resourcesPath, 'app', 'drivers', 'chromedriver.exe'),
    path.join(process.resourcesPath, 'app', 'chromedriver.exe'),
    path.join(process.resourcesPath, 'drivers', 'chromedriver.exe'),
  ]);
}

function resolvePackagedChromeBinaryPath() {
  return resolveFirstExistingPath([
    path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'electron-resources', 'chrome', 'chrome.exe'),
    path.join(process.resourcesPath, 'app.asar', 'dist', 'electron-resources', 'chrome', 'chrome.exe'),
    path.join(process.resourcesPath, 'app', 'dist', 'electron-resources', 'chrome', 'chrome.exe'),
    path.join(process.resourcesPath, 'dist', 'electron-resources', 'chrome', 'chrome.exe'),
    path.join(process.resourcesPath, 'app', 'chrome', 'chrome.exe'),
    path.join(process.resourcesPath, 'app', 'chrome-win64', 'chrome.exe'),
    path.join(process.resourcesPath, 'app', 'drivers', 'chrome.exe'),
    path.join(process.resourcesPath, 'app', 'drivers', 'chrome', 'chrome.exe'),
    path.join(process.resourcesPath, 'app', 'drivers', 'chrome-win64', 'chrome.exe'),
  ]);
}

function resolveWindowIconPath() {
  const candidates = app.isPackaged
    ? [
        path.join(resolvePackagedStandaloneDir(), 'public', 'favicon.ico'),
        path.join(process.resourcesPath, 'app', 'public', 'favicon.ico'),
      ]
    : [
        path.join(__dirname, 'public', 'favicon.ico'),
        path.join(process.cwd(), 'public', 'favicon.ico'),
      ];

  return resolveFirstExistingPath(candidates) ?? candidates[0];
}

function applyBundledBrowserEnv(targetEnv) {
  const chromeBinaryPath = resolvePackagedChromeBinaryPath();
  const chromedriverPath = resolvePackagedChromedriverPath();

  if (chromeBinaryPath) {
    targetEnv.CHROME_BINARY_PATH = chromeBinaryPath;
  }

  if (chromedriverPath) {
    targetEnv.CHROMEDRIVER_PATH = chromedriverPath;
    targetEnv.SE_CHROMEDRIVER = chromedriverPath;
    targetEnv.WEBDRIVER_CHROME_DRIVER = chromedriverPath;
  }

  return {
    chromeBinaryPath,
    chromedriverPath,
  };
}

function resolveRuntimeUserDataPaths() {
  const userDataDir = app.getPath('userData');
  const storageDir = path.join(userDataDir, 'storage');
  const dataDir = path.join(userDataDir, 'data');
  const csvDir = path.join(dataDir, 'csvs');
  const imageDir = path.join(dataDir, 'images');
  const traceDir = path.join(storageDir, 'automation-trace');

  return {
    userDataDir,
    storageDir,
    dataDir,
    csvDir,
    imageDir,
    traceDir,
  };
}

function applyRuntimeDataEnv(targetEnv) {
  const runtimePaths = resolveRuntimeUserDataPaths();
  targetEnv[RUNTIME_ENV_KEYS.userDataDir] = runtimePaths.userDataDir;
  targetEnv[RUNTIME_ENV_KEYS.storageDir] = runtimePaths.storageDir;
  targetEnv[RUNTIME_ENV_KEYS.dataDir] = runtimePaths.dataDir;
  targetEnv[RUNTIME_ENV_KEYS.csvDir] = runtimePaths.csvDir;
  targetEnv[RUNTIME_ENV_KEYS.imageDir] = runtimePaths.imageDir;
  targetEnv[RUNTIME_ENV_KEYS.traceDir] = runtimePaths.traceDir;
  return runtimePaths;
}

async function writeFileIfMissing(filePath, content) {
  try {
    await fs.promises.access(filePath);
    return;
  } catch {
    // Seed missing first-run files.
  }

  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content, 'utf8');
}

async function ensurePackagedUserDataStructure() {
  if (!app.isPackaged) {
    return;
  }

  const runtimePaths = applyRuntimeDataEnv(process.env);

  await Promise.all([
    fs.promises.mkdir(runtimePaths.storageDir, { recursive: true }),
    fs.promises.mkdir(runtimePaths.csvDir, { recursive: true }),
    fs.promises.mkdir(runtimePaths.imageDir, { recursive: true }),
    fs.promises.mkdir(runtimePaths.traceDir, { recursive: true }),
    fs.promises.mkdir(path.join(runtimePaths.storageDir, 'comment-test-dumps'), { recursive: true }),
  ]);

  await Promise.all([
    writeFileIfMissing(
      path.join(runtimePaths.storageDir, 'automation_state.json'),
      `${JSON.stringify(DEFAULT_AUTOMATION_STATE, null, 2)}\n`
    ),
    writeFileIfMissing(path.join(runtimePaths.storageDir, 'facebook_sessions.json'), '{}\n'),
    writeFileIfMissing(path.join(runtimePaths.storageDir, 'comment-test-last-run.json'), '{}\n'),
    writeFileIfMissing(path.join(runtimePaths.storageDir, 'comment-test-last-inspect.json'), '{}\n'),
  ]);

  const line =
    `[electron] Using userData runtime paths: storage=${runtimePaths.storageDir}, data=${runtimePaths.dataDir}`;
  console.log(line);
  appendNextServerLogLine(line);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getNextServerLogFilePath() {
  if (nextServerLogFilePath !== null) {
    return nextServerLogFilePath || undefined;
  }

  if (!app.isReady()) {
    return undefined;
  }

  try {
    const logFilePath = path.join(app.getPath('userData'), 'logs', 'next-standalone.log');
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    nextServerLogFilePath = logFilePath;
    return nextServerLogFilePath;
  } catch {
    nextServerLogFilePath = '';
    return undefined;
  }
}

function appendNextServerLogLine(line) {
  const logFilePath = getNextServerLogFilePath();
  if (!logFilePath) {
    return;
  }

  try {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
  } catch {
    return;
  }

  fs.appendFile(logFilePath, `${new Date().toISOString()} ${line}\n`, () => {
    // Logging failures should never crash the app startup flow.
  });
}

function probeServerStatus(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const statusCode = Number(res.statusCode ?? 0);
      res.resume();
      resolve(statusCode);
    });

    req.on('error', reject);
    req.setTimeout(SERVER_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timeout after ${SERVER_REQUEST_TIMEOUT_MS}ms`));
    });
  });
}

async function waitForServer200(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? SERVER_READY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? SERVER_READY_POLL_MS;
  const childProcess = options.childProcess;
  const startedAt = Date.now();
  let lastStatusCode = 0;
  let lastError;

  while (Date.now() - startedAt <= timeoutMs) {
    if (childProcess && childProcess.exitCode !== null) {
      throw new Error(
        `Next.js standalone process exited before readiness (code=${childProcess.exitCode ?? 'null'}, signal=${childProcess.signalCode ?? 'null'}).`
      );
    }

    try {
      const statusCode = await probeServerStatus(url);
      lastStatusCode = statusCode;

      if (statusCode >= 200 && statusCode <= 499) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await delay(pollIntervalMs);
  }

  const details = [];
  if (lastStatusCode) {
    details.push(`last status=${lastStatusCode}`);
  }

  if (lastError) {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    details.push(`last error=${message}`);
  }

  const suffix = details.length > 0 ? ` (${details.join('; ')})` : '';
  const timeoutMessage = `Timed out waiting for ${url} to return an HTTP status between 200 and 499${suffix}.`;

  if (childProcess && childProcess.exitCode === null && !childProcess.killed) {
    const cleanupLine = `[next-standalone] ${timeoutMessage} Cleaning up child process (pid=${childProcess.pid}).`;
    console.error(cleanupLine);
    appendNextServerLogLine(cleanupLine);

    await killProcessTree(childProcess.pid).catch(() => undefined);

    if (nextServerProcess === childProcess) {
      nextServerProcess = null;
    }
  }

  if (app.isReady() && !isAppShuttingDown) {
    const quitLine = '[electron] Readiness polling timed out. Quitting app to avoid zombie processes.';
    console.error(quitLine);
    appendNextServerLogLine(quitLine);
    isAppShuttingDown = true;
    app.quit();
  }

  throw new Error(timeoutMessage);
}

function pipeChildOutput(childProcess, label) {
  const writeChunk = (chunk, isError) => {
    const text = chunk.toString();
    const lines = text.split(/\r?\n/);

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      const prefixedLine = `[${label}] ${line}`;
      if (isError) {
        process.stderr.write(`${prefixedLine}\n`);
      } else {
        process.stdout.write(`${prefixedLine}\n`);
      }
      appendNextServerLogLine(prefixedLine);
    }
  };

  if (childProcess.stdout) {
    childProcess.stdout.on('data', (chunk) => writeChunk(chunk, false));
  }

  if (childProcess.stderr) {
    childProcess.stderr.on('data', (chunk) => writeChunk(chunk, true));
  }
}

function killProcessTree(pid) {
  if (!pid || Number.isNaN(pid)) {
    return Promise.resolve();
  }

  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });

      killer.on('error', () => {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // Ignore already-exited processes.
        }

        resolve();
      });

      killer.on('close', () => resolve());
    });
  }

  return new Promise((resolve) => {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      resolve();
      return;
    }

    const check = setInterval(() => {
      try {
        process.kill(pid, 0);
      } catch {
        clearInterval(check);
        clearTimeout(forceKillTimer);
        resolve();
      }
    }, 200);

    const forceKillTimer = setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Ignore already-exited processes.
      }

      clearInterval(check);
      resolve();
    }, 5_000);
  });
}

async function startProductionServer() {
  if (!app.isPackaged) {
    return process.env.ELECTRON_START_URL || `http://localhost:${DEFAULT_SERVER_PORT}`;
  }

  const serverPort = Number.parseInt(process.env.PORT ?? String(DEFAULT_SERVER_PORT), 10) || DEFAULT_SERVER_PORT;
  const serverUrl = `http://${PRODUCTION_HOST}:${serverPort}`;

  if (nextServerProcess && nextServerProcess.exitCode === null && !nextServerProcess.killed) {
    await waitForServer200(serverUrl, {
      timeoutMs: SERVER_READY_TIMEOUT_MS,
      pollIntervalMs: SERVER_READY_POLL_MS,
      childProcess: nextServerProcess,
    });
    return serverUrl;
  }

  const { serverEntry, candidates } = resolvePackagedServerEntry();
  if (!serverEntry) {
    throw new Error(
      `Standalone Next.js server.js was not found. Checked: ${candidates.join(', ')}`
    );
  }

  const standaloneDir = path.dirname(serverEntry);
  const serverEnv = {
    ...process.env,
    NODE_ENV: 'production',
    ELECTRON_RUN_AS_NODE: '1',
    PORT: String(serverPort),
    HOSTNAME: PRODUCTION_HOST,
    NEXT_TELEMETRY_DISABLED: '1',
  };

  applyRuntimeDataEnv(serverEnv);

  const browserPaths = applyBundledBrowserEnv(serverEnv);
  const modulePaths = resolvePackagedStandaloneModulePathCandidates().filter((candidate) => fs.existsSync(candidate));
  if (modulePaths.length > 0) {
    applyNodePath(serverEnv, modulePaths);
    const message = `[electron] Using standalone module paths: ${modulePaths.join(', ')}`;
    console.log(message);
    appendNextServerLogLine(message);
  }

  const launchMessage = `[electron] Starting packaged Next.js server from ${serverEntry}`;
  console.log(launchMessage);
  appendNextServerLogLine(launchMessage);

  nextServerProcess = spawn(process.execPath, [serverEntry], {
    cwd: standaloneDir,
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  pipeChildOutput(nextServerProcess, 'next-standalone');

  if (browserPaths.chromedriverPath) {
    const message = `[electron] Using packaged chromedriver at ${browserPaths.chromedriverPath}`;
    console.log(message);
    appendNextServerLogLine(message);
  }

  if (browserPaths.chromeBinaryPath) {
    const message = `[electron] Using packaged Chrome binary at ${browserPaths.chromeBinaryPath}`;
    console.log(message);
    appendNextServerLogLine(message);
  }

  nextServerProcess.on('error', (error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    const logLine = `[next-standalone] Failed to spawn process: ${message}`;
    console.error(logLine);
    appendNextServerLogLine(logLine);
  });

  nextServerProcess.on('close', (code, signal) => {
    if (isAppShuttingDown) {
      return;
    }

    const logLine = `[next-standalone] Process exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`;
    console.error(logLine);
    appendNextServerLogLine(logLine);

    nextServerProcess = null;
    app.quit();
  });

  await waitForServer200(serverUrl, {
    timeoutMs: SERVER_READY_TIMEOUT_MS,
    pollIntervalMs: SERVER_READY_POLL_MS,
    childProcess: nextServerProcess,
  });

  return serverUrl;
}

async function startProductionWorker() {
  if (!app.isPackaged) {
    return;
  }

  if (workerProcess && workerProcess.exitCode === null && !workerProcess.killed) {
    return;
  }

  const { workerEntry, candidates } = resolvePackagedWorkerEntry();
  if (!workerEntry) {
    const message = `[worker-engine] Worker entrypoint was not found. Checked: ${candidates.join(', ')}`;
    console.error(message);
    appendNextServerLogLine(message);
    return;
  }

  const workerEnv = {
    ...process.env,
    NODE_ENV: 'production',
    ELECTRON_RUN_AS_NODE: '1',
    NEXT_TELEMETRY_DISABLED: '1',
  };

  applyRuntimeDataEnv(workerEnv);
  const browserPaths = applyBundledBrowserEnv(workerEnv);
  const modulePaths = resolvePackagedWorkerModulePathCandidates().filter((candidate) => fs.existsSync(candidate));
  if (modulePaths.length > 0) {
    applyNodePath(workerEnv, modulePaths);
    const message = `[worker-engine] Using module paths: ${modulePaths.join(', ')}`;
    console.log(message);
    appendNextServerLogLine(message);
  }

  const launchMessage = `[worker-engine] Starting packaged worker from ${workerEntry}`;
  console.log(launchMessage);
  appendNextServerLogLine(launchMessage);

  workerProcess = spawn(process.execPath, [workerEntry], {
    cwd: path.dirname(workerEntry),
    env: workerEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const startedAt = Date.now();
  pipeChildOutput(workerProcess, 'worker-engine');

  if (browserPaths.chromedriverPath) {
    const message = `[worker-engine] Using chromedriver at ${browserPaths.chromedriverPath}`;
    console.log(message);
    appendNextServerLogLine(message);
  }

  if (browserPaths.chromeBinaryPath) {
    const message = `[worker-engine] Using Chrome binary at ${browserPaths.chromeBinaryPath}`;
    console.log(message);
    appendNextServerLogLine(message);
  }

  workerProcess.on('error', (error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    const logLine = `[worker-engine] Failed to spawn process: ${message}`;
    console.error(logLine);
    appendNextServerLogLine(logLine);
  });

  workerProcess.on('close', (code, signal) => {
    const runtimeMs = Date.now() - startedAt;
    workerProcess = null;

    if (isAppShuttingDown) {
      return;
    }

    if (runtimeMs > 30_000) {
      workerRestartAttempts = 0;
    }

    workerRestartAttempts += 1;
    const delayMs = Math.min(8_000, 1_000 * workerRestartAttempts);
    const logLine =
      `[worker-engine] Process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}). ` +
      `Restarting in ${delayMs}ms.`;
    console.warn(logLine);
    appendNextServerLogLine(logLine);

    setTimeout(() => {
      if (isAppShuttingDown) {
        return;
      }

      startProductionWorker().catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        const restartErrorLine = `[worker-engine] Restart attempt failed: ${message}`;
        console.error(restartErrorLine);
        appendNextServerLogLine(restartErrorLine);
      });
    }, delayMs);
  });
}

async function stopProductionServer() {
  const child = nextServerProcess;
  nextServerProcess = null;

  if (!child || child.killed) {
    return;
  }

  await killProcessTree(child.pid).catch(() => undefined);
}

async function stopProductionWorker() {
  const child = workerProcess;
  workerProcess = null;

  if (!child || child.killed) {
    return;
  }

  await killProcessTree(child.pid).catch(() => undefined);
}

function getDevelopmentStartUrl() {
  return process.env.ELECTRON_START_URL || `http://localhost:${DEFAULT_SERVER_PORT}`;
}

ipcMain.handle('startFacebookBot', async (event, credentials = {}) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  const pushLog = (message) => {
    if (!sourceWindow || sourceWindow.isDestroyed()) {
      return;
    }

    sourceWindow.webContents.send('bot-log', String(message));
  };

  try {
    pushLog('Starting Facebook bot workflow...');
    const startFacebookBot = resolveStartFacebookBot();
    if (typeof startFacebookBot !== 'function') {
      throw new Error('Facebook bot module is not bundled in this build.');
    }

    return await startFacebookBot(credentials, pushLog);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pushLog(`Bot failed: ${message}`);
    throw new Error(`Failed to start Facebook bot: ${message}`);
  }
});

async function createMainWindow() {
  const startUrl = app.isPackaged ? await startProductionServer() : getDevelopmentStartUrl();
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    icon: resolveWindowIconPath(),
    autoHideMenuBar: true,
    backgroundColor: '#101114',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (process.platform !== 'darwin') {
    mainWindow.removeMenu();
    mainWindow.setMenuBarVisibility(false);
  }

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });

  if (startUrl.startsWith('http://') || startUrl.startsWith('https://')) {
    if (app.isPackaged) {
      await waitForServer200(startUrl, {
        timeoutMs: SERVER_READY_TIMEOUT_MS,
        pollIntervalMs: SERVER_READY_POLL_MS,
        childProcess: nextServerProcess,
      });
    }

    await mainWindow.loadURL(startUrl);
    return;
  }

  await mainWindow.loadFile(path.join(__dirname, 'out', 'index.html'));
}

async function shutdownApp() {
  if (hasRunShutdown) {
    return;
  }

  hasRunShutdown = true;
  isAppShuttingDown = true;
  await stopProductionWorker();
  await stopProductionServer();
  app.exit(0);
}

app.whenReady().then(async () => {
  if (app.isPackaged) {
    await ensurePackagedUserDataStructure();
    applyBundledBrowserEnv(process.env);
    await startProductionWorker();
  }

  await createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        dialog.showErrorBox('Sheet2Social', `Failed to open the app window.\n\n${message}`);
        app.quit();
      });
    }
  });
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox('Sheet2Social', `Failed to start the app.\n\n${message}`);
  app.quit();
});

app.on('before-quit', (event) => {
  if (hasRunShutdown) {
    return;
  }

  event.preventDefault();
  shutdownApp().catch(() => {
    app.exit(1);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
