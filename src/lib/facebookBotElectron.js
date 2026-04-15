const { createHmac } = require('node:crypto');
const { Builder, By, Key, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

const MOBILE_FACEBOOK_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const FACEBOOK_LOGIN_WAIT_MS = 60_000;
const TWO_FACTOR_FIELD_WAIT_MS = 20_000;

const LOGIN_FORM_INPUT_SELECTORS = ['input[name="email"]', 'input[name="pass"]'];

const FACEBOOK_LOGIN_SUBMIT_SELECTORS = [
  'button[name="login"]',
  'button[type="submit"]',
  'input[name="login"]',
  'input[type="submit"]',
  'div[role="button"][aria-label="Log in"]',
  'div[data-anchor-id="replay"][role="button"]',
  '[data-anchor-id="replay"][aria-label="Log in"]',
];

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

const TWO_FACTOR_SUBMIT_SELECTORS = [
  'button[name="submit"]',
  'button[type="submit"]',
  'button[value="Continue"]',
  'button[value="Confirm"]',
  'button[value="Log In"]',
  'input[type="submit"]',
  'button[id*="checkpointSubmitButton"]',
  '[role="button"][aria-label="Continue"][aria-disabled="false"]',
  '[role="button"][aria-label="Continue"]:not([aria-disabled="true"]):not([disabled])',
];

const TWO_FACTOR_URL_HINTS = ['two_factor', 'checkpoint', 'approvals_code', 'security_code', 'authentication'];

function emitLog(logger, message) {
  if (typeof logger === 'function') {
    logger(message);
  }
}

async function findFirstVisibleElement(driver, selectors) {
  for (const selector of selectors) {
    const elements = await driver.findElements(By.css(selector));
    for (const element of elements) {
      try {
        if (await element.isDisplayed()) {
          return element;
        }
      } catch {
        // Ignore stale/inaccessible element handles and keep searching.
      }
    }
  }

  return undefined;
}

async function findFirstVisibleEnabledElement(driver, selectors) {
  for (const selector of selectors) {
    const elements = await driver.findElements(By.css(selector));
    for (const element of elements) {
      try {
        if ((await element.isDisplayed()) && (await element.isEnabled())) {
          return element;
        }
      } catch {
        // Ignore stale/inaccessible element handles and keep searching.
      }
    }
  }

  return undefined;
}

async function clickFirstVisibleEnabledElement(driver, selectors) {
  const element = await findFirstVisibleEnabledElement(driver, selectors);
  if (!element) {
    return false;
  }

  await element.click();
  return true;
}

async function safeCurrentUrl(driver) {
  try {
    return await driver.getCurrentUrl();
  } catch {
    return '';
  }
}

async function hasAuthenticatedSession(driver) {
  const currentUrl = await safeCurrentUrl(driver);
  if (
    currentUrl.includes('/login') ||
    currentUrl.includes('/checkpoint') ||
    currentUrl.includes('two_factor') ||
    currentUrl.includes('approvals_code')
  ) {
    return false;
  }

  const loginMarkers = await driver.findElements(By.css('input[name="email"], input[name="pass"]'));
  return loginMarkers.length === 0;
}

async function isTwoFactorChallengePage(driver) {
  const url = (await safeCurrentUrl(driver)).toLowerCase();
  if (TWO_FACTOR_URL_HINTS.some((hint) => url.includes(hint))) {
    return true;
  }

  const candidate = await findFirstVisibleElement(driver, TWO_FACTOR_INPUT_SELECTORS);
  if (!candidate) {
    return false;
  }

  const hasLoginFormInput = Boolean(await findFirstVisibleElement(driver, LOGIN_FORM_INPUT_SELECTORS));
  return !hasLoginFormInput;
}

async function waitForLoginOutcome(driver, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await hasAuthenticatedSession(driver)) {
      return 'authenticated';
    }

    if (await isTwoFactorChallengePage(driver)) {
      return 'two-factor-required';
    }

    await driver.sleep(500);
  }

  const finalUrl = await safeCurrentUrl(driver);
  return finalUrl.includes('/login') ? 'still-on-login' : 'unknown';
}

