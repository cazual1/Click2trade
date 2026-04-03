// Click2Trade WhatsApp Bot
// Stack: Node.js + Express + Twilio WhatsApp API + OpenAI API + Supabase
// Deploy: Railway, Render, or Supabase Edge Functions

import express from 'express';
import OpenAI from 'openai';
import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ── CONFIG ──
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_NUMBER, // e.g. "whatsapp:+14155238886"
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  AUTOGRAB_API_KEY, // Optional: for real valuations
} = process.env;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

// ── CONVERSATION STATE ──
// In production, this lives in Supabase. In-memory for dev.
const sessions = new Map();

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      phone,
      step: 'welcome', // welcome → collecting → valuation → searching → quotes → negotiating → done
      vehicle: {},
      messages: [],
      quotes: [],
      finalOffers: [],
      createdAt: new Date().toISOString(),
    });
  }
  return sessions.get(phone);
}

// ── SYSTEM PROMPT ──
const SYSTEM_PROMPT = `You are Click2Trade's WhatsApp assistant — a friendly, concise AI that helps Australians sell their cars for the best price.

Your job is to collect vehicle details through natural conversation, provide an AI valuation, then coordinate dealer outreach and negotiation.

PERSONALITY:
- Aussie-friendly but professional. Not overly formal.
- Keep messages SHORT — this is WhatsApp, not email. 2-3 sentences max per message.
- Use line breaks for readability. No walls of text.
- Emoji sparingly and naturally (✅, 🚗, 💰) — don't overdo it.

FLOW:
1. WELCOME: Greet them, explain what Click2Trade does in one sentence, ask what car they want to sell.
2. COLLECTING: Gather these details one or two at a time (don't dump all questions at once):
   - Year
   - Make
   - Model
   - Variant/trim (if they know it)
   - Kilometres on the odometer
   - Condition (Excellent / Good / Fair / Below Average)
   - Postcode
   If they give multiple details at once, acknowledge all of them and ask for what's missing.
3. VALUATION: Once you have enough info, confirm the details back to them and provide the valuation.
4. SEARCHING: Ask if they want you to find buyers. If yes, tell them the AI agent is contacting dealers.
5. QUOTES: Present quotes as they come in (we'll inject these).
6. NEGOTIATING: Ask if they want the AI to negotiate. Explain it uses competing offers as leverage.
7. DONE: Present final offers, let them accept.

IMPORTANT RULES:
- If someone asks about pricing/fees: "Click2Trade is free for sellers. We only charge the dealer a small fee when a sale goes through."
- If they ask how it works: Give the 4-step summary (enter details → AI valuation → dealers compete → AI negotiates).
- If they want to start over: Reset and begin fresh.
- Always confirm details before generating a valuation.
- Use AUD currency (A$) and kilometres.
- Be honest — this is a real service, not a gimmick.

You must respond ONLY with the message to send to the user. No explanations, no metadata, no JSON. Just the WhatsApp message text.

When you have collected ALL required vehicle details (year, make, model, km, condition, postcode), end your confirmation message with the exact tag: [READY_FOR_VALUATION]

When the user confirms they want to find buyers, end your message with: [START_SEARCH]

When the user wants to negotiate, end your message with: [START_NEGOTIATION]`;

// ── CLAUDE CONVERSATION ──
async function chat(session, userMessage) {
  session.messages.push({ role: 'user', content: userMessage });

  // Add context about current state
  let contextNote = '';
  if (session.step === 'valuation' && session.valuation) {
    contextNote = `\n\n[CONTEXT: Vehicle valuation completed. Details: ${JSON.stringify(session.vehicle)}. Valuation: Low A$${session.valuation.low.toLocaleString()}, Market A$${session.valuation.mid.toLocaleString()}, High A$${session.valuation.high.toLocaleString()}]`;
  }
  if (session.step === 'quotes' && session.quotes.length > 0) {
    contextNote = `\n\n[CONTEXT: ${session.quotes.length} dealer quotes received. Highest: A$${Math.max(...session.quotes.map(q => q.offer)).toLocaleString()}. Quotes: ${JSON.stringify(session.quotes)}]`;
  }
  if (session.step === 'done' && session.finalOffers.length > 0) {
    contextNote = `\n\n[CONTEXT: Negotiation complete. Final offers: ${JSON.stringify(session.finalOffers)}. Best offer: A$${session.finalOffers[0].offer.toLocaleString()} from ${session.finalOffers[0].dealer}]`;
  }

  const messagesForLLM = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...session.messages.slice(-20),
  ];
  if (contextNote) {
    messagesForLLM[messagesForLLM.length - 1] = {
      role: 'user',
      content: userMessage + contextNote,
    };
  }

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 500,
    messages: messagesForLLM,
  });

  const reply = response.choices[0].message.content;
  session.messages.push({ role: 'assistant', content: reply });

  return reply;
}

