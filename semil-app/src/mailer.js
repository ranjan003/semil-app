'use strict';
// Email plugin: Nodemailer over SMTP.
// Works with SendGrid, Amazon SES, Mailgun, Gmail, or any SMTP relay.
// In development (when SMTP_HOST is unset) messages are logged to the console.

const nodemailer = require('nodemailer');

/**
 * @param {object} opts
 * @param {string}  [opts.host]      SMTP host (e.g. smtp.sendgrid.net)
 * @param {number}  [opts.port]      SMTP port (465 for TLS, 587 for STARTTLS)
 * @param {boolean} [opts.secure]    true for port 465
 * @param {string}  [opts.user]      SMTP username / API key
 * @param {string}  [opts.pass]      SMTP password / API secret
 * @param {string}  [opts.from]      Default sender (e.g. "Semil <noreply@semil.in>")
 * @param {boolean} [opts.isProd]    Production flag
 */
function createMailer(opts = {}) {
  const from = opts.from || process.env.SMTP_FROM || 'Semil Talent Discovery <noreply@semil.in>';

  // If SMTP is not configured, return a logger-only mailer (safe for dev/test).
  if (!opts.host && !process.env.SMTP_HOST) {
    return {
      async send(to, subject, body, html) {
        console.log(`[mail] To: ${to}\n  Subject: ${subject}\n  ${body.slice(0, 200)}${body.length > 200 ? '…' : ''}`);
      },
      async sendTemplate(to, template, data) {
        const { subject, text, html } = renderTemplate(template, data);
        console.log(`[mail-template] To: ${to}\n  Template: ${template}\n  Subject: ${subject}`);
      },
      transport: null,
    };
  }

  const transport = nodemailer.createTransport({
    host: opts.host || process.env.SMTP_HOST,
    port: Number(opts.port || process.env.SMTP_PORT || 587),
    secure: opts.secure ?? (process.env.SMTP_SECURE === 'true'),
    auth: {
      user: opts.user || process.env.SMTP_USER,
      pass: opts.pass || process.env.SMTP_PASS,
    },
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    // Retry once on transient failures
    tls: { rejectUnauthorized: opts.isProd !== false },
  });

  return {
    /**
     * Send a plain-text email (with optional HTML).
     */
    async send(to, subject, body, html) {
      await transport.sendMail({ from, to, subject, text: body, html: html || undefined });
    },

    /**
     * Send a templated email.
     */
    async sendTemplate(to, template, data) {
      const { subject, text, html } = renderTemplate(template, data);
      await transport.sendMail({ from, to, subject, text, html });
    },

    transport,
  };
}

// ---- Email templates ----

