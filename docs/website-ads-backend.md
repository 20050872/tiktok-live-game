# Website Advertising Backend

This branch adds the first backend layer for website-only ads. Existing publisher accounts, licenses, game sessions, Socket.IO events and the existing Shopier license callback remain separate.

## Account rules

- Advertiser signup creates a `PENDING` account.
- Only an administrator can change the account to `ACTIVE`.
- The advertiser's first campaign is created as `PENDING_REVIEW`.
- After the first campaign is approved, later campaigns do not require a second content review. They remain non-serving until payment is confirmed.
- Campaign serving requires `ACTIVE` status and an eligible date/budget window.

## API

Advertiser:
- `POST /api/advertisers/register` — { email, companyName, contactName, password }
- `POST /api/advertisers/login` — { email, password }; returns a bearer token
- `GET /api/advertiser/me` — bearer token required
- `GET /api/advertiser/campaigns` — bearer token required
- `POST /api/advertiser/campaigns` — bearer token required; { name, headline, description?, imageUrl, targetUrl, placement, billingModel, budget? }

Public website:
- `GET /api/ads/serve?placement=HOME_TOP|HOME_MIDDLE|GAME_PAGE|SPONSOR_GRID`
- `POST /api/ads/impression` — { campaignId, placement }
- `POST /api/ads/click` — { campaignId, placement }; returns the validated campaign destination

Admin (send `x-admin-secret` or Bearer token matching `ADMIN_SECRET`):
- `GET /api/admin/ads/advertisers`
- `PATCH /api/admin/ads/advertisers` — { id, action: "approve"|"reject" }
- `GET /api/admin/ads/campaigns`
- `PATCH /api/admin/ads/campaigns` — { id, action: "approve"|"reject"|"pause"|"activate" }

## Environment

- `ADMIN_SECRET` — required for admin ad endpoints; there is no insecure development fallback in this module.
- `AD_MONTHLY_PRICE_TRY` — monthly fixed price in TRY (default 2500).
- `AD_CPM_PRICE_TRY` — price per 1,000 eligible impressions in TRY (default 100).
- `AD_TRACKING_SALT` — recommended private random value for visitor hashing. If omitted, a server secret is used as a fallback.

## Payment integration boundary

Campaign creation currently creates a pending payment ledger entry with a unique `AD-...` order ID. A campaign cannot be served until its payment is marked `PAID`. The existing Shopier callback is intentionally not repurposed for ad orders in this first backend pass: its current responsibility is license fulfillment. A dedicated, signature-verified ad payment flow and checkout URL configuration must be added before accepting advertiser payments in production.

## Deployment

The Prisma schema is additive. Generate Prisma Client and apply the schema to the Render PostgreSQL database during a controlled deployment. Back up the database first; do not run schema changes against production until the branch has passed build and integration tests.