// ── VALUATION (mock — replace with AutoGrab API) ──
function generateValuation(vehicle) {
  // TODO: Replace with AutoGrab API call
  // POST https://api.autograb.com.au/v2/valuations/predict
  // { "region": "au", "vehicle_id": "{ID}", "kms": vehicle.km, "condition_score": conditionMap[vehicle.condition] }
  const base = 25000 + Math.random() * 30000;
  const kmPenalty = (parseInt(vehicle.km) || 50000) * 0.025;
  const condMultiplier =
    vehicle.condition === 'Excellent' ? 1.15 :
    vehicle.condition === 'Good' ? 1.0 :
    vehicle.condition === 'Fair' ? 0.85 : 0.7;
  const mid = Math.round((base - kmPenalty) * condMultiplier);
  return {
    low: Math.round(mid * 0.88),
    mid,
    high: Math.round(mid * 1.14),
  };
}

// ── MOCK DEALER QUOTES (replace with real outreach) ──
function generateMockQuotes(vehicle, valuation) {
  const dealers = [
    { dealer: 'Sydney City Toyota', type: 'Dealership', distance: '3.2 km', rating: 4.8 },
    { dealer: 'Parramatta Auto Group', type: 'Dealership', distance: '8.5 km', rating: 4.5 },
    { dealer: 'Eastern Suburbs Motors', type: 'Broker', distance: '5.1 km', rating: 4.9 },
    { dealer: 'CarsGuide Direct', type: 'Broker', distance: '12.3 km', rating: 4.3 },
    { dealer: 'Prestige Auto Brokers', type: 'Broker', distance: '6.7 km', rating: 4.7 },
    { dealer: 'North Shore Automotive', type: 'Dealership', distance: '11.4 km', rating: 4.6 },
  ];
  return dealers.map(d => ({
    ...d,
    offer: Math.round(valuation.mid * (0.85 + Math.random() * 0.2)),
  })).sort((a, b) => b.offer - a.offer);
}

function generateNegotiatedOffers(quotes) {
  return quotes.map(q => ({
    ...q,
    originalOffer: q.offer,
    offer: Math.round(q.offer * (1.03 + Math.random() * 0.05)),
  })).sort((a, b) => b.offer - a.offer);
}

// ── SEND WHATSAPP MESSAGE ──
async function sendMessage(to, body) {
  // Split long messages (WhatsApp limit is 4096 chars but shorter is better)
  const chunks = body.match(/[\s\S]{1,1500}/g) || [body];
  for (const chunk of chunks) {
    await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to,
      body: chunk.trim(),
    });
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
  }
}

