// ── ACQUISITION API ──
// Daily listing feed in → valued, filtered leads → approval queue → outreach → deal pipeline.
//
//   POST /api/listings/ingest     (INGEST_API_KEY)  scraping agent drops the day's listings
//   GET  /api/leads               (ADMIN_TOKEN)     dashboard data
//   ...                                             see routes below
//   POST /api/leads/:id/start     (ADMIN_TOKEN)     you enter a seller's mobile/WhatsApp/email → intro goes out
//   POST /sms-inbound                               Twilio SMS webhook (seller replies)
//   /admin                                          approval + pipeline dashboard

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseListing, checkCriteria, CRITERIA, normalisePhone, normaliseEmail } from './listings.mjs';
import { valueListing, discountFor } from './valuation.mjs';
import { STAGES, documentChecklist, alerts, checkStageMove, moveStage } from './pipeline.mjs';
import { draftMessages, sendToSeller, recordReply, suggestReply, isOptOut, aiIntro, introTemplate, followUpMessages, channelsAvailable } from './seller-outreach.mjs';
import { getLead, listLeads, saveLead, findLeadByContact, isSuppressed } from './store.mjs';

const { INGEST_API_KEY, ADMIN_TOKEN, DISPLAY_TZ = 'Australia/Sydney' } = process.env;
const FOLLOWUP_HOURS = Number(process.env.FOLLOWUP_HOURS || 48);
const MAX_FOLLOWUPS = Number(process.env.MAX_FOLLOWUPS ?? 1);

// Only nudge sellers at a reasonable time: 9am–7pm, Monday to Saturday, local time
function businessHours(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: DISPLAY_TZ, hour: 'numeric', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(now).map(p => [p.type, p.value]));
  const h = Number(parts.hour);
  return parts.weekday !== 'Sun' && h >= 9 && h < 19;
}

function scheduleFollowUp(lead, channels) {
  lead.followUp = MAX_FOLLOWUPS > 0 && channels.length ? { due: new Date(Date.now() + FOLLOWUP_HOURS * 3600000).toISOString(), channels, sent: 0 } : null;
}

// Send the follow-up to sellers who went quiet after the intro
async function sweepFollowUps() {
  if (!businessHours()) return;
  const now = Date.now();
  for (const lead of await listLeads()) {
    const f = lead.followUp;
    if (lead.stage !== 'contacted' || !f?.due || new Date(f.due).getTime() > now || f.sent >= MAX_FOLLOWUPS) continue;
    const msg = followUpMessages(lead);
    const sent = [];
    for (const ch of f.channels) {
      try {
        if (ch === 'email') await sendToSeller(lead, 'email', { subject: msg.email.subject, body: msg.email.body });
        else await sendToSeller(lead, ch, { body: msg.sms, template: ch === 'whatsapp' ? msg.template : null });
        sent.push(ch);
      } catch (err) {
        console.error(`Follow-up ${ch} failed for ${lead.id}:`, err.message);
      }
    }
    f.sent++;
    f.due = f.sent < MAX_FOLLOWUPS ? new Date(now + 3 * 86400000).toISOString() : null;
    lead.history = lead.history || [];
    if (sent.length) lead.history.push({ at: new Date().toISOString(), from: lead.stage, to: lead.stage, note: `Follow-up sent via ${sent.join(', ')}` });
    await saveLead(lead);
  }
}
const here = path.dirname(fileURLToPath(import.meta.url));

// Stages where a fresh price from the feed should re-run qualification
const PRE_CONTACT = ['new', 'needs_valuation', 'draft', 'rejected'];

function requireToken(expected, name) {
  return (req, res, next) => {
    if (!expected) return res.status(503).json({ error: `${name} not configured on the server` });
    const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (token !== expected) return res.status(401).json({ error: 'Unauthorised' });
    next();
  };
}

// Decide where a not-yet-contacted lead belongs, based on criteria + valuation
async function qualify(lead, pool) {
  const check = checkCriteria(lead);
  lead.criteria = check;
  if (!check.pass) {
    lead.stage = 'rejected';
    lead.rejectReason = check.reasons.join('; ');
    return lead;
  }

  // Keep a manual valuation if one was entered
  if (lead.valuation?.method !== 'manual') {
    const { valuation } = await valueListing(lead, pool);
    lead.valuation = valuation;
  }
  lead.discountPct = discountFor(lead.askingPrice, lead.valuation?.market);

  if (!lead.valuation) {
    lead.stage = 'needs_valuation';
  } else if (lead.discountPct < CRITERIA.minDiscountPct) {
    lead.stage = 'rejected';
    lead.rejectReason = `Not far enough below market (${lead.discountPct}% vs ${CRITERIA.minDiscountPct}% needed)`;
  } else if (!lead.seller.phone && !lead.seller.email && !lead.seller.profileUrl && !lead.url) {
    lead.stage = 'rejected';
    lead.rejectReason = 'No way to contact seller';
  } else {
    lead.stage = 'draft';
    lead.rejectReason = null;
    lead.drafts = lead.drafts || draftMessages(lead);
  }
  return lead;
}

