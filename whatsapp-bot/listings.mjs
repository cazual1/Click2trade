// ── LISTING NORMALISATION + BUY CRITERIA ──
// Turns raw marketplace listings (from the scraping agent's daily feed) into leads,
// and decides whether each vehicle fits what we buy.
// Feed format is documented in LISTING_FEED.md.

import crypto from 'node:crypto';

export const CRITERIA = {
  maxAgeYears: parseInt(process.env.MAX_AGE_YEARS || '5'),
  maxKm: parseInt(process.env.MAX_KM || '80000'),
  minDiscountPct: parseFloat(process.env.MIN_DISCOUNT_PCT || '5'), // % below market to qualify
};

const MAKES = ['toyota','ford','mazda','hyundai','kia','mitsubishi','isuzu','mg','byd','gwm','haval','tesla','nissan','subaru','volkswagen','vw','honda','bmw','mercedes-benz','mercedes','audi','chery','suzuki','lexus','porsche','jeep','ram','land rover','volvo','skoda','renault','peugeot','ldv','polestar','cupra','genesis','mini'];

const MAKE_NAMES = { vw: 'Volkswagen', mercedes: 'Mercedes-Benz', 'mercedes-benz': 'Mercedes-Benz', mg: 'MG', byd: 'BYD', gwm: 'GWM', bmw: 'BMW', ldv: 'LDV', ram: 'RAM', mini: 'MINI' };

// Words in the title/description that change whether we want the car
const RISK_FLAGS = [
  { flag: 'written_off', re: /written[\s-]?off|wovr|wovi|repairable write|statutory write|salvage/i, reject: true },
  { flag: 'damaged', re: /hail|accident|crash|flood|smash|panel damage|needs (?:work|repair)|not running|mechanic special|\bdent\b/i },
  { flag: 'no_rego', re: /no rego|unregistered|rego expired|without rego/i },
  { flag: 'finance_owing', re: /finance owing|still on finance|currently has finance|payout|owe on|money owing/i },
  { flag: 'swap_only', re: /swap only|swaps? (?:wanted|considered)|trade for/i },
  {
    flag: 'dealer',
    re: /\blmct\b|licen[cs]ed (?:motor )?dealer|\bdealer (?:licen[cs]e|lic|sale|warranty)\b|we are a dealer|\b(?:DL|MD|MVD)[\s:#]*\d{4,}|finance (?:available|options)|trade[- ]ins? (?:welcome|&|offered)|we can deliver|on the yard|car sales\b|\bmotors\b[^.\n]{0,20}\.com|platform contact options to connect with the dealer/i,
    reject: true,
  },
];

// "No finance owing", "no accidents, no written off", "clean PPSR – no write-off history" are good news, not flags
const NEGATION = /\b(?:no|not|never|nil|zero|without|clear)\b[^.\n,;!]{0,30}/gi;
const NEGATABLE = /finance|money owing|written[\s-]?off|write[\s-]?off|accident|damage|hail|dent/i;
const stripNegated = text => text.replace(NEGATION, m => NEGATABLE.test(m) && !/wov[ri]/i.test(m) ? ' ' : m);

const NOT_CAR_BODY = /motor ?cycle|motorbike|scooter|atv|quad|boat|caravan|trailer|jet ?ski/i;
const BIKE_MAKES = ['yamaha', 'beta', 'ktm', 'kawasaki', 'ducati', 'harley-davidson', 'husqvarna', 'triumph', 'aprilia', 'gasgas', 'sherco', 'royal enfield', 'cfmoto'];

// Feed models can be "q5 sportback s 40tdi quattro" or "2024 toyota vellfire hybrid": keep the model, move the rest to variant
const TWO_WORD_MODELS = { 'landcruiser prado': 'Prado', 'land cruiser': 'LandCruiser', 'model y': 'Model Y', 'model 3': 'Model 3', 'model s': 'Model S', 'model x': 'Model X', 'yaris cross': 'Yaris Cross', 'cx 3': 'CX-3', 'cx 30': 'CX-30', 'cx 5': 'CX-5', 'cx 60': 'CX-60', 'cx 8': 'CX-8', 'cx 9': 'CX-9', 'mg 4': 'MG4', 'mg 5': 'MG5' };
const MODEL_NAMES = { cx60: 'CX-60', cx5: 'CX-5', cx30: 'CX-30', cx3: 'CX-3', cx8: 'CX-8', cx9: 'CX-9', hilux: 'HiLux', rav4: 'RAV4', 'x-trail': 'X-Trail', 'd-max': 'D-Max', 'bt-50': 'BT-50', 'mx-5': 'MX-5', 'cr-v': 'CR-V', 'hr-v': 'HR-V', hrv: 'HR-V', crv: 'CR-V', landcruiser: 'LandCruiser', 't-roc': 'T-Roc', mg4: 'MG4', mg5: 'MG5', mg3: 'MG3', zst: 'ZST', zs: 'ZS', i30n: 'i30 N', i30: 'i30', y: 'Model Y' };

const titleCase = s => s && s === s.toLowerCase() ? s.replace(/(^|[\s-])([a-z])/g, (m, a, b) => a + b.toUpperCase()) : s;

function splitModel(rawModel, make, rawVariant) {
  if (!rawModel) return { model: null, variant: rawVariant || null };
  let m = String(rawModel).replace(/[•|(),]/g, ' ').replace(/\b(19|20)\d\d\b/g, ' ');
  if (make) m = m.replace(new RegExp(`\\b${make.replace(/[-]/g, '[- ]?')}\\b`, 'ig'), ' ');
  m = m.replace(/\s+/g, ' ').trim();
  const lower = m.toLowerCase();
  for (const [k, v] of Object.entries(TWO_WORD_MODELS)) {
    if (lower === k || lower.startsWith(k + ' ')) return { model: v, variant: rawVariant || titleCase(m.slice(k.length).trim()) || null };
  }
  const [first, ...rest] = m.split(' ');
  const key = first.toLowerCase();
  const model = MODEL_NAMES[key] || MODEL_NAMES[key.replace(/-/g, '')] || titleCase(first);
  return { model, variant: rawVariant || titleCase(rest.join(' ')) || null };
}

// Pull a seller's number / email out of free text ("call 0412 345 678", keycap emoji digits)
function contactFromText(text) {
  const t = String(text || '').replace(/️?⃣/g, '').replace(/️/g, '');
  const phone = t.match(/(?:\+?61\s?|0)4\d{2}[\s.-]?\d{3}[\s.-]?\d{3}/)?.[0] || null;
  const email = t.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] || null;
  return { phone, email };
}

