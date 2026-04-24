import "server-only";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { Builder, By, Key, until } from "selenium-webdriver";
import type { IWebDriverOptionsCookie, WebDriver } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome";

import { readParquetRecords } from "@/lib/db";
import { getRuntimeStorageDir } from "@/lib/runtimePaths";
import { parseTwoFactorInput, type TwoFactorSource } from "@/lib/twoFactor";

type FbAccountRecord = {
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
};

type ProxyRecord = {
  id: string;
  ipAddress: string;
  port: number;
  username?: string;
  password?: string;
  enabled: boolean;
};

type ProxyConfig = {
  host: string;
  port: number;
  username?: string;
  password?: string;
};

type SessionStore = Record<string, IWebDriverOptionsCookie[]>;

type LoginOutcome = "authenticated" | "two-factor-required" | "still-on-login" | "unknown";

type LoginAndCaptureResult = {
  cookies: IWebDriverOptionsCookie[];
  requiredTwoFactor: boolean;
  twoFactorSource?: TwoFactorSource | "manual";
};

type TwoFactorHandlingResult =
  | { solved: true; source: TwoFactorSource | "manual" }
  | { solved: false; message: string };

type ManualLoginSession = {
  id: string;
  accountId: string;
  proxyPublicIp?: string;
  driver: WebDriver;
  cleanup: () => Promise<void>;
  createdAtMs: number;
};

type BrowserInitializationResult = {
  driver: WebDriver;
  cleanup: () => Promise<void>;
  proxyPublicIp?: string;
};

