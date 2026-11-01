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
  TWILIO_WHATSAPP_NUMBER,        // e.g. "whatsapp:+61..." — same number the WhatsApp bot uses
  // WhatsApp only lets a business message someone first with a Meta-approved template.
  // Create them in Twilio Content Template Builder; variables: {{1}} first name, {{2}} car, {{3}} business name.
  TWILIO_WA_INTRO_CONTENT_SID,
  TWILIO_WA_FOLLOWUP_CONTENT_SID,
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

async function sendWhatsApp(to, body, template) {
  if (!twilioClient || !TWILIO_WHATSAPP_NUMBER) throw new Error('WhatsApp not configured (TWILIO_WHATSAPP_NUMBER)');
  const from = TWILIO_WHATSAPP_NUMBER.startsWith('whatsapp:') ? TWILIO_WHATSAPP_NUMBER : 'whatsapp:' + TWILIO_WHATSAPP_NUMBER;
  const msg = { from, to: 'whatsapp:' + to };
  // Without an approved template, only works inside a 24h window the seller opened (or the Twilio sandbox)
  if (template?.sid) Object.assign(msg, { contentSid: template.sid, contentVariables: JSON.stringify(template.vars) });
  else msg.body = body;
  const res = await twilioClient.messages.create(msg);
  return res.sid;
}

// Which channels can actually send right now
export function channelsAvailable() {
  return {
    sms: !!(twilioClient && (TWILIO_SMS_NUMBER || TWILIO_MESSAGING_SERVICE_SID)),
    email: !!RESEND_API_KEY,
    whatsapp: !!(twilioClient && TWILIO_WHATSAPP_NUMBER),
    whatsappTemplates: !!TWILIO_WA_INTRO_CONTENT_SID,
  };
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
export async function sendToSeller(lead, channel, { body, subject, template } = {}) {
  const contact = { sms: lead.seller.phone, email: lead.seller.email, whatsapp: lead.seller.whatsapp }[channel] || null;
  if (channel !== 'manual' && !contact) throw new Error(`No ${channel} contact for this seller`);
  if (contact && await isSuppressed(contact)) throw new Error(`${contact} has opted out`);

  let providerId = null;
  if (channel === 'sms') providerId = await sendSms(contact, body);
  if (channel === 'email') providerId = await sendEmail(lead, contact, subject, body);
  if (channel === 'whatsapp') providerId = await sendWhatsApp(contact, body, template);

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

// ── AI-PERSONALISED INTRO ──
// The AI only writes the friendly opening about this particular car. Who we are, the dealer licence
// and the opt-out are added here, so they're always present whatever the model writes.
export async function aiIntro(lead) {
  const base = draftMessages(lead);
  if (!openai) return base;
  const v = lead.vehicle;
  const name = firstName(lead.seller.name);
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 300,
      temperature: 0.6,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You write the opening of a first message from ${BUSINESS_NAME}, a licensed Australian car dealer, to a private seller whose car is advertised.
Mention one or two genuine details from their listing so it doesn't read like a template. Friendly, straight-talking, Australian. Say we'd like to buy it and can pay fast and handle paperwork and pickup.
NEVER mention a price, offer or valuation. Never invent facts. No greeting line, no sign-off — those are added separately.
Return JSON: {"sms": "max 200 characters", "email_subject": "short", "email": "2-4 short sentences"}`,
        },
        {
          role: 'user',
          content: [`${v.year} ${v.make} ${v.model} ${v.variant || ''}`.trim(), v.km ? `${v.km.toLocaleString()} km` : '', lead.location?.suburb || '',
            `Listing: ${(lead.title || '')} ${(lead.description || '').slice(0, 800)}`].filter(Boolean).join('\n'),
        },
      ],
    });
    const out = JSON.parse(response.choices[0].message.content);
    const ok = t => typeof t === 'string' && t.trim().length > 20 && !/\$\s?\d|\d+\s?k\b|offer you|valued at/i.test(t);
    if (!ok(out.sms) || !ok(out.email)) return base;
    return {
      sms: `Hi ${name}, ${out.sms.trim().replace(/^hi[^,]*,\s*/i, '')} - ${SENDER_NAME}, ${BUSINESS_NAME}${licence}. Reply STOP to opt out`,
      email: {
        subject: String(out.email_subject || base.email.subject).slice(0, 90),
        body: `Hi ${name},

${out.email.trim()}

If you're open to it, reply to this email or call/text me${SENDER_PHONE ? ` on ${SENDER_PHONE}` : ''} and we can talk numbers.

Cheers,
${SENDER_NAME}
${BUSINESS_NAME}${licence}

---
You're receiving this because your vehicle was advertised for sale. Reply "unsubscribe" and we won't contact you again.`,
      },
      draftedAt: new Date().toISOString(),
      ai: true,
    };
  } catch (err) {
    console.error('AI intro failed, using template:', err.message);
    return base;
  }
}

export function introTemplate(lead) {
  return TWILIO_WA_INTRO_CONTENT_SID ? { sid: TWILIO_WA_INTRO_CONTENT_SID, vars: { 1: firstName(lead.seller.name), 2: carName(lead.vehicle), 3: BUSINESS_NAME } } : null;
}

// One polite nudge when the seller hasn't replied
export function followUpMessages(lead) {
  const car = carName(lead.vehicle), name = firstName(lead.seller.name);
  return {
    sms: `Hi ${name}, just following up on your ${car} - we're still keen and can move quickly (fast payment, paperwork and pickup handled). Happy to chat? - ${SENDER_NAME}, ${BUSINESS_NAME}. Reply STOP to opt out`,
    email: {
      subject: `Re: ${lead.drafts?.email?.subject || `Your ${car}`}`,
      body: `Hi ${name},

Just following up on your ${car}. We're still keen to buy it and can move quickly: fast payment, and we take care of the paperwork, any finance payout and pickup.

Happy to have a quick chat whenever suits.

Cheers,
${SENDER_NAME}
${BUSINESS_NAME}${licence}

---
Reply "unsubscribe" and we won't contact you again.`,
    },
    template: TWILIO_WA_FOLLOWUP_CONTENT_SID ? { sid: TWILIO_WA_FOLLOWUP_CONTENT_SID, vars: { 1: name, 2: car, 3: BUSINESS_NAME } } : null,
  };
}
