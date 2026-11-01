// ── DEALER PORTAL ──
// Dealers sign up, you approve them, then they log in to see cars you've opened for bids and bid on them.
// Opening a car for bids also invites approved dealers by email/SMS. When bidding closes, the highest bid
// at or above your reserve wins automatically (if auto-accept is on); otherwise it waits for you.
//
//   Dealer API   /api/dealer/...            (dealer session token)
//   Admin API    /api/admin/dealers, /api/leads/:id/sale...   (ADMIN_TOKEN)
//   Pages        /dealer

import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLead, listLeads, saveLead, getDealer, listDealers, saveDealer, findDealerByEmail } from './store.mjs';
import { normalisePhone, normaliseEmail, cleanVariant } from './listings.mjs';
import { sendEmail, sendSms, canEmail, canSms } from './notify.mjs';
import { moveStage } from './pipeline.mjs';

const { ADMIN_TOKEN, ADMIN_EMAIL, PUBLIC_URL, BUSINESS_NAME = 'Click2Trade', DISPLAY_TZ = 'Australia/Sydney' } = process.env;
const here = path.dirname(fileURLToPath(import.meta.url));

const BID_INCREMENT = 100;
const SNIPE_WINDOW_MS = 2 * 60 * 1000; // a bid in the last 2 minutes pushes the close back to 2 minutes away
const SESSION_DAYS = 30;
const RESET_MINUTES = 60;
const DEAL_STAGES = ['agreed', 'agreement_sent', 'inspection', 'documents', 'dms_loaded', 'selling', 'seller_paid', 'in_stock'];

let baseUrl = PUBLIC_URL || '';
const link = (p) => `${baseUrl}${p}`;
const money = n => '$' + Math.round(n).toLocaleString('en-AU');
const when = iso => new Date(iso).toLocaleString('en-AU', { timeZone: DISPLAY_TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const carName = l => [l.vehicle.year, l.vehicle.make, l.vehicle.model].filter(Boolean).join(' ');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// ── passwords & sessions ──
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [, salt, hash] = String(stored || '').split('$');
  if (!salt || !hash) return false;
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}
function newSession(dealer) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  dealer.sessions = [...(dealer.sessions || []).filter(s => s.expires > now), { hash: sha256(token), expires: now + SESSION_DAYS * 86400000 }].slice(-5);
  return token;
}

// Simple in-memory brute-force guard: 10 tries per key per 15 minutes
const attempts = new Map();
function tooMany(key) {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.until < now) { attempts.set(key, { n: 1, until: now + 15 * 60000 }); return false; }
  return ++a.n > 10;
}

// One bid at a time per car, so two dealers can't both "win" the same increment
const locks = new Map();
function withLock(key, fn) {
  const run = (locks.get(key) || Promise.resolve()).then(fn, fn);
  locks.set(key, run.catch(() => {}));
  return run;
}

// What a dealer may see about themselves / what admin sees about a dealer (never hashes or sessions)
function publicDealer(d) {
  const { passwordHash, sessions, reset, ...rest } = d;
  return rest;
}

// ── sale helpers ──
function topBid(sale) {
  // Highest amount wins; on a tie the earlier bid wins
  return (sale?.bids || []).reduce((best, b) => !best || b.amount > best.amount ? b : best, null);
}
function saleStatus(sale, now = Date.now()) {
  if (!sale) return null;
  if (sale.status === 'open' && new Date(sale.closesAt).getTime() <= now) return 'ended';
  return sale.status;
}
function minNextBid(sale, dealerId) {
  const top = topBid(sale);
  if (sale.showHighest) return top ? top.amount + BID_INCREMENT : Math.max(BID_INCREMENT, sale.startPrice || 0);
  const mine = Math.max(0, ...sale.bids.filter(b => b.dealerId === dealerId).map(b => b.amount));
  return mine ? mine + BID_INCREMENT : Math.max(BID_INCREMENT, sale.startPrice || 0);
}

