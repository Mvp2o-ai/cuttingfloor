---
'cuttingfloor': minor
---

cuttingfloor keeps its own credits. Balances move from Kazi's shared ledger into cuttingfloor's own credit ledger (`credit_accounts` and `credit_entries` in the record database): every change is an entry written once by its id, a clean copy is spent once and never past zero, and the balance always equals its entries. Our Stripe webhook credits packs and takes back refunds (only `metadata.app = cuttingfloor` payments), the account page credits a checkout as it returns, and automatic top-up runs here again. The Cutting Floor AI app's credits and App Store purchases are served on `/v1/credits` and `/v1/credits/apple`, with App Store Server Notifications at `/apple/notifications`. Tool activity is no longer sent to Kazi. `scripts/ledger-opening.ts` carries Kazi's hand-off over at the cutover and `scripts/ledger-reconcile.ts` checks it. The privacy policy names who keeps credits now.
