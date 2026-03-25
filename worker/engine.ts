import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";

import csvParser from "csv-parser";
import { createObjectCsvWriter } from "csv-writer";
import { Builder, By, until } from "selenium-webdriver";
import type { IWebDriverOptionsCookie, WebDriver } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome";
import parquet from "parquetjs-lite";

interface FbAccountRecord {
  id: string;
  name: string;
  username: string;
  password: string;
  socks5ProxyHost?: string;
  socks5ProxyPort?: number;
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
}

interface ProxyConfig {
  host: string;
  port: number;
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
const STORAGE_DIR = path.join(process.cwd(), "storage");
const AUTOMATION_STATE_PATH = path.join(STORAGE_DIR, "automation_state.json");
const LOGS_PARQUET_PATH = path.join(STORAGE_DIR, "logs.parquet");
const FB_ACCOUNTS_PARQUET_PATH = path.join(STORAGE_DIR, "fbAccounts.parquet");
const FB_GROUPS_PARQUET_PATH = path.join(STORAGE_DIR, "fbGroups.parquet");
const SESSION_STORE_PATH = path.join(STORAGE_DIR, "facebook_sessions.json");
const IS_DRY_RUN = process.env.WORKER_DRY_RUN !== "false";
const TEMP_IMAGE_DIR = path.join(os.tmpdir(), "sheet2social-worker");
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

async function readParquetRows<T>(filePath: string): Promise<T[]> {
  try {
    await fs.access(filePath);
  } catch {
    return [];
  }

  const reader = await parquet.ParquetReader.openFile(filePath);

  try {
    const cursor = reader.getCursor();
    const rows: T[] = [];

    let row = await cursor.next();
    while (row) {
      rows.push(row as T);
      row = await cursor.next();
    }

    return rows;
  } finally {
    await reader.close();
  }
}

async function writeParquetRows<T>(
  filePath: string,
  schemaDefinition: Record<string, ParquetField>,
  rows: T[]
): Promise<void> {
  await ensureStorageDir();

  const schema = new parquet.ParquetSchema(schemaDefinition);
  const writer = await parquet.ParquetWriter.openFile(schema, filePath);

  try {
    for (const row of rows) {
      await writer.appendRow(row as object);
    }
  } finally {
    await writer.close();
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

    if (status !== "posted") {
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

  rows[rowIndex].status = "Posted";

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

async function downloadImageToTemp(imageUrl: string): Promise<string> {
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
  postData: Pick<CsvPostRow, "post_text" | "image_url" | "comment_link">
): Promise<boolean> {
  const groupUrl = `https://facebook.com/groups/${groupId}`;
  await driver.get(groupUrl);
  await driver.wait(until.elementLocated(By.css("body")), 20_000);

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
  await createPostActivator.click();

  const postInput = await waitForFirstVisibleElement(
    driver,
    [
      "div[role='dialog'] div[role='textbox'][contenteditable='true']",
      "div[role='dialog'] div[contenteditable='true'][data-lexical-editor='true']",
    ],
    20_000
  );

  await postInput.click();
  await postInput.sendKeys(postData.post_text);

  let downloadedImagePath: string | null = null;
  try {
    if (postData.image_url.trim()) {
      downloadedImagePath = await downloadImageToTemp(postData.image_url.trim());
      const fileInput = await waitForFirstVisibleElement(
        driver,
        [
          "div[role='dialog'] input[type='file']",
          "input[type='file'][accept*='image']",
        ],
        20_000
      );
      await fileInput.sendKeys(downloadedImagePath);

      await driver.sleep(2_000);
    }

    const publishButton = await waitForFirstVisibleXpath(
      driver,
      [
        "//div[@role='dialog']//div[@role='button'][contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'post')]",
        "//div[@role='dialog']//span[normalize-space(text())='Post']/ancestor::div[@role='button'][1]",
      ],
      20_000
    );
    await publishButton.click();

    await waitForFirstVisibleXpath(
      driver,
      [
        "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'your post is now published')]",
        "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'posted')]",
      ],
      30_000
    );

    await driver.navigate().refresh();
    await driver.wait(until.elementLocated(By.css("body")), 20_000);

    const commentButton = await waitForFirstVisibleXpath(
      driver,
      [
        "(//div[@role='article'])[1]//div[@role='button'][contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'comment')][1]",
        "(//div[@role='article'])[1]//span[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'comment')]/ancestor::div[@role='button'][1]",
      ],
      25_000
    );
    await commentButton.click();

    const commentInput = await waitForFirstVisibleElement(
      driver,
      [
        "div[role='article'] div[role='textbox'][contenteditable='true']",
        "div[aria-label*='comment'] div[role='textbox'][contenteditable='true']",
      ],
      20_000
    );
    await commentInput.click();
    await commentInput.sendKeys(postData.comment_link, "\n");

    return true;
  } finally {
    if (downloadedImagePath) {
      await fs.unlink(downloadedImagePath).catch(() => undefined);
    }
  }
}

export async function initializeBrowser(
  proxyConfig: ProxyConfig | undefined,
  sessionCookies: IWebDriverOptionsCookie[]
): Promise<WebDriver> {
  const options = new chrome.Options();
  options.addArguments(
    "--headless=new",
    "--disable-gpu",
    "--window-size=1366,768",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process"
  );
  options.excludeSwitches("enable-automation");
  if (proxyConfig) {
    options.addArguments(`--proxy-server=socks5://${proxyConfig.host}:${proxyConfig.port}`);
  }

  const chromeBinaryPath = process.env.CHROME_BINARY_PATH;
  if (chromeBinaryPath) {
    options.setChromeBinaryPath(chromeBinaryPath);
  }

  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();
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

  return driver;
}

async function hasAuthenticatedSession(driver: WebDriver): Promise<boolean> {
  const currentUrl = await driver.getCurrentUrl();
  if (currentUrl.includes("/home") || currentUrl.includes("/feed")) {
    return true;
  }

  const loginMarkers = await driver.findElements(
    By.css('input[name="email"], input[name="pass"]')
  );

  return loginMarkers.length === 0;
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

async function loginAndCaptureSession(
  driver: WebDriver,
  account: FbAccountRecord
): Promise<IWebDriverOptionsCookie[]> {
  await driver.get("https://www.facebook.com/login");
  await driver.wait(until.elementLocated(By.name("email")), 15_000);

  const emailInput = await driver.findElement(By.name("email"));
  const passwordInput = await driver.findElement(By.name("pass"));

  await emailInput.clear();
  await emailInput.sendKeys(account.username);
  await passwordInput.clear();
  await passwordInput.sendKeys(account.password);

  const loginButton = await driver.findElement(By.css('button[name="login"]'));
  await loginButton.click();

  await driver.wait(async () => {
    const url = await driver.getCurrentUrl();
    return !url.includes("/login");
  }, 25_000);

  await switchFacebookLanguageToEnglishUS(driver);

  const cookies = await driver.manage().getCookies();
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
      message: `Dry run for group ${group.groupId}`,
      details: "Set WORKER_DRY_RUN=false to execute browser automation.",
    };
  }

  const sessionCookies = await getStoredSessionCookies(account.id);
  const proxyConfig =
    account.socks5ProxyHost && account.socks5ProxyPort
      ? {
          host: account.socks5ProxyHost,
          port: account.socks5ProxyPort,
        }
      : undefined;

  const driver = await initializeBrowser(
    proxyConfig,
    sessionCookies
  );

  try {
    let authenticated = await hasAuthenticatedSession(driver);

    if (!authenticated) {
      const freshCookies = await loginAndCaptureSession(driver, account);
      if (freshCookies.length > 0) {
        await saveStoredSessionCookies(account.id, freshCookies);
      }
      authenticated = await hasAuthenticatedSession(driver);
    }

    if (!authenticated) {
      return {
        success: false,
        message: "Unable to establish authenticated Facebook session",
      };
    }

    await driver.get(`https://www.facebook.com/groups/${group.groupId}`);
    await driver.wait(until.elementLocated(By.css("body")), 15_000);

    const published = await publishPost(driver, group.groupId, {
      post_text: pendingPost.post_text,
      image_url: pendingPost.image_url,
      comment_link: pendingPost.comment_link,
    });

    if (!published) {
      return {
        success: false,
        message: `Failed to publish post for group ${group.groupId}`,
      };
    }

    return {
      success: true,
      message: `Post published and comment added for group ${group.groupId}`,
    };
  } catch (error) {
    const details = error instanceof Error ? error.message : "Unknown Selenium error";
    return {
      success: false,
      message: "Selenium automation failed",
      details,
    };
  } finally {
    await driver.quit();
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

async function processGroupPosts(
  group: FbGroupRecord,
  account: FbAccountRecord,
  settings: AutomationSettings
): Promise<void> {
  const postCooldownMs = settings.waitIntervalMinutes * 60_000;

  for (let postCounter = 0; postCounter < settings.postsPerGroup; postCounter += 1) {
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
    if (result.success) {
      await markPostAsDone(group.csvPath, pending.rowIndex);
      await appendLog({
        level: "success",
        message: `Posted successfully at ${new Date().toISOString()} | account=${account.name} | groupId=${group.groupId}`,
        accountId: account.id,
        groupId: group.id,
        details: result.details,
      });
    } else {
      await appendLog({
        level: "error",
        message: result.message,
        accountId: account.id,
        groupId: group.id,
        details: result.details,
      });
    }

    if (postCounter < settings.postsPerGroup - 1) {
      await sleep(postCooldownMs);
    }
  }
}

async function runCycle(): Promise<number> {
  const automation = await readAutomationConfig();
  if (automation.state !== "running") {
    await appendLog({
      level: "info",
      message: "Automation is stopped; worker cycle skipped.",
    });
    return POLL_INTERVAL_MS;
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
    return POLL_INTERVAL_MS;
  }

  const accountSwitchDelayMs =
    automation.settings.delayBetweenAccountsMinutes * 60_000;

  for (let index = 0; index < activeGroups.length; index += 1) {
    const group = activeGroups[index];
    const account = getMappedAccountForGroup(group, activeAccounts, index);

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
      await sleep(accountSwitchDelayMs);
    }
  }

  return 10_000;
}

async function startWorker(): Promise<void> {
  await appendLog({
    level: "info",
    message: `Worker started. Polling every ${POLL_INTERVAL_MS / 1000} seconds.`,
  });

  if (process.argv.includes("--once")) {
    await runCycle();
    await appendLog({
      level: "info",
      message: "Worker executed in one-shot mode and is exiting.",
    });
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

startWorker().catch(async (error) => {
  const details = error instanceof Error ? error.stack ?? error.message : "Unknown worker startup error";
  await appendLog({
    level: "error",
    message: "Worker failed during startup.",
    details,
  });
  process.exit(1);
});
