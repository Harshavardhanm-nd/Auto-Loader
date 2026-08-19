/**
 * Sending through Outlook on the web, driven by Playwright.
 *
 * This exists because SMTP is unusable in this tenant: it answers 535 5.7.139, Microsoft's code
 * for SMTP AUTH being switched off.
 *
 * The approach is taken from the working implementation in ~/BSG/bsg-qa-agent
 * (services/outlook-email-service.js, services/outlook-session-manager.js, utils/helpers.js),
 * which has been sending these DL emails in anger. Every non-obvious behaviour below is there
 * because that code learned it the hard way:
 *
 *   - Auth is a saved Playwright **storage state**, not a browser profile. One interactive sign-in
 *     writes it; later sends run headless against it. No window to babysit, and no fight with the
 *     Salesforce login over a profile lock.
 *   - Outlook renders its chrome seconds after `domcontentloaded` and routes through
 *     login.microsoftonline.com even for a silent sign-in, so readiness is polled and a live
 *     session is only declared dead when a real credential field is on screen.
 *   - Recipients are a contenteditable div committed with `;`, not an input.
 *   - Compose has four hidden `input[type=file]` elements and they are NOT equivalent: the one
 *     declaring accept="image/*" is the inline-image picker and silently discards a CSV. Only
 *     inputs that accept arbitrary files are used, and the result is confirmed against OWA's own
 *     attachment listbox rather than by looking for the filename on the page.
 *   - Send must be waited for to become *enabled* (attachment processing disables it), and an
 *     "Attachment reminder" dialog can grey it out behind a modal so every retry clicks a dead
 *     button.
 *   - **Sent Items is the only trustworthy confirmation.** A vanished Send button is not proof —
 *     the compose window also closes when a message is discarded. On 2026-08-01 that repo shipped
 *     a 1.16 MB report that reported success and appeared in neither Sent Items nor Drafts: the
 *     browser had been torn down while OWA was still transmitting.
 *
 * On top of that, this version defaults to **compose-and-stop**: it fills the message in a visible
 * window and leaves it for you to read and send. A wrong send here is a real device load, and this
 * code has not yet been proven against this mailbox.
 */

import path from 'node:path';
import fs from 'node:fs';
import { DATA_DIR, ROOT } from '../lib/paths.js';

const OUTLOOK_URL = process.env.OUTLOOK_WEB_URL || 'https://outlook.office.com/mail/';
const SENT_ITEMS_URL = process.env.OUTLOOK_SENT_ITEMS_URL || 'https://outlook.office.com/mail/sentitems';

/**
 * Where the saved session lives: `outlook-auth.json` in the project root, written on the first
 * successful sign-in and reused silently after that. Gitignored and chmod 0600.
 *
 * OUTLOOK_AUTH_STATE_PATH overrides it, which is how an existing session file elsewhere can be
 * borrowed without copying it.
 */
const AUTH_FILE = path.resolve(
  process.env.OUTLOOK_AUTH_STATE_PATH || path.join(ROOT, 'outlook-auth.json')
);

const AUTH_WAIT_MS = Number(process.env.OUTLOOK_AUTH_WAIT_MS || 600_000);
const HYDRATION_MS = Number(process.env.OUTLOOK_HYDRATION_MS || 45_000);
const SEND_ENABLE_MS = Number(process.env.OUTLOOK_SEND_ENABLE_MS || 60_000);
const SEND_CONFIRM_MS = Number(process.env.OUTLOOK_SEND_CONFIRM_MS || 120_000);
const SENT_VERIFY_MS = Number(process.env.OUTLOOK_SENT_VERIFY_MS || 180_000);

// Microsoft is migrating OWA to outlook.cloud.microsoft and renamed the compose control from
// "New mail"/"New message" to "New email", so every variant has to be matched.
const MAIL_URL = /outlook\.(office\.com|cloud\.microsoft|live\.com)\/mail/i;
const LOGIN_URL = /login\.microsoftonline\.com|login\.microsoft\.com/i;

const INBOX_SELECTORS = [
  'button[aria-label="New mail"]',
  'button[aria-label="New message"]',
  'button[aria-label="New email"]',
  'button:has-text("New mail")',
  'button:has-text("New message")',
  'button:has-text("New email")',
  '[data-icon-name="ComposeRegular"]',
  '[data-icon-name="Compose"]',
];

