/**
 * Salesforce session acquisition and storage.
 *
 * Credentials are never persisted and never read from the environment. The flow is:
 *
 *   1. UI posts username + password for one login attempt. They live in this process's
 *      memory only, for the life of the attempt.
 *   2. A headed Chromium fills the login form.
 *   3. If Salesforce challenges for MFA, the attempt parks at `awaiting-mfa` and the UI
 *      prompts for the code. The code is posted, typed, and discarded.
 *   4. On success the `sid` cookie for the *.my.salesforce.com domain is captured and
 *      written to data/sessions/<env>.json with mode 0600. That is the only thing that
 *      touches the disk.
 *   5. Every API call uses the stored sid as a Bearer token until Salesforce returns 401,
 *      at which point the session is marked expired and the UI asks for a fresh login.
 *
 * The sid must come from the *.my.salesforce.com host, not the Lightning host — only the
 * former is a valid Bearer token for /services/data. After login we navigate to the
 * instance URL explicitly to make sure that cookie is present before reading it.
 */

import path from 'node:path';
import fs from 'node:fs';
import { SESSIONS_DIR, writeSecret, readJson } from '../lib/paths.js';
import { getEnvironment } from '../lib/config.js';

const ATTEMPT_TTL_MS = 10 * 60 * 1000;
const NAV_TIMEOUT_MS = 60_000;

/** In-flight login attempts, keyed by id. Never serialised. */
const attempts = new Map();

let playwrightModule = null;
async function getPlaywright() {
  if (!playwrightModule) {
    try {
      playwrightModule = await import('playwright');
    } catch {
      throw new Error(
        'Playwright is not installed. Run `npm install` in the project root, then ' +
          '`npx playwright install chromium`.'
      );
    }
  }
  return playwrightModule;
}

function sessionFile(envName) {
  return path.join(SESSIONS_DIR, `${envName}.json`);
}

export function readSession(envName) {
  const stored = readJson(sessionFile(envName), null);
  if (!stored?.sid) return null;
  return stored;
}

