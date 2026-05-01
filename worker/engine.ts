import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createConnection, type Socket } from "node:net";

import csvParser from "csv-parser";
import { createObjectCsvWriter } from "csv-writer";
import { Builder, By, Key, until } from "selenium-webdriver";
import type { IWebDriverOptionsCookie, WebDriver } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome";
import parquet from "parquetjs-lite";

import {
  getRuntimeDataDir,
  getRuntimeStorageDir,
  getRuntimeTraceDir,
  isUserDataRuntime,
} from "../src/lib/runtimePaths";
import { parseTwoFactorInput } from "../src/lib/twoFactor";

interface FbAccountRecord {
  id: string;
  name: string;
  username: string;
  password: string;
  twoFactorSecret?: string;
  proxyId?: string;
  socks5ProxyHost?: string;
  socks5ProxyPort?: number;
  socks5ProxyUsername?: string;
  socks5ProxyPassword?: string;
  isActive: boolean;
  disabledAt?: string;
  disabledUntil?: string;
  disabledReason?: string;
  disabledType?: "manual" | "automatic";
  createdAt: string;
  updatedAt: string;
}

interface FbGroupRecord {
  id: string;
  groupId: string;
  csvPath: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ProxyRecord {
  id: string;
  ipAddress: string;
  port: number;
  username?: string;
  password?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface CsvPostRow {
  post_text: string;
  image_url: string;
  comment_link: string;
  status: string;
}

interface PendingPost {
  row: CsvPostRow;
  rowIndex: number;
}

interface ClaimedPost extends PendingPost {
  claimToken: string;
}

interface LogRecord {
  id: string;
  level: "info" | "success" | "error";
  message: string;
  accountId?: string;
  groupId?: string;
  details?: string;
  createdAt: string;
}

interface PostResult {
  success: boolean;
  message: string;
  details?: string;
  commentWarning?: string;
}

interface ProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

type ProxyProtocol = "socks5" | "http";

interface LocalProxyBridge {
  localProxyUrl: string;
  close: () => Promise<void>;
}

type SessionStore = Record<string, IWebDriverOptionsCookie[]>;
type StateValue = "running" | "stopped";

interface AutomationSettings {
  parallelAccounts: number;
  waitIntervalMinutes: number;
  delayBetweenAccountsMinutes: number;
  postsPerGroup: number;
  maxPostsPerAccountPerCycle: number;
  postsPerSession: number;
  commentWithPostImage: boolean;
  proxyRotationEnabled: boolean;
  visibleBrowser: boolean;
}

interface AutomationConfig {
  state: StateValue;
  settings: AutomationSettings;
  updatedAt: string;
}

type ParquetField = {
  type: "UTF8" | "BOOLEAN" | "INT32";
  optional?: boolean;
};

const POLL_INTERVAL_MS = 60_000;
const STOPPED_POLL_INTERVAL_MS = 2_000;
const STOP_CHECK_INTERVAL_MS = 1_000;
const ACTION_BLOCK_COOLDOWN_MS =
  Math.max(5, Number.parseInt(process.env.WORKER_ACTION_BLOCK_COOLDOWN_MINUTES ?? "45", 10) || 45) * 60_000;
const AUTO_DISABLE_ACCOUNT_ON_ACTION_BLOCK = process.env.WORKER_AUTO_DISABLE_ON_LIMIT === "true";
const STORAGE_DIR = getRuntimeStorageDir();
const AUTOMATION_STATE_PATH = path.join(STORAGE_DIR, "automation_state.json");
const LOGS_PARQUET_PATH = path.join(STORAGE_DIR, "logs.parquet");
const FB_ACCOUNTS_PARQUET_PATH = path.join(STORAGE_DIR, "fbAccounts.parquet");
const FB_GROUPS_PARQUET_PATH = path.join(STORAGE_DIR, "fbGroups.parquet");
const PROXIES_PARQUET_PATH = path.join(STORAGE_DIR, "proxies.parquet");
const SESSION_STORE_PATH = path.join(STORAGE_DIR, "facebook_sessions.json");
const WORKER_LOCK_PATH = path.join(STORAGE_DIR, "worker.lock");
const IS_DRY_RUN = process.env.WORKER_DRY_RUN === "true";
const DEFAULT_VISIBLE_BROWSER = process.env.WORKER_VISIBLE_BROWSER === "true";
const ENABLE_VISUAL_TRACE = false;
const DEFAULT_SKIP_PREFLIGHT_IN_VISIBLE_MODE =
  process.env.WORKER_SKIP_PREFLIGHT_IN_VISIBLE_MODE !== "false";
const DEBUG_BROWSER_HOLD_FAILURE_ONLY =
  process.env.WORKER_DEBUG_BROWSER_HOLD_FAILURE_ONLY !== "false";
const TEMP_IMAGE_DIR = path.join(os.tmpdir(), "sheet2social-worker");
const SCREENSHOT_OUTPUT_DIR = getRuntimeTraceDir();
const SCREENSHOT_REFERENCE_PREFIX = "/automation-trace";
const MAX_TRACE_SCREENSHOTS = 220;
const PARQUET_READ_RETRY_COUNT = 3;
const PARQUET_RETRY_DELAY_MS = 35;
const PROXY_TUNNEL_TIMEOUT_MS = 25_000;
const PUBLIC_IP_PAGELOAD_TIMEOUT_MS = 8_000;
const PUBLIC_IP_CHECK_ENDPOINTS = [
  "https://api64.ipify.org?format=json",
  "https://api.ipify.org?format=json",
  "https://ipv4.icanhazip.com",
  "https://ifconfig.me/ip",
];
let logWriteQueue: Promise<void> = Promise.resolve();
const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  parallelAccounts: 3,
  waitIntervalMinutes: 5,
  delayBetweenAccountsMinutes: 1,
  postsPerGroup: 1,
  maxPostsPerAccountPerCycle: 10,
  postsPerSession: 20,
  commentWithPostImage: false,
  proxyRotationEnabled: false,
  visibleBrowser: DEFAULT_VISIBLE_BROWSER,
};

const CSV_HEADERS: Array<keyof CsvPostRow> = [
  "post_text",
  "image_url",
  "comment_link",
  "status",
];

const logsSchema: Record<string, ParquetField> = {
  id: { type: "UTF8" },
  level: { type: "UTF8" },
  message: { type: "UTF8" },
  accountId: { type: "UTF8", optional: true },
  groupId: { type: "UTF8", optional: true },
  details: { type: "UTF8", optional: true },
  createdAt: { type: "UTF8" },
};

const fbAccountsSchema: Record<string, ParquetField> = {
  id: { type: "UTF8" },
  name: { type: "UTF8" },
  alias: { type: "UTF8", optional: true },
  username: { type: "UTF8" },
  password: { type: "UTF8" },
  twoFactorSecret: { type: "UTF8", optional: true },
  proxyId: { type: "UTF8", optional: true },
  socks5ProxyHost: { type: "UTF8", optional: true },
  socks5ProxyPort: { type: "INT32", optional: true },
  socks5ProxyUsername: { type: "UTF8", optional: true },
  socks5ProxyPassword: { type: "UTF8", optional: true },
  postFilter: { type: "UTF8", optional: true },
  postingMethod: { type: "UTF8", optional: true },
  isActive: { type: "BOOLEAN" },
  disabledAt: { type: "UTF8", optional: true },
  disabledUntil: { type: "UTF8", optional: true },
  disabledReason: { type: "UTF8", optional: true },
  disabledType: { type: "UTF8", optional: true },
  createdAt: { type: "UTF8" },
  updatedAt: { type: "UTF8" },
};

let lastObservedAutomationState: StateValue | undefined;
const readyAccountSessions = new Set<string>();
const accountCooldownUntil = new Map<string, number>();
const accountGroupCursor = new Map<string, number>();
const csvFileWriteLocks = new Map<string, Promise<void>>();

class AutomationStopRequestedError extends Error {
  constructor(message = "Automation stop requested by user.") {
    super(message);
    this.name = "AutomationStopRequestedError";
  }
}

function isAutomationStopRequestedError(error: unknown): error is AutomationStopRequestedError {
  return error instanceof AutomationStopRequestedError;
}

function isActionBlockedMessage(message: string | undefined): boolean {
  const text = normalizeForComparison(message ?? "");
  return (
    text.includes("temporarily limited") ||
    text.includes("limit how often you can post") ||
    text.includes("try again later")
  );
}

function isRecoverableBrowserSessionError(message: string | undefined): boolean {
  const text = normalizeForComparison(message ?? "");
  return (
    text.includes("nosuchsessionerror") ||
    text.includes("nosuchwindowerror") ||
    text.includes("no such window") ||
    text.includes("target window already closed") ||
    text.includes("web view not found") ||
    text.includes("chrome not reachable") ||
    text.includes("invalid session id") ||
    text.includes("session deleted as the browser has closed") ||
    text.includes("stale element reference") ||
    text.includes("not connected to devtools")
  );
}

function isRecoverablePublishFlowError(
  message: string | undefined,
  details: string | undefined
): boolean {
  const text = normalizeForComparison(`${message ?? ""} ${details ?? ""}`);
  return (
    text.includes("timed out waiting for the post composer textbox") ||
    text.includes("timed out waiting for xpaths") ||
    text.includes("timed out waiting for selectors") ||
    text.includes("post composer did not close after clicking post")
  );
}

function getSkippablePostFailureStatus(
  message: string | undefined,
  details: string | undefined
): string | undefined {
  const text = normalizeForComparison(`${message ?? ""} ${details ?? ""}`);
  if (text.includes("post text is empty") || text.includes("nothing to publish")) {
    return "failed:empty-post-text";
  }

  return undefined;
}

function getAccountCooldownRemainingMs(accountId: string): number {
  const until = accountCooldownUntil.get(accountId);
  if (!until) {
    return 0;
  }

  const remaining = until - Date.now();
  if (remaining <= 0) {
    accountCooldownUntil.delete(accountId);
    return 0;
  }

  return remaining;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readWorkerLockPid(): Promise<number | undefined> {
  try {
    const content = (await fs.readFile(WORKER_LOCK_PATH, "utf8")).trim();
    const pid = Number.parseInt(content, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function acquireWorkerLock(): Promise<void> {
  await ensureStorageDir();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(WORKER_LOCK_PATH, "wx");
      await handle.writeFile(String(process.pid), "utf8");
      await handle.close();
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EEXIST") {
        throw error;
      }

      const existingPid = await readWorkerLockPid();
      if (existingPid && existingPid !== process.pid && isProcessAlive(existingPid)) {
        throw new Error(
          `Another worker instance is already running (PID ${existingPid}). Stop it before starting a new worker.`
        );
      }

      await fs.rm(WORKER_LOCK_PATH, { force: true }).catch(() => undefined);
    }
  }

  throw new Error("Could not acquire worker lock.");
}

async function releaseWorkerLock(): Promise<void> {
  const existingPid = await readWorkerLockPid();
  if (!existingPid || existingPid === process.pid) {
    await fs.rm(WORKER_LOCK_PATH, { force: true }).catch(() => undefined);
  }
}

async function holdVisibleBrowserForDebug(
  contextLabel: string,
  visibleBrowser: boolean,
  shouldHold: boolean
): Promise<void> {
  const holdMs = resolveDebugBrowserHoldMs(visibleBrowser);
  if (!visibleBrowser || !shouldHold || holdMs <= 0) {
    return;
  }

  await appendLog({
    level: "info",
    message: `[Debug] Keeping browser open for ${Math.round(
      holdMs / 1000
    )}s (${contextLabel}).`,
  }).catch(() => undefined);

  await sleep(holdMs).catch(() => undefined);
}

async function ensureStorageDir(): Promise<void> {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
}

function toStateValue(rawState: unknown): StateValue {
  const normalized = String(rawState ?? "").trim().toLowerCase();
  return normalized === "running" ? "running" : "stopped";
}

function normalizeAutomationSettings(raw: unknown): AutomationSettings {
  if (!raw || typeof raw !== "object") {
    return DEFAULT_AUTOMATION_SETTINGS;
  }

  const candidate = raw as Partial<AutomationSettings>;
  const normalizedParallelAccounts = Math.max(
    1,
    Math.floor(
      typeof candidate.parallelAccounts === "number"
        ? candidate.parallelAccounts
        : DEFAULT_AUTOMATION_SETTINGS.parallelAccounts
    )
  );
  const normalizedWaitIntervalMinutes = Math.max(
    1,
    Math.floor(
      typeof candidate.waitIntervalMinutes === "number"
        ? candidate.waitIntervalMinutes
        : DEFAULT_AUTOMATION_SETTINGS.waitIntervalMinutes
    )
  );
  const normalizedDelayBetweenAccountsMinutes = Math.max(
    0,
    Math.floor(
      typeof candidate.delayBetweenAccountsMinutes === "number"
        ? candidate.delayBetweenAccountsMinutes
        : DEFAULT_AUTOMATION_SETTINGS.delayBetweenAccountsMinutes
    )
  );
  const normalizedPostsPerGroup = Math.max(
    1,
    Math.floor(
      typeof candidate.postsPerGroup === "number"
        ? candidate.postsPerGroup
        : DEFAULT_AUTOMATION_SETTINGS.postsPerGroup
    )
  );
  const normalizedMaxPostsPerAccountPerCycle = Math.max(
    1,
    Math.floor(
      typeof candidate.maxPostsPerAccountPerCycle === "number"
        ? candidate.maxPostsPerAccountPerCycle
        : DEFAULT_AUTOMATION_SETTINGS.maxPostsPerAccountPerCycle
    )
  );

  return {
    parallelAccounts: normalizedParallelAccounts,
    waitIntervalMinutes: normalizedWaitIntervalMinutes,
    delayBetweenAccountsMinutes: normalizedDelayBetweenAccountsMinutes,
    postsPerGroup: normalizedPostsPerGroup,
    maxPostsPerAccountPerCycle: normalizedMaxPostsPerAccountPerCycle,
    postsPerSession: Math.max(
      1,
      Math.floor(
        typeof candidate.postsPerSession === "number"
          ? candidate.postsPerSession
          : normalizedParallelAccounts * normalizedMaxPostsPerAccountPerCycle
      )
    ),
    commentWithPostImage:
      typeof candidate.commentWithPostImage === "boolean"
        ? candidate.commentWithPostImage
        : DEFAULT_AUTOMATION_SETTINGS.commentWithPostImage,
    proxyRotationEnabled:
      typeof candidate.proxyRotationEnabled === "boolean"
        ? candidate.proxyRotationEnabled
        : DEFAULT_AUTOMATION_SETTINGS.proxyRotationEnabled,
    visibleBrowser:
      typeof candidate.visibleBrowser === "boolean"
        ? candidate.visibleBrowser
        : DEFAULT_AUTOMATION_SETTINGS.visibleBrowser,
  };
}

function resolveVisibleBrowser(settings?: AutomationSettings): boolean {
  if (typeof settings?.visibleBrowser === "boolean") {
    return settings.visibleBrowser;
  }

  return DEFAULT_VISIBLE_BROWSER;
}

function resolveSkipPreflightInVisibleMode(visibleBrowser: boolean): boolean {
  return visibleBrowser && DEFAULT_SKIP_PREFLIGHT_IN_VISIBLE_MODE;
}

function resolveDebugBrowserHoldMs(visibleBrowser: boolean): number {
  const fallback = visibleBrowser ? "15000" : "0";
  const rawValue = process.env.WORKER_DEBUG_BROWSER_HOLD_MS ?? fallback;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return parsed;
}

async function readAutomationConfig(): Promise<AutomationConfig> {
  await ensureStorageDir();

  try {
    const content = await fs.readFile(AUTOMATION_STATE_PATH, "utf8");
    const payload = JSON.parse(content) as {
      state?: string;
      settings?: Partial<AutomationSettings>;
      updatedAt?: string;
    };

    return {
      state: toStateValue(payload.state),
      settings: normalizeAutomationSettings(payload.settings),
      updatedAt:
        typeof payload.updatedAt === "string" && payload.updatedAt.trim().length > 0
          ? payload.updatedAt
          : new Date(0).toISOString(),
    };
  } catch {
    return {
      state: "stopped",
      settings: DEFAULT_AUTOMATION_SETTINGS,
      updatedAt: new Date(0).toISOString(),
    };
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function buildAutomationControlToken(config: AutomationConfig): string {
  return `${config.state}:${config.updatedAt}`;
}

async function isAutomationRunning(): Promise<boolean> {
  const automation = await readAutomationConfig();
  return automation.state === "running";
}

async function throwIfAutomationStopped(context: string): Promise<void> {
  if (!(await isAutomationRunning())) {
    throw new AutomationStopRequestedError(`Automation stop requested by user (${context}).`);
  }
}

async function sleepWithStopCheck(ms: number, context: string): Promise<void> {
  const deadline = Date.now() + Math.max(0, ms);

  while (Date.now() < deadline) {
    await throwIfAutomationStopped(context);

    const remaining = deadline - Date.now();
    await sleep(Math.min(STOP_CHECK_INTERVAL_MS, remaining));
  }
}

function buildTempParquetPath(filePath: string): string {
  return `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
}

function isTransientFileWriteError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY" || code === "EEXIST";
}

function isRetryableParquetReadError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (
    code === "ERR_OUT_OF_RANGE" ||
    code === "ENOENT" ||
    code === "EPERM" ||
    code === "EACCES" ||
    code === "EBUSY"
  ) {
    return true;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("out of range") ||
    message.includes("unexpected end") ||
    message.includes("invalid parquet") ||
    message.includes("no such file or directory")
  );
}

async function replaceFileWithRetry(tempFilePath: string, filePath: string): Promise<void> {
  const maxAttempts = 5;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await fs.rename(tempFilePath, filePath);
      return;
    } catch (error) {
      if (!isTransientFileWriteError(error) || attempt === maxAttempts - 1) {
        throw error;
      }

      // On Windows, rename can fail while destination exists/is temporarily locked.
      await fs.rm(filePath, { force: true }).catch(() => undefined);
      await sleep(PARQUET_RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

async function readParquetRows<T>(filePath: string): Promise<T[]> {
  try {
    await fs.access(filePath);
  } catch {
    return [];
  }

  for (let attempt = 0; attempt <= PARQUET_READ_RETRY_COUNT; attempt += 1) {
    let reader: Awaited<ReturnType<typeof parquet.ParquetReader.openFile>> | undefined;

    try {
      reader = await parquet.ParquetReader.openFile(filePath);

      const cursor = reader.getCursor();
      const rows: T[] = [];

      let row = await cursor.next();
      while (row) {
        rows.push(row as T);
        row = await cursor.next();
      }

      return rows;
    } catch (error) {
      if (!isRetryableParquetReadError(error) || attempt === PARQUET_READ_RETRY_COUNT) {
        throw error;
      }

      await sleep(PARQUET_RETRY_DELAY_MS * (attempt + 1));
    } finally {
      if (reader) {
        await reader.close().catch(() => undefined);
      }
    }
  }

  return [];
}

interface BrowserLaunchResult {
  driver: WebDriver;
  cleanup: () => Promise<void>;
  proxyProtocol?: ProxyProtocol;
}

function toProxyConfig(proxy: ProxyRecord): ProxyConfig {
  return {
    host: proxy.ipAddress,
    port: proxy.port,
    username: proxy.username,
    password: proxy.password,
  };
}

function getStickyProxyIndex(accountId: string, poolSize: number): number {
  if (poolSize <= 0) {
    return 0;
  }

  let hash = 0;
  for (let index = 0; index < accountId.length; index += 1) {
    hash = (hash * 31 + accountId.charCodeAt(index)) >>> 0;
  }

  return hash % poolSize;
}

async function resolveAccountProxyConfig(
  account: FbAccountRecord,
  settings?: AutomationSettings
): Promise<ProxyConfig | undefined> {
  const shouldReadProxyPool = Boolean(account.proxyId) || Boolean(settings?.proxyRotationEnabled);
  const enabledPool = shouldReadProxyPool
    ? (await readParquetRows<ProxyRecord>(PROXIES_PARQUET_PATH)).filter((proxy) => proxy.enabled !== false)
    : [];

  if (account.proxyId) {
    const selected = enabledPool.find((proxy) => proxy.id === account.proxyId);

    if (selected) {
      return toProxyConfig(selected);
    }
  }

  if (account.socks5ProxyHost && account.socks5ProxyPort) {
    return {
      host: account.socks5ProxyHost,
      port: account.socks5ProxyPort,
      username: account.socks5ProxyUsername,
      password: account.socks5ProxyPassword,
    };
  }

  if (settings?.proxyRotationEnabled && enabledPool.length > 0) {
    const stickyIndex = getStickyProxyIndex(account.id, enabledPool.length);
    return toProxyConfig(enabledPool[stickyIndex]);
  }

  return undefined;
}

async function writeParquetRows<T>(
  filePath: string,
  schemaDefinition: Record<string, ParquetField>,
  rows: T[]
): Promise<void> {
  await ensureStorageDir();

  const tempFilePath = buildTempParquetPath(filePath);
  const schema = new parquet.ParquetSchema(schemaDefinition);
  let writer: Awaited<ReturnType<typeof parquet.ParquetWriter.openFile>> | undefined;

  try {
    writer = await parquet.ParquetWriter.openFile(schema, tempFilePath);

    for (const row of rows) {
      await writer.appendRow(row as object);
    }

    await writer.close();
    writer = undefined;

    await replaceFileWithRetry(tempFilePath, filePath);
  } catch (error) {
    if (writer) {
      await writer.close().catch(() => undefined);
    }

    await fs.rm(tempFilePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function appendLog(log: Omit<LogRecord, "id" | "createdAt">): Promise<void> {
  const entry: LogRecord = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...log,
  };

  const printable = `[${entry.level.toUpperCase()}] ${entry.message}`;
  if (entry.level === "error") {
    console.error(printable);
  } else {
    console.log(printable);
  }

  // Serialize parquet writes and swallow transient failures so logging never crashes the worker.
  logWriteQueue = logWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const existing = await readParquetRows<LogRecord>(LOGS_PARQUET_PATH);
      await writeParquetRows(LOGS_PARQUET_PATH, logsSchema, [...existing, entry]);
    })
    .catch((error) => {
      const details = error instanceof Error ? error.message : String(error ?? "Unknown log write error");
      console.error(`[LOG-WRITE-ERROR] ${details}`);
    });

  await logWriteQueue;
}

async function isAccountEnabledInDashboard(accountId: string): Promise<boolean> {
  const accounts = await readParquetRows<FbAccountRecord>(FB_ACCOUNTS_PARQUET_PATH);
  const account = accounts.find((item) => item.id === accountId);

  if (!account) {
    return false;
  }

  if (account.isActive) {
    return true;
  }

  const disabledUntilMs = account.disabledUntil ? Date.parse(account.disabledUntil) : Number.NaN;
  if (
    account.disabledType === "automatic" &&
    Number.isFinite(disabledUntilMs) &&
    disabledUntilMs <= Date.now()
  ) {
    await setAccountEnabledInDashboard(accountId, true).catch(() => undefined);
    return true;
  }

  return false;
}

async function setAccountEnabledInDashboard(
  accountId: string,
  enabled: boolean,
  disableInfo?: {
    reason: string;
    type: "manual" | "automatic";
    until?: string;
  }
): Promise<boolean> {
  const accounts = await readParquetRows<FbAccountRecord>(FB_ACCOUNTS_PARQUET_PATH);
  const index = accounts.findIndex((item) => item.id === accountId);

  if (index < 0) {
    return false;
  }

  if (accounts[index].isActive === enabled) {
    return true;
  }

  accounts[index] = {
    ...accounts[index],
    isActive: enabled,
    disabledAt: enabled ? undefined : new Date().toISOString(),
    disabledUntil: enabled ? undefined : disableInfo?.until,
    disabledReason: enabled === false && disableInfo ? disableInfo.reason : undefined,
    disabledType: enabled === false && disableInfo ? disableInfo.type : undefined,
    updatedAt: new Date().toISOString(),
  };

  await writeParquetRows(FB_ACCOUNTS_PARQUET_PATH, fbAccountsSchema, accounts);
  return true;
}

type StepLogger = (step: string, detail?: string) => Promise<void>;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeForComparison(value: string): string {
  return normalizeWhitespace(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u064b-\u065f\u0670]/g, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"');
}

function sanitizeTraceLabel(label: string): string {
  const normalized = label
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!normalized) {
    return "trace";
  }

  return normalized.slice(0, 80);
}

async function cleanupTraceScreenshots(): Promise<void> {
  try {
    const files = await fs.readdir(SCREENSHOT_OUTPUT_DIR);
    const pngFiles = files.filter((file) => file.toLowerCase().endsWith(".png"));

    if (pngFiles.length <= MAX_TRACE_SCREENSHOTS) {
      return;
    }

    const withStats = await Promise.all(
      pngFiles.map(async (fileName) => {
        const absolutePath = path.join(SCREENSHOT_OUTPUT_DIR, fileName);
        const stat = await fs.stat(absolutePath);
        return {
          absolutePath,
          modifiedAtMs: stat.mtimeMs,
        };
      })
    );

    withStats.sort((left, right) => left.modifiedAtMs - right.modifiedAtMs);
    const overflowCount = withStats.length - MAX_TRACE_SCREENSHOTS;

    for (let index = 0; index < overflowCount; index += 1) {
      await fs.unlink(withStats[index].absolutePath).catch(() => undefined);
    }
  } catch {
    // Best-effort cleanup.
  }
}

async function captureScreenshot(driver: WebDriver, label: string): Promise<string | undefined> {
  void driver;
  void label;
  return undefined;
}

async function appendVisualTraceLog(
  driver: WebDriver,
  log: Omit<LogRecord, "id" | "createdAt">,
  screenshotLabel: string
): Promise<void> {
  if (!ENABLE_VISUAL_TRACE) {
    return;
  }

  const screenshotUrl = await captureScreenshot(driver, screenshotLabel);
  const detailsParts: string[] = [];

  if (log.details?.trim()) {
    detailsParts.push(log.details.trim());
  }

  if (screenshotUrl) {
    detailsParts.push(`Screenshot: ${screenshotUrl}`);
  }

  await appendLog({
    ...log,
    details: detailsParts.length > 0 ? detailsParts.join(" | ") : undefined,
  });
}

async function setEditableText(
  driver: WebDriver,
  element: Awaited<ReturnType<WebDriver["findElement"]>>,
  value: string
): Promise<void> {
  const normalizedValue = String(value ?? "").replace(/\r\n/g, "\n");
  const expectedProbe = normalizeForComparison(normalizedValue).slice(0, Math.min(32, normalizedValue.length));

  try {
    await element.click().catch(() => undefined);
    await element.sendKeys(Key.chord(Key.CONTROL, "a")).catch(() => undefined);
    await element.sendKeys(Key.BACK_SPACE).catch(() => undefined);
    if (normalizedValue) {
      await element.sendKeys(normalizedValue);
    }

    const typedText = normalizeForComparison(
      `${await element.getText()} ${(await element.getAttribute("textContent")) ?? ""}`
    );

    if (!expectedProbe || typedText.includes(expectedProbe)) {
      return;
    }
  } catch {
    // Fall back to JS write path if native typing fails.
  }

  await driver.executeScript(
    `
      const el = arguments[0];
      const nextValue = String(arguments[1] ?? "");

      const dispatchInputEvents = () => {
        el.dispatchEvent(new Event("input", { bubbles: true }));

        el.dispatchEvent(new Event("change", { bubbles: true }));
      };

      const contentEditableAttr = String(el.getAttribute?.("contenteditable") ?? "").toLowerCase();
      const isContentEditable = Boolean(el.isContentEditable) || contentEditableAttr === "true";

      if (typeof el.focus === "function") {
        el.focus();
      }

      if (isContentEditable) {
        const selection = window.getSelection();
        if (selection) {
          selection.removeAllRanges();
          const clearRange = document.createRange();
          clearRange.selectNodeContents(el);
          selection.addRange(clearRange);
        }

        if (typeof document.execCommand === "function") {
          try {
            document.execCommand("selectAll", false);
          } catch {
            // Ignore unsupported command.
          }
          try {
            document.execCommand("delete", false);
          } catch {
            // Ignore unsupported command.
          }
          try {
            document.execCommand("insertText", false, nextValue);
          } catch {
            // Ignore unsupported command.
          }
        }

        if ((el.textContent ?? "") !== nextValue) {
          el.textContent = nextValue;
        }

        if (selection) {
          const endRange = document.createRange();
          endRange.selectNodeContents(el);
          endRange.collapse(false);
          selection.removeAllRanges();
          selection.addRange(endRange);
        }

        dispatchInputEvents();
        return;
      }

      if ("value" in el) {
        el.value = nextValue;
        dispatchInputEvents();
        return;
      }

      el.textContent = nextValue;
      dispatchInputEvents();
    `,
    element,
    value
  );
}

function createPostVerificationSnippet(postText: string): string {
  const normalized = normalizeLooseMatch(postText);
  return normalized.slice(0, Math.min(160, normalized.length));
}

function normalizeLooseMatch(value: string): string {
  return normalizeForComparison(value)
    .replace(/[^a-z0-9\u0600-\u06ff\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildWordTokens(value: string): string[] {
  const normalized = normalizeLooseMatch(value);
  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);

  return [...new Set(tokens)].slice(0, 40);
}

function scoreWordOverlap(haystack: string, needles: string[]): number {
  if (!haystack || needles.length === 0) {
    return 0;
  }

  let hits = 0;
  for (const token of needles) {
    if (haystack.includes(token)) {
      hits += 1;
    }
  }

  if (hits >= 10) {
    return 16;
  }

  if (hits >= 6) {
    return 10;
  }

  if (hits >= 3) {
    return 4;
  }

  return hits;
}

function buildMatchFragments(value: string): string[] {
  const normalized = normalizeForComparison(value);
  const looseNormalized = normalizeLooseMatch(value);
  const fragments = new Set<string>();

  if (normalized.length > 0) {
    fragments.add(normalized.slice(0, Math.min(normalized.length, 180)));
  }

  if (looseNormalized.length > 0) {
    fragments.add(looseNormalized.slice(0, Math.min(looseNormalized.length, 180)));
  }

  for (const part of looseNormalized.split(/[\n\r]+|[.!?]+/g)) {
    const trimmed = part.trim();
    if (trimmed.length >= 12) {
      fragments.add(trimmed.slice(0, 180));
    }
  }

  const words = looseNormalized.split(/\s+/).filter(Boolean);
  for (let size = 4; size <= 8; size += 1) {
    for (let index = 0; index + size <= words.length; index += Math.max(1, size - 2)) {
      const fragment = words.slice(index, index + size).join(" ").trim();
      if (fragment.length >= 12) {
        fragments.add(fragment.slice(0, 120));
      }
    }
  }

  return [...fragments].slice(0, 24);
}

async function resolveContainerFromStoryBlock(
  block: Awaited<ReturnType<WebDriver["findElement"]>>
): Promise<Awaited<ReturnType<WebDriver["findElement"]>>> {
  const roleArticle = await block.findElements(By.xpath("ancestor::div[@role='article'][1]"));
  if (roleArticle[0]) {
    return roleArticle[0];
  }

  const fallback = await block.findElements(
    By.xpath(
      "ancestor::*[.//*[@data-ad-rendering-role='comment_button' or (@aria-label and contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'comment'))]][1]"
    )
  );

  if (fallback[0]) {
    return fallback[0];
  }

  throw new Error("Could not resolve a container for the matched story block.");
}

async function findMatchingArticle(
  driver: WebDriver,
  expectedText: string,
  authorHints: string[] = []
): Promise<Awaited<ReturnType<WebDriver["findElement"]>>> {
  const normalizedExpectedText = normalizeLooseMatch(expectedText);
  const expectedWordTokens = buildWordTokens(expectedText);
  const fragments = buildMatchFragments(expectedText);
  const normalizedAuthorHints = authorHints
    .map((value) => normalizeLooseMatch(value))
    .filter((value) => value.length >= 2);
  const authorWordTokens = buildWordTokens(normalizedAuthorHints.join(" "));

  const storyBlocks = await driver.findElements(By.css("[data-ad-rendering-role='story_message']"));
  for (const block of storyBlocks.slice(0, 40)) {
    try {
      const storyText = normalizeLooseMatch(await block.getText());
      if (!storyText) {
        continue;
      }

      let matched = storyText.includes(normalizedExpectedText);
      for (const fragment of fragments) {
        if (storyText.includes(fragment)) {
          matched = true;
          break;
        }
      }

      if (!matched) {
        continue;
      }

      return await resolveContainerFromStoryBlock(block);
    } catch {
      // Ignore detached blocks and continue scanning.
    }
  }

  const articles = await getCandidateContainers(driver);
  let bestArticle: Awaited<ReturnType<WebDriver["findElement"]>> | undefined;
  let bestScore = 0;

  for (const article of articles.slice(0, 40)) {
    try {
      const articleText = normalizeForComparison(await article.getText());
      const looseArticleText = normalizeLooseMatch(articleText);
      let score = 0;

      if (looseArticleText.includes(normalizedExpectedText)) {
        score += 20;
      }

      for (const fragment of fragments) {
        if (fragment.length >= 12 && looseArticleText.includes(fragment)) {
          score += 2;
        }
      }

      score += scoreWordOverlap(looseArticleText, expectedWordTokens);

      if (normalizedAuthorHints.some((hint) => looseArticleText.includes(hint))) {
        score += 12;
      }

      score += Math.min(6, scoreWordOverlap(looseArticleText, authorWordTokens));

      const storyTextBlocks = await article.findElements(By.css("[data-ad-rendering-role='story_message']"));
      for (const block of storyTextBlocks.slice(0, 3)) {
        try {
          const storyText = normalizeLooseMatch(await block.getText());
          if (storyText.includes(normalizedExpectedText)) {
            score += 20;
          }

          for (const fragment of fragments) {
            if (fragment.length >= 12 && storyText.includes(fragment)) {
              score += 3;
            }
          }
        } catch {
          // Ignore detached story blocks and continue.
        }
      }

      if ((await article.findElements(By.css("[aria-label='Actions for this post']"))).length > 0) {
        score += 2;
      }

      if (
        (await article.findElements(
          By.xpath(
            ".//*[@aria-label and contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'comment')]"
          )
        )).length > 0
      ) {
        score += 1;
      }

      if (score > bestScore) {
        bestScore = score;
        bestArticle = article;
      }
    } catch {
      // Ignore detached elements and continue scanning.
    }
  }

  if (bestArticle && bestScore >= 4) {
    return bestArticle;
  }

  if (bestArticle) {
    return bestArticle;
  }

  throw new Error("Could not match the target posted item in the group feed.");
}

async function detectComposerAuthorHint(driver: WebDriver): Promise<string | undefined> {
  const dialogs = await driver.findElements(By.css("div[role='dialog']"));
  const blockedSnippets = [
    "create post",
    "creer une publication",
    "post anonymously",
    "publier de maniere anonyme",
    "private group",
    "groupe prive",
    "public group",
    "add to your post",
    "ajouter a votre publication",
    "photo/video",
    "photo / video",
    "comment",
    "post",
    "publier",
    "نشر",
  ];

  for (const dialog of dialogs) {
    try {
      if (!(await dialog.isDisplayed())) {
        continue;
      }

      const dialogText = normalizeForComparison(await dialog.getText());
      const dialogLabel = normalizeForComparison((await dialog.getAttribute("aria-label")) ?? "");

      if (!isComposerSurfaceText(dialogText) && !isComposerDialogLabel(dialogLabel)) {
        continue;
      }

      if (!(await dialogHasVisibleComposerTextbox(dialog))) {
        continue;
      }

      const lines = normalizeWhitespace(await dialog.getText())
        .split(/\r?\n+/)
        .map((line) => normalizeWhitespace(line))
        .filter(Boolean);

      for (const line of lines.slice(0, 16)) {
        const normalizedLine = normalizeForComparison(line);
        if (normalizedLine.length < 2 || normalizedLine.length > 72) {
          continue;
        }

        if (line.split(/\s+/).length > 6) {
          continue;
        }

        if (blockedSnippets.some((snippet) => normalizedLine.includes(snippet))) {
          continue;
        }

        if (normalizedLine.includes("http") || normalizedLine.includes("www.")) {
          continue;
        }

        return line;
      }
    } catch {
      // Ignore transient dialog updates.
    }
  }

  return undefined;
}

async function getCandidateContainers(
  driver: WebDriver
): Promise<Array<Awaited<ReturnType<WebDriver["findElement"]>>>> {
  const roleArticles = await driver.findElements(By.css("div[role='article']"));
  if (roleArticles.length > 0) {
    return roleArticles;
  }

  return driver.findElements(
    By.xpath(
      "//*[@data-ad-rendering-role='story_message']/ancestor::*[.//*[@data-ad-rendering-role='comment_button' or (@aria-label and contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'comment'))]][1]"
    )
  );
}

async function clickFirstVisibleCommentButton(
  driver: WebDriver,
  container: Awaited<ReturnType<WebDriver["findElement"]>>,
  notFoundMessage: string
): Promise<void> {
  const selectors = [
    ".//*[@data-ad-rendering-role='comment_button']/ancestor::*[@role='button' or @role='link'][1]",
    ".//*[@role='button' or @role='link'][contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'leave a comment') or contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'comment')]",
    ".//span[contains(translate(normalize-space(text()), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'comment')]/ancestor::*[@role='button' or @role='link'][1]",
    ".//*[@role='button' or @role='link'][contains(normalize-space(.), 'Comment') or contains(normalize-space(.), 'comment') or contains(normalize-space(.), '╪¬╪╣┘ä┘è┘é')]",
  ];

  for (const selector of selectors) {
    const elements = await container.findElements(By.xpath(selector));
    for (const element of elements) {
      try {
        if (!(await element.isDisplayed())) {
          continue;
        }

        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", element).catch(() => undefined);
        await element.click().catch(async () => {
          await driver.executeScript(
            "arguments[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));",
            element
          );
        });
        return;
      } catch {
        // Try next candidate element.
      }
    }
  }

  const buttonCount = (await container.findElements(By.xpath(".//*[@role='button']"))).length;
  const linkCount = (await container.findElements(By.xpath(".//*[@role='link']"))).length;
  throw new Error(`${notFoundMessage} role=button count: ${buttonCount}, role=link count: ${linkCount}.`);
}

async function detectFacebookActionBlock(driver: WebDriver): Promise<string | undefined> {
  const markers = [
    "we limit how often you can post",
    "help protect the community from spam",
    "you can try again later",
    "if you think this doesn't go against our community standards",
    "give feedback",
  ];

  const overlays = await driver.findElements(By.css("div[role='dialog'], div[role='alertdialog'], body"));

  for (const overlay of overlays) {
    try {
      if (!(await overlay.isDisplayed())) {
        continue;
      }

      const text = normalizeWhitespace(await overlay.getText());
      const normalized = normalizeForComparison(text);
      if (markers.every((marker) => normalized.includes(marker))) {
        return text.slice(0, 500);
      }

      if (
        normalized.includes("we limit how often you can post") &&
        normalized.includes("you can try again later")
      ) {
        return text.slice(0, 500);
      }
    } catch {
      // Ignore transient overlay detachments.
    }
  }

  return undefined;
}

function isCompletedPostStatus(status: string): boolean {
  const normalized = normalizeStatus(status);
  return (
    normalized === "posted" ||
    normalized === "done" ||
    normalized === "completed" ||
    normalized === "success" ||
    normalized.startsWith("failed") ||
    normalized.startsWith("invalid") ||
    normalized.startsWith("skipped")
  );
}

function extractIpFromText(raw: string): string | undefined {
  if (!raw.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as { ip?: unknown };
    if (typeof parsed.ip === "string" && parsed.ip.trim()) {
      return parsed.ip.trim();
    }
  } catch {
    // Continue with regex extraction for non-JSON payloads.
  }

  const ipv4Match = raw.match(
    /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/
  );
  if (ipv4Match?.[0]) {
    return ipv4Match[0];
  }

  const ipv6Match = raw.match(/\b(?:[A-F0-9]{1,4}:){2,7}[A-F0-9]{1,4}\b/i);
  if (ipv6Match?.[0]) {
    return ipv6Match[0];
  }

  return undefined;
}

async function detectActivePublicIp(driver: WebDriver): Promise<string | undefined> {
  const manager = driver.manage();
  const originalTimeouts = await manager.getTimeouts().catch(() => undefined);

  if (originalTimeouts) {
    await manager
      .setTimeouts({
        implicit: originalTimeouts.implicit ?? 0,
        script: originalTimeouts.script ?? 30_000,
        pageLoad: Math.min(
          originalTimeouts.pageLoad ?? PUBLIC_IP_PAGELOAD_TIMEOUT_MS,
          PUBLIC_IP_PAGELOAD_TIMEOUT_MS
        ),
      })
      .catch(() => undefined);
  }

  try {
    for (const endpoint of PUBLIC_IP_CHECK_ENDPOINTS) {
      try {
        await driver.get(endpoint);
        await driver.wait(until.elementLocated(By.css("body")), 5_000);

        const bodyText = await driver.findElement(By.css("body")).getText();
        const fromBody = extractIpFromText(bodyText);
        if (fromBody) {
          return fromBody;
        }

        const pageSource = await driver.getPageSource();
        const fromSource = extractIpFromText(pageSource);
        if (fromSource) {
          return fromSource;
        }
      } catch {
        // Try the next endpoint.
      }
    }

    return undefined;
  } finally {
    if (originalTimeouts) {
      await manager
        .setTimeouts({
          implicit: originalTimeouts.implicit ?? 0,
          script: originalTimeouts.script ?? 30_000,
          pageLoad: originalTimeouts.pageLoad ?? 45_000,
        })
        .catch(() => undefined);
    }
  }
}

function describeProxy(proxyConfig: ProxyConfig | undefined): string {
  if (!proxyConfig) {
    return "direct-connection";
  }

  if (proxyConfig.username) {
    return `${proxyConfig.host}:${proxyConfig.port} (auth user: ${proxyConfig.username})`;
  }

  return `${proxyConfig.host}:${proxyConfig.port}`;
}

function resolveWorkerDataPath(inputPath: string): string {
  const raw = String(inputPath ?? "").replace(/\\/g, "/").trim();
  if (!raw) {
    return getRuntimeDataDir();
  }

  const normalized = raw.replace(/^\.?\//, "");
  const relativeToData = normalized.startsWith("data/") ? normalized.slice("data/".length) : normalized;
  return path.join(getRuntimeDataDir(), relativeToData);
}

function resolveCsvPath(csvFilePath: string): string {
  return path.isAbsolute(csvFilePath) ? csvFilePath : resolveWorkerDataPath(csvFilePath);
}

function normalizeStatus(value: string): string {
  return value.trim().toLowerCase();
}

function isProcessingPostStatus(status: string): boolean {
  const normalized = normalizeStatus(status);
  return normalized.startsWith("processing:");
}

function buildPostClaimToken(claimOwner: string): string {
  return `processing:${claimOwner}:${randomUUID()}`;
}

async function validateCsvHeaders(csvFilePath: string): Promise<void> {
  const content = await fs.readFile(csvFilePath, "utf8");
  const firstLine = content.split(/\r?\n/)[0] ?? "";
  const normalizedHeaders = firstLine
    .split(",")
    .map((header) => header.trim().replace(/^"|"$/g, ""));

  for (const requiredHeader of CSV_HEADERS) {
    if (!normalizedHeaders.includes(requiredHeader)) {
      throw new Error(
        `CSV is missing required header: ${requiredHeader} in ${csvFilePath}`
      );
    }
  }
}

async function readCsvRows(csvFilePath: string): Promise<CsvPostRow[]> {
  await validateCsvHeaders(csvFilePath);

  return new Promise((resolve, reject) => {
    const rows: CsvPostRow[] = [];

    createReadStream(csvFilePath)
      .pipe(csvParser())
      .on("data", (rawRow) => {
        rows.push({
          post_text: String(rawRow.post_text ?? ""),
          image_url: String(rawRow.image_url ?? ""),
          comment_link: String(rawRow.comment_link ?? ""),
          status: String(rawRow.status ?? ""),
        });
      })
      .on("end", () => resolve(rows))
      .on("error", (error) => reject(error));
  });
}

async function writeCsvRows(csvFilePath: string, rows: CsvPostRow[]): Promise<void> {
  const writer = createObjectCsvWriter({
    path: csvFilePath,
    header: CSV_HEADERS.map((id) => ({ id, title: id })),
  });

  await writer.writeRecords(rows);
}

async function withCsvFileLock<T>(csvFilePath: string, task: () => Promise<T>): Promise<T> {
  const resolvedPath = resolveCsvPath(csvFilePath);
  const previous = csvFileWriteLocks.get(resolvedPath) ?? Promise.resolve();

  let releaseCurrentLock: () => void = () => undefined;
  const currentLock = new Promise<void>((resolve) => {
    releaseCurrentLock = resolve;
  });
  const queuedLock = previous.then(() => currentLock);
  csvFileWriteLocks.set(resolvedPath, queuedLock);

  await previous;

  try {
    return await task();
  } finally {
    releaseCurrentLock();
    if (csvFileWriteLocks.get(resolvedPath) === queuedLock) {
      csvFileWriteLocks.delete(resolvedPath);
    }
  }
}

async function claimNextPost(
  csvFilePath: string,
  claimOwner: string
): Promise<ClaimedPost | null> {
  return withCsvFileLock(csvFilePath, async () => {
    const resolvedPath = resolveCsvPath(csvFilePath);
    const rows = await readCsvRows(resolvedPath);

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const status = normalizeStatus(row.status);

      if (isCompletedPostStatus(status) || isProcessingPostStatus(status)) {
        continue;
      }

      const claimToken = buildPostClaimToken(claimOwner);
      rows[index] = {
        ...row,
        status: claimToken,
      };
      await writeCsvRows(resolvedPath, rows);

      return {
        row,
        rowIndex: index,
        claimToken,
      };
    }

    return null;
  });
}

async function finalizeClaimedPostAsDone(
  csvFilePath: string,
  rowIndex: number,
  claimToken: string
): Promise<void> {
  await finalizeClaimedPostWithStatus(csvFilePath, rowIndex, claimToken, "done");
}

async function finalizeClaimedPostWithStatus(
  csvFilePath: string,
  rowIndex: number,
  claimToken: string,
  status: string
): Promise<void> {
  await withCsvFileLock(csvFilePath, async () => {
    const resolvedPath = resolveCsvPath(csvFilePath);
    const rows = await readCsvRows(resolvedPath);

    if (rowIndex < 0 || rowIndex >= rows.length) {
      throw new Error(`CSV row index out of bounds: ${rowIndex}`);
    }

    if (normalizeStatus(rows[rowIndex].status) !== normalizeStatus(claimToken)) {
      return;
    }

    rows[rowIndex] = {
      ...rows[rowIndex],
      status,
    };
    await writeCsvRows(resolvedPath, rows);
  });
}

async function releaseClaimedPost(
  csvFilePath: string,
  rowIndex: number,
  claimToken: string
): Promise<void> {
  await withCsvFileLock(csvFilePath, async () => {
    const resolvedPath = resolveCsvPath(csvFilePath);
    const rows = await readCsvRows(resolvedPath);

    if (rowIndex < 0 || rowIndex >= rows.length) {
      return;
    }

    if (normalizeStatus(rows[rowIndex].status) !== normalizeStatus(claimToken)) {
      return;
    }

    rows[rowIndex] = {
      ...rows[rowIndex],
      status: "",
    };
    await writeCsvRows(resolvedPath, rows);
  });
}

export async function fetchNextPost(
  csvFilePath: string
): Promise<PendingPost | null> {
  const resolvedPath = resolveCsvPath(csvFilePath);
  const rows = await readCsvRows(resolvedPath);

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const status = normalizeStatus(row.status);

    if (!isCompletedPostStatus(status) && !isProcessingPostStatus(status)) {
      return { row, rowIndex: index };
    }
  }

  return null;
}

export async function markPostAsDone(
  csvFilePath: string,
  rowIndex: number
): Promise<void> {
  const resolvedPath = resolveCsvPath(csvFilePath);
  const rows = await readCsvRows(resolvedPath);

  if (rowIndex < 0 || rowIndex >= rows.length) {
    throw new Error(`CSV row index out of bounds: ${rowIndex}`);
  }

  rows[rowIndex].status = "done";

  const writer = createObjectCsvWriter({
    path: resolvedPath,
    header: CSV_HEADERS.map((id) => ({ id, title: id })),
  });

  await writer.writeRecords(rows);
}

function isWebDriverCookie(value: unknown): value is IWebDriverOptionsCookie {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.name === "string" && typeof candidate.value === "string";
}

async function readSessionStore(): Promise<SessionStore> {
  await ensureStorageDir();

  try {
    const raw = await fs.readFile(SESSION_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as SessionStore;
    return parsed ?? {};
  } catch {
    return {};
  }
}

async function writeSessionStore(store: SessionStore): Promise<void> {
  await ensureStorageDir();
  await fs.writeFile(SESSION_STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

async function getStoredSessionCookies(
  accountId: string
): Promise<IWebDriverOptionsCookie[]> {
  const store = await readSessionStore();
  const cookies = store[accountId];

  if (!Array.isArray(cookies)) {
    return [];
  }

  return cookies.filter(isWebDriverCookie);
}

async function saveStoredSessionCookies(
  accountId: string,
  cookies: IWebDriverOptionsCookie[]
): Promise<void> {
  const store = await readSessionStore();
  store[accountId] = cookies;
  await writeSessionStore(store);
}

async function waitForFirstVisibleElement(
  driver: WebDriver,
  selectors: string[],
  timeoutMs: number
) {
  const timeoutAt = Date.now() + timeoutMs;

  while (Date.now() < timeoutAt) {
    for (const selector of selectors) {
      const elements = await driver.findElements(By.css(selector));
      if (elements.length === 0) {
        continue;
      }

      for (const element of elements) {
        try {
          if (await element.isDisplayed()) {
            return element;
          }
        } catch {
          // Ignore detached elements during DOM updates.
        }
      }
    }

    await driver.sleep(300);
  }

  throw new Error(`Timed out waiting for selectors: ${selectors.join(", ")}`);
}

async function waitForFirstVisibleXpath(
  driver: WebDriver,
  xpaths: string[],
  timeoutMs: number
) {
  const timeoutAt = Date.now() + timeoutMs;

  while (Date.now() < timeoutAt) {
    for (const xpathSelector of xpaths) {
      const elements = await driver.findElements(By.xpath(xpathSelector));
      if (elements.length === 0) {
        continue;
      }

      for (const element of elements) {
        try {
          if (await element.isDisplayed()) {
            return element;
          }
        } catch {
          // Ignore detached elements during DOM updates.
        }
      }
    }

    await driver.sleep(300);
  }

  throw new Error(`Timed out waiting for xpaths: ${xpaths.join(" | ")}`);
}

async function navigateWithRetry(
  driver: WebDriver,
  url: string,
  attempts = 3
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await driver.get(url);
      return;
    } catch (error) {
      lastError = error;

      const message = error instanceof Error ? error.message : String(error ?? "");
      const isTransientNetworkError =
        /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_CONNECTION_RESET|timed out/i.test(
          message
        );

      if (!isTransientNetworkError || attempt === attempts) {
        throw error;
      }

      await driver.sleep(800 * attempt);
    }
  }

  throw (lastError instanceof Error
    ? lastError
    : new Error(`Navigation to ${url} failed after ${attempts} attempts.`));
}

async function waitForComposerTextbox(driver: WebDriver, timeoutMs: number) {
  const timeoutAt = Date.now() + timeoutMs;

  while (Date.now() < timeoutAt) {
    const dialogs = await driver.findElements(By.css("div[role='dialog']"));

    for (const dialog of dialogs) {
      try {
        const dialogText = normalizeForComparison(await dialog.getText());
        const dialogLabel = normalizeForComparison((await dialog.getAttribute("aria-label")) ?? "");

        if (!isComposerSurfaceText(dialogText) && !isComposerDialogLabel(dialogLabel)) {
          continue;
        }

        const candidates = await dialog.findElements(
          By.css(
            "div[role='textbox'][contenteditable='true'], div[contenteditable='true'][data-lexical-editor='true'], div[contenteditable='true'], [role='textbox'][contenteditable='true']"
          )
        );

        for (const candidate of candidates) {
          try {
            if (await candidate.isDisplayed()) {
              return candidate;
            }
          } catch {
            // Ignore detached elements during DOM updates.
          }
        }
      } catch {
        // Ignore transient dialog changes while Facebook re-renders the composer.
      }
    }

    await driver.sleep(250);
  }

  throw new Error("Timed out waiting for the post composer textbox.");
}

async function waitForComposerToClose(driver: WebDriver, timeoutMs: number): Promise<boolean> {
  return driver
    .wait(async () => {
      const dialogs = await driver.findElements(By.css("div[role='dialog']"));
      for (const dialog of dialogs) {
        try {
          const dialogText = normalizeForComparison(await dialog.getText());
          const dialogLabel = normalizeForComparison((await dialog.getAttribute("aria-label")) ?? "");
          if (isComposerSurfaceText(dialogText) || isComposerDialogLabel(dialogLabel)) {
            return false;
          }
        } catch {
          // Ignore transient dialogs.
        }
      }

      return true;
    }, timeoutMs)
    .then(() => true)
    .catch(() => false);
}

async function dismissAddToYourPostOverlay(driver: WebDriver): Promise<boolean> {
  const dialogs = await driver.findElements(By.css("div[role='dialog']"));

  for (const dialog of dialogs) {
    try {
      if (!(await dialog.isDisplayed())) {
        continue;
      }

      const dialogText = normalizeForComparison(await dialog.getText());
      const dialogLabel = normalizeForComparison((await dialog.getAttribute("aria-label")) ?? "");

      if (!isAddToPostOverlayText(`${dialogLabel} ${dialogText}`)) {
        continue;
      }

      const composerTextboxes = await dialog.findElements(
        By.css(
          "div[role='textbox'][contenteditable='true'], [role='textbox'][contenteditable='true'], div[contenteditable='true'][data-lexical-editor='true']"
        )
      );
      const hasVisibleComposerTextbox = await Promise.all(
        composerTextboxes.map(async (textbox) => {
          try {
            return await textbox.isDisplayed();
          } catch {
            return false;
          }
        })
      ).then((flags) => flags.some(Boolean));

      // Main composer includes "add to your post" text; do not dismiss it.
      if (hasVisibleComposerTextbox) {
        continue;
      }

      const controls = await dialog.findElements(By.css("[role='button'], a[role='button'], button"));
      for (const control of controls) {
        try {
          if (!(await control.isDisplayed())) {
            continue;
          }

          const ariaLabel = normalizeForComparison((await control.getAttribute("aria-label")) ?? "");
          const text = normalizeForComparison(await control.getText());
          const controlLabel = `${ariaLabel} ${text}`;

          if (!isBackControlText(controlLabel)) {
            continue;
          }

          await control.click().catch(async () => {
            await driver.executeScript("arguments[0].click();", control);
          });

          await driver.sleep(800);
          return true;
        } catch {
          // Try next control if this one detached or is not interactable.
        }
      }
    } catch {
      // Ignore transient dialog updates.
    }
  }

  return false;
}

const COMPOSER_DIALOG_TERMS = [
  "create post",
  "create a post",
  "create a public post",
  "creer une publication",
  "creer un post",
  "enregistrer une publication",
  "انشاء منشور",
  "إنشاء منشور",
];

const COMPOSER_SURFACE_TERMS = [
  ...COMPOSER_DIALOG_TERMS,
  "post anonymously",
  "write something",
  "whats on your mind",
  "add to your post",
  "exprimez-vous",
  "ecrivez",
  "publier de maniere anonyme",
  "ajouter a votre publication",
  "اكتب",
  "اكتب شي",
  "منشور مجهول الهوية",
  "اضافة الى منشورك",
  "إضافة إلى منشورك",
];

const ADD_TO_POST_OVERLAY_TERMS = [
  "add to your post",
  "ajouter a votre publication",
  "اضافة الى منشورك",
  "إضافة إلى منشورك",
];

const BACK_CONTROL_TERMS = [
  "back",
  "retour",
  "رجوع",
  "عودة",
];

const BACK_OR_CLOSE_TERMS = [
  "back",
  "close",
  "retour",
  "fermer",
  "رجوع",
  "عودة",
  "اغلاق",
  "إغلاق",
];

const FILE_UPLOAD_ERROR_TERMS = [
  "cant read files",
  "your file cant be uploaded",
  "your photos couldnt be uploaded",
  "file cant be uploaded",
  "couldnt be uploaded",
  "fichiers illisibles",
  "impossible dimporter vos photos",
  "impossible dimporter votre fichier",
  "impossible dimporter",
  "photos nont pas pu etre importees",
  "لا يمكن تحميل",
  "تعذر تحميل",
  "تعذر رفع",
  "ملفات غير قابلة للقراءة",
  "تعذر استيراد",
];

const FILE_UPLOAD_DISMISS_TERMS = [
  "close",
  "fermer",
  "ok",
  "okay",
  "daccord",
  "annuler",
  "cancel",
  "موافق",
  "اغلاق",
  "إغلاق",
];

const ATTACHMENT_REMOVE_TERMS = [
  "remove photo",
  "remove image",
  "remove media",
  "supprimer la photo",
  "supprimer l image",
  "supprimer l'image",
  "supprimer",
  "حذف الصورة",
  "حذف",
];

function includesAny(haystack: string, terms: readonly string[]): boolean {
  return terms.some((term) => haystack.includes(normalizeForComparison(term)));
}

function isComposerDialogLabel(value: string): boolean {
  const normalized = normalizeForComparison(value);
  return includesAny(normalized, COMPOSER_DIALOG_TERMS);
}

function isAddToPostOverlayText(value: string): boolean {
  const normalized = normalizeForComparison(value);
  return includesAny(normalized, ADD_TO_POST_OVERLAY_TERMS);
}

function isBackOrCloseControlText(value: string): boolean {
  const normalized = normalizeForComparison(value);
  return includesAny(normalized, BACK_OR_CLOSE_TERMS);
}

function isBackControlText(value: string): boolean {
  const normalized = normalizeForComparison(value);
  return includesAny(normalized, BACK_CONTROL_TERMS);
}

function isComposerSurfaceText(value: string): boolean {
  const normalized = normalizeForComparison(value);
  return includesAny(normalized, COMPOSER_SURFACE_TERMS);
}

function isFileUploadErrorText(value: string): boolean {
  const normalized = normalizeForComparison(value);
  return includesAny(normalized, FILE_UPLOAD_ERROR_TERMS);
}

function isFileUploadDismissControlText(value: string): boolean {
  const normalized = normalizeForComparison(value);
  return isBackOrCloseControlText(normalized) || includesAny(normalized, FILE_UPLOAD_DISMISS_TERMS);
}

async function dialogHasVisibleComposerTextbox(
  dialog: Awaited<ReturnType<WebDriver["findElement"]>>
): Promise<boolean> {
  const composerTextboxes = await dialog.findElements(
    By.css(
      "div[role='textbox'][contenteditable='true'], [role='textbox'][contenteditable='true'], div[contenteditable='true'][data-lexical-editor='true']"
    )
  );

  const visibilityFlags = await Promise.all(
    composerTextboxes.map(async (textbox) => {
      try {
        return await textbox.isDisplayed();
      } catch {
        return false;
      }
    })
  );

  return visibilityFlags.some(Boolean);
}

async function composerHasAttachedImage(driver: WebDriver): Promise<boolean> {
  const dialogs = await driver.findElements(By.css("div[role='dialog']"));

  for (const dialog of dialogs) {
    try {
      if (!(await dialog.isDisplayed())) {
        continue;
      }

      const dialogText = normalizeForComparison(await dialog.getText());
      const dialogLabel = normalizeForComparison((await dialog.getAttribute("aria-label")) ?? "");

      if (!isComposerSurfaceText(dialogText) && !isComposerDialogLabel(dialogLabel)) {
        continue;
      }

      const controls = await dialog.findElements(By.css("[role='button'], button, a[role='button']"));
      for (const control of controls) {
        try {
          if (!(await control.isDisplayed())) {
            continue;
          }

          const ariaLabel = normalizeForComparison((await control.getAttribute("aria-label")) ?? "");
          const text = normalizeForComparison(await control.getText());
          if (includesAny(`${ariaLabel} ${text}`, ATTACHMENT_REMOVE_TERMS)) {
            return true;
          }
        } catch {
          // Ignore detached controls while composer re-renders.
        }
      }

      const previews = await dialog.findElements(
        By.css("img[src^='blob:'], img[src*='scontent.'], img[src*='fbcdn.net']")
      );

      for (const preview of previews) {
        try {
          if (!(await preview.isDisplayed())) {
            continue;
          }

          const rect = await preview.getRect();
          if ((rect.width ?? 0) >= 96 && (rect.height ?? 0) >= 96) {
            return true;
          }
        } catch {
          // Ignore detached previews while DOM updates.
        }
      }
    } catch {
      // Ignore transient dialog updates.
    }
  }

  return false;
}

async function detectFileUploadError(driver: WebDriver): Promise<string | undefined> {
  const overlays = await driver.findElements(By.css("div[role='dialog'], div[role='alertdialog'], body"));

  for (const overlay of overlays) {
    try {
      if (!(await overlay.isDisplayed())) {
        continue;
      }

      const text = normalizeWhitespace(await overlay.getText());
      if (isFileUploadErrorText(text)) {
        return text.slice(0, 500);
      }
    } catch {
      // Ignore detached overlays while DOM updates.
    }
  }

  return undefined;
}

async function dismissFileUploadErrorDialogs(driver: WebDriver): Promise<boolean> {
  const dialogs = await driver.findElements(By.css("div[role='dialog'], div[role='alertdialog']"));
  let dismissed = false;

  for (const dialog of dialogs) {
    try {
      if (!(await dialog.isDisplayed())) {
        continue;
      }

      const text = normalizeWhitespace(await dialog.getText());
      const label = (await dialog.getAttribute("aria-label")) ?? "";
      if (!isFileUploadErrorText(`${label} ${text}`)) {
        continue;
      }

      const composerTextboxes = await dialog.findElements(
        By.css(
          "div[role='textbox'][contenteditable='true'], [role='textbox'][contenteditable='true'], div[contenteditable='true'][data-lexical-editor='true']"
        )
      );
      const hasVisibleComposerTextbox = await Promise.all(
        composerTextboxes.map(async (textbox) => {
          try {
            return await textbox.isDisplayed();
          } catch {
            return false;
          }
        })
      ).then((flags) => flags.some(Boolean));

      // Inline upload errors can appear inside main composer; never click close there.
      if (hasVisibleComposerTextbox) {
        continue;
      }

      const controls = await dialog.findElements(By.css("[role='button'], button, a[role='button']"));
      for (const control of controls) {
        try {
          if (!(await control.isDisplayed())) {
            continue;
          }

          const ariaLabel = (await control.getAttribute("aria-label")) ?? "";
          const controlText = await control.getText();
          if (!isFileUploadDismissControlText(`${ariaLabel} ${controlText}`)) {
            continue;
          }

          await control.click().catch(async () => {
            await driver.executeScript("arguments[0].click();", control);
          });
          dismissed = true;
          await driver.sleep(700);
          break;
        } catch {
          // Try next control.
        }
      }
    } catch {
      // Ignore transient dialog updates.
    }
  }

  return dismissed;
}

function isLikelySubmitLabel(value: string): boolean {
  const normalized = normalizeForComparison(value);

  if (!normalized) {
    return false;
  }

  const blocked = [
    "add to your post",
    "ajouter a votre publication",
    "اضافة الى منشورك",
    "إضافة إلى منشورك",
    "photo/video",
    "photo / video",
    "photo video",
    "tag people",
    "identifier des personnes",
    "اشارة الى الاشخاص",
    "check in",
    "je suis la",
    "تسجيل الدخول",
    "feeling/activity",
    "humeur/activite",
    "شعور/نشاط",
    "poll",
    "sondage",
    "استطلاع",
    "live video",
    "tag event",
    "create event",
    "file",
    "emoji",
    "الرمز التعبيري",
    "background",
    "arriere-plan",
    "الخلفية",
    "schedule post",
    "programmer une publication",
    "جدولة المنشور",
    "close composer dialog",
    "close",
    "fermer",
    "اغلاق",
    "إغلاق",
    "back",
    "retour",
    "رجوع",
    "عودة",
    "more attachment options",
    "plus d'options de piece jointe",
    "plus doptions de piece jointe",
    "خيارات ارفاق اضافية",
    "منشور مجهول الهوية",
    "نشر محتوى مجهول الهوية",
    "post anonymously",
    "publier de maniere anonyme",
  ];

  if (blocked.some((term) => normalized.includes(term))) {
    return false;
  }

  return (
    normalized === "post" ||
    normalized === "publier" ||
    normalized === "نشر" ||
    normalized.startsWith("post ") ||
    normalized.startsWith("publier ") ||
    normalized.startsWith("نشر ") ||
    normalized.includes(" post") ||
    normalized.includes("publish") ||
    normalized.includes("share") ||
    normalized.includes("publier") ||
    normalized.includes("نشر")
  );
}

async function waitForComposerSubmitButton(driver: WebDriver, timeoutMs: number) {
  const timeoutAt = Date.now() + timeoutMs;
  const exactSubmitLabels = new Set(["post", "publier", "نشر"]);

  while (Date.now() < timeoutAt) {
    const dialogs = await driver.findElements(By.css("div[role='dialog']"));

    for (const dialog of dialogs) {
      try {
        const dialogText = normalizeForComparison(await dialog.getText());
        const dialogLabel = normalizeForComparison((await dialog.getAttribute("aria-label")) ?? "");

        if (!isComposerSurfaceText(dialogText) && !isComposerDialogLabel(dialogLabel)) {
          continue;
        }

        // Only target submit controls inside the main composer surface.
        if (!(await dialogHasVisibleComposerTextbox(dialog))) {
          continue;
        }

        const candidates = await dialog.findElements(
          By.css(
            "[role='button'], button, div[role='button'][aria-label], span[role='button']"
          )
        );

        const submitCandidates: Array<{
          candidate: Awaited<ReturnType<WebDriver["findElement"]>>;
          isExact: boolean;
          y: number;
          width: number;
        }> = [];

        for (const candidate of candidates) {
          try {
            if (!(await candidate.isDisplayed())) {
              continue;
            }

            const ariaLabel = (await candidate.getAttribute("aria-label")) ?? "";
            const text = await candidate.getText();
            const candidateLabel = `${ariaLabel} ${text}`;

            if (!isLikelySubmitLabel(candidateLabel)) {
              continue;
            }

            const disabled =
              (await candidate.getAttribute("aria-disabled")) === "true" ||
              (await candidate.getAttribute("disabled")) !== null;

            if (disabled) {
              continue;
            }

            const normalizedCandidateLabel = normalizeForComparison(candidateLabel);
            const rect = await candidate.getRect().catch(() => ({ y: 0, width: 0 }));

            submitCandidates.push({
              candidate,
              isExact: exactSubmitLabels.has(normalizedCandidateLabel),
              y: Number(rect.y ?? 0),
              width: Number(rect.width ?? 0),
            });
          } catch {
            // Ignore detached candidates while Facebook re-renders the composer.
          }
        }

        if (submitCandidates.length > 0) {
          submitCandidates.sort((left, right) => {
            if (left.isExact !== right.isExact) {
              return Number(right.isExact) - Number(left.isExact);
            }

            if (left.y !== right.y) {
              return right.y - left.y;
            }

            return right.width - left.width;
          });

          return submitCandidates[0].candidate;
        }
      } catch {
        // Ignore transient dialogs while the page updates.
      }
    }

    await driver.sleep(250);
  }

  throw new Error("Timed out waiting for the composer submit button.");
}

function extensionFromContentType(contentType: string | null | undefined): string | undefined {
  const normalized = String(contentType ?? "").toLowerCase();
  if (!normalized.startsWith("image/")) {
    return undefined;
  }

  if (normalized.includes("jpeg") || normalized.includes("jpg")) return ".jpg";
  if (normalized.includes("png")) return ".png";
  if (normalized.includes("gif")) return ".gif";
  if (normalized.includes("webp")) return ".webp";
  if (normalized.includes("tiff") || normalized.includes("tif")) return ".tiff";
  if (normalized.includes("heic")) return ".heic";
  if (normalized.includes("heif")) return ".heif";
  if (normalized.includes("bmp")) return ".bmp";
  return ".jpg";
}

function hasKnownImageMagicBytes(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 4) {
    return false;
  }

  return (
    (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) ||
    (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) ||
    (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) ||
    (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) ||
    (buffer[0] === 0x49 && buffer[1] === 0x49) ||
    (buffer[0] === 0x4d && buffer[1] === 0x4d) ||
    (buffer[0] === 0x42 && buffer[1] === 0x4d)
  );
}

async function getDriverCookieHeader(driver: WebDriver): Promise<string | undefined> {
  try {
    const cookies = await driver.manage().getCookies();
    const cookieHeader = cookies
      .filter((cookie) => cookie?.name && typeof cookie.value === "string")
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");

    return cookieHeader || undefined;
  } catch {
    return undefined;
  }
}

async function downloadImageToTempWithRetry(
  imageUrl: string,
  driver?: WebDriver,
  maxAttempts = 2
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt += 1) {
    try {
      return await downloadImageToTemp(imageUrl, driver);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await sleep(1_250);
      }
    }
  }

  throw (
    lastError instanceof Error
      ? lastError
      : new Error(String(lastError ?? "Failed to download image."))
  );
}

function extractFacebookPhotoIdFromImageUrl(imageUrl: string): string | undefined {
  const normalized = imageUrl.trim();
  if (!normalized) {
    return undefined;
  }

  const photoParamMatch = normalized.match(/[?&]fbid=(\d{8,})/i);
  if (photoParamMatch?.[1]) {
    return photoParamMatch[1];
  }

  const filePatternMatch = normalized.match(
    /\/(\d+)_(\d{8,})_(\d+)_n\.(?:jpg|jpeg|png|webp|gif|bmp|tiff?|heic|heif)/i
  );
  if (filePatternMatch?.[2]) {
    return filePatternMatch[2];
  }

  return undefined;
}

function normalizeEscapedScontentUrl(rawUrl: string): string {
  return rawUrl
    .replace(/\\u0025/gi, "%")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&");
}

async function resolveFreshFbCdnUrlsFromPhotoPage(
  driver: WebDriver,
  imageUrl: string
): Promise<string[]> {
  const photoId = extractFacebookPhotoIdFromImageUrl(imageUrl);
  if (!photoId) {
    return [];
  }

  try {
    const result = (await driver.executeAsyncScript(
      `
        const callback = arguments[arguments.length - 1];
        const photoId = String(arguments[0] ?? "").trim();

        if (!photoId) {
          callback({ status: 0, urls: [] });
          return;
        }

        const sources = [
          "https://www.facebook.com/photo/?fbid=" + encodeURIComponent(photoId) + "&download=1",
          "https://www.facebook.com/photo/?fbid=" + encodeURIComponent(photoId),
          "https://www.facebook.com/photo.php?fbid=" + encodeURIComponent(photoId),
        ];

        const extractCandidates = (html) => {
          const candidates = [];
          const maybePush = (token) => {
            const value = String(token ?? "").trim();
            if (!value || !value.includes("scontent")) {
              return;
            }

            if (value.startsWith("https://") || value.startsWith("https:\\/\\/")) {
              candidates.push(value);
            }
          };

          const quoteSplit = String(html ?? "").split('"');
          for (const token of quoteSplit) {
            maybePush(token);
          }

          const singleQuoteSplit = String(html ?? "").split("'");
          for (const token of singleQuoteSplit) {
            maybePush(token);
          }

          return candidates;
        };

        (async () => {
          const allCandidates = [];
          let lastStatus = 0;

          for (const source of sources) {
            try {
              const response = await fetch(source, { credentials: "include" });
              lastStatus = response.status;

              const html = await response.text();
              const extracted = extractCandidates(html);
              for (const candidate of extracted) {
                allCandidates.push(candidate);
              }
            } catch {
              // Try the next source URL.
            }
          }

          callback({
            status: lastStatus,
            urls: Array.from(new Set(allCandidates)).slice(0, 320),
          });
        })().catch((error) => callback({
          status: 0,
          error: String(error?.message ?? error ?? "unknown"),
          urls: [],
        }));
      `,
      photoId
    )) as { status?: number; urls?: string[]; error?: string } | null;

    const rawUrls = Array.isArray(result?.urls) ? result!.urls : [];
    const normalized = Array.from(
      new Set(
        rawUrls
          .map((url) => normalizeEscapedScontentUrl(String(url ?? "")).trim())
          .filter(Boolean)
      )
    )
      .filter((url) => /^https?:\/\/scontent\./i.test(url))
      .filter((url) => /\.(jpg|jpeg|png|webp|gif|bmp|tiff?|heic|heif)(\?|$)/i.test(url))
      .filter((url) => url.includes(`_${photoId}_`));

    return normalized
      .slice(0, 12);
  } catch {
    return [];
  }
}

async function downloadImageToTemp(imageUrl: string, driver?: WebDriver): Promise<string> {
  const normalizedImageUrl = imageUrl.trim().replace(/^"(.*)"$/, "$1");

  if (!normalizedImageUrl) {
    throw new Error("imageUrl is empty");
  }

  const isRemoteUrl = /^https?:\/\//i.test(normalizedImageUrl);
  const candidatePath = path.isAbsolute(normalizedImageUrl)
    ? normalizedImageUrl
    : isRemoteUrl
      ? ""
      : resolveWorkerDataPath(normalizedImageUrl);

  if (candidatePath) {
    try {
      await fs.access(candidatePath);
      return candidatePath;
    } catch {
      // Continue with remote URL fetch fallback.
    }
  }

  await fs.mkdir(TEMP_IMAGE_DIR, { recursive: true });

  const browserLikeHeaders = {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    referer: "https://www.facebook.com/",
  };

  let lastFailureReason = "Failed to download image.";

  const persistBufferAsImage = async (
    sourceUrl: string,
    contentType: string | null,
    buffer: Buffer
  ): Promise<string | undefined> => {
    const looksLikeImage =
      String(contentType ?? "").toLowerCase().startsWith("image/") ||
      hasKnownImageMagicBytes(buffer);

    if (!looksLikeImage || buffer.length === 0) {
      lastFailureReason = `Image URL did not return a valid image payload (content-type=${contentType ?? "unknown"}).`;
      return undefined;
    }

    let extension = extensionFromContentType(contentType);
    if (!extension) {
      try {
        const parsedSource = new URL(sourceUrl);
        extension = path.extname(parsedSource.pathname) || ".jpg";
      } catch {
        extension = ".jpg";
      }
    }

    const filePath = path.join(TEMP_IMAGE_DIR, `${randomUUID()}${extension}`);
    await fs.writeFile(filePath, buffer);
    return filePath;
  };

  const tryFetchAndPersist = async (
    targetUrl: string,
    headers: Record<string, string>
  ): Promise<string | undefined> => {
    try {
      const response = await fetch(targetUrl, {
        redirect: "follow",
        headers,
      });

      if (!response.ok) {
        lastFailureReason = `Failed to download image: ${response.status} ${response.statusText}`;
        return undefined;
      }

      const contentType = response.headers.get("content-type");
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      return await persistBufferAsImage(targetUrl, contentType, buffer);
    } catch (error) {
      lastFailureReason =
        error instanceof Error ? error.message : String(error ?? "Unknown fetch error");
      return undefined;
    }
  };

  const directFetchResult = await tryFetchAndPersist(normalizedImageUrl, browserLikeHeaders);
  if (directFetchResult) {
    return directFetchResult;
  }

  const cookieHeader = driver ? await getDriverCookieHeader(driver) : undefined;
  if (cookieHeader) {
    const cookieFetchResult = await tryFetchAndPersist(normalizedImageUrl, {
      ...browserLikeHeaders,
      cookie: cookieHeader,
    });

    if (cookieFetchResult) {
      return cookieFetchResult;
    }
  }

  const isFbCdn = /fbcdn\.net|facebook\.com\/photo/i.test(normalizedImageUrl);

  if (isFbCdn && driver) {
    const refreshedUrls = await resolveFreshFbCdnUrlsFromPhotoPage(driver, normalizedImageUrl);
    const refreshedHeaders = cookieHeader
      ? { ...browserLikeHeaders, cookie: cookieHeader }
      : browserLikeHeaders;

    for (const refreshedUrl of refreshedUrls) {
      const refreshedFetchResult = await tryFetchAndPersist(refreshedUrl, refreshedHeaders);
      if (refreshedFetchResult) {
        return refreshedFetchResult;
      }
    }
  }

  // For Facebook CDN URLs, use the browser's authenticated session to download
  if (isFbCdn && driver) {
    try {
      const base64Data = await driver.executeAsyncScript(`
        const callback = arguments[arguments.length - 1];
        fetch(arguments[0], { credentials: "include" })
          .then(async (r) => {
            const blob = await r.blob();
            const reader = new FileReader();
            reader.onloadend = () => callback({
              dataUrl: reader.result,
              mimeType: blob.type,
              size: blob.size,
              status: r.status,
              statusText: r.statusText,
            });
            reader.readAsDataURL(blob);
          })
          .catch((error) => callback({ error: String(error?.message ?? error ?? "unknown") }));
      `, normalizedImageUrl) as { dataUrl?: string; mimeType?: string; size?: number } | null;

      const dataUrl = base64Data?.dataUrl;
      const mimeType = String(base64Data?.mimeType ?? "");
      const browserFetchStatus = Number((base64Data as { status?: number } | null)?.status ?? 0);
      const browserFetchStatusText = String((base64Data as { statusText?: string } | null)?.statusText ?? "");

      if (dataUrl && typeof dataUrl === "string" && dataUrl.includes(",")) {
        const raw = dataUrl.split(",")[1];
        const buffer = Buffer.from(raw, "base64");
        const persisted = await persistBufferAsImage(normalizedImageUrl, mimeType, buffer);
        if (persisted) {
          return persisted;
        }
      }

      if (browserFetchStatus >= 400) {
        lastFailureReason = `Failed to download image: ${browserFetchStatus} ${browserFetchStatusText || "Forbidden"}`;
      }
    } catch {
      // Fall through to regular fetch.
    }
  }

  throw new Error(lastFailureReason);
}

export async function publishPost(
  driver: WebDriver,
  groupId: string,
  postData: Pick<CsvPostRow, "post_text" | "image_url" | "comment_link">,
  log: StepLogger = async () => {},
  options?: { commentWithPostImage?: boolean }
): Promise<PostResult> {
  const normalizedPostText = normalizeWhitespace(postData.post_text);
  const requestedImageUrl = postData.image_url.trim();

  if (!normalizedPostText.trim()) {
    return {
      success: false,
      message: "Post text is empty; nothing to publish.",
    };
  }

  const groupUrl = `https://facebook.com/groups/${groupId}`;

  // ΓöÇΓöÇ Step 1: Navigate to group ΓöÇΓöÇ
  await log("Navigating to group", groupUrl);
  await navigateWithRetry(driver, groupUrl, 3);
  await driver.wait(until.elementLocated(By.css("body")), 20_000);
  await log("Group page loaded");

  // ΓöÇΓöÇ Step 2: Open the post composer ΓöÇΓöÇ
  await log("Looking for 'Create post' button");
  const createPostActivatorXpaths = [
    "//span[contains(translate(normalize-space(text()), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'create a public post')]",
    "//div[@role='button'][contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'create a public post')]",
    "//div[@role='button'][contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), " +
      "'write something')]",
    "//div[@role='button'][contains(normalize-space(.), 'Exprimez-vous') or contains(normalize-space(.), 'Exprimez vous')]",
    "//span[contains(normalize-space(.), 'Exprimez-vous') or contains(normalize-space(.), 'Exprimez vous')]/ancestor::*[@role='button'][1]",
    "//div[@role='button'][contains(normalize-space(.), 'Écrivez') or contains(normalize-space(.), 'Ecrivez')]",
    "//div[@role='button'][contains(normalize-space(.), 'اكتب')]",
    "//span[contains(normalize-space(.), 'اكتب')]/ancestor::*[@role='button'][1]",
    "//div[@role='button'][contains(normalize-space(.), 'إنشاء منشور') or contains(normalize-space(.), 'انشاء منشور')]",
  ];
  const createPostActivator = await waitForFirstVisibleXpath(
    driver,
    createPostActivatorXpaths,
    25_000
  );

  let postInput: Awaited<ReturnType<WebDriver["findElement"]>> | undefined;
  for (let composerAttempt = 1; composerAttempt <= 3; composerAttempt += 1) {
    const clickableActivator = (await driver.executeScript(
      `
        let node = arguments[0];
        while (node && node !== document.body) {
          const role = node.getAttribute?.("role");
          const tag = String(node.tagName ?? "").toUpperCase();
          if (role === "button" || tag === "BUTTON") {
            return node;
          }
          node = node.parentElement;
        }
        return arguments[0];
      `,
      createPostActivator
    )) as Awaited<ReturnType<WebDriver["findElement"]>>;

    await log(
      composerAttempt === 1
        ? "Clicking 'Create post' button"
        : `Clicking 'Create post' button (retry ${composerAttempt}/3)`
    );

    await clickableActivator.click().catch(async () => {
      await driver.executeScript("arguments[0].click();", clickableActivator);
    });

    await log("Waiting for post composer textbox");
    postInput = await waitForComposerTextbox(driver, composerAttempt === 1 ? 12_000 : 8_000).catch(() => undefined);
    if (postInput) {
      break;
    }

    await driver.sleep(500);
  }

  if (!postInput) {
    throw new Error("Timed out waiting for the post composer textbox after clicking the Create Post activator.");
  }

  const composerAuthorHint = await detectComposerAuthorHint(driver).catch(() => undefined);
  if (composerAuthorHint) {
    await log("Detected composer author hint", composerAuthorHint.slice(0, 60));
  }

  await log(`Typing post text (${normalizedPostText.length} chars)`);
  await postInput.click();
  await setEditableText(driver, postInput, normalizedPostText);
  await log("Post text entered");

  let downloadedImagePath: string | null = null;
  let downloadedCommentImagePath: string | null = null;
  let imageWarning: string | undefined;
  let imageUploadSucceeded = false;
  try {
    // ΓöÇΓöÇ Step 4: Upload image (if any) ΓöÇΓöÇ
    if (requestedImageUrl) {
      try {
        await log("Downloading image for upload", requestedImageUrl.slice(0, 80));
        downloadedImagePath = await downloadImageToTempWithRetry(requestedImageUrl, driver, 2);
        await log("Image downloaded", downloadedImagePath);

        // Validate the downloaded file is actually an image
        const imageStats = await fs.stat(downloadedImagePath).catch(() => undefined);
        const imageBuffer = imageStats && imageStats.size > 0
          ? Buffer.from(await fs.readFile(downloadedImagePath))
          : undefined;

        // Check magic bytes: JPEG (FF D8 FF), PNG (89 50 4E 47), GIF (47 49 46), WebP (52 49 46 46), TIFF (49 49 or 4D 4D)
        const isValidImage = imageBuffer && imageBuffer.length > 100 && (
          (imageBuffer[0] === 0xFF && imageBuffer[1] === 0xD8 && imageBuffer[2] === 0xFF) || // JPEG
          (imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50 && imageBuffer[2] === 0x4E && imageBuffer[3] === 0x47) || // PNG
          (imageBuffer[0] === 0x47 && imageBuffer[1] === 0x49 && imageBuffer[2] === 0x46) || // GIF
          (imageBuffer[0] === 0x52 && imageBuffer[1] === 0x49 && imageBuffer[2] === 0x46 && imageBuffer[3] === 0x46) || // WebP/RIFF
          (imageBuffer[0] === 0x49 && imageBuffer[1] === 0x49) || // TIFF LE
          (imageBuffer[0] === 0x4D && imageBuffer[1] === 0x4D)    // TIFF BE
        );

        if (!isValidImage) {
          const sizeInfo = imageStats ? `${imageStats.size} bytes` : "file not found";
          const headerHex = imageBuffer ? imageBuffer.subarray(0, 8).toString("hex") : "empty";
          imageWarning = `Downloaded file header is unusual (${sizeInfo}, header: ${headerHex}). Trying upload anyway.`;
          await log("Image validation failed", imageWarning);
        } else {
          await log("Image validated", `${imageStats!.size} bytes, valid image format`);
        }

        if (imageStats && imageStats.size > 0) {
          // File inputs are typically hidden; use findElements directly without visibility check
          await log("Looking for file input element");
          let fileInputs = await driver.findElements(By.css("div[role='dialog'] input[type='file']"));
          if (fileInputs.length === 0) {
            fileInputs = await driver.findElements(By.css("input[type='file'][accept*='image']"));
          }
          if (fileInputs.length === 0) {
            fileInputs = await driver.findElements(By.css("input[type='file']"));
          }

          if (fileInputs.length > 0) {
            // Make sure the file input is interactable (unhide if necessary)
            await driver.executeScript(
              "arguments[0].style.display = 'block'; arguments[0].style.visibility = 'visible'; arguments[0].style.opacity = '1';",
              fileInputs[0]
            );
            await fileInputs[0].sendKeys(downloadedImagePath);
            await log("Image file sent to file input");
            await driver.sleep(3_000);

            const uploadErrorText = await detectFileUploadError(driver);
            if (uploadErrorText) {
              imageWarning = `Image upload failed: ${uploadErrorText.slice(0, 200)}.`;
              imageUploadSucceeded = false;
              await log("Facebook image upload error detected", uploadErrorText.slice(0, 180));
              if (await dismissFileUploadErrorDialogs(driver)) {
                await log("Image upload error dialog dismissed");
              }
              await log("Continuing without image after upload error");
            } else {
              imageUploadSucceeded = true;
              await log("Image file attached to composer successfully");
            }
          } else {
            imageWarning = "Image upload skipped: No file input found in composer.";
            await log("Image upload skipped", imageWarning);
          }
        } else {
          imageWarning = "Image upload skipped: Downloaded file is empty.";
          await log("Image upload skipped", imageWarning);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        imageWarning = `Image upload skipped: ${reason}`;
        await log("Image upload error", reason);
      }
    } else {
      await log("No image URL for this post, skipping image upload");
    }

    // ΓöÇΓöÇ Step 4b: Dismiss any stale error overlays before looking for Post button ΓöÇΓöÇ
    try {
      await log("Running robust error check before final submit");

      const actionBlockedText = await detectFacebookActionBlock(driver);
      if (actionBlockedText) {
        await log("Facebook temporary posting limit detected", actionBlockedText.slice(0, 180));
        return {
          success: false,
          message: "Facebook temporarily limited this account from posting/commenting. Try again later.",
          details: actionBlockedText,
        };
      }

      const lateUploadErrorText = await detectFileUploadError(driver);
      if (lateUploadErrorText) {
        if (!imageWarning) {
          imageWarning = `Image upload failed: ${lateUploadErrorText.slice(0, 200)}.`;
        }
        imageUploadSucceeded = false;

        await log("LATE DETECTION: image upload error found", lateUploadErrorText.slice(0, 180));
        if (await dismissFileUploadErrorDialogs(driver)) {
          await log("Recovered from late image error dialog");
        }
      }

      const errorOverlays = await driver.findElements(By.xpath(
        "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), \"can't be combined\")]"
      ));
      if (errorOverlays.length > 0) {
        await log("Dismissing stale 'can't be combined' error toast");
        await driver.sleep(2_000); // Wait for toast to auto-dismiss
      }
    } catch { /* ignore */ }

    // ΓöÇΓöÇ Step 5: Ensure we are on the main composer, then click Post/Submit ΓöÇΓöÇ
    if (await dismissAddToYourPostOverlay(driver)) {
      await log("Detected 'Add to your post' overlay, returned to main composer");
    }

    const composerStillOpen = await waitForComposerTextbox(driver, 6_000)
      .then((textbox) => {
        postInput = textbox;
        return true;
      })
      .catch(() => false);

    if (!composerStillOpen) {
      await log("Composer disappeared before submit, reopening post composer");
      const reopenActivator = await waitForFirstVisibleXpath(driver, createPostActivatorXpaths, 20_000);
      await reopenActivator.click().catch(async () => {
        await driver.executeScript("arguments[0].click();", reopenActivator);
      });

      postInput = await waitForComposerTextbox(driver, 20_000);
      await setEditableText(driver, postInput, normalizedPostText);
      await log("Composer reopened and post text restored");

      if (downloadedImagePath && requestedImageUrl) {
        await log("Reattaching image after composer reopen");
        let reattachInputs = await driver.findElements(By.css("div[role='dialog'] input[type='file']"));
        if (reattachInputs.length === 0) {
          reattachInputs = await driver.findElements(By.css("input[type='file'][accept*='image']"));
        }

        if (reattachInputs.length > 0) {
          await driver.executeScript(
            "arguments[0].style.display = 'block'; arguments[0].style.visibility = 'visible'; arguments[0].style.opacity = '1';",
            reattachInputs[0]
          );
          await reattachInputs[0].sendKeys(downloadedImagePath);
          await driver.sleep(2_000);

          const reattachErrorText = await detectFileUploadError(driver);
          if (reattachErrorText) {
            imageWarning = `Image upload failed after composer reopen: ${reattachErrorText.slice(0, 180)}.`;
            imageUploadSucceeded = false;
            await dismissFileUploadErrorDialogs(driver);
          } else {
            imageUploadSucceeded = true;
            await log("Image reattached after composer reopen");
          }
        } else {
          imageWarning = "Image upload skipped after composer reopen: file input not found.";
        }
      }
    }

    if (imageWarning) {
      const expectedProbe = normalizeForComparison(normalizedPostText).slice(
        0,
        Math.min(32, normalizedPostText.length)
      );

      try {
        const composerText = normalizeForComparison(
          `${await postInput.getText()} ${(await postInput.getAttribute("textContent")) ?? ""}`
        );
        if (expectedProbe && !composerText.includes(expectedProbe)) {
          await log("Composer text missing after image flow, retyping post text");
          postInput = await waitForComposerTextbox(driver, 10_000);
          await setEditableText(driver, postInput, normalizedPostText);
        }
      } catch {
        await log("Composer text check failed, reacquiring textbox");
        postInput = await waitForComposerTextbox(driver, 10_000);
        await setEditableText(driver, postInput, normalizedPostText);
      }
    }

    if (requestedImageUrl && downloadedImagePath && !imageUploadSucceeded) {
      await log("Retrying image attach before submit");
      let retryInputs = await driver.findElements(By.css("div[role='dialog'] input[type='file']"));
      if (retryInputs.length === 0) {
        retryInputs = await driver.findElements(By.css("input[type='file'][accept*='image']"));
      }
      if (retryInputs.length === 0) {
        retryInputs = await driver.findElements(By.css("input[type='file']"));
      }

      if (retryInputs.length > 0) {
        await driver.executeScript(
          "arguments[0].style.display = 'block'; arguments[0].style.visibility = 'visible'; arguments[0].style.opacity = '1';",
          retryInputs[0]
        );
        await retryInputs[0].sendKeys(downloadedImagePath);
        await driver.sleep(2_000);

        const retryUploadErrorText = await detectFileUploadError(driver);
        if (retryUploadErrorText) {
          imageWarning = `Image upload failed on retry: ${retryUploadErrorText.slice(0, 180)}.`;
          imageUploadSucceeded = false;
          await dismissFileUploadErrorDialogs(driver);
        } else {
          imageUploadSucceeded = true;
          await log("Image attached successfully on retry");
        }
      }
    }

    if (requestedImageUrl && !imageUploadSucceeded) {
      const failureDetails = imageWarning ?? "Image upload failed before submit.";
      await log("Image upload failed before submit, aborting post", failureDetails.slice(0, 220));
      return {
        success: false,
        message: `Image upload failed for group ${groupId}; post submit was aborted to avoid text-only publishing.`,
        details: failureDetails,
      };
    }

    await log("Looking for Post/Submit button");
    let publishButton: Awaited<ReturnType<WebDriver["findElement"]>> | undefined;
    try {
      publishButton = await waitForComposerSubmitButton(driver, 20_000);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error ?? "");
      await log("Post/Submit button not found in time, using keyboard fallback", reason.slice(0, 180));
    }

    let dialogClosed = false;
    let submitRetryImageReattachAttempted = false;

    for (let submitAttempt = 1; submitAttempt <= 3; submitAttempt += 1) {
      await log(`Submitting post (attempt ${submitAttempt}/3)`);

      if (requestedImageUrl && downloadedImagePath) {
        const hasAttachedImage = await composerHasAttachedImage(driver);
        if (hasAttachedImage) {
          imageUploadSucceeded = true;
        } else if (!submitRetryImageReattachAttempted) {
          submitRetryImageReattachAttempted = true;
          await log("Image appears missing before submit retry, reattaching");
          let retryInputs = await driver.findElements(By.css("div[role='dialog'] input[type='file']"));
          if (retryInputs.length === 0) {
            retryInputs = await driver.findElements(By.css("input[type='file'][accept*='image']"));
          }
          if (retryInputs.length === 0) {
            retryInputs = await driver.findElements(By.css("input[type='file']"));
          }

          if (retryInputs.length > 0) {
            await driver.executeScript(
              "arguments[0].style.display = 'block'; arguments[0].style.visibility = 'visible'; arguments[0].style.opacity = '1';",
              retryInputs[0]
            );
            await retryInputs[0].sendKeys(downloadedImagePath);
            await driver.sleep(2_000);

            const retryUploadErrorText = await detectFileUploadError(driver);
            if (retryUploadErrorText) {
              imageWarning = `Image upload failed during submit retry: ${retryUploadErrorText.slice(0, 180)}.`;
              imageUploadSucceeded = false;
              await dismissFileUploadErrorDialogs(driver);
              await log("Image reattach failed before submit retry", retryUploadErrorText.slice(0, 160));
            } else {
              imageUploadSucceeded = true;
              await log("Image reattached before submit retry");
            }
          }
        } else {
          await log("Image still not detectable before retry, skipping repeated reattach to avoid composer reset");
        }
      }

      publishButton = await waitForComposerSubmitButton(driver, submitAttempt === 1 ? 6_000 : 3_500).catch(() => undefined);

      let submitTriggered = false;

      if (publishButton) {
        try {
          await publishButton.click();
          submitTriggered = true;
        } catch {
          try {
            await driver.executeScript("arguments[0].click();", publishButton);
            submitTriggered = true;
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error ?? "");
            await log("Submit button click failed, will refresh reference", reason.slice(0, 180));
            publishButton = undefined;
          }
        }
      }

      if (!submitTriggered) {
        try {
          postInput = await waitForComposerTextbox(driver, 3_000).catch(() => postInput);
          if (postInput) {
            await postInput.sendKeys(Key.chord(Key.CONTROL, Key.ENTER));
            submitTriggered = true;
            await log("Used keyboard submit fallback (Ctrl+Enter)");
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error ?? "");
          await log("Keyboard submit fallback failed", reason.slice(0, 180));
        }
      }

      if (!submitTriggered) {
        await log("Submit action could not be triggered for this attempt");
        continue;
      }

      dialogClosed = await waitForComposerToClose(driver, submitAttempt === 1 ? 45_000 : 25_000);
      if (dialogClosed) {
        await log("Post composer closed successfully");
        break;
      }

      const lateUploadErrorText = await detectFileUploadError(driver);
      if (lateUploadErrorText) {
        imageWarning = `Image upload failed after submit click: ${lateUploadErrorText.slice(0, 200)}.`;
        imageUploadSucceeded = false;
        await dismissFileUploadErrorDialogs(driver);
        await log("Detected upload error after submit click", lateUploadErrorText.slice(0, 180));
      }

      const actionBlockedText = await detectFacebookActionBlock(driver);
      if (actionBlockedText) {
        await log("Facebook temporary posting limit detected after submit", actionBlockedText.slice(0, 180));
        return {
          success: false,
          message: "Facebook temporarily limited this account from posting/commenting. Try again later.",
          details: actionBlockedText,
        };
      }

      if (await dismissAddToYourPostOverlay(driver)) {
        await log("Composer is in 'Add to your post' overlay after submit, going back to main composer");
        postInput = await waitForComposerTextbox(driver, 8_000).catch(() => postInput);
        await driver.sleep(600);
      }

      await log(`Composer still open after attempt ${submitAttempt}`);
    }

    if (!dialogClosed) {
      const screenshotPath = await captureScreenshot(driver, `post-fail-${groupId}`);
      const dialogs = await driver.findElements(By.css("div[role='dialog']"));
      const dialogText = dialogs[0]
        ? normalizeWhitespace(await dialogs[0].getText())
        : "";

      await log("Post failed: composer did not close", dialogText.slice(0, 200));
      return {
        success: false,
        message: `Post composer did not close after clicking Post for group ${groupId}.`,
        details:
          (dialogText.slice(0, 500) ||
          "No additional dialog text was captured after submission attempt.") +
          (screenshotPath ? ` | Screenshot: ${screenshotPath}` : ""),
      };
    }

    // ΓöÇΓöÇ Step 6: Add comment link (if any) after quick group search ΓöÇΓöÇ
    if (!postData.comment_link.trim()) {
      const details = [
        imageWarning,
      ]
        .filter(Boolean)
        .join(" | ");

      return {
        success: true,
        message: `Post submitted successfully for group ${groupId}.`,
        details: details || undefined,
        commentWarning: undefined,
      };
    }

    await log("Locating submitted post in group feed for commenting");
    const expectedSnippet = createPostVerificationSnippet(normalizedPostText);
    let matchedArticle: Awaited<ReturnType<WebDriver["findElement"]>> | undefined;
    let matchLookupError: string | undefined;

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await driver.sleep(Math.min(10_000, attempt * 2_000));
      await navigateWithRetry(driver, groupUrl, 2);
      await driver.wait(until.elementLocated(By.css("body")), 20_000);
      await driver.executeScript("window.scrollTo(0, 0);").catch(() => undefined);

      try {
        matchedArticle = await findMatchingArticle(
          driver,
          expectedSnippet,
          composerAuthorHint ? [composerAuthorHint] : []
        );
      } catch (error) {
        matchLookupError = error instanceof Error ? error.message : String(error ?? "");
      }

      if (matchedArticle) {
        break;
      }
    }

    await log("Adding comment link to post", postData.comment_link.trim().slice(0, 60));
    let commentWarning: string | undefined;
    let commentImageWarning: string | undefined;
    try {
      const actionBlockedText = await detectFacebookActionBlock(driver);
      if (actionBlockedText) {
        throw new Error(
          `Facebook temporarily limited commenting for this account. ${actionBlockedText.slice(0, 220)}`
        );
      }

      if (!matchedArticle) {
        const fallbackMessage = matchLookupError
          ? `Submitted post was not found in feed for commenting after retries. ${matchLookupError}`
          : "Submitted post was not found in feed for commenting after retries.";

        throw new Error(fallbackMessage);
      }

      await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", matchedArticle).catch(() => undefined);
      await clickFirstVisibleCommentButton(driver, matchedArticle, "Comment button not found on verified post.");

      const inputTimeoutAt = Date.now() + 20_000;
      let commentInput: Awaited<ReturnType<WebDriver["findElement"]>> | undefined;

      while (Date.now() < inputTimeoutAt && !commentInput) {
        const localCandidates = await matchedArticle.findElements(
          By.xpath(
            ".//div[@contenteditable='true' and (@role='textbox' or contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'comment'))]"
          )
        );

        for (const candidate of localCandidates) {
          try {
            if (await candidate.isDisplayed()) {
              commentInput = candidate;
              break;
            }
          } catch {
            // Ignore detached element and continue polling.
          }
        }

        if (!commentInput) {
          const globalCandidates = await driver.findElements(
            By.css("div[role='article'] div[role='textbox'][contenteditable='true'], form div[role='textbox'][contenteditable='true']")
          );
          for (const candidate of globalCandidates) {
            try {
              if (await candidate.isDisplayed()) {
                commentInput = candidate;
                break;
              }
            } catch {
              // Ignore detached element and continue polling.
            }
          }
        }

        if (!commentInput) {
          await driver.sleep(250);
        }
      }

      if (!commentInput) {
        throw new Error("Comment input box was not found after opening comments.");
      }

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", commentInput).catch(() => undefined);
          await driver.executeScript("arguments[0].focus();", commentInput).catch(() => undefined);
          const currentCommentInput = commentInput;
          if (!currentCommentInput) {
            throw new Error("Comment input box was not found after opening comments.");
          }

          await setEditableText(driver, currentCommentInput, postData.comment_link);
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (!message.toLowerCase().includes("stale element") || attempt === 3) {
            throw error;
          }

          commentInput = undefined;
          const retryDeadline = Date.now() + 20_000;
          while (Date.now() < retryDeadline && !commentInput) {
            const localCandidates = await matchedArticle.findElements(
              By.xpath(
                ".//div[@contenteditable='true' and (@role='textbox' or contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'comment'))]"
              )
            );

            for (const candidate of localCandidates) {
              try {
                if (await candidate.isDisplayed()) {
                  commentInput = candidate;
                  break;
                }
              } catch {
                // Ignore detached element and continue polling.
              }
            }

            if (!commentInput) {
              const globalCandidates = await driver.findElements(
                By.css("div[role='article'] div[role='textbox'][contenteditable='true'], form div[role='textbox'][contenteditable='true']")
              );
              for (const candidate of globalCandidates) {
                try {
                  if (await candidate.isDisplayed()) {
                    commentInput = candidate;
                    break;
                  }
                } catch {
                  // Ignore detached element and continue polling.
                }
              }
            }

            if (!commentInput) {
              await driver.sleep(250);
            }
          }
        }
      }

      if (options?.commentWithPostImage && postData.image_url.trim()) {
        await log("Comment image mode enabled, attempting to attach image");
        let commentImagePath = downloadedImagePath;

        if (!commentImagePath) {
          try {
            commentImagePath = await downloadImageToTemp(postData.image_url.trim(), driver);
            downloadedCommentImagePath = commentImagePath;
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            commentImageWarning = `Comment image skipped: ${reason}`;
            await log("Comment image download failed", reason);
          }
        }

        if (commentImagePath) {
          let imageInputs = await matchedArticle.findElements(
            By.css("input[type='file'][accept*='image'], input[type='file']")
          );

          if (imageInputs.length === 0) {
            imageInputs = await driver.findElements(
              By.css("div[role='article'] input[type='file'], form input[type='file'][accept*='image'], form input[type='file']")
            );
          }

          if (imageInputs.length > 0) {
            try {
              await driver.executeScript(
                "arguments[0].style.display = 'block'; arguments[0].style.visibility = 'visible'; arguments[0].style.opacity = '1';",
                imageInputs[0]
              );
              await imageInputs[0].sendKeys(commentImagePath);
              await driver.sleep(1_000);
              await log("Comment image attached");
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              commentImageWarning = `Comment image skipped: ${reason}`;
              await log("Comment image attach failed", reason);
            }
          } else {
            commentImageWarning = "Comment image skipped: no comment image uploader was found.";
            await log("Comment image upload skipped", commentImageWarning);
          }
        }
      }

      let submitButtons = await driver.findElements(
        By.xpath(
          "//*[@role='button'][contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'post comment')]"
        )
      );
      if (submitButtons.length === 0) {
        submitButtons = await matchedArticle.findElements(
          By.xpath(
            ".//*[@role='button'][contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'post comment') or contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'send')]"
          )
        );
      }

      if (submitButtons.length > 0) {
        await submitButtons[0].click().catch(async () => {
          await driver.executeScript("arguments[0].click();", submitButtons[0]);
        });
      } else {
        const currentCommentInput = commentInput;
        if (!currentCommentInput) {
          throw new Error("Comment input box was not found after opening comments.");
        }

        await currentCommentInput.sendKeys("\n");
      }

      await driver.sleep(800);
      await log("Comment link submitted");
    } catch (error) {
      commentWarning =
        error instanceof Error ? error.message : "Unknown error while adding comment link.";
      await log("Comment link failed", commentWarning);
    }

    const details = [
      commentWarning,
      commentImageWarning,
      imageWarning,
    ]
      .filter(Boolean)
      .join(" | ");

    return {
      success: true,
      message: commentWarning
        ? `Post submitted for group ${groupId}, but comment could not be added.`
        : `Post submitted and comment added for group ${groupId}.`,
      details: details || undefined,
      commentWarning,
    };
  } finally {
    if (downloadedImagePath) {
      await fs.unlink(downloadedImagePath).catch(() => undefined);
    }

    if (
      downloadedCommentImagePath &&
      downloadedCommentImagePath !== downloadedImagePath
    ) {
      await fs.unlink(downloadedCommentImagePath).catch(() => undefined);
    }
  }
}

