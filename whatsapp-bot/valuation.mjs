// ── MARKET VALUE ESTIMATE ──
// Order of preference:
//   1. AutoGrab (if AUTOGRAB_API_KEY is set) — real AU retail/trade data
//   2. Comparable listings — other ingested listings of the same make/model,
//      adjusted for year and kms, median taken
//   3. Nothing — lead is parked as "needs valuation" for a manual figure.
// We never make up a number: a wrong "below market" call means emailing the wrong sellers.

const { AUTOGRAB_API_KEY } = process.env;

const COMP_WINDOW_DAYS = 60;
const YEAR_ADJ = 0.07;     // ~7% value per model year
const KM_ADJ_PER_10K = 0.02; // ~2% value per 10,000 km

const median = arr => {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Adjust a comparable's asking price to what it'd be for the target's year + kms
function adjustComp(comp, target) {
  const yearDiff = target.year - comp.vehicle.year;
  const kmDiff = (comp.vehicle.km - target.km) / 10000;
  return comp.askingPrice * (1 + YEAR_ADJ * yearDiff) * (1 + KM_ADJ_PER_10K * kmDiff);
}

export function compValuation(listing, pool, now = new Date()) {
  const v = listing.vehicle;
  const cutoff = now.getTime() - COMP_WINDOW_DAYS * 86400000;

  const comps = pool.filter(c =>
    c.id !== listing.id &&
    c.askingPrice > 1000 &&
    c.vehicle?.year && c.vehicle?.km != null &&
    norm(c.vehicle.make) === norm(v.make) &&
    norm(c.vehicle.model) === norm(v.model) &&
    Math.abs(c.vehicle.year - v.year) <= 2 &&
    Math.abs(c.vehicle.km - v.km) <= 40000 &&
    !c.flags?.includes('written_off') &&
    new Date(c.firstSeenAt || now).getTime() >= cutoff
  );

  // Prefer same-variant comps when there are enough of them
  const sameVariant = v.variant ? comps.filter(c => norm(c.vehicle.variant) === norm(v.variant)) : [];
  const used = sameVariant.length >= 3 ? sameVariant : comps;
  if (used.length < 3) return null;

  const adjusted = used.map(c => adjustComp(c, v));
  const mid = Math.round(median(adjusted) / 100) * 100;
  const sorted = adjusted.sort((a, b) => a - b);

  return {
    method: 'comparables',
    market: mid,
    low: Math.round(sorted[Math.floor(sorted.length * 0.25)] / 100) * 100,
    high: Math.round(sorted[Math.floor(sorted.length * 0.75)] / 100) * 100,
    compCount: used.length,
    compIds: used.map(c => c.id).slice(0, 20),
    confidence: used.length >= 8 ? 'high' : used.length >= 5 ? 'medium' : 'low',
  };
}

async function autoGrabValuation(listing) {
  const v = listing.vehicle;
  const headers = { ApiKey: AUTOGRAB_API_KEY, 'Content-Type': 'application/json' };

  const searchRes = await fetch('https://api.autograb.com.au/v2/vehicles/search', {
    method: 'POST',
    headers,
    body: JSON.stringify({ region: 'au', query: [v.year, v.make, v.model, v.variant].filter(Boolean).join(' ') }),
  });
  const vehicleId = (await searchRes.json()).results?.[0]?.id;
  if (!vehicleId) return null;

  const condition_score = { Excellent: 5, Good: 3, Fair: 2, Poor: 1 }[v.condition] || 3;
  const valRes = await fetch('https://api.autograb.com.au/v2/valuations/predict?features=bounds', {
    method: 'POST',
    headers,
    body: JSON.stringify({ region: 'au', vehicle_id: vehicleId, kms: v.km, condition_score }),
  });
  const val = await valRes.json();
  if (!val.prediction) return null;

  return {
    method: 'autograb',
    market: Math.round(val.prediction.retail_price),
    trade: Math.round(val.prediction.trade_price),
    low: Math.round(val.bounds?.retail?.lower || val.prediction.retail_price * 0.92),
    high: Math.round(val.bounds?.retail?.upper || val.prediction.retail_price * 1.08),
    confidence: val.prediction.score >= 0.8 ? 'high' : 'medium',
  };
}

// Returns { valuation, discountPct } — valuation is null when we can't value it
export async function valueListing(listing, pool) {
  let valuation = null;
  if (AUTOGRAB_API_KEY) {
    try {
      valuation = await autoGrabValuation(listing);
    } catch (err) {
      console.error('AutoGrab valuation failed, falling back to comps:', err.message);
    }
  }
  if (!valuation) valuation = compValuation(listing, pool);
  if (!valuation) return { valuation: null, discountPct: null };

  valuation.valuedAt = new Date().toISOString();
  return { valuation, discountPct: discountFor(listing.askingPrice, valuation.market) };
}

export function discountFor(askingPrice, market) {
  if (!askingPrice || !market) return null;
  return Math.round(((market - askingPrice) / market) * 1000) / 10; // one decimal, positive = below market
}