function hasDisplayServer(): boolean {
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function hasInteractiveDesktopSession(): boolean {
  if (process.platform !== "linux") {
    return true;
  }

  return hasDisplayServer();
}

function shouldRunHeadless(): boolean {
  const explicit = (process.env.CHROME_HEADLESS ?? "").trim().toLowerCase();
  const linuxWithoutDisplay = process.platform === "linux" && !hasDisplayServer();

  if (explicit === "true" || explicit === "1" || explicit === "yes") {
    return true;
  }

  if (explicit === "false" || explicit === "0" || explicit === "no") {
    if (linuxWithoutDisplay) {
      console.warn(
        "[facebookSession] CHROME_HEADLESS=false ignored because no display server is detected. Forcing headless mode."
      );
      return true;
    }

    return false;
  }

  // Default to headless on Linux servers with no display manager.
  return linuxWithoutDisplay;
}

export type FacebookLoginAttemptResult = {
  hasSession: boolean;
  message: string;
  proxyPublicIp?: string;
};

export type FacebookSessionStatus =
  | { hasSession: false; reason: "no-cookies" | "cookies-only"; cookieCount: number }
  | { hasSession: true; reason: "auth-cookies-present"; cookieCount: number };

const STORAGE_DIR = getRuntimeStorageDir();
const SESSION_STORE_PATH = path.join(STORAGE_DIR, "facebook_sessions.json");
const CHROMEDRIVER_LOG_PATH = path.join(STORAGE_DIR, "chromedriver.log");
const MOBILE_FACEBOOK_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const FACEBOOK_LOGIN_WAIT_MS = 60_000;
const MANUAL_LOGIN_SESSION_TTL_MS = 10 * 60_000;
const MANUAL_TWO_FACTOR_WAIT_MS = 120_000;
const PROXY_IP_DETECTION_WAIT_MS = 15_000;
const TWO_FACTOR_FIELD_WAIT_MS = 20_000;

const TWO_FACTOR_INPUT_SELECTORS = [
  'input[aria-label="Code"]',
  'input[data-bloks-name="bk.components.TextInput"][inputmode="numeric"]',
  'input[autocomplete="one-time-code"]',
  'input[name="approvals_code"]',
  'input[name="security_code"]',
  'input[id*="approvals"]',
  'input[id*="security"]',
  'input[inputmode="numeric"]',
  'input[data-bloks-name="bk.components.TextInput"]',
  'input[name="code"]',
];

const LOGIN_FORM_INPUT_SELECTORS = ['input[name="email"]', 'input[name="pass"]'];

const TWO_FACTOR_PROMPT_SELECTORS = [
  'h2[aria-label*="authentication app"]',
  '[aria-label*="Go to your authentication app"]',
  '[role="button"][aria-label="Continue"]',
  '[role="button"][aria-label="Try another way"]',
  'input[aria-label="Code"]',
];

const TWO_FACTOR_SUBMIT_SELECTORS = [
  "button[name='submit']",
  "button[type='submit']",
  "button[value='Continue']",
  "button[value='Confirm']",
  "button[value='Log In']",
  "input[type='submit']",
  "button[id*='checkpointSubmitButton']",
  '[role="button"][aria-label="Continue"][aria-disabled="false"]',
  '[role="button"][aria-label="Continue"]:not([aria-disabled="true"]):not([disabled])',
];

const FACEBOOK_LOGIN_SUBMIT_SELECTORS = [
  'button[name="login"]',
  'button[type="submit"]',
  'input[name="login"]',
  'input[type="submit"]',
  'div[role="button"][aria-label="Log in"]',
  'div[data-anchor-id="replay"][role="button"]',
  '[data-anchor-id="replay"][aria-label="Log in"]',
];

const TWO_FACTOR_URL_HINTS = ["two_factor", "checkpoint", "approvals_code", "security_code", "authentication"];
const PUBLIC_IP_CHECK_ENDPOINTS = [
  "https://api64.ipify.org?format=json",
  "https://api.ipify.org?format=json",
  "https://ipv4.icanhazip.com",
  "https://ifconfig.me/ip",
];

const manualLoginSessions = new Map<string, ManualLoginSession>();

async function ensureStorageDir(): Promise<void> {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
}

async function readSessionStore(): Promise<SessionStore> {
  await ensureStorageDir();

  try {
    const raw = await fs.readFile(SESSION_STORE_PATH, "utf8");
    return (JSON.parse(raw) as SessionStore) ?? {};
  } catch {
    return {};
  }
}

async function writeSessionStore(store: SessionStore): Promise<void> {
  await ensureStorageDir();
  await fs.writeFile(SESSION_STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

export async function getStoredSessionCookies(accountId: string): Promise<IWebDriverOptionsCookie[]> {
  const store = await readSessionStore();
  const cookies = store[accountId];
  return Array.isArray(cookies) ? cookies : [];
}

export function classifyStoredSessionCookies(cookies: IWebDriverOptionsCookie[]): FacebookSessionStatus {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return { hasSession: false, reason: "no-cookies", cookieCount: 0 };
  }

  const cookieNames = new Set(cookies.map((cookie) => String(cookie.name || "").trim().toLowerCase()));
  const hasAuthCookies = cookieNames.has("c_user") && cookieNames.has("xs");

  if (hasAuthCookies) {
    return { hasSession: true, reason: "auth-cookies-present", cookieCount: cookies.length };
  }

  return { hasSession: false, reason: "cookies-only", cookieCount: cookies.length };
}

async function saveStoredSessionCookies(
  accountId: string,
  cookies: IWebDriverOptionsCookie[]
): Promise<void> {
  const store = await readSessionStore();
  store[accountId] = cookies;
  await writeSessionStore(store);
}

export async function saveImportedSessionCookies(
  accountId: string,
  cookies: IWebDriverOptionsCookie[]
): Promise<FacebookSessionStatus> {
  const normalized = cookies.filter(isWebDriverCookie);
  await saveStoredSessionCookies(accountId, normalized);
  return classifyStoredSessionCookies(normalized);
}

function isWebDriverCookie(value: unknown): value is IWebDriverOptionsCookie {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.name === "string" && typeof candidate.value === "string";
}

async function readProxyConfig(account: FbAccountRecord): Promise<ProxyConfig | undefined> {
  if (account.proxyId) {
    const proxies = await readParquetRecords("proxies");
    const selected = proxies.find((proxy) => proxy.id === account.proxyId && proxy.enabled !== false) as
      | ProxyRecord
      | undefined;

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

async function createProxyAuthExtension(proxyConfig: ProxyConfig): Promise<string> {
  const extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), "sheet2social-proxy-"));
  const manifest = {
    manifest_version: 3,
    name: "Sheet2Social Proxy Auth",
    version: "1.0.0",
    permissions: ["webRequest", "webRequestAuthProvider", "proxy"],
    host_permissions: ["<all_urls>"],
    background: {
      service_worker: "background.js",
    },
  };

  const backgroundScript = `
const authUsername = ${JSON.stringify(proxyConfig.username ?? "")};
const authPassword = ${JSON.stringify(proxyConfig.password ?? "")};

chrome.proxy.settings.set({
  value: {
    mode: "fixed_servers",
    rules: {
      singleProxy: {
        scheme: "http",
        host: ${JSON.stringify(proxyConfig.host)},
        port: parseInt(${proxyConfig.port})
      }
    }
  },
  scope: "regular"
}, () => {});

chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (!details.isProxy) {
      callback({});
      return;
    }

    callback({
      authCredentials: {
        username: authUsername,
        password: authPassword,
      },
    });
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);
`;

  await fs.writeFile(path.join(extensionDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await fs.writeFile(path.join(extensionDir, "background.js"), backgroundScript.trim(), "utf8");

  return extensionDir;
}

function normalizeFacebookLoginUsername(username: string): string {
  const normalized = username.trim();

  // Facebook can drop un-prefixed local phone formats from foreign IP ranges.
  if (/^0\d{9}$/.test(normalized)) {
    return "+212" + normalized.substring(1);
  }

  return normalized;
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
    // Continue with regex extraction for non-JSON responses.
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
  for (const endpoint of PUBLIC_IP_CHECK_ENDPOINTS) {
    try {
      await driver.get(endpoint);
      await driver.wait(until.elementLocated(By.css("body")), PROXY_IP_DETECTION_WAIT_MS);

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

  const loginMarkers = await driver.findElements(By.css('input[name="email"], input[name="pass"]'));
  return loginMarkers.length === 0;
}

async function findFirstVisibleElement(driver: WebDriver, selectors: string[]) {
  for (const selector of selectors) {
    const elements = await driver.findElements(By.css(selector));
    for (const element of elements) {
      try {
        if (await element.isDisplayed()) {
          return element;
        }
      } catch {
        // Ignore detached elements and continue.
      }
    }
  }

  return undefined;
}

async function isElementDisabled(
  element: Awaited<ReturnType<WebDriver["findElement"]>>
): Promise<boolean> {
  const disabledAttribute = await element.getAttribute("disabled").catch(() => null);
  if (disabledAttribute !== null) {
    return true;
  }

  const ariaDisabled = (await element.getAttribute("aria-disabled").catch(() => ""))?.toLowerCase();
  return ariaDisabled === "true";
}

async function findFirstVisibleEnabledElement(driver: WebDriver, selectors: string[]) {
  for (const selector of selectors) {
    const elements = await driver.findElements(By.css(selector));
    for (const element of elements) {
      try {
        if (!(await element.isDisplayed())) {
          continue;
        }

        if (await isElementDisabled(element)) {
          continue;
        }

        return element;
      } catch {
        // Ignore detached elements and continue.
      }
    }
  }

  return undefined;
}

async function hasTwoFactorPromptVisible(driver: WebDriver): Promise<boolean> {
  return Boolean(await findFirstVisibleElement(driver, TWO_FACTOR_PROMPT_SELECTORS));
}

async function isLikelyTwoFactorInputElement(
  input: Awaited<ReturnType<WebDriver["findElement"]>>
): Promise<boolean> {
  const name = ((await input.getAttribute("name").catch(() => "")) ?? "").toLowerCase();
  const ariaLabel = ((await input.getAttribute("aria-label").catch(() => "")) ?? "").toLowerCase();
  const inputMode = ((await input.getAttribute("inputmode").catch(() => "")) ?? "").toLowerCase();
  const type = ((await input.getAttribute("type").catch(() => "")) ?? "").toLowerCase();

  if (name === "email" || name === "pass") {
    return false;
  }

  if (ariaLabel.includes("code")) {
    return true;
  }

  if (name.includes("approvals") || name.includes("security") || name === "code" || name.includes("otp")) {
    return true;
  }

  if (inputMode === "numeric") {
    return true;
  }

  if (type === "number") {
    return true;
  }

  return false;
}

async function clickFirstVisibleElement(driver: WebDriver, selectors: string[]): Promise<boolean> {
  const target = await findFirstVisibleElement(driver, selectors);
  if (!target) {
    return false;
  }

  try {
    await target.click();
    return true;
  } catch {
    try {
      await driver.actions({ async: true }).move({ origin: target }).click().perform();
      return true;
    } catch {
      // Fall through to script click fallback.
    }

    try {
      await driver.executeScript("arguments[0].click();", target);
      return true;
    } catch {
      return false;
    }
  }
}

async function clickFirstVisibleEnabledElement(driver: WebDriver, selectors: string[]): Promise<boolean> {
  const target = await findFirstVisibleEnabledElement(driver, selectors);
  if (!target) {
    return false;
  }

  try {
    await target.click();
    return true;
  } catch {
    try {
      await driver.actions({ async: true }).move({ origin: target }).click().perform();
      return true;
    } catch {
      // Fall through to script click fallback.
    }

    try {
      await driver.executeScript("arguments[0].click();", target);
      return true;
    } catch {
      return false;
    }
  }
}

async function fillInputWithEvents(
  driver: WebDriver,
  input: Awaited<ReturnType<WebDriver["findElement"]>>,
  value: string
): Promise<void> {
  await input.click().catch(() => undefined);
  await driver.executeScript("arguments[0].focus();", input).catch(() => undefined);
  await input.clear().catch(() => undefined);
  await input.sendKeys(value).catch(() => undefined);

  const currentValue = (await input.getAttribute("value").catch(() => "")) ?? "";
  if (currentValue === value) {
    await driver
      .executeScript(
        "arguments[0].dispatchEvent(new Event('input', { bubbles: true })); arguments[0].dispatchEvent(new Event('change', { bubbles: true }));",
        input
      )
      .catch(() => undefined);
    return;
  }

  await driver
    .executeScript(
      `
        const el = arguments[0];
        const nextValue = arguments[1];
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

        if (setter) {
          setter.call(el, nextValue);
        } else {
          el.value = nextValue;
        }

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      `,
      input,
      value
    )
    .catch(() => undefined);

  const finalValue = (await input.getAttribute("value").catch(() => "")) ?? "";
  if (finalValue !== value) {
    await input.sendKeys(Key.chord(Key.CONTROL, "a"), value).catch(() => undefined);
    await driver
      .executeScript(
        "arguments[0].dispatchEvent(new Event('input', { bubbles: true })); arguments[0].dispatchEvent(new Event('change', { bubbles: true }));",
        input
      )
      .catch(() => undefined);
  }
}

function normalizeAutomationErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "Unknown automation error");

  if (/element not interactable/i.test(raw)) {
    return "Facebook interaction changed while automation was entering data. The flow could not interact with a required field/button. Please retry Auto Login once; if it still fails, use Manual Popup Login and click Logged In after completing 2FA.";
  }

  if (/stale element/i.test(raw)) {
    return "Facebook UI refreshed during automation. Please retry Auto Login.";
  }

  return raw;
}

async function clickTwoFactorContinueWithScript(driver: WebDriver): Promise<boolean> {
  try {
    return await driver.executeScript<boolean>(`
      const selectors = [
        '[role="button"][aria-label="Continue"][aria-disabled="false"]',
        '[role="button"][aria-label="Continue"]:not([aria-disabled="true"]):not([disabled])',
        'button[aria-label="Continue"]:not([disabled])'
      ];

      const continueButton = selectors
        .map((selector) => document.querySelector(selector))
        .find((node) => node instanceof HTMLElement);

      if (!(continueButton instanceof HTMLElement)) {
        return false;
      }

      try {
        continueButton.scrollIntoView({ block: 'center', inline: 'center' });
      } catch {
        // Continue with event dispatch.
      }

      const eventTypes = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
      for (const eventType of eventTypes) {
        if (eventType.startsWith('pointer') && typeof PointerEvent !== 'undefined') {
          continueButton.dispatchEvent(new PointerEvent(eventType, { bubbles: true, cancelable: true }));
        } else {
          continueButton.dispatchEvent(new MouseEvent(eventType, { bubbles: true, cancelable: true }));
        }
      }

      if (typeof continueButton.click === 'function') {
        continueButton.click();
      }

      return true;
    `);
  } catch {
    return false;
  }
}

async function submitFacebookLoginFormWithScript(driver: WebDriver): Promise<boolean> {
  try {
    return await driver.executeScript<boolean>(`
      const bloksLoginSelectors = [
        'div[role="button"][aria-label="Log in"]',
        'div[data-anchor-id="replay"][role="button"]',
        '[data-anchor-id="replay"][aria-label="Log in"]'
      ];

      const bloksButton = bloksLoginSelectors
        .map((selector) => document.querySelector(selector))
        .find((node) => node instanceof HTMLElement);

      if (bloksButton instanceof HTMLElement) {
        try {
          bloksButton.scrollIntoView({ block: 'center', inline: 'center' });
        } catch {
          // Continue with click dispatch.
        }

        const eventTypes = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
        for (const eventType of eventTypes) {
          if (eventType.startsWith('pointer') && typeof PointerEvent !== 'undefined') {
            bloksButton.dispatchEvent(new PointerEvent(eventType, { bubbles: true, cancelable: true }));
          } else {
            bloksButton.dispatchEvent(new MouseEvent(eventType, { bubbles: true, cancelable: true }));
          }
        }

        if (typeof bloksButton.click === 'function') {
          bloksButton.click();
        }

        return true;
      }

      const passInput = document.querySelector('input[name="pass"]');
      const emailInput = document.querySelector('input[name="email"]');
      const form = (passInput && passInput.form) || (emailInput && emailInput.form) || document.querySelector('form');

      if (!form) {
        return false;
      }

      const submitter = form.querySelector('button[name="login"], button[type="submit"], input[name="login"], input[type="submit"]');
      if (submitter && typeof submitter.click === 'function') {
        submitter.click();
        return true;
      }

      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
        return true;
      }

      if (typeof form.submit === 'function') {
        form.submit();
        return true;
      }

      return false;
    `);
  } catch {
    return false;
  }
}

async function submitFacebookLoginCredentials(
  driver: WebDriver,
  emailInput: Awaited<ReturnType<WebDriver["findElement"]>>,
  passwordInput: Awaited<ReturnType<WebDriver["findElement"]>>
): Promise<void> {
  const clickedLogin = await clickFirstVisibleElement(driver, FACEBOOK_LOGIN_SUBMIT_SELECTORS);
  if (clickedLogin) {
    const outcomeAfterClick = await waitForLoginOutcome(driver, 5_000);
    if (outcomeAfterClick !== "still-on-login") {
      return;
    }
  }

  const submittedByScript = await submitFacebookLoginFormWithScript(driver);
  if (submittedByScript) {
    const outcomeAfterScriptSubmit = await waitForLoginOutcome(driver, 5_000);
    if (outcomeAfterScriptSubmit !== "still-on-login") {
      return;
    }
  }

  await passwordInput.sendKeys(Key.RETURN).catch(() => undefined);
  await emailInput.sendKeys(Key.RETURN).catch(() => undefined);
}

async function readFacebookLoginErrorMessage(driver: WebDriver): Promise<string | undefined> {
  const selectors = [
    'div[role="alert"]',
    '#login_error',
    '[id*="login_error"]',
    '[data-sigil*="m_login_notice"]',
  ];

  for (const selector of selectors) {
    const nodes = await driver.findElements(By.css(selector));
    for (const node of nodes) {
      try {
        if (!(await node.isDisplayed())) {
          continue;
        }

        const text = (await node.getText()).trim();
        if (text) {
          return text;
        }
      } catch {
        // Ignore detached elements and continue scanning.
      }
    }
  }

  return undefined;
}

async function isTwoFactorChallengePage(driver: WebDriver): Promise<boolean> {
  const currentUrl = (await driver.getCurrentUrl()).toLowerCase();
  if (TWO_FACTOR_URL_HINTS.some((hint) => currentUrl.includes(hint))) {
    return true;
  }

  const headingMarkers = await driver.findElements(
    By.css('h2[aria-label*="authentication app"], [aria-label*="Go to your authentication app"]')
  );
  if (headingMarkers.length > 0) {
    return true;
  }

  return Boolean(await findFirstVisibleElement(driver, TWO_FACTOR_INPUT_SELECTORS));
}

async function waitForAuthenticatedSession(driver: WebDriver, timeoutMs: number): Promise<boolean> {
  const timeoutAt = Date.now() + timeoutMs;
  while (Date.now() < timeoutAt) {
    if (await hasAuthenticatedSession(driver)) {
      return true;
    }

    await driver.sleep(450);
  }

  return hasAuthenticatedSession(driver);
}

async function waitForLoginOutcome(driver: WebDriver, timeoutMs: number): Promise<LoginOutcome> {
  const timeoutAt = Date.now() + timeoutMs;

  while (Date.now() < timeoutAt) {
    if (await hasAuthenticatedSession(driver)) {
      return "authenticated";
    }

    if (await isTwoFactorChallengePage(driver)) {
      return "two-factor-required";
    }

    await driver.sleep(450);
  }

  if (await hasAuthenticatedSession(driver)) {
    return "authenticated";
  }

  if (await isTwoFactorChallengePage(driver)) {
    return "two-factor-required";
  }

  const finalUrl = (await driver.getCurrentUrl()).toLowerCase();
  return finalUrl.includes("/login") ? "still-on-login" : "unknown";
}

async function waitForTwoFactorInput(driver: WebDriver, timeoutMs: number) {
  const timeoutAt = Date.now() + timeoutMs;

  while (Date.now() < timeoutAt) {
    const input = await findFirstVisibleEnabledElement(driver, TWO_FACTOR_INPUT_SELECTORS);
    if (input && (await isLikelyTwoFactorInputElement(input))) {
      const hasPrompt = await hasTwoFactorPromptVisible(driver);
      const hasLoginFormInput = Boolean(await findFirstVisibleElement(driver, LOGIN_FORM_INPUT_SELECTORS));

      if (hasPrompt || !hasLoginFormInput) {
        await input.click().catch(() => undefined);
        await driver.executeScript("arguments[0].focus();", input).catch(() => undefined);
        return input;
      }
    }

    if (await hasAuthenticatedSession(driver)) {
      return undefined;
    }

    await driver.sleep(250);
  }

  return undefined;
}

async function waitForManualTwoFactorCompletion(driver: WebDriver): Promise<boolean> {
  return waitForAuthenticatedSession(driver, MANUAL_TWO_FACTOR_WAIT_MS);
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

async function handleTwoFactorChallenge(
  driver: WebDriver,
  twoFactorInput?: string
): Promise<TwoFactorHandlingResult> {
  const parsedInput = parseTwoFactorInput(twoFactorInput);

  if (parsedInput.state === "missing") {
    const manualCompletion = await waitForManualTwoFactorCompletion(driver);
    if (manualCompletion) {
      return { solved: true, source: "manual" };
    }

    return {
      solved: false,
      message:
        "Facebook requested 2FA. Enter a 6-digit 2FA code or Base32 secret, or complete the challenge manually in the opened browser window and try again.",
    };
  }

  if (parsedInput.state === "invalid") {
    return {
      solved: false,
      message: parsedInput.message,
    };
  }

  for (const code of parsedInput.codes) {
    const input = await waitForTwoFactorInput(driver, TWO_FACTOR_FIELD_WAIT_MS);
    if (!input) {
      return {
        solved: false,
        message: "Facebook requested 2FA, but no verification input field was detected.",
      };
    }

    await fillInputWithEvents(driver, input, code);
    await driver.sleep(350);

    let clicked = await clickFirstVisibleEnabledElement(driver, TWO_FACTOR_SUBMIT_SELECTORS);
    if (!clicked) {
      clicked = await clickTwoFactorContinueWithScript(driver);
    }

    if (!clicked) {
      await input.sendKeys(Key.RETURN).catch(() => undefined);
    }

    const outcome = await waitForLoginOutcome(driver, 20_000);
    if (outcome === "authenticated") {
      return {
        solved: true,
        source: parsedInput.source,
      };
    }

    if (outcome !== "two-factor-required") {
      break;
    }
  }

  return {
    solved: false,
    message:
      parsedInput.source === "code"
        ? "The provided 2FA code was not accepted. Verify the code and try again."
        : "The generated 2FA codes were not accepted. Verify the 2FA secret and try again.",
  };
}

async function loginAndCaptureSession(
  driver: WebDriver,
  account: FbAccountRecord
): Promise<LoginAndCaptureResult> {
  await driver.get("https://m.facebook.com/login");
  await driver.wait(until.elementLocated(By.name("email")), 15_000);

  const emailInput = await driver.findElement(By.name("email"));
  const passwordInput = await driver.findElement(By.name("pass"));

  const loginUsername = normalizeFacebookLoginUsername(account.username);

  await fillInputWithEvents(driver, emailInput, loginUsername);
  await fillInputWithEvents(driver, passwordInput, account.password);

  await submitFacebookLoginCredentials(driver, emailInput, passwordInput);

  let requiredTwoFactor = false;
  let twoFactorSource: TwoFactorSource | "manual" | undefined;
  const initialOutcome = await waitForLoginOutcome(driver, FACEBOOK_LOGIN_WAIT_MS);

  if (initialOutcome === "still-on-login") {
    const loginError = await readFacebookLoginErrorMessage(driver);
    throw new Error(
      loginError
        ? `Facebook stayed on login after submit: ${loginError}`
        : "Facebook stayed on login after submit. Verify credentials, proxy quality, or checkpoint requirements and try again."
    );
  }

  if (initialOutcome === "two-factor-required") {
    requiredTwoFactor = true;
    const challengeResult = await handleTwoFactorChallenge(driver, account.twoFactorSecret);
    if (!challengeResult.solved) {
      throw new Error(challengeResult.message);
    }
    twoFactorSource = challengeResult.source;
  }

  const authenticated = await waitForAuthenticatedSession(driver, FACEBOOK_LOGIN_WAIT_MS);
  if (!authenticated) {
    if (requiredTwoFactor) {
      throw new Error("2FA was submitted but Facebook did not complete the authenticated session.");
    }

    throw new Error("Unable to establish authenticated Facebook session.");
  }

  await switchFacebookLanguageToEnglishUS(driver);

  const cookies = await driver.manage().getCookies();
  return {
    cookies: cookies.filter(isWebDriverCookie),
    requiredTwoFactor,
    twoFactorSource,
  };
}

function resolveChromedriverPath(): string | undefined {
  const { existsSync, readdirSync, statSync } = require("node:fs") as typeof import("fs");
  const isWindows = process.platform === "win32";

  // 1. Explicit env override
  const candidates: string[] = [];
  if (process.env.CHROMEDRIVER_PATH) {
    candidates.push(process.env.CHROMEDRIVER_PATH);
  }

  // 2. Project-bundled driver on Windows only.
  // The repository ships a Windows chromedriver.exe for desktop/Electron flows.
  // Linux servers must not try to execute it.
  if (isWindows) {
    const bundled = path.join(process.cwd(), "drivers", "chromedriver.exe");
    if (existsSync(bundled)) return bundled;
  }

  // 3. Common Linux/macOS system installs.
  for (const candidate of ["/usr/bin/chromedriver", "/usr/local/bin/chromedriver", "/snap/bin/chromedriver"]) {
    candidates.push(candidate);
  }

  // 4. Well-known selenium-manager cache locations on Windows
  const homeDir = process.env.USERPROFILE ?? process.env.HOME ?? "";
  for (const subDir of ["win64", "windows"]) {
    candidates.push(path.join(homeDir, ".cache", "selenium", "chromedriver", subDir));
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    // Direct file path case (env var or installed driver)
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // ignore and fall through to directory handling
    }

    // Directory case – pick newest version from selenium-manager cache
    try {
      if (!existsSync(candidate)) continue;
      const versions = readdirSync(candidate).sort().reverse();
      for (const ver of versions) {
        const full = path.join(candidate, ver, isWindows ? "chromedriver.exe" : "chromedriver");
        if (existsSync(full)) return full;
      }
    } catch {
      // ignore
    }
  }

  return undefined;
}

async function resolveChromeBinaryPath(): Promise<string | undefined> {
  const configuredPath = process.env.CHROME_BINARY_PATH?.trim();

  if (!configuredPath) {
    return undefined;
  }

  try {
    await fs.access(configuredPath);
    return configuredPath;
  } catch {
    console.warn(
      `[facebookSession] Ignoring CHROME_BINARY_PATH because it is not accessible on this host: ${configuredPath}`
    );
    return undefined;
  }
}

function normalizeBrowserStartupErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Unknown browser startup error";

  if (/cannot find chrome binary|no chrome binary/i.test(raw)) {
    return "Chrome binary was not found. Install Google Chrome/Chromium and set CHROME_BINARY_PATH to a valid executable.";
  }

  if (/only supports chrome version|this version of chromedriver/i.test(raw)) {
    return "ChromeDriver does not match the installed Chrome version. Install matching versions or unset CHROMEDRIVER_PATH to use Selenium Manager.";
  }

  if (/chrome instance exited|devtoolsactiveport|failed to start.*exited/i.test(raw)) {
    return "Chrome exited immediately after launch. On VPS this usually means missing GUI requirements for headed mode or incompatible Chrome startup flags.";
  }

  return raw;
}


async function initializeBrowser(
  proxyConfig: ProxyConfig | undefined,
  sessionCookies: IWebDriverOptionsCookie[],
  initOptions?: { forceHeaded?: boolean }
): Promise<BrowserInitializationResult> {
  const driverOptions = new chrome.Options();
  let proxyExtensionDir: string | undefined;

  driverOptions.addArguments(
    "--disable-gpu",
    "--window-size=390,844",
    `--user-agent=${MOBILE_FACEBOOK_USER_AGENT}`,
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process"
  );
  driverOptions.excludeSwitches("enable-automation");

  if (!initOptions?.forceHeaded && shouldRunHeadless()) {
    driverOptions.addArguments("--headless=new");
  }

  if (proxyConfig) {
    if (proxyConfig.username && proxyConfig.password) {
      proxyExtensionDir = await createProxyAuthExtension(proxyConfig);
      driverOptions.addArguments(`--disable-extensions-except=${proxyExtensionDir}`);
      driverOptions.addArguments(`--load-extension=${proxyExtensionDir}`);
    } else {
      driverOptions.addArguments(`--proxy-server=http://${proxyConfig.host}:${proxyConfig.port}`);
    }
  }

  const chromeBinaryPath = await resolveChromeBinaryPath();
  if (chromeBinaryPath) {
    driverOptions.setChromeBinaryPath(chromeBinaryPath);
  }

  await ensureStorageDir();

  // Resolve chromedriver explicitly to avoid selenium-manager path virtualisation
  // in Next.js server routes (\ ROOT\ ... error).
  const chromedriverPath = resolveChromedriverPath();
  const service = chromedriverPath
    ? new chrome.ServiceBuilder(chromedriverPath)
    : new chrome.ServiceBuilder();
  service.enableVerboseLogging();
  service.loggingTo(CHROMEDRIVER_LOG_PATH);

  let driver: WebDriver;
  try {
    const builder = new Builder().forBrowser("chrome").setChromeOptions(driverOptions);
    builder.setChromeService(service);
    driver = await builder.build();
  } catch (error) {
    if (proxyExtensionDir) {
      await fs.rm(proxyExtensionDir, { recursive: true, force: true }).catch(() => undefined);
    }

    const message = normalizeBrowserStartupErrorMessage(error);
    throw new Error(`Unable to start browser session: ${message} ChromeDriver log: ${CHROMEDRIVER_LOG_PATH}`);
  }

  let proxyPublicIp: string | undefined;

  try {
    if (proxyConfig) {
      proxyPublicIp = await detectActivePublicIp(driver);
      if (!proxyPublicIp) {
        throw new Error(
          `The proxy is configured (${proxyConfig.host}:${proxyConfig.port}) but its public IP could not be detected. Please verify proxy credentials and connectivity.`
        );
      }
    }

    try {
      await driver.get("https://m.facebook.com/");
    } catch (error) {
      const errText = String(error);
      if (errText.includes("ERR_SOCKS_CONNECTION_FAILED") || errText.includes("ERR_PROXY_CONNECTION_FAILED")) {
        throw new Error(`The configured Proxy is unreachable or offline (${proxyConfig?.host}:${proxyConfig?.port}). Please fix or remove the proxy and try again.`);
      }
      if (errText.includes("ERR_CONNECTION_") || errText.includes("ERR_NAME_NOT_RESOLVED")) {
        throw new Error("Could not connect to Facebook. This is likely due to your network or proxy settings.");
      }
      throw error;
    }

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
      proxyPublicIp,
      cleanup: async () => {
        if (proxyExtensionDir) {
          await fs.rm(proxyExtensionDir, { recursive: true, force: true }).catch(() => undefined);
        }
      },
    };
  } catch (error) {
    await driver.quit().catch(() => undefined);
    if (proxyExtensionDir) {
      await fs.rm(proxyExtensionDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function closeManualLoginSession(manualLoginId: string): Promise<void> {
  const session = manualLoginSessions.get(manualLoginId);
  if (!session) {
    return;
  }

  manualLoginSessions.delete(manualLoginId);
  await session.driver.quit().catch(() => undefined);
  await session.cleanup().catch(() => undefined);
}

async function cleanupExpiredManualLoginSessions(): Promise<void> {
  const now = Date.now();
  const expired = Array.from(manualLoginSessions.values()).filter(
    (session) => now - session.createdAtMs > MANUAL_LOGIN_SESSION_TTL_MS
  );

  for (const session of expired) {
    await closeManualLoginSession(session.id);
  }
}

export async function startManualFacebookAccountLogin(
  accountId: string
): Promise<{ accountId: string; manualLoginId: string; message: string; proxyPublicIp?: string }> {
  await cleanupExpiredManualLoginSessions();

  if (!hasInteractiveDesktopSession()) {
    throw new Error(
      "Manual Popup Login requires a graphical desktop session. This VPS is running headless. Use Try Auto Login, or configure a display server (Xvfb) and set DISPLAY."
    );
  }

  const accounts = await readParquetRecords("fbAccounts");
  const account = accounts.find((item) => item.id === accountId) as FbAccountRecord | undefined;
  if (!account) {
    throw new Error("Account not found");
  }

  const proxyConfig = await readProxyConfig(account);
  let browser: BrowserInitializationResult | undefined;

  try {
    browser = await initializeBrowser(proxyConfig, await getStoredSessionCookies(account.id), {
      forceHeaded: true,
    });
    await browser.driver.get("https://m.facebook.com/login");
    await browser.driver.wait(until.elementLocated(By.css("body")), 15_000);

    const emailFields = await browser.driver.findElements(By.name("email"));
    if (emailFields.length > 0) {
      await fillInputWithEvents(browser.driver, emailFields[0], normalizeFacebookLoginUsername(account.username));
    }

    const passwordFields = await browser.driver.findElements(By.name("pass"));
    if (passwordFields.length > 0) {
      await fillInputWithEvents(browser.driver, passwordFields[0], account.password);

      await submitFacebookLoginCredentials(browser.driver, emailFields[0] ?? passwordFields[0], passwordFields[0]);
    }

    const manualLoginId = randomUUID();
    manualLoginSessions.set(manualLoginId, {
      id: manualLoginId,
      accountId: account.id,
      proxyPublicIp: browser.proxyPublicIp,
      driver: browser.driver,
      cleanup: browser.cleanup,
      createdAtMs: Date.now(),
    });

    return {
      accountId: account.id,
      manualLoginId,
      proxyPublicIp: browser.proxyPublicIp,
      message:
        browser.proxyPublicIp
          ? `Proxy activated successfully (IP: ${browser.proxyPublicIp}). Login was submitted automatically. Complete any Facebook checkpoint/2FA, then click Logged In.`
          : "Manual login popup is ready and login was submitted automatically. Complete any Facebook checkpoint/2FA, then click Logged In.",
    };
  } catch (error) {
    if (browser) {
      await browser.driver.quit().catch(() => undefined);
      await browser.cleanup().catch(() => undefined);
    }

    const message = error instanceof Error ? error.message : "Unable to start manual login popup";
    throw new Error(message);
  }
}

export async function finalizeManualFacebookAccountLogin(
  manualLoginId: string
): Promise<{ accountId?: string; hasSession: boolean; message: string; proxyPublicIp?: string }> {
  await cleanupExpiredManualLoginSessions();

  const session = manualLoginSessions.get(manualLoginId);
  if (!session) {
    return {
      hasSession: false,
      message: "Manual login session was not found or expired. Start manual login again.",
    };
  }

  const authenticated = await hasAuthenticatedSession(session.driver);
  if (!authenticated) {
    return {
      accountId: session.accountId,
      hasSession: false,
      proxyPublicIp: session.proxyPublicIp,
      message: "Login is not complete yet. Finish it in the browser popup, then click Logged In again.",
    };
  }

  const cookies = (await session.driver.manage().getCookies()).filter(isWebDriverCookie);
  if (cookies.length > 0) {
    await saveStoredSessionCookies(session.accountId, cookies);
  }

  await closeManualLoginSession(manualLoginId);

  const cookieStatus = classifyStoredSessionCookies(cookies);
  if (!cookieStatus.hasSession) {
    return {
      accountId: session.accountId,
      hasSession: false,
      proxyPublicIp: session.proxyPublicIp,
      message:
        "Cookies were captured, but required Facebook auth cookies were missing. Retry manual login and confirm again.",
    };
  }

  return {
    accountId: session.accountId,
    hasSession: true,
    proxyPublicIp: session.proxyPublicIp,
    message: "Manual login completed successfully. Session cookies are now saved.",
  };
}

export async function cancelManualFacebookAccountLogin(
  manualLoginId: string
): Promise<{ accountId?: string; message: string }> {
  await cleanupExpiredManualLoginSessions();

  const session = manualLoginSessions.get(manualLoginId);
  if (!session) {
    return { message: "Manual login session is already closed." };
  }

  const accountId = session.accountId;
  await closeManualLoginSession(manualLoginId);

  return {
    accountId,
    message: "Manual login popup closed.",
  };
}

export async function attemptFacebookAccountLogin(accountId: string): Promise<FacebookLoginAttemptResult> {
  const accounts = await readParquetRecords("fbAccounts");
  const account = accounts.find((item) => item.id === accountId) as FbAccountRecord | undefined;

  if (!account) {
    return { hasSession: false, message: "Account not found" };
  }

  const proxyConfig = await readProxyConfig(account);
  let browser: BrowserInitializationResult | undefined;

  try {
    browser = await initializeBrowser(proxyConfig, await getStoredSessionCookies(account.id));
    let authenticated = await hasAuthenticatedSession(browser.driver);
    let loginAttempt: LoginAndCaptureResult | undefined;

    if (!authenticated) {
      loginAttempt = await loginAndCaptureSession(browser.driver, account);
      if (loginAttempt.cookies.length > 0) {
        await saveStoredSessionCookies(account.id, loginAttempt.cookies);
      }
      authenticated = await hasAuthenticatedSession(browser.driver);
    }

    let message = "Unable to establish authenticated Facebook session";
    if (authenticated) {
      if (!loginAttempt) {
        message = "Login succeeded using saved session cookies.";
      } else if (!loginAttempt.requiredTwoFactor) {
        message = "Login succeeded. 2FA was not required.";
      } else if (loginAttempt.twoFactorSource === "code") {
        message = "Login succeeded. 2FA was required and solved with the provided 2FA code.";
      } else if (loginAttempt.twoFactorSource === "secret") {
        message = "Login succeeded. 2FA was required and solved with the stored 2FA secret.";
      } else {
        message = "Login succeeded. 2FA was required and completed manually in the browser popup.";
      }

      if (browser.proxyPublicIp) {
        message = `Proxy activated (IP: ${browser.proxyPublicIp}). ${message}`;
      }
    }

    return {
      hasSession: authenticated,
      message,
      proxyPublicIp: browser.proxyPublicIp,
    };
  } catch (error) {
    const message = normalizeAutomationErrorMessage(error);
    return { hasSession: false, message };
  } finally {
    if (browser) {
      await browser.driver.quit().catch(() => undefined);
      await browser.cleanup().catch(() => undefined);
    }
  }
}
