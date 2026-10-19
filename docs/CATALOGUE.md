# Website catalogue workspace

Entry: **https://manager.electricemporium.in/catalogue/**, also available through the owner’s Catalogue menu in ShopManager.

Sign in with the existing website admin account. This is the same owner identity checked by `admin-products`; shop staff PINs do not grant website publishing access.

## Daily use

1. Import manufacturer/supplier links, an Excel/CSV spreadsheet, or existing EE Lens products; or choose New product.
2. Review the name, model, variant, category, customer photos, selling price and availability. Blank price means “Call for price”. Imported prices always need review.
3. Save draft or close the editor to save. Preview is private. Publish makes the saved snapshot visible on the website; later edits remain private until Publish update.

Use the table’s Drafts, Needs attention and Changes to publish views. Select rows to change category or publish/unpublish in bulk. Individual failures remain selected and display their reason.

URLs are saved in the database before fetching. Resume / retry processes unfinished entries. A source website can refuse automated access: a failed link stays in the queue and manual/spreadsheet import is available. The importer reads supplied HTML, never executes source-page scripts, and checks DNS, URLs and redirects against private-address access.

Excel imports the first sheet, up to 1,000 product rows and 5 MB. Supported headers are in the downloadable template. Existing products are skipped on exact normalized brand/model/colour/size matches. EE Lens imports use only the `catalogue` photo role; recognition/shop photos never enter website drafts.

Link shop stock only after identifying the exact item(s). Read linked stock updates the draft’s availability; Publish applies it to the website. This is an explicit refresh, not a background stock synchronization job. No automatic name matching or stock/price overwrites occur.

## Implementation and access

- Static workspace: `catalogue/`, plain HTML/CSS/JS, reuses the existing EE Lens parser and photo compression.
- Backend: `supabase/functions/catalogue-manager/index.js`, deployed to **dnmzzckeuctnkqbphwdg**, the website project. Do not deploy its migration to the operations project.
- New tables: `public.catalogue_drafts` and `public.catalogue_imports`, RLS enabled, no client privileges or policies. Only the owner-verified Edge Function accesses them using its server credential. The linter’s “RLS enabled, no policy” information is expected for these service-only tables.
- Draft images: private `catalogue-drafts` bucket. One-hour signed previews; compressed, checksum-verified JPEGs. Publish copies selected images to the existing public bucket.
- The owner must pass Supabase Auth verification and match user ID `21e0db6b-373f-4793-93ac-b82ba79e569d`. `verify_jwt` stays enabled. No secrets are shipped to the browser.
- `catalogue_save` checks revisions; duplicate keys do not overwrite an existing product. `catalogue_publish` updates the product, image rows, variants and publication state in one transaction; retries retain the same website ID. Unpublish applies the visibility boundary to products and child rows. Previously public image URLs remain public assets.
- Existing website products retain their IDs and URLs. The existing storefront code reads the published rows through RLS, so no storefront deployment is required.
- The original AdminPanel remains available, but edit website products in the new workspace to avoid having two independent editors change the same listing.

## Verification

- `node scripts/run-tests.cjs`: shop regression suite plus catalogue validation, CSV, image ownership, URL protection, auth rejection and combined browser-script parsing.
- `node scripts/check-catalogue-browser.cjs`: requires Playwright and a local static server; set `PLAYWRIGHT_MODULE` to its installed package path if needed. Intercepts **all** Supabase calls; does not write production data. Covers save/preview/publish/unpublish, failed-save recovery, import retries, required review, real image compression/upload path, bulk updates, Excel input and mobile layout.
- `npx deno run -A scripts/check-catalogue-network.mjs`: read-only public page/image and EE Lens connectivity check.
- `sql/catalogue/verification.sql`: transaction-only database rehearsal, ends in rollback. Checks atomic publication, repeat publication, stale-revision rejection, private drafts and unpublished parent/child rows.

The migration preserved all 43 original website products. Original-row checksum (excluding new `is_published` column) before and after: `93c4a70816523b61c438bf51524524cb`.

## Deploy and rollback

Deploy the website database migration and catalogue function first, then dispatch the normal ShopManager Pages workflow. Both deploy and rollback workflows package `catalogue/`; the service worker includes it in the shell and uses its own page for catalogue offline navigation. Offline UI does not imply offline publishing.

The pre-catalogue frontend commit is `56e7c30fd9bb6e1c3e4f0cfcc174eda53f79af7b`. Revert the frontend with the existing Pages rollback workflow if needed. The additive database migration can remain; do not drop draft tables or remove publication policies during a rollback because doing so could lose drafts or expose unpublished products. Keep the catalogue function available until any unfinished drafts are recovered.