async function waitForTwoFactorInput(driver, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const input = await findFirstVisibleEnabledElement(driver, TWO_FACTOR_INPUT_SELECTORS);
    if (input) {
      return input;
    }

    await driver.sleep(500);
  }

  return undefined;
}

async function readFacebookLoginErrorMessage(driver) {
  const selectors = [
    '#login_error',
    '[id*="login_error"]',
    '[data-sigil*="m_login_notice"]',
    '[role="alert"]',
  ];

  for (const selector of selectors) {
    const elements = await driver.findElements(By.css(selector));
    for (const element of elements) {
      try {
        if (await element.isDisplayed()) {
          const text = (await element.getText()).trim();
          if (text) {
            return text;
          }
        }
      } catch {
        // Ignore stale/inaccessible element handles and keep searching.
      }
    }
  }

  return undefined;
}

function decodeBase32Secret(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleanSecret = String(secret).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const char of cleanSecret) {
    const index = alphabet.indexOf(char);
    if (index < 0) {
      continue;
    }

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

function generateTotpCode(secret, timeMs = Date.now()) {
  const key = decodeBase32Secret(secret);
  if (key.length === 0) {
    throw new Error('The 2FA secret could not be decoded.');
  }

  const counter = Math.floor(timeMs / 30_000);
  const buffer = Buffer.alloc(8);

  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter & 0xffffffff, 4);

  const hmac = createHmac('sha1', key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(code % 1_000_000).padStart(6, '0');
}

function parseTwoFactorInput(rawInput) {
  const normalizedInput = String(rawInput ?? '').trim();
  if (!normalizedInput) {
    return { state: 'missing' };
  }

  const digitsOnly = normalizedInput.replace(/\D/g, '');
  const hasOnlyDigitsAndSeparators = normalizedInput.replace(/[0-9\s-]/g, '').length === 0;
  if (digitsOnly.length === 6 && hasOnlyDigitsAndSeparators) {
    return { state: 'ready', source: 'code', codes: [digitsOnly] };
  }

  const secretCandidate = normalizedInput
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/=+$/g, '');

  if (!/^[A-Z2-7]+$/.test(secretCandidate) || secretCandidate.length < 10) {
    return {
      state: 'invalid',
      message: 'Invalid 2FA value. Enter either a 6-digit authentication code or a valid Base32 2FA secret.',
    };
  }

  try {
    const codes = Array.from(
      new Set([
        generateTotpCode(secretCandidate, Date.now()),
        generateTotpCode(secretCandidate, Date.now() - 30_000),
        generateTotpCode(secretCandidate, Date.now() + 30_000),
      ])
    );

    return {
      state: 'ready',
      source: 'secret',
      codes,
    };
  } catch {
    return {
      state: 'invalid',
      message: 'Invalid 2FA secret. Verify the secret key and try again.',
    };
  }
}

async function handleTwoFactorChallenge(driver, twoFactorInput, logger) {
  const parsedInput = parseTwoFactorInput(twoFactorInput);
  if (parsedInput.state === 'missing') {
    throw new Error('Facebook requested 2FA. Provide a 2FA code or Base32 2FA secret and try again.');
  }

  if (parsedInput.state === 'invalid') {
    throw new Error(parsedInput.message);
  }

  const input = await waitForTwoFactorInput(driver, TWO_FACTOR_FIELD_WAIT_MS);
  if (!input) {
    throw new Error('Facebook requested 2FA, but no verification input field was detected.');
  }

  for (const code of parsedInput.codes) {
    emitLog(logger, `Submitting ${parsedInput.source === 'code' ? '2FA code' : 'generated 2FA token'}...`);

    try {
      await input.clear();
    } catch {
      // Ignore clear failures and continue with sendKeys.
    }

    await input.sendKeys(code);

    const clicked = await clickFirstVisibleEnabledElement(driver, TWO_FACTOR_SUBMIT_SELECTORS);
    if (!clicked) {
      await input.sendKeys(Key.RETURN);
    }

    const outcome = await waitForLoginOutcome(driver, 20_000);
    if (outcome === 'authenticated') {
      emitLog(logger, '2FA challenge solved successfully.');
      return;
    }

    if (outcome !== 'two-factor-required') {
      break;
    }
  }

  throw new Error(
    parsedInput.source === 'code'
      ? 'The provided 2FA code was not accepted. Verify the code and try again.'
      : 'The generated 2FA codes were not accepted. Verify the 2FA secret and try again.'
  );
}