// The car as a dealer sees it: no seller details, no asking/purchase price, no listing link, no internal notes
function dealerCarView(lead, dealerId) {
  const v = lead.vehicle, s = lead.sale;
  const top = topBid(s);
  const myBids = s.bids.filter(b => b.dealerId === dealerId);
  const status = saleStatus(s);
  const winner = s.status === 'sold' ? s.bids.find(b => b.id === s.winningBidId) : null;
  return {
    id: lead.id,
    title: carName(lead),
    year: v.year, make: v.make, model: v.model, variant: cleanVariant(v.variant),
    km: v.km, condition: v.condition, transmission: v.transmission, fuelType: v.fuelType, bodyType: v.bodyType, colour: v.colour,
    location: { suburb: lead.location?.suburb || null, state: lead.location?.state || null },
    photos: lead.photos || [],
    description: s.description || '',
    inspection: lead.deal?.inspectionResult || null,
    openedAt: s.openedAt, closesAt: s.closesAt, status,
    bidCount: s.bids.length,
    bidders: new Set(s.bids.map(b => b.dealerId)).size,
    highest: s.showHighest && top ? top.amount : null,
    showHighest: !!s.showHighest,
    reserveMet: !!(top && top.amount >= s.reserve),
    myBid: myBids.length ? Math.max(...myBids.map(b => b.amount)) : null,
    leading: !!(top && top.dealerId === dealerId),
    won: !!(winner && winner.dealerId === dealerId),
    minNext: minNextBid(s, dealerId),
    increment: BID_INCREMENT,
  };
}

// ── closing a sale ──
async function acceptBid(lead, bid, by) {
  const s = lead.sale;
  s.status = 'sold';
  s.winningBidId = bid.id;
  s.closedAt = new Date().toISOString();
  lead.deal = { ...lead.deal, buyingDealer: bid.dealerName, buyingDealerId: bid.dealerId, salePrice: bid.amount };
  lead.history = lead.history || [];
  lead.history.push({ at: s.closedAt, from: lead.stage, to: lead.stage, note: `Sold to ${bid.dealerName} for ${money(bid.amount)} (${by})` });
  await saveLead(lead);
  notifySold(lead, bid).catch(err => console.error('Sale notifications failed for', lead.id, err));
}

async function notifySold(lead, bid) {
  const s = lead.sale;
  const winner = await getDealer(bid.dealerId);
  if (winner) {
    await sendEmail(winner.email, `You've bought the ${carName(lead)} — ${money(bid.amount)}`,
`Hi ${winner.contactName},

Congratulations — your bid of ${money(bid.amount)} won the ${carName(lead)} (${lead.vehicle.km?.toLocaleString()} km).

We'll be in touch shortly with the tax invoice and to arrange transport. Payment is due within 72 hours of invoice.

${link('/dealer#car=' + lead.id)}

${BUSINESS_NAME}`);
  }
  // Let the other bidders know it's gone
  const others = [...new Set(s.bids.filter(b => b.dealerId !== bid.dealerId).map(b => b.dealerId))];
  for (const id of others) {
    const d = await getDealer(id);
    if (d && d.notify?.email !== false) {
      await sendEmail(d?.email, `Bidding closed: ${carName(lead)}`,
`Hi ${d.contactName},

Bidding on the ${carName(lead)} has closed and your bid wasn't the winning one this time. Thanks for bidding — we'll let you know about new stock.

${link('/dealer')}

${BUSINESS_NAME}`);
    }
  }
}

