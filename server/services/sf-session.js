/**
 * Salesforce session acquisition and storage.
 *
 * Two ways in, because both org login pages offer both:
 *
 *   - `password` — the default. A username and password through the two-step Salesforce form.
 *                  Stays entirely inside Salesforce, which is why it is preferred: the SSO route
 *                  detours out to Microsoft Entra and back for the same session.
 *   - `sso`      — click the org's SAML button and authenticate at the identity provider. Kept
 *                  for accounts that can only get in that way.
 *
 * Credentials are never persisted and never read from the environment. The flow is:
 *
 *   1. The UI posts a username and password for one password login attempt. They live in this
 *      process's memory only, for the life of the attempt. An SSO attempt receives none.
 *   2. A headed Chromium drives the login. Rather than following a fixed script, the driver
 *      re-inspects the page every cycle and takes whatever action is available — fill a
 *      field, click a Next/Continue/Verify button, dismiss a "stay signed in?" prompt. Real
 *      orgs interleave SSO redirects, org pickers and interstitials in orders no fixed script
 *      survives, so the driver reacts to what is on screen instead of assuming a sequence.
 *   3. It parks at `awaiting-mfa` only when Salesforce actually asks for a code. The UI
 *      prompts, the code is typed in, and the driver resumes.
 *   4. If it cannot make progress for a while, it says so and keeps watching — you finish the
 *      last step in the browser window yourself and it still captures the session. It never
 *      dead-ends on an unexpected screen.
 *   5. On success the `sid` cookie for the *.my.salesforce.com domain is captured, verified
 *      with a live query, and written to data/sessions/<env>.json at mode 0600. That is the
 *      only thing that touches the disk.
 *
 * The sid must come from the *.my.salesforce.com host, not the Lightning host — only the
 * former is a valid Bearer token for /services/data.
 *
 * A persistent browser profile per environment means "remember this device" survives, so MFA
 * is usually asked for once rather than every run.
 */

import path from 'node:path';
import fs from 'node:fs';
import { SESSIONS_DIR, DATA_DIR, writeSecret, readJson } from '../lib/paths.js';
import { getEnvironment } from '../lib/config.js';

const ATTEMPT_TTL_MS = 15 * 60 * 1000;
const CYCLE_MS = 900;
/** How long without progress before we ask the user to take over in the browser. */
const STALL_CYCLES = 18;

/** In-flight login attempts, keyed by id. Never serialised. */
const attempts = new Map();

let playwrightModule = null;
async function getPlaywright() {
  if (!playwrightModule) {
    try {
      playwrightModule = await import('playwright');
    } catch {
      throw new Error(
        'Playwright is not installed. Run `npm install`, then `npx playwright install chromium`.'
      );
    }
  }
  return playwrightModule;
}

function sessionFile(envName) {
  return path.join(SESSIONS_DIR, `${envName}.json`);
}

function profileDir(envName) {
  return path.join(DATA_DIR, 'browser', envName);
}

export function readSession(envName) {
  const stored = readJson(sessionFile(envName), null);
  return stored?.sid ? stored : null;
}

