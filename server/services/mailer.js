/**
 * SMTP send, plus the Sent Items confirmation that makes a "sent" claim trustworthy.
 *
 * Sending is only half the job (spec section 4). A transport that accepted the message is
 * not the same as a message that left the building, and the previous automation learned
 * this the hard way driving Outlook Web — a compose window closing looks identical whether
 * the mail was transmitted or discarded. Here nodemailer gives us a real server response,
 * and an optional IMAP lookup in Sent Items confirms it independently.
 *
 * SMTP credentials arrive from the UI and live in this module's memory. Nothing is written
 * to disk and nothing is read from the environment.
 */

import nodemailer from 'nodemailer';
import { getSmtpConfig, getMailConfig } from '../lib/config.js';
import {
  composeAndSend,
  describeOutlook,
  authenticateInteractively,
  validateStoredSession,
} from './outlook-web-service.js';

/** envName -> { user, pass, from } */
const credentials = new Map();

export function setSmtpCredentials(envName, { user, pass, from }) {
  if (!user || !pass) throw new Error('SMTP username and password are both required.');
  credentials.set(envName, { user, pass, from: from || user });
  return { configured: true, user, from: from || user };
}

export function clearSmtpCredentials(envName) {
  credentials.delete(envName);
}

export function describeSmtp(envName) {
  const cred = credentials.get(envName);
  const cfg = getSmtpConfig();
  const mail = getMailConfig();
  const transport = mail.transport ?? 'smtp';

  const base = {
    transport,
    autoSend: Boolean(mail.autoSend),
    host: cfg.host,
    port: cfg.port,
    sentItemsCheckEnabled: Boolean(cfg.sentItemsCheck?.enabled),
  };

  if (transport === 'outlook-web') {
    const outlook = describeOutlook();
    return {
      ...base,
      // Outlook needs no credentials from this app: a saved storage state holds the session.
      configured: outlook.signedIn,
      needsCredentials: false,
      user: null,
      from: null,
      outlook,
    };
  }

  return {
    ...base,
    configured: Boolean(cred),
    needsCredentials: true,
    user: cred?.user ?? null,
    from: cred?.from ?? null,
  };
}

/**
 * Dispatch a send to whichever transport is configured.
 *
 * @param {string} envName
 * @param {object} message  { to, subject, body, attachment: { filename, content, path } }
 * @param {object} [options] { autoSend } — overrides the config default per call.
 */
export async function deliver(envName, message, options = {}) {
  const mail = getMailConfig();
  const transport = mail.transport ?? 'smtp';

  if (transport === 'outlook-web') {
    if (!message.attachment?.path) {
      throw new Error(
        'The Outlook transport attaches the file from disk, so the send needs its path. ' +
          'This is a bug in the caller, not a configuration problem.'
      );
    }
    const result = await composeAndSend(
      {
        to: message.to,
        subject: message.subject,
        body: message.body,
        attachmentPath: message.attachment.path,
      },
      { autoSend: options.autoSend ?? Boolean(mail.autoSend) }
    );
    return { transport, ...result };
  }

  const result = await sendMail(envName, message);
  return { transport, sent: true, composed: true, awaitingYourSend: false, ...result };
}

/** One-time interactive Outlook sign-in, saving the session for later headless sends. */
export async function signInToOutlook() {
  return authenticateInteractively();
}

/** Prove the saved Outlook session still works. */
export async function verifyOutlook() {
  return validateStoredSession();
}

function transportFor(envName) {
  const cred = credentials.get(envName);
  if (!cred) {
    throw new Error(
      'SMTP is not configured for this session. Enter your mail username and app password ' +
        'on the Connect screen.'
    );
  }
  const cfg = getSmtpConfig();
  return {
    transporter: nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      requireTLS: cfg.requireTLS,
      auth: { user: cred.user, pass: cred.pass },
    }),
    cred,
    cfg,
  };
}

/** Prove the credentials work before a run rather than mid-run. */
export async function verifySmtp(envName) {
  const { transporter, cred } = transportFor(envName);
  await transporter.verify();
  return { ok: true, user: cred.user };
}

/**
 * @param {string} envName
 * @param {object} message
 * @param {string} message.to
 * @param {string} message.subject
 * @param {string} message.body
 * @param {{filename:string, content:Buffer}} message.attachment
 * @returns {Promise<{messageId:string, accepted:string[], rejected:string[], response:string,
 *                    sentItems:object}>}
 */
