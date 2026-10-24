# Listing Feed — spec for the scraping agent

Once a day, send the listings you've collected to Click2Trade. Send **everything** you find
(not just bargains): every listing becomes a comparable that the valuation uses, so more data
means better "below market" calls. Re-sending a listing you sent yesterday is fine. It's matched
by `listing_id` / `url`, and price changes are tracked.

## How to deliver

**Option A — HTTP (preferred)**

```
POST https://<server>/api/listings/ingest
Authorization: Bearer <INGEST_API_KEY>
Content-Type: application/json
```

The response is a summary: `{ received, new, updated, priceDrops, skipped, byStage }`.
Max body 20 MB. Split the batch into several requests if it's bigger.

**Option B — file**

Write the same JSON to a file and run `npm run ingest -- path/to/listings.json` on the server.

## Format

```json
{
  "source": "facebook_marketplace",
  "scraped_at": "2026-10-24T06:00:00+10:00",
  "listings": [
    {
      "listing_id": "1234567890",
      "url": "https://www.facebook.com/marketplace/item/1234567890",
      "title": "2022 Toyota RAV4 GX Hybrid",
      "description": "One owner, full service history, finance owing...",
      "price": 36990,
      "year": 2022,
      "make": "Toyota",
      "model": "RAV4",
      "variant": "GX Hybrid",
      "odometer_km": 45000,
      "condition": "Good",
      "body_type": "SUV",
      "transmission": "Automatic",
      "fuel_type": "Hybrid",
      "colour": "White",
      "vin": null,
      "rego": null,
      "location": { "suburb": "Parramatta", "state": "NSW", "postcode": "2150" },
      "seller": {
        "name": "Jane Smith",
        "phone": "0412 345 678",
        "email": "jane@example.com",
        "profile_url": "https://www.facebook.com/marketplace/profile/...",
        "is_dealer": false
      },
      "photos": ["https://..."],
      "listed_at": "2026-10-23T09:12:00+10:00"
    }
  ]
}
```

### Required

`listing_id` or `url`, `price`, `odometer_km`, and enough to identify the car: `year` + `make` + `model`,
or a `title` like "2022 Toyota RAV4 GX" that they can be parsed from.

### Strongly wanted

- `seller.phone` / `seller.email`: sellers often put these in the description ("call 0412..."),
  so pull them out of the text. Without either, the seller can only be messaged manually on Marketplace.
- `seller.profile_url`: used for that manual Marketplace message.
- `description`: scanned for write-offs, hail and accident damage, missing rego, finance owing and dealer listings.
- `variant`: makes the valuation compare like with like.
- `location.postcode`

### Notes

- Numbers can be numbers or strings: `"$36,990"`, `"45k"` and `"45,000 km"` all parse.
- Australian phone formats are normalised to +61.
- A plain JSON array (no wrapper object) is also accepted.
- Unknown extra fields are ignored.

## What happens next

1. Listings older than `MAX_AGE_YEARS` (5), over `MAX_KM` (80,000 km), written off, or from dealers are rejected.
2. The rest are valued (AutoGrab if configured, otherwise comparable listings from this feed).
3. Cars at least `MIN_DISCOUNT_PCT` (5%) under market get an intro SMS/email drafted and land in
   the **Approve** queue at `/admin`. Nothing is sent until someone clicks approve.