// Close anything whose timer has run out. Runs every minute and before dealer/admin reads.
export async function sweepSales() {
  const now = Date.now();
  for (const lead of await listLeads()) {
    if (lead.sale?.status !== 'open' || new Date(lead.sale.closesAt).getTime() > now) continue;
    // One car failing (e.g. an email error) mustn't stop the others closing
    await withLock(lead.id, async () => {
      const l = await getLead(lead.id);
      if (l.sale?.status !== 'open' || new Date(l.sale.closesAt).getTime() > Date.now()) return;
      const top = topBid(l.sale);
      if (top && top.amount >= l.sale.reserve && l.sale.autoAccept) {
        await acceptBid(l, top, 'auto-accepted at close');
        return;
      }
      l.sale.status = 'ended';
      l.sale.closedAt = new Date().toISOString();
      await saveLead(l);
      await sendEmail(ADMIN_EMAIL, `Bidding ended: ${carName(l)} — ${top ? `top bid ${money(top.amount)}` : 'no bids'}`,
`${carName(l)}: bidding has ended.
Top bid: ${top ? `${money(top.amount)} from ${top.dealerName}` : 'none'}
Reserve: ${money(l.sale.reserve)}${top && top.amount < l.sale.reserve ? ' (not met)' : ''}

Accept a bid or relist it: ${link('/admin')}`);
    }).catch(err => console.error('Closing sale failed for', lead.id, err));
  }
}

async function inviteDealers(lead, { email = true, sms = false } = {}) {
  const v = lead.vehicle;
  const where = [lead.location?.suburb, lead.location?.state].filter(Boolean).join(' ');
  const url = link('/dealer#car=' + lead.id);
  const dealers = (await listDealers()).filter(d => d.status === 'approved');
  let emailed = 0, texted = 0;
  for (const d of dealers) {
    if (email && d.notify?.email !== false && await sendEmail(d.email,
      `New stock for bids: ${carName(lead)} · ${v.km?.toLocaleString()} km`,
`Hi ${d.contactName},

New stock is open for bids:

${carName(lead)}${cleanVariant(v.variant) ? ' ' + cleanVariant(v.variant) : ''}
${v.km?.toLocaleString()} km · ${[v.transmission, v.fuelType].filter(Boolean).join(' · ')}
${where}

Bids close ${when(lead.sale.closesAt)}.

See photos and bid: ${url}

${BUSINESS_NAME}
(Turn off these emails in your account settings on the dealer portal.)`)) emailed++;
    if (sms && d.notify?.sms && d.phone && await sendSms(d.phone,
      `${BUSINESS_NAME}: new stock for bids - ${carName(lead)}, ${v.km?.toLocaleString()}km, ${where}. Closes ${when(lead.sale.closesAt)}. ${url} Reply STOP to opt out`)) texted++;
  }
  return { dealers: dealers.length, emailed, texted };
}

