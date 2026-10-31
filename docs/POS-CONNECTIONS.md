# Provider approval and payroll readiness

The restaurant workspace uses one connected labor source at a time. A connection alone does not unlock payroll: its last successful import must cover the entire selected pay period, with no unmatched employees or failed rows. Manual records outside that source must be reconciled first. CSV imports do not satisfy this requirement. Existing API-only employers without restaurant setup keep their existing workflow.

The dashboard shows company-scoped timecards, employee matching, minutes, reported card tips and cash tips. It does not import sales, orders or inventory. Source timestamps are shown when the provider supplies them; missing fields are identified rather than invented. Before approving a reviewed run, the server verifies that its connection, employee mapping, import summary and period timecards have not changed. Recalculate if they have.

## Production setup

Use `PUBLIC_BASE_URL` or Render's `RENDER_EXTERNAL_URL` for the canonical HTTPS site address. Merchant credentials are never entered in the restaurant connection UI. Provider app credentials belong in server environment variables only.

| Provider | Server configuration | Approval |
| --- | --- | --- |
| Square | `SQUARE_APP_ID`, `SQUARE_APP_SECRET` | Registered app redirect to `/v1/pos/square/callback` |
| Clover | `CLOVER_APP_ID`, `CLOVER_APP_SECRET` | Approved app redirect to `/v1/pos/clover/callback` |
| 7shifts | `SEVENSHIFTS_CLIENT_ID`, `SEVENSHIFTS_CLIENT_SECRET` | Partner OAuth client; configured callback `/v1/pos/sevenshifts/callback` |
| Toast | `TOAST_PARTNER_CLIENT_ID`, `TOAST_PARTNER_CLIENT_SECRET`, `TOAST_PARTNER_ENTRY_URL` | Approved partner account and an official Toast marketplace entry URL |

Square and Clover retain their existing token exchange and renewal. 7shifts redirects to its partner `generate_token` page. Its returned company grant GUID accompanies every API call as `x-company-guid`; a server client-credentials token alone never establishes a restaurant connection. The returned numeric company ID is checked against the grant's permitted companies. Read scopes only are requested. Short-lived tokens are renewed server-side and stored encrypted.

Toast does not use the same generic OAuth flow. The owner adds the approved integration in Toast and enters Totali's one-use connection reference as the marketplace Location ID. Totali checks `/partners/v1/restaurants` for exactly one authorized location with that `externalRestaurantRef`, then verifies labor API access before saving the connection. Approval can take 15 minutes or longer to propagate. A browser-supplied restaurant GUID is never accepted as approval. The integration's approved listing must actually offer this location reference configuration before enabling it.

OAuth state expires after 15 minutes, is single-use and bound to the company signed in at completion. Toast pending references expire after one hour. These pending requests are held in process memory; restarting the server requires starting connection approval again. Production connections and encrypted credentials are persisted in the store. Multi-instance deployments need shared pending-state storage before scaling beyond one instance.

No provider was tested against a live merchant account in this change. Unconfigured providers show connection details rather than a nonfunctional authorization button. App registration, partner approval and live-account validation are deployment prerequisites.

## Sources

- [Square authorization URLs](https://developer.squareup.com/docs/oauth-api/create-urls-for-square-authorization)
- [Clover OAuth](https://docs.clover.com/dev/docs/use-oauth)
- [7shifts partner OAuth](https://developers.7shifts.com/docs/oauth-authentication)
- [Toast accessible partner restaurants](https://dev.toasttab.com/doc/devguide/apiPartnersGettingAccessibleRestaurants.html)
- [Toast partner integration setup](https://support.toasttab.com/en/article/Set-Up-Toast-Partner-Integrations)

Visual direction: [NN/g on generic AI prototypes](https://www.nngroup.com/articles/ai-prototyping/) and [Carbon table guidance](https://github.com/carbon-design-system/carbon-website/blob/main/src/pages/components/data-table/usage.mdx). The implementation uses restrained surfaces, consistent hierarchy, direct task labels and full-width data tables with search and progressive disclosure.
