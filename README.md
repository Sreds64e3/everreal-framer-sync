# EverReal → Framer CMS Sync

A Node.js integration that synchronizes active property listings from the **EverReal** real estate platform into a **Framer CMS** collection, keeping a live property website up to date without manual data entry.

Built for [Frank Borgmann Immobilien](https://www.borgmann-immobilien.de) (or link if public), a real estate agency using Framer as its website platform.

## What it does

Property listings live in EverReal, the agency's source-of-truth system. This script bridges that data into the Framer CMS collection that powers the website's homepage, buy/rent search pages, and individual property detail pages — so listings stay current without anyone manually copying data between systems.

On each run, the sync:

1. Authenticates against EverReal via OAuth2 (password grant)
2. Queries EverReal's GraphQL reporting endpoint for active, non-archived listings
3. Fetches the Framer CMS collection schema and maps EverReal fields to Framer's internal field IDs
4. Upserts each listing — creating new CMS items, updating existing ones (matched by EverReal listing ID)
5. Marks listings no longer returned by EverReal as inactive (`isActive: false`, `status: "INACTIVE"`) rather than deleting them
6. Publishes and deploys the Framer project if any changes were made

## Architecture

```
EverReal GraphQL API
   ↓ OAuth2 password grant → bearer token
   ↓ query active, non-archived listings
Node.js sync script (Vercel serverless function)
   ↓ map fields → Framer CMS field IDs
   ↓ upsert via Framer Server API
Framer CMS "Listings" collection
   ↓ publish() → deploy()
Live property website
```

## Tech stack

- **Node.js**, deployed as a **Vercel serverless function**
- **EverReal GraphQL reporting API** — listing data source
- **Framer Server API** (`framer-api` npm package) — CMS writes, publish, and deploy
- **axios** for HTTP/GraphQL requests
- Scheduled via an external cron service (**cron-job.org**), triggering the endpoint every 6 hours — chosen after hitting Vercel Hobby's once-daily cron limit

## Key implementation details

- **Upsert key**: EverReal's listing UUID, stored in a dedicated `id` field on each Framer CMS item, used to match records across runs
- **Non-destructive removal**: delisted properties are flagged inactive instead of deleted, preserving history
- **Generated fields**: `virtualTourLink` is derived from the listing ID rather than pulled directly from EverReal
- **Per-listing error isolation**: a failure on one listing is logged and skipped; it doesn't stop the rest of the batch
- **Token handling**: OAuth token is re-requested on every run, so there's no separate refresh/expiry logic to maintain

## Known limitations

- **Not real-time** — scheduled batch sync (every 6 hours), not event-driven
- **Images are not synced** — image fields are intentionally left null; this was a deliberate scope decision, not an oversight
- **No pagination** — the query fetches up to 1,000 listings in a single request; agencies with a larger active inventory would need pagination added
- **No retry logic** — failed listings are logged, not retried, on the next scheduled run

## Status

The sync logic, field mapping, and publish/deploy calls are implemented and have run successfully against live data (29–31 listings synced in testing). This repo covers the sync layer only — it does not include or modify the Framer website's frontend, property cards, or detail page templates.
