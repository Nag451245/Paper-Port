import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger('Mailer');

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

let transporter: Transporter | null = null;

export function isMailConfigured(): boolean {
  return !!env.SMTP_HOST;
}

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,          // 465 is implicit TLS; 587 upgrades with STARTTLS
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

/**
 * Send an email. Returns false (never throws) when mail is not configured or
 * the provider refuses, so a caller such as "forgot password" can still give
 * the same answer whether or not the address exists.
 */
export async function sendMail(msg: MailMessage): Promise<boolean> {
  if (!isMailConfigured()) {
    log.warn({ to: msg.to, subject: msg.subject }, 'SMTP not configured (SMTP_HOST empty) — email not sent');
    return false;
  }
  try {
    await getTransporter().sendMail({
      from: env.SMTP_FROM || env.SMTP_USER,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
    return true;
  } catch (err) {
    log.error({ err: (err as Error).message, subject: msg.subject }, 'Email send failed');
    return false;
  }
}