export async function initializeBrowser(
  proxyConfig: ProxyConfig | undefined,
  sessionCookies: IWebDriverOptionsCookie[],
  visibleBrowser: boolean = DEFAULT_VISIBLE_BROWSER
): Promise<{ driver: WebDriver; cleanup: () => Promise<void>; proxyProtocol?: ProxyProtocol }> {
  const proxyProtocols: Array<ProxyProtocol | undefined> = proxyConfig
    ? ["socks5", "http"]
    : [undefined];

  let lastError: unknown;

  for (const proxyProtocol of proxyProtocols) {
    const options = new chrome.Options();
    let authProxyBridge: LocalProxyBridge | undefined;

    if (!visibleBrowser) {
      options.addArguments("--headless=new");
    }

    options.addArguments(
      "--disable-gpu",
      "--window-size=1366,768",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process"
    );
    options.excludeSwitches("enable-automation");

    if (proxyConfig && proxyProtocol) {
      if (proxyConfig.username && proxyConfig.password) {
        authProxyBridge = await createAuthenticatedProxyBridge(proxyConfig, proxyProtocol);
        options.addArguments(`--proxy-server=${authProxyBridge.localProxyUrl}`);
      } else {
        options.addArguments(`--proxy-server=${proxyProtocol}://${proxyConfig.host}:${proxyConfig.port}`);
      }
    }

    const chromeBinaryPath = process.env.CHROME_BINARY_PATH;
    if (chromeBinaryPath) {
      options.setChromeBinaryPath(chromeBinaryPath);
    }

    const chromeDriverPath =
      process.env.CHROMEDRIVER_PATH ||
      process.env.SE_CHROMEDRIVER ||
      process.env.WEBDRIVER_CHROME_DRIVER;

    const builder = new Builder().forBrowser("chrome").setChromeOptions(options);

    if (chromeDriverPath) {
      builder.setChromeService(new chrome.ServiceBuilder(chromeDriverPath));
    }

    const driver = await builder.build();
    await driver.manage().setTimeouts({
      pageLoad: 45_000,
      script: 30_000,
      implicit: 0,
    });

    try {
      await driver.get("https://www.facebook.com/");

      if (sessionCookies.length > 0) {
        for (const cookie of sessionCookies) {
          try {
            await driver.manage().addCookie(cookie);
          } catch {
            // Ignore invalid/expired cookie entries and continue.
          }
        }
        await driver.navigate().refresh();
      }

      await driver.executeScript(
        "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });"
      );

      return {
        driver,
        proxyProtocol,
        cleanup: async () => {
          await authProxyBridge?.close().catch(() => undefined);
        },
      };
    } catch (error) {
      lastError = error;

      await driver.quit().catch(() => undefined);
      await authProxyBridge?.close().catch(() => undefined);

      const errorText = error instanceof Error ? error.message : String(error ?? "");
      const shouldTryNextProtocol =
        proxyConfig &&
        proxyProtocol === "socks5" &&
        /ERR_SOCKS_CONNECTION_FAILED|ERR_NO_SUPPORTED_PROXIES|ERR_PROXY_CONNECTION_FAILED|SOCKS proxy|Proxy bridge/i.test(errorText);

      if (!shouldTryNextProtocol) {
        throw error;
      }
    }
  }

  throw (lastError instanceof Error
    ? lastError
    : new Error("Unable to initialize browser with the configured proxy."));
}

