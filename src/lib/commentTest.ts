import "server-only";

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { Builder, By, until } from "selenium-webdriver";
import type { IWebDriverOptionsCookie, WebDriver } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome";
import { anonymizeProxy, closeAnonymizedProxy } from "proxy-chain";

import { isCsvPostCompleted, readCsvPosts } from "@/lib/csvPosts";
import { readParquetRecords } from "@/lib/db";
import type { FbAccount, FbGroup, ProxyRecord } from "@/lib/db/entities";
import { getRuntimeStorageDir, getRuntimeTraceDir, isUserDataRuntime } from "@/lib/runtimePaths";

type ProxyProtocol = "socks5" | "http";

type CommentTestInput = {
  accountId: string;
  groupId: string;
  rowIndex?: number;
  commentLink?: string;
  visible?: boolean;
  articleIndex?: number;
  captureMatchedPostScreenshot?: boolean;
};

export type CommentTestCandidate = {
  index: number;
  score: number;
  articleText: string;
  storyText: string;
  hasActionsMenu: boolean;
  hasCommentControl: boolean;
};

export type CommentCandidatePreview = {
  candidates: CommentTestCandidate[];
  rowIndex: number;
  postText: string;
  commentText: string;
  debugDetails?: string;
  screenshot?: string;
  pageSourcePath?: string;
  pageTitle?: string;
  domSummary?: string;
  accountId: string;
  accountName: string;
  groupId: string;
  groupLabel: string;
};

type CommentTestResult = {
  success: boolean;
  message: string;
  details?: string;
  matchedPostScreenshot?: string;
  accountId: string;
  accountName: string;
  groupId: string;
  groupLabel: string;
  rowIndex: number;
  postText: string;
  commentLink: string;
};

interface ProxyTarget {
  host: string;
  port: number;
  username?: string;
  password?: string;
  protocols: ProxyProtocol[];
}

const STORAGE_DIR = getRuntimeStorageDir();
const SESSION_STORE_PATH = path.join(STORAGE_DIR, "facebook_sessions.json");
const COMMENT_TEST_DUMP_DIR = path.join(STORAGE_DIR, "comment-test-dumps");
const TRACE_PUBLIC_DIR = getRuntimeTraceDir();
const TRACE_PUBLIC_ROUTE = "/automation-trace";

function sanitizeTraceLabel(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    return "trace";
  }

  return normalized.slice(0, 80);
}

async function captureTraceScreenshot(driver: WebDriver, label: string): Promise<string | undefined> {
  try {
    await fs.mkdir(TRACE_PUBLIC_DIR, { recursive: true });
    const screenshot = await driver.takeScreenshot();
    const fileName = `${Date.now()}-${sanitizeTraceLabel(label)}.png`;
    const filePath = path.join(TRACE_PUBLIC_DIR, fileName);
    await fs.writeFile(filePath, screenshot, "base64");

    if (isUserDataRuntime()) {
      return filePath;
    }

    return `${TRACE_PUBLIC_ROUTE}/${fileName}`;
  } catch {
    return undefined;
  }
}

async function capturePageSourceDump(driver: WebDriver, label: string): Promise<string | undefined> {
  try {
    await fs.mkdir(COMMENT_TEST_DUMP_DIR, { recursive: true });
    const html = await driver.getPageSource();
    const fileName = `${Date.now()}-${sanitizeTraceLabel(label)}.html`;
    const filePath = path.join(COMMENT_TEST_DUMP_DIR, fileName);
    await fs.writeFile(filePath, html, "utf8");
    return filePath;
  } catch {
    return undefined;
  }
}

async function warmUpFeed(driver: WebDriver): Promise<void> {
  await driver.executeScript("window.scrollTo(0, Math.max(document.body.scrollHeight * 0.35, 400));").catch(() => undefined);
  await sleep(700);
  await driver.executeScript("window.scrollTo(0, 0);").catch(() => undefined);
  await sleep(500);
}

