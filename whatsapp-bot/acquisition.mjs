// ── ACQUISITION API ──
// Daily listing feed in → valued, filtered leads → approval queue → outreach → deal pipeline.
//
//   POST /api/listings/ingest     (INGEST_API_KEY)  scraping agent drops the day's listings
//   GET  /api/leads               (ADMIN_TOKEN)     dashboard data
//   ...                                             see routes below
//   POST /sms-inbound                               Twilio SMS webhook (seller replies)
//   /admin                                          approval + pipeline dashboard

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseListing, checkCriteria, CRITERIA } from './listings.mjs';
import { valueListing, discountFor } from './valuation.mjs';
import { STAGES, documentChecklist, alerts, checkStageMove, moveStage } from './pipeline.mjs';
import { draftMessages, sendToSeller, recordReply, suggestReply, isOptOut } from './seller-outreach.mjs';
import { getLead, listLeads, saveLead, findLeadByContact } from './store.mjs';

const { INGEST_API_KEY, ADMIN_TOKEN } = process.env;
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
  } else if (!lead.seller.phone && !lead.seller.email && !lead.seller.profileUrl) {
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
function view(lead) {
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

  router.get('/api/meta', admin, (req, res) => res.json({ stages: STAGES, criteria: CRITERIA }));

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
        results[ch] = 'sent';
      } catch (err) {
        results[ch] = err.message;
      }
    }

    if (Object.values(results).includes('sent')) {
      lead.approvedAt = new Date().toISOString();
      moveStage(lead, 'contacted', `Intro sent via ${Object.keys(results).filter(k => results[k] === 'sent').join(', ')}`);
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

  return router;
}

async function handleReply(lead, channel, body, from) {
  await recordReply(lead, channel, body, from);
  if (isOptOut(body)) moveStage(lead, 'opted_out', `Opt-out via ${channel}`);
  else if (lead.stage === 'contacted') moveStage(lead, 'negotiating', `Seller replied via ${channel}`);
  await saveLead(lead);
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
  const pool = [...byId.values()];
  for (const lead of touched) {
    const manuallyRejected = lead.stage === 'rejected' && lead.history?.some(h => h.to === 'rejected');
    if (PRE_CONTACT.includes(lead.stage) && !manuallyRejected) await qualify(lead, pool);
    await saveLead(lead);
    summary.byStage[lead.stage] = (summary.byStage[lead.stage] || 0) + 1;
  }
  return summary;
}

// Contact details we corrected by hand win over the feed
function pick(seller = {}) {
  return Object.fromEntries(Object.entries(seller).filter(([, v]) => v));
}