const SEND_SELECTORS = [
  '[data-automationid="sendButton"]',
  'button[aria-label="Send"]',
  'button[aria-label^="Send"]',
  'button[title^="Send"]',
  'button[name="Send"]',
  'button:has([data-icon-name="Send"])',
  'button:has([data-icon-name="SendRegular"])',
  'button.ms-Button--primary:has-text("Send")',
  'button:has-text("Send")',
  '[role="button"][aria-label*="Send" i]',
];

export class OutlookAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OutlookAuthError';
    this.reauthenticationRequired = true;
  }
}

let playwrightModule = null;
async function getPlaywright() {
  if (!playwrightModule) {
    try {
      playwrightModule = await import('playwright');
    } catch {
      throw new Error('Playwright is not installed. Run `npm install`, then `npx playwright install chromium`.');
    }
  }
  return playwrightModule;
}

// ---------------------------------------------------------------------------
// Saved session
// ---------------------------------------------------------------------------

function secureAuthFile() {
  if (!fs.existsSync(AUTH_FILE)) return;
  try {
    fs.chmodSync(AUTH_FILE, 0o600);
  } catch {
    // Some filesystems do not implement POSIX permissions.
  }
}

export function hasStoredSession() {
  if (!fs.existsSync(AUTH_FILE)) return false;
  secureAuthFile();
  return true;
}

export function authFilePath() {
  return AUTH_FILE;
}

export function clearStoredSession() {
  try {
    fs.unlinkSync(AUTH_FILE);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { cleared: true };
}

async function saveStorageState(context) {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true, mode: 0o700 });
  await context.storageState({ path: AUTH_FILE });
  secureAuthFile();
}

/** A compose window left open for the user to send by hand. */
const held = { browser: null, context: null, page: null, subject: null };

