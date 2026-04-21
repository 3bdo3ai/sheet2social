#!/usr/bin/env node

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const standaloneSource = path.join(projectRoot, '.next', 'standalone');
const standaloneNodeModulesSource = path.join(standaloneSource, 'node_modules');
const staticSource = path.join(projectRoot, '.next', 'static');
const publicSource = path.join(projectRoot, 'public');
const driversSource = path.join(projectRoot, 'drivers');

const resourcesRoot = path.join(projectRoot, 'dist', 'electron-resources');
const standaloneDest = path.join(resourcesRoot, 'standalone');
const standaloneNodeModulesDest = path.join(resourcesRoot, 'standalone-node-modules');
const staticDest = path.join(standaloneDest, '.next', 'static');
const publicDest = path.join(standaloneDest, 'public');
const driversDest = path.join(resourcesRoot, 'drivers');
const chromeDest = path.join(resourcesRoot, 'chrome');
const workerRuntimeDest = path.join(resourcesRoot, 'worker-runtime');
const workerNodeModulesDest = path.join(resourcesRoot, 'worker-node-modules');
const workerTsconfigPath = path.join(projectRoot, 'tsconfig.worker.json');
const rootNodeModulesDir = path.join(projectRoot, 'node_modules');
const INCLUDE_PORTABLE_CHROME = process.env.BUNDLE_PORTABLE_CHROME === 'true';

const PRUNABLE_PACKAGE_DIRS = new Set([
  '__tests__',
  '__mocks__',
  '.github',
  '.vscode',
  'benchmark',
  'benchmarks',
  'coverage',
  'docs',
  'doc',
  'example',
  'examples',
  'test',
  'tests',
]);

const PRUNABLE_PACKAGE_EXTENSIONS = new Set(['.map', '.markdown', '.md']);
const PRUNABLE_PACKAGE_FILE_PATTERNS = [
  /^readme(?:\..+)?$/i,
  /^changelog(?:\..+)?$/i,
  /^changes(?:\..+)?$/i,
  /^history(?:\..+)?$/i,
  /^license(?:\..+)?$/i,
  /^licence(?:\..+)?$/i,
];

const WORKER_RUNTIME_DEPENDENCIES = [
  'csv-parser',
  'csv-writer',
  'parquetjs-lite',
  'proxy-chain',
  'selenium-webdriver',
];

function assertExists(filePath, label) {
  if (!fsSync.existsSync(filePath)) {
    throw new Error(`${label} was not found at ${filePath}`);
  }
}

async function copyDirectory(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true });
}

function shouldPrunePackageFile(fileName) {
  const normalized = fileName.toLowerCase();
  const extension = path.extname(normalized);

  if (PRUNABLE_PACKAGE_EXTENSIONS.has(extension)) {
    return true;
  }

  return PRUNABLE_PACKAGE_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}

async function pruneNodeModulesTree(rootDir) {
  if (!fsSync.existsSync(rootDir)) {
    return;
  }

  const pendingDirs = [rootDir];

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    if (!currentDir) {
      continue;
    }

    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (PRUNABLE_PACKAGE_DIRS.has(entry.name.toLowerCase())) {
          await fs.rm(entryPath, { recursive: true, force: true }).catch(() => undefined);
          continue;
        }

        pendingDirs.push(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (shouldPrunePackageFile(entry.name)) {
        await fs.rm(entryPath, { force: true }).catch(() => undefined);
      }
    }
  }
}

function findPackageRoot(startDir) {
  let currentDir = startDir;

  while (true) {
    const packageJsonPath = path.join(currentDir, 'package.json');
    if (fsSync.existsSync(packageJsonPath)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return undefined;
    }

    currentDir = parentDir;
  }
}

function resolveInstalledPackageDir(packageName, fromDir) {
  try {
    const resolvedEntry = require.resolve(packageName, { paths: [fromDir] });
    return findPackageRoot(path.dirname(resolvedEntry));
  } catch {
    return undefined;
  }
}