async function hasAuthenticatedSession(driver: WebDriver): Promise<boolean> {
  const currentUrl = (await driver.getCurrentUrl()).toLowerCase();
  if (
    currentUrl.includes("/home") ||
    currentUrl.includes("/feed") ||
    currentUrl.includes("/groups") ||
    currentUrl.includes("/profile")
  ) {
    return true;
  }

  if (currentUrl.includes("/login") || currentUrl.includes("/checkpoint") || currentUrl.includes("two_factor")) {
    return false;
  }

  const loginMarkers = await driver.findElements(
    By.css('input[name="email"], input[name="pass"]')
  );

  return loginMarkers.length === 0;
}

async function hasTwoFactorInputPresent(driver: WebDriver, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const fields = await driver.findElements(By.css(selector));
    if (fields.length > 0) {
      return true;
    }
  }

  return false;
}

async function switchFacebookLanguageToEnglishUS(driver: WebDriver): Promise<void> {
  try {
    await driver.get("https://www.facebook.com/settings/?tab=language");
    await driver.wait(until.elementLocated(By.css("body")), 10_000);

    const englishSelectors = [
      "//span[contains(text(), 'English (US)')]",
      "//a[contains(text(), 'English (US)')]",
      "//div[contains(text(), 'English (US)')]",
      "//*[contains(text(), 'English (US)')]",
    ];

    for (const selector of englishSelectors) {
      const nodes = await driver.findElements(By.xpath(selector));
      if (nodes.length > 0) {
        await nodes[0].click();
        await driver.sleep(1200);
        return;
      }
    }
  } catch {
    // Best-effort language switch.
  }
}