export function clearSession(envName) {
  try {
    fs.unlinkSync(sessionFile(envName));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function saveSession(envName, session) {
  writeSecret(sessionFile(envName), JSON.stringify(session, null, 2) + '\n');
}

/** Public shape — deliberately omits the sid so it can be sent to the browser. */
export function describeSession(envName) {
  const s = readSession(envName);
  if (!s) return { connected: false, env: envName };
  return {
    connected: true,
    env: envName,
    username: s.username ?? null,
    instanceUrl: s.instanceUrl,
    apiVersion: s.apiVersion,
    capturedAt: s.capturedAt,
    ageMinutes: Math.round((Date.now() - new Date(s.capturedAt).getTime()) / 60000),
    lastVerifiedAt: s.lastVerifiedAt ?? null,
  };
}

export function markSessionExpired(envName, reason = 'Salesforce returned 401') {
  const s = readSession(envName);
  if (s) saveSession(envName, { ...s, expiredAt: new Date().toISOString(), expiredReason: reason });
  clearSession(envName);
}

export function markSessionVerified(envName) {
  const s = readSession(envName);
  if (s) saveSession(envName, { ...s, lastVerifiedAt: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Login attempt state machine
// ---------------------------------------------------------------------------

const MFA_INPUT_SELECTORS = [
  '#tc-verification-code',
  'input[name="EmailVerifCode"]',
  '#emc',
  '#smc',
  'input[id$="verification-code"]',
  'input[autocomplete="one-time-code"]',
];

const MFA_SUBMIT_SELECTORS = ['#save', 'input[value="Verify"]', 'button:has-text("Verify")'];

function publicAttempt(attempt) {
  return {
    attemptId: attempt.id,
    env: attempt.env,
    status: attempt.status,
    message: attempt.message,
    mfaPrompt: attempt.mfaPrompt ?? null,
    error: attempt.error ?? null,
    startedAt: attempt.startedAt,
  };
}

export function getAttempt(attemptId) {
  const attempt = attempts.get(attemptId);
  if (!attempt) throw new Error('Unknown or expired login attempt. Start a new login.');
  return attempt;
}

export function describeAttempt(attemptId) {
  return publicAttempt(getAttempt(attemptId));
}

async function teardown(attempt) {
  attempt.credentials = null;
  try {
    await attempt.browser?.close();
  } catch {
    /* browser already gone */
  }
  attempt.browser = null;
  attempt.page = null;
  attempt.context = null;
}

function scheduleExpiry(attempt) {
  attempt.timer = setTimeout(async () => {
    if (attempt.status === 'awaiting-mfa' || attempt.status === 'starting') {
      attempt.status = 'failed';
      attempt.error = 'Login attempt timed out after 10 minutes.';
      await teardown(attempt);
    }
    attempts.delete(attempt.id);
  }, ATTEMPT_TTL_MS);
  attempt.timer.unref?.();
}

/**
 * Begin a login. Returns immediately; the caller polls describeAttempt().
 */
export async function startLogin({ env, username, password, headless }) {
  const environment = getEnvironment(env);
  if (!username || !password) throw new Error('Username and password are both required.');

  const id = `login_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const attempt = {
    id,
    env,
    status: 'starting',
    message: 'Opening browser…',
    startedAt: new Date().toISOString(),
    credentials: { username, password },
    environment,
    headless: headless ?? process.env.HEADLESS === 'true',
    mfaResolver: null,
  };
  attempts.set(id, attempt);
  scheduleExpiry(attempt);

  // Fire and forget — progress is observed through the attempt record.
  runLogin(attempt).catch(async (err) => {
    attempt.status = 'failed';
    attempt.error = err.message;
    attempt.message = 'Login failed.';
    await teardown(attempt);
  });

  return publicAttempt(attempt);
}

/** Supply the MFA code the user read off their phone or mailbox. */
export async function submitMfaCode(attemptId, code) {
  const attempt = getAttempt(attemptId);
  if (attempt.status !== 'awaiting-mfa') {
    throw new Error(`Attempt is "${attempt.status}", not awaiting an MFA code.`);
  }
  const trimmed = String(code ?? '').trim();
  if (!/^\d{4,10}$/.test(trimmed)) throw new Error('Verification code should be 4–10 digits.');
  if (!attempt.mfaResolver) throw new Error('Nothing is waiting for a code right now.');

  attempt.status = 'verifying';
  attempt.message = 'Submitting verification code…';
  attempt.mfaResolver(trimmed);
  attempt.mfaResolver = null;
  return publicAttempt(attempt);
}

export async function cancelLogin(attemptId) {
  const attempt = attempts.get(attemptId);
  if (!attempt) return { cancelled: false };
  attempt.status = 'cancelled';
  attempt.message = 'Cancelled.';
  await teardown(attempt);
  clearTimeout(attempt.timer);
  attempts.delete(attemptId);
  return { cancelled: true };
}

async function firstVisible(page, selectors, timeoutMs = 2000) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      return locator;
    } catch {
      /* try the next selector */
    }
  }
  return null;
}

async function readLoginError(page) {
  for (const selector of ['#error', '.loginError', '#theloginform .error']) {
    try {
      const text = await page.locator(selector).first().innerText({ timeout: 500 });
      if (text?.trim()) return text.trim();
    } catch {
      /* no error element */
    }
  }
  return null;
}

function isLoggedIn(url) {
  return (
    /\/lightning\//.test(url) ||
    /lightning\.force\.com/.test(url) ||
    /\/home\/home\.jsp/.test(url) ||
    /\/setup\//.test(url) ||
    /my\.salesforce\.com\/(?:$|\?)/.test(url)
  );
}

async function runLogin(attempt) {
  const { chromium } = await getPlaywright();
  const { loginUrl, instanceUrl, apiVersion } = attempt.environment.salesforce;
  const { username, password } = attempt.credentials;

  attempt.browser = await chromium.launch({
    headless: attempt.headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  attempt.context = await attempt.browser.newContext({ viewport: { width: 1280, height: 900 } });
  attempt.page = await attempt.context.newPage();
  const page = attempt.page;
  page.setDefaultTimeout(NAV_TIMEOUT_MS);

  attempt.status = 'logging-in';
  attempt.message = 'Submitting credentials…';

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  await page.fill('#username', username);
  await page.fill('#password', password);
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    page.click('#Login'),
  ]);

  // Give Salesforce a moment to land on either the app, an MFA challenge, or an error.
  await page.waitForTimeout(2500);

  const badCredentials = await readLoginError(page);
  if (badCredentials) throw new Error(`Salesforce rejected the login: ${badCredentials}`);

  // Up to three verification rounds — Salesforce occasionally chains challenges.
  for (let round = 0; round < 3; round++) {
    if (isLoggedIn(page.url())) break;

    const codeInput = await firstVisible(page, MFA_INPUT_SELECTORS, 4000);
    if (!codeInput) break;

    const promptText = await page
      .locator('.description, .verificationDescription, #content h2')
      .first()
      .innerText({ timeout: 1000 })
      .catch(() => null);

    attempt.status = 'awaiting-mfa';
    attempt.mfaPrompt =
      promptText?.trim() ||
      'Salesforce is asking for a verification code. Enter the code it just sent you.';
    attempt.message = 'Waiting for your verification code…';

    const code = await new Promise((resolve) => {
      attempt.mfaResolver = resolve;
    });

    await codeInput.fill(code);
    const submit = await firstVisible(page, MFA_SUBMIT_SELECTORS, 3000);
    if (submit) await submit.click();
    else await codeInput.press('Enter');

    await page.waitForTimeout(3000);

    const mfaError = await readLoginError(page);
    if (mfaError) {
      // Loop again so the user can retype, unless Salesforce has given up on us.
      attempt.mfaPrompt = `${mfaError} — try again.`;
      if (round === 2) throw new Error(`Verification failed: ${mfaError}`);
    }
  }

  attempt.status = 'capturing';
  attempt.message = 'Capturing session…';

  // Dismiss a "stay signed in?" style interstitial if one appears.
  const notNow = await firstVisible(
    page,
    ['text="Not Now"', 'button:has-text("Not Now")', '#cancel'],
    1500
  );
  if (notNow) await notNow.click().catch(() => {});

  // Ensure the my.salesforce.com sid exists by visiting that host directly.
  await page.goto(instanceUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);

  const sid = await captureSid(attempt.context, instanceUrl);
  if (!sid) {
    throw new Error(
      'Logged in, but no `sid` cookie was found for ' +
        new URL(instanceUrl).host +
        '. Check that the instance URL in config/environments.json matches this sandbox.'
    );
  }

  saveSession(attempt.env, {
    env: attempt.env,
    username,
    sid,
    instanceUrl,
    apiVersion,
    capturedAt: new Date().toISOString(),
  });

  attempt.status = 'connected';
  attempt.message = 'Connected.';
  await teardown(attempt);
}

async function captureSid(context, instanceUrl) {
  const wanted = new URL(instanceUrl).host;
  const all = await context.cookies();

  const sids = all.filter((c) => c.name === 'sid' && c.value);
  // Prefer an exact host match, then any my.salesforce.com cookie. A Lightning-domain sid
  // is not accepted as a Bearer token by /services/data, so it is never a fallback.
  return (
    sids.find((c) => c.domain.replace(/^\./, '') === wanted)?.value ??
    sids.find((c) => c.domain.includes('my.salesforce.com'))?.value ??
    null
  );
}

/**
 * Manual escape hatch: paste a sid straight from browser devtools. Useful when the
 * automated login is blocked by an SSO variant this app does not drive.
 */
export function saveSessionManually({ env, sid, username = null }) {
  const environment = getEnvironment(env);
  const trimmed = String(sid ?? '').trim();
  if (!trimmed) throw new Error('sid is required.');
  saveSession(env, {
    env,
    username,
    sid: trimmed,
    instanceUrl: environment.salesforce.instanceUrl,
    apiVersion: environment.salesforce.apiVersion,
    capturedAt: new Date().toISOString(),
    source: 'manual-paste',
  });
  return describeSession(env);
}
