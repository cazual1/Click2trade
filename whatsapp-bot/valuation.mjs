// ── MARKET VALUE ESTIMATE ──
// Order of preference:
//   1. AutoGrab (if AUTOGRAB_API_KEY is set) — real AU retail/trade data
//   2. Comparable listings — other ingested listings of the same make/model,
//      adjusted for year and kms, median taken
//   3. AI estimate (if OPENAI_API_KEY is set) — labelled "AI estimate", low confidence,
//      so it's obvious in the dashboard that the figure needs checking before approving
//   4. Nothing — lead is parked as "needs valuation" for a manual figure.

import OpenAI from 'openai';

const { AUTOGRAB_API_KEY, OPENAI_API_KEY } = process.env;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const AI_VALUATION_DAYS = 7; // re-use an AI estimate for a week instead of asking again every day

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
  if (!valuation) {
    const prev = listing.valuation;
    const fresh = prev?.method === 'ai' && prev.km === listing.vehicle.km &&
      Date.now() - new Date(prev.valuedAt).getTime() < AI_VALUATION_DAYS * 86400000;
    if (fresh) return { valuation: prev, discountPct: discountFor(listing.askingPrice, prev.market) };
    try {
      valuation = await aiValuation(listing);
    } catch (err) {
      console.error('AI valuation failed:', err.message);
    }
  }
  if (!valuation) return { valuation: null, discountPct: null };

  valuation.valuedAt = new Date().toISOString();
  return { valuation, discountPct: discountFor(listing.askingPrice, valuation.market) };
}

export function discountFor(askingPrice, market) {
  if (!askingPrice || !market) return null;
  return Math.round(((market - askingPrice) / market) * 1000) / 10; // one decimal, positive = below market
}

// Asks for a typical Australian private-sale price. Deliberately not given the asking price,
// so the estimate isn't anchored to the number we're judging.
async function aiValuation(listing) {
  if (!openai) return null;
  const v = listing.vehicle;
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 150,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You estimate Australian used-car prices. Given a vehicle, return the typical PRIVATE-SALE price in AUD it would sell for today in Australia (not dealer retail, not trade-in).
Return JSON: {"market": number, "low": number, "high": number, "confidence": "low"|"medium"}.
Use "low" confidence if you are unsure of this exact model/variant/year. Return {"market": null} if you cannot estimate.`,
      },
      {
        role: 'user',
        content: [
          `${v.year} ${v.make} ${v.model} ${v.variant || ''}`.trim(),
          `${v.km?.toLocaleString()} km`,
          [v.transmission, v.fuelType, v.bodyType].filter(Boolean).join(', '),
          `Condition: ${v.condition}`,
          listing.location?.state ? `State: ${listing.location.state}` : '',
        ].filter(Boolean).join('\n'),
      },
    ],
  });
  const out = JSON.parse(response.choices[0].message.content);
  if (!out.market || out.market < 1000) return null;
  const round = n => Math.round(n / 100) * 100;
  return {
    method: 'ai',
    market: round(out.market),
    low: out.low ? round(out.low) : null,
    high: out.high ? round(out.high) : null,
    confidence: 'low', // never trusted above "low" — it's a starting point, not market data
    km: v.km,
  };
}
