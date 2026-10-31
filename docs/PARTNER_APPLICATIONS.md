# Getting live access to the point of sale systems

What each system needs before Totali can read its staff, hours and tips directly, who has to apply, and what to say. Nothing here has been submitted. Applications are made in the company's name by someone who can sign for it, and some are agreements with fees, so they are yours to send. Everything below is ready to paste.

Details marked **unverified** came from third-party sites, not the vendor's own documentation. Check them with the vendor before you rely on them.

## Where each one stands

| System | What Totali has | What's needed from the vendor | Who it blocks |
| --- | --- | --- | --- |
| Toast | Done for a restaurant's own API credentials (made in Toast Web). Not tested live. | Optional: partner status, so a restaurant doesn't have to make credentials | Nobody yet |
| Square | Done. Not tested live. | Optional: register Totali as an OAuth app, so owners click instead of pasting a token | Nobody yet |
| 7shifts | Done. Not tested live. | Nothing | Nobody |
| Clover | Done, including sign-in and token renewal. Not tested live. | An approved Clover production developer account and an approved app | **Every Clover restaurant** (Clover is the largest among small restaurants) |
| Lightspeed K-Series | Nothing | Partner approval, then API credentials | Lightspeed restaurants |
| Revel | Nothing | Approved integration access (API key and secret) | Revel restaurants |
| Aloha (NCR Voyix) | Nothing | NCR partner program and certification | Aloha restaurants |
| TouchBistro | Nothing | Integration partner approval | TouchBistro restaurants |
| SpotOn | Nothing | Developer access through a SpotOn rep | SpotOn restaurants |

Every system above can still be used today through *Import a time clock report*.

## Do these first, they block most applications

1. **Put the site on a real address.** Deploy to Render (`render.yaml`), set `PUBLIC_BASE_URL`. Every OAuth app needs a live site URL and redirect.
2. **Have the Terms of Service and Privacy Policy reviewed by a lawyer and published.** The pages at `/terms` and `/privacy` are drafts nobody has read. Clover reviews these and says generic boilerplate is grounds to send an app back.
3. **A support address and phone number** that someone answers. Clover requires support contact details on the app.
4. **A short screen recording** of the read-only flow: Settings, Point of sale, connect, pull a pay period, the people matching screen. Clover asks for one.
5. **The company's legal details:** legal name (OMNIA TAX LLC), address, state of formation, a named signatory, a technical contact.

## Say this (all applications)

> **Totali** (a product of OMNIA TAX LLC) is payroll software for restaurants. We are asking for **read-only** access to a restaurant's employee list, its time clock entries and the tips recorded on them, so the restaurant's hours and tips flow into payroll without anyone typing them twice.
>
> We do not take payments, change menus, edit orders, or write anything back. We read: employees (name, email), shifts or time entries (clock in, clock out, breaks, job), and tips (card and cash) attached to those shifts. We do not read card numbers or customer data.
>
> Access is granted by the restaurant owner, who can disconnect at any time. Credentials and tokens are stored encrypted on our server and are never shown in the browser. Employee Social Security numbers and bank details are encrypted at rest.
>
> The integration is built and tested against your published API. We would like sandbox credentials, then production approval.

Add to this where a form asks: expected number of locations in the first year, support contact, a link to the Privacy Policy and Terms, and the demo video.

## Clover