// ── PROCESS TRIGGERS IN AI RESPONSE ──
async function processResponse(session, reply, from) {
  let cleanReply = reply;

  // Handle valuation trigger
  if (reply.includes('[READY_FOR_VALUATION]')) {
    cleanReply = reply.replace('[READY_FOR_VALUATION]', '').trim();
    await sendMessage(from, cleanReply);

    // Generate valuation
    session.valuation = generateValuation(session.vehicle);
    session.step = 'valuation';

    const valMsg = `💰 *AI Valuation Result*

🚗 ${session.vehicle.year || ''} ${session.vehicle.make || ''} ${session.vehicle.model || ''}
📍 ${session.vehicle.postcode || 'AU'} · ${(parseInt(session.vehicle.km) || 0).toLocaleString()} km · ${session.vehicle.condition || 'Good'}

*Estimated Market Value: A$${session.valuation.mid.toLocaleString()}*

Low: A$${session.valuation.low.toLocaleString()}
High: A$${session.valuation.high.toLocaleString()}

_Based on current Australian market data_

Would you like me to find buyers in your area? Our AI agent will contact 10-15 dealers and get real quotes. 🔍`;

    await new Promise(r => setTimeout(r, 1500));
    await sendMessage(from, valMsg);
    return;
  }

  // Handle search trigger
  if (reply.includes('[START_SEARCH]')) {
    cleanReply = reply.replace('[START_SEARCH]', '').trim();
    await sendMessage(from, cleanReply);
    session.step = 'searching';

    // Simulate progressive dealer outreach
    await new Promise(r => setTimeout(r, 2000));
    await sendMessage(from, '🔍 *AI Agent Active*\n\nContacting dealers and brokers near ' + (session.vehicle.postcode || 'you') + '...');

    await new Promise(r => setTimeout(r, 3000));
    await sendMessage(from, '✅ 12 dealers contacted\n⏳ Waiting for offers...');

    await new Promise(r => setTimeout(r, 4000));

    // Generate quotes
    session.quotes = generateMockQuotes(session.vehicle, session.valuation);
    session.step = 'quotes';

    const best = session.quotes[0];
    const worst = session.quotes[session.quotes.length - 1];

    let quotesMsg = `🏆 *${session.quotes.length} Offers Received!*\n\n`;
    session.quotes.forEach((q, i) => {
      const badge = i === 0 ? ' ⭐ HIGHEST' : '';
      quotesMsg += `${i + 1}. *${q.dealer}*${badge}\n   ${q.type} · ${q.distance} · ★${q.rating}\n   *A$${q.offer.toLocaleString()}*\n\n`;
    });
    quotesMsg += `Best: A$${best.offer.toLocaleString()} | Lowest: A$${worst.offer.toLocaleString()}\n\n`;
    quotesMsg += `Want me to *negotiate all offers* to get you an even better deal? Reply YES and our AI will use competing bids as leverage. 🤖`;

    await sendMessage(from, quotesMsg);
    return;
  }

  // Handle negotiation trigger
  if (reply.includes('[START_NEGOTIATION]')) {
    cleanReply = reply.replace('[START_NEGOTIATION]', '').trim();
    await sendMessage(from, cleanReply);
    session.step = 'negotiating';

    await new Promise(r => setTimeout(r, 2000));
    await sendMessage(from, '🤖 *AI Negotiation Started*\n\n1️⃣ Analysing market leverage...');

    await new Promise(r => setTimeout(r, 3000));
    await sendMessage(from, '2️⃣ Sending counter-offers to all 6 dealers...');

    await new Promise(r => setTimeout(r, 3000));
    await sendMessage(from, '3️⃣ 4 dealers improved their price ✅');

    await new Promise(r => setTimeout(r, 2000));
    await sendMessage(from, '4️⃣ Pushing for final numbers...');

    await new Promise(r => setTimeout(r, 3000));

    // Generate final offers
    session.finalOffers = generateNegotiatedOffers(session.quotes);
    session.step = 'done';

    const best = session.finalOffers[0];
    const gain = best.offer - best.originalOffer;

    let finalMsg = `✅ *Negotiation Complete!*\n\nBest offer improved by *A$${gain.toLocaleString()}*\n\n`;
    session.finalOffers.slice(0, 3).forEach((q, i) => {
      const diff = q.offer - q.originalOffer;
      const badge = i === 0 ? ' 🏆 BEST' : '';
      finalMsg += `${i + 1}. *${q.dealer}*${badge}\n   *A$${q.offer.toLocaleString()}* _(was A$${q.originalOffer.toLocaleString()}, +A$${diff.toLocaleString()})_\n\n`;
    });
    finalMsg += `To accept an offer, reply with the number (1, 2, or 3).\n\nYour details remain private until you accept.`;

    await sendMessage(from, finalMsg);
    return;
  }

  // Default: just send the reply
  await sendMessage(from, cleanReply);
}

