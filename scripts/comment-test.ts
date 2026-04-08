import "server-only";

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { Builder, By, until } from "selenium-webdriver";
import type { IWebDriverOptionsCookie, WebDriver } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome";
import { anonymizeProxy, closeAnonymizedProxy } from "proxy-chain";

import { initializeDbStorage, readParquetRecords } from "@/lib/db";
import type { FbAccount, FbGroup, ProxyRecord } from "@/lib/db/entities";
import { isCsvPostCompleted, readCsvPosts } from "@/lib/csvPosts";

type ProxyProtocol = "socks5" | "http";

interface ProxyTarget {
  host: string;
  port: number;
  username?: string;
  password?: string;
  protocols: ProxyProtocol[];
}

interface CliArgs {
  accountId?: string;
  groupId?: string;
  rowIndex?: number;
  commentLink?: string;
  visible: boolean;
}

const STORAGE_DIR = path.join(process.cwd(), "storage");
const SESSION_STORE_PATH = path.join(STORAGE_DIR, "facebook_sessions.json");

function resolveChromedriverPath(): string | undefined {
  const candidatePaths = [
    process.env.CHROMEDRIVER_PATH,
    path.join(process.cwd(), "drivers", "chromedriver.exe"),
    path.join(process.cwd(), "drivers", "chromedriver"),
  ].filter((value): value is string => Boolean(value));

  return candidatePaths.find((candidatePath) => existsSync(candidatePath));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv: string[]): CliArgs {
  const result: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      continue;
    }

    const separatorIndex = value.indexOf("=");
    if (separatorIndex > 0) {
      result[value.slice(2, separatorIndex)] = value.slice(separatorIndex + 1);
      continue;
    }

    const key = value.slice(2);
    const nextValue = argv[index + 1];
    if (nextValue && !nextValue.startsWith("--")) {
      result[key] = nextValue;
      index += 1;
    } else {
      result[key] = true;
    }
  }

  const rowIndexValue = result.rowIndex ?? result.postIndex;

  return {
    accountId: typeof result.accountId === "string" ? result.accountId.trim() : undefined,
    groupId: typeof result.groupId === "string" ? result.groupId.trim() : undefined,
    rowIndex:
      typeof rowIndexValue === "string" && rowIndexValue.trim().length > 0
        ? Number.parseInt(rowIndexValue.trim(), 10)
        : undefined,
    commentLink: typeof result.commentLink === "string" ? result.commentLink.trim() : undefined,
    visible: process.env.COMMENT_TEST_VISIBLE === "true" || result.visible === true,
  };
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeForComparison(value: string): string {
  return normalizeWhitespace(value)
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\u201c|\u201d/g, '"')
    .toLowerCase();
}

function buildPostSnippet(value: string): string {
  const normalized = normalizeForComparison(value);
  return normalized.length > 120 ? normalized.slice(0, 120) : normalized;
}

function isWebDriverCookie(value: unknown): value is IWebDriverOptionsCookie {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.name === "string" && typeof candidate.value === "string";
}

async function readSessionStore(): Promise<Record<string, IWebDriverOptionsCookie[]>> {
  try {
    const raw = await fs.readFile(SESSION_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, IWebDriverOptionsCookie[]>;
    return parsed ?? {};
  } catch {
    return {};
  }
}

async function getStoredSessionCookies(accountId: string): Promise<IWebDriverOptionsCookie[]> {
  const store = await readSessionStore();
  const cookies = store[accountId];

  if (!Array.isArray(cookies)) {
    return [];
  }

  return cookies.filter(isWebDriverCookie);
}

async function readParquetRows<T>(filePath: string): Promise<T[]> {
  try {
    const { default: parquet } = await import("parquetjs-lite");

    await fs.access(filePath);
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
      await reader.close().catch(() => undefined);
    }
  } catch {
    return [];
  }
}

async function resolveAccountProxyTarget(account: FbAccount): Promise<ProxyTarget | undefined> {
  if (account.proxyId) {
    const proxies = await readParquetRows<ProxyRecord>(path.join(STORAGE_DIR, "proxies.parquet"));
    const proxy = proxies.find((item) => item.id === account.proxyId && item.enabled !== false);

    if (proxy) {
      return {
        host: proxy.ipAddress,
        port: proxy.port,
        username: proxy.username,
        password: proxy.password,
        protocols: ["socks5", "http"],
      };
    }
  }

  if (account.socks5ProxyHost && account.socks5ProxyPort) {
    return {
      host: account.socks5ProxyHost,
      port: account.socks5ProxyPort,
      username: account.socks5ProxyUsername,
      password: account.socks5ProxyPassword,
      protocols: ["socks5", "http"],
    };
  }

  return undefined;
}