export function describeOutlook() {
  const stored = hasStoredSession();
  let savedAt = null;
  if (stored) {
    try {
      savedAt = fs.statSync(AUTH_FILE).mtime.toISOString();
    } catch {
      /* ignore */
    }
  }
  return {
    transport: 'outlook-web',
    signedIn: stored,
    authFile: AUTH_FILE,
    savedAt,
    composeOpen: Boolean(held.context),
    composeSubject: held.subject ?? null,
  };
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

async function isInboxReady(page, timeout = 1200) {
  if (!MAIL_URL.test(page.url())) return false;
  for (const selector of INBOX_SELECTORS) {
    if (await page.locator(selector).first().isVisible({ timeout }).catch(() => false)) return true;
  }
  return false;
}

/**
 * Microsoft redirects through login.microsoftonline.com even for a silent sign-in, so the URL
 * alone does not mean the session is dead. Only an actual credential or code field does.
 */
async function isInteractiveSignInPrompt(page) {
  if (!LOGIN_URL.test(page.url())) return false;
  return page
    .locator('input[name="loginfmt"], input[type="password"], input[name="otc"]')
    .first()
    .isVisible({ timeout: 800 })
    .catch(() => false);
}

/**
 * Poll until OWA finishes hydrating. It renders the inbox chrome several seconds after
 * `domcontentloaded`, so a single readiness probe reports a perfectly good session as expired.
 */
async function waitForInboxHydration(page, timeoutMs = HYDRATION_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isInboxReady(page, 1500)) return true;
    if (await isInteractiveSignInPrompt(page)) return false;
    await page.waitForTimeout(1500);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Interactive sign-in
// ---------------------------------------------------------------------------

/**
 * Open a visible Outlook window, wait for the mailbox to appear, then save the session.
 *
 * Nothing is typed for you: the identity provider is Microsoft Entra and this app does not handle
 * those credentials. Any existing saved session is reused first so Microsoft can restore silently
 * rather than re-challenging.
 */
export async function authenticateInteractively({ timeoutMs = AUTH_WAIT_MS } = {}) {
  const { chromium } = await getPlaywright();
  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const context = await browser.newContext({
    viewport: null,
    ...(hasStoredSession() ? { storageState: AUTH_FILE } : {}),
  });
  const page = await context.newPage();

  try {
    await page.goto(OUTLOOK_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await isInboxReady(page)) {
        await saveStorageState(context);
        return { signedIn: true, authFile: AUTH_FILE };
      }
      // Accept "Stay signed in?" — that prompt is the whole reason the session survives.
      const stay = page.locator('input[value="Yes"], button:has-text("Yes")').first();
      if (await stay.isVisible({ timeout: 400 }).catch(() => false)) {
        await stay.click().catch(() => {});
      }
      await page.waitForTimeout(1500);
    }
    throw new OutlookAuthError('Outlook sign-in did not reach the mailbox before the timeout.');
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

const TO_FIELD_SELECTOR =
  'div[aria-label="To"][contenteditable="true"], div[aria-label="To"][role="textbox"], input[aria-label="To"]';

/** The compose form is open once it has a recipients field. */
function composeToField(page) {
  return page.locator(TO_FIELD_SELECTOR).first();
}

/**
 * How many compose panels are actually open right now, judged by how many "To" fields render.
 * Every fill/attach/send helper below queries the page with `.first()` rather than a handle to
 * "the panel we opened" — cheap when exactly one panel exists, but if a second one is ever on
 * screen at the same time, different steps can silently resolve to different panels: recipients
 * typed into one, the CSV attached to another, Send clicked on whichever the browser happens to
 * list first. That is not a hypothetical — it is what produced two real, untracked sends to a
 * staging mailbox while the compose this code was watching sat empty and failed on "at least one
 * recipient" (2026-08-17, Octo shipment-update/received-at-3PL, staging). This count is the guard
 * against it happening silently again.
 */
function countComposePanels(page) {
  return page.locator(TO_FIELD_SELECTOR).count().catch(() => 0);
}

/**
 * Best-effort close of whatever compose panel is currently on screen, so a retry does not stack a
 * second one alongside a first that only turned out to be slow rather than absent.
 */
async function discardStaleCompose(page) {
  const closeBtn = page
    .locator(
      'button[aria-label="Discard"], button[title="Discard"], button[aria-label="Close"], button[title="Close"]'
    )
    .first();
  if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await closeBtn.click({ force: true }).catch(() => {});
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }
  await page.waitForTimeout(300);
  // Escape (or Close) on a compose that already has content prompts to keep-or-discard; take the
  // discard so the panel actually goes away instead of lingering behind a confirmation dialog.
  const discardConfirm = page.getByRole('button', { name: /^\s*Discard\s*$/i }).first();
  if (await discardConfirm.isVisible({ timeout: 1000 }).catch(() => false)) {
    await discardConfirm.click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
  }
}

/**
 * Click "New mail" and confirm a compose form actually opened.
 *
 * Playwright ignores the timeout on `isVisible()`, so probing per-selector that way returns in
 * milliseconds. On a slow-hydrating OWA that either finds no control or clicks one before the app
 * is interactive and has the click swallowed — and the failure then surfaces 20s later as the To
 * field timing out, which reads like a broken selector rather than a window that never opened.
 */
async function openComposeWindow(page) {
  const newMail = page.locator(INBOX_SELECTORS.join(', ')).first();

  for (let attempt = 1; attempt <= 2; attempt++) {
    const ready = await newMail
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!ready) {
      if (attempt === 2) throw new Error('Outlook mailbox loaded, but the New mail control was not found.');
      continue;
    }

    await newMail.click().catch(() => {});
    const opened = await composeToField(page)
      .waitFor({ state: 'visible', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (opened) return;

    // The click may have opened a panel that is merely slow to render, not one that failed
    // outright. Close it before the next attempt clicks "New mail" again — otherwise a
    // late-rendering first panel and a fresh second one both end up on screen at once.
    if (attempt < 2) await discardStaleCompose(page);
  }

  throw new Error(
    'Outlook clicked New mail but the compose form never opened (no To field). The mailbox was ' +
      'reachable, so this is a slow or blocked compose window, not an expired session.'
  );
}

/** Recipients are a contenteditable div; each address is committed with a semicolon. */
async function fillRecipients(page, recipients) {
  const field = composeToField(page);
  await field.waitFor({ state: 'visible', timeout: 20_000 });
  await field.click({ force: true });

  for (const address of recipients) {
    await page.keyboard.type(address, { delay: 10 });
    await page.keyboard.press(';');
    await page.waitForTimeout(250);
  }
  await page.keyboard.press('Tab');
}

async function fillSubject(page, subject) {
  const field = page
    .locator(
      'input[aria-label="Subject"], input[placeholder*="Add a subject" i], [aria-label="Subject"][contenteditable="true"]'
    )
    .first();
  await field.waitFor({ state: 'visible', timeout: 20_000 });
  await field.click({ force: true });
  await field.fill(subject).catch(async () => {
    // Some OWA builds render the subject as a contenteditable, which fill() cannot set.
    await field.evaluate((el, value) => {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }, subject);
  });
}

async function fillBody(page, text) {
  const field = page
    .locator(
      'div[aria-label*="Message body" i][contenteditable="true"], div[role="textbox"][contenteditable="true"][aria-label*="body" i]'
    )
    .first();
  await field.waitFor({ state: 'visible', timeout: 20_000 });
  await field.click({ force: true });
  await field.evaluate((el, value) => {
    el.focus();
    el.textContent = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, text);
}

/**
 * What OWA itself says is attached to this message.
 *
 * The authoritative surface — verified against outlook.cloud.microsoft on 2026-08-04 — is a
 * listbox it labels "file attachments", whose options carry
 * `aria-label="<filename> Open <size>"`. Nothing else is trustworthy.
 *
 * This was learned the hard way. An earlier version searched the whole page for the filename as
 * text, which matched something outside the compose surface and reported success when nothing was
 * attached at all. The message then went out empty — the worst possible outcome here, because the
 * far end treats a CSV-less mail as nothing while the run records a load that never happened. So
 * this asks OWA's own attachment list and accepts no substitute.
 *
 * @returns {Promise<string[]>} the aria-labels of the attachments currently on the message
 */
async function attachedFiles(page) {
  const well = page.locator('[role="listbox"][aria-label*="file attachment" i]').first();
  if ((await well.count().catch(() => 0)) === 0) return [];

  const options = well.locator('[role="option"]');
  const count = await options.count().catch(() => 0);
  const labels = [];
  for (let i = 0; i < count; i++) {
    const label = await options.nth(i).getAttribute('aria-label').catch(() => null);
    if (label) labels.push(label);
  }
  return labels;
}

async function attachmentVisible(page, filePath) {
  const base = path.basename(filePath);
  return (await attachedFiles(page)).some((label) => label.includes(base));
}

async function waitForAttachment(page, filePath, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await attachmentVisible(page, filePath)) return true;
    await page.waitForTimeout(750);
  }
  return false;
}

/** What is on the page, for when attaching fails and the reason is not obvious. */
async function describeAttachSurface(page) {
  const inputs = await page
    .locator('input[type="file"]')
    .evaluateAll((els) =>
      els.map((e) => ({
        id: e.id || null,
        name: e.name || null,
        accept: e.accept || null,
        multiple: e.multiple,
        hidden: !(e.offsetWidth || e.offsetHeight || e.getClientRects().length),
      }))
    )
    .catch(() => []);

  const buttons = await page
    .locator('button, [role="menuitem"]')
    .evaluateAll((els) =>
      els
        .filter((e) => e.offsetWidth || e.offsetHeight || e.getClientRects().length)
        .map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim())
        .filter((t) => t && /attach|browse|upload|computer|cloud|file/i.test(t))
        .slice(0, 15)
    )
    .catch(() => []);

  return `file inputs: ${JSON.stringify(inputs)} · attach-ish controls: ${JSON.stringify(buttons)}`;
}