function normalizeFacebookLoginUsername(username) {
  const normalized = String(username ?? '').trim();

  if (/^0\d{9}$/.test(normalized)) {
    return '+212' + normalized.substring(1);
  }

  return normalized;
}

async function startFacebookBot(credentials = {}, logger) {
  const email = normalizeFacebookLoginUsername(credentials.email);
  const password = String(credentials.password ?? '');
  const twoFactorSecret = String(credentials.twoFactorSecret ?? '').trim() || undefined;

  if (!email) {
    throw new Error('Email (or username/phone) is required.');
  }

  if (!password) {
    throw new Error('Password is required.');
  }

  const options = new chrome.Options();
  options.addArguments(
    '--disable-gpu',
    '--window-size=390,844',
    `--user-agent=${MOBILE_FACEBOOK_USER_AGENT}`,
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process'
  );
  options.excludeSwitches('enable-automation');

  const chromeBinaryPath = process.env.CHROME_BINARY_PATH;
  if (chromeBinaryPath) {
    options.setChromeBinaryPath(chromeBinaryPath);
  }

  const chromeDriverPath =
    process.env.CHROMEDRIVER_PATH ||
    process.env.SE_CHROMEDRIVER ||
    process.env.WEBDRIVER_CHROME_DRIVER;

  const builder = new Builder().forBrowser('chrome').setChromeOptions(options);

  if (chromeDriverPath) {
    builder.setChromeService(new chrome.ServiceBuilder(chromeDriverPath));
  }

  const driver = await builder.build();

  try {
    emitLog(logger, 'Browser started. Opening Facebook login page...');
    await driver.get('https://m.facebook.com/login');
    await driver.wait(until.elementLocated(By.name('email')), 15_000);

    const emailInput = await driver.findElement(By.name('email'));
    const passwordInput = await driver.findElement(By.name('pass'));

    try {
      await emailInput.clear();
    } catch {
      // Ignore clear failures and continue with sendKeys.
    }

    await emailInput.sendKeys(email);

    try {
      await passwordInput.clear();
    } catch {
      // Ignore clear failures and continue with sendKeys.
    }

    await passwordInput.sendKeys(password);
    emitLog(logger, 'Credentials entered. Submitting login...');

    const submitted = await clickFirstVisibleEnabledElement(driver, FACEBOOK_LOGIN_SUBMIT_SELECTORS);
    if (!submitted) {
      await passwordInput.sendKeys(Key.RETURN);
    }

    const initialOutcome = await waitForLoginOutcome(driver, FACEBOOK_LOGIN_WAIT_MS);

    if (initialOutcome === 'still-on-login') {
      const loginError = await readFacebookLoginErrorMessage(driver);
      throw new Error(
        loginError
          ? `Facebook stayed on login after submit: ${loginError}`
          : 'Facebook stayed on login after submit. Verify credentials and proxy quality, then try again.'
      );
    }

    if (initialOutcome === 'two-factor-required') {
      emitLog(logger, '2FA challenge detected. Attempting verification...');
      await handleTwoFactorChallenge(driver, twoFactorSecret, logger);
    }

    emitLog(logger, 'Waiting for authenticated session...');
    const authenticated = await hasAuthenticatedSession(driver);
    if (!authenticated) {
      const finalOutcome = await waitForLoginOutcome(driver, FACEBOOK_LOGIN_WAIT_MS);
      if (finalOutcome !== 'authenticated') {
        throw new Error('Unable to establish authenticated Facebook session.');
      }
    }

    emitLog(logger, 'Facebook session authenticated successfully.');
    return 'Facebook bot login flow completed successfully.';
  } finally {
    emitLog(logger, 'Closing browser session...');
    await driver.quit().catch(() => undefined);
  }
}

module.exports = {
  startFacebookBot,
};
