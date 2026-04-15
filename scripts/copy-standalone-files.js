#!/usr/bin/env node

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const standaloneSource = path.join(projectRoot, '.next', 'standalone');
const standaloneNodeModulesSource = path.join(standaloneSource, 'node_modules');
const staticSource = path.join(projectRoot, '.next', 'static');
const publicSource = path.join(projectRoot, 'public');
const driversSource = path.join(projectRoot, 'drivers');
const dataSource = path.join(projectRoot, 'data');

const resourcesRoot = path.join(projectRoot, 'dist', 'electron-resources');
const standaloneDest = path.join(resourcesRoot, 'standalone');
const standaloneNodeModulesDest = path.join(resourcesRoot, 'standalone-node-modules');
const staticDest = path.join(standaloneDest, '.next', 'static');
const publicDest = path.join(standaloneDest, 'public');
const driversDest = path.join(resourcesRoot, 'drivers');
const dataDest = path.join(standaloneDest, 'data');
const storageDest = path.join(standaloneDest, 'storage');
const chromeDest = path.join(resourcesRoot, 'chrome');

const defaultAutomationState = {
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

function assertExists(filePath, label) {
  if (!fsSync.existsSync(filePath)) {
    throw new Error(`${label} was not found at ${filePath}`);
  }
}

async function copyDirectory(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true });
}

async function copyIfExists(source, destination) {
  if (!fsSync.existsSync(source)) {
    return false;
  }

  await copyDirectory(source, destination);
  return true;
}

function resolveChromeSourceDir() {
  const candidates = [
    {
      dir: path.join(projectRoot, 'chrome'),
      binary: path.join(projectRoot, 'chrome', 'chrome.exe'),
    },
    {
      dir: path.join(projectRoot, 'chrome-win64'),
      binary: path.join(projectRoot, 'chrome-win64', 'chrome.exe'),
    },
    {
      dir: path.join(projectRoot, 'drivers', 'chrome'),
      binary: path.join(projectRoot, 'drivers', 'chrome', 'chrome.exe'),
    },
    {
      dir: path.join(projectRoot, 'drivers', 'chrome-win64'),
      binary: path.join(projectRoot, 'drivers', 'chrome-win64', 'chrome.exe'),
    },
  ];

  const match = candidates.find((candidate) => fsSync.existsSync(candidate.binary));
  return match ? match.dir : undefined;
}

function resolveEnvSourceFile() {
  const candidates = [
    path.join(projectRoot, '.env.local'),
    path.join(projectRoot, '.env'),
    path.join(projectRoot, '.env.production'),
  ];

  return candidates.find((candidate) => fsSync.existsSync(candidate));
}

async function copyEnvFileToStandalone(targetDir) {
  const envSourceFile = resolveEnvSourceFile();
  if (!envSourceFile) {
    console.warn(
      '[copy-standalone] No .env.local, .env, or .env.production file found in project root. Skipping standalone env copy.'
    );
    return;
  }

  const envDestFile = path.join(targetDir, '.env.production');
  await fs.mkdir(targetDir, { recursive: true });
  await fs.copyFile(envSourceFile, envDestFile);

  console.log(
    `[copy-standalone] Copied ${path.basename(envSourceFile)} -> standalone/.env.production`
  );
}

async function writeDefaultAutomationState(targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(
    path.join(targetDir, 'automation_state.json'),
    `${JSON.stringify(defaultAutomationState, null, 2)}\n`,
    'utf8'
  );
}

async function main() {
  assertExists(standaloneSource, 'Next standalone output');
  assertExists(standaloneNodeModulesSource, 'Next standalone node_modules output');
  assertExists(staticSource, 'Next static output');

  await fs.rm(resourcesRoot, { recursive: true, force: true });
  await fs.mkdir(resourcesRoot, { recursive: true });

  console.log('[copy-standalone] Copying .next/standalone ...');
  await copyDirectory(standaloneSource, standaloneDest);

  // Electron-builder can filter out directories literally named "node_modules"
  // from extraResources. Keep a duplicate in a neutral path and use NODE_PATH at runtime.
  console.log('[copy-standalone] Copying standalone node_modules -> resources/standalone-node-modules ...');
  await copyDirectory(standaloneNodeModulesSource, standaloneNodeModulesDest);

  // Standalone tracing can occasionally include previous build artifacts.
  // Keep the packaged server folder clean and deterministic.
  await fs.rm(path.join(standaloneDest, 'dist'), { recursive: true, force: true });

  console.log('[copy-standalone] Copying .next/static -> standalone/.next/static ...');
  await copyDirectory(staticSource, staticDest);

  console.log('[copy-standalone] Copying public -> standalone/public ...');
  await copyIfExists(publicSource, publicDest);

  console.log('[copy-standalone] Copying data -> standalone/data ...');
  await copyIfExists(dataSource, dataDest);

  console.log('[copy-standalone] Copying environment file -> standalone/.env.production ...');
  await copyEnvFileToStandalone(standaloneDest);

  console.log('[copy-standalone] Copying drivers -> resources/drivers ...');
  await copyIfExists(driversSource, driversDest);

  console.log('[copy-standalone] Writing default storage seed files ...');
  await writeDefaultAutomationState(storageDest);

  const chromeSourceDir = resolveChromeSourceDir();
  if (chromeSourceDir) {
    console.log(`[copy-standalone] Copying Chrome bundle from ${chromeSourceDir} ...`);
    await copyDirectory(chromeSourceDir, chromeDest);
  } else {
    await fs.mkdir(chromeDest, { recursive: true });
    console.warn(
      '[copy-standalone] No portable Chrome binary was found. The packaged app will require a system Chrome installation unless you place chrome.exe under chrome/, chrome-win64/, drivers/chrome/, or drivers/chrome-win64/.'
    );
  }

  console.log(`[copy-standalone] Electron resources prepared at ${resourcesRoot}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[copy-standalone] ${message}`);
  process.exit(1);
});
