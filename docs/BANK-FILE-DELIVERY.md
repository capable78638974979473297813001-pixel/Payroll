# Getting the payment file to the employer's bank

In employer-bank mode Totali writes the payment file and the employer's own bank sends the money. There are three ways the payments reach the bank. With levels 1 and 2 the employer approves at their bank. With level 3 the approval is in Totali, before anything is sent. In every case a named person approves and Totali never approves for anyone.

| Level | How | Needs from the bank |
| --- | --- | --- |
| 1. Upload | Totali builds the file; the employer downloads it and imports it in their bank's online ACH service, then approves it. | A business ACH service with file import. |
| 2. SFTP | Totali delivers the file to the bank's server after each run. The employer still approves it at the bank. | The bank enables it for that employer and gives them a host, a login, a key arrangement, a file-name rule and the bank's host key. |
| 3. Bank API | A named person approves the exact file in Totali, then Totali sends each payment through the bank's API with the employer's own credentials. | A bank with a public API, an adapter for it, and the employer's own onboarding. Built for J.P. Morgan only. |

## Column: one connection that works for every employer's bank

The levels below each need the employer's own bank to enable something. This one does not. With `TOTALI_ACH_MODE=column`, Totali sends through [Column](https://docs.column.com), a bank with a public API, as the originating bank (the `totali_ach` mode). Totali debits the employer's account by ACH and pays employees by ACH. ACH debits and credits work with every U.S. bank, so no employer's bank has to connect to us.

**What it automates, with no staff step**
- Each payment is sent to Column as its own ACH transfer, with an idempotency key made from the file and the payment. A repeat returns the first result, so a lost answer can be retried and cannot pay twice. A payment Column refuses fails that employee only.
- Column's status is polled. When the employer's debit settles, the funds are confirmed (this replaces the ops-only "confirm funds received" step), and the hold, pay and settle steps follow.
- Returns arrive with Column's own return code and are applied the same way a return file would be: net pay owed again, a bad account disabled, an exposure flagged if the employer's debit comes back after employees were paid.
- The employer's approval is approving the pay run in Totali, which already exists.

**Try it for real, for free:** `COLUMN_API_KEY=test_... COLUMN_BANK_ACCOUNT_ID=bacc_... npm run check:column` makes one $1.00 sandbox credit, reads it back and cancels it. It refuses a live key. Column's sandbox mirrors production on the same host.

**What is not known or not built**
- **Never run against Column.** The code is written from Column's published API reference. The tests use a fake that follows it.
- **The debit request** is the same `POST /transfers/ach` with `type: DEBIT`, but the documentation I read describes only credits in its examples. Whether Column needs anything extra for an originated debit is untested.
- **Status meanings:** Column lists 16 status values without defining them. The groupings in `src/column/submitter.ts` follow their names, and any value Totali does not know raises an alert and is never assumed fine.
- **Webhooks** are not used (their signing was not in the pages I read), so status is polled: every 15 minutes while in flight, daily after settling until the return window passes.
- **Approval and compliance are not code.** Column's own onboarding for a platform that originates for others, money-transmission questions (Totali holds the employer's money between the debit and the payout), and Nacha third-party-sender requirements are for Column, the business and a lawyer. Column documents a self-serve pilot for moving a small amount of your own money; anything past that is theirs to approve.

## The nine large banks

Read 2026-10-29 and 2026-10-30. **"Read"** means I read the bank's own document. **"Summary"** means I only saw a search summary of the bank's page, because the page itself would not load for me.