async function launchBrowser(
  proxyTarget: ProxyTarget | undefined,
  visible: boolean,
  sessionCookies: IWebDriverOptionsCookie[]
): Promise<{ driver: WebDriver; cleanup: () => Promise<void> }> {
  const proxyProtocols: Array<ProxyProtocol | undefined> = proxyTarget ? proxyTarget.protocols : [undefined];
  let lastError: unknown;

  for (const proxyProtocol of proxyProtocols) {
    const options = new chrome.Options();
    let anonymizedProxyUrl: string | undefined;

    if (!visible) {
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

    if (proxyTarget && proxyProtocol) {
      const credentials = proxyTarget.username || proxyTarget.password
        ? `${encodeURIComponent(proxyTarget.username ?? "")}:${encodeURIComponent(proxyTarget.password ?? "")}@`
        : "";
      const upstreamProxyUrl = `${proxyProtocol}://${credentials}${proxyTarget.host}:${proxyTarget.port}`;

      if (proxyTarget.username || proxyTarget.password) {
        anonymizedProxyUrl = await anonymizeProxy(upstreamProxyUrl);
        options.addArguments(`--proxy-server=${anonymizedProxyUrl}`);
      } else {
        options.addArguments(`--proxy-server=${proxyProtocol}://${proxyTarget.host}:${proxyTarget.port}`);
      }
    }

    const chromeBinaryPath = process.env.CHROME_BINARY_PATH;
    if (chromeBinaryPath) {
      options.setChromeBinaryPath(chromeBinaryPath);
    }

    const chromedriverPath = resolveChromedriverPath();
    const service = chromedriverPath ? new chrome.ServiceBuilder(chromedriverPath) : undefined;

    const builder = new Builder().forBrowser("chrome").setChromeOptions(options);
    if (service) {
      builder.setChromeService(service);
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
            // Ignore invalid cookie entries and continue.
          }
        }
        await driver.navigate().refresh();
      }

      await driver.executeScript(
        "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });"
      );

      return {
        driver,
        cleanup: async () => {
          if (anonymizedProxyUrl) {
            await closeAnonymizedProxy(anonymizedProxyUrl, true).catch(() => undefined);
          }
          await driver.quit().catch(() => undefined);
        },
      };
    } catch (error) {
      lastError = error;
      await driver.quit().catch(() => undefined);
      if (anonymizedProxyUrl) {
        await closeAnonymizedProxy(anonymizedProxyUrl, true).catch(() => undefined);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Unable to launch browser for comment test.");
}

async function waitForCommentInput(driver: WebDriver, article: Awaited<ReturnType<WebDriver["findElement"]>>) {
  const timeoutAt = Date.now() + 20_000;

  while (Date.now() < timeoutAt) {
    const candidates = await article.findElements(
      By.xpath(
        ".//div[@contenteditable='true' and (@role='textbox' or contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'comment'))]"
      )
    );

    for (const candidate of candidates) {
      try {
        if (await candidate.isDisplayed()) {
          return candidate;
        }
      } catch {
        // Ignore detached elements and continue polling.
      }
    }

    const globalCandidates = await driver.findElements(
      By.css("div[role='article'] div[role='textbox'][contenteditable='true'], form div[role='textbox'][contenteditable='true']")
    );
    for (const candidate of globalCandidates) {
      try {
        if (await candidate.isDisplayed()) {
          return candidate;
        }
      } catch {
        // Ignore detached elements and continue polling.
      }
    }

    await sleep(250);
  }

  throw new Error("Comment input box was not found after opening comments.");
}

async function findMatchingArticle(
  driver: WebDriver,
  expectedSnippet: string
): Promise<Awaited<ReturnType<WebDriver["findElement"]>>> {
  const articles = await driver.findElements(By.css("div[role='article']"));

  for (const article of articles.slice(0, 12)) {
    try {
      const articleText = normalizeForComparison(await article.getText());
      if (articleText.includes(expectedSnippet)) {
        return article;
      }
    } catch {
      // Ignore detached elements and continue scanning.
    }
  }

  throw new Error("Could not match the target done post in the group feed.");
}

async function clickCommentButton(article: Awaited<ReturnType<WebDriver["findElement"]>>): Promise<void> {
  let commentButtons = await article.findElements(
    By.xpath(
      ".//*[@role='button'][contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'comment')]"
    )
  );

  if (commentButtons.length === 0) {
    commentButtons = await article.findElements(
      By.xpath(
        ".//span[contains(translate(normalize-space(text()), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'comment')]/ancestor::*[@role='button'][1]"
      )
    );
  }

  if (commentButtons.length === 0) {
    commentButtons = await article.findElements(
      By.xpath(
        ".//*[@role='button'][contains(normalize-space(.), 'Comment') or contains(normalize-space(.), 'comment') or contains(normalize-space(.), 'تعليق')]"
      )
    );
  }

  if (commentButtons.length === 0) {
    throw new Error("Comment button not found on the matched post.");
  }

  await commentButtons[0].click().catch(async () => {
    await article.getDriver().executeScript("arguments[0].click();", commentButtons[0]);
  });
}

async function submitComment(
  driver: WebDriver,
  article: Awaited<ReturnType<WebDriver["findElement"]>>,
  commentText: string
): Promise<void> {
  await clickCommentButton(article);

  const commentInput = await waitForCommentInput(driver, article);
  await commentInput.click();
  await commentInput.sendKeys(commentText);

  let submitButtons = await driver.findElements(
    By.xpath(
      "//*[@role='button'][contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'post comment')]"
    )
  );

  if (submitButtons.length === 0) {
    submitButtons = await article.findElements(
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
    await commentInput.sendKeys("\n");
  }

  await driver.sleep(800);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.accountId || !args.groupId) {
    console.log(
      [
        "Usage: npm run comment:test -- --accountId <account-id> --groupId <group-id> [--rowIndex <csv-row-index>] [--commentLink <text>] [--visible]",
        "The script only comments on completed CSV rows and does not publish a new post.",
      ].join("\n")
    );
    process.exitCode = 1;
    return;
  }

  await initializeDbStorage();

  const [accounts, groups] = await Promise.all([
    readParquetRecords("fbAccounts"),
    readParquetRecords("fbGroups"),
  ]);

  const account = accounts.find((item) => item.id === args.accountId);
  if (!account) {
    throw new Error(`Account not found: ${args.accountId}`);
  }

  const group = groups.find((item) => item.id === args.groupId);
  if (!group) {
    throw new Error(`Group not found: ${args.groupId}`);
  }

  const posts = await readCsvPosts(group.csvPath);
  const targetRow =
    Number.isInteger(args.rowIndex) && args.rowIndex !== undefined
      ? posts.find((item) => item.rowIndex === args.rowIndex)
      : [...posts].reverse().find((item) => isCsvPostCompleted(item.status));

  if (!targetRow) {
    throw new Error("No completed CSV post was found for the selected group.");
  }

  if (!isCsvPostCompleted(targetRow.status)) {
    throw new Error(`Selected row ${targetRow.rowIndex} is not marked as completed.`);
  }

  const commentText = args.commentLink ?? targetRow.comment_link.trim();
  if (!commentText) {
    throw new Error(
      `No comment text was provided and row ${targetRow.rowIndex} does not have a comment_link value.`
    );
  }

  const proxyTarget = await resolveAccountProxyTarget(account);
  const sessionCookies = await getStoredSessionCookies(account.id);

  console.log(
    `Testing comment flow for account=${account.name} group=${group.groupId} row=${targetRow.rowIndex}`
  );

  const { driver, cleanup } = await launchBrowser(proxyTarget, args.visible, sessionCookies);

  try {
    const groupUrl = `https://www.facebook.com/groups/${group.groupId}`;
    await driver.get(groupUrl);
    await driver.wait(until.elementLocated(By.css("body")), 20_000);
    await driver.sleep(5_000);

    const expectedSnippet = buildPostSnippet(targetRow.post_text);
    const article = await findMatchingArticle(driver, expectedSnippet);

    console.log(`Matched post row ${targetRow.rowIndex}; submitting comment text.`);
    await submitComment(driver, article, commentText);

    console.log("Comment test completed successfully.");
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});