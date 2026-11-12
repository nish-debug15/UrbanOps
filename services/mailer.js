/**
 * Outgoing email.
 *
 * Transport is chosen from the environment:
 *   SMTP_HOST set            → real SMTP (Gmail app password, SendGrid, Mailgun, your own)
 *   otherwise, in dev        → Ethereal test inbox: nothing is delivered, the server logs a
 *                              preview URL where you can read the email
 *   otherwise (offline/prod) → logged to the console, reported as not sent
 *
 * Tests inject a stub with setTransport(). sendMail() never throws: it returns
 * { sent, previewUrl?, error? } so callers can fall back to showing the code.
 */

const nodemailer = require('nodemailer');

const FROM = process.env.MAIL_FROM || 'UrbanOps <no-reply@urbanops.local>';
const APP_NAME = 'UrbanOps';

let transportPromise = null;
let mode = 'auto';

const buildTransport = async () => {
  if (process.env.SMTP_HOST) {
    const port = Number(process.env.SMTP_PORT) || 587;
    return {
      mode: 'smtp',
      transport: nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      }),
    };
  }
  if (process.env.NODE_ENV !== 'production' && process.env.MAIL_MODE !== 'log') {
    try {
      const account = await nodemailer.createTestAccount();
      console.log(`[Mail] No SMTP configured: using an Ethereal test inbox (${account.user}). Emails are NOT delivered; preview URLs are logged.`);
      return {
        mode: 'ethereal',
        transport: nodemailer.createTransport({
          host: account.smtp.host,
          port: account.smtp.port,
          secure: account.smtp.secure,
          auth: { user: account.user, pass: account.pass },
        }),
      };
    } catch (err) {
      console.warn(`[Mail] Could not reach Ethereal (${err.message}); emails will be logged to the console instead.`);
    }
  }
  return { mode: 'log', transport: null };
};

const getTransport = () => {
  if (!transportPromise) transportPromise = buildTransport().then((t) => { mode = t.mode; return t; });
  return transportPromise;
};

/** Tests: replace the transport. Pass null to restore auto-detection. */
const setTransport = (transport, newMode = 'stub') => {
  transportPromise = transport ? Promise.resolve({ mode: newMode, transport }) : null;
  mode = transport ? newMode : 'auto';
};

/**
 * @param {{ to: string, subject: string, text: string, html?: string }} message
 * @returns {Promise<{ sent: boolean, mode: string, previewUrl?: string, error?: string }>}
 */
const sendMail = async (message) => {
  const { mode: m, transport } = await getTransport();
  const mail = { from: FROM, ...message };

  if (!transport) {
    console.log(`[Mail] (not sent) To: ${mail.to}\n  Subject: ${mail.subject}\n  ${mail.text.replace(/\n/g, '\n  ')}`);
    return { sent: false, mode: m, error: 'Email is not configured on this server' };
  }
  try {
    const info = await transport.sendMail(mail);
    const previewUrl = m === 'ethereal' ? nodemailer.getTestMessageUrl(info) || undefined : undefined;
    if (previewUrl) console.log(`[Mail] Preview (not delivered): ${previewUrl}`);
    return { sent: true, mode: m, previewUrl };
  } catch (err) {
    console.error('[Mail] Send failed:', err.message);
    return { sent: false, mode: m, error: err.message };
  }
};