| Bank | Level 1: upload | Level 2: automatic file delivery | Rules that affect Totali | How I know |
| --- | --- | --- | --- | --- |
| **Chase** (Chase for Business) | **Yes.** "ACH file upload" in online banking. | Not found for Chase for Business. | See below: the strictest rules of the nine. | Read: [Chase ACH file upload guide](https://www.chase.com/content/dam/chaseonline/en/demos/cbo/pdfs/cbo_achfile_helpguide.pdf) |
| **J.P. Morgan** (commercial) | n/a | **Yes, protocol not named.** "Direct transmission" and "Host-to-Host", up to 90 days in advance. Deadlines (ET): direct transmission 10 p.m. next-day, 1:15 p.m. same-day; Host-to-Host 11 p.m. and 11:30 a.m. | Not eligibility-limited on the page, but these are commercial services. | Read: [J.P. Morgan](https://www.jpmorgan.com/commercial-banking/alternate-methods-transacting-business) |
| **Wells Fargo** | Not covered in what I read. | **Yes: SAFE Transmission.** SFTP with a user ID and key, **or** SFTP with a user ID and password, plus HTTPS, FTPS and AS2. `safetrans.wellsfargo.com`, port 22 (RSA key). A separate test environment. | See below. | Read: [SAFE Transmission guide](https://wellsoffice.ceo.wellsfargo.com/ceopub/assets/pdf/safetransmissions/safe_trans_ref_guide.pdf), [ACH implementation guide](https://wellsoffice.wellsfargo.com/ceopub/assets/pdf/ach/ach_implementation_guide.pdf) |
| **Bank of America** | Via CashPro ACH. | **A file channel exists: CashPro Connect.** A CashPro API exists too. The page does not say SFTP. | The bank's file specification takes precedence over the Nacha rules. A free CashPro Validator checks files during onboarding. | Read: [BofA ACH page](https://business.bofa.com/en-us/content/ach.html). Summary: terms and Validator |
| **U.S. Bank** | Via SinglePoint ACH Origination. | **Yes: SFTP-SSH**, HTTPS, AS2 and Connect:Direct, NACHA format accepted. An ACH Originations API exists. | Its [third-party sender checklist](https://www.usbank.com/dam/documents/pdf/corporate-and-commercial-banking/third-party-sender-checklist.pdf) is what Totali-sent mode would face. | Summary: U.S. Bank developer site (it would not load). Read: the checklist |
| **PNC** | Via the PINACLE ACH module (import, or clip in a file). | **Yes: SFTP (FTP over SSH)**, AS2, or a VPN with SFTP or Connect:Direct. Real-time or store-and-forward. ACH files up to 250 MB. A Payments API sends a whole ACH batch in one call. | Deadlines (ET): direct transmission 10 p.m. next-day, 3:45 p.m. same-day; PINACLE ACH module 8 p.m. and 3 p.m. Same-day is for entries of $100,000 or less. Files can be dated up to 45 days ahead. You choose how to receive returns during implementation. | Read: [PNC ACH credit origination](https://www.pnc.com/content/dam/pnc-com/pdf/corporateandinstitutional/treasurymanagement/ach-credit-origination-services.pdf) |
| **Truist** | **Yes.** "File Services" upload in Treasury Manager; NACHA is the only upload format. | **Yes: "File Transfer"** by browser or secure FTP, also called direct transmission. | **A login ID and password**, not a key. **The bank must be given every IP address you send from.** **Control totals must be submitted before the file is released.** | Read: [Truist Treasury Terms and Conditions (rev. 03/26)](https://www.truist.com/content/dam/truist-bank/us/en/documents/truist-treasury-terms-conditions.pdf), [File Services manual](https://treasuryresources.truist.com/content/dam/treasuryresources/us/en/documents/platforms/file-services-user-manual.pdf) |
| **Fifth Third** | Through Fifth Third Direct (its online banking). | **Probably: "direct send transmission"**, protocol not named. | Not found. | Summary only: its ACH page did not load. It also said ACH services moved on 2026-09-08. |
| **Regions** | Through iTreasury, iTreasury Small Business Plus, or Online Banking Business Services. | **Not found.** The page lists "a variety of input methods" and names no protocol. | **Online Banking Business Services caps ACH at $100,000 per batch and $500,000 a month per account.** | Read: [Regions ACH Origination](https://www.regions.com/treasury-management/managing-payments/ach-payments) |
| **KeyBank** | Via KeyNavigator File Transfer (web). | **Yes: "Direct Transmission" by FTP, sFTP or AS2.** | Test files are required of every client sending files. ACH deadline 9 p.m. ET. Totals are entered in "ACH Direct" before the file is sent. | Summary: key.com transmission toolkit and ACH Direct guide (the toolkit now says it moved into KeyNavigator) |

### Chase for Business: the strictest rules

From the Chase guide. These are real constraints, and Totali already follows the file-format ones.

- **The system administrator has to turn the upload service on**, and only calling the bank turns it off again. Uploading is free; each payment is charged at your pricing.
- **Payroll must be PPD with the description "PAYROLL".** Totali writes exactly that.
- **The effective date must be after the day the file is created.** Totali refuses an effective date earlier than the bank's lead time, so a same-day date is not offered by default.
- **Employee payments must be created at least two business days before the "send on" date**, the day Chase debits the employer, which is itself before the effective date. In practice allow about three banking days. Set `employerBank.leadBankingDays` to 3 for a Chase employer: this is my reading of the guide, so confirm it with them.
- **The bank assigns the company id.** Immediate origin and company id are the values Chase gives you.
- Uploads by anyone but the administrator need approval whether or not Dual Control is on; with Dual Control on, everything does. Daily limits apply, and employee payments need an employee-payment entitlement.
- **No same-day settlement, no repeating payments, no collections or reversals, not on mobile.** Files are validated one at a time, old transactions are refused, and after upload payments cannot be edited: cancel and upload again.

### Wells Fargo: what to know

- Wells **prefers "unbalanced" files**, where the bank makes the offsetting entry. Employer-bank mode writes exactly that.
- **File ID.** The immediate origin is a 10-character ID, normally "1" plus the tax ID, which the implementation consultant confirms. "Files that don't include the correct ACH file ID may be rejected."
- Send up to 45 banking days ahead; usually 1 to 2 banking days before the effective date. Same-day is offered.
- **Trace numbers.** Wells overwrites them. A return file may carry your original trace, Wells's, or the returning bank's, depending on the options you pick. **Ask for the original trace number**, or Totali cannot match the return to the payment.
- **IP validation.** Automated connections are checked against the IP addresses authorized for the user ID.
- **PGP is optional**, set per product folder; **Totali does not support PGP**, so do not turn it on for the ACH folder.
- SFTP by key works with Totali. Password SFTP does not (see below).

## How Totali uses each bank's rules

`src/banks/profiles.ts` has a profile for each bank above, the smaller banks (First Citizens, Johnson Financial, Banner Bank) and a generic `other`. `GET /v1/bank-profiles` lists them and `GET /v1/bank-profiles/:id` returns one, with its sources, cutoffs, guidance and the questions to ask the bank.

An employer picks a bank with `employerBank.bankProfile` in `PUT /payment-setup`. Then:

- **Defaults.** The bank's lead time is applied unless the employer sets their own.
- **Setup is checked.** It is refused if it cannot work: SFTP for Truist (password login only), a lead time of 0 where the effective date must follow creation (Chase), a file id of the wrong shape (Wells Fargo wants ten characters), an unknown limits tier. It only warns where the bank's rule is our reading of its guide, or the employer may know something a public page does not (SFTP at a bank that documents none, a host or port that differs from the guide, a routing number the spec does not show).
- **Every file is checked before it is offered for release.** A file that breaks a rule is rolled back, with its payment legs, and the response says which rule: same-day not supported, same-day entry over PNC's $100,000, further ahead than the bank accepts (Wells Fargo 45 banking days, J.P. Morgan 90 days), over a published per-batch or monthly limit when the employer has set `limitsTier` (Regions' Online Banking Business Services). Control totals (Truist, KeyBank), IP allow-listing, PGP and trace-number behaviour come back as notes on the prepared file.
- **Release stays manual.** Nothing here approves or sends anything.

Each profile records, for each source, whether the page was read or only seen as a search summary. The four marked summary-only (U.S. Bank, Fifth Third, KeyBank, Banner Bank) should be treated as leads, and the profile's `askBank` list says what to confirm. Facts that were not found are left out of the rules and listed there instead.

What is not built: connecting to a bank's API, PGP, password logins, and any behaviour that depends on a bank rule that has not been read.

## Level 3: sending through a bank API

**What is built:** an adapter for J.P. Morgan's Global Payments 2 ACH API (`src/bankapi/jpmorgan.ts`), written from the public developer documentation and never run against J.P. Morgan. It signs the OAuth assertion with the employer's RSA key, sends one PPD / PAYROLL credit per employee, and reads each payment's status back by polling.

**Why approval happens in Totali.** For this to keep the one manual step, a bank would have to hold an API-sent payment until its owner releases it. J.P. Morgan's documentation shows no such state (its statuses are accepted, processing, rejected, returned and completed, with holds that belong to the bank) and no cancel call. A payment sent by API is therefore accepted for execution. The other banks I looked at (PNC, Wells Fargo, Bank of America) publish nothing readable on this, so I did not write adapters for them. The approval is placed before the call instead:

1. `POST /pay-runs/:id/prepare-payment` builds the file. **It calls the bank not at all.**
2. A named person approves the exact file: `POST /ach/files/:id/approve-and-send` with `approvedBy` and `confirm {entryCount, creditsCents}` typed back to match the file. Wrong or missing totals send nothing.
3. Only then does Totali call the bank, one payment at a time.

**Controls around the employer's credentials**

- The employer sets `maxFileCents`, the largest file Totali may send with them, and accepts a written authorization (`GET /payment-setup/api-authorization`) that names the account, the cap and the approval rule. The wording is a draft and has not been reviewed by a lawyer.
- The private key, account number and client id are encrypted at rest and never returned. Totali only calls the bank's own hosts (`*.jpmorgan.com`), so a company key cannot point it, and the account numbers it sends, somewhere else.
- A file whose date has passed, or that now breaks the bank's rules, is refused. A file released by hand cannot also be sent by API, and the reverse.

**Never pays twice.** A payment is marked `sending` before the call. If the answer is lost, late or unclear (a timeout, a 5xx, a duplicate warning, an unreadable reply) it becomes `unknown` and is not sent again until a person checks the bank and says whether it is there (`POST /ach/files/:id/entries/:leg/resolve`). Bad credentials, a refused connection and rate limits are `not_sent` and safe to repeat; a rejection by the bank fails that employee only.

**What stays outside Totali's control**

- **Onboarding is the employer's.** Credentials, the certificate, a client-testing environment and its base URL come from the employer's J.P. Morgan representative. Totali cannot get them.
- **mTLS and digital signatures:** the documentation says they "may be required depending on the capability" and does not say whether ACH needs them. This adapter does neither. If the bank requires them the call will fail, safely, with no payment made.
- **Callbacks** need an implementation request with the bank and the documentation does not say how they are signed, so status is polled (at most every 15 minutes per payment, and not for payments more than 30 days old).
- **Returns** arrive as a status, without an R-code. Totali treats them as an unrecognised return: the employee's net pay is owed again and their bank account is disabled until someone checks.
- **Legal:** the employer stays the originator, with their own agreement with the bank, and Totali never holds the money. Whether the bank's terms allow a software provider to use the employer's credentials, and whether Totali needs any registration for this, are for the employer's bank and a lawyer to say. Totali does not claim an answer.

**Banks checked for an API adapter and not built (2026-10-30)**

- **KeyBank:** publishes an ACH Origination API (`/ach/payments/v1/...`) with a status call and an "undo" call that works for roughly ten minutes before the collection window. That is a short cancel window, not a hold for release, so it would need the same in-Totali approval. The request format could not be read (the documentation pages returned 404 to me), so no adapter.
- **Wells Fargo and Bank of America:** their developer portals only load in a browser, so nothing could be read. Third-party summaries describe OAuth and ACH endpoints but nothing about release or holds.
- **PNC:** the ACH credit service sheet mentions a Payments API that takes a batch in one call. No PNC developer documentation turned up.
- **Everyone else:** nothing public to read.

A bank is added when its own documentation can be read, cited, and shown to say how a payment is sent and cancelled.

## How many banks

**There is no published count of banks that accept ACH files over SFTP.** For scale: the FDIC counted [4,336 insured institutions at the end of 2025](https://fdic.gov/quarterly-banking-profile/statistics-glance-historical-trends-fourth-quarter-2025.pdf) and the NCUA [4,287 federally insured credit unions](https://ncua.gov/newsroom/press-release/2026/ncua-releases-fourth-quarter-2025-credit-union-system-performance-data), about 8,600 in all. Among the nine above, **five confirm an automatic file channel with a named protocol or name** (Wells Fargo, PNC, U.S. Bank, Truist, KeyBank), J.P. Morgan has one without naming the protocol, Bank of America has a file channel (CashPro Connect) without naming SFTP, and for Fifth Third, Regions and Chase for Business I found none.

Smaller banks, from the earlier pass: [First Citizens](https://www.firstcitizens.com/commercial/solutions/treasury-management/information-management/data-exchange-service), [Johnson Financial](https://www.johnsonfinancialgroup.com/commercial/treasury-management/direct-transmissions-faqs) (setup up to 8 weeks, fees), [Banner Bank](https://www.bannerbank.com/business-solutions/services/treasury-management/treasury-management-solutions), banks on [Jack Henry's platform](https://knowledge.banno.com/business-banking/treasury-management/ach/ach-file-data-transmission-via-sftp/) (the bank must switch it on) and [Fiserv File Exchange](https://www.fiserv.com/en/about-fiserv/resource-center/brochures/file-exchange-commercial-payment-interface.html). [Lead Bank](https://docs.lead.bank/file-integrations/nacha-files.md) no longer offers file delivery to new partners and uses an API.

## What this means for Totali

- **Level 1 works almost everywhere** and the file is built for it. It is the default, and for a small restaurant it will usually be the answer.
- **Level 2 is a commercial treasury service.** It needs an enrolled employer, an implementation process, usually fees, and often weeks. Offer it as an upgrade, one bank at a time.
- **Where Totali's SFTP fits today:** Wells Fargo (key login, no PGP), PNC, U.S. Bank and KeyBank are plausible once their login details are known. **Truist uses a user ID and password, which Totali's SFTP does not support**, so Truist employers use level 1 for now. Adding password login is possible but weaker, so it is not done.
- **Static IP address.** Wells Fargo and Truist check the address you connect from. The Totali server needs a fixed outbound IP, which the employer gives to the bank.
- **Control totals.** Truist and KeyBank hold a file until the employer types in its totals. `prepare-payment` returns the credit and debit totals and the entry count for exactly this.
- **Lead times differ.** Set `leadBankingDays` per employer bank (the default is 1).
- **Limits differ.** Regions' small-business online service stops at $100,000 a batch and $500,000 a month, which a busy restaurant group can reach. Ask about limits before onboarding.

## Questions to ask an employer's bank

1. Does our business ACH service accept a NACHA file import? Which file extension and size limit?
2. Do you offer SFTP (or FTPS) delivery of ACH files? What does it cost and how long does setup take?
3. What are the host, port, username, remote directory, and the host key we must pin?
4. How do we authenticate: SSH key (which types) or password? Do you require PGP encryption of the file?
5. Do you check the address we connect from? Which IP addresses do we give you?
6. What file-name rule do you enforce?
7. What are our ACH ids: the immediate-origin id and the company id for the file header?
8. How many banking days must pass between preparing a payroll file and its effective date? Do you accept same-day?
9. What are the cutoff times, and our daily, per-batch and monthly limits?
10. Must we enter control totals before a file is released?
11. Can we require a second person to approve each file? (Totali relies on this.)
12. How do you tell us a file was accepted, rejected or returned (email, report file, API)? **Which trace number do returns carry?**

## How Totali's SFTP delivery behaves

- It uses OpenSSH's `sftp` client, which must be installed on the Totali server.
- The connection is refused unless the server presents the **host key the employer gave Totali** (pinned in one known_hosts line). Key authentication only: no password, no agent.
- The employer's private key is stored encrypted and is written to disk only for the length of the transfer (a 0600 file in a 0700 temporary directory, then deleted).
- Every host, user, directory and file name is checked against a strict pattern before it reaches the command line.
- Delivery is **not** approval. A delivered file is `queued`; it becomes `accepted` only when the employer says they released it at their bank.
- A failed delivery leaves the file ready to download and is retried no more often than every 15 minutes, so a wrong key cannot hammer the bank's server.
- **Not supported:** PGP encryption of the file, password login, and servers that need a rename after upload.
- **Not tested against a real SFTP server.** The tests use a stand-in for the `sftp` command and check exactly what Totali would run. Try it against one real bank's test endpoint before relying on it. Wells Fargo has a separate validation environment for exactly this.