/**
 * Attach the CSV.
 *
 * Two routes, in order of reliability:
 *
 *   1. Set the file directly on a hidden `input[type=file]`. No menus, no native dialog. Outlook
 *      renders several unrelated hidden inputs so each is tried in turn.
 *   2. The Attach button. On current OWA this opens a **menu** first ("Browse this computer"), so
 *      the menu item has to be clicked before any file chooser appears — waiting for a
 *      `filechooser` straight after clicking Attach just times out. The listener is registered
 *      before the click either way, since the event can fire immediately.
 */
async function attachFile(page, filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Outlook attachment does not exist: ${filePath}`);

  // --- Route 1: direct file inputs -----------------------------------------
  //
  // Compose has four hidden file inputs and they are NOT interchangeable. The first declares
  // accept="image/*" — that is the inline-image picker, and handing it a CSV attaches nothing at
  // all, silently. Inputs that only accept images are therefore skipped outright rather than tried
  // and hopefully rejected.
  const inputs = page.locator('input[type="file"]');
  const accepts = await inputs.evaluateAll((els) => els.map((e) => e.accept || '')).catch(() => []);

  for (let i = 0; i < accepts.length; i++) {
    const accept = accepts[i];
    const imageOnly = /image\//i.test(accept) && !/(csv|text\/|\*\/\*|application\/)/i.test(accept);
    if (imageOnly) continue;

    try {
      await inputs.nth(i).setInputFiles(filePath);
      if (await waitForAttachment(page, filePath)) return `file-input[${i}]`;
    } catch {
      // Not a usable input; try the next.
    }
  }

  // --- Route 2: the Attach menu -------------------------------------------
  const attachButton = page
    .locator(
      'button[aria-label*="Attach" i], button[title*="Attach" i], [data-icon-name="Attach"], [data-icon-name="AttachRegular"]'
    )
    .first();

  if (await attachButton.isVisible().catch(() => false)) {
    // The chooser may open on the Attach click itself on older builds, so listen first.
    const early = page.waitForEvent('filechooser', { timeout: 4000 }).catch(() => null);
    await attachButton.click({ force: true }).catch(() => {});
    const earlyChooser = await early;
    if (earlyChooser) {
      await earlyChooser.setFiles(filePath);
      if (await waitForAttachment(page, filePath)) return 'attach-button-direct';
    }

    await page.waitForTimeout(1200);

    // A menu opened. Its labels vary by build, and it also often contains a fresh file input.
    const menuItem = page
      .locator(
        [
          'button:has-text("Browse this computer")',
          '[role="menuitem"]:has-text("Browse this computer")',
          'button:has-text("Upload from this computer")',
          '[role="menuitem"]:has-text("Upload from this computer")',
          'button:has-text("This computer")',
          '[role="menuitem"]:has-text("This computer")',
          'span:has-text("Browse this computer")',
        ].join(', ')
      )
      .first();

    if (await menuItem.isVisible().catch(() => false)) {
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 20_000 }).catch(() => null);
      await menuItem.click({ force: true }).catch(() => {});
      const chooser = await chooserPromise;
      if (chooser) {
        await chooser.setFiles(filePath);
        if (await waitForAttachment(page, filePath)) return 'attach-menu';
      }
    }

    // The menu may have injected a usable input rather than opening a dialog.
    const afterMenu = page.locator('input[type="file"]');
    const afterCount = await afterMenu.count().catch(() => 0);
    for (let i = 0; i < afterCount; i++) {
      try {
        await afterMenu.nth(i).setInputFiles(filePath);
        if (await waitForAttachment(page, filePath)) return 'file-input-after-menu';
      } catch {
        // Try the next.
      }
    }
  }

  const surface = await describeAttachSurface(page);
  const shot = await captureFailureContext(page);
  throw new Error(
    `Outlook: could not attach ${path.basename(filePath)} — neither a file input nor the Attach ` +
      `menu worked. Not sending, because a message without its CSV is inert at the far end. ` +
      `${surface}.${shot}`
  );
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/**
 * Outlook interposes "Attachment reminder" / "send without a subject" dialogs and greys out the
 * ribbon Send behind them. Every retry then clicks a disabled button forever.
 */
async function confirmBlockingPrompt(page) {
  const prompt = page
    .locator('[role="dialog"], .ms-Dialog-main, [class*="Dialog"]')
    .filter({ hasText: /forgotten to attach|Attachment reminder|without a subject/i })
    .first();
  if (!(await prompt.isVisible().catch(() => false))) return false;

  const confirm = prompt
    .getByRole('button', { name: /^\s*Send\s*$/i })
    .or(prompt.locator('button').filter({ hasText: /^\s*Send\s*$/i }))
    .first();
  if (!(await confirm.isVisible().catch(() => false))) return false;

  await confirm.click({ force: true }).catch(() => {});
  await page.waitForTimeout(1500);
  return true;
}

async function sendLooksConfirmed(page) {
  // A blocking prompt means nothing has gone anywhere yet.
  if (await confirmBlockingPrompt(page)) return false;

  const toast = await page
    .locator('text=/message has been sent|sent successfully|your message has been sent|sending/i')
    .first()
    .isVisible()
    .catch(() => false);
  if (toast) return true;

  const sendBtn = page
    .locator('button[aria-label^="Send"], button[title^="Send"], [data-automationid="sendButton"]')
    .first();
  return !(await sendBtn.isVisible().catch(() => false));
}

/** Wait for Send to become enabled — attachment processing disables it. */
async function waitForSendEnabled(page) {
  const deadline = Date.now() + SEND_ENABLE_MS;
  while (Date.now() < deadline) {
    const probe = page
      .locator('button[aria-label*="Send" i], button[title*="Send" i], [data-automationid="sendButton"]')
      .first();
    if (await probe.isVisible({ timeout: 500 }).catch(() => false)) {
      const disabled = await probe.isDisabled().catch(() => false);
      const aria = await probe.getAttribute('aria-disabled').catch(() => null);
      if (!disabled && aria !== 'true') return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

/**
 * Press Send and wait for confirmation, escalating through selectors only while a compose window
 * is still on screen. A closed window means an earlier press already went through, and pressing
 * again would send a second copy — at the far end, a duplicate device load.
 */
async function clickSend(page) {
  await waitForSendEnabled(page);

  const msgTab = page.locator('[role="tab"]:has-text("Message"), button:has-text("Message")').first();
  if (await msgTab.isVisible({ timeout: 2000 }).catch(() => false)) {
    await msgTab.click().catch(() => {});
    await page.waitForTimeout(400);
  }

  const waitForConfirmation = async (budgetMs) => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      if (await sendLooksConfirmed(page)) return true;
      if (Date.now() >= deadline) return false;
      await page.waitForTimeout(1000);
    }
  };

  const composeStillOpen = () =>
    page
      .locator('button[aria-label^="Send"], button[title^="Send"], [data-automationid="sendButton"]')
      .first()
      .isVisible()
      .catch(() => false);

  let attempts = 0;
  for (const selector of SEND_SELECTORS) {
    if (attempts > 0) {
      if (!(await composeStillOpen())) return true;
      // `composeStillOpen` only asks "is there a Send button anywhere" — if a second, unrelated
      // panel has appeared since the first click, that question can say yes even though the
      // panel we actually filled already sent and closed. Escalating to another selector at that
      // point risks clicking Send on the wrong (empty) panel, which reads as this call having
      // failed even though the real message already went. Stop and let the caller report it
      // rather than guess.
      if ((await countComposePanels(page)) > 1) return false;
    }

    const btn = page.locator(selector).first();
    if (!(await btn.isVisible().catch(() => false))) continue;
    if (await btn.isDisabled().catch(() => false)) continue;
    if ((await btn.getAttribute('aria-disabled').catch(() => null)) === 'true') continue;

    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn
      .click({ timeout: 8000 })
      .catch(() => btn.click({ force: true, timeout: 8000 }).catch(() => {}));

    attempts++;
    // The first click gets the full window; later strategies exist only for a click that plainly
    // did not register, so they need far less.
    if (await waitForConfirmation(attempts === 1 ? SEND_CONFIRM_MS : Math.min(SEND_CONFIRM_MS, 30_000))) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sent Items
// ---------------------------------------------------------------------------

/**
 * Sent Items on the same host the session is already on. An explicit OUTLOOK_SENT_ITEMS_URL wins;
 * otherwise the current origin is reused, falling back to the configured default.
 */
function sentItemsUrlFor(currentUrl) {
  if (process.env.OUTLOOK_SENT_ITEMS_URL) return process.env.OUTLOOK_SENT_ITEMS_URL;
  try {
    const { origin } = new URL(currentUrl);
    if (MAIL_URL.test(currentUrl)) return `${origin}/mail/sentitems`;
  } catch {
    /* not a usable URL */
  }
  return SENT_ITEMS_URL;
}

/** Compare subjects the way a mail list renders them: no emoji, collapsed whitespace. */
function normalizeSubject(value) {
  return String(value || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Poll Sent Items until the message shows up.
 *
 * This is the only signal that survives the browser being torn down: a closed compose window tells
 * you nothing about whether Outlook finished transmitting.
 */
export async function verifyInSentItems(page, subject, timeoutMs = SENT_VERIFY_MS) {
  const needle = normalizeSubject(subject);
  if (!needle) return { confirmed: null, reason: 'No subject to match on.' };
  // Long subjects are truncated in the list, so match a distinctive leading chunk.
  const probe = needle.slice(0, 45);

  // Microsoft is migrating OWA from outlook.office.com to outlook.cloud.microsoft, and a saved
  // session lands on whichever the tenant has been moved to. Derive Sent Items from where we
  // actually are rather than sending the browser back across a redirect mid-verification.
  const sentUrl = sentItemsUrlFor(page.url());

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await page.goto(sentUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(4000);

    const rows = await page
      .locator('div[role="option"], div[role="listitem"]')
      .allInnerTexts()
      .catch(() => []);

    const hit = rows.find((row) => normalizeSubject(row).includes(probe));
    if (hit) return { confirmed: true, matchedOn: 'subject', row: hit.slice(0, 160) };

    if (Date.now() >= deadline) {
      return {
        confirmed: false,
        reason:
          `"${subject}" did not appear in Sent Items within ${Math.round(timeoutMs / 1000)}s. ` +
          'Treat it as NOT delivered — but check the mailbox before re-sending, since a second ' +
          'send is a double load.',
      };
    }
    await page.waitForTimeout(5000);
  }
}

/**
 * Snapshot the compose window when a send is never confirmed: a screenshot plus any banner text
 * Outlook is showing. Size rejections and validation errors surface there, not in the DOM checked
 * above.
 */
async function captureFailureContext(page) {
  const parts = [];
  try {
    const dir = path.join(DATA_DIR, 'diagnostics');
    fs.mkdirSync(dir, { recursive: true });
    const shot = path.join(dir, `outlook-send-failure-${Date.now()}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    if (fs.existsSync(shot)) parts.push(`Screenshot: ${shot}`);
  } catch {
    // Diagnostics must never mask the original failure.
  }
  try {
    const alerts = await page
      .locator('[role="alert"], [role="alertdialog"], .ms-MessageBar, [class*="errorMessage" i]')
      .allInnerTexts()
      .catch(() => []);
    const text = alerts.map((a) => String(a).trim()).filter(Boolean).join(' | ').slice(0, 400);
    if (text) parts.push(`Outlook said: "${text}"`);
  } catch {
    // ignore
  }
  return parts.length ? ` ${parts.join(' — ')}` : '';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function closeHeld() {
  try {
    await held.context?.close();
  } catch {
    /* already gone */
  }
  try {
    await held.browser?.close();
  } catch {
    /* already gone */
  }
  Object.assign(held, { browser: null, context: null, page: null, subject: null });
}