async function collectFeedDiagnostics(driver: WebDriver): Promise<string> {
  const stats = await driver.executeScript(() => {
    const count = (selector: string) => document.querySelectorAll(selector).length;
    return {
      article: count("div[role='article']"),
      storyMessage: count("[data-ad-rendering-role='story_message']"),
      commentButtonRole: count("[role='button'][aria-label*='comment' i], [role='link'][aria-label*='comment' i]"),
      commentAdRole: count("[data-ad-rendering-role='comment_button']"),
      postActions: count("[aria-label='Actions for this post']"),
      textboxComment: count("div[role='textbox'][contenteditable='true'][aria-label*='comment' i]"),
    };
  }).catch(() => undefined) as
    | {
        article: number;
        storyMessage: number;
        commentButtonRole: number;
        commentAdRole: number;
        postActions: number;
        textboxComment: number;
      }
    | undefined;

  const issues: string[] = [];
  const currentUrl = await driver.getCurrentUrl().catch(() => "unknown");
  const pageTitle = await driver.getTitle().catch(() => "unknown");
  const body = await driver.findElement(By.css("body")).catch(() => undefined);
  const bodyText = body ? normalizeForComparison(await body.getText().catch(() => "")) : "";
  const articleCount = (await driver.findElements(By.css("div[role='article']")).catch(() => [])).length;

  if (currentUrl.includes("/login") || bodyText.includes("log in") || bodyText.includes("log into facebook")) {
    issues.push("Possible auth issue: page looks like login flow.");
  }

  if (bodyText.includes("join group") || bodyText.includes("private group") || bodyText.includes("only members can")) {
    issues.push("Group access issue: account may not be able to view this group feed.");
  }

  if (bodyText.includes("temporarily blocked") || bodyText.includes("try again later")) {
    issues.push("Facebook action limit or temporary block detected in page text.");
  }

  const domSummary = stats
    ? `DOM: article=${stats.article}, story_message=${stats.storyMessage}, comment_aria=${stats.commentButtonRole}, comment_ad_role=${stats.commentAdRole}, post_actions=${stats.postActions}, comment_textbox=${stats.textboxComment}`
    : "DOM: unavailable";

  const detailsParts = [`URL: ${currentUrl}`, `Title: ${pageTitle}`, `Article count: ${articleCount}`, domSummary];
  if (issues.length > 0) {
    detailsParts.push(`Signals: ${issues.join(" ")}`);
  }

  return detailsParts.join(" | ");
}