async function collectWorkerDependencyDirs() {
  const queue = WORKER_RUNTIME_DEPENDENCIES.map((name) => ({ name, fromDir: projectRoot }));
  const visitedDirs = new Set();
  const resolvedDirs = [];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) {
      continue;
    }

    const packageDir = resolveInstalledPackageDir(next.name, next.fromDir);
    if (!packageDir || visitedDirs.has(packageDir)) {
      continue;
    }

    visitedDirs.add(packageDir);
    resolvedDirs.push(packageDir);

    let packageJson;
    try {
      const raw = await fs.readFile(path.join(packageDir, 'package.json'), 'utf8');
      packageJson = JSON.parse(raw);
    } catch {
      continue;
    }

    const dependencyNames = [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.optionalDependencies ?? {}),
    ];

    for (const dependencyName of dependencyNames) {
      queue.push({ name: dependencyName, fromDir: packageDir });
    }
  }

  return resolvedDirs;
}

async function buildWorkerRuntime(outputDir) {
  assertExists(workerTsconfigPath, 'Worker runtime tsconfig');

  const tscScriptPath = path.join(projectRoot, 'node_modules', 'typescript', 'lib', 'tsc.js');
  assertExists(tscScriptPath, 'TypeScript compiler');

  await fs.rm(outputDir, { recursive: true, force: true });

  const result = spawnSync(
    process.execPath,
    [tscScriptPath, '--project', workerTsconfigPath, '--outDir', outputDir],
    {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
    }
  );

  if ((result.status ?? 1) !== 0) {
    throw new Error(`Worker runtime compilation failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

async function bundleWorkerNodeModules(destinationDir, dedupeSourceDir) {
  await fs.rm(destinationDir, { recursive: true, force: true });
  await fs.mkdir(destinationDir, { recursive: true });

  const dependencyDirs = await collectWorkerDependencyDirs();
  if (dependencyDirs.length === 0) {
    throw new Error('No worker runtime dependencies were resolved from node_modules.');
  }

  for (const dependencyDir of dependencyDirs) {
    const relativePath = path.relative(rootNodeModulesDir, dependencyDir);
    if (relativePath.startsWith('..')) {
      continue;
    }

    if (dedupeSourceDir) {
      const duplicatePath = path.join(dedupeSourceDir, relativePath);
      const duplicatePackageJsonPath = path.join(duplicatePath, 'package.json');
      if (fsSync.existsSync(duplicatePath) && fsSync.existsSync(duplicatePackageJsonPath)) {
        continue;
      }
    }

    const targetPath = path.join(destinationDir, relativePath);
    await copyDirectory(dependencyDir, targetPath);
  }

  await pruneNodeModulesTree(destinationDir);
}

async function copyStandaloneRuntime(source, destination) {
  const keepTopLevelEntries = new Set([
    '.env.production',
    '.next',
    'package.json',
    'public',
    'server.js',
  ]);

  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, {
    recursive: true,
    force: true,
    filter: (srcPath) => {
      const relative = path.relative(source, srcPath);

      if (!relative) {
        return true;
      }

      const topLevel = relative.split(path.sep)[0];
      return keepTopLevelEntries.has(topLevel);
    },
  });
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

async function pruneStandaloneDevArtifacts(targetDir) {
  const keepTopLevelEntries = new Set([
    '.env.production',
    '.next',
    'package.json',
    'public',
    'server.js',
  ]);

  const topLevelEntries = await fs.readdir(targetDir, { withFileTypes: true });

  await Promise.all(
    topLevelEntries
      .filter((entry) => !keepTopLevelEntries.has(entry.name))
      .map((entry) => fs.rm(path.join(targetDir, entry.name), { recursive: true, force: true })),
  );

  await Promise.all([
    fs.rm(path.join(targetDir, '.next', 'cache'), { recursive: true, force: true }),
    fs.rm(path.join(targetDir, 'public', 'automation-trace'), { recursive: true, force: true }),
  ]);
}

async function ensureEmptyRuntimeTemplates(targetDir) {
  const dataDir = path.join(targetDir, 'data');
  const storageDir = path.join(targetDir, 'storage');

  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(storageDir, { recursive: true, force: true });

  await fs.mkdir(path.join(dataDir, 'csvs'), { recursive: true });
  await fs.mkdir(path.join(dataDir, 'images'), { recursive: true });
  await fs.mkdir(path.join(storageDir, 'comment-test-dumps'), { recursive: true });
}

async function main() {
  assertExists(standaloneSource, 'Next standalone output');
  assertExists(standaloneNodeModulesSource, 'Next standalone node_modules output');
  assertExists(staticSource, 'Next static output');

  await fs.rm(resourcesRoot, { recursive: true, force: true });
  await fs.mkdir(resourcesRoot, { recursive: true });

  console.log('[copy-standalone] Building worker runtime ...');
  await buildWorkerRuntime(workerRuntimeDest);

  console.log('[copy-standalone] Bundling worker node_modules ...');
  await bundleWorkerNodeModules(workerNodeModulesDest, standaloneNodeModulesSource);

  console.log('[copy-standalone] Copying .next/standalone ...');
  await copyStandaloneRuntime(standaloneSource, standaloneDest);

  // Electron-builder can filter out directories literally named "node_modules"
  // from extraResources. Keep a duplicate in a neutral path and use NODE_PATH at runtime.
  console.log('[copy-standalone] Copying standalone node_modules -> resources/standalone-node-modules ...');
  await copyDirectory(standaloneNodeModulesSource, standaloneNodeModulesDest);

  console.log('[copy-standalone] Pruning standalone node_modules (docs/tests/sourcemaps) ...');
  await pruneNodeModulesTree(standaloneNodeModulesDest);

  // Standalone tracing can occasionally include large dev-only folders.
  // Prune these aggressively to keep packaged payloads deterministic and small.
  console.log('[copy-standalone] Pruning standalone dev-only artifacts ...');
  await pruneStandaloneDevArtifacts(standaloneDest);

  console.log('[copy-standalone] Copying .next/static -> standalone/.next/static ...');
  await copyDirectory(staticSource, staticDest);

  console.log('[copy-standalone] Copying public -> standalone/public ...');
  await copyIfExists(publicSource, publicDest);

  console.log('[copy-standalone] Resetting standalone data/storage templates (empty only) ...');
  await ensureEmptyRuntimeTemplates(standaloneDest);

  console.log('[copy-standalone] Copying environment file -> standalone/.env.production ...');
  await copyEnvFileToStandalone(standaloneDest);

  console.log('[copy-standalone] Copying drivers -> resources/drivers ...');
  await copyIfExists(driversSource, driversDest);

  const chromeSourceDir = resolveChromeSourceDir();
  if (INCLUDE_PORTABLE_CHROME && chromeSourceDir) {
    console.log(`[copy-standalone] Copying Chrome bundle from ${chromeSourceDir} ...`);
    await copyDirectory(chromeSourceDir, chromeDest);
  } else {
    await fs.mkdir(chromeDest, { recursive: true });

    if (INCLUDE_PORTABLE_CHROME) {
      console.warn(
        '[copy-standalone] No portable Chrome binary was found. The packaged app will require a system Chrome installation unless you place chrome.exe under chrome/, chrome-win64/, drivers/chrome/, or drivers/chrome-win64/.'
      );
    } else {
      console.log(
        '[copy-standalone] Skipping portable Chrome bundle by default. Set BUNDLE_PORTABLE_CHROME=true to include it.'
      );
    }
  }

  console.log(`[copy-standalone] Electron resources prepared at ${resourcesRoot}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[copy-standalone] ${message}`);
  process.exit(1);
});