// What the dashboard needs per lead
export function view(lead) {
  return { ...lead, checklist: documentChecklist(lead), alerts: alerts(lead) };
}

export function createAcquisitionRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '20mb' }));

  // ── INGEST ──
  router.post('/api/listings/ingest', requireToken(INGEST_API_KEY, 'INGEST_API_KEY'), async (req, res) => {
    try {
      const payload = req.body;
      const items = Array.isArray(payload) ? payload : payload.listings;
      if (!Array.isArray(items)) return res.status(400).json({ error: 'Expected an array of listings or { listings: [...] }' });
      const source = payload.source || 'facebook_marketplace';
      const summary = await ingest(items, source);
      res.json(summary);
    } catch (err) {
      console.error('Ingest error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── DASHBOARD API ──
  const admin = requireToken(ADMIN_TOKEN, 'ADMIN_TOKEN');

  router.get('/api/meta', admin, (req, res) => res.json({ stages: STAGES, criteria: CRITERIA, channels: channelsAvailable(), followUpHours: FOLLOWUP_HOURS }));

  // You've got the seller's mobile, WhatsApp or email (e.g. from a Marketplace chat): save it and send the intro.
  // Only channels that haven't had an intro yet are used, so re-running this after adding an email won't double-text them.
  router.post('/api/leads/:id/start', admin, async (req, res) => {
    const lead = await getLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Not found' });
    if (lead.stage === 'opted_out' || lead.optedOut) return res.status(409).json({ error: 'This seller has opted out' });

    const b = req.body || {};
    const phone = b.phone ? normalisePhone(b.phone) : lead.seller.phone;
    const whatsapp = b.whatsapp ? normalisePhone(b.whatsapp) : lead.seller.whatsapp;
    const email = b.email ? normaliseEmail(b.email) : lead.seller.email;
    if (b.phone && !phone) return res.status(400).json({ error: 'That mobile number doesn’t look right' });
    if (b.whatsapp && !whatsapp) return res.status(400).json({ error: 'That WhatsApp number doesn’t look right — include the country code if it isn’t Australian' });
    if (b.email && !email) return res.status(400).json({ error: 'That email address doesn’t look right' });
    lead.seller = { ...lead.seller, phone: phone || null, whatsapp: whatsapp || null, email: email || null };

    const avail = channelsAvailable();
    const already = new Set((lead.thread || []).filter(m => m.dir === 'out').map(m => m.channel));
    const want = [whatsapp && 'whatsapp', phone && 'sms', email && 'email'].filter(Boolean).filter(ch => !already.has(ch));
    if (!want.length) {
      await saveLead(lead);
      return res.status(409).json({ error: phone || whatsapp || email ? 'An intro has already gone out on those channels' : 'Enter a mobile, WhatsApp number or email', lead: view(lead) });
    }

    if (!lead.drafts?.ai) lead.drafts = await aiIntro(lead);
    const results = {};
    for (const ch of want) {
      if (!avail[ch]) { results[ch] = 'not set up yet'; continue; }
      try {
        if (ch === 'email') await sendToSeller(lead, 'email', { subject: lead.drafts.email.subject, body: lead.drafts.email.body });
        else await sendToSeller(lead, ch, { body: lead.drafts.sms, template: ch === 'whatsapp' ? introTemplate(lead) : null });
        results[ch] = 'sent';
      } catch (err) {
        results[ch] = err.message;
      }
    }

    const sent = Object.keys(results).filter(k => results[k] === 'sent');
    if (sent.length) {
      lead.approvedAt = lead.approvedAt || new Date().toISOString();
      if (['new', 'needs_valuation', 'draft', 'rejected'].includes(lead.stage)) moveStage(lead, 'contacted', `Outreach started via ${sent.join(', ')}`);
      else (lead.history = lead.history || []).push({ at: new Date().toISOString(), from: lead.stage, to: lead.stage, note: `Intro sent via ${sent.join(', ')}` });
      if (lead.stage === 'contacted') scheduleFollowUp(lead, [...new Set([...(lead.followUp?.channels || []), ...sent])]);
    }
    await saveLead(lead);
    res.json({ results, lead: view(lead) });
  });

  router.get('/api/leads', admin, async (req, res) => {
    let leads = await listLeads();
    if (req.query.stage) leads = leads.filter(l => req.query.stage.split(',').includes(l.stage));
    leads.sort((a, b) => (b.discountPct ?? -999) - (a.discountPct ?? -999));
    res.json(leads.map(view));
  });

  router.get('/api/leads/:id', admin, async (req, res) => {
    const lead = await getLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Not found' });
    if (lead.unread) { lead.unread = false; await saveLead(lead); }
    res.json(view(lead));
  });

  // Edit drafts, deal figures, documents, notes, or enter a manual market value
  router.patch('/api/leads/:id', admin, async (req, res) => {
    const lead = await getLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Not found' });
    const { drafts, deal, documents, notes, manualMarketValue, seller } = req.body;

    if (drafts) lead.drafts = { ...lead.drafts, ...drafts, email: { ...lead.drafts?.email, ...drafts.email } };
    if (deal) lead.deal = { ...lead.deal, ...deal };
    if (documents) lead.documents = { ...lead.documents, ...documents };
    if (seller) lead.seller = { ...lead.seller, ...seller };
    if (notes !== undefined) lead.notes = notes;

    if (manualMarketValue) {
      lead.valuation = { method: 'manual', market: Number(manualMarketValue), confidence: 'manual', valuedAt: new Date().toISOString() };
      if (PRE_CONTACT.includes(lead.stage)) await qualify(lead, []);
    }
    res.json(view(await saveLead(lead)));
  });

  // Step 3 — approve and send the intro on the chosen channels
  router.post('/api/leads/:id/approve', admin, async (req, res) => {
    const lead = await getLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Not found' });
    if (lead.stage !== 'draft') return res.status(409).json({ error: `Lead is ${lead.stage}, not awaiting approval` });

    const channels = req.body.channels || ['sms', 'email'];
    const results = {};
    for (const ch of channels) {
      try {
        if (ch === 'sms') await sendToSeller(lead, 'sms', { body: lead.drafts.sms });
        else if (ch === 'email') await sendToSeller(lead, 'email', { subject: lead.drafts.email.subject, body: lead.drafts.email.body });
        else if (ch === 'manual') await sendToSeller(lead, 'manual', { body: lead.drafts.sms });
        else if (ch === 'whatsapp') await sendToSeller(lead, 'whatsapp', { body: lead.drafts.sms, template: introTemplate(lead) });
        results[ch] = 'sent';
      } catch (err) {
        results[ch] = err.message;
      }
    }

    if (Object.values(results).includes('sent')) {
      lead.approvedAt = new Date().toISOString();
      const sentCh = Object.keys(results).filter(k => results[k] === 'sent');
      moveStage(lead, 'contacted', `Intro sent via ${sentCh.join(', ')}`);
      scheduleFollowUp(lead, sentCh.filter(c => c !== 'manual'));
    }
    await saveLead(lead);
    res.json({ results, lead: view(lead) });
  });

  router.post('/api/leads/:id/reject', admin, async (req, res) => {
    const lead = await getLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Not found' });
    lead.rejectReason = req.body.reason || 'Rejected manually';
    moveStage(lead, 'rejected', lead.rejectReason);
    res.json(view(await saveLead(lead)));
  });

  router.post('/api/leads/:id/stage', admin, async (req, res) => {
    const lead = await getLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Not found' });
    const { stage, note } = req.body;
    const err = checkStageMove(lead, stage);
    if (err) return res.status(422).json({ error: err });
    // Re-opening a rejected lead for approval needs drafts
    if (stage === 'draft' && !lead.drafts) lead.drafts = draftMessages(lead);
    moveStage(lead, stage, note);
    res.json(view(await saveLead(lead)));
  });

  // Step 4 — send a follow-up / negotiation message you've written or approved
  router.post('/api/leads/:id/message', admin, async (req, res) => {
    const lead = await getLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Not found' });
    const { channel, body, subject } = req.body;
    if (!body) return res.status(400).json({ error: 'Message body required' });
    try {
      await sendToSeller(lead, channel, { body, subject: subject || `Re: ${lead.drafts?.email?.subject || 'your vehicle'}` });
      if (lead.stage === 'contacted') moveStage(lead, 'negotiating');
      res.json(view(await saveLead(lead)));
    } catch (err) {
      res.status(422).json({ error: err.message });
    }
  });

  router.post('/api/leads/:id/suggest-reply', admin, async (req, res) => {
    const lead = await getLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Not found' });
    try {
      res.json({ text: await suggestReply(lead, req.body.channel || 'sms') });
    } catch (err) {
      res.status(422).json({ error: err.message });
    }
  });

  // ── SELLER REPLIES ──
  // Twilio → Phone Number → "A message comes in" → POST https://your-domain/sms-inbound
  router.post('/sms-inbound', express.urlencoded({ extended: true }), async (req, res) => {
    try {
      const from = req.body.From;
      const body = req.body.Body || '';
      const lead = await findLeadByContact(from);
      if (lead) await handleReply(lead, 'sms', body, from);
      else console.log('SMS from unknown number', from);
    } catch (err) {
      console.error('SMS inbound error:', err);
    }
    res.type('text/xml').send('<Response></Response>');
  });

  router.get('/admin', (req, res) => res.sendFile(path.join(here, 'admin.html')));

  setInterval(() => sweepFollowUps().catch(err => console.error('Follow-up sweep failed:', err)), 10 * 60000).unref();

  return router;
}

async function handleReply(lead, channel, body, from) {
  await recordReply(lead, channel, body, from);
  lead.followUp = null; // they replied — no nudge needed
  if (isOptOut(body)) moveStage(lead, 'opted_out', `Opt-out via ${channel}`);
  else if (lead.stage === 'contacted') moveStage(lead, 'negotiating', `Seller replied via ${channel}`);
  await saveLead(lead);
}

// WhatsApp messages share one webhook with the seller-facing bot. If the sender is a seller we contacted
// about a listing, the reply belongs on that car. Returns true if handled.
export async function handleSellerWhatsApp(from, body) {
  const num = String(from || '').replace(/^whatsapp:/, '');
  if (!num || !body) return false;
  const lead = await findLeadByContact(num);
  if (!lead || lead.seller?.whatsapp !== num) return false;
  await handleReply(lead, 'whatsapp', body, num);
  return true;
}

// Seller email replies arrive at lead-{id}@INBOUND_DOMAIN. Returns true if handled.
export async function handleSellerEmail(req) {
  const { from, to, text, html } = req.body;
  const toAddress = Array.isArray(to) ? to[0] : to;
  const match = (toAddress || '').match(/lead-([A-Z0-9]+)@/i);
  if (!match) return false;
  const lead = await getLead(match[1].toUpperCase());
  if (!lead) return true;
  const body = (text || (html ? html.replace(/<[^>]*>/g, '') : '')).split(/\n>|\nOn .+wrote:/)[0].trim();
  const sender = (String(from).match(/<([^>]+)>/)?.[1] || from || '').toLowerCase();
  await handleReply(lead, 'email', body, sender);
  return true;
}

// Shared by the HTTP endpoint and the CLI
export async function ingest(items, source) {
  const summary = { received: items.length, new: 0, updated: 0, priceDrops: 0, skipped: 0, byStage: {} };
  const existing = await listLeads();
  const byId = new Map(existing.map(l => [l.id, l]));
  const touched = [];
  const now = new Date().toISOString();

  // Pass 1: upsert every listing so the whole batch counts as comparables
  for (const raw of items) {
    let listing;
    try {
      listing = normaliseListing(raw, source);
    } catch (err) {
      summary.skipped++;
      continue;
    }
    const prev = byId.get(listing.id);
    if (prev) {
      // Keep pipeline state, refresh listing details, track price changes
      const lead = { ...prev, ...listing, seller: { ...listing.seller, ...pick(prev.seller) }, lastSeenAt: now };
      if (listing.askingPrice && prev.askingPrice && listing.askingPrice !== prev.askingPrice) {
        lead.priceHistory = [...(prev.priceHistory || []), { at: now, price: listing.askingPrice }];
        if (listing.askingPrice < prev.askingPrice) summary.priceDrops++;
      }
      byId.set(lead.id, lead);
      touched.push(lead);
      summary.updated++;
    } else {
      const lead = {
        ...listing, stage: 'new', firstSeenAt: now, lastSeenAt: now,
        priceHistory: [{ at: now, price: listing.askingPrice }],
        documents: { financeOwing: listing.flags.includes('finance_owing') },
      };
      byId.set(lead.id, lead);
      touched.push(lead);
      summary.new++;
    }
  }

  // Pass 2: qualify anything we haven't contacted yet (but leave manual rejections alone)
  // A few at a time, since AI valuations make a network call per car
  const pool = [...byId.values()];
  const queue = [...touched];
  const worker = async () => {
    for (let lead; (lead = queue.shift());) {
      const manuallyRejected = lead.stage === 'rejected' && lead.history?.some(h => h.to === 'rejected');
      if (PRE_CONTACT.includes(lead.stage) && !manuallyRejected) await qualify(lead, pool);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  for (const lead of touched) {
    await saveLead(lead);
    summary.byStage[lead.stage] = (summary.byStage[lead.stage] || 0) + 1;
  }
  return summary;
}

// Contact details we corrected by hand win over the feed
function pick(seller = {}) {
  return Object.fromEntries(Object.entries(seller).filter(([, v]) => v));
}

export { sweepFollowUps, businessHours };