function resolveChromedriverPath(): string | undefined {
  const candidatePaths = [
    process.env.CHROMEDRIVER_PATH,
    path.join(process.cwd(), "drivers", "chromedriver.exe"),
    path.join(process.cwd(), "drivers", "chromedriver"),
  ].filter((value): value is string => Boolean(value));

  for (const candidatePath of candidatePaths) {
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function summarizeText(value: string, maxLength = 260): string {
  const normalized = normalizeWhitespace(value);
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
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

async function resolveAccountProxyTarget(account: FbAccount): Promise<ProxyTarget | undefined> {
  if (account.proxyId) {
    const proxies = await readParquetRecords("proxies");
    const proxy = proxies.find((item) => item.id === account.proxyId && item.enabled !== false) as
      | ProxyRecord
      | undefined;

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

  throw lastError instanceof Error ? lastError : new Error("Unable to launch browser for comment test.");
}

async function waitForCommentInput(
  driver: WebDriver,
  article: Awaited<ReturnType<WebDriver["findElement"]>>
) {
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

async function getCandidateContainers(
  driver: WebDriver
): Promise<Array<Awaited<ReturnType<WebDriver["findElement"]>>>> {
  const roleArticles = await driver.findElements(By.css("div[role='article']"));
  if (roleArticles.length > 0) {
    return roleArticles;
  }

  const fallbackContainers = await driver.findElements(
    By.xpath(
      "//*[@data-ad-rendering-role='story_message']/ancestor::*[.//*[@data-ad-rendering-role='comment_button' or (@aria-label and contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'comment'))]][1]"
    )
  );

  return fallbackContainers;
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
  const fragments = buildMatchFragments(expectedText);

  const storyBlocks = await driver.findElements(By.css("[data-ad-rendering-role='story_message']"));
  for (const block of storyBlocks.slice(0, 40)) {
    try {
      const storyText = normalizeForComparison(await block.getText());
      if (!storyText) {
        continue;
      }

      let matched = storyText.includes(normalizeForComparison(expectedText));
      for (const fragment of fragments) {
        if (storyText.includes(fragment)) {
          matched = true;
          break;
        }
      }

      if (!matched) {
        continue;
      }

      const article = await resolveContainerFromStoryBlock(block);
      return article;
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

      if (articleText.includes(normalizeForComparison(expectedText))) {
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
          if (storyText.includes(normalizeForComparison(expectedText))) {
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

  throw new Error("Could not match the target done post in the group feed.");
}

async function scoreArticleCandidate(
  article: Awaited<ReturnType<WebDriver["findElement"]>>,
  fragments: string[]
): Promise<Omit<CommentTestCandidate, "index">> {
  const articleText = normalizeForComparison(await article.getText());
  const storyBlocks = await article.findElements(By.css("[data-ad-rendering-role='story_message']"));
  const storyTextParts: string[] = [];

  for (const block of storyBlocks.slice(0, 3)) {
    try {
      storyTextParts.push(normalizeForComparison(await block.getText()));
    } catch {
      // Ignore detached story blocks and continue.
    }
  }

  const storyText = storyTextParts.join(" ");
  const hasActionsMenu = (await article.findElements(By.css("[aria-label='Actions for this post']"))).length > 0;
  const hasCommentControl = (
    await article.findElements(
      By.xpath(
        ".//*[@aria-label and contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'comment')]"
      )
    )
  ).length > 0;

  let score = 0;
  for (const fragment of fragments) {
    if (fragment.length >= 20 && articleText.includes(fragment)) {
      score += 6;
    } else if (fragment.length >= 16 && storyText.includes(fragment)) {
      score += 8;
    } else if (fragment.length >= 12 && storyText.includes(fragment)) {
      score += 4;
    } else if (fragment.length >= 12 && articleText.includes(fragment)) {
      score += 2;
    }
  }

  if (storyText.length > 0) {
    score += 2;
  }

  if (hasActionsMenu) {
    score += 2;
  }

  if (hasCommentControl) {
    score += 1;
  }

  return {
    score,
    articleText: summarizeText(articleText),
    storyText: summarizeText(storyText),
    hasActionsMenu,
    hasCommentControl,
  };
}

async function scanCommentCandidates(
  driver: WebDriver,
  expectedText: string
): Promise<CommentTestCandidate[]> {
  const articles = await getCandidateContainers(driver);
  const fragments = buildMatchFragments(expectedText);
  const scored: CommentTestCandidate[] = [];

  for (let index = 0; index < Math.min(articles.length, 20); index += 1) {
    try {
      const candidate = await scoreArticleCandidate(articles[index], fragments);
      scored.push({ index, ...candidate });
    } catch {
      // Ignore detached elements and continue scanning.
    }
  }

  scored.sort((left, right) => right.score - left.score);
  return scored;
}

async function chooseMatchedArticle(
  driver: WebDriver,
  expectedText: string,
  articleIndex?: number
): Promise<Awaited<ReturnType<WebDriver["findElement"]>>> {
  const articles = await getCandidateContainers(driver);

  if (typeof articleIndex === "number" && Number.isInteger(articleIndex) && articleIndex >= 0) {
    const selected = articles[articleIndex];
    if (!selected) {
      throw new Error(`Article index ${articleIndex} is not available in the current feed.`);
    }
    return selected;
  }

  const candidates = await scanCommentCandidates(driver, expectedText);
  const selectedCandidate = candidates[0];

  if (!selectedCandidate) {
    throw new Error("Could not match the target done post in the group feed.");
  }

  const selectedArticle = articles[selectedCandidate.index];
  if (!selectedArticle) {
    throw new Error("Could not resolve the matched candidate article in the feed.");
  }

  return selectedArticle;
}

async function clickCommentButton(
  driver: WebDriver,
  article: Awaited<ReturnType<WebDriver["findElement"]>>
): Promise<void> {
  const selectors = [
    ".//*[@data-ad-rendering-role='comment_button']/ancestor::*[@role='button' or @role='link'][1]",
    ".//*[@role='button' or @role='link'][contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'leave a comment') or contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'comment')]",
    ".//span[contains(translate(normalize-space(text()), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'comment')]/ancestor::*[@role='button' or @role='link'][1]",
    ".//*[@role='button' or @role='link'][contains(normalize-space(.), 'Comment') or contains(normalize-space(.), 'comment') or contains(normalize-space(.), 'تعليق')]",
  ];

  for (const selector of selectors) {
    const elements = await article.findElements(By.xpath(selector));
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

  const buttonCount = (await article.findElements(By.xpath(".//*[@role='button']"))).length;
  const linkCount = (await article.findElements(By.xpath(".//*[@role='link']"))).length;
  throw new Error(
    `Comment button not found on the matched post. role=button count: ${buttonCount}, role=link count: ${linkCount}.`
  );
}

async function setEditableText(
  driver: WebDriver,
  element: Awaited<ReturnType<WebDriver["findElement"]>>,
  value: string
): Promise<void> {
  await driver.executeScript(
    `
      const el = arguments[0];
      const nextValue = String(arguments[1] ?? "");

      const dispatchInputEvents = () => {
        try {
          el.dispatchEvent(new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: nextValue,
          }));
        } catch {
          // Ignore unsupported InputEvent constructor.
        }

        try {
          el.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: nextValue,
          }));
        } catch {
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }

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

async function submitComment(
  driver: WebDriver,
  article: Awaited<ReturnType<WebDriver["findElement"]>>,
  commentText: string
): Promise<void> {
  await clickCommentButton(driver, article);

  let commentInput: Awaited<ReturnType<WebDriver["findElement"]>> | undefined;

  for (let attempt = 1; attempt <= 3 && !commentInput; attempt += 1) {
    try {
      commentInput = await waitForCommentInput(driver, article);
      await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", commentInput).catch(() => undefined);
      await driver.executeScript("arguments[0].focus();", commentInput).catch(() => undefined);
      await setEditableText(driver, commentInput, commentText);
    } catch (error) {
      commentInput = undefined;
      const message = error instanceof Error ? error.message : "";
      if (!message.toLowerCase().includes("stale element")) {
        throw error;
      }
      await sleep(250 * attempt);
    }
  }

  if (!commentInput) {
    throw new Error("Comment input box was not found after opening comments.");
  }

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

export async function runCommentTest(input: CommentTestInput): Promise<CommentTestResult> {
  await fs.mkdir(STORAGE_DIR, { recursive: true });

  const [accounts, groups] = await Promise.all([
    readParquetRecords("fbAccounts"),
    readParquetRecords("fbGroups"),
  ]);

  const account = accounts.find((item) => item.id === input.accountId) as FbAccount | undefined;
  if (!account) {
    throw new Error(`Account not found: ${input.accountId}`);
  }

  const group = groups.find((item) => item.id === input.groupId) as FbGroup | undefined;
  if (!group) {
    throw new Error(`Group not found: ${input.groupId}`);
  }

  const posts = await readCsvPosts(group.csvPath);
  const targetRow =
    Number.isInteger(input.rowIndex) && input.rowIndex !== undefined
      ? posts.find((item) => item.rowIndex === input.rowIndex)
      : [...posts].reverse().find((item) => isCsvPostCompleted(item.status));

  if (!targetRow) {
    throw new Error("No completed CSV post was found for the selected group.");
  }

  if (!isCsvPostCompleted(targetRow.status)) {
    throw new Error(`Selected row ${targetRow.rowIndex} is not marked as completed.`);
  }

  const commentText = input.commentLink?.trim() || targetRow.comment_link.trim();
  if (!commentText) {
    throw new Error(
      `No comment text was provided and row ${targetRow.rowIndex} does not have a comment_link value.`
    );
  }

  const proxyTarget = await resolveAccountProxyTarget(account);
  const sessionCookies = await getStoredSessionCookies(account.id);
  const { driver, cleanup } = await launchBrowser(proxyTarget, input.visible === true, sessionCookies);
  const shouldCaptureMatchedPostScreenshot = input.captureMatchedPostScreenshot !== false;

  try {
    const groupUrl = `https://www.facebook.com/groups/${group.groupId}`;
    await driver.get(groupUrl);
    await driver.wait(until.elementLocated(By.css("body")), 20_000);
    await driver.sleep(5_000);
    await warmUpFeed(driver);

    let article: Awaited<ReturnType<WebDriver["findElement"]>>;
    try {
      article = await chooseMatchedArticle(driver, targetRow.post_text, input.articleIndex);
    } catch (error) {
      const diagnostics = await collectFeedDiagnostics(driver);
      const noMatchScreenshot = shouldCaptureMatchedPostScreenshot
        ? await captureTraceScreenshot(driver, `comment-test-no-match-row-${targetRow.rowIndex}`)
        : undefined;
      const pageSourcePath = await capturePageSourceDump(driver, `comment-test-no-match-row-${targetRow.rowIndex}`);
      const message = error instanceof Error ? error.message : "Could not match the target done post in the group feed.";
      const details = [
        message,
        diagnostics,
        noMatchScreenshot ? `Screenshot: ${noMatchScreenshot}` : undefined,
        pageSourcePath ? `Page source dump: ${pageSourcePath}` : undefined,
      ]
        .filter(Boolean)
        .join(" | ");
      throw new Error(details);
    }
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", article).catch(() => undefined);

    const matchedPostScreenshot = shouldCaptureMatchedPostScreenshot
      ? await captureTraceScreenshot(driver, `comment-test-matched-row-${targetRow.rowIndex}`)
      : undefined;

    try {
      await submitComment(driver, article, commentText);
    } catch (error) {
      const failedStepScreenshot = shouldCaptureMatchedPostScreenshot
        ? await captureTraceScreenshot(driver, `comment-test-fail-row-${targetRow.rowIndex}`)
        : undefined;
      const message = error instanceof Error ? error.message : "Unknown comment flow error.";
      throw new Error(
        failedStepScreenshot ? `${message} | Screenshot: ${failedStepScreenshot}` : message
      );
    }

    const detailsParts = [
      `Matched completed row ${targetRow.rowIndex} in group feed and submitted the comment action.`,
      matchedPostScreenshot ? `Matched-post screenshot: ${matchedPostScreenshot}` : undefined,
    ].filter(Boolean);

    return {
      success: true,
      message: "Comment test completed successfully.",
      details: detailsParts.join(" | "),
      matchedPostScreenshot,
      accountId: account.id,
      accountName: account.name,
      groupId: group.id,
      groupLabel: group.name || group.groupId,
      rowIndex: targetRow.rowIndex,
      postText: targetRow.post_text,
      commentLink: commentText,
    };
  } finally {
    await cleanup();
  }
}

export async function inspectCommentCandidates(input: CommentTestInput): Promise<CommentCandidatePreview> {
  await fs.mkdir(STORAGE_DIR, { recursive: true });

  const [accounts, groups] = await Promise.all([
    readParquetRecords("fbAccounts"),
    readParquetRecords("fbGroups"),
  ]);

  const account = accounts.find((item) => item.id === input.accountId) as FbAccount | undefined;
  if (!account) {
    throw new Error(`Account not found: ${input.accountId}`);
  }

  const group = groups.find((item) => item.id === input.groupId) as FbGroup | undefined;
  if (!group) {
    throw new Error(`Group not found: ${input.groupId}`);
  }

  const posts = await readCsvPosts(group.csvPath);
  const targetRow =
    Number.isInteger(input.rowIndex) && input.rowIndex !== undefined
      ? posts.find((item) => item.rowIndex === input.rowIndex)
      : [...posts].reverse().find((item) => isCsvPostCompleted(item.status));

  if (!targetRow) {
    throw new Error("No completed CSV post was found for the selected group.");
  }

  const commentText = input.commentLink?.trim() || targetRow.comment_link.trim();
  if (!commentText) {
    throw new Error(
      `No comment text was provided and row ${targetRow.rowIndex} does not have a comment_link value.`
    );
  }

  const proxyTarget = await resolveAccountProxyTarget(account);
  const sessionCookies = await getStoredSessionCookies(account.id);
  const { driver, cleanup } = await launchBrowser(proxyTarget, input.visible === true, sessionCookies);

  try {
    const groupUrl = `https://www.facebook.com/groups/${group.groupId}`;
    await driver.get(groupUrl);
    await driver.wait(until.elementLocated(By.css("body")), 20_000);
    await driver.sleep(5_000);
    await warmUpFeed(driver);

    const candidates = await scanCommentCandidates(driver, targetRow.post_text);
    const diagnostics = await collectFeedDiagnostics(driver);
    const noCandidatesScreenshot = candidates.length === 0
      ? await captureTraceScreenshot(driver, `comment-test-no-candidates-row-${targetRow.rowIndex}`)
      : undefined;
    const pageSourcePath = candidates.length === 0
      ? await capturePageSourceDump(driver, `comment-test-no-candidates-row-${targetRow.rowIndex}`)
      : undefined;
    const pageTitle = await driver.getTitle().catch(() => undefined);

    const domSummary = diagnostics.includes("DOM:")
      ? diagnostics.slice(diagnostics.indexOf("DOM:"))
      : undefined;

    return {
      candidates,
      rowIndex: targetRow.rowIndex,
      postText: targetRow.post_text,
      commentText,
      debugDetails: diagnostics,
      screenshot: noCandidatesScreenshot,
      pageSourcePath,
      pageTitle,
      domSummary,
      accountId: account.id,
      accountName: account.name,
      groupId: group.id,
      groupLabel: group.name || group.groupId,
    };
  } finally {
    await cleanup();
  }
}