export function createDealerRouter({ adminView }) {
  const router = express.Router();
  router.use(express.json());
  // Links in emails need the public address; take it from the first real request if PUBLIC_URL isn't set
  router.use((req, res, next) => {
    if (!baseUrl && req.get('host')) baseUrl = `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
    next();
  });

  const admin = (req, res, next) => {
    if (!ADMIN_TOKEN) return res.status(503).json({ error: 'ADMIN_TOKEN not configured on the server' });
    if ((req.get('authorization') || '').replace(/^Bearer\s+/i, '') !== ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorised' });
    next();
  };

  const dealerAuth = async (req, res, next) => {
    const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Please log in' });
    const h = sha256(token), now = Date.now();
    const dealer = (await listDealers()).find(d => d.sessions?.some(s => s.hash === h && s.expires > now));
    if (!dealer) return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
    if (dealer.status !== 'approved') return res.status(403).json({ error: 'Your account is not active.' });
    req.dealer = dealer;
    req.sessionHash = h;
    next();
  };

  // ── account ──
  router.post('/api/dealer/signup', async (req, res) => {
    const b = req.body || {};
    const email = normaliseEmail(b.email);
    const missing = ['businessName', 'contactName', 'licence', 'phone'].filter(k => !String(b[k] || '').trim());
    if (!email) missing.push('email');
    if (missing.length) return res.status(400).json({ error: `Please fill in: ${missing.join(', ')}` });
    if (String(b.password || '').length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (tooMany('signup:' + req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    if (await findDealerByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists. Try logging in.' });

    const dealer = {
      id: 'DL' + crypto.randomBytes(5).toString('hex').toUpperCase(),
      businessName: String(b.businessName).trim(),
      contactName: String(b.contactName).trim(),
      email,
      phone: normalisePhone(b.phone) || String(b.phone).trim(),
      licence: String(b.licence).trim(),
      abn: String(b.abn || '').replace(/\s/g, '') || null,
      state: String(b.state || '').toUpperCase() || null,
      suburb: String(b.suburb || '').trim() || null,
      status: 'pending',
      notify: { email: true, sms: false },
      passwordHash: hashPassword(String(b.password)),
      createdAt: new Date().toISOString(),
    };
    await saveDealer(dealer);
    await sendEmail(ADMIN_EMAIL, `New dealer sign-up: ${dealer.businessName}`,
`${dealer.businessName} (${dealer.licence}) signed up for the dealer portal.
Contact: ${dealer.contactName} · ${dealer.email} · ${dealer.phone}
ABN: ${dealer.abn || '—'} · ${[dealer.suburb, dealer.state].filter(Boolean).join(', ')}

Check their licence, then approve them: ${link('/admin')}`);
    res.json({ ok: true, status: 'pending' });
  });

  router.post('/api/dealer/login', async (req, res) => {
    const email = normaliseEmail(req.body?.email);
    if (tooMany('login:' + (email || req.ip))) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    const dealer = email && await findDealerByEmail(email);
    if (!dealer || !checkPassword(String(req.body?.password || ''), dealer.passwordHash)) {
      return res.status(401).json({ error: 'Email or password is incorrect' });
    }
    if (dealer.status === 'pending') return res.status(403).json({ error: 'Thanks for signing up — your account is awaiting approval. We’ll email you once it’s active.' });
    if (dealer.status !== 'approved') return res.status(403).json({ error: 'Your account is not active. Please contact us.' });
    const token = newSession(dealer);
    dealer.lastLoginAt = new Date().toISOString();
    await saveDealer(dealer);
    res.json({ token, dealer: publicDealer(dealer) });
  });

  router.post('/api/dealer/logout', dealerAuth, async (req, res) => {
    req.dealer.sessions = req.dealer.sessions.filter(s => s.hash !== req.sessionHash);
    await saveDealer(req.dealer);
    res.json({ ok: true });
  });

  router.post('/api/dealer/forgot', async (req, res) => {
    const email = normaliseEmail(req.body?.email);
    if (tooMany('forgot:' + (email || req.ip))) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    const dealer = email && await findDealerByEmail(email);
    // Same answer whether or not the account exists
    if (dealer && dealer.status !== 'suspended') {
      const token = crypto.randomBytes(32).toString('base64url');
      dealer.reset = { hash: sha256(token), expires: Date.now() + RESET_MINUTES * 60000 };
      await saveDealer(dealer);
      await sendEmail(dealer.email, `Reset your ${BUSINESS_NAME} dealer password`,
`Hi ${dealer.contactName},

Use this link to set a new password (valid for ${RESET_MINUTES} minutes):
${link('/dealer#reset=' + token)}

If you didn't ask for this, you can ignore this email.

${BUSINESS_NAME}`);
    }
    res.json({ ok: true, emailEnabled: canEmail });
  });

  router.post('/api/dealer/reset', async (req, res) => {
    const { token, password } = req.body || {};
    if (String(password || '').length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const h = sha256(String(token || ''));
    const dealer = (await listDealers()).find(d => d.reset?.hash === h && d.reset.expires > Date.now());
    if (!dealer) return res.status(400).json({ error: 'This reset link has expired. Request a new one.' });
    dealer.passwordHash = hashPassword(String(password));
    dealer.reset = null;
    dealer.sessions = [];
    await saveDealer(dealer);
    res.json({ ok: true });
  });

  router.get('/api/dealer/me', dealerAuth, (req, res) => res.json({ ...publicDealer(req.dealer), smsAvailable: canSms }));

  router.patch('/api/dealer/me', dealerAuth, async (req, res) => {
    const b = req.body || {};
    const d = req.dealer;
    if (b.notify) d.notify = { email: b.notify.email !== false, sms: !!b.notify.sms };
    if (b.phone) d.phone = normalisePhone(b.phone) || String(b.phone).trim();
    if (b.contactName) d.contactName = String(b.contactName).trim();
    await saveDealer(d);
    res.json(publicDealer(d));
  });

  // ── inventory & bidding ──
  router.get('/api/dealer/cars', dealerAuth, async (req, res) => {
    await sweepSales();
    const id = req.dealer.id;
    const recent = Date.now() - 30 * 86400000;
    const cars = (await listLeads())
      .filter(l => l.sale && (l.sale.status === 'open' || (l.sale.bids.some(b => b.dealerId === id) && new Date(l.sale.openedAt).getTime() > recent)))
      .map(l => dealerCarView(l, id))
      .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || new Date(a.closesAt) - new Date(b.closesAt));
    res.json(cars);
  });

  router.get('/api/dealer/cars/:id', dealerAuth, async (req, res) => {
    const lead = await getLead(req.params.id);
    if (!lead?.sale || (lead.sale.status !== 'open' && !lead.sale.bids.some(b => b.dealerId === req.dealer.id))) {
      return res.status(404).json({ error: 'This car is no longer available' });
    }
    res.json(dealerCarView(lead, req.dealer.id));
  });

  router.post('/api/dealer/cars/:id/bids', dealerAuth, async (req, res) => {
    const amount = Math.round(Number(req.body?.amount));
    const dealer = req.dealer;
    try {
      const out = await withLock(req.params.id, async () => {
        const lead = await getLead(req.params.id);
        const s = lead?.sale;
        if (!s || saleStatus(s) !== 'open') throw Object.assign(new Error('Bidding on this car has closed'), { status: 409 });
        const min = minNextBid(s, dealer.id);
        if (!Number.isFinite(amount) || amount < min) throw Object.assign(new Error(`Your bid needs to be at least ${money(min)}`), { status: 422 });
        if (amount > 2000000) throw Object.assign(new Error('That bid looks too high — please check it'), { status: 422 });

        const prevTop = topBid(s);
        const bid = { id: 'B' + crypto.randomBytes(5).toString('hex'), dealerId: dealer.id, dealerName: dealer.businessName, amount, at: new Date().toISOString() };
        s.bids.push(bid);
        if (new Date(s.closesAt).getTime() - Date.now() < SNIPE_WINDOW_MS) {
          s.closesAt = new Date(Date.now() + SNIPE_WINDOW_MS).toISOString();
        }
        await saveLead(lead);
        return { lead, prevTop };
      });

      // Tell the dealer who just lost the lead (only when bidding is open, so it doesn't leak sealed amounts)
      const { lead, prevTop } = out;
      const newTop = topBid(lead.sale);
      if (lead.sale.showHighest && prevTop && prevTop.dealerId !== dealer.id && newTop.dealerId === dealer.id) {
        const d = await getDealer(prevTop.dealerId);
        if (d && d.notify?.email !== false) {
          sendEmail(d.email, `You've been outbid: ${carName(lead)}`,
`Hi ${d.contactName},

You've been outbid on the ${carName(lead)}. The top bid is now ${money(newTop.amount)}.
Bids close ${when(lead.sale.closesAt)}.

Bid again: ${link('/dealer#car=' + lead.id)}

${BUSINESS_NAME}`);
        }
      }
      res.json(dealerCarView(lead, dealer.id));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // ── admin: dealer accounts ──
  router.get('/api/admin/dealers', admin, async (req, res) => {
    const leads = await listLeads();
    const dealers = (await listDealers()).map(d => {
      const bids = leads.flatMap(l => l.sale?.bids || []).filter(b => b.dealerId === d.id);
      const won = leads.filter(l => l.sale?.status === 'sold' && l.deal?.buyingDealerId === d.id).length;
      return { ...publicDealer(d), bidCount: bids.length, won };
    });
    dealers.sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ dealers, canEmail, canSms });
  });

  router.patch('/api/admin/dealers/:id', admin, async (req, res) => {
    const d = await getDealer(req.params.id);
    if (!d) return res.status(404).json({ error: 'Not found' });
    const { status, notes } = req.body || {};
    if (status && !['pending', 'approved', 'suspended'].includes(status)) return res.status(400).json({ error: 'Bad status' });
    const approvedNow = status === 'approved' && d.status !== 'approved';
    if (status) d.status = status;
    if (status === 'suspended') d.sessions = [];
    if (notes !== undefined) d.notes = notes;
    if (approvedNow) d.approvedAt = new Date().toISOString();
    await saveDealer(d);
    if (approvedNow) {
      await sendEmail(d.email, `Your ${BUSINESS_NAME} dealer account is approved`,
`Hi ${d.contactName},

Your dealer account for ${d.businessName} is now active. Log in to see stock open for bids:
${link('/dealer')}

We'll email you whenever new stock is available.

${BUSINESS_NAME}`);
    }
    res.json(publicDealer(d));
  });

  // ── admin: selling a car to dealers ──
  router.post('/api/leads/:id/sale', admin, async (req, res) => {
    const lead = await getLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Not found' });
    if (!DEAL_STAGES.includes(lead.stage)) return res.status(409).json({ error: 'Agree a price and secure the car before offering it to dealers' });
    if (lead.sale?.status === 'open') return res.status(409).json({ error: 'Bidding is already open on this car' });
    if (lead.sale?.status === 'sold') return res.status(409).json({ error: 'This car is already sold' });

    const b = req.body || {};
    const reserve = Math.round(Number(b.reserve));
    const hours = Math.min(14 * 24, Math.max(1, Number(b.hours) || 24));
    if (!reserve || reserve < 1000) return res.status(400).json({ error: 'Set a reserve — the lowest price you’ll sell for' });

    const now = Date.now();
    lead.sale = {
      status: 'open',
      openedAt: new Date(now).toISOString(),
      closesAt: new Date(now + hours * 3600000).toISOString(),
      reserve,
      startPrice: Math.round(Number(b.startPrice)) || 0,
      description: String(b.description || '').slice(0, 3000),
      showHighest: b.showHighest !== false,
      autoAccept: b.autoAccept !== false,
      bids: [],
      round: (lead.sale?.round || 0) + 1,
    };
    if (lead.stage !== 'selling' && ['agreed', 'agreement_sent', 'inspection', 'documents', 'dms_loaded'].includes(lead.stage) && b.moveStage) {
      moveStage(lead, 'selling', 'Opened for dealer bids');
    }
    await saveLead(lead);
    const invited = await inviteDealers(lead, { email: b.notifyEmail !== false, sms: !!b.notifySms });
    lead.sale.invited = invited;
    await saveLead(lead);
    res.json({ lead: adminView(lead), invited });
  });

  router.post('/api/leads/:id/sale/accept', admin, async (req, res) => {
    try {
      const lead = await withLock(req.params.id, async () => {
        const l = await getLead(req.params.id);
        if (!l?.sale || l.sale.status === 'sold') throw Object.assign(new Error('Nothing to accept'), { status: 409 });
        const bid = l.sale.bids.find(b => b.id === req.body?.bidId);
        if (!bid) throw Object.assign(new Error('Bid not found'), { status: 404 });
        await acceptBid(l, bid, 'accepted by you');
        return l;
      });
      res.json(adminView(lead));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.post('/api/leads/:id/sale/close', admin, async (req, res) => {
    const lead = await withLock(req.params.id, async () => {
      const l = await getLead(req.params.id);
      if (l?.sale && ['open', 'ended'].includes(l.sale.status)) {
        l.sale.status = 'unsold';
        l.sale.closedAt = new Date().toISOString();
        await saveLead(l);
      }
      return l;
    });
    if (!lead) return res.status(404).json({ error: 'Not found' });
    res.json(adminView(lead));
  });

  router.get('/dealer', (req, res) => res.sendFile(path.join(here, 'dealer.html')));

  setInterval(() => sweepSales().catch(err => console.error('Sale sweep failed:', err)), 60000).unref();
  return router;
}
