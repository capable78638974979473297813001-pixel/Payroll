# Getting the payment file to the employer's bank

In employer-bank mode Totali writes the payment file and the employer's own bank sends the money. There are three ways the file reaches the bank. The employer approves it at their bank in every case; Totali never releases a payment.

| Level | How | Needs from the bank |
| --- | --- | --- |
| 1. Upload | Totali builds the file; the employer downloads it and imports it in their bank's online ACH service, then approves it. | A business ACH service with file import. |
| 2. SFTP | Totali delivers the file to the bank's server after each run. The employer still approves it at the bank. | The bank enables it for that employer and gives them a host, a login, a key arrangement, a file-name rule and the bank's host key. |
| 3. Bank API | Totali submits through the bank's API. | A bank that has one, and an adapter for it. Not built. |

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
