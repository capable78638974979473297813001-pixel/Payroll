# Provider approval and payroll readiness

The restaurant workspace uses one connected labor source at a time. A connection alone does not unlock payroll: its last successful import must cover the entire selected pay period, with no unmatched employees or failed rows. Manual records outside that source must be reconciled first. CSV imports do not satisfy this requirement. Existing API-only employers without restaurant setup keep their existing workflow.

The dashboard shows company-scoped timecards, employee matching, minutes, reported card tips and cash tips. It does not import sales, orders or inventory. Source timestamps are shown when the provider supplies them; missing fields are identified rather than invented. Before approving a reviewed run, the server verifies that its connection, employee mapping, import summary and period timecards have not changed. Recalculate if they have.

## Production setup

Use `PUBLIC_BASE_URL` or Render's `RENDER_EXTERNAL_URL` for the canonical HTTPS site address. Restaurant-owned access tokens and IDs can be entered in the guided connection dialog. Totali’s provider app credentials belong in server environment variables only. Each guide distinguishes the two.

| Provider | Server configuration | Approval |
| --- | --- | --- |
| Square | `SQUARE_APP_ID`, `SQUARE_APP_SECRET` | Registered app redirect to `/v1/pos/square/callback` |
| Clover | `CLOVER_APP_ID`, `CLOVER_APP_SECRET` | Approved app redirect to `/v1/pos/clover/callback` |
| 7shifts | `SEVENSHIFTS_CLIENT_ID`, `SEVENSHIFTS_CLIENT_SECRET` | Partner OAuth client; configured callback `/v1/pos/sevenshifts/callback` |
| Toast | `TOAST_PARTNER_CLIENT_ID`, `TOAST_PARTNER_CLIENT_SECRET`, `TOAST_PARTNER_ENTRY_URL` | Approved partner account and an official Toast marketplace entry URL |

Square and Clover retain their existing token exchange and renewal. 7shifts redirects to its partner `generate_token` page. Its returned company grant GUID accompanies every API call as `x-company-guid`; a server client-credentials token alone never establishes a restaurant connection. The returned numeric company ID is checked against the grant's permitted companies. Read scopes only are requested. Short-lived tokens are renewed server-side and stored encrypted.

Toast does not use the same generic OAuth flow. The owner adds the approved integration in Toast and enters Totali's one-use connection reference as the marketplace Location ID. Totali checks `/partners/v1/restaurants` for exactly one authorized location with that `externalRestaurantRef`, then verifies labor API access before saving the connection. Approval can take 15 minutes or longer to propagate. A browser-supplied restaurant GUID is never accepted as approval. The integration's approved listing must actually offer this location reference configuration before enabling it.

OAuth state expires after 15 minutes, is single-use and bound to the company signed in at completion. Toast pending references expire after one hour. These pending requests are held in process memory; restarting the server requires starting connection approval again. Production connections and encrypted credentials are persisted in the store. Multi-instance deployments need shared pending-state storage before scaling beyond one instance.

No provider was tested against a live merchant account in this change. Unconfigured approval flows open the guided restaurant credential form instead. App registration, partner approval and live-account validation are deployment prerequisites.

## Sources

- [Square authorization URLs](https://developer.squareup.com/docs/oauth-api/create-urls-for-square-authorization)
- [Clover OAuth](https://docs.clover.com/dev/docs/use-oauth)
- [7shifts partner OAuth](https://developers.7shifts.com/docs/oauth-authentication)
- [Toast accessible partner restaurants](https://dev.toasttab.com/doc/devguide/apiPartnersGettingAccessibleRestaurants.html)
- [Toast partner integration setup](https://support.toasttab.com/en/article/Set-Up-Toast-Partner-Integrations)

Visual direction: [NN/g on generic AI prototypes](https://www.nngroup.com/articles/ai-prototyping/) and [Carbon table guidance](https://github.com/carbon-design-system/carbon-website/blob/main/src/pages/components/data-table/usage.mdx). The implementation uses restrained surfaces, consistent hierarchy, direct task labels and full-width data tables with search and progressive disclosure.

## When every provider says setup is required

The server has not loaded complete provider app credentials. A restaurant's sign-in cannot issue Totali's application credentials. Create/register the production application first, set its issued ID and secret in the running Render service's Environment, and redeploy. Toast additionally needs its approved marketplace entry URL. Blueprint changes do not supply credentials or necessarily update an existing manually created service.

Square also accepts `SQUARE_APPLICATION_ID` and `SQUARE_APPLICATION_SECRET`; Clover accepts `CLOVER_CLIENT_ID` and `CLOVER_CLIENT_SECRET`. The documented `*_APP_*` names take precedence. Values are trimmed, and blank/partial pairs never enable a provider. Production startup warnings identify all four incomplete configurations by variable name without printing values. The restaurant connection dialog links provider-owned instructions and provides labeled credential fields. Provider app setup remains a server administration task.

Registering a developer account does not guarantee production or partner approval. Finish the provider's review and verify the first live restaurant approval before claiming an integration is live. Never replace credentials with placeholders, or mark a provider connected merely because a button was clicked.


## Restaurant credential entry

Every provider has a numbered guide, a link to its web dashboard, primary-source help links, and a field-specific explanation. When approval sign-in is configured it remains the primary action; “Use IDs and tokens instead” opens the same guided form. Without approval configuration, Connect opens that form directly.

| Provider | Fields in the restaurant dialog | Where to obtain them |
| --- | --- | --- |
| Square | Access token; optional Location ID; Environment | Developer Console → application → Production → Credentials; application → Locations |
| Clover | Merchant ID; merchant access token; Region | Merchant dashboard URL; an installed app’s production OAuth authorization |
| Toast | Client ID; Client secret; Restaurant GUID; Environment | Toast Web → Integrations → Toast API access → Manage credentials → Standard API; activation email or signed-in support for GUID |
| 7shifts | Access token; optional Company ID | Settings → Developer tools → Create Access Token; Resource IDs → Company ID |

These are restaurant credentials, not Totali’s application ID/secret. Clover production OAuth tokens may expire; this form does not turn test-merchant tokens into production tokens. Square personal tokens carry broad account access, so provider sign-in remains preferred. Toast requires an eligible plan and labor API access; Analytics-only credentials do not suffice. The guides do not promise access that the account lacks.

The owner explicitly submits “Verify and connect.” The existing authenticated server endpoint checks credentials before saving an encrypted connection, and returns no secret values. Secret inputs are masked with a Show/Hide control. No values go in local/session storage or URLs, and closing the dialog clears its inputs. Provider rejection leaves the form open with an error; it never displays a successful connection.

Guide content and links: `src/pos/guides.ts`. Checked against the official sources linked above, plus [7shifts token creation](https://kb.7shifts.com/hc/en-us/articles/8150346086163-How-To-Generate-an-Access-Token), [7shifts resource IDs](https://kb.7shifts.com/hc/en-us/articles/33063124722195-How-to-Find-Your-Location-ID-and-Company-ID), [Square credential types](https://developer.squareup.com/docs/build-basics/access-tokens), [Toast Standard API credentials](https://doc.toasttab.com/doc/devguide/devApiAccessCredentials.html), and [Toast restaurant GUID](https://support.toasttab.com/en/article/Locate-My-Restaurant-s-GUID).