// ── EXTRACT VEHICLE INFO FROM CONVERSATION ──
function extractVehicleInfo(session, message) {
  const msg = message.toLowerCase();
  const v = session.vehicle;

  // Year
  const yearMatch = message.match(/\b(20[0-2]\d|19[89]\d)\b/);
  if (yearMatch) v.year = yearMatch[1];

  // Kilometres
  const kmMatch = message.match(/(\d[\d,]*)\s*(?:km|kms|kilometres|kilometers|k's)/i);
  if (kmMatch) v.km = kmMatch[1].replace(/,/g, '');
  // Also catch standalone large numbers likely to be km
  if (!v.km) {
    const numMatch = message.match(/(\d{4,6})/);
    if (numMatch && parseInt(numMatch[1]) > 1000 && parseInt(numMatch[1]) < 500000) {
      // Only set if we're in collecting mode and it looks like km
      if (session.step === 'collecting') v.km = numMatch[1];
    }
  }

  // Postcode
  const pcMatch = message.match(/\b(\d{4})\b/);
  if (pcMatch && parseInt(pcMatch[1]) >= 2000 && parseInt(pcMatch[1]) <= 7999) {
    if (!v.year || pcMatch[1] !== v.year) v.postcode = pcMatch[1];
  }

  // Condition
  if (msg.includes('excellent')) v.condition = 'Excellent';
  else if (msg.includes('good')) v.condition = 'Good';
  else if (msg.includes('fair')) v.condition = 'Fair';
  else if (msg.includes('below average') || msg.includes('poor') || msg.includes('rough')) v.condition = 'Below Average';

  // Common makes
  const makes = ['toyota','ford','mazda','hyundai','kia','mitsubishi','isuzu','mg','byd','gwm','tesla','nissan','subaru','volkswagen','vw','honda','bmw','mercedes','audi','chery','suzuki','lexus','porsche'];
  for (const make of makes) {
    if (msg.includes(make)) {
      v.make = make === 'vw' ? 'Volkswagen' : make === 'mercedes' ? 'Mercedes-Benz' : make.charAt(0).toUpperCase() + make.slice(1);
      break;
    }
  }

  // Common models (simplified — expand as needed)
  const models = ['hilux','rav4','ranger','cx-5','cx5','camry','corolla','tucson','sportage','i30','model 3','model y','model s','civic','crv','cr-v','forester','outback','x-trail','golf','tiguan','d-max','dmax','mx-5','bt-50','landcruiser','land cruiser','prado','kona','seltos','cerato','carnival','triton','outlander','everest','mustang','atto 3','seal','dolphin'];
  for (const model of models) {
    if (msg.includes(model)) {
      // Normalize model name
      const modelMap = {
        'hilux': 'HiLux', 'rav4': 'RAV4', 'cx-5': 'CX-5', 'cx5': 'CX-5',
        'i30': 'i30', 'model 3': 'Model 3', 'model y': 'Model Y', 'model s': 'Model S',
        'crv': 'CR-V', 'cr-v': 'CR-V', 'x-trail': 'X-Trail', 'd-max': 'D-Max', 'dmax': 'D-Max',
        'mx-5': 'MX-5', 'bt-50': 'BT-50', 'landcruiser': 'LandCruiser', 'land cruiser': 'LandCruiser',
        'atto 3': 'Atto 3',
      };
      v.model = modelMap[model] || model.charAt(0).toUpperCase() + model.slice(1);
      break;
    }
  }

  if (session.step === 'welcome' && (v.make || v.model || v.year)) {
    session.step = 'collecting';
  }
}

// ── WEBHOOK: INCOMING WHATSAPP MESSAGES ──
app.post('/webhook', async (req, res) => {
  try {
    const from = req.body.From; // "whatsapp:+61..."
    const body = (req.body.Body || '').trim();

    if (!from || !body) return res.sendStatus(200);

    const session = getSession(from);

    // Extract vehicle info from the message
    extractVehicleInfo(session, body);

    // Handle offer acceptance
    if (session.step === 'done' && /^[1-3]$/.test(body)) {
      const idx = parseInt(body) - 1;
      const offer = session.finalOffers[idx];
      if (offer) {
        await sendMessage(from, `🎉 *Offer Accepted!*\n\nYou've accepted *A$${offer.offer.toLocaleString()}* from *${offer.dealer}*.\n\nWe'll now connect you with the dealer to arrange:\n✅ Free vehicle pickup\n✅ Payment (usually within 24-48 hours)\n✅ Transfer paperwork\n\nA Click2Trade team member will be in touch shortly. Congratulations! 🚗💰`);
        session.step = 'accepted';

        // TODO: Save to Supabase, notify dealer, trigger email
        // await supabase.from('deals').insert({ ... });

        return res.sendStatus(200);
      }
    }

    // Handle reset
    if (['start over', 'reset', 'new car', 'restart'].includes(body.toLowerCase())) {
      sessions.delete(from);
      const fresh = getSession(from);
      const reply = await chat(fresh, 'Hi, I want to sell my car');
      await processResponse(fresh, reply, from);
      return res.sendStatus(200);
    }

    // Normal conversation
    const reply = await chat(session, body);
    await processResponse(session, reply, from);

    // Save session to Supabase (in production)
    // await supabase.from('whatsapp_sessions').upsert({ phone: from, ...session });

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(200); // Always return 200 to Twilio
  }
});

// ── HEALTH CHECK ──
app.get('/', (req, res) => {
  res.json({
    service: 'Click2Trade WhatsApp Bot',
    status: 'running',
    sessions: sessions.size,
    uptime: process.uptime(),
  });
});

// ── START ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Click2Trade WhatsApp bot running on port ${PORT}`);
  console.log(`Webhook URL: https://your-domain.com/webhook`);
  console.log(`Configure this URL in Twilio Console → Messaging → WhatsApp Sandbox`);
});
