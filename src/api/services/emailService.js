'use strict';

async function sendVerificationEmail(email, name, token) {
  const url = `${process.env.APP_URL}/api/auth/verify-email?token=${token}`;

  // Dev mode or no SMTP — just log
  if (process.env.NODE_ENV !== 'production' || !process.env.SMTP_PASS) {
    console.log('[EMAIL] Verification URL for', email, ':', url);
    return;
  }

  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({
    host:   process.env.SMTP_HOST   || 'smtp.resend.com',
    port:   parseInt(process.env.SMTP_PORT || '465'),
    secure: process.env.SMTP_SECURE === 'true',
    auth:   { user: process.env.SMTP_USER || 'resend', pass: process.env.SMTP_PASS },
  });

  await transport.sendMail({
    from:    process.env.EMAIL_FROM || 'NexGen Study <support@corverxis.com>',
    to:      email,
    subject: 'Verify your NexGen Study account',
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px">
        <h2 style="color:#0F2645">Welcome to NexGen Study, ${name}!</h2>
        <p>Please verify your email address to activate your 7-day free trial.</p>
        <a href="${url}" style="display:inline-block;background:#00C8FF;color:#0F2645;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:700;margin:16px 0">Verify Email Address</a>
        <p style="font-size:12px;color:#888">This link expires in 24 hours.</p>
        <p style="font-size:11px;color:#aaa">Corverxis Technologies Ltd &middot; support@corverxis.com</p>
      </div>
    `,
  });
}

async function sendPasswordResetEmail(email, name, token) {
  const url = `${process.env.APP_URL}/reset-password?token=${token}`;

  if (process.env.NODE_ENV !== 'production' || !process.env.SMTP_PASS) {
    console.log('[EMAIL] Password reset URL for', email, ':', url);
    return;
  }

  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({
    host:   process.env.SMTP_HOST   || 'smtp.resend.com',
    port:   parseInt(process.env.SMTP_PORT || '465'),
    secure: process.env.SMTP_SECURE === 'true',
    auth:   { user: process.env.SMTP_USER || 'resend', pass: process.env.SMTP_PASS },
  });

  await transport.sendMail({
    from:    process.env.EMAIL_FROM || 'NexGen Study <support@corverxis.com>',
    to:      email,
    subject: 'Reset your NexGen Study password',
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px">
        <h2 style="color:#0F2645">Password Reset Request</h2>
        <p>Hi ${name}, click below to reset your password.</p>
        <a href="${url}" style="display:inline-block;background:#00C8FF;color:#0F2645;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:700;margin:16px 0">Reset Password</a>
        <p style="font-size:12px;color:#888">This link expires in 1 hour.</p>
        <p style="font-size:11px;color:#aaa">Corverxis Technologies Ltd &middot; support@corverxis.com</p>
      </div>
    `,
  });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail };
