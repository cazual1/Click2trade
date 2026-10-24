# Click2Trade WhatsApp Bot

AI-powered car selling assistant via WhatsApp. Users text in their car details, get an instant valuation, then the AI agent contacts dealers and negotiates the best price.

The same server also runs the **acquisition pipeline**: buying under-market cars from private sellers.

## Acquisition pipeline

```
Scraping agent (daily) ──POST /api/listings/ingest──▶ normalise ─▶ buy criteria ─▶ valuation ─▶ approval queue
                                                     (listings.mjs)  (≤5yr, ≤80k km)  (valuation.mjs)   /admin
                                                                                                          │ approve
Seller SMS / email replies ◀──────────── Twilio SMS / Resend email ◀──────────────────────────────────────┘
   /sms-inbound, /inbound-email ──▶ conversation thread + AI-suggested replies ──▶ deal pipeline (steps 4–16)
```

| Step | Where |
|------|-------|
| 1. Scan platforms | The scraping agent. Feed format is in [LISTING_FEED.md](LISTING_FEED.md) |
| 2. Find under-market cars | `listings.mjs` filters (age, km, write-offs, dealers); `valuation.mjs` estimates market value (AutoGrab, else comparable listings, else manual) |
| 3. Intro email / SMS | Drafted automatically, sent only after you approve it in `/admin` |
| 4–5. Negotiate, agree | Conversation thread in `/admin`, "AI suggest" drafts replies (never auto-sent), record max buy and agreed price |
| 6–7. Agreement, inspection | Deal fields in `/admin` |
| 8. Documents | Checklist: rego, licence and bank details; GST tax invoice if company-owned; payout letter, checked to be valid ≥14 days past the sale date, if finance is owing |
| 9–16. DMS → on-sell → pay → invoice → transport → dealer payment → delivered | Stage tracking with guards: no stage past 8 until documents are complete, no seller payment until a buying dealer is recorded, alert when dealer payment is over 72h past the invoice |

Run it:
```bash
cp .env.example .env    # set INGEST_API_KEY, ADMIN_TOKEN, Twilio SMS number, Resend, dealer licence
npm run dev
npm run ingest -- sample-listings.json   # load the sample feed
open http://localhost:3000/admin          # enter ADMIN_TOKEN
```

Webhooks to configure:
- Twilio SMS number → "A message comes in" → `POST https://<server>/sms-inbound`
- Resend inbound (domain `INBOUND_DOMAIN`) → `POST https://<server>/inbound-email`. Seller replies come to `lead-<id>@...`, dealer quotes to `quote-...@...`

Storage: Supabase `leads` / `suppressions` tables (schema at the top of `store.mjs`) if `SUPABASE_URL` is set, otherwise `data/leads.json`.
On Railway/Render the local disk is wiped on redeploy, so use Supabase or a persistent volume in production.

Compliance: intro messages identify the business and dealer licence and carry an opt-out. STOP/unsubscribe replies are suppressed permanently (Spam Act 2003).

## Architecture

```
User (WhatsApp) → Twilio → Express Webhook → Claude API (conversation)
                                            → AutoGrab API (valuation)
                                            → Dealer outreach (future)
                                            → Supabase (state + deals)
```

## Setup (15 minutes)

### 1. Twilio WhatsApp Sandbox (for testing)

