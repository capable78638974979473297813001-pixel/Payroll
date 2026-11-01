/** Merchant credential guides, checked against provider documentation on 2026-11-01. */
export interface ConnectionGuide {
  url: string;
  docs: Array<{ label: string; url: string }>;
  steps: string[];
  note: string;
  fields: Record<string, { hint: string; placeholder?: string }>;
}
export const CONNECTION_GUIDES: Record<'square' | 'clover' | 'toast' | 'sevenshifts', ConnectionGuide> = {
  square: {
    url: 'https://developer.squareup.com/apps',
    docs: [{ label: 'Square token instructions', url: 'https://developer.squareup.com/docs/build-basics/access-tokens' }],
    steps: [
      'Open Square Developer Console using the Square account that owns this restaurant. Open your application, or create one for your own account.',
      'Choose Production, then Credentials. Under Production Access token, select Show and copy the token into Access token below. An Application ID or Application secret will not work in this box.',
      'If your account has multiple locations, open the application’s Locations page and copy the correct Location ID into Location ID below. For one location, leave it blank.',
      'Keep Environment set to My real restaurant. Select Verify and connect. After verification, match employees and sync a pay period.',
    ],
    note: 'For your own Square account only. Personal tokens grant broad account access. Provider sign-in is preferred when enabled. Sandbox credentials cannot import real restaurant data.',
    fields: { accessToken: { hint: 'Paste Production → Credentials → Production Access token. Do not paste your Application ID or secret.', placeholder: 'Paste your Square access token' }, locationId: { hint: 'Copy from Developer Console → your application → Locations. Required when Square returns multiple locations.', placeholder: 'Paste Location ID, or leave blank' } },
  },
  clover: {
    url: 'https://www.clover.com/dashboard',
    docs: [{ label: 'Clover production authorization', url: 'https://docs.clover.com/dev/docs/use-oauth' }, { label: 'Find the Merchant ID', url: 'https://docs.clover.com/dev/docs/merchant-id-and-api-token-for-development' }],
    steps: [
      'Sign in to the Clover dashboard for the restaurant you want to connect. Copy the merchant identifier from the merchant dashboard address into Merchant ID below.',
      'Use the merchant access token issued by a Clover application installed and authorized for this restaurant. Copy that token into Access token below. Ask your integration administrator if you do not already have it.',
      'The authorized app needs read access to employees, shifts and payments. A Clover App ID, App Secret, public payment token or merchant account password is not a merchant access token.',
      'Select the restaurant’s region, then Verify and connect. If you have no production access token, use provider sign-in once Totali’s approved Clover app is enabled.',
    ],
    note: 'Clover’s test-merchant API Tokens instructions are for sandbox testing. This form uses production Clover hosts. Production OAuth tokens can expire; reconnect when Clover revokes or expires access.',
    fields: { merchantId: { hint: 'The identifier in the Clover merchant dashboard URL. Use the restaurant ID, not the Clover App ID.', placeholder: 'Paste your Clover Merchant ID' }, accessToken: { hint: 'An existing merchant OAuth access token from an authorized Clover app. App secrets and payment tokens do not work.', placeholder: 'Paste your Clover merchant access token' }, region: { hint: 'Choose the region where this Clover merchant account is registered.' } },
  },
  toast: {
    url: 'https://www.toasttab.com/login',
    docs: [{ label: 'Create Standard API credentials', url: 'https://doc.toasttab.com/doc/devguide/devApiAccessCredentials.html' }, { label: 'Find your restaurant GUID', url: 'https://support.toasttab.com/en/article/Locate-My-Restaurant-s-GUID' }],
    steps: [
      'Sign in to Toast Web with Manage Integrations permission. Go to Integrations → Toast API access → Manage credentials.',
      'Choose Create new credentials → Standard API. Name the credentials Totali payroll, select the restaurant location and available read scopes for employees and time entries, then confirm.',
      'Copy Client ID into Client ID below. Paste the issued Client secret into Client secret. Use credentials with Labor API access; Analytics-only credentials do not provide these timecards.',
      'Copy the location’s GUID from the API activation email into Restaurant GUID below. If you cannot find it, ask the support chat while signed in to Toast for that location’s restaurant GUID.',
      'Keep Environment set to My real restaurant, then select Verify and connect. If Standard API or labor access is missing, ask Toast about access for your plan.',
    ],
    note: 'Toast requires an eligible subscription for Standard API access. Use the restaurant GUID, not a marketplace Location ID or management-group ID. Do not rotate a secret already used by another integration just to copy it.',
    fields: { clientId: { hint: 'Copy Client ID from Toast Web → Manage credentials → your Standard API credential.', placeholder: 'Paste your Toast Client ID' }, clientSecret: { hint: 'Paste the client secret issued for the same credential set. This is not a Toast password.', placeholder: 'Paste your Toast client secret' }, restaurantGuid: { hint: 'Copy the restaurant location GUID from the activation email or signed-in Toast support chat.', placeholder: 'Paste your Toast restaurant GUID' } },
  },
  sevenshifts: {
    url: 'https://app.7shifts.com/',
    docs: [{ label: 'Create a 7shifts access token', url: 'https://kb.7shifts.com/hc/en-us/articles/8150346086163-How-To-Generate-an-Access-Token' }, { label: 'Find Company ID', url: 'https://kb.7shifts.com/hc/en-us/articles/33063124722195-How-to-Find-Your-Location-ID-and-Company-ID' }],
    steps: [
      'Sign in to the 7shifts web app as an Admin. Open Settings → Developer tools.',
      'Select + Create Access Token. Name it Totali payroll, select an active Admin as the technical contact, then create it.',
      'Use the token’s Copy button. Paste the copied value into Access token below. Do not paste a partner Client ID, client secret or company GUID.',
      'Open Developer tools → Resource IDs. Copy Company ID into Company ID below. This box takes the company ID, not the Location ID. You can leave it blank if the token reaches exactly one company.',
      'Select Verify and connect. Then match employees and sync the pay period. If Developer tools is missing, ask the account Admin.',
    ],
    note: 'An Admin can create an access token for their own company without the partner OAuth approval process. Keep the token linked to an active technical contact.',
    fields: { accessToken: { hint: 'Paste the token copied from Settings → Developer tools → Access Tokens.', placeholder: 'Paste your 7shifts access token' }, companyId: { hint: 'Copy Developer tools → Resource IDs → Company ID. Do not use Location ID or company GUID.', placeholder: 'Paste Company ID, or leave blank' } },
  },
};