**Program:** Clover Developer Dashboard. Source: [Get approvals for your Clover production account and your app](https://docs.clover.com/dev/docs/approval), [Submit your app for approval](https://docs.clover.com/dev/docs/gdp-submit-your-app-for-approval).

1. Make a Clover developer account, then request **production developer account** approval. Clover approves the account before it reviews any app.
2. Create the app. In the app's settings:
   - **Permissions:** Read employees, Read payments. (If permissions are added later, merchants must reinstall.)
   - **Site URL and redirect:** `https://YOUR-SITE/v1/pos/clover/callback`. The redirect must match the registered Site URL exactly.
   - **OAuth:** expiring tokens from the v2 flow, which is what Totali uses.
3. Listing items: app name, tagline, description, icon, support contacts, two or more benefits, at least one screenshot, a demo video.
4. Legal: a privacy policy and terms of service specific to the app (not generic).
5. Review: Clover checks the video, description, permissions, and then the legal documents. Statuses run Pending, Under review, Changes Required, Approved, Published.
6. When approved, set `CLOVER_APP_ID` and `CLOVER_APP_SECRET` on the server. The *Sign in with Clover* button appears by itself. Totali is already built to hand off, exchange the code, store the tokens encrypted and renew them.

Still to confirm once you have a sandbox: whether a shift's `cashTipsCollected` is in cents, Clover's filter syntax for `in_time`, and that a list response always comes back as `{ elements: [...] }`.

## Lightspeed Restaurant (K-Series)

**Program:** Lightspeed Partner Program. **Unverified** from third-party integrator guides:
1. Complete the **Partner Application** form. Once approved you are sent a form to request API credentials.
2. Or, for a single restaurant's own use: the merchant asks Lightspeed for **custom API access**, completes an API request form, and credentials go to the technical contact. Reported as a per-location add-on with read-only endpoints.
3. Ask your Lightspeed Partner Services contact or the restaurant's Account Manager for the current form. We could not find the live link.

Once you have credentials and the API reference, send them to me and I'll write the adapter. A community description of the staff shifts endpoint is `GET /staff/v1/businessLocations/{id}/shift` with OAuth, but I haven't built it on that because it is not Lightspeed's own documentation.

## Revel

**Program:** Revel Integrated / API partner access. **Unverified:**
- Access is by request, not self-serve. Integrators email Revel's partner setup team with the restaurant's Revel URL and establishment numbers, signed off by an authorized representative. Approval reported at 2 to 5 business days.
- Revel gives an **API key and secret** per account, sent in an `API-AUTHENTICATION` header as `key:secret`.
- Revel's enterprise integrations page lists a sales line for integration inquiries: +1 (833) 437-3835.
- Revel is reported to be part of Shift4 now.

## Aloha (NCR Voyix)

**Program:** NCR Voyix developer portal (developer.ncrvoyix.com), partner program with certification per integration type. **Unverified:** access is partner-gated, with per-location fees (one source claims a share of revenue; confirm before agreeing to anything). Aloha Cloud has REST APIs over OAuth. Older on-premises Aloha sites export files instead, which the report import already handles.

Ask NCR which API exposes labor and time clock data for Aloha Cloud, and whether read-only labor access needs full certification.

## TouchBistro

**Program:** integration partner program, private API. **Unverified:** there is no public developer portal. One directory lists `integratedpartners@touchbistro.com` as the contact; confirm it on TouchBistro's own site. Access comes with negotiated terms and monitored API keys.

## SpotOn

**Program:** SpotOn developer center (reported at developers.spoton.com). **Unverified:** keys are set up through a sales representative or customer success manager, per API and per venue. A *Restaurant POS Export API* is reported, read-oriented, authenticated with an `x-api-key` header. A restaurant that is already a SpotOn customer can ask its own rep for API access to its venue.

## Toast (optional, for a smoother setup)

What exists works without a partnership: a restaurant makes **standard API access** credentials in Toast Web and pastes them in. Becoming a Toast integration partner would let owners connect without making credentials, and Toast's help centre has an article titled "Become a Toast Integration Partner" that I could not open. Toast documents that a restaurant's relationship with an integration partner is separate from its relationship with Toast, and one third-party page says restaurants pay a *Toast Partner Connect* fee to enable third-party integrations.

## Square (do this, it is self-serve)

Sign in with Square is built. To switch it on:
1. In the Square Developer Dashboard, create an application.
2. On its OAuth page set the redirect URL to `https://YOUR-SITE/v1/pos/square/callback`.
3. Copy the production Application ID and Application Secret to the server as `SQUARE_APP_ID` and `SQUARE_APP_SECRET`.
4. The *Sign in with Square* button appears by itself. Totali asks for `EMPLOYEES_READ`, `TIMECARDS_READ`, `PAYMENTS_READ` and `MERCHANT_PROFILE_READ`, and renews the 30-day token before it runs out.

A restaurant with more than one Square location can't use the button yet; it has to use an access token and enter the location ID.

## What I can't do for you

I can't submit any of these. Each is an application in the company's name that someone has to sign, and several carry fees or terms. I also can't pass identity or phone checks, or record the demo video. When you have credentials or documentation from any vendor, send them over and I'll build and test the adapter the same day.