const TEMPLATES = {
  password_reset: {
    subject: 'Reset your Semil password',
    text: d => `Hi ${d.name || 'there'},\n\nOpen this link within 30 minutes to reset your password:\n${d.link}\n\nIf you did not request this, ignore this email.\n\n— Semil Talent Discovery`,
    html: d => `
      <div style="font-family:Inter,system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
        <h2 style="color:#0B1B3A;margin:0 0 16px">Reset your password</h2>
        <p>Hi ${d.name || 'there'},</p>
        <p>Click the button below within 30 minutes to set a new password:</p>
        <p style="text-align:center;margin:24px 0">
          <a href="${d.link}" style="display:inline-block;background:#2457D6;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600">Reset Password</a>
        </p>
        <p style="color:#5A6A85;font-size:13px">If you did not request this, ignore this email.</p>
        <hr style="border:none;border-top:1px solid #E1E6EF;margin:24px 0">
        <p style="color:#92A3C0;font-size:12px">Semil Talent Discovery</p>
      </div>`,
  },

  interview_invite: {
    subject: d => `Interview scheduled: ${d.role || 'Position'} at Semil`,
    text: d => `Hi ${d.name},\n\nYour interview for ${d.role || 'the position'} has been scheduled.\n\nDate: ${d.date}\nTime: ${d.time}\nDuration: ${d.duration} minutes\nLocation: ${d.location || 'To be confirmed'}\n\n${d.instructions ? `Instructions:\n${d.instructions}\n\n` : ''}If you have questions, reply to this email.\n\n— Semil Talent Discovery`,
    html: d => `
      <div style="font-family:Inter,system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
        <h2 style="color:#0B1B3A;margin:0 0 16px">Interview Scheduled</h2>
        <p>Hi ${d.name},</p>
        <p>Your interview for <strong>${d.role || 'the position'}</strong> has been scheduled:</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr><td style="padding:8px 0;color:#5A6A85">Date</td><td style="padding:8px 0;font-weight:600">${d.date}</td></tr>
          <tr><td style="padding:8px 0;color:#5A6A85">Time</td><td style="padding:8px 0;font-weight:600">${d.time}</td></tr>
          <tr><td style="padding:8px 0;color:#5A6A85">Duration</td><td style="padding:8px 0;font-weight:600">${d.duration} minutes</td></tr>
          <tr><td style="padding:8px 0;color:#5A6A85">Location</td><td style="padding:8px 0;font-weight:600">${d.location || 'To be confirmed'}</td></tr>
        </table>
        ${d.instructions ? `<p style="background:#F7F9FC;padding:12px;border-radius:8px;font-size:13px">${d.instructions}</p>` : ''}
        <hr style="border:none;border-top:1px solid #E1E6EF;margin:24px 0">
        <p style="color:#92A3C0;font-size:12px">Semil Talent Discovery</p>
      </div>`,
  },

  test_invitation: {
    subject: d => `Assessment assigned: ${d.title || 'Test'}`,
    text: d => `Hi ${d.name},\n\nYou have been assigned an assessment: ${d.title}\n\nRound: ${d.round}\nTime limit: ${d.timeLimit || 'No limit'}\n${d.deadline ? `Due by: ${d.deadline}\n` : ''}\nLog in to your candidate portal to start:\n${d.link}\n\n— Semil Talent Discovery`,
    html: d => `
      <div style="font-family:Inter,system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
        <h2 style="color:#0B1B3A;margin:0 0 16px">Assessment Assigned</h2>
        <p>Hi ${d.name},</p>
        <p>You have been assigned a new assessment:</p>
        <div style="background:#E7EEFD;padding:16px;border-radius:10px;margin:16px 0">
          <p style="margin:0;font-weight:600;font-size:16px;color:#2457D6">${d.title}</p>
          <p style="margin:4px 0 0;color:#5A6A85;font-size:13px">Round ${d.round} • ${d.timeLimit || 'No time limit'}${d.deadline ? ` • Due by ${d.deadline}` : ''}</p>
        </div>
        <p style="text-align:center;margin:24px 0">
          <a href="${d.link}" style="display:inline-block;background:#2457D6;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600">Start Assessment</a>
        </p>
        <hr style="border:none;border-top:1px solid #E1E6EF;margin:24px 0">
        <p style="color:#92A3C0;font-size:12px">Semil Talent Discovery</p>
      </div>`,
  },

  offer_letter: {
    subject: 'Offer from Semil Retail Industries',
    text: d => `Dear ${d.name},\n\nCongratulations! We are pleased to extend an offer for the position of ${d.role} at Semil Retail Industries.\n\nExpected joining date: ${d.joiningDate || 'To be discussed'}\n\nPlease log in to your candidate portal to view and respond to the offer:\n${d.link}\n\nWe look forward to welcoming you to the team.\n\nBest regards,\nSemil Talent Discovery`,
    html: d => `
      <div style="font-family:Inter,system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
        <h2 style="color:#0B1B3A;margin:0 0 16px">🎉 Congratulations!</h2>
        <p>Dear ${d.name},</p>
        <p>We are pleased to extend an offer for the position of <strong>${d.role}</strong> at Semil Retail Industries.</p>
        ${d.joiningDate ? `<p>Expected joining date: <strong>${d.joiningDate}</strong></p>` : ''}
        <p style="text-align:center;margin:24px 0">
          <a href="${d.link}" style="display:inline-block;background:#17703A;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600">View Offer</a>
        </p>
        <p>We look forward to welcoming you to the team.</p>
        <hr style="border:none;border-top:1px solid #E1E6EF;margin:24px 0">
        <p style="color:#92A3C0;font-size:12px">Semil Talent Discovery</p>
      </div>`,
  },

  notification: {
    subject: d => d.subject || 'Semil Notification',
    text: d => `${d.message}\n\n${d.link ? `View details: ${d.link}\n\n` : ''}— Semil Talent Discovery`,
    html: d => `
      <div style="font-family:Inter,system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
        <p>${d.message}</p>
        ${d.link ? `<p><a href="${d.link}" style="color:#2457D6">View details →</a></p>` : ''}
        <hr style="border:none;border-top:1px solid #E1E6EF;margin:24px 0">
        <p style="color:#92A3C0;font-size:12px">Semil Talent Discovery</p>
      </div>`,
  },
};

function renderTemplate(name, data) {
  const t = TEMPLATES[name];
  if (!t) throw new Error(`Unknown email template: ${name}`);
  return {
    subject: typeof t.subject === 'function' ? t.subject(data) : t.subject,
    text: t.text(data),
    html: t.html(data),
  };
}

module.exports = { createMailer, renderTemplate, TEMPLATES };