export function normaliseMake(raw) {
  if (!raw) return null;
  const m = String(raw).trim().toLowerCase();
  return MAKE_NAMES[m] || m.replace(/\b\w/g, c => c.toUpperCase());
}

// Australian numbers → E.164 (+61...). Returns null if it doesn't look like a phone.
export function normalisePhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d.length >= 11 ? d : null;
  if (d.startsWith('61')) return '+' + d;
  if (d.startsWith('0') && d.length === 10) return '+61' + d.slice(1);
  if (d.length === 9 && d.startsWith('4')) return '+61' + d;
  return null;
}

export function normaliseEmail(raw) {
  if (!raw) return null;
  const e = String(raw).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).toLowerCase().replace(/,/g, '').trim();
  const k = s.match(/^\$?\s*([\d.]+)\s*k\b/); // "45k"
  if (k) return Math.round(parseFloat(k[1]) * 1000);
  const n = s.match(/[\d.]+/);
  return n ? Math.round(parseFloat(n[0])) : null;
}

function parseCondition(raw, text) {
  const s = `${raw || ''}`.toLowerCase();
  const t = `${text || ''}`.toLowerCase();
  // Facebook's own condition values first, then free-text hints
  if (/new|excellent|like new|immaculate|mint/.test(s)) return 'Excellent';
  if (/good/.test(s)) return 'Good';
  if (/fair/.test(s)) return 'Fair';
  if (/poor|salvage/.test(s)) return 'Poor';
  if (/immaculate|like new|mint condition|showroom/.test(t)) return 'Excellent';
  if (/needs work|rough|tired/.test(t)) return 'Fair';
  return raw ? String(raw) : 'Unknown';
}