/** Public URL of the web app, for links in emails. First CLIENT_ORIGIN entry by default. */
const appUrl = () => {
  const explicit = process.env.APP_URL;
  const origin = (process.env.CLIENT_ORIGIN || 'http://localhost:3000').split(',')[0].trim();
  return (explicit || origin).replace(/\/$/, '');
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The state-admin invite email. */
const inviteEmail = ({ code, regionName, expiresAt, note, invitedBy }) => {
  const link = `${appUrl()}/login?invite=${encodeURIComponent(code)}`;
  const expires = new Date(expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  const subject = `Your ${APP_NAME} admin invitation for ${regionName}`;
  const text = [
    `${invitedBy || `The ${APP_NAME} team`} has invited you to be the ${APP_NAME} administrator for ${regionName}.`,
    '',
    `Your invite code: ${code}`,
    '',
    `Set up your account: ${link}`,
    '',
    `The code works once and expires on ${expires}. If you did not expect this, ignore this email.`,
    '',
    `— ${APP_NAME}`,
  ].join('\n');
  const html = `
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1A1C1E">
  <p style="font-size:12px;letter-spacing:1.5px;color:#4D5358;font-weight:700">${APP_NAME} COMMAND CENTER</p>
  <h2 style="margin:0 0 12px">You're invited to administer ${escapeHtml(regionName)}</h2>
  <p>${escapeHtml(invitedBy || `The ${APP_NAME} team`)} has invited you to be the ${APP_NAME} administrator for <b>${escapeHtml(regionName)}</b>.${note ? ` <span style="color:#4D5358">(${escapeHtml(note)})</span>` : ''}</p>
  <p style="margin:20px 0 6px;font-size:13px;color:#4D5358">Your invite code</p>
  <div style="font-family:Consolas,monospace;font-size:24px;font-weight:700;letter-spacing:2px;padding:12px 16px;border:2px dashed #2B5C5D;display:inline-block">${escapeHtml(code)}</div>
  <p style="margin:24px 0 8px">
    <a href="${escapeHtml(link)}" style="background:#2B5C5D;color:#fff;text-decoration:none;padding:12px 20px;font-weight:700;display:inline-block">Set up my admin account</a>
  </p>
  <p style="font-size:13px;color:#4D5358">The code works once and expires on <b>${escapeHtml(expires)}</b>. If you did not expect this, ignore this email.</p>
</div>`;
  return { subject, text, html };
};

/** Dispatcher account created / password reset by their admin. */
const staffEmail = ({ name, temporaryPassword, regionName, createdBy, reason = 'created' }) => {
  const link = `${appUrl()}/login`;
  const by = createdBy || 'Your state admin';
  const subject =
    reason === 'reset'
      ? `Your ${APP_NAME} password was reset`
      : `Your ${APP_NAME} dispatcher account for ${regionName}`;
  const intro =
    reason === 'reset'
      ? `${by} reset your ${APP_NAME} password.`
      : `${by} created a ${APP_NAME} dispatcher account for you in ${regionName}.`;
  const text = [
    `Hello ${name},`,
    '',
    intro,
    '',
    `Temporary password: ${temporaryPassword}`,
    '',
    `Sign in at ${link} with this email address. You will be asked to choose your own password first.`,
    '',
    `— ${APP_NAME}`,
  ].join('\n');
  const html = `
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1A1C1E">
  <p style="font-size:12px;letter-spacing:1.5px;color:#4D5358;font-weight:700">${APP_NAME} COMMAND CENTER</p>
  <h2 style="margin:0 0 12px">${escapeHtml(subject)}</h2>
  <p>Hello ${escapeHtml(name)},</p>
  <p>${escapeHtml(intro)}</p>
  <p style="margin:20px 0 6px;font-size:13px;color:#4D5358">Temporary password</p>
  <div style="font-family:Consolas,monospace;font-size:24px;font-weight:700;letter-spacing:2px;padding:12px 16px;border:2px dashed #2B5C5D;display:inline-block">${escapeHtml(temporaryPassword)}</div>
  <p style="margin:24px 0 8px">
    <a href="${escapeHtml(link)}" style="background:#2B5C5D;color:#fff;text-decoration:none;padding:12px 20px;font-weight:700;display:inline-block">Sign in</a>
  </p>
  <p style="font-size:13px;color:#4D5358">Use this email address to sign in. You will be asked to choose your own password first.</p>
</div>`;
  return { subject, text, html };
};

const shell = (title, bodyHtml) => `
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1A1C1E">
  <p style="font-size:12px;letter-spacing:1.5px;color:#4D5358;font-weight:700">${APP_NAME} COMMAND CENTER</p>
  <h2 style="margin:0 0 12px">${escapeHtml(title)}</h2>
  ${bodyHtml}
</div>`;

const button = (href, label) =>
  `<p style="margin:24px 0 8px"><a href="${escapeHtml(href)}" style="background:#2B5C5D;color:#fff;text-decoration:none;padding:12px 20px;font-weight:700;display:inline-block">${escapeHtml(label)}</a></p>`;

/** Self-service password reset link. */
const passwordResetEmail = ({ name, token, expiresAt }) => {
  const link = `${appUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  const minutes = Math.max(1, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60000));
  const subject = `Reset your ${APP_NAME} password`;
  const text = [
    `Hello ${name},`,
    '',
    `Someone asked to reset the password for your ${APP_NAME} account. Choose a new one here:`,
    '',
    link,
    '',
    `The link works once and expires in ${minutes} minutes. If this wasn't you, ignore this email: your password stays the same.`,
    '',
    `— ${APP_NAME}`,
  ].join('\n');
  const html = shell(
    subject,
    `<p>Hello ${escapeHtml(name)},</p>
  <p>Someone asked to reset the password for your ${APP_NAME} account.</p>
  ${button(link, 'Choose a new password')}
  <p style="font-size:13px;color:#4D5358">The link works once and expires in <b>${minutes} minutes</b>. If this wasn't you, ignore this email: your password stays the same.</p>`
  );
  return { subject, text, html };
};

/** Tells a reporter their issue was dispatched or resolved. */
const issueStatusEmail = ({ name, title, ref, place, status, note }) => {
  const link = `${appUrl()}/my-reports`;
  const resolved = status === 'resolved';
  const subject = resolved ? `Resolved: ${title} (${ref})` : `A crew is on it: ${title} (${ref})`;
  const intro = resolved
    ? `The issue you reported has been marked as resolved.`
    : `The issue you reported has been dispatched: someone has been assigned to deal with it.`;
  const text = [
    `Hello ${name},`,
    '',
    intro,
    '',
    `${title} · ${ref}`,
    ...(place ? [place] : []),
    ...(resolved && note ? ['', `What was done: ${note}`] : []),
    '',
    `Follow your reports: ${link}`,
    ...(resolved ? ['', 'If the problem is still there, report it again and it will be reopened as a new issue.'] : []),
    '',
    `— ${APP_NAME}`,
  ].join('\n');
  const html = shell(
    resolved ? 'Your report was resolved' : 'A crew is on it',
    `<p>Hello ${escapeHtml(name)},</p>
  <p>${escapeHtml(intro)}</p>
  <div style="border-left:4px solid #2B5C5D;padding:8px 14px;margin:16px 0;background:#F2F4F5">
    <b>${escapeHtml(title)}</b> <span style="font-family:Consolas,monospace;color:#4D5358">${escapeHtml(ref)}</span>
    ${place ? `<br><span style="color:#4D5358">${escapeHtml(place)}</span>` : ''}
  </div>
  ${resolved && note ? `<p><b>What was done:</b> ${escapeHtml(note)}</p>` : ''}
  ${button(link, 'View my reports')}
  ${resolved ? '<p style="font-size:13px;color:#4D5358">If the problem is still there, report it again and it will be opened as a new issue.</p>' : ''}`
  );
  return { subject, text, html };
};

module.exports = {
  sendMail,
  setTransport,
  inviteEmail,
  staffEmail,
  passwordResetEmail,
  issueStatusEmail,
  appUrl,
  getMode: () => mode,
};
