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
  commentWithPostImage: boolean;
  proxyRotationEnabled: boolean;
}

interface AutomationConfig {
  state: StateValue;
  settings: AutomationSettings;
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
const STORAGE_DIR = path.join(process.cwd(), "storage");
const AUTOMATION_STATE_PATH = path.join(STORAGE_DIR, "automation_state.json");
const LOGS_PARQUET_PATH = path.join(STORAGE_DIR, "logs.parquet");
const FB_ACCOUNTS_PARQUET_PATH = path.join(STORAGE_DIR, "fbAccounts.parquet");
const FB_GROUPS_PARQUET_PATH = path.join(STORAGE_DIR, "fbGroups.parquet");
const PROXIES_PARQUET_PATH = path.join(STORAGE_DIR, "proxies.parquet");
const SESSION_STORE_PATH = path.join(STORAGE_DIR, "facebook_sessions.json");
const WORKER_LOCK_PATH = path.join(STORAGE_DIR, "worker.lock");
const IS_DRY_RUN = process.env.WORKER_DRY_RUN === "true";
const IS_VISIBLE_BROWSER = process.env.WORKER_VISIBLE_BROWSER === "true";
const ENABLE_VISUAL_TRACE = process.env.WORKER_VISUAL_TRACE !== "false";
const SKIP_PREFLIGHT_IN_VISIBLE_MODE =
  IS_VISIBLE_BROWSER && process.env.WORKER_SKIP_PREFLIGHT_IN_VISIBLE_MODE !== "false";
const DEBUG_BROWSER_HOLD_MS = Math.max(
  0,
  Number.parseInt(
    process.env.WORKER_DEBUG_BROWSER_HOLD_MS ?? (IS_VISIBLE_BROWSER ? "15000" : "0"),
    10
  ) || 0
);
const DEBUG_BROWSER_HOLD_FAILURE_ONLY =
  process.env.WORKER_DEBUG_BROWSER_HOLD_FAILURE_ONLY !== "false";
const TEMP_IMAGE_DIR = path.join(os.tmpdir(), "sheet2social-worker");
const SCREENSHOT_PUBLIC_DIR = path.join(process.cwd(), "public", "automation-trace");
const SCREENSHOT_PUBLIC_ROUTE = "/automation-trace";
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
const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  parallelAccounts: 3,
  waitIntervalMinutes: 5,
  delayBetweenAccountsMinutes: 1,
  postsPerGroup: 1,
  commentWithPostImage: false,
  proxyRotationEnabled: false,
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
  createdAt: { type: "UTF8" },
  updatedAt: { type: "UTF8" },
};

