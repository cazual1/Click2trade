// ── DEALER OUTREACH MODULE ──
// Emails dealers about a vehicle, parses their replies with AI, collects quotes
// Uses Resend for email (free 100 emails/day) + OpenAI for parsing

import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const INBOUND_DOMAIN = process.env.INBOUND_DOMAIN || 'offers.click2trade.com.au'; // Your domain for receiving replies
const FROM_EMAIL = process.env.FROM_EMAIL || 'agent@click2trade.com.au';

// ── DEALER DATABASE ──
// Start with a manually curated list. Later move to Supabase.
// Scrape these from carsales.com.au dealer directory using Apify
const DEALERS = [
  // Sydney
  { id: 'syd-1', name: 'Suttons City Toyota', email: '', city: 'Sydney', postcode: '2000', makes: ['Toyota'], type: 'Dealership' },
  { id: 'syd-2', name: 'Trivett BMW Sydney', email: '', city: 'Sydney', postcode: '2000', makes: ['BMW'], type: 'Dealership' },
  { id: 'syd-3', name: 'Sydney Auto Brokers', email: '', city: 'Sydney', postcode: '2010', makes: ['*'], type: 'Broker' },
  { id: 'syd-4', name: 'Parramatta Auto Centre', email: '', city: 'Parramatta', postcode: '2150', makes: ['*'], type: 'Dealership' },
  { id: 'syd-5', name: 'Castle Hill Motors', email: '', city: 'Castle Hill', postcode: '2154', makes: ['*'], type: 'Dealership' },

  // Melbourne
  { id: 'mel-1', name: 'Melbourne City Toyota', email: '', city: 'Melbourne', postcode: '3000', makes: ['Toyota'], type: 'Dealership' },
  { id: 'mel-2', name: 'Brighton BMW', email: '', city: 'Brighton', postcode: '3186', makes: ['BMW'], type: 'Dealership' },
  { id: 'mel-3', name: 'Cars4Us Melbourne', email: '', city: 'Melbourne', postcode: '3000', makes: ['*'], type: 'Broker' },

  // Brisbane
  { id: 'bri-1', name: 'Toowong Toyota', email: '', city: 'Brisbane', postcode: '4000', makes: ['Toyota'], type: 'Dealership' },
  { id: 'bri-2', name: 'Brisbane Auto Exchange', email: '', city: 'Brisbane', postcode: '4000', makes: ['*'], type: 'Broker' },

  // TODO: Populate with real dealer emails scraped via Apify
  // Run: apify call carsales-dealer-scraper --input='{"location":"Sydney","radius":50}'
];

// ── FIND RELEVANT DEALERS ──
export function findDealers(vehicle, maxResults = 15) {
  const postcode = parseInt(vehicle.postcode) || 2000;
  const make = (vehicle.make || '').toLowerCase();

  return DEALERS
    .filter(d => {
      // Match by make (or wildcard dealers who buy everything)
      const makesMatch = d.makes.includes('*') || d.makes.some(m => m.toLowerCase() === make);
      // Rough postcode proximity (same state)
      const sameRegion = Math.abs(parseInt(d.postcode) - postcode) < 500;
      // Must have email
      const hasEmail = d.email && d.email.length > 0;
      return makesMatch && sameRegion && hasEmail;
    })
    .slice(0, maxResults);
}

// ── GENERATE UNIQUE REPLY-TO ADDRESS ──
// Each outreach gets a unique reply-to so we can match replies to the listing
function generateReplyAddress(listingId, dealerId) {
  return `quote-${listingId}-${dealerId}@${INBOUND_DOMAIN}`;
}

// ── SEND OUTREACH EMAIL TO ONE DEALER ──
async function sendDealerEmail(dealer, vehicle, valuation, listingId) {
  const replyTo = generateReplyAddress(listingId, dealer.id);

  const subject = `Vehicle Available: ${vehicle.year} ${vehicle.make} ${vehicle.model} – ${(parseInt(vehicle.km) || 0).toLocaleString()} km`;

  const body = `Hi ${dealer.name.split(' ')[0]},

We have a seller looking to move their vehicle quickly. Details below:

🚗 Vehicle: ${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''}
${vehicle.trim ? `Trim: ${vehicle.trim}` : ''}
📏 Odometer: ${(parseInt(vehicle.km) || 0).toLocaleString()} km
✅ Condition: ${vehicle.condition || 'Good'}
📍 Location: ${vehicle.postcode || 'Sydney'}

Market estimate: A$${valuation.low.toLocaleString()} – A$${valuation.high.toLocaleString()}

If you're interested in acquiring this vehicle, simply reply to this email with your best offer (AUD).

Just reply with a number like "$38,000" or "we'd offer $37,500 subject to inspection" — whatever works for you.

The seller will receive all offers and can choose to accept. No obligation on either side.

Regards,
Click2Trade AI Agent
click2trade.com.au

---
Ref: ${listingId}
To stop receiving vehicle alerts, reply STOP.`;

  // Send via Resend API
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `Click2Trade Agent <${FROM_EMAIL}>`,
      to: dealer.email,
      reply_to: replyTo,
      subject,
      text: body,
    }),
  });

  const result = await res.json();
  return { dealer, emailId: result.id, replyTo, sentAt: new Date().toISOString() };
}