export const closeOutlook = closeHeld;

async function launch({ headless }) {
  const { chromium } = await getPlaywright();
  if (!hasStoredSession()) {
    throw new OutlookAuthError(
      'No saved Outlook session. Sign in once on the Connect screen — or point ' +
        'OUTLOOK_AUTH_STATE_PATH at an existing outlook-auth.json.'
    );
  }
  const browser = await chromium.launch({ headless, args: headless ? [] : ['--start-maximized'] });
  const context = await browser.newContext({
    storageState: AUTH_FILE,
    acceptDownloads: true,
    ...(headless ? { viewport: { width: 1440, height: 960 } } : { viewport: null }),
  });
  const page = await context.newPage();
  await page.goto(OUTLOOK_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });

  if (!(await waitForInboxHydration(page))) {
    await browser.close().catch(() => {});
    throw new OutlookAuthError('The saved Outlook session has expired. Sign in again on the Connect screen.');
  }
  return { browser, context, page };
}

/**
 * Compose a message and either leave it for review or send it.
 *
 * @param {object} message   { to, subject, body, attachmentPath }
 * @param {object} [options] { autoSend }
 */
export async function composeAndSend(
  { to, subject, body, attachmentPath },
  // `headless` defaults to autoSend: a compose-and-stop needs a window you can see, an auto-send
  // does not. Overriding it is for verifying the plumbing without a window appearing.
  { autoSend = false, headless = autoSend } = {}
) {
  const recipients = (Array.isArray(to) ? to : String(to).split(','))
    .map((a) => a.trim())
    .filter(Boolean);
  if (!recipients.length) throw new Error('At least one recipient is required.');
  if (!subject) throw new Error('A subject is required.');

  await closeHeld();
  const { browser, context, page } = await launch({ headless });

  try {
    await openComposeWindow(page);

    // Every fill/attach/send step below queries the page rather than holding a handle to this
    // specific panel. That is only safe while exactly one panel exists — a second one (a slow
    // first attempt that finally rendered, a leftover draft from an earlier crash, an OWA
    // notification popping its own compose) lets one step land on this panel and a later step
    // land on the other. Refuse outright rather than guess which is which: a message sent from
    // the wrong panel is empty, and one sent from the right panel while this call reports failure
    // is a real, untracked send. See countComposePanels' doc comment for the incident this guards.
    const panelsAtOpen = await countComposePanels(page);
    if (panelsAtOpen > 1) {
      const shot = await captureFailureContext(page);
      throw new Error(
        `Outlook has ${panelsAtOpen} compose windows open at once. Filling and sending would be ` +
          `ambiguous about which one gets the recipients and which gets Send. Close the extra ` +
          `draft(s) in Outlook (check the Drafts folder) and retry.${shot}`
      );
    }

    await fillRecipients(page, recipients);
    await fillSubject(page, subject);
    await fillBody(page, body ?? '');
    const attachedVia = await attachFile(page, attachmentPath);

    // Re-read OWA's own attachment list after everything is filled in, and require exactly one
    // CSV — the one we meant. attachFile has already checked, but this is the last gate before a
    // message can leave, and an empty or double-attached send is unrecoverable at the far end.
    const attached = await attachedFiles(page);
    const csvs = attached.filter((label) => /\.csv/i.test(label));
    if (csvs.length !== 1 || !csvs[0].includes(path.basename(attachmentPath))) {
      const surface = await describeAttachSurface(page);
      const shot = await captureFailureContext(page);
      throw new Error(
        `Outlook reports ${csvs.length} CSV attachment(s) on the message ` +
          `(${JSON.stringify(attached)}), not exactly one named ${path.basename(attachmentPath)}. ` +
          `Refusing to go further — an empty or duplicated send is unrecoverable. ${surface}.${shot}`
      );
    }

    if (!autoSend) {
      // Keep it open and hand it over. Nothing is recorded as sent.
      Object.assign(held, { browser, context, page, subject });
      return {
        sent: false,
        composed: true,
        awaitingYourSend: true,
        to: recipients.join(', '),
        subject,
        attachment: path.basename(attachmentPath),
        attachedVia,
        // What OWA itself reports on the message, so the UI can show it rather than assert it.
        attachedPerOutlook: csvs,
        message:
          'The message is composed in the Outlook window with the CSV attached. Read it and press ' +
          'Send there, then confirm here so the app can check Sent Items.',
      };
    }

    // Re-check right before the click that actually sends: attaching or an "Attachment reminder"
    // dialog can itself spawn extra UI, and this is the last point where landing on the wrong
    // panel is still preventable rather than already a sent, untracked email.
    const panelsAtSend = await countComposePanels(page);
    if (panelsAtSend > 1) {
      const shot = await captureFailureContext(page);
      throw new Error(
        `Outlook now has ${panelsAtSend} compose windows open, up from 1 when this message was ` +
          `filled in. Refusing to click Send — it could land on the wrong one.${shot}`
      );
    }

    const clicked = await clickSend(page);
    if (!clicked) {
      const details = await captureFailureContext(page);
      throw new Error(`Outlook did not confirm that the message was sent.${details}`);
    }

    // A vanished Send button is not proof of delivery — the window also closes on discard. And the
    // browser must not be torn down before this resolves: doing so has silently lost a send.
    const sentItems = await verifyInSentItems(page, subject);
    if (sentItems.confirmed !== true) {
      const details = await captureFailureContext(page);
      throw new Error(`${sentItems.reason}${details}`);
    }

    await saveStorageState(context);
    return {
      sent: true,
      composed: true,
      awaitingYourSend: false,
      to: recipients.join(', '),
      subject,
      attachment: path.basename(attachmentPath),
      attachedVia,
      attachedPerOutlook: csvs,
      messageId: `outlook-web-${Date.now()}`,
      response: 'Sent through Outlook on the web (confirmed in Sent Items)',
      sentItems,
    };
  } finally {
    // The compose-and-stop path deliberately keeps its browser; everything else tears down.
    if (held.browser !== browser) {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }
}

/**
 * Check Sent Items for a message the user sent by hand in the open compose window. Falls back to a
 * fresh headless window if that one has since been closed.
 */
export async function checkSentItems({ subject }) {
  if (held.page) {
    try {
      const result = await verifyInSentItems(held.page, subject, Math.min(SENT_VERIFY_MS, 60_000));
      if (result.confirmed === true) await closeHeld();
      return { checked: true, ...result };
    } catch (err) {
      return { checked: true, confirmed: null, reason: `Sent Items check failed: ${err.message}` };
    }
  }

  try {
    const { browser, context, page } = await launch({ headless: true });
    try {
      const result = await verifyInSentItems(page, subject, Math.min(SENT_VERIFY_MS, 60_000));
      await saveStorageState(context).catch(() => {});
      return { checked: true, ...result };
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  } catch (err) {
    return { checked: false, confirmed: null, reason: err.message };
  }
}

/** Prove the saved session still works, without composing anything. */
export async function validateStoredSession() {
  if (!hasStoredSession()) return { ok: false, reason: 'No saved session.' };
  try {
    const { browser, context, page } = await launch({ headless: true });
    try {
      await saveStorageState(context);
      return { ok: true, url: page.url() };
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
