# Getting the payment file to the employer's bank

In employer-bank mode Totali writes the payment file and the employer's own bank sends the money. There are three ways the file reaches the bank. The employer approves it at their bank in every case; Totali never releases a payment.

| Level | How | Needs from the bank |
| --- | --- | --- |
| 1. Upload | Totali builds the file; the employer downloads it and imports it in their bank's online ACH service, then approves it. | A business ACH origination service with file import. Many banks have one. |
| 2. SFTP | Totali delivers the file to the bank's SFTP server after each run. The employer still approves it at the bank. | The bank enables SFTP for that employer and gives them a host, a user, a key arrangement, a file-name rule and the bank's host key. |
| 3. Bank API | Totali submits through the bank's API. | A bank that has one, and an adapter for it. Not built. |

## How many banks, and which

**There is no published count of banks that accept ACH files over SFTP.** It is a treasury-management feature each bank switches on for individual business customers. For scale: the FDIC counted [4,336 insured institutions at the end of 2025](https://fdic.gov/quarterly-banking-profile/statistics-glance-historical-trends-fourth-quarter-2025.pdf) and the NCUA [4,287 federally insured credit unions](https://ncua.gov/newsroom/press-release/2026/ncua-releases-fourth-quarter-2025-credit-union-system-performance-data), about 8,600 in all. Nobody counts how many of those take SFTP files.

What I could confirm from the banks' and platforms' own pages (read 2026-10-29):

| Who | What the page says | Gaps |
| --- | --- | --- |
| [First Citizens Bank](https://www.firstcitizens.com/commercial/solutions/treasury-management/information-management/data-exchange-service) | Data Exchange Service, for treasury-management clients, includes ACH origination. Automated transfers by sFTP (SSH key, port 22) or FTPS (port 991). "Your automation must be supported by your company." | Who is eligible and how long setup takes are not stated. |
| [Johnson Financial Group](https://www.johnsonfinancialgroup.com/commercial/treasury-management/direct-transmissions-faqs) | SFTP for all transmissions, "ACH – NACHA" format, SSH public-key authentication preferred, an ACH confirmation report by email. **ACH implementation can take up to 8 weeks.** There are fees for sending and receiving files. | Eligibility, minimums and cutoffs are not stated. PGP is not mentioned. |
| [Banner Bank](https://www.bannerbank.com/business-solutions/services/treasury-management/treasury-management-solutions) | "Direct transmission": clients send ACH or wire files to the bank's SFTP server. | Not read in detail. |
| Banks on [Jack Henry's treasury management platform](https://knowledge.banno.com/business-banking/treasury-management/ach/ach-file-data-transmission-via-sftp/) | Lets a business send NACHA files over SFTP. **The bank has to switch it on**, for the bank and then for the company. File names follow a strict pattern (bank routing number, environment, treasury company id, timestamp); a mismatch makes the file fail to load. Aimed at higher-volume originators. | Which banks use it, and how many, are not published. |
| [Fiserv File Exchange](https://www.fiserv.com/en/about-fiserv/resource-center/brochures/file-exchange-commercial-payment-interface.html) | A product banks use to take batch files, including ACH origination, from commercial clients. | Which banks use it is not published. |
| J.P. Morgan | A public-sector document describes sending NACHA files over SFTP, with duplicate-file checks and a transaction journal within two hours. | That was a city-government document, not J.P. Morgan's own page, and it says nothing about small businesses. |

**Not confirmed** (I found no official page): Chase, Wells Fargo, Bank of America, U.S. Bank, PNC, Truist, Fifth Third, Regions, KeyBank. The large banks very likely offer file transmission to commercial clients, but I could not verify it, or whether a small restaurant would qualify.

**A trend to know about:** [Lead Bank](https://docs.lead.bank/file-integrations/nacha-files.md) no longer offers file-based ACH to new partners and points them to its API. Other banks may do the same.

## What this means

- SFTP is a **business-banking upgrade**, not something a small restaurant can switch on tomorrow. Expect fees, weeks of setup, key exchange, and a bank-specific file-name rule.
- Most small employers will use **Level 1**. It works anywhere the bank has a NACHA import. Totali's file is built to be imported.
- Offer **Level 2** to employers whose bank supports it, one bank at a time, once you know which banks your first customers use.

## Questions to ask an employer's bank

1. Does our business ACH service accept a NACHA file import? Which file extension and size limit?
2. Do you offer SFTP (or FTPS) delivery of ACH files? What does it cost and how long does setup take?
3. What are the host, port, username, remote directory, and the host key we must pin?
4. How do we authenticate: SSH key (which types), and do you require PGP encryption of the file?
5. What file-name rule do you enforce?
6. What are our ACH ids: the immediate-origin id and the company id for the file header?
7. What are the cutoff times for same-day and next-day credits, and our daily and per-file limits?
8. Can we require a second person to approve each file? (Totali relies on this.)
9. How do you tell us a file was accepted, rejected or returned (email, report file, API)?

## How Totali's SFTP delivery behaves

- It uses OpenSSH's `sftp` client, which must be installed on the Totali server.
- The connection is refused unless the server presents the **host key the employer gave Totali** (pinned in one known_hosts line). Key authentication only: no password, no agent.
- The employer's private key is stored encrypted and is written to disk only for the length of the transfer (a 0600 file in a 0700 temporary directory, then deleted).
- Every host, user, directory and file name is checked against a strict pattern before it reaches the command line.
- Delivery is **not** approval. A delivered file is `queued`; it becomes `accepted` only when the employer says they released it at their bank.
- A failed delivery leaves the file ready to download and is retried no more often than every 15 minutes, so a wrong key cannot hammer the bank's server.
- **Not supported:** PGP encryption of the file, password login, and servers that need a rename after upload.
- **Not tested against a real SFTP server.** The tests use a stand-in for the `sftp` command and check exactly what Totali would run. Try it against one real bank's test or sandbox endpoint before relying on it.