let lastObservedAutomationState: StateValue | undefined;
const readyAccountSessions = new Set<string>();
const accountCooldownUntil = new Map<string, number>();

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
  shouldHold: boolean
): Promise<void> {
  if (!IS_VISIBLE_BROWSER || !shouldHold || DEBUG_BROWSER_HOLD_MS <= 0) {
    return;
  }

  await appendLog({
    level: "info",
    message: `[Debug] Keeping browser open for ${Math.round(
      DEBUG_BROWSER_HOLD_MS / 1000
    )}s (${contextLabel}).`,
  }).catch(() => undefined);

  await sleep(DEBUG_BROWSER_HOLD_MS).catch(() => undefined);
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
  return {
    parallelAccounts: Math.max(
      1,
      Math.floor(
        typeof candidate.parallelAccounts === "number"
          ? candidate.parallelAccounts
          : DEFAULT_AUTOMATION_SETTINGS.parallelAccounts
      )
    ),
    waitIntervalMinutes: Math.max(
      1,
      Math.floor(
        typeof candidate.waitIntervalMinutes === "number"
          ? candidate.waitIntervalMinutes
          : DEFAULT_AUTOMATION_SETTINGS.waitIntervalMinutes
      )
    ),
    delayBetweenAccountsMinutes: Math.max(
      0,
      Math.floor(
        typeof candidate.delayBetweenAccountsMinutes === "number"
          ? candidate.delayBetweenAccountsMinutes
          : DEFAULT_AUTOMATION_SETTINGS.delayBetweenAccountsMinutes
      )
    ),
    postsPerGroup: Math.max(
      1,
      Math.floor(
        typeof candidate.postsPerGroup === "number"
          ? candidate.postsPerGroup
          : DEFAULT_AUTOMATION_SETTINGS.postsPerGroup
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
  };
}

async function readAutomationConfig(): Promise<AutomationConfig> {
  await ensureStorageDir();

  try {
    const content = await fs.readFile(AUTOMATION_STATE_PATH, "utf8");
    const payload = JSON.parse(content) as {
      state?: string;
      settings?: Partial<AutomationSettings>;
    };

    return {
      state: toStateValue(payload.state),
      settings: normalizeAutomationSettings(payload.settings),
    };
  } catch {
    return {
      state: "stopped",
      settings: DEFAULT_AUTOMATION_SETTINGS,
    };
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
  if (code === "ERR_OUT_OF_RANGE") {
    return true;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("out of range") ||
    message.includes("unexpected end") ||
    message.includes("invalid parquet")
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

async function resolveAccountProxyConfig(
  account: FbAccountRecord
): Promise<ProxyConfig | undefined> {
  if (account.proxyId) {
    const proxies = await readParquetRows<ProxyRecord>(PROXIES_PARQUET_PATH);
    const selected = proxies.find((proxy) => proxy.id === account.proxyId && proxy.enabled !== false);

    if (selected) {
      return {
        host: selected.ipAddress,
        port: selected.port,
        username: selected.username,
        password: selected.password,
      };
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

  const existing = await readParquetRows<LogRecord>(LOGS_PARQUET_PATH);
  await writeParquetRows(LOGS_PARQUET_PATH, logsSchema, [...existing, entry]);

  const printable = `[${entry.level.toUpperCase()}] ${entry.message}`;
  if (entry.level === "error") {
    console.error(printable);
    return;
  }
  console.log(printable);
}

async function isAccountEnabledInDashboard(accountId: string): Promise<boolean> {
  const accounts = await readParquetRows<FbAccountRecord>(FB_ACCOUNTS_PARQUET_PATH);
  const account = accounts.find((item) => item.id === accountId);
  return account?.isActive === true;
}

async function setAccountEnabledInDashboard(accountId: string, enabled: boolean): Promise<boolean> {
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
    updatedAt: new Date().toISOString(),
  };

  await writeParquetRows(FB_ACCOUNTS_PARQUET_PATH, fbAccountsSchema, accounts);
  return true;
}

type StepLogger = (step: string, detail?: string) => Promise<void>;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripNonBmpChars(value: string): string {
  let result = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 0xffff) {
      result += char;
    }
  }
  return result;
}

function normalizeForComparison(value: string): string {
  return stripNonBmpChars(normalizeWhitespace(value))
    .toLowerCase()
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
    const files = await fs.readdir(SCREENSHOT_PUBLIC_DIR);
    const pngFiles = files.filter((file) => file.toLowerCase().endsWith(".png"));

    if (pngFiles.length <= MAX_TRACE_SCREENSHOTS) {
      return;
    }

    const withStats = await Promise.all(
      pngFiles.map(async (fileName) => {
        const absolutePath = path.join(SCREENSHOT_PUBLIC_DIR, fileName);
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
  if (!ENABLE_VISUAL_TRACE) {
    return undefined;
  }

  try {
    await fs.mkdir(SCREENSHOT_PUBLIC_DIR, { recursive: true });
    const screenshot = await driver.takeScreenshot();
    const fileName = `${Date.now()}-${sanitizeTraceLabel(label)}.png`;
    const filePath = path.join(SCREENSHOT_PUBLIC_DIR, fileName);
    await fs.writeFile(filePath, screenshot, "base64");

    // Keep trace storage bounded so long runs do not grow without limit.
    void cleanupTraceScreenshots();

    return `${SCREENSHOT_PUBLIC_ROUTE}/${fileName}`;
  } catch {
    return undefined;
  }
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

function toWebDriverSafeText(value: string): {
  safeText: string;
  removedNonBmp: boolean;
} {
  let removedNonBmp = false;
  let safeText = "";

  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint > 0xffff) {
      removedNonBmp = true;
      continue;
    }

    safeText += char;
  }

  return {
    safeText,
    removedNonBmp,
  };
}

function createPostVerificationSnippet(postText: string): string {
  const normalized = normalizeForComparison(postText);
  return normalized.slice(0, Math.min(80, normalized.length));
}

function buildMatchFragments(value: string): string[] {
  const normalized = normalizeForComparison(value);
  const fragments = new Set<string>();

  if (normalized.length > 0) {
    fragments.add(normalized.slice(0, Math.min(normalized.length, 180)));
  }

  for (const part of normalized.split(/[\n\r]+|[.!?]+/g)) {
    const trimmed = part.trim();
    if (trimmed.length >= 12) {
      fragments.add(trimmed.slice(0, 180));
    }
  }

  const words = normalized.split(/\s+/).filter(Boolean);
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
  expectedText: string
): Promise<Awaited<ReturnType<WebDriver["findElement"]>>> {
  const normalizedExpectedText = normalizeForComparison(expectedText);
  const fragments = buildMatchFragments(expectedText);

  const storyBlocks = await driver.findElements(By.css("[data-ad-rendering-role='story_message']"));
  for (const block of storyBlocks.slice(0, 40)) {
    try {
      const storyText = normalizeForComparison(await block.getText());
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
      let score = 0;

      if (articleText.includes(normalizedExpectedText)) {
        score += 20;
      }

      for (const fragment of fragments) {
        if (fragment.length >= 12 && articleText.includes(fragment)) {
          score += 2;
        }
      }

      const storyTextBlocks = await article.findElements(By.css("[data-ad-rendering-role='story_message']"));
      for (const block of storyTextBlocks.slice(0, 3)) {
        try {
          const storyText = normalizeForComparison(await block.getText());
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
    ".//*[@role='button' or @role='link'][contains(normalize-space(.), 'Comment') or contains(normalize-space(.), 'comment') or contains(normalize-space(.), 'تعليق')]",
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
  return normalized === "posted" || normalized === "done" || normalized === "completed" || normalized === "success";
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

function resolveCsvPath(csvFilePath: string): string {
  return path.isAbsolute(csvFilePath)
    ? csvFilePath
    : path.join(process.cwd(), csvFilePath);
}

function normalizeStatus(value: string): string {
  return value.trim().toLowerCase();
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

export async function fetchNextPost(
  csvFilePath: string
): Promise<PendingPost | null> {
  const resolvedPath = resolveCsvPath(csvFilePath);
  const rows = await readCsvRows(resolvedPath);

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const status = normalizeStatus(row.status);

    if (status !== "posted" && status !== "done" && status !== "completed" && status !== "success") {
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

        if (!dialogText.includes("create post") && dialogLabel !== "create post") {
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

  throw new Error("Timed out waiting for the Create post composer textbox.");
}

async function waitForComposerToClose(driver: WebDriver, timeoutMs: number): Promise<boolean> {
  return driver
    .wait(async () => {
      const dialogs = await driver.findElements(By.css("div[role='dialog']"));
      for (const dialog of dialogs) {
        try {
          const dialogText = normalizeForComparison(await dialog.getText());
          const dialogLabel = normalizeForComparison((await dialog.getAttribute("aria-label")) ?? "");
          if (dialogText.includes("create post") || dialogLabel === "create post") {
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
  const overlayDialogs = await driver.findElements(
    By.xpath(
      "//div[@role='dialog'][@aria-label='Add to your post' or .//*[contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'add to your post')]]"
    )
  );

  if (overlayDialogs.length === 0) {
    return false;
  }

  const topDialog = overlayDialogs[overlayDialogs.length - 1];
  const backButtons = await topDialog.findElements(
    By.xpath(
      ".//*[@role='button'][@aria-label='Back'] | .//a[@aria-label='Back'] | .//*[contains(@aria-label, 'Back')]"
    )
  );

  if (backButtons.length === 0) {
    return false;
  }

  try {
    await backButtons[0].click();
  } catch {
    await driver.executeScript("arguments[0].click();", backButtons[0]).catch(() => undefined);
  }

  await driver.sleep(800);
  return true;
}

function isComposerSurfaceText(value: string): boolean {
  const normalized = normalizeForComparison(value);
  return (
    normalized.includes("create post") ||
    normalized.includes("post anonymously") ||
    normalized.includes("write something") ||
    normalized.includes("add to your post")
  );
}

function isLikelySubmitLabel(value: string): boolean {
  const normalized = normalizeForComparison(value);

  if (!normalized) {
    return false;
  }

  const blocked = [
    "add to your post",
    "photo/video",
    "tag people",
    "check in",
    "feeling/activity",
    "poll",
    "live video",
    "tag event",
    "create event",
    "file",
    "emoji",
    "background",
    "schedule post",
    "close composer dialog",
    "close",
    "back",
    "more attachment options",
  ];

  if (blocked.some((term) => normalized.includes(term))) {
    return false;
  }

  return (
    normalized === "post" ||
    normalized.startsWith("post ") ||
    normalized.includes(" post") ||
    normalized.includes("publish") ||
    normalized.includes("share")
  );
}

async function waitForComposerSubmitButton(driver: WebDriver, timeoutMs: number) {
  const timeoutAt = Date.now() + timeoutMs;

  while (Date.now() < timeoutAt) {
    const dialogs = await driver.findElements(By.css("div[role='dialog']"));

    for (const dialog of dialogs) {
      try {
        const dialogText = normalizeForComparison(await dialog.getText());
        const dialogLabel = normalizeForComparison((await dialog.getAttribute("aria-label")) ?? "");

        if (!isComposerSurfaceText(dialogText) && dialogLabel !== "create post") {
          continue;
        }

        const candidates = await dialog.findElements(
          By.css(
            "[role='button'], button, div[role='button'][aria-label], span[role='button']"
          )
        );

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

            return candidate;
          } catch {
            // Ignore detached candidates while Facebook re-renders the composer.
          }
        }
      } catch {
        // Ignore transient dialogs while the page updates.
      }
    }

    await driver.sleep(250);
  }

  throw new Error("Timed out waiting for the composer submit button.");
}

async function downloadImageToTemp(imageUrl: string, driver?: WebDriver): Promise<string> {
  if (!imageUrl.trim()) {
    throw new Error("imageUrl is empty");
  }

  const candidatePath = path.isAbsolute(imageUrl)
    ? imageUrl
    : path.join(process.cwd(), imageUrl);

  try {
    await fs.access(candidatePath);
    return candidatePath;
  } catch {
    // Continue with remote URL fetch fallback.
  }

  await fs.mkdir(TEMP_IMAGE_DIR, { recursive: true });

  // For Facebook CDN URLs, use the browser's authenticated session to download
  const isFbCdn = /fbcdn\.net|facebook\.com\/photo/i.test(imageUrl);
  if (isFbCdn && driver) {
    try {
      const base64Data = await driver.executeAsyncScript(`
        const callback = arguments[arguments.length - 1];
        fetch(arguments[0])
          .then(r => r.blob())
          .then(blob => {
            const reader = new FileReader();
            reader.onloadend = () => callback(reader.result);
            reader.readAsDataURL(blob);
          })
          .catch(() => callback(null));
      `, imageUrl) as string | null;

      if (base64Data && typeof base64Data === "string" && base64Data.includes(",")) {
        const raw = base64Data.split(",")[1];
        const extension = base64Data.includes("image/png") ? ".png"
          : base64Data.includes("image/webp") ? ".webp"
          : ".jpg";
        const filePath = path.join(TEMP_IMAGE_DIR, `${randomUUID()}${extension}`);
        await fs.writeFile(filePath, Buffer.from(raw, "base64"));
        return filePath;
      }
    } catch {
      // Fall through to regular fetch.
    }
  }

  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const url = new URL(imageUrl);
  const extension = path.extname(url.pathname) || ".jpg";
  const filePath = path.join(TEMP_IMAGE_DIR, `${randomUUID()}${extension}`);
  await fs.writeFile(filePath, Buffer.from(arrayBuffer));

  return filePath;
}

export async function publishPost(
  driver: WebDriver,
  groupId: string,
  postData: Pick<CsvPostRow, "post_text" | "image_url" | "comment_link">,
  log: StepLogger = async () => {}
): Promise<PostResult> {
  const normalizedPostText = normalizeWhitespace(postData.post_text);
  const webDriverPostText = toWebDriverSafeText(normalizedPostText);

  if (!webDriverPostText.safeText.trim()) {
    return {
      success: false,
      message:
        webDriverPostText.removedNonBmp
          ? "Post text only contained unsupported characters (for example, certain emojis) and could not be sent."
          : "Post text is empty; nothing to publish.",
    };
  }

  const groupUrl = `https://facebook.com/groups/${groupId}`;

  // ── Step 1: Navigate to group ──
  await log("Navigating to group", groupUrl);
  await navigateWithRetry(driver, groupUrl, 3);
  await driver.wait(until.elementLocated(By.css("body")), 20_000);
  await log("Group page loaded");

  // ── Step 2: Open the post composer ──
  await log("Looking for 'Create post' button");
  const createPostActivator = await waitForFirstVisibleXpath(
    driver,
    [
      "//span[contains(translate(normalize-space(text()), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'create a public post')]",
      "//div[@role='button'][contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'create a public post')]",
      "//div[@role='button'][contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), " +
        "'write something')]",
    ],
    25_000
  );
  await log("Clicking 'Create post' button");
  await createPostActivator.click().catch(async () => {
    await driver.executeScript("arguments[0].click();", createPostActivator);
  });

  // ── Step 3: Type post text ──
  await log("Waiting for post composer textbox");
  const postInput = await waitForComposerTextbox(driver, 25_000);

  await log(`Typing post text (${webDriverPostText.safeText.length} chars)`);
  await postInput.click();
  await postInput.sendKeys(webDriverPostText.safeText);
  await log("Post text entered");

  let downloadedImagePath: string | null = null;
  let imageWarning: string | undefined;
  try {
    // ── Step 4: Upload image (if any) ──
    if (postData.image_url.trim()) {
      try {
        await log("Downloading image for upload", postData.image_url.trim().slice(0, 80));
        downloadedImagePath = await downloadImageToTemp(postData.image_url.trim(), driver);
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
          imageWarning = `Image upload skipped: Downloaded file is not a valid image (${sizeInfo}, header: ${headerHex}).`;
          await log("Image validation failed", imageWarning);
        } else {
          await log("Image validated", `${imageStats!.size} bytes, valid image format`);

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

            // Check for Facebook's "Can't Read Files" error dialog and dismiss it
            const cantReadDialogs = await driver.findElements(By.xpath(
              "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), \"can't read\")]" +
              " | //*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'couldn')]"
            ));
            if (cantReadDialogs.length > 0) {
              await log("Facebook 'Can't Read Files' error detected, dismissing");
              // Click "Close" button on the error dialog
              const closeButtons = await driver.findElements(By.xpath(
                "//div[@role='button'][contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'close')]" +
                " | //div[@aria-label='Close'] | //*[@aria-label='Close']"
              ));
              for (const btn of closeButtons) {
                try { await btn.click(); } catch { /* continue */ }
              }
              await driver.sleep(1_000);

              // Click the back arrow to return from "Add to your post" to the main composer
              const backButtons = await driver.findElements(By.xpath(
                "//div[@role='dialog']//div[@role='button'][@aria-label='Back']" +
                " | //div[@role='dialog']//a[@aria-label='Back']" +
                " | //div[@role='dialog']//*[contains(@aria-label, 'back') or contains(@aria-label, 'Back')]"
              ));
              for (const btn of backButtons) {
                try { await btn.click(); } catch { /* continue */ }
              }
              await driver.sleep(1_000);
              imageWarning = "Image upload failed: Facebook reported 'Can't Read Files'. Posting without image.";
              await log("Recovered from image error, continuing without image");
            } else {
              await log("Image file attached to composer successfully");
            }
          } else {
            imageWarning = "Image upload skipped: No file input found in composer.";
            await log("Image upload skipped", imageWarning);
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        imageWarning = `Image upload skipped: ${reason}`;
        await log("Image upload error", reason);
      }
    } else {
      await log("No image URL for this post, skipping image upload");
    }

    // ── Step 4b: Dismiss any stale error overlays before looking for Post button ──
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

      // Late check for Facebook's "Can't Read Files" error dialog
      const cantReadDialogs = await driver.findElements(By.xpath(
        "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), \"can't read\")]" +
        " | //*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'couldn')]"
      ));
      if (cantReadDialogs.length > 0) {
        await log("LATE DETECTION: 'Can't Read Files' error dialog found, dismissing");
        // Click "Close" button on the error dialog
        const closeButtons = await driver.findElements(By.xpath(
          "//div[@role='button'][contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'close')]" +
          " | //div[@aria-label='Close'] | //*[@aria-label='Close']"
        ));
        for (const btn of closeButtons) {
          try { await btn.click(); } catch { /* continue */ }
        }
        await driver.sleep(1_000);

        // Click the back arrow to return from "Add to your post" to the main composer
        const backButtons = await driver.findElements(By.xpath(
          "//div[@role='dialog']//div[@role='button'][@aria-label='Back']" +
          " | //div[@role='dialog']//a[@aria-label='Back']" +
          " | //div[@role='dialog']//*[contains(@aria-label, 'back') or contains(@aria-label, 'Back')]"
        ));
        for (const btn of backButtons) {
          try { await btn.click(); } catch { /* continue */ }
        }
        await driver.sleep(1_000);
        await log("Recovered from late image error dialog");
      }

      const errorOverlays = await driver.findElements(By.xpath(
        "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), \"can't be combined\")]"
      ));
      if (errorOverlays.length > 0) {
        await log("Dismissing stale 'can't be combined' error toast");
        await driver.sleep(2_000); // Wait for toast to auto-dismiss
      }
    } catch { /* ignore */ }

    // ── Step 5: Ensure we are on the main composer, then click Post/Submit ──
    if (await dismissAddToYourPostOverlay(driver)) {
      await log("Detected 'Add to your post' overlay, returned to main composer");
    }

    await log("Looking for Post/Submit button");
    const publishButton = await waitForComposerSubmitButton(driver, 20_000);
    let dialogClosed = false;

    for (let submitAttempt = 1; submitAttempt <= 3; submitAttempt += 1) {
      await log(`Submitting post (attempt ${submitAttempt}/3)`);
      if (submitAttempt === 1) {
        await publishButton.click().catch(async () => {
          await driver.executeScript("arguments[0].click();", publishButton);
        });
      } else if (submitAttempt === 2) {
        await postInput.sendKeys(Key.chord(Key.CONTROL, Key.ENTER)).catch(() => undefined);
      } else {
        await driver.executeScript("arguments[0].click();", publishButton).catch(() => undefined);
      }

      dialogClosed = await waitForComposerToClose(driver, submitAttempt === 1 ? 20_000 : 12_000);
      if (dialogClosed) {
        await log("Post composer closed successfully");
        break;
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
        await log("Composer is in 'Add to your post' overlay after submit, going back");
        dialogClosed = await waitForComposerToClose(driver, 5_000);
        if (dialogClosed) {
          await log("Post composer closed successfully after dismissing overlay");
          break;
        }
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

    // ── Step 6: Add comment link (if any) after quick group search ──
    if (!postData.comment_link.trim()) {
      const details = [
        webDriverPostText.removedNonBmp
          ? "Some non-BMP characters were removed from post text because ChromeDriver cannot send them via sendKeys."
          : undefined,
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
    const expectedSnippet = createPostVerificationSnippet(webDriverPostText.safeText);
    let matchedArticle: Awaited<ReturnType<WebDriver["findElement"]>> | undefined;
    let matchLookupError: string | undefined;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await driver.sleep(attempt === 1 ? 2_000 : 4_000);
      await navigateWithRetry(driver, groupUrl, 2);
      await driver.wait(until.elementLocated(By.css("body")), 20_000);

      try {
        matchedArticle = await findMatchingArticle(driver, expectedSnippet);
      } catch (error) {
        matchLookupError = error instanceof Error ? error.message : String(error ?? "");
      }

      if (matchedArticle) {
        break;
      }
    }

    await log("Adding comment link to post", postData.comment_link.trim().slice(0, 60));
    let commentWarning: string | undefined;
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

          await currentCommentInput.sendKeys(postData.comment_link);
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
      webDriverPostText.removedNonBmp
        ? "Some non-BMP characters were removed from post text because ChromeDriver cannot send them via sendKeys."
        : undefined,
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
  }
}

export async function initializeBrowser(
  proxyConfig: ProxyConfig | undefined,
  sessionCookies: IWebDriverOptionsCookie[]
): Promise<{ driver: WebDriver; cleanup: () => Promise<void>; proxyProtocol?: ProxyProtocol }> {
  const proxyProtocols: Array<ProxyProtocol | undefined> = proxyConfig
    ? ["socks5", "http"]
    : [undefined];

  let lastError: unknown;

  for (const proxyProtocol of proxyProtocols) {
    const options = new chrome.Options();
    let authProxyBridge: LocalProxyBridge | undefined;

    if (!IS_VISIBLE_BROWSER) {
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

    const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();
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
  pendingPost: CsvPostRow
): Promise<PostResult> {
  if (IS_DRY_RUN) {
    return {
      success: true,
      message: `Dry run enabled for group ${group.groupId}`,
      details: "Set WORKER_DRY_RUN=true only for testing. Disable it for real posting.",
    };
  }

  const sessionCookies = await getStoredSessionCookies(account.id);
  const proxyConfig = await resolveAccountProxyConfig(account);

  await appendLog({
    level: "info",
    message: `Preparing account ${account.name} for group ${group.groupId}. Connection: ${describeProxy(proxyConfig)}.`,
    accountId: account.id,
    groupId: group.id,
    details: `Saved cookie count: ${sessionCookies.length}`,
  });

  const browser = await initializeBrowser(
    proxyConfig,
    sessionCookies
  );
  const driver = browser.driver;
  let shouldHoldBrowser = false;

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

  try {
    await throwIfAutomationStopped("before browser automation starts");

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
    }, stepLogger);

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
    await holdVisibleBrowserForDebug(
      `account=${account.name}, group=${group.groupId}`,
      DEBUG_BROWSER_HOLD_FAILURE_ONLY ? shouldHoldBrowser : true
    );
    await driver.quit().catch(() => undefined);
    await browser.cleanup().catch(() => undefined);
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

async function preflightAccountSession(account: FbAccountRecord): Promise<boolean> {
  const sessionCookies = await getStoredSessionCookies(account.id);
  const proxyConfig = await resolveAccountProxyConfig(account);

  await appendLog({
    level: "info",
    message: `Session preflight started for account ${account.name}. Connection: ${describeProxy(proxyConfig)}.`,
    accountId: account.id,
    details: `Saved cookie count: ${sessionCookies.length}`,
  });

  let browser: BrowserLaunchResult | undefined;
  let shouldHoldBrowser = false;
  try {
    browser = await initializeBrowser(proxyConfig, sessionCookies);
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
  settings: AutomationSettings
): Promise<void> {
  const postCooldownMs = settings.waitIntervalMinutes * 60_000;

  for (let postCounter = 0; postCounter < settings.postsPerGroup; postCounter += 1) {
    if (!(await isAutomationRunning())) {
      await appendLog({
        level: "info",
        message: `Automation stop requested. Exiting group loop for ${group.groupId}.`,
        accountId: account.id,
        groupId: group.id,
      });
      break;
    }

    const pending = await fetchNextPost(group.csvPath);
    if (!pending) {
      await appendLog({
        level: "info",
        message: `No pending posts in CSV for group ${group.groupId}.`,
        accountId: account.id,
        groupId: group.id,
      });
      break;
    }

    const result = await executeSeleniumPost(account, group, pending.row);
    if (result.message === "Automation stop requested by user.") {
      await appendLog({
        level: "info",
        message: `Automation stop requested. Ending current cycle for group ${group.groupId}.`,
        accountId: account.id,
        groupId: group.id,
      });
      break;
    }

    if (result.success) {
      await markPostAsDone(group.csvPath, pending.rowIndex);
      await appendLog({
        level: "success",
        message: `[POSTED] ${result.message} | account=${account.name} | groupId=${group.groupId} | post=${postCounter + 1}/${settings.postsPerGroup}`,
        accountId: account.id,
        groupId: group.id,
        details: result.details,
      });
    } else {
      if (isActionBlockedMessage(result.message) || isActionBlockedMessage(result.details)) {
        const cooldownUntil = Date.now() + ACTION_BLOCK_COOLDOWN_MS;
        accountCooldownUntil.set(account.id, cooldownUntil);
        readyAccountSessions.delete(account.id);
        await setAccountEnabledInDashboard(account.id, false).catch(() => undefined);
        await appendLog({
          level: "error",
          message: `Account ${account.name} hit Facebook temporary limit and was auto-disabled. Re-enable it manually from the dashboard when ready.`,
          accountId: account.id,
          groupId: group.id,
          details: result.details,
        });
      }

      await appendLog({
        level: "error",
        message: `[FAILED] ${result.message} | account=${account.name} | groupId=${group.groupId} | post=${postCounter + 1}/${settings.postsPerGroup}`,
        accountId: account.id,
        groupId: group.id,
        details: result.details,
      });
      // Stop trying more posts to this group if one fails
      break;
    }

    if (postCounter < settings.postsPerGroup - 1) {
      await sleepWithStopCheck(postCooldownMs, `between posts in group ${group.groupId}`);
    }
  }
}

async function runCycle(): Promise<number> {
  const automation = await readAutomationConfig();
  if (automation.state !== "running") {
    if (lastObservedAutomationState !== "stopped") {
      await appendLog({
        level: "info",
        message: "Automation is stopped. Worker is idle.",
      });
    }

    readyAccountSessions.clear();
    lastObservedAutomationState = "stopped";
    return STOPPED_POLL_INTERVAL_MS;
  }

  const isFreshAutomationStart = lastObservedAutomationState !== "running";
  lastObservedAutomationState = "running";

  if (isFreshAutomationStart) {
    await appendLog({
      level: "info",
      message: "Automation started. Checking selected accounts, proxies, and saved sessions before posting.",
    });

    await appendLog({
      level: "info",
      message: `Effective settings: parallelAccounts=${automation.settings.parallelAccounts}, waitIntervalMinutes=${automation.settings.waitIntervalMinutes}, delayBetweenAccountsMinutes=${automation.settings.delayBetweenAccountsMinutes}, postsPerGroup=${automation.settings.postsPerGroup}, commentWithPostImage=${automation.settings.commentWithPostImage}, proxyRotationEnabled=${automation.settings.proxyRotationEnabled}.`,
    });
  }

  const accounts = await readParquetRows<FbAccountRecord>(FB_ACCOUNTS_PARQUET_PATH);
  const groups = await readParquetRows<FbGroupRecord>(FB_GROUPS_PARQUET_PATH);

  const activeAccounts = accounts.filter((account) => account.isActive === true);
  const activeGroups = groups.filter((group) => group.isActive === true);

  if (activeAccounts.length === 0 || activeGroups.length === 0) {
    await appendLog({
      level: "info",
      message: "No active accounts or groups found for automation.",
    });
    return STOPPED_POLL_INTERVAL_MS;
  }

  const selectedAccountsById = new Map<string, FbAccountRecord>();
  for (let index = 0; index < activeGroups.length; index += 1) {
    const mapped = getMappedAccountForGroup(activeGroups[index], activeAccounts, index);
    selectedAccountsById.set(mapped.id, mapped);
  }

  const selectedAccounts = Array.from(selectedAccountsById.values());

  const availableSelectedAccounts = selectedAccounts.filter(
    (account) => getAccountCooldownRemainingMs(account.id) === 0
  );
  const maxParallelAccounts = Math.max(1, automation.settings.parallelAccounts);
  const activeCycleAccounts = availableSelectedAccounts.slice(0, maxParallelAccounts);

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

  if (activeCycleAccounts.length === 0) {
    const soonestMs = Math.min(
      ...selectedAccounts
        .map((account) => getAccountCooldownRemainingMs(account.id))
        .filter((remaining) => remaining > 0)
    );

    await appendLog({
      level: "info",
      message: "All selected accounts are in temporary cooldown due to Facebook limits. Waiting for cooldown expiry.",
    });

    return Number.isFinite(soonestMs)
      ? Math.max(STOPPED_POLL_INTERVAL_MS, Math.min(POLL_INTERVAL_MS, soonestMs))
      : STOPPED_POLL_INTERVAL_MS;
  }

  if (isFreshAutomationStart) {
    await appendLog({
      level: "info",
      message: `Automation selection ready: ${activeCycleAccounts.length}/${selectedAccounts.length} account(s) active this cycle (limit=${maxParallelAccounts}), ${activeGroups.length} group(s).`,
    });
  }

  if (availableSelectedAccounts.length > activeCycleAccounts.length) {
    await appendLog({
      level: "info",
      message: `parallelAccounts limit applied: processing ${activeCycleAccounts.length} account(s) this cycle, ${availableSelectedAccounts.length - activeCycleAccounts.length} queued for later cycles.`,
    });
  }

  if (SKIP_PREFLIGHT_IN_VISIBLE_MODE) {
    for (const account of activeCycleAccounts) {
      readyAccountSessions.add(account.id);
    }

    if (isFreshAutomationStart) {
      await appendLog({
        level: "info",
        message:
          "Visible debug mode is enabled. Skipping preflight so the full login/post flow runs inside the visible publish browser.",
      });
    }
  } else {
    for (const account of activeCycleAccounts) {
      if (readyAccountSessions.has(account.id)) {
        continue;
      }

      const ready = await preflightAccountSession(account);
      if (ready) {
        readyAccountSessions.add(account.id);
      } else {
        readyAccountSessions.delete(account.id);
      }
    }
  }

  const readySelectedCount = activeCycleAccounts.filter((account) => readyAccountSessions.has(account.id)).length;
  if (readySelectedCount === 0) {
    await appendLog({
      level: "error",
      message: "No selected account passed session preflight. Posting cycle aborted.",
    });
    return STOPPED_POLL_INTERVAL_MS;
  }

  const activeCycleAccountIds = new Set(activeCycleAccounts.map((account) => account.id));

  const accountSwitchDelayMs =
    automation.settings.delayBetweenAccountsMinutes * 60_000;

  for (let index = 0; index < activeGroups.length; index += 1) {
    if (!(await isAutomationRunning())) {
      await appendLog({
        level: "info",
        message: "Automation stop requested. Ending current worker cycle.",
      });
      break;
    }

    const group = activeGroups[index];
    const account = getMappedAccountForGroup(group, activeAccounts, index);

    if (!activeCycleAccountIds.has(account.id)) {
      continue;
    }

    const dashboardEnabled = await isAccountEnabledInDashboard(account.id).catch(() => false);
    if (!dashboardEnabled) {
      readyAccountSessions.delete(account.id);
      await appendLog({
        level: "info",
        message: `Skipping group ${group.groupId} because account ${account.name} is disabled in dashboard.`,
        accountId: account.id,
        groupId: group.id,
      });
      continue;
    }

    const cooldownRemainingMs = getAccountCooldownRemainingMs(account.id);
    if (cooldownRemainingMs > 0) {
      await appendLog({
        level: "info",
        message: `Skipping group ${group.groupId} because account ${account.name} is cooling down (${Math.ceil(
          cooldownRemainingMs / 60_000
        )} minute(s) remaining).`,
        accountId: account.id,
        groupId: group.id,
      });
      continue;
    }

    if (!readyAccountSessions.has(account.id)) {
      await appendLog({
        level: "error",
        message: `Skipping group ${group.groupId} because account ${account.name} is not session-ready.`,
        accountId: account.id,
        groupId: group.id,
      });
      continue;
    }

    try {
      await processGroupPosts(group, account, automation.settings);
    } catch (error) {
      await appendLog({
        level: "error",
        message: `CSV processing failed for group ${group.groupId}`,
        accountId: account.id,
        groupId: group.id,
        details: error instanceof Error ? error.stack ?? error.message : "Unknown CSV error",
      });
    }

    if (index < activeGroups.length - 1) {
      await sleepWithStopCheck(accountSwitchDelayMs, "between groups");
    }
  }

  return Math.max(10_000, automation.settings.waitIntervalMinutes * 60_000);
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

  await appendLog({
    level: "info",
    message:
      `Worker started. Polling every ${POLL_INTERVAL_MS / 1000} seconds. ` +
      `Browser=${IS_VISIBLE_BROWSER ? "visible" : "headless"}, visualTrace=${ENABLE_VISUAL_TRACE ? "on" : "off"}, ` +
      `skipPreflightInVisible=${SKIP_PREFLIGHT_IN_VISIBLE_MODE ? "on" : "off"}, debugHoldMs=${DEBUG_BROWSER_HOLD_MS}.`,
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
    let nextDelayMs = POLL_INTERVAL_MS;

    try {
      nextDelayMs = await runCycle();
    } catch (error) {
      const details =
        error instanceof Error ? error.stack ?? error.message : "Unknown worker cycle error";
      await appendLog({
        level: "error",
        message: "Worker cycle failed unexpectedly.",
        details,
      });
      nextDelayMs = POLL_INTERVAL_MS;
    }

    setTimeout(() => {
      controllerLoop().catch(async (error) => {
        await appendLog({
          level: "error",
          message: "Worker controller loop crashed unexpectedly.",
          details: error instanceof Error ? error.stack ?? error.message : "Unknown loop error",
        });
      });
    }, nextDelayMs);
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