// ── SEND TO ALL MATCHING DEALERS ──
export async function sendDealerOutreach(vehicle, valuation, listingId) {
  const dealers = findDealers(vehicle);

  if (dealers.length === 0) {
    console.log('No matching dealers found for', vehicle);
    return { sent: 0, dealers: [] };
  }

  const results = [];
  for (const dealer of dealers) {
    try {
      const result = await sendDealerEmail(dealer, vehicle, valuation, listingId);
      results.push(result);
      // Small delay between emails to avoid rate limits
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error(`Failed to email ${dealer.name}:`, err.message);
    }
  }

  console.log(`Sent ${results.length} outreach emails for listing ${listingId}`);
  return { sent: results.length, dealers: results };
}

// ── PARSE DEALER REPLY WITH AI ──
// When a dealer replies to the email, we use AI to extract the offer amount
export async function parseDealerReply(emailBody, dealerName) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 200,
    messages: [
      {
        role: 'system',
        content: `You parse dealer email replies to extract vehicle purchase offers.
Return ONLY a JSON object with these fields:
- "hasOffer": boolean (true if they made a price offer)
- "amount": number or null (the dollar amount they offered, no currency symbol, just the number)
- "conditional": boolean (true if offer is subject to inspection or other conditions)
- "conditions": string or null (any conditions mentioned)
- "declined": boolean (true if they explicitly said no/not interested)
- "notes": string (any other relevant info, keep brief)

Examples:
- "We'd offer $38,000" → {"hasOffer":true,"amount":38000,"conditional":false,"conditions":null,"declined":false,"notes":""}
- "We can do $35k subject to inspection" → {"hasOffer":true,"amount":35000,"conditional":true,"conditions":"Subject to inspection","declined":false,"notes":""}
- "Not interested at this time" → {"hasOffer":false,"amount":null,"conditional":false,"conditions":null,"declined":true,"notes":""}
- "Can you send photos?" → {"hasOffer":false,"amount":null,"conditional":false,"conditions":null,"declined":false,"notes":"Requesting photos"}

Return ONLY the JSON, no other text.`
      },
      {
        role: 'user',
        content: `Dealer: ${dealerName}\n\nEmail reply:\n${emailBody}`
      }
    ],
  });

  try {
    const text = response.choices[0].message.content.replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (err) {
    console.error('Failed to parse dealer reply:', err);
    return { hasOffer: false, amount: null, conditional: false, conditions: null, declined: false, notes: 'Failed to parse reply' };
  }
}

// ── INBOUND EMAIL WEBHOOK ──
// This handles incoming dealer replies. Configure your email provider
// (Resend, SendGrid, Mailgun) to POST incoming emails to /inbound-email
export function createInboundHandler(sessions, sendWhatsAppMessage) {
  return async function handleInboundEmail(req, res) {
    try {
      const { from, to, subject, text, html } = req.body;

      // Extract listing ID and dealer ID from the reply-to address
      // Format: quote-{listingId}-{dealerId}@offers.click2trade.com.au
      const toAddress = Array.isArray(to) ? to[0] : to;
      const match = (toAddress || '').match(/quote-([^-]+)-([^@]+)@/);

      if (!match) {
        console.log('Inbound email not matching quote format:', toAddress);
        return res.sendStatus(200);
      }

      const listingId = match[1];
      const dealerId = match[2];

      // Find the session for this listing
      let session = null;
      for (const [phone, s] of sessions) {
        if (s.listingId === listingId) {
          session = s;
          break;
        }
      }

      if (!session) {
        console.log('No session found for listing:', listingId);
        return res.sendStatus(200);
      }

      // Find dealer info
      const dealer = DEALERS.find(d => d.id === dealerId);
      const dealerName = dealer ? dealer.name : from;

      // Parse the reply with AI
      const emailContent = text || (html ? html.replace(/<[^>]*>/g, '') : '');
      const parsed = await parseDealerReply(emailContent, dealerName);

      console.log(`Dealer reply from ${dealerName}:`, parsed);

      if (parsed.hasOffer && parsed.amount) {
        // Add to session quotes
        const quote = {
          id: session.quotes.length + 1,
          dealer: dealerName,
          type: dealer?.type || 'Dealer',
          offer: parsed.amount,
          conditional: parsed.conditional,
          conditions: parsed.conditions,
          time: 'just now',
          rating: 4.5,
          dealerId,
        };

        session.quotes.push(quote);
        session.quotes.sort((a, b) => b.offer - a.offer);

        // Notify the seller via WhatsApp
        const quoteCount = session.quotes.length;
        const best = session.quotes[0];

        let msg = `💰 *New offer received!*\n\n`;
        msg += `*${dealerName}* offered *A$${parsed.amount.toLocaleString()}*`;
        if (parsed.conditional) msg += ` _(${parsed.conditions})_`;
        msg += `\n\n`;
        msg += `You now have *${quoteCount} offer${quoteCount > 1 ? 's' : ''}*. `;
        msg += `Best so far: *A$${best.offer.toLocaleString()}*\n\n`;

        if (quoteCount >= 3) {
          msg += `Want me to show all offers? Reply *SHOW OFFERS*\n`;
          msg += `Want me to negotiate for better prices? Reply *NEGOTIATE*`;
        } else {
          msg += `Still waiting on more dealers to respond. I'll message you as each offer comes in.`;
        }

        await sendWhatsAppMessage(session.phone, msg);
      } else if (parsed.declined) {
        // Dealer declined - don't notify seller, just log
        console.log(`${dealerName} declined for listing ${listingId}`);
      } else if (parsed.notes) {
        // Dealer asked a question - for now just log, later auto-reply
        console.log(`${dealerName} asked: ${parsed.notes}`);
        // TODO: Auto-reply with more info or photos
      }

      res.sendStatus(200);
    } catch (err) {
      console.error('Inbound email error:', err);
      res.sendStatus(200);
    }
  };
}