function waitForSocketData(
  socket: Socket,
  isComplete: (buffer: Buffer) => number | null,
  timeoutMs: number,
  contextLabel: string
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${contextLabel} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const usedLength = isComplete(buffer);
      if (usedLength === null) {
        return;
      }

      cleanup();

      if (usedLength < buffer.length) {
        socket.unshift(buffer.subarray(usedLength));
      }

      resolve(buffer.subarray(0, usedLength));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onClose = () => {
      cleanup();
      reject(new Error(`${contextLabel} socket closed before data was fully received.`));
    };

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

function openSocketConnection(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    // Keep a baseline error listener so transient socket resets never crash the process.
    socket.on("error", () => undefined);

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Connection to ${host}:${port} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    const onError = (error: Error) => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      reject(error);
    };

    const onConnect = () => {
      clearTimeout(timer);
      socket.off("error", onError);
      socket.setNoDelay(true);
      resolve(socket);
    };

    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}

async function openSocksTunnel(
  proxyConfig: ProxyConfig,
  targetHost: string,
  targetPort: number
): Promise<Socket> {
  const socket = await openSocketConnection(proxyConfig.host, proxyConfig.port, PROXY_TUNNEL_TIMEOUT_MS);

  try {
    const methods = proxyConfig.username && proxyConfig.password ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([0x05, methods.length, ...methods]));

    const greeting = await waitForSocketData(
      socket,
      (buffer) => (buffer.length >= 2 ? 2 : null),
      PROXY_TUNNEL_TIMEOUT_MS,
      "SOCKS5 greeting"
    );

    if (greeting[0] !== 0x05) {
      throw new Error("SOCKS proxy returned an unsupported protocol version.");
    }

    const method = greeting[1];
    if (method === 0xff) {
      throw new Error("SOCKS proxy rejected all authentication methods.");
    }

    if (method === 0x02) {
      if (!proxyConfig.username || !proxyConfig.password) {
        throw new Error("SOCKS proxy requires username/password, but credentials are missing.");
      }

      const usernameBuffer = Buffer.from(proxyConfig.username, "utf8");
      const passwordBuffer = Buffer.from(proxyConfig.password, "utf8");

      if (usernameBuffer.length > 255 || passwordBuffer.length > 255) {
        throw new Error("SOCKS proxy credentials exceed supported length limits.");
      }

      const authPayload = Buffer.concat([
        Buffer.from([0x01, usernameBuffer.length]),
        usernameBuffer,
        Buffer.from([passwordBuffer.length]),
        passwordBuffer,
      ]);

      socket.write(authPayload);

      const authResponse = await waitForSocketData(
        socket,
        (buffer) => (buffer.length >= 2 ? 2 : null),
        PROXY_TUNNEL_TIMEOUT_MS,
        "SOCKS5 auth"
      );

      if (authResponse[1] !== 0x00) {
        throw new Error("SOCKS proxy authentication failed for the configured credentials.");
      }
    }

    const targetHostBuffer = Buffer.from(targetHost, "utf8");
    if (targetHostBuffer.length === 0 || targetHostBuffer.length > 255) {
      throw new Error(`Invalid SOCKS tunnel target host: ${targetHost}`);
    }

    const connectRequest = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, targetHostBuffer.length]),
      targetHostBuffer,
      Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
    ]);

    socket.write(connectRequest);

    const connectResponse = await waitForSocketData(
      socket,
      (buffer) => {
        if (buffer.length < 5) {
          return null;
        }

        const atyp = buffer[3];
        let responseLength = 0;

        if (atyp === 0x01) {
          responseLength = 10;
        } else if (atyp === 0x04) {
          responseLength = 22;
        } else if (atyp === 0x03) {
          responseLength = 7 + buffer[4];
        } else {
          return null;
        }

        return buffer.length >= responseLength ? responseLength : null;
      },
      PROXY_TUNNEL_TIMEOUT_MS,
      "SOCKS5 connect"
    );

    if (connectResponse[1] !== 0x00) {
      throw new Error(`SOCKS proxy failed to connect to ${targetHost}:${targetPort} (reply code ${connectResponse[1]}).`);
    }

    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function openHttpProxyTunnel(
  proxyConfig: ProxyConfig,
  targetHost: string,
  targetPort: number
): Promise<Socket> {
  const socket = await openSocketConnection(proxyConfig.host, proxyConfig.port, PROXY_TUNNEL_TIMEOUT_MS);

  try {
    const proxyAuthHeader =
      proxyConfig.username && proxyConfig.password
        ? `Proxy-Authorization: Basic ${Buffer.from(`${proxyConfig.username}:${proxyConfig.password}`).toString("base64")}\r\n`
        : "";

    const requestPayload =
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
      `Host: ${targetHost}:${targetPort}\r\n` +
      "Proxy-Connection: Keep-Alive\r\n" +
      proxyAuthHeader +
      "\r\n";

    socket.write(requestPayload);

    const responseHeader = await waitForSocketData(
      socket,
      (buffer) => {
        const headerEndIndex = buffer.indexOf("\r\n\r\n");
        return headerEndIndex >= 0 ? headerEndIndex + 4 : null;
      },
      PROXY_TUNNEL_TIMEOUT_MS,
      "HTTP proxy CONNECT"
    );

    const statusLine = responseHeader.toString("utf8").split("\r\n")[0] ?? "";
    if (!/^HTTP\/1\.[01] 200\b/i.test(statusLine)) {
      throw new Error(`HTTP proxy CONNECT failed: ${statusLine || "Unknown status"}`);
    }

    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function createAuthenticatedProxyBridge(
  proxyConfig: ProxyConfig,
  proxyProtocol: ProxyProtocol
): Promise<LocalProxyBridge> {
  const server = createHttpServer((_, response) => {
    response.writeHead(501, { "Content-Type": "text/plain" });
    response.end("Proxy bridge only supports CONNECT requests.");
  });

  server.on("connect", (request, clientSocket, head) => {
    clientSocket.on("error", () => undefined);

    void (async () => {
      const target = String(request.url ?? "").trim();
      const separatorIndex = target.lastIndexOf(":");

      if (separatorIndex <= 0) {
        clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        clientSocket.destroy();
        return;
      }

      const targetHost = target.slice(0, separatorIndex);
      const targetPort = Number(target.slice(separatorIndex + 1));

      if (!targetHost || !Number.isFinite(targetPort) || targetPort <= 0) {
        clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        clientSocket.destroy();
        return;
      }

      let upstreamSocket: Socket | undefined;
      try {
        let lastTunnelError: unknown;

        for (let attemptNumber = 1; attemptNumber <= 2; attemptNumber += 1) {
          try {
            upstreamSocket =
              proxyProtocol === "socks5"
                ? await openSocksTunnel(proxyConfig, targetHost, targetPort)
                : await openHttpProxyTunnel(proxyConfig, targetHost, targetPort);
            break;
          } catch (error) {
            lastTunnelError = error;
          }
        }

        if (!upstreamSocket) {
          throw lastTunnelError instanceof Error
            ? lastTunnelError
            : new Error(`Unable to open upstream proxy tunnel to ${targetHost}:${targetPort}.`);
        }

        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

        if (head.length > 0) {
          upstreamSocket.write(head);
        }

        upstreamSocket.on("error", () => {
          clientSocket.destroy();
        });

        clientSocket.on("error", () => {
          upstreamSocket?.destroy();
        });

        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(
          `[ProxyBridge] Failed to open CONNECT tunnel for ${targetHost}:${targetPort}: ${reason}`
        );
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        clientSocket.destroy();
        upstreamSocket?.destroy();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };

    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    throw new Error("Failed to determine local proxy bridge address.");
  }

  return {
    localProxyUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function handleTwoFactorChallenge(
  driver: WebDriver,
  twoFactorSecret?: string
): Promise<boolean> {
  const parsedInput = parseTwoFactorInput(twoFactorSecret);
  if (parsedInput.state !== "ready") {
    return false;
  }

  const selectors = [
    'input[name="approvals_code"]',
    'input[name="security_code"]',
    'input[name="code"]',
    'input[id*="approvals"]',
    'input[id*="security"]',
  ];

  const submitSelectors = [
    "button[name='submit']",
    "button[type='submit']",
    "button[value='Continue']",
    "button[value='Confirm']",
    "button[value='Log In']",
    "input[type='submit']",
  ];

  for (const code of parsedInput.codes) {
    for (const selector of selectors) {
      const fields = await driver.findElements(By.css(selector));
      if (fields.length === 0) {
        continue;
      }

      const input = fields[0];
      await input.clear().catch(() => undefined);
      await input.sendKeys(code);

      let submitted = false;
      for (const submitSelector of submitSelectors) {
        const buttons = await driver.findElements(By.css(submitSelector));
        if (buttons.length > 0) {
          await buttons[0].click();
          submitted = true;
          break;
        }
      }

      if (!submitted) {
        await input.sendKeys("\n");
      }

      await driver.sleep(2_000);

      if (await hasAuthenticatedSession(driver)) {
        return true;
      }

      if (!(await hasTwoFactorInputPresent(driver, selectors))) {
        return false;
      }
    }
  }

  return false;
}

async function loginAndCaptureSession(
  driver: WebDriver,
  account: FbAccountRecord,
  context?: {
    flow: "preflight" | "publish";
    groupId?: string;
    groupEntityId?: string;
  }
): Promise<IWebDriverOptionsCookie[]> {
  const flowPrefix = context?.flow === "publish" ? "publish" : "preflight";

  await driver.get("https://www.facebook.com/login");
  await driver.wait(until.elementLocated(By.name("email")), 15_000);

  await appendVisualTraceLog(
    driver,
    {
      level: "info",
      message: `[Visual] Login page opened for account ${account.name}.`,
      accountId: account.id,
      groupId: context?.groupEntityId,
      details: context?.groupId
        ? `Flow=${flowPrefix} | group=${context.groupId}`
        : `Flow=${flowPrefix}`,
    },
    `${flowPrefix}-login-page-${account.id}-${context?.groupId ?? "account"}`
  );

  const emailInput = await driver.findElement(By.name("email"));
  const passwordInput = await driver.findElement(By.name("pass"));

  await emailInput.clear();
  await emailInput.sendKeys(account.username);
  await passwordInput.clear();
  await passwordInput.sendKeys(account.password);

  await appendVisualTraceLog(
    driver,
    {
      level: "info",
      message: `[Visual] Credentials entered for account ${account.name}.`,
      accountId: account.id,
      groupId: context?.groupEntityId,
      details: "Ready to submit login form.",
    },
    `${flowPrefix}-credentials-filled-${account.id}-${context?.groupId ?? "account"}`
  );

  const loginButton = await driver.findElement(By.css('button[name="login"]'));
  await loginButton.click();

  try {
    await driver.wait(async () => {
      const url = await driver.getCurrentUrl();
      return !url.includes("/login");
    }, 25_000);
  } catch (error) {
    await appendVisualTraceLog(
      driver,
      {
        level: "error",
        message: `[Visual] Login submit did not leave login page for account ${account.name}.`,
        accountId: account.id,
        groupId: context?.groupEntityId,
        details: error instanceof Error ? error.message : "Unknown login submit timeout",
      },
      `${flowPrefix}-login-submit-timeout-${account.id}-${context?.groupId ?? "account"}`
    );
    throw error;
  }

  if (!(await hasAuthenticatedSession(driver))) {
    await appendVisualTraceLog(
      driver,
      {
        level: "info",
        message: `[Visual] 2FA challenge detected for account ${account.name}.`,
        accountId: account.id,
        groupId: context?.groupEntityId,
      },
      `${flowPrefix}-two-factor-challenge-${account.id}-${context?.groupId ?? "account"}`
    );

    const solvedTwoFactor = await handleTwoFactorChallenge(driver, account.twoFactorSecret);

    await appendVisualTraceLog(
      driver,
      {
        level: solvedTwoFactor ? "success" : "error",
        message: solvedTwoFactor
          ? `[Visual] 2FA submission completed for account ${account.name}.`
          : `[Visual] 2FA submission did not complete for account ${account.name}.`,
        accountId: account.id,
        groupId: context?.groupEntityId,
      },
      `${flowPrefix}-two-factor-result-${account.id}-${context?.groupId ?? "account"}`
    );

    await driver.wait(async () => {
      const url = await driver.getCurrentUrl();
      return !url.includes("/login");
    }, 25_000).catch(() => undefined);
  }

  await switchFacebookLanguageToEnglishUS(driver);

  const cookies = await driver.manage().getCookies();

  await appendVisualTraceLog(
    driver,
    {
      level: "success",
      message: `[Visual] Login flow finished for account ${account.name}.`,
      accountId: account.id,
      groupId: context?.groupEntityId,
      details: `Cookies captured: ${cookies.length}`,
    },
    `${flowPrefix}-login-finished-${account.id}-${context?.groupId ?? "account"}`
  );

  return cookies.filter(isWebDriverCookie);
}

async function executeSeleniumPost(
  account: FbAccountRecord,
  group: FbGroupRecord,
  pendingPost: CsvPostRow,
  settings: AutomationSettings,
  sharedContext?: {
    browser: BrowserLaunchResult;
    driver: WebDriver;
    proxyConfig?: ProxyConfig;
  }
): Promise<PostResult> {
  if (IS_DRY_RUN) {
    return {
      success: true,
      message: `Dry run enabled for group ${group.groupId}`,
      details: "Set WORKER_DRY_RUN=true only for testing. Disable it for real posting.",
    };
  }

  const visibleBrowser = resolveVisibleBrowser(settings);

  const usingSharedBrowser = Boolean(sharedContext);
  let browser: BrowserLaunchResult | undefined = sharedContext?.browser;
  let driver: WebDriver | undefined = sharedContext?.driver;
  let proxyConfig: ProxyConfig | undefined = sharedContext?.proxyConfig;
  let shouldHoldBrowser = false;

  try {
    await throwIfAutomationStopped("before browser automation starts");

    if (!usingSharedBrowser) {
      const sessionCookies = await getStoredSessionCookies(account.id);
      proxyConfig = await resolveAccountProxyConfig(account, settings);

      await appendLog({
        level: "info",
        message: `Preparing account ${account.name} for group ${group.groupId}. Connection: ${describeProxy(proxyConfig)}.`,
        accountId: account.id,
        groupId: group.id,
        details: `Saved cookie count: ${sessionCookies.length}`,
      });

      browser = await initializeBrowser(proxyConfig, sessionCookies, visibleBrowser);
      driver = browser.driver;

      await appendVisualTraceLog(
        driver,
        {
          level: "info",
          message: `[Visual] Browser opened for account ${account.name} in group ${group.groupId}.`,
          accountId: account.id,
          groupId: group.id,
          details: "Session check start",
        },
        `publish-browser-open-${account.id}-${group.groupId}`
      );

      if (proxyConfig) {
        const proxyPublicIp = await detectActivePublicIp(driver);
        await appendLog({
          level: "info",
          message: proxyPublicIp
            ? `Account ${account.name} connected via proxy ${describeProxy(proxyConfig)} with public IP ${proxyPublicIp}.`
            : `Account ${account.name} connected via proxy ${describeProxy(proxyConfig)} (public IP check unavailable).`,
          accountId: account.id,
          groupId: group.id,
        });
      }

      let authenticated = await hasAuthenticatedSession(driver);

      if (!authenticated) {
        await appendLog({
          level: "info",
          message: `No valid session for account ${account.name}. Starting login flow.`,
          accountId: account.id,
          groupId: group.id,
        });

        const freshCookies = await loginAndCaptureSession(driver, account, {
          flow: "publish",
          groupId: group.groupId,
          groupEntityId: group.id,
        });
        if (freshCookies.length > 0) {
          await saveStoredSessionCookies(account.id, freshCookies);
          await appendLog({
            level: "success",
            message: `Account ${account.name} logged in successfully and session cookies were saved (${freshCookies.length}).`,
            accountId: account.id,
            groupId: group.id,
          });
        }
        authenticated = await hasAuthenticatedSession(driver);
      } else {
        await appendLog({
          level: "success",
          message: `Account ${account.name} authenticated using saved cookies.`,
          accountId: account.id,
          groupId: group.id,
        });
      }

      if (!authenticated) {
        return {
          success: false,
          message: "Unable to establish authenticated Facebook session",
        };
      }
    }

    if (!driver) {
      throw new Error("Browser driver was not initialized for publish execution.");
    }

    await appendLog({
      level: "info",
      message: `Starting post publish for account ${account.name} in group ${group.groupId}.`,
      accountId: account.id,
      groupId: group.id,
    });

    // Create a step logger that prefixes with account/group info
    const stepLogger: StepLogger = async (step, detail) => {
      await throwIfAutomationStopped(`during publish step: ${step}`);
      await appendLog({
        level: "info",
        message: `[Publish] ${step} | account=${account.name} | group=${group.groupId}`,
        accountId: account.id,
        groupId: group.id,
        details: detail,
      });
    };

    const publishResult = await publishPost(driver, group.groupId, {
      post_text: pendingPost.post_text,
      image_url: pendingPost.image_url,
      comment_link: pendingPost.comment_link,
    }, stepLogger, {
      commentWithPostImage: settings.commentWithPostImage,
    });

    if (!publishResult.success) {
      shouldHoldBrowser = true;
      await appendLog({
        level: "error",
        message: `Post FAILED for account ${account.name} in group ${group.groupId}: ${publishResult.message}`,
        accountId: account.id,
        groupId: group.id,
        details: publishResult.details,
      });
      return {
        success: false,
        message: publishResult.message,
        details: publishResult.details,
      };
    }

    if (publishResult.commentWarning) {
      shouldHoldBrowser = true;
    }

    await appendLog({
      level: "success",
      message: `Account ${account.name} has POSTED successfully to group ${group.groupId}.`,
      accountId: account.id,
      groupId: group.id,
      details: publishResult.details,
    });

    return {
      success: true,
      message: publishResult.message,
      details: publishResult.details,
      commentWarning: publishResult.commentWarning,
    };
  } catch (error) {
    if (isAutomationStopRequestedError(error)) {
      await appendLog({
        level: "info",
        message: `Automation stop requested while processing account ${account.name} in group ${group.groupId}.`,
        accountId: account.id,
        groupId: group.id,
        details: error.message,
      });

      return {
        success: false,
        message: "Automation stop requested by user.",
        details: error.message,
      };
    }

    shouldHoldBrowser = true;
    const details = error instanceof Error ? (error.stack ?? error.message) : "Unknown Selenium error";
    await appendLog({
      level: "error",
      message: `Selenium automation CRASHED for account ${account.name} in group ${group.groupId}.`,
      accountId: account.id,
      groupId: group.id,
      details,
    });
    return {
      success: false,
      message: `Selenium automation failed for account ${account.name}`,
      details,
    };
  } finally {
    if (!usingSharedBrowser && driver && browser) {
      await holdVisibleBrowserForDebug(
        `account=${account.name}, group=${group.groupId}`,
        visibleBrowser,
        DEBUG_BROWSER_HOLD_FAILURE_ONLY ? shouldHoldBrowser : true
      );
      await driver.quit().catch(() => undefined);
      await browser.cleanup().catch(() => undefined);
    }
  }
}

function getMappedAccountForGroup(
  group: FbGroupRecord,
  activeAccounts: FbAccountRecord[],
  groupIndex: number
): FbAccountRecord {
  const groupWithMapping = group as FbGroupRecord & {
    fbAccountId?: string;
    accountId?: string;
  };

  const mappedAccountId = groupWithMapping.fbAccountId ?? groupWithMapping.accountId;
  if (mappedAccountId) {
    const mapped = activeAccounts.find((account) => account.id === mappedAccountId);
    if (mapped) {
      return mapped;
    }
  }

  return activeAccounts[groupIndex % activeAccounts.length];
}

function getMappedAccountsForGroup(
  group: FbGroupRecord,
  activeAccounts: FbAccountRecord[],
  groupIndex: number
): FbAccountRecord[] {
  const groupWithMapping = group as FbGroupRecord & {
    fbAccountId?: string;
    fbAccountIds?: string[] | string;
    accountId?: string;
  };

  const explicitList = Array.isArray(groupWithMapping.fbAccountIds)
    ? groupWithMapping.fbAccountIds
    : String(groupWithMapping.fbAccountIds ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

  const legacyList = String(groupWithMapping.fbAccountId ?? groupWithMapping.accountId ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const mergedAccountIds = Array.from(new Set([...explicitList, ...legacyList]));
  const mappedAccounts = mergedAccountIds
    .map((accountId) => activeAccounts.find((account) => account.id === accountId))
    .filter((account): account is FbAccountRecord => Boolean(account));

  if (mappedAccounts.length > 0) {
    return mappedAccounts;
  }

  return [activeAccounts[groupIndex % activeAccounts.length]];
}

async function preflightAccountSession(
  account: FbAccountRecord,
  settings: AutomationSettings
): Promise<boolean> {
  const visibleBrowser = resolveVisibleBrowser(settings);
  const sessionCookies = await getStoredSessionCookies(account.id);
  const proxyConfig = await resolveAccountProxyConfig(account, settings);

  await appendLog({
    level: "info",
    message: `Session preflight started for account ${account.name}. Connection: ${describeProxy(proxyConfig)}.`,
    accountId: account.id,
    details: `Saved cookie count: ${sessionCookies.length}`,
  });

  let browser: BrowserLaunchResult | undefined;
  let shouldHoldBrowser = false;
  try {
    browser = await initializeBrowser(proxyConfig, sessionCookies, visibleBrowser);
    const driver = browser.driver;

    await appendVisualTraceLog(
      driver,
      {
        level: "info",
        message: `[Visual] Browser opened for preflight account ${account.name}.`,
        accountId: account.id,
        details: "Preflight session check start",
      },
      `preflight-browser-open-${account.id}`
    );

    if (proxyConfig) {
      const proxyPublicIp = await detectActivePublicIp(driver);
      await appendLog({
        level: "info",
        message: proxyPublicIp
          ? `Account ${account.name} connected to proxy ${describeProxy(proxyConfig)} with public IP ${proxyPublicIp}.`
          : `Account ${account.name} connected to proxy ${describeProxy(proxyConfig)} (public IP check unavailable).`,
        accountId: account.id,
      });
    }

    let authenticated = await hasAuthenticatedSession(driver);
    if (authenticated) {
      await appendLog({
        level: "success",
        message: `Account ${account.name} authenticated via saved cookies.`,
        accountId: account.id,
      });
      return true;
    }

    await appendLog({
      level: "info",
      message: `Account ${account.name} requires login. Running login + session save flow.`,
      accountId: account.id,
    });

    const freshCookies = await loginAndCaptureSession(driver, account, {
      flow: "preflight",
    });
    if (freshCookies.length > 0) {
      await saveStoredSessionCookies(account.id, freshCookies);
    }

    authenticated = await hasAuthenticatedSession(driver);
    if (!authenticated) {
      shouldHoldBrowser = true;
      await appendLog({
        level: "error",
        message: `Account ${account.name} failed preflight login.`,
        accountId: account.id,
        details: "Authentication was not confirmed after login and cookie save attempt.",
      });
      return false;
    }

    await appendLog({
      level: "success",
      message: `Account ${account.name} logged in successfully and session cookies were saved (${freshCookies.length}).`,
      accountId: account.id,
    });
    return true;
  } catch (error) {
    shouldHoldBrowser = true;
    await appendLog({
      level: "error",
      message: `Session preflight failed for account ${account.name}.`,
      accountId: account.id,
      details: error instanceof Error ? error.stack ?? error.message : "Unknown preflight error",
    });
    return false;
  } finally {
    if (browser) {
      await holdVisibleBrowserForDebug(
        `preflight account=${account.name}`,
        visibleBrowser,
        DEBUG_BROWSER_HOLD_FAILURE_ONLY ? shouldHoldBrowser : true
      );
      await browser.driver.quit().catch(() => undefined);
      await browser.cleanup().catch(() => undefined);
    }
  }
}

async function processGroupPosts(
  group: FbGroupRecord,
  account: FbAccountRecord,
  settings: AutomationSettings,
  maxPostsForAccountInCycle: number
): Promise<{ postedCount: number; stopRequested: boolean; accountIssueDetected: boolean }> {
  const visibleBrowser = resolveVisibleBrowser(settings);
  const postTransitionDelayMs = 1_500;
  const targetPostsForGroup = Math.min(settings.postsPerGroup, Math.max(0, maxPostsForAccountInCycle));
  let postedCount = 0;
  let recoverableBrowserResetCount = 0;
  let accountIssueDetected = false;
  let sharedContext:
    | {
        browser: BrowserLaunchResult;
        driver: WebDriver;
        proxyConfig?: ProxyConfig;
      }
    | undefined;
  let shouldHoldBrowser = false;

  if (targetPostsForGroup <= 0) {
    return { postedCount, stopRequested: false, accountIssueDetected };
  }

  try {
    for (let postCounter = 0; postCounter < targetPostsForGroup; postCounter += 1) {
      if (!(await isAutomationRunning())) {
        await appendLog({
          level: "info",
          message: `Automation stop requested. Exiting group loop for ${group.groupId}.`,
          accountId: account.id,
          groupId: group.id,
        });
        return { postedCount, stopRequested: true, accountIssueDetected };
      }

      const claimOwner = `${account.id}:${group.id}`;
      const pending = await claimNextPost(group.csvPath, claimOwner);
      if (!pending) {
        await appendLog({
          level: "info",
          message: `No pending posts in CSV for group ${group.groupId}.`,
          accountId: account.id,
          groupId: group.id,
        });
        break;
      }

      const normalizedPendingPostText = normalizeWhitespace(String(pending.row.post_text ?? ""));
      if (!normalizedPendingPostText.trim()) {
        const skippedStatus = "failed:empty-post-text";
        await finalizeClaimedPostWithStatus(
          group.csvPath,
          pending.rowIndex,
          pending.claimToken,
          skippedStatus
        );

        await appendLog({
          level: "info",
          message: `[SKIPPED] CSV row has empty post text and was skipped before browser publish | account=${account.name} | groupId=${group.groupId} | post=${postCounter + 1}/${targetPostsForGroup}`,
          accountId: account.id,
          groupId: group.id,
          details: `CSV row ${pending.rowIndex + 1} marked as ${skippedStatus}.`,
        });

        continue;
      }

      if (!sharedContext) {
        const sessionCookies = await getStoredSessionCookies(account.id);
        const proxyConfig = await resolveAccountProxyConfig(account, settings);

        await appendLog({
          level: "info",
          message: `Preparing account ${account.name} for group ${group.groupId}. Connection: ${describeProxy(proxyConfig)}.`,
          accountId: account.id,
          groupId: group.id,
          details: `Saved cookie count: ${sessionCookies.length}`,
        });

        const browser = await initializeBrowser(proxyConfig, sessionCookies, visibleBrowser);
        const driver = browser.driver;

        await appendVisualTraceLog(
          driver,
          {
            level: "info",
            message: `[Visual] Browser opened for account ${account.name} in group ${group.groupId}.`,
            accountId: account.id,
            groupId: group.id,
            details: "Session check start",
          },
          `publish-browser-open-${account.id}-${group.groupId}`
        );

        if (proxyConfig) {
          const proxyPublicIp = await detectActivePublicIp(driver);
          await appendLog({
            level: "info",
            message: proxyPublicIp
              ? `Account ${account.name} connected via proxy ${describeProxy(proxyConfig)} with public IP ${proxyPublicIp}.`
              : `Account ${account.name} connected via proxy ${describeProxy(proxyConfig)} (public IP check unavailable).`,
            accountId: account.id,
            groupId: group.id,
          });
        }

        let authenticated = await hasAuthenticatedSession(driver);
        if (!authenticated) {
          await appendLog({
            level: "info",
            message: `No valid session for account ${account.name}. Starting login flow.`,
            accountId: account.id,
            groupId: group.id,
          });

          const freshCookies = await loginAndCaptureSession(driver, account, {
            flow: "publish",
            groupId: group.groupId,
            groupEntityId: group.id,
          });
          if (freshCookies.length > 0) {
            await saveStoredSessionCookies(account.id, freshCookies);
            await appendLog({
              level: "success",
              message: `Account ${account.name} logged in successfully and session cookies were saved (${freshCookies.length}).`,
              accountId: account.id,
              groupId: group.id,
            });
          }

          authenticated = await hasAuthenticatedSession(driver);
        } else {
          await appendLog({
            level: "success",
            message: `Account ${account.name} authenticated using saved cookies.`,
            accountId: account.id,
            groupId: group.id,
          });
        }

        if (!authenticated) {
          shouldHoldBrowser = true;
          accountIssueDetected = true;
          await appendLog({
            level: "error",
            message: `Unable to establish authenticated Facebook session for account ${account.name}.`,
            accountId: account.id,
            groupId: group.id,
          });
          break;
        }

        sharedContext = {
          browser,
          driver,
          proxyConfig,
        };
      }

      const result = await executeSeleniumPost(account, group, pending.row, settings, sharedContext);
      if (result.message === "Automation stop requested by user.") {
        await releaseClaimedPost(group.csvPath, pending.rowIndex, pending.claimToken).catch(() => undefined);
        return { postedCount, stopRequested: true, accountIssueDetected };
      }

      if (result.success) {
        recoverableBrowserResetCount = 0;
        await finalizeClaimedPostAsDone(group.csvPath, pending.rowIndex, pending.claimToken);
        postedCount += 1;
        await appendLog({
          level: "success",
          message: `[POSTED] ${result.message} | account=${account.name} | groupId=${group.groupId} | post=${postCounter + 1}/${targetPostsForGroup}`,
          accountId: account.id,
          groupId: group.id,
          details: result.details,
        });

        if (result.commentWarning) {
          shouldHoldBrowser = true;
        }
      } else {
        const skippableFailureStatus = getSkippablePostFailureStatus(result.message, result.details);
        if (skippableFailureStatus) {
          await finalizeClaimedPostWithStatus(
            group.csvPath,
            pending.rowIndex,
            pending.claimToken,
            skippableFailureStatus
          );

          await appendLog({
            level: "info",
            message: `[SKIPPED] ${result.message} | account=${account.name} | groupId=${group.groupId} | post=${postCounter + 1}/${targetPostsForGroup}`,
            accountId: account.id,
            groupId: group.id,
            details: `CSV row ${pending.rowIndex + 1} marked as ${skippableFailureStatus}.`,
          });

          continue;
        }

        const recoverableSessionError =
          isRecoverableBrowserSessionError(result.message) ||
          isRecoverableBrowserSessionError(result.details);
        const recoverablePublishFlowError = isRecoverablePublishFlowError(
          result.message,
          result.details
        );
        const recoverableByBrowserReset = recoverableSessionError || recoverablePublishFlowError;

        if (recoverableByBrowserReset && recoverableBrowserResetCount < 2) {
          recoverableBrowserResetCount += 1;
          await releaseClaimedPost(group.csvPath, pending.rowIndex, pending.claimToken).catch(() => undefined);
          await appendLog({
            level: "info",
            message: `Browser/composer flow issue for account ${account.name} in group ${group.groupId}. Re-initializing browser and retrying post ${postCounter + 1}/${targetPostsForGroup} (attempt ${recoverableBrowserResetCount}/2).`,
            accountId: account.id,
            groupId: group.id,
            details: result.details,
          });

          if (sharedContext) {
            await sharedContext.driver.quit().catch(() => undefined);
            await sharedContext.browser.cleanup().catch(() => undefined);
            sharedContext = undefined;
          }

          postCounter -= 1;
          continue;
        }

        await releaseClaimedPost(group.csvPath, pending.rowIndex, pending.claimToken).catch(() => undefined);
        shouldHoldBrowser = true;
        accountIssueDetected = true;
        if (isActionBlockedMessage(result.message) || isActionBlockedMessage(result.details)) {
          const cooldownUntil = Date.now() + ACTION_BLOCK_COOLDOWN_MS;
          accountCooldownUntil.set(account.id, cooldownUntil);
          readyAccountSessions.delete(account.id);

          await setAccountEnabledInDashboard(account.id, false, {
            reason: "Facebook temporary posting limit reached",
            type: "automatic",
            until: new Date(cooldownUntil).toISOString(),
          }).catch(() => undefined);

          await appendLog({
            level: "error",
            message: `Account ${account.name} hit Facebook temporary limit and was paused until ${new Date(
              cooldownUntil
            ).toLocaleString()}. It will automatically return to the active pool after the pause ends.`,
            accountId: account.id,
            groupId: group.id,
            details: result.details,
          });
        }

        await appendLog({
          level: "error",
          message: `[FAILED] ${result.message} | account=${account.name} | groupId=${group.groupId} | post=${postCounter + 1}/${targetPostsForGroup}`,
          accountId: account.id,
          groupId: group.id,
          details: result.details,
        });
        break;
      }

      if (postCounter < targetPostsForGroup - 1 && postTransitionDelayMs > 0) {
        await sleepWithStopCheck(postTransitionDelayMs, `between posts in group ${group.groupId}`);
      }
    }

    return { postedCount, stopRequested: false, accountIssueDetected };
  } finally {
    if (sharedContext) {
      await holdVisibleBrowserForDebug(
        `account=${account.name}, group=${group.groupId}`,
        visibleBrowser,
        DEBUG_BROWSER_HOLD_FAILURE_ONLY ? shouldHoldBrowser : true
      );
      await sharedContext.driver.quit().catch(() => undefined);
      await sharedContext.browser.cleanup().catch(() => undefined);
    }
  }
}

interface CycleResult {
  nextDelayMs: number;
  controlToken: string;
}

async function runCycle(): Promise<CycleResult> {
  const automation = await readAutomationConfig();
  const controlToken = buildAutomationControlToken(automation);

  if (automation.state !== "running") {
    if (lastObservedAutomationState !== "stopped") {
      await appendLog({
        level: "info",
        message: "Automation is stopped. Worker is idle.",
      });
    }

    readyAccountSessions.clear();
    lastObservedAutomationState = "stopped";
    return {
      nextDelayMs: STOPPED_POLL_INTERVAL_MS,
      controlToken,
    };
  }

  const isFreshAutomationStart = lastObservedAutomationState !== "running";
  lastObservedAutomationState = "running";
  const visibleBrowser = resolveVisibleBrowser(automation.settings);
  const skipPreflightInVisibleMode = resolveSkipPreflightInVisibleMode(visibleBrowser);
  if (skipPreflightInVisibleMode) {
    readyAccountSessions.clear();
  }

  if (isFreshAutomationStart) {
    await appendLog({
      level: "info",
      message: "Automation started. Checking selected accounts, proxies, and saved sessions before posting.",
    });

    await appendLog({
      level: "info",
      message: `Effective settings: parallelAccounts=${automation.settings.parallelAccounts}, waitIntervalMinutes=${automation.settings.waitIntervalMinutes}, delayBetweenAccountsMinutes=${automation.settings.delayBetweenAccountsMinutes}, postsPerGroup=${automation.settings.postsPerGroup}, maxPostsPerAccountPerCycle=${automation.settings.maxPostsPerAccountPerCycle}, postsPerSession=${automation.settings.postsPerSession}, commentWithPostImage=${automation.settings.commentWithPostImage}, proxyRotationEnabled=${automation.settings.proxyRotationEnabled}, visibleBrowser=${visibleBrowser}.`,
    });
  }

  let accounts = await readParquetRows<FbAccountRecord>(FB_ACCOUNTS_PARQUET_PATH);
  const groups = await readParquetRows<FbGroupRecord>(FB_GROUPS_PARQUET_PATH);

  const now = Date.now();
  let restoredCount = 0;
  const refreshedAccounts = accounts.map((account) => {
    if (account.isActive) {
      return account;
    }

    const disabledUntilMs = account.disabledUntil ? Date.parse(account.disabledUntil) : Number.NaN;
    const shouldRestore =
      account.disabledType === "automatic" &&
      Number.isFinite(disabledUntilMs) &&
      disabledUntilMs <= now;

    if (!shouldRestore) {
      return account;
    }

    restoredCount += 1;
    return {
      ...account,
      isActive: true,
      disabledAt: undefined,
      disabledUntil: undefined,
      disabledReason: undefined,
      disabledType: undefined,
      updatedAt: new Date().toISOString(),
    };
  });

  if (restoredCount > 0) {
    accounts = refreshedAccounts;
    await writeParquetRows(FB_ACCOUNTS_PARQUET_PATH, fbAccountsSchema, refreshedAccounts);
    await appendLog({
      level: "info",
      message:
        restoredCount === 1
          ? "Automatic posting pause expired for 1 account. It has been re-enabled and returned to the active pool."
          : `Automatic posting pauses expired for ${restoredCount} account(s). They have been re-enabled and returned to the active pool.`,
    });
  }

  const activeAccounts = accounts.filter((account) => account.isActive !== false);
  const activeGroups = groups.filter((group) => group.isActive !== false);

  if (activeAccounts.length === 0 || activeGroups.length === 0) {
    const diagnostics = [
      `accounts active/total=${activeAccounts.length}/${accounts.length}`,
      `groups active/total=${activeGroups.length}/${groups.length}`,
      activeAccounts.length === 0 && accounts.length > 0
        ? "all accounts are disabled in Accounts page"
        : undefined,
      activeGroups.length === 0 && groups.length > 0
        ? "all groups are disabled in Groups page"
        : undefined,
    ]
      .filter(Boolean)
      .join(" | ");

    await appendLog({
      level: "info",
      message: "No active accounts or groups found for automation.",
      details: diagnostics || undefined,
    });
    return {
      nextDelayMs: STOPPED_POLL_INTERVAL_MS,
      controlToken,
    };
  }

  const selectedAccountsById = new Map<string, FbAccountRecord>();
  for (let index = 0; index < activeGroups.length; index += 1) {
    const mappedAccounts = getMappedAccountsForGroup(activeGroups[index], activeAccounts, index);
    for (const mapped of mappedAccounts) {
      selectedAccountsById.set(mapped.id, mapped);
    }
  }

  const selectedAccounts = Array.from(selectedAccountsById.values());

  const availableSelectedAccounts = selectedAccounts.filter(
    (account) => getAccountCooldownRemainingMs(account.id) === 0
  );
  const maxParallelAccounts = Math.max(1, automation.settings.parallelAccounts);
  const activeCycleSlots = Math.min(maxParallelAccounts, availableSelectedAccounts.length);

  if (isFreshAutomationStart && selectedAccounts.length < maxParallelAccounts) {
    await appendLog({
      level: "info",
      message: `parallelAccounts is set to ${maxParallelAccounts}, but only ${selectedAccounts.length} selected account(s) are assigned to active groups. Effective parallel browsers are capped by selected assigned accounts.`,
    });
  }

  for (const account of selectedAccounts) {
    const remainingMs = getAccountCooldownRemainingMs(account.id);
    if (remainingMs > 0) {
      await appendLog({
        level: "info",
        message: `Skipping account ${account.name} due to temporary Facebook cooldown (${Math.ceil(
          remainingMs / 60_000
        )} minute(s) remaining).`,
        accountId: account.id,
      });
    }
  }

  if (availableSelectedAccounts.length === 0) {
    const soonestMs = Math.min(
      ...selectedAccounts
        .map((account) => getAccountCooldownRemainingMs(account.id))
        .filter((remaining) => remaining > 0)
    );

    await appendLog({
      level: "info",
      message: "All selected accounts are in temporary cooldown due to Facebook limits. Waiting for cooldown expiry.",
    });

    return {
      nextDelayMs: Number.isFinite(soonestMs)
        ? Math.max(STOPPED_POLL_INTERVAL_MS, Math.min(POLL_INTERVAL_MS, soonestMs))
        : STOPPED_POLL_INTERVAL_MS,
      controlToken,
    };
  }

  if (isFreshAutomationStart) {
    await appendLog({
      level: "info",
      message: `Automation selection ready: ${activeCycleSlots}/${selectedAccounts.length} account(s) active this cycle (limit=${maxParallelAccounts}), ${activeGroups.length} group(s).`,
    });

    await appendLog({
      level: "info",
      message: `Selected account pool: ${selectedAccounts.map((account) => account.name).join(", ") || "none"}.`,
    });
  }

  if (availableSelectedAccounts.length > maxParallelAccounts) {
    await appendLog({
      level: "info",
      message: `parallelAccounts limit applied: processing ${maxParallelAccounts} account(s) at once, ${availableSelectedAccounts.length - maxParallelAccounts} queued for later slots in this cycle.`,
    });
  }

  if (skipPreflightInVisibleMode && isFreshAutomationStart) {
    await appendLog({
      level: "info",
      message:
        "Visible debug mode is enabled. Skipping preflight so the full login/post flow runs inside the visible publish browser.",
    });
  }

  let remainingSessionQuota = Math.max(1, automation.settings.postsPerSession);
  const reserveSessionQuota = (requested: number): number => {
    if (remainingSessionQuota <= 0) {
      return 0;
    }

    const granted = Math.min(remainingSessionQuota, Math.max(0, requested));
    remainingSessionQuota -= granted;
    return granted;
  };
  const releaseSessionQuota = (count: number): void => {
    if (count <= 0) {
      return;
    }

    remainingSessionQuota += count;
  };

  const accountSwitchDelayMs = automation.settings.delayBetweenAccountsMinutes * 60_000;
  const availableAccountIds = new Set(availableSelectedAccounts.map((account) => account.id));
  const eligibleGroupsByAccount = new Map<string, FbGroupRecord[]>();

  for (let index = 0; index < activeGroups.length; index += 1) {
    const group = activeGroups[index];
    const mappedAccounts = getMappedAccountsForGroup(group, activeAccounts, index).filter((account) =>
      availableAccountIds.has(account.id)
    );

    if (mappedAccounts.length === 0) {
      continue;
    }

    for (const account of mappedAccounts) {
      const existing = eligibleGroupsByAccount.get(account.id);
      if (existing) {
        existing.push(group);
      } else {
        eligibleGroupsByAccount.set(account.id, [group]);
      }
    }
  }

  const accountQueue = [...availableSelectedAccounts];
  let readyAccountCount = 0;

  const ensureAccountReady = async (account: FbAccountRecord): Promise<boolean> => {
    if (skipPreflightInVisibleMode) {
      readyAccountCount += 1;
      return true;
    }

    if (readyAccountSessions.has(account.id)) {
      readyAccountCount += 1;
      return true;
    }

    const ready = await preflightAccountSession(account, automation.settings);
    if (ready) {
      readyAccountSessions.add(account.id);
      readyAccountCount += 1;
    } else {
      readyAccountSessions.delete(account.id);
    }

    return ready;
  };

  const runAccountCycle = async (account: FbAccountRecord): Promise<void> => {
    const dashboardEnabled = await isAccountEnabledInDashboard(account.id).catch(() => false);
    if (!dashboardEnabled) {
      readyAccountSessions.delete(account.id);
      return;
    }

    const eligibleGroups = eligibleGroupsByAccount.get(account.id) ?? [];
    if (eligibleGroups.length === 0) {
      await appendLog({
        level: "info",
        message: `Account ${account.name} has no eligible assigned groups in this cycle.`,
        accountId: account.id,
      });
      return;
    }

    const ready = await ensureAccountReady(account);
    if (!ready) {
      return;
    }

    let remainingAccountQuota = automation.settings.maxPostsPerAccountPerCycle;
    let postedByAccount = 0;
    let nextGroupIndex = accountGroupCursor.get(account.id) ?? 0;

    while (remainingAccountQuota > 0 && remainingSessionQuota > 0) {
      if (!(await isAutomationRunning())) {
        await appendLog({
          level: "info",
          message: `Automation stop requested. Ending account cycle for ${account.name}.`,
          accountId: account.id,
        });
        break;
      }

      const stillEnabled = await isAccountEnabledInDashboard(account.id).catch(() => false);
      if (!stillEnabled) {
        readyAccountSessions.delete(account.id);
        await appendLog({
          level: "info",
          message: `Account ${account.name} became disabled during this cycle. Stopping account worker and moving to other accounts.`,
          accountId: account.id,
        });
        break;
      }

      const cooldownRemainingMs = getAccountCooldownRemainingMs(account.id);
      if (cooldownRemainingMs > 0) {
        await appendLog({
          level: "info",
          message: `Account ${account.name} entered cooldown during this cycle (${Math.ceil(
            cooldownRemainingMs / 60_000
          )} minute(s) remaining). Stopping account worker for now.`,
          accountId: account.id,
        });
        break;
      }

      let postedInPass = 0;

      for (let offset = 0; offset < eligibleGroups.length; offset += 1) {
        if (remainingAccountQuota <= 0 || remainingSessionQuota <= 0) {
          break;
        }

        const requestedSessionQuota = Math.min(
          remainingAccountQuota,
          automation.settings.postsPerGroup
        );
        const reservedSessionQuota = reserveSessionQuota(requestedSessionQuota);
        if (reservedSessionQuota <= 0) {
          remainingAccountQuota = 0;
          break;
        }

        const group = eligibleGroups[(nextGroupIndex + offset) % eligibleGroups.length];
        try {
          const groupResult = await processGroupPosts(
            group,
            account,
            automation.settings,
            Math.min(remainingAccountQuota, reservedSessionQuota)
          );

          const unusedReservedQuota = reservedSessionQuota - groupResult.postedCount;
          if (unusedReservedQuota > 0) {
            releaseSessionQuota(unusedReservedQuota);
          }

          remainingAccountQuota -= groupResult.postedCount;
          postedByAccount += groupResult.postedCount;
          postedInPass += groupResult.postedCount;

          if (groupResult.stopRequested) {
            remainingAccountQuota = 0;
            break;
          }

          if (groupResult.accountIssueDetected) {
            remainingAccountQuota = 0;
            readyAccountSessions.delete(account.id);
            await appendLog({
              level: "info",
              message: `Account ${account.name} encountered a browser/session issue in group ${group.groupId}. Stopping this account for the rest of the cycle and continuing other accounts.`,
              accountId: account.id,
              groupId: group.id,
            });
            break;
          }

          const enabledAfterGroup = await isAccountEnabledInDashboard(account.id).catch(() => false);
          if (!enabledAfterGroup) {
            readyAccountSessions.delete(account.id);
            remainingAccountQuota = 0;
            await appendLog({
              level: "info",
              message: `Account ${account.name} was disabled after processing group ${group.groupId}. Moving on to other accounts.`,
              accountId: account.id,
              groupId: group.id,
            });
            break;
          }

          const cooldownAfterGroupMs = getAccountCooldownRemainingMs(account.id);
          if (cooldownAfterGroupMs > 0) {
            remainingAccountQuota = 0;
            await appendLog({
              level: "info",
              message: `Account ${account.name} entered cooldown after group ${group.groupId}. Moving on to other accounts.`,
              accountId: account.id,
              groupId: group.id,
            });
            break;
          }
        } catch (error) {
          releaseSessionQuota(reservedSessionQuota);
          await appendLog({
            level: "error",
            message: `CSV processing failed for group ${group.groupId}`,
            accountId: account.id,
            groupId: group.id,
            details: error instanceof Error ? error.stack ?? error.message : "Unknown CSV error",
          });
        }
      }

      nextGroupIndex = (nextGroupIndex + 1) % eligibleGroups.length;

      if (postedInPass === 0) {
        break;
      }
    }

    accountGroupCursor.set(account.id, nextGroupIndex);

    if (postedByAccount >= automation.settings.maxPostsPerAccountPerCycle) {
      await appendLog({
        level: "info",
        message: `Account ${account.name} reached maxPostsPerAccountPerCycle=${automation.settings.maxPostsPerAccountPerCycle} for this cycle.`,
        accountId: account.id,
      });
    }
  };

  const runAccountWorker = async (): Promise<void> => {
    while (remainingSessionQuota > 0) {
      const account = accountQueue.shift();
      if (!account) {
        return;
      }

      try {
        await runAccountCycle(account);
      } catch (error) {
        if (isAutomationStopRequestedError(error)) {
          await appendLog({
            level: "info",
            message: `Automation stop requested. Ending account cycle for ${account.name}.`,
            accountId: account.id,
          });
          return;
        }

        const details =
          error instanceof Error ? error.stack ?? error.message : "Unknown account processing error";
        await appendLog({
          level: "error",
          message: `Account ${account.name} failed unexpectedly. Continuing with the next account.`,
          accountId: account.id,
          details,
        });
      }

      if (accountSwitchDelayMs > 0 && accountQueue.length > 0 && remainingSessionQuota > 0) {
        try {
          await sleepWithStopCheck(accountSwitchDelayMs, `between accounts after ${account.name}`);
        } catch (error) {
          if (isAutomationStopRequestedError(error)) {
            return;
          }

          throw error;
        }
      }
    }
  };

  await Promise.all(
    Array.from({ length: activeCycleSlots }, () => runAccountWorker())
  );

  if (readyAccountCount === 0 && availableSelectedAccounts.length > 0 && !skipPreflightInVisibleMode) {
    await appendLog({
      level: "error",
      message: "No selected account passed session preflight. Posting cycle aborted.",
    });
  }

  if (remainingSessionQuota <= 0) {
    await appendLog({
      level: "info",
      message: `Session post cap reached (${automation.settings.postsPerSession} posts). Cooling down for ${automation.settings.waitIntervalMinutes} minute(s) before next cycle.`,
    });
  }

  return {
    nextDelayMs: Math.max(10_000, automation.settings.waitIntervalMinutes * 60_000),
    controlToken,
  };
}

async function waitForDelayOrControlTokenChange(
  delayMs: number,
  baselineControlToken: string
): Promise<void> {
  const boundedDelayMs = Math.max(0, Math.floor(delayMs));
  if (boundedDelayMs === 0) {
    return;
  }

  const deadline = Date.now() + boundedDelayMs;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    await sleep(Math.min(STOP_CHECK_INTERVAL_MS, remainingMs));

    if (!baselineControlToken) {
      continue;
    }

    try {
      const latest = await readAutomationConfig();
      if (buildAutomationControlToken(latest) !== baselineControlToken) {
        return;
      }
    } catch {
      // Keep waiting on transient read errors.
    }
  }
}

async function startWorker(): Promise<void> {
  await acquireWorkerLock();

  const releaseLockAndExit = async (exitCode: number) => {
    await releaseWorkerLock();
    process.exit(exitCode);
  };

  process.once("SIGINT", () => {
    void releaseLockAndExit(0);
  });

  process.once("SIGTERM", () => {
    void releaseLockAndExit(0);
  });

  const defaultDebugHoldMs = resolveDebugBrowserHoldMs(DEFAULT_VISIBLE_BROWSER);

  await appendLog({
    level: "info",
    message:
      `Worker started. Polling every ${POLL_INTERVAL_MS / 1000} seconds. ` +
      `Browser=${DEFAULT_VISIBLE_BROWSER ? "visible" : "headless"}, visualTrace=${ENABLE_VISUAL_TRACE ? "on" : "off"}, ` +
      `skipPreflightInVisible=${DEFAULT_SKIP_PREFLIGHT_IN_VISIBLE_MODE ? "on" : "off"}, debugHoldMs=${defaultDebugHoldMs}.`,
  });

  if (process.argv.includes("--once")) {
    await runCycle();
    await appendLog({
      level: "info",
      message: "Worker executed in one-shot mode and is exiting.",
    });
    await releaseWorkerLock();
    return;
  }

  const controllerLoop = async (): Promise<void> => {
    while (true) {
      let cycleResult: CycleResult = {
        nextDelayMs: POLL_INTERVAL_MS,
        controlToken: "",
      };

      try {
        cycleResult = await runCycle();
      } catch (error) {
        const details =
          error instanceof Error ? error.stack ?? error.message : "Unknown worker cycle error";
        await appendLog({
          level: "error",
          message: "Worker cycle failed unexpectedly.",
          details,
        });

        const fallbackState = await readAutomationConfig().catch(() => undefined);
        cycleResult = {
          nextDelayMs: POLL_INTERVAL_MS,
          controlToken: fallbackState ? buildAutomationControlToken(fallbackState) : "",
        };
      }

      await waitForDelayOrControlTokenChange(
        cycleResult.nextDelayMs,
        cycleResult.controlToken
      );
    }
  };

  await controllerLoop();
}

// Catch unhandled promise rejections so posting failures never silently crash the process
process.on("unhandledRejection", (reason) => {
  const details = reason instanceof Error ? reason.stack ?? reason.message : String(reason ?? "Unknown rejection");
  console.error(`[CRITICAL] Unhandled rejection: ${details}`);
  appendLog({
    level: "error",
    message: "Unhandled promise rejection in worker process.",
    details,
  }).catch(() => undefined);
});

process.on("uncaughtException", (error) => {
  const details = error.stack ?? error.message;
  console.error(`[CRITICAL] Uncaught exception: ${details}`);
  appendLog({
    level: "error",
    message: "Uncaught exception in worker process.",
    details,
  }).catch(() => undefined);
});

startWorker().catch(async (error) => {
  const details = error instanceof Error ? error.stack ?? error.message : "Unknown worker startup error";
  await appendLog({
    level: "error",
    message: "Worker failed during startup.",
    details,
  });

  await releaseWorkerLock();
  process.exit(1);
});