1. Create a Twilio account at [twilio.com](https://www.twilio.com)
2. Go to **Messaging → Try it out → Send a WhatsApp message**
3. Follow the instructions to join the sandbox (send "join [word]" to the Twilio number)
4. Set the webhook URL to `https://your-domain.com/webhook` (POST)
5. Copy your Account SID and Auth Token

### 2. Deploy

```bash
# Clone and install
git clone https://github.com/cazual1/click2trade-whatsapp.git
cd click2trade-whatsapp
npm install

# Set environment variables
cp .env.example .env
# Fill in your keys

# Run locally
npm run dev

# Expose locally with ngrok (for Twilio webhook)
ngrok http 3000
# Copy the https URL → Twilio Console → WhatsApp Sandbox → Webhook URL
```

### 3. Deploy to Production

**Railway (recommended):**
```bash
# Install Railway CLI
npm i -g @railway/cli
railway login
railway init
railway up
```

**Render:**
- Connect GitHub repo → Auto-deploy on push
- Set environment variables in dashboard

### 4. Go Live with WhatsApp Business API

For production (not sandbox), you need:
1. Meta Business account verified
2. WhatsApp Business API access via Twilio
3. A dedicated phone number
4. Message template approval for outbound messages

## Conversation Flow

```
User: "Hey I want to sell my car"
Bot:  Welcome message, asks what car

User: "2022 Toyota RAV4, 45000km, good condition, 2000"
Bot:  Confirms details, generates AI valuation
      → Low: A$38,200 | Market: A$42,400 | High: A$47,500

User: "Yeah find me buyers"
Bot:  AI agent contacts 10-15 dealers...
      → 6 offers received, highest A$44,800

User: "Yes negotiate"
Bot:  AI sends counter-offers using competing bids...
      → Best offer improved to A$46,200 (+A$1,400)

User: "1"
Bot:  Offer accepted! Connects buyer and seller.
```

## Key Commands

- **"start over"** / **"reset"** — Reset conversation
- **"how does it work"** — Explains the process
- **1, 2, 3** — Accept a final offer by number

## Replacing Mock Data with Real APIs

### AutoGrab Valuation
Replace `generateValuation()` in server.mjs with:

```javascript
async function getAutoGrabValuation(vehicle) {
  // Step 1: Search for vehicle ID
  const searchRes = await fetch('https://api.autograb.com.au/v2/vehicles/search', {
    method: 'POST',
    headers: { 'ApiKey': AUTOGRAB_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      region: 'au',
      query: `${vehicle.year} ${vehicle.make} ${vehicle.model}`
    })
  });
  const searchData = await searchRes.json();
  const vehicleId = searchData.results[0]?.id;

  // Step 2: Get valuation
  const valRes = await fetch('https://api.autograb.com.au/v2/valuations/predict?features=bounds', {
    method: 'POST',
    headers: { 'ApiKey': AUTOGRAB_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      region: 'au',
      vehicle_id: vehicleId,
      kms: parseInt(vehicle.km),
      condition_score: { Excellent: 5, Good: 3, Fair: 2, 'Below Average': 1 }[vehicle.condition] || 3
    })
  });
  const valData = await valRes.json();

  return {
    low: valData.bounds?.trade?.lower || valData.prediction.trade_price,
    mid: valData.prediction.retail_price,
    high: valData.bounds?.retail?.upper || valData.prediction.retail_price * 1.1,
    trade: valData.prediction.trade_price,
    confidence: valData.prediction.score,
  };
}
```

### Real Dealer Outreach
Replace `generateMockQuotes()` with actual dealer contact logic — email via Instantly.ai, SMS via Twilio, or direct API calls to dealer networks.

## Supabase Schema

```sql
-- Sessions
create table whatsapp_sessions (
  id uuid default gen_random_uuid() primary key,
  phone text unique not null,
  step text default 'welcome',
  vehicle jsonb default '{}',
  valuation jsonb,
  quotes jsonb default '[]',
  final_offers jsonb default '[]',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Completed deals
create table deals (
  id uuid default gen_random_uuid() primary key,
  phone text not null,
  vehicle jsonb not null,
  accepted_offer jsonb not null,
  dealer_name text,
  dealer_contact text,
  status text default 'accepted',
  created_at timestamptz default now()
);
```

## Cost Estimate

| Component | Cost |
|-----------|------|
| Twilio WhatsApp | ~A$0.07/conversation (first 1000 free with Meta) |
| Claude API (Sonnet) | ~A$0.01-0.03 per conversation |
| Supabase | Free tier covers early stage |
| AutoGrab | Contact for pricing (est. A$200-500/mo) |
| **Total per sale** | **~A$0.50-1.00** |