export function clearSession(envName) {
  try {
    fs.unlinkSync(sessionFile(envName));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/** Drop the remembered browser profile, forcing a fresh login and a fresh MFA challenge. */
export function clearBrowserProfile(envName) {
  fs.rmSync(profileDir(envName), { recursive: true, force: true });
  return { cleared: true };
}

export function hasBrowserProfile(envName) {
  return fs.existsSync(profileDir(envName));
}

function saveSession(envName, session) {
  writeSecret(sessionFile(envName), JSON.stringify(session, null, 2) + '\n');
}

/** Public shape — deliberately omits the sid so it can be sent to the browser. */
export function describeSession(envName) {
  const s = readSession(envName);
  if (!s) {
    // A retired record still says who it was and why it ended, which is more useful than a bare
    // "not connected" — and tells the user whether a silent renewal is even possible.
    const retired = readJson(sessionFile(envName), null);
    return {
      connected: false,
      env: envName,
      rememberedBrowser: hasBrowserProfile(envName),
      autoRenews: hasBrowserProfile(envName),
      previousUsername: retired?.username ?? null,
      expiredAt: retired?.expiredAt ?? null,
      expiredReason: retired?.expiredReason ?? null,
      refreshCount: retired?.refreshCount ?? 0,
    };
  }
  return {
    connected: true,
    env: envName,
    username: s.username ?? null,
    instanceUrl: s.instanceUrl,
    apiVersion: s.apiVersion,
    capturedAt: s.capturedAt,
    ageMinutes: Math.round((Date.now() - new Date(s.capturedAt).getTime()) / 60000),
    lastVerifiedAt: s.lastVerifiedAt ?? null,
    source: s.source ?? 'browser-login',
    refreshCount: s.refreshCount ?? 0,
    rememberedBrowser: hasBrowserProfile(envName),
    // With a remembered profile an expired sid is re-minted headlessly, so a login prompt should
    // be rare rather than routine.
    autoRenews: hasBrowserProfile(envName),
  };
}

/**
 * Retire a dead sid without throwing the record away.
 *
 * The sid is nulled so nothing can use it — `readSession` treats a record without one as no
 * session — but the file stays. That keeps the username, the capture time and the refresh count,
 * which is what lets a later silent refresh know whose session it is renewing, and lets the UI say
 * "expired, reconnect" rather than the indistinguishable "never logged in".
 *
 * Deleting the file is reserved for an explicit logout.
 */
export function markSessionExpired(envName, reason = 'Salesforce returned 401') {
  const previous = readJson(sessionFile(envName), null);
  if (!previous) return;
  saveSession(envName, {
    ...previous,
    sid: null,
    expiredAt: new Date().toISOString(),
    expiredReason: reason,
  });
}

// ---------------------------------------------------------------------------
// Silent refresh
// ---------------------------------------------------------------------------

/**
 * Re-mint a sid from the remembered browser profile, with no user interaction.
 *
 * A Salesforce `sid` is a session cookie and expires on the org's session-timeout — often a couple
 * of hours. That is far shorter than the browser profile's own trust, which survives for weeks. So
 * when a sid dies there is usually no need to ask for credentials again: opening the profile
 * headless against the instance URL is enough for Salesforce to hand out a fresh one.
 *
 * This is what stops the app asking you to log in over and over. Only when the profile itself has
 * gone stale — Salesforce actually presents a login form — is an interactive login required.
 *
 * Serialised through a promise, because a burst of parallel API calls all 401ing at once would
 * otherwise each try to open the same profile directory, which Chromium locks exclusively.
 */
let refreshInFlight = new Map();

export async function refreshSessionSilently(envName) {
  if (refreshInFlight.has(envName)) return refreshInFlight.get(envName);

  const attempt = (async () => {
    if (!hasBrowserProfile(envName)) {
      return { refreshed: false, reason: 'No remembered browser profile — an interactive login is needed.' };
    }

    const environment = getEnvironment(envName);
    const { instanceUrl, apiVersion } = environment.salesforce;
    const previous = readJson(sessionFile(envName), null);

    const { chromium } = await getPlaywright();
    let context;
    try {
      context = await chromium.launchPersistentContext(profileDir(envName), {
        headless: true,
        viewport: { width: 1280, height: 900 },
      });
      const page = context.pages()[0] ?? (await context.newPage());
      page.setDefaultTimeout(30_000);

      await page.goto(instanceUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(2000);

      // A login form means the profile's own trust has lapsed; nothing headless can fix that.
      const loginForm = await page
        .locator('#username, input[name="pw"], #idp_section_buttons button')
        .first()
        .isVisible()
        .catch(() => false);
      if (loginForm) {
        return { refreshed: false, reason: 'Salesforce is asking to log in again — the saved browser session has lapsed.' };
      }

      const sid = await captureSid(context, instanceUrl);
      if (!sid) return { refreshed: false, reason: 'No sid cookie appeared for the instance host.' };
      if (!(await sidWorks(instanceUrl, apiVersion, sid))) {
        return { refreshed: false, reason: 'The re-minted sid was rejected by the API.' };
      }

      saveSession(envName, {
        env: envName,
        username: previous?.username ?? null,
        sid,
        instanceUrl,
        apiVersion,
        capturedAt: new Date().toISOString(),
        source: 'silent-refresh',
        refreshCount: (previous?.refreshCount ?? 0) + 1,
      });
      return { refreshed: true };
    } catch (err) {
      return { refreshed: false, reason: err.message };
    } finally {
      await context?.close().catch(() => {});
    }
  })();

  refreshInFlight.set(envName, attempt);
  try {
    return await attempt;
  } finally {
    refreshInFlight.delete(envName);
  }
}

export function markSessionVerified(envName) {
  const s = readSession(envName);
  if (s) saveSession(envName, { ...s, lastVerifiedAt: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Page recognition
// ---------------------------------------------------------------------------

/**
 * Selector groups, in the order the driver prefers to act on them. Several alternatives per
 * concern because Salesforce's login pages differ by org, by My Domain settings and by
 * whether an SSO provider is in front.
 *
 * Verified against both org login pages on 2026-08-04. Each presents TWO ways in:
 *
 *   1. A two-step username/password form. The first page carries only `#username` (type=email)
 *      and `#Login` ("Log In to Sandbox") — no password input at all. The password field appears
 *      only after that submit. Both pages reuse `#Login`.
 *   2. A SAML SSO button inside `#idp_section_buttons`, labelled "Log in with Netradyne
 *      <env> SSO", which calls IdpOptions.useIdp() and redirects to /saml/authn-request.jsp.
 *
 * The generic https://test.salesforce.com page does NOT show the SSO button — that is why
 * logging in there needed manual intervention. loginUrl now points at each org's own domain.
 */
const SELECTORS = {
  username: ['#username', 'input[name="username"]', 'input[name="loginId"]'],
  password: ['#password', 'input[name="pw"]', 'input[type="password"]:not([name="EmailVerifCode"])'],
  submitLogin: ['#Login', 'input[name="Login"]', 'button[type="submit"]#Login'],
  // A "Next"/"Continue" that advances a step without being the final login button.
  advance: [
    '#continue',
    'input[value="Continue"]',
    'button:has-text("Continue")',
    'input[value="Next"]',
    'button:has-text("Next")',
    '#oaapprove',
    'input[value="Allow"]',
  ],
  mfaCode: [
    '#tc-verification-code',
    'input[name="EmailVerifCode"]',
    '#emc',
    '#smc',
    'input[autocomplete="one-time-code"]',
    'input[id$="verification-code"]',
  ],
  mfaSubmit: ['#save', 'input[value="Verify"]', 'button:has-text("Verify")'],
  // "Choose a verification method" — pick the first option, then continue.
  mfaMethodChoice: ['input[type="radio"][name="selectedMethod"]', '.methodOption input[type="radio"]'],
  // The SAML SSO button on the org login page.
  sso: ['#idp_section_buttons button', 'button:has-text("Log in with")'],

  /**
   * Microsoft Entra ID (login.microsoftonline.com), which is the identity provider behind both
   * orgs' SAML button — verified 2026-08-04. Its form is three steps: account, password, then
   * usually a "stay signed in?" prompt.
   */
  idpUsername: ['input[name="loginfmt"]', '#i0116'],
  idpPassword: ['input[name="passwd"]', '#i0118'],
  idpSubmit: ['#idSIButton9', 'input[type="submit"][value="Next"]', 'input[type="submit"][value="Sign in"]'],
  // "Stay signed in?" — Yes keeps the profile trusted, which is the whole point of reusing it.
  idpStaySignedIn: ['#idSIButton9'],
  idpStaySignedInPrompt: ['#KmsiCheckboxField', 'div:has-text("Stay signed in?")'],
  // A code the user can type. Push/number-match approval cannot be automated.
  idpMfaCode: ['input[name="otc"]', '#idTxtBx_SAOTCC_OTC'],
  idpPushApproval: ['#idDiv_RemoteNGC_DisplaySign', '#idRemoteNGC_DisplaySign'],
  idpError: ['#passwordError', '#usernameError', '.alert-error', '[id^="idSpan_SAOTCC_Error"]'],
  // Post-login prompts that block the landing page.
  dismiss: [
    '#cancel',
    'input[value="Not Now"]',
    'button:has-text("Not Now")',
    'a:has-text("Not Now")',
    'button:has-text("Remind Me Later")',
    'button:has-text("Skip")',
  ],
  error: ['#error', '.loginError', '#theloginform .error', '.error[role="alert"]'],
};

/**
 * First visible match, checked immediately rather than waited on. The driver already loops, so
 * a field that has not rendered yet is simply picked up on the next cycle — waiting here would
 * multiply every miss by the timeout and make one slow page take minutes.
 */
async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0 && (await locator.isVisible())) return locator;
    } catch {
      /* not present, or the page navigated mid-check */
    }
  }
  return null;
}

async function readError(page) {
  for (const selector of SELECTORS.error) {
    try {
      const text = await page.locator(selector).first().innerText({ timeout: 200 });
      if (text?.trim()) return text.trim();
    } catch {
      /* no error element */
    }
  }
  return null;
}

/**
 * Errors that mean "stop", as opposed to "the user mistyped a code and can retry".
 * Salesforce phrases credential failures distinctively enough to separate the two.
 */
function isFatalError(message) {
  return /password|username|locked|deactivat|not exist|check your email address/i.test(message);
}

// ---------------------------------------------------------------------------
// Attempt state
// ---------------------------------------------------------------------------

function publicAttempt(a) {
  return {
    attemptId: a.id,
    env: a.env,
    method: a.method,
    status: a.status,
    message: a.message,
    mfaPrompt: a.mfaPrompt ?? null,
    error: a.error ?? null,
    startedAt: a.startedAt,
    // True once the driver has stopped steering and is only watching for the session.
    manualTakeover: a.status === 'needs-your-click' || a.status === 'sso-handoff',
    currentUrl: a.currentUrl ?? null,
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
    await attempt.context?.close();
  } catch {
    /* already gone */
  }
  attempt.context = null;
  attempt.page = null;
}

function scheduleExpiry(attempt) {
  attempt.expiryTimer = setTimeout(async () => {
    if (!['connected', 'failed', 'cancelled'].includes(attempt.status)) {
      attempt.status = 'failed';
      attempt.error = 'Login attempt timed out after 15 minutes.';
      await teardown(attempt);
    }
    attempts.delete(attempt.id);
  }, ATTEMPT_TTL_MS);
  attempt.expiryTimer.unref?.();
}

/**
 * @param {object} options
 * @param {string} options.env
 * @param {'sso'|'password'} [options.method] how to authenticate. SSO needs no credentials.
 * @param {string} [options.username] password method only
 * @param {string} [options.password] password method only
 * @param {boolean} [options.headless]
 */
export async function startLogin({ env, method = 'password', username, password, headless }) {
  const environment = getEnvironment(env);
  if (!['sso', 'password'].includes(method)) throw new Error(`Unknown login method "${method}".`);
  if (method === 'password' && (!username || !password)) {
    throw new Error('Username and password are both required for a password login.');
  }
  // For SSO, credentials are optional: supply them and the Microsoft form is driven too;
  // omit them and the browser is handed over at the identity provider.
  const driveIdp = method === 'sso' && Boolean(username && password);

  const id = `login_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const attempt = {
    id,
    env,
    method,
    status: 'starting',
    message: 'Opening browser…',
    startedAt: new Date().toISOString(),
    credentials: method === 'password' || driveIdp ? { username, password } : null,
    driveIdp,
    environment,
    // Headed by default: you can see what it is doing and finish anything it cannot.
    headless: headless ?? process.env.HEADLESS === 'true',
    mfaResolver: null,
    filledUsername: false,
    filledPassword: false,
    clickedLogin: false,
    stall: 0,
  };
  attempts.set(id, attempt);
  scheduleExpiry(attempt);

  runLogin(attempt).catch(async (err) => {
    attempt.status = 'failed';
    attempt.error = err.message;
    attempt.message = 'Login failed.';
    await teardown(attempt);
  });

  return publicAttempt(attempt);
}

/** Supply the MFA code. */
export async function submitMfaCode(attemptId, code) {
  const attempt = getAttempt(attemptId);
  if (attempt.status !== 'awaiting-mfa') {
    throw new Error(`Attempt is "${attempt.status}", not awaiting a code.`);
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
  clearTimeout(attempt.expiryTimer);
  await teardown(attempt);
  attempts.delete(attemptId);
  return { cancelled: true };
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

async function runLogin(attempt) {
  const { chromium } = await getPlaywright();
  const { loginUrl, instanceUrl, apiVersion } = attempt.environment.salesforce;

  // A persistent profile keeps "remember this device", so MFA is usually a one-off.
  fs.mkdirSync(profileDir(attempt.env), { recursive: true, mode: 0o700 });
  attempt.context = await chromium.launchPersistentContext(profileDir(attempt.env), {
    headless: attempt.headless,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  attempt.page = attempt.context.pages()[0] ?? (await attempt.context.newPage());
  const page = attempt.page;
  page.setDefaultTimeout(15_000);

  attempt.status = 'logging-in';
  attempt.message = 'Opening the Salesforce login page…';
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});

  // Adaptive loop: look at the page, do the next useful thing, repeat.
  const deadline = Date.now() + ATTEMPT_TTL_MS - 30_000;
  while (Date.now() < deadline) {
    if (attempt.status === 'cancelled') return;

    attempt.currentUrl = page.url();

    // Success condition first: a working sid is the only thing that actually matters, and it
    // can appear at any point — including immediately, from the remembered profile.
    const sid = await captureSid(attempt.context, instanceUrl);
    if (sid && (await sidWorks(instanceUrl, apiVersion, sid))) {
      saveSession(attempt.env, {
        env: attempt.env,
        username: attempt.credentials?.username ?? null,
        sid,
        instanceUrl,
        apiVersion,
        capturedAt: new Date().toISOString(),
        source: 'browser-login',
      });
      attempt.status = 'connected';
      attempt.message = 'Connected.';
      await teardown(attempt);
      return;
    }

    const progressed = await stepOnce(attempt, page);

    if (progressed) {
      attempt.stall = 0;
    } else if (++attempt.stall === STALL_CYCLES && attempt.status !== 'sso-handoff') {
      // Something on screen that this driver does not recognise. Rather than fail, hand over:
      // the browser is already open and the loop keeps watching for the session.
      //
      // An SSO handoff is excluded: it is already waiting on the identity provider by design,
      // and its own message says so more precisely than this one would.
      attempt.status = 'needs-your-click';
      attempt.message =
        'Salesforce is showing a step this app does not recognise. Finish it in the browser ' +
        'window that is open — the session will be picked up automatically.';
    }

    await page.waitForTimeout(CYCLE_MS);
  }

  throw new Error('Login did not complete in time.');
}

/**
 * One cycle of the driver. Returns true if it did something.
 * Ordered by specificity: MFA and errors before generic fills and clicks.
 */
async function stepOnce(attempt, page) {
  // 1. A hard credential error ends the attempt; a soft one is left for a retry.
  const error = await readError(page);
  if (error) {
    if (isFatalError(error)) throw new Error(`Salesforce rejected the login: ${error}`);
    attempt.softError = error;
  }

  // 2. MFA code prompt — the one place we deliberately stop.
  const codeInput = await firstVisible(page, SELECTORS.mfaCode);
  if (codeInput) {
    const prompt = await page
      .locator('.description, .verificationDescription, #content h2, .subtitle')
      .first()
      .innerText({ timeout: 400 })
      .catch(() => null);

    attempt.status = 'awaiting-mfa';
    attempt.mfaPrompt =
      [attempt.softError, prompt?.trim()].filter(Boolean).join(' — ') ||
      'Salesforce is asking for a verification code. Enter the code it just sent you.';
    attempt.message = 'Waiting for your verification code…';
    attempt.softError = null;

    const code = await new Promise((resolve) => {
      attempt.mfaResolver = resolve;
    });
    if (attempt.status === 'cancelled') return true;

    await codeInput.fill(code);
    const submit = await firstVisible(page, SELECTORS.mfaSubmit);
    if (submit) await submit.click().catch(() => {});
    else await codeInput.press('Enter').catch(() => {});

    attempt.status = 'logging-in';
    attempt.message = 'Verifying…';
    await page.waitForTimeout(1500);
    return true;
  }

  // 3. "Choose a verification method" — take the first offered and continue.
  const method = await firstVisible(page, SELECTORS.mfaMethodChoice);
  if (method) {
    await method.check().catch(() => {});
    const go = await firstVisible(page, SELECTORS.advance);
    if (go) await go.click().catch(() => {});
    attempt.message = 'Choosing a verification method…';
    await page.waitForTimeout(1200);
    return true;
  }

  // 4. SSO: click the identity-provider button, then hand over.
  //
  //    The driver deliberately stops steering once it leaves for the IdP. It has no idea which
  //    provider the org uses, and blind-filling a third-party login page risks submitting the
  //    wrong credentials against a corporate account — which locks that account, not just this
  //    session. So SSO carries no credentials at all: you authenticate at the IdP, and the
  //    driver keeps watching for the sid. With the remembered profile an existing IdP session
  //    usually makes this instant.
  if (attempt.method === 'sso' && !attempt.clickedSso) {
    const sso = await firstVisible(page, SELECTORS.sso);
    if (sso) {
      attempt.clickedSso = true;
      const label = (await sso.innerText().catch(() => null))?.trim();
      attempt.message = `Opening ${label || 'the identity provider'}…`;
      await sso.click().catch(() => {});
      await page.waitForTimeout(2500);
      attempt.status = 'sso-handoff';
      attempt.message =
        'Sign in with your Netradyne account in the browser window. The session is captured ' +
        'automatically once you land in Salesforce.';
      return true;
    }
  }

  if (attempt.method === 'sso') {
    // Drive the Microsoft Entra form too, but only if credentials were offered for it. Without
    // them the window is simply handed over — this app will not guess at a corporate login.
    if (attempt.credentials) {
      const handled = await stepIdp(attempt, page);
      if (handled) return true;
    }

    // Salesforce's own post-login prompts, once the IdP returns.
    const dismissAfterSso = await firstVisible(page, SELECTORS.dismiss);
    if (dismissAfterSso) {
      attempt.message = 'Dismissing a prompt…';
      await dismissAfterSso.click().catch(() => {});
      await page.waitForTimeout(900);
      return true;
    }
    return false;
  }

  // 5. Credentials. Filled at most once each, so a re-render does not retype endlessly.
  const usernameField = await firstVisible(page, SELECTORS.username);
  const passwordField = await firstVisible(page, SELECTORS.password);

  if (usernameField && !attempt.filledUsername) {
    const existing = await usernameField.inputValue().catch(() => '');
    if (existing !== attempt.credentials.username) {
      await usernameField.fill(attempt.credentials.username).catch(() => {});
    }
    attempt.filledUsername = true;
    attempt.message = 'Entering username…';
    return true;
  }

  if (passwordField && !attempt.filledPassword) {
    await passwordField.fill(attempt.credentials.password).catch(() => {});
    attempt.filledPassword = true;
    attempt.message = 'Entering password…';
    return true;
  }

  // 6. Submit, once both fields are in.
  if (attempt.filledPassword && !attempt.clickedLogin) {
    const login = await firstVisible(page, SELECTORS.submitLogin);
    if (login) {
      attempt.clickedLogin = true;
      attempt.message = 'Signing in…';
      await login.click().catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(1200);
      return true;
    }
  }

  // 7. Two-step forms: a username page whose Next comes before any password field exists.
  //
  //    This is the normal path, not an edge case: test.salesforce.com has no password field on
  //    its first page (see SELECTORS above).
  //
  //    Gated on the field being absent for several consecutive cycles. A single miss is not
  //    enough: the field is briefly unqueryable while a page renders or navigates, and clicking
  //    submit in that window sends an empty password. Salesforce counts that as a failed attempt
  //    and enough of them lock the account, so the cost of guessing wrong here is the user's
  //    login, not a wasted cycle. Three cycles is ~2.7s once per login — worth it.
  if (attempt.filledUsername && !attempt.filledPassword) {
    attempt.noPasswordCycles = passwordField ? 0 : (attempt.noPasswordCycles ?? 0) + 1;

    if (attempt.noPasswordCycles >= 3) {
      const next = await firstVisible(page, [...SELECTORS.submitLogin, ...SELECTORS.advance]);
      if (next) {
        attempt.noPasswordCycles = 0;
        attempt.message = 'Continuing to the password step…';
        await next.click().catch(() => {});
        await page.waitForTimeout(1200);
        return true;
      }
    }
    // Waiting for the field to appear counts as progress — but only for a while. If neither a
    // password field nor a Next button ever shows up, fall through so the stall timer fires and
    // hands the browser over instead of looping silently.
    if (attempt.noPasswordCycles < 12) return true;
  }

  // 8. Post-login prompts: "stay signed in?", connected-app approval, and similar.
  const dismiss = await firstVisible(page, SELECTORS.dismiss);
  if (dismiss) {
    attempt.message = 'Dismissing a prompt…';
    await dismiss.click().catch(() => {});
    await page.waitForTimeout(900);
    return true;
  }

  const advance = await firstVisible(page, SELECTORS.advance);
  if (advance) {
    attempt.message = 'Continuing…';
    await advance.click().catch(() => {});
    await page.waitForTimeout(900);
    return true;
  }

  // 9. Logged in somewhere that is not the API host — visit it so its sid cookie is set.
  if (!/my\.salesforce\.com/.test(page.url()) && attempt.clickedLogin && !attempt.nudgedToInstance) {
    attempt.nudgedToInstance = true;
    attempt.message = 'Capturing session…';
    await page.goto(attempt.environment.salesforce.instanceUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1200);
    return true;
  }

  return false;
}

/**
 * The Microsoft Entra side of an SSO login. Same shape as the Salesforce driver: react to
 * whatever is on screen, stop at MFA, never submit a half-filled form.
 *
 * Returns true if it acted.
 */
async function stepIdp(attempt, page) {
  if (!/login\.microsoftonline\.com|login\.microsoft\.com/.test(page.url())) return false;

  // A rejected password is fatal here: retrying against a corporate directory is how accounts
  // get locked, and Entra lockout affects far more than this app.
  for (const selector of SELECTORS.idpError) {
    const text = await page.locator(selector).first().innerText({ timeout: 150 }).catch(() => null);
    if (text?.trim()) {
      throw new Error(`Microsoft sign-in failed: ${text.trim()}`);
    }
  }

  // Push or number-match approval — genuinely not automatable, so hand over.
  const push = await firstVisible(page, SELECTORS.idpPushApproval);
  if (push) {
    const number = await push.innerText().catch(() => null);
    attempt.status = 'awaiting-mfa-approval';
    attempt.message = number
      ? `Approve the sign-in in your Authenticator app and enter ${number.trim()}.`
      : 'Approve the sign-in request in your Authenticator app.';
    return false;
  }

  // A typed code — park exactly as the Salesforce MFA step does.
  const code = await firstVisible(page, SELECTORS.idpMfaCode);
  if (code) {
    attempt.status = 'awaiting-mfa';
    attempt.mfaPrompt = 'Microsoft is asking for a verification code. Enter the code it sent you.';
    attempt.message = 'Waiting for your verification code…';

    const entered = await new Promise((resolve) => {
      attempt.mfaResolver = resolve;
    });
    if (attempt.status === 'cancelled') return true;

    await code.fill(entered).catch(() => {});
    const submit = await firstVisible(page, SELECTORS.idpSubmit);
    if (submit) await submit.click().catch(() => {});
    else await code.press('Enter').catch(() => {});

    attempt.status = 'logging-in';
    attempt.message = 'Verifying…';
    await page.waitForTimeout(2000);
    return true;
  }

  // "Stay signed in?" — say yes. Keeping the profile trusted is the whole reason it persists,
  // and it lives locally at 0700 and is gitignored.
  const kmsi = await firstVisible(page, SELECTORS.idpStaySignedInPrompt);
  if (kmsi) {
    const yes = await firstVisible(page, SELECTORS.idpStaySignedIn);
    if (yes) {
      attempt.message = 'Staying signed in…';
      await yes.click().catch(() => {});
      await page.waitForTimeout(1500);
      return true;
    }
  }

  const idpUser = await firstVisible(page, SELECTORS.idpUsername);
  const idpPass = await firstVisible(page, SELECTORS.idpPassword);

  if (idpUser && !attempt.filledIdpUsername) {
    await idpUser.fill(attempt.credentials.username).catch(() => {});
    attempt.filledIdpUsername = true;
    attempt.message = 'Entering your Microsoft account…';
    const next = await firstVisible(page, SELECTORS.idpSubmit);
    if (next) await next.click().catch(() => {});
    await page.waitForTimeout(1800);
    return true;
  }

  if (idpPass && !attempt.filledIdpPassword) {
    await idpPass.fill(attempt.credentials.password).catch(() => {});
    attempt.filledIdpPassword = true;
    attempt.message = 'Signing in to Microsoft…';
    const submit = await firstVisible(page, SELECTORS.idpSubmit);
    if (submit) await submit.click().catch(() => {});
    await page.waitForTimeout(2200);
    return true;
  }

  return false;
}

async function captureSid(context, instanceUrl) {
  const wanted = new URL(instanceUrl).host;
  const sids = (await context.cookies().catch(() => [])).filter((c) => c.name === 'sid' && c.value);

  // Prefer an exact host match, then any my.salesforce.com cookie. A Lightning-domain sid is
  // not accepted as a Bearer token by /services/data, so it is never a fallback.
  return (
    sids.find((c) => c.domain.replace(/^\./, '') === wanted)?.value ??
    sids.find((c) => c.domain.includes('my.salesforce.com'))?.value ??
    null
  );
}

/**
 * A persistent profile can hand back a stale sid from a previous session, so the cookie is
 * proven against the API before it is accepted.
 */
async function sidWorks(instanceUrl, apiVersion, sid) {
  try {
    const res = await fetch(
      `${instanceUrl}/services/data/${apiVersion}/query/?q=${encodeURIComponent('SELECT Id FROM Organization LIMIT 1')}`,
      { headers: { Authorization: `Bearer ${sid}`, Accept: 'application/json' } }
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Manual escape hatch: paste a sid straight from browser devtools. Useful when an SSO variant
 * cannot be driven at all.
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
