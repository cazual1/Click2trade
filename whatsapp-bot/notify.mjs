// ── NOTIFICATIONS ──
// Plain email (Resend) and SMS (Twilio) for dealer-facing messages.
// Both quietly no-op when the provider isn't configured, so the portal works before they're set up.

import twilio from 'twilio';

const {
  RESEND_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_SMS_NUMBER,
  TWILIO_MESSAGING_SERVICE_SID,
  BUSINESS_NAME = 'Click2Trade',
  DEALER_FROM_EMAIL = process.env.FROM_EMAIL || 'stock@click2trade.com.au',
} = process.env;

const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

export const canEmail = !!RESEND_API_KEY;
export const canSms = !!(twilioClient && (TWILIO_SMS_NUMBER || TWILIO_MESSAGING_SERVICE_SID));

export async function sendEmail(to, subject, text) {
  if (!canEmail || !to) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `${BUSINESS_NAME} <${DEALER_FROM_EMAIL}>`, to, subject, text }),
    });
    if (!res.ok) console.error('Email failed:', to, res.status, await res.text());
    return res.ok;
  } catch (err) {
    console.error('Email failed:', to, err.message);
    return false;
  }
}

export async function sendSms(to, body) {
  if (!canSms || !to) return false;
  try {
    const msg = { to, body };
    if (TWILIO_MESSAGING_SERVICE_SID) msg.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
    else msg.from = TWILIO_SMS_NUMBER;
    await twilioClient.messages.create(msg);
    return true;
  } catch (err) {
    console.error('SMS failed:', to, err.message);
    return false;
  }
}