function parseLocation(loc, listing) {
  if (!loc) loc = {};
  if (typeof loc === 'string') {
    // "Parramatta, NSW 2150" or "Parramatta, NSW"
    const pc = loc.match(/\b(\d{4})\b/);
    const st = loc.match(/\b(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b/i);
    loc = { suburb: loc.split(',')[0].trim(), state: st?.[1]?.toUpperCase(), postcode: pc?.[1] };
  }
  return {
    suburb: loc.suburb || loc.city || listing.suburb || listing.city || null,
    state: (loc.state || listing.state || '').toUpperCase() || null,
    postcode: String(loc.postcode || listing.postcode || '') || null,
  };
}

// Pull year / make / model out of a title like "2021 Toyota RAV4 GX Hybrid"
function parseTitle(title) {
  const out = {};
  if (!title) return out;
  const y = title.match(/\b(19[89]\d|20[0-4]\d)\b/);
  if (y) out.year = parseInt(y[1]);
  const lower = title.toLowerCase();
  for (const make of MAKES) {
    const idx = lower.search(new RegExp(`\\b${make}\\b`));
    if (idx >= 0) {
      out.make = normaliseMake(make);
      const rest = title.slice(idx + make.length).trim().split(/\s+/);
      if (rest[0]) out.model = rest[0];
      if (rest.length > 1) out.variant = rest.slice(1).join(' ');
      break;
    }
  }
  return out;
}

export function leadIdFor(raw, source) {
  const key = raw.listing_id || raw.id || raw.url || `${raw.title}|${raw.price}|${raw.seller?.name}`;
  return 'LD' + crypto.createHash('sha1').update(`${source}|${key}`).digest('hex').slice(0, 10).toUpperCase();
}

// Raw feed item → normalised listing (vehicle + seller + location)
export function normaliseListing(raw, source = 'facebook_marketplace') {
  const fromTitle = parseTitle(raw.title);
  const seller = raw.seller || {};
  const text = `${raw.title || ''}\n${raw.description || ''}`;
  const flagText = stripNegated(text);

  const flags = RISK_FLAGS.filter(f => f.re.test(flagText)).map(f => f.flag);
  if (seller.is_dealer) flags.push('dealer');

  // A make like "Honda HRV" or "MG3 , AUTO, Good Mechanically" means the feed mis-split the title
  const rawMake = raw.make && /^[a-z-]+$/i.test(String(raw.make).trim()) ? raw.make : null;
  const make = normaliseMake(rawMake) || fromTitle.make || null;
  const { model, variant } = rawMake
    ? splitModel(raw.model, make, raw.variant || raw.trim)
    : { model: fromTitle.model ? (MODEL_NAMES[fromTitle.model.toLowerCase()] || fromTitle.model) : null, variant: fromTitle.variant || null };

  if (NOT_CAR_BODY.test(raw.body_type || '') || BIKE_MAKES.includes(String(make || '').toLowerCase())) flags.push('not_car');
  const found = contactFromText(raw.description);

  return {
    id: leadIdFor(raw, source),
    source: raw.source || source,
    sourceListingId: raw.listing_id || raw.id || null,
    url: raw.url || null,
    title: raw.title || null,
    description: raw.description || '',
    photos: raw.photos || raw.images || [],
    listedAt: raw.listed_at || null,
    vehicle: {
      year: toNumber(raw.year) || fromTitle.year || null,
      make,
      model,
      variant,
      km: toNumber(raw.odometer_km ?? raw.km ?? raw.mileage ?? raw.odometer),
      condition: parseCondition(raw.condition, text),
      bodyType: raw.body_type || null,
      transmission: raw.transmission || null,
      fuelType: raw.fuel_type || null,
      colour: raw.colour || raw.color || null,
      vin: raw.vin || null,
      rego: raw.rego || raw.registration || null,
    },
    askingPrice: toNumber(raw.price),
    location: parseLocation(raw.location, raw),
    seller: {
      name: seller.name || raw.seller_name || null,
      phone: normalisePhone(seller.phone || raw.seller_phone || raw.phone || found.phone),
      email: normaliseEmail(seller.email || raw.seller_email || raw.email || found.email),
      profileUrl: seller.profile_url || raw.seller_profile_url || null,
      isDealer: !!seller.is_dealer,
    },
    flags: [...new Set(flags)],
  };
}

// Hard filters — no point valuing something we'd never buy
export function checkCriteria(listing, now = new Date()) {
  const reasons = [];
  const v = listing.vehicle;
  const minYear = now.getFullYear() - CRITERIA.maxAgeYears;

  if (!v.year) reasons.push('Year unknown');
  else if (v.year < minYear) reasons.push(`Older than ${CRITERIA.maxAgeYears} years (${v.year})`);

  if (v.km === null || v.km === undefined) reasons.push('Kilometres unknown');
  else if (v.km > CRITERIA.maxKm) reasons.push(`Over ${CRITERIA.maxKm.toLocaleString()} km (${v.km.toLocaleString()})`);

  if (!v.make || !v.model) reasons.push('Make/model unknown');
  if (!listing.askingPrice) reasons.push('No asking price');

  if (listing.flags.includes('not_car')) reasons.push('Not a car');
  for (const f of RISK_FLAGS) {
    if (f.reject && listing.flags.includes(f.flag)) reasons.push(f.flag === 'dealer' ? 'Dealer listing' : `Flagged: ${f.flag.replace('_', ' ')}`);
  }

  return { pass: reasons.length === 0, reasons };
}
