// ── SELLER OUTREACH ──
// Drafts the intro SMS/email to private sellers, sends it once a human approves,
// and records replies. Nothing goes out without approval.
//
// Messages to private sellers are commercial messages under the Spam Act 2003:
// every message identifies us and carries an opt-out, and opt-outs are suppressed forever.

import twilio from 'twilio';
import OpenAI from 'openai';
import { isSuppressed, suppress } from './store.mjs';

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_SMS_NUMBER,             // plain SMS number, e.g. +61...  (not the WhatsApp one)
  TWILIO_MESSAGING_SERVICE_SID,  // or a Messaging Service (alphanumeric sender etc.)
  RESEND_API_KEY,
  OPENAI_API_KEY,
  BUSINESS_NAME = 'Click2Trade',
  DEALER_LICENCE = '',           // e.g. "LMCT 12345" / "MD 12345"
  SENDER_NAME = 'the Click2Trade team',
  SENDER_PHONE = '',
  SELLER_FROM_EMAIL = process.env.FROM_EMAIL || 'buy@click2trade.com.au',
  INBOUND_DOMAIN = 'offers.click2trade.com.au',
} = process.env;

const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const carName = v => [v.year, v.make, v.model].filter(Boolean).join(' ');
const firstName = name => (name || '').trim().split(/\s+/)[0] || 'there';
const licence = DEALER_LICENCE ? ` (${DEALER_LICENCE})` : '';

export function replyAddressFor(leadId) {
  return `lead-${leadId}@${INBOUND_DOMAIN}`;
}

// Step 3 — introduction. No price in the opener: get the conversation started first.
export function draftMessages(lead) {
  const car = carName(lead.vehicle);
  const name = firstName(lead.seller.name);
  const where = lead.location.suburb ? ` in ${lead.location.suburb}` : '';

  const sms = `Hi ${name}, saw your ${car} listed${where}. ${BUSINESS_NAME} is a licensed dealer${licence} and we're keen to buy it - fast payment, we handle the paperwork and pickup. Open to a quick chat? - ${SENDER_NAME}. Reply STOP to opt out`;

  const email = {
    subject: `Your ${car} - interested buyer`,
    body: `Hi ${name},

I came across your ${car} for sale${where} and wanted to reach out directly.

We're ${BUSINESS_NAME}, a licensed motor dealer${licence}. We buy quality late-model vehicles from private sellers and make it simple:

- Fast payment - funds in your account as soon as paperwork is done
- No hassle - no tyre-kickers, test drives with strangers or no-shows
- We handle it all - transfer paperwork, finance payouts and pickup from your door

If you're open to it, reply to this email or call/text me${SENDER_PHONE ? ` on ${SENDER_PHONE}` : ''} and we can talk numbers.

Cheers,
${SENDER_NAME}
${BUSINESS_NAME}${licence}

---
You're receiving this because your vehicle was advertised for sale. Reply "unsubscribe" and we won't contact you again.`,
  };

  return { sms, email, draftedAt: new Date().toISOString() };
}

async function sendSms(to, body) {
  if (!twilioClient) throw new Error('Twilio not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)');
  const msg = { to, body };
  if (TWILIO_MESSAGING_SERVICE_SID) msg.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
  else if (TWILIO_SMS_NUMBER) msg.from = TWILIO_SMS_NUMBER;
  else throw new Error('Set TWILIO_SMS_NUMBER or TWILIO_MESSAGING_SERVICE_SID');
  const res = await twilioClient.messages.create(msg);
  return res.sid;
}

async function sendEmail(lead, to, subject, text) {
  if (!RESEND_API_KEY) throw new Error('Resend not configured (RESEND_API_KEY)');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${SENDER_NAME} - ${BUSINESS_NAME} <${SELLER_FROM_EMAIL}>`,
      to,
      reply_to: replyAddressFor(lead.id),
      subject,
      text,
    }),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.message || `Resend error ${res.status}`);
  return result.id;
}

// Send a message on one channel and log it to the lead's thread.
// 'manual' = the seller only has a Marketplace profile; you paste the text into Messenger yourself.
export async function sendToSeller(lead, channel, { body, subject } = {}) {
  const contact = channel === 'sms' ? lead.seller.phone : channel === 'email' ? lead.seller.email : null;
  if (channel !== 'manual' && !contact) throw new Error(`No ${channel} contact for this seller`);
  if (contact && await isSuppressed(contact)) throw new Error(`${contact} has opted out`);

  let providerId = null;
  if (channel === 'sms') providerId = await sendSms(contact, body);
  if (channel === 'email') providerId = await sendEmail(lead, contact, subject, body);

  lead.thread = lead.thread || [];
  lead.thread.push({ dir: 'out', channel, subject: subject || null, body, at: new Date().toISOString(), providerId });
  return lead;
}

// ── INBOUND ──
const OPT_OUT = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|remove me)\b/i;

export function isOptOut(text) {
  return OPT_OUT.test(text || '');
}

export async function recordReply(lead, channel, body, from) {
  lead.thread = lead.thread || [];
  lead.thread.push({ dir: 'in', channel, body, at: new Date().toISOString(), from });
  lead.unread = true;
  if (isOptOut(body)) {
    await suppress(from, 'opt-out reply');
    lead.optedOut = true;
  }
  return lead;
}

// Step 4 — AI drafts a negotiation reply for you to edit/approve. Never auto-sent.
export async function suggestReply(lead, channel) {
  if (!openai) throw new Error('OPENAI_API_KEY not set');
  const v = lead.vehicle;
  const val = lead.valuation;
  const maxBuy = lead.deal?.maxBuyPrice;

  const context = [
    `Vehicle: ${carName(v)} ${v.variant || ''}, ${v.km?.toLocaleString()} km, condition ${v.condition}`,
    `Seller asking: A$${lead.askingPrice?.toLocaleString()}`,
    val ? `Our market estimate: A$${val.market.toLocaleString()} (${val.method}, ${val.confidence} confidence)` : 'No market estimate',
    maxBuy ? `Our maximum buy price (NEVER reveal this): A$${maxBuy.toLocaleString()}` : '',
    `Listing notes: ${(lead.description || '').slice(0, 600)}`,
  ].filter(Boolean).join('\n');

  const thread = (lead.thread || []).slice(-12).map(m => `${m.dir === 'out' ? 'US' : 'SELLER'} (${m.channel}): ${m.body}`).join('\n\n');

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 400,
    messages: [
      {
        role: 'system',
        content: `You write replies for ${BUSINESS_NAME}, a licensed Australian motor dealer buying a car from a private seller.
Goals: build trust, find out the seller's real bottom line, finance owing, service history, any damage, and move towards an agreed price and a time to inspect.
Rules:
- Friendly, straight-talking Australian tone. ${channel === 'sms' ? 'SMS: under 300 characters.' : 'Email: short, a few lines.'}
- Never invent facts about the car or promise anything we haven't stated.
- Never exceed or reveal our maximum buy price. If no max is given, do not name a figure higher than the asking price.
- Selling points: fast payment, no hassle, we handle transfer paperwork, finance payout and pickup.
- If the seller wants out, politely accept.
Return only the message text.`,
      },
      { role: 'user', content: `${context}\n\nConversation so far:\n${thread || '(none)'}\n\nWrite our next ${channel} message.` },
    ],
  });
  return response.choices[0].message.content.trim();
}