export async function sendMail(envName, { to, subject, body, attachment }) {
  const { transporter, cred, cfg } = transportFor(envName);

  const info = await transporter.sendMail({
    from: cred.from,
    to,
    subject,
    text: body,
    attachments: [
      {
        filename: attachment.filename,
        content: attachment.content,
        contentType: 'text/csv',
      },
    ],
  });

  if (info.rejected?.length) {
    throw new Error(`SMTP rejected recipient(s): ${info.rejected.join(', ')}`);
  }
  if (!info.accepted?.length) {
    throw new Error(`SMTP accepted no recipients. Server said: ${info.response}`);
  }

  const sentItems = cfg.sentItemsCheck?.enabled
    ? await confirmInSentItems(cred, cfg.sentItemsCheck, { subject, messageId: info.messageId })
    : { checked: false, confirmed: null, reason: 'Sent Items check disabled in config.' };

  return {
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected ?? [],
    response: info.response,
    envelope: info.envelope,
    sentItems,
  };
}

/**
 * Look for the message we just sent in the Sent Items folder.
 *
 * A failure here is reported, never thrown: the message may genuinely have been sent and
 * simply not filed yet, and treating "could not confirm" as "did not send" would push the
 * user into a double send. The distinction is surfaced so they can judge.
 */
async function confirmInSentItems(cred, sentCfg, { subject, messageId }) {
  let ImapFlow;
  try {
    ({ ImapFlow } = await import('imapflow'));
  } catch {
    return {
      checked: false,
      confirmed: null,
      reason: 'imapflow is not installed — run `npm install` to enable Sent Items confirmation.',
    };
  }

  const client = new ImapFlow({
    host: sentCfg.host,
    port: sentCfg.port,
    secure: sentCfg.secure,
    auth: { user: cred.user, pass: cred.pass },
    logger: false,
  });

  try {
    await client.connect();
    const mailbox = await openSentMailbox(client, sentCfg.sentMailbox);
    if (!mailbox) {
      return { checked: true, confirmed: null, reason: 'Could not open a Sent Items mailbox.' };
    }

    // Give the server a moment to file the message, then look for it by Message-ID.
    for (let attempt = 0; attempt < 6; attempt++) {
      const hits = await client.search({ header: { 'message-id': messageId } });
      if (hits?.length) {
        return { checked: true, confirmed: true, mailbox, uid: hits[hits.length - 1], matchedOn: 'message-id' };
      }
      const bySubject = await client.search({ header: { subject } });
      if (bySubject?.length) {
        return {
          checked: true,
          confirmed: true,
          mailbox,
          uid: bySubject[bySubject.length - 1],
          matchedOn: 'subject',
        };
      }
      await new Promise((r) => setTimeout(r, 2500));
    }

    return {
      checked: true,
      confirmed: false,
      mailbox,
      reason:
        'The SMTP server accepted the message but it did not appear in Sent Items within 15s. ' +
        'It may still be filing — check the mailbox before re-sending, since a second send is a double load.',
    };
  } catch (err) {
    return { checked: true, confirmed: null, reason: `Sent Items check failed: ${err.message}` };
  } finally {
    try {
      await client.logout();
    } catch {
      /* already closed */
    }
  }
}

async function openSentMailbox(client, preferred) {
  const candidates = [preferred, 'Sent Items', 'Sent', '[Gmail]/Sent Mail', 'INBOX.Sent'].filter(
    Boolean
  );
  for (const name of candidates) {
    try {
      await client.mailboxOpen(name);
      return name;
    } catch {
      /* try the next name */
    }
  }
  // Fall back to whatever the server flags as \Sent.
  try {
    for await (const box of client.list()) {
      if (box.specialUse === '\\Sent') {
        await client.mailboxOpen(box.path);
        return box.path;
      }
    }
  } catch {
    /* listing unavailable */
  }
  return null;
}

/**
 * RFC 5322 message with the CSV attached, for when SMTP is blocked. Opens in Outlook
 * pre-addressed; the user presses Send. The bytes of the attachment are identical to what
 * SMTP would have transmitted.
 */
export function buildEml({ from, to, subject, body, attachment }) {
  const boundary = `----=_AutoLoader_${Buffer.from(subject).toString('hex').slice(0, 16)}`;
  const b64 = attachment.content.toString('base64').replace(/(.{76})/g, '$1\r\n');

  return Buffer.from(
    [
      `From: ${from ?? ''}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      body,
      '',
      `--${boundary}`,
      `Content-Type: text/csv; name="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      '',
      b64,
      '',
      `--${boundary}--`,
      '',
    ].join('\r\n'),
    'utf8'
  );
}
