import "./env.js";
import nodemailer from "nodemailer";
import process from "node:process";
import { pool, withTransaction } from "./db.js";

export function createTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) {
    const error = new Error("SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM are required for email delivery.");
    error.status = 503;
    throw error;
  }
  if (!Number.isInteger(Number(SMTP_PORT)) || Number(SMTP_PORT) < 1 || Number(SMTP_PORT) > 65535) {
    const error = new Error("SMTP_PORT must be a valid TCP port.");
    error.status = 503;
    throw error;
  }

  return {
    from: SMTP_FROM,
    transport: nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    }),
  };
}

export async function queueEmail(recipient, subject, body) {
  createTransport();
  await pool.query(
    "INSERT INTO mail_outbox (recipient, subject, body) VALUES ($1, $2, $3)",
    [recipient, subject, body]
  );
}

export async function deliverQueuedEmails() {
  const { transport, from } = createTransport();
  const rows = await withTransaction(async (client) => {
    const { rows: queued } = await client.query(
      `SELECT id, recipient, subject, body, attempts FROM mail_outbox
       WHERE sent_at IS NULL AND next_attempt_at <= now()
       ORDER BY id LIMIT 10 FOR UPDATE SKIP LOCKED`
    );
    for (const message of queued) {
      await client.query(
        `UPDATE mail_outbox
         SET attempts = attempts + 1, next_attempt_at = DATE_ADD(now(), INTERVAL 10 MINUTE)
         WHERE id = $1`,
        [message.id]
      );
      message.attempts += 1;
    }
    return queued;
  });

  for (const message of rows) {
    try {
      await transport.sendMail({
        from,
        to: message.recipient,
        subject: message.subject,
        text: message.body,
      });
      await pool.query(
        "UPDATE mail_outbox SET sent_at = now(), last_error = NULL WHERE id = $1",
        [message.id]
      );
    } catch (error) {
      const delayMinutes = Math.min(60, 2 ** Math.min(message.attempts, 6));
      console.error(`Unable to deliver queued email ${message.id}:`, error);
      await pool.query(
        `UPDATE mail_outbox
         SET next_attempt_at = DATE_ADD(now(), INTERVAL $2 MINUTE),
             last_error = $3
         WHERE id = $1`,
        [message.id, delayMinutes, String(error.message || error).slice(0, 1000)]
      );
    }
  }
}
