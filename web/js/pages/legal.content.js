// The Terms of Service and Privacy Policy. Plain language, and every statement here describes what the product does.
// A block is a paragraph, or { list: [...] } for bullets. Keep this in step with the product: if what Totali does changes,
// so does this, and the version in src/api/app.ts (termsVersion).
export const EFFECTIVE = 'October 31, 2026';
export const CONTACT = 'hello@omnia.tax';

export const TERMS = [
  { id: 'agreement', title: '1. This agreement', blocks: [
    'These Terms of Service (the “Terms”) are an agreement between you and OMNIA TAX LLC (“Totali”, “we”, “us”). They apply when you create an account or use Totali, a website and service that helps restaurants work out and run payroll.',
    'If you use Totali for a business, you are agreeing for that business and you promise that you have the authority to do so. You must be at least 18 years old. By creating an account you accept these Terms and our Privacy Policy.',
  ] },
  { id: 'service', title: '2. What Totali does, and what it does not', blocks: [
    'Totali takes the hours, tips, pay rates and tax forms for your team, works out each paycheck and the taxes on it, keeps your payroll records, helps you bring in hours from your point of sale, and writes the payment file you give to your bank. Totali also keeps track of tax due dates and prepares figures for your tax filings.',
    'Please read this part carefully:',
    { list: [
      'Totali does not hold, receive or move your money. When you approve a pay run, Totali writes a payment file. You download it, upload it to your own bank and release it there. Your bank, not Totali, sends the money.',
      'Unless a feature in the app says otherwise, Totali does not file tax returns or send tax payments for you. It tells you what is due and when, and gives you the numbers. You are responsible for filing and paying on time.',
      'Totali is not a professional employer organization, a payroll bureau, or your tax, legal, accounting or HR adviser. You are your employees’ employer and stay responsible as the employer.',
      'Tax rates, wage rules and forms change. Totali uses the rules in effect on the pay date as we have them, and an independent check reports differences. We work to keep them current, but we cannot promise that every rule for every city and state is modeled. Where the app says a rule is not modeled, or marks an item for review, you need to decide it.',
    ] },
  ] },
  { id: 'account', title: '3. Your account', blocks: [
    'You need an account to use Totali. Give accurate information, keep your password private, and tell us at once if you think someone else has gained access. You are responsible for what happens under your account, including what other people you let in do.',
    'You can sign in with a password or with Google. We may suspend an account we believe has been compromised to protect you and your employees.',
  ] },
  { id: 'responsibilities', title: '4. What you are responsible for', blocks: [
    'Totali is only as accurate as what goes into it. You agree that:',
    { list: [
      'what you enter or import (hours, tips, rates, hire dates, tax forms, bank details, company details and your tax account numbers) is accurate and complete, and you will review each pay run before approving it;',
      'you will pay your employees and your taxes on time and file what the law requires of you, whether or not Totali has prepared the figures;',
      'you have the right to give Totali your employees’ personal information, you have told them how it is used, and you will keep your own records, including Forms I-9 and any written notices the law requires (such as a tip credit notice);',
      'you will keep copies of payroll reports you may need. Totali is not a substitute for your own records.',
    ] },
  ] },
  { id: 'integrations', title: '5. Connected services', blocks: [
    'Totali can connect to other services at your direction: for example Toast, Square, Clover and 7shifts to bring in staff, hours and tips, Stripe for payment and for linking bank accounts, and Google to sign in. When you connect one, you authorize Totali to read the data you allow and, where the connection is made with credentials or a token you give us, to store them encrypted so we can read from it until you disconnect.',
    'Totali only reads from your point of sale or time clock; it does not change anything there. Each connected service has its own terms and privacy policy, which apply to your use of it. We are not responsible for another service’s outage, change or error, and we cannot promise a connection will work for every account.',
  ] },
  { id: 'fees', title: '6. Price and payment', blocks: [
    { list: [
      'Totali costs $20 every three months. The price is the same however many employees you have and however many pay runs you make.',
      'You are billed in advance, every three months, starting when you subscribe, by Stripe, to the card you give on Stripe’s secure page. Your subscription renews automatically until you cancel.',
      'You can cancel at any time from Billing in the app. A cancellation takes effect at the end of the three months you have paid for, and you keep using Totali until then. We do not give partial refunds for a period already paid, unless the law requires it.',
      'If a payment fails, Stripe will try again. While it is late you can keep using Totali. If it cannot be collected, we may stop you approving new pay runs until it is paid. Your records stay available to you.',
      'If we ever change the price, we will tell you at least 30 days before it applies to you, and you can cancel before then. Prices do not include any taxes that apply to you; where required we will add them.',
    ] },
  ] },
  { id: 'use', title: '7. Using Totali properly', blocks: [
    'You agree not to misuse Totali. In particular you will not:',
    { list: [
      'use it to break the law, to pay people who are not your employees or contractors, or to hide wages;',
      'try to get into someone else’s account or data, probe or attack the service, or overload it;',
      'copy, resell or build a competing service from Totali, or reverse engineer it, except where the law lets you;',
      'upload material that is unlawful or that you have no right to upload.',
    ] },
  ] },
  { id: 'data', title: '8. Your data and ours', blocks: [
    'Your payroll records and the information you put into Totali are yours. You give us the right to store, process and display them only as needed to run Totali for you, to keep it secure, and to meet legal duties. You can export your reports from the app, and you can ask us to close your account.',
    'Totali, its software, design and name belong to OMNIA TAX LLC and our licensors. We give you a limited, non-exclusive, non-transferable right to use Totali for your own business while you follow these Terms. If you send us feedback, we may use it without owing you anything.',
  ] },
  { id: 'security', title: '9. Security and breaches', blocks: [
    'We protect your data with the measures described in our Privacy Policy, including encryption of Social Security numbers, bank account numbers and tax IDs. No system is perfectly secure. If we learn that your personal information was accessed without permission, we will tell you without unreasonable delay and tell you what we know, as the law requires.',
  ] },
  { id: 'warranty', title: '10. No promises beyond these', blocks: [
    'Totali is provided “as is” and “as available”. To the fullest extent the law allows, we do not make promises about it other than the ones in these Terms: not that it will be uninterrupted or error-free, not that its calculations or deadlines will be right in every case, and not that it fits a particular purpose. Some places do not allow some of these limits, so some may not apply to you.',
  ] },
  { id: 'liability', title: '11. Limits on what we owe you', blocks: [
    'To the fullest extent the law allows, OMNIA TAX LLC is not liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, lost revenue, or penalties and interest charged by a tax or labor authority because of information you entered, a decision you made, a late filing, or a rule that was not modeled.',
    'Our total liability for any claim relating to Totali is limited to the greater of the amount you paid us in the 12 months before the claim arose, and $100. These limits do not apply where the law does not allow them, including to liability for our gross negligence or willful misconduct.',
  ] },
  { id: 'indemnity', title: '12. If someone makes a claim', blocks: [
    'You will defend and reimburse us for claims, losses and costs (including reasonable legal fees) from a third party that arise from your breach of these Terms, from information you put into Totali that you had no right to use, or from how you run your business and pay your employees. We will tell you promptly of any such claim and let you control the defense, as long as you do not settle in a way that binds us without our consent.',
  ] },
  { id: 'ending', title: '13. Ending this agreement', blocks: [
    'You can stop using Totali and cancel at any time. We can suspend or end your access if you seriously or repeatedly break these Terms, if you do not pay, or if we must for legal reasons. We will tell you why, where we can, and give you a chance to export your records unless that is not lawful.',
    'After your account ends we keep your information only as the Privacy Policy describes. Parts of these Terms that are meant to continue, such as the sections on data, limits on liability and claims, still apply.',
  ] },
  { id: 'changes', title: '14. Changes to these Terms', blocks: [
    'We may change these Terms. If a change matters, we will tell you by email or in the app at least 30 days before it applies, and the date at the top will change. If you keep using Totali after that date, you accept the change. If you do not accept it, you can cancel before it applies.',
  ] },
  { id: 'law', title: '15. Law and disputes', blocks: [
    'These Terms are governed by the laws of the state in which OMNIA TAX LLC is organized, without regard to its conflict-of-laws rules, and by applicable federal law. If you have a problem, please write to us first at ' + CONTACT + ' and we will work with you in good faith to fix it. If we cannot, either of us may bring the claim in the courts of that state.',
  ] },
  { id: 'general', title: '16. The rest', blocks: [
    'These Terms and the Privacy Policy are the whole agreement between us about Totali. If part of them is found unenforceable, the rest stays in effect. If we do not enforce a right right away, we have not given it up. You may not transfer your rights under these Terms without our consent; we may transfer ours as part of a sale or reorganization. Neither of us is liable for delays caused by events beyond our reasonable control. We may give you notices by email or in the app.',
    'Questions about these Terms: ' + CONTACT + '.',
  ] },
];

export const PRIVACY = [
  { id: 'who', title: '1. Who we are', blocks: [
    'Totali is run by OMNIA TAX LLC. This policy explains what personal information we collect through Totali, why, who sees it, and the choices you have. Totali is a business service used by restaurant owners and their managers. It is not for children, and we do not knowingly collect information from anyone under 16 other than the details an employer enters about their own young workers.',
    'We handle two kinds of information: information about you, the person who signs up; and information you put in about your business and your employees. For the second kind, you are the employer and we handle it on your behalf to provide payroll to you.',
  ] },
  { id: 'collect', title: '2. What we collect', blocks: [
    { list: [
      'You: your name, work email, business name and a password (kept only as a salted hash). If you sign in with Google we receive your name and email from Google.',
      'Your business: legal name, EIN and tax account numbers, address, locations, owners and officers, pay schedule, and your answers to the setup questions.',
      'Your employees and contractors: names, email, role, location, pay rates, hours, tips, hire and end dates, tax withholding forms (W-4 and state forms), Form I-9 section 1 details, Social Security numbers, dates of birth, direct deposit bank details, year-to-date wages, and for contractors a W-9 and amounts paid.',
      'Payroll records: pay runs, paychecks, taxes, deposits, payment files and the reports built from them.',
      'Connected services: if you connect a point of sale or time clock, the staff, shifts, hours and tips we read from it, and the credentials or token you gave us, which are kept encrypted. We do not collect card numbers or customer data from your point of sale.',
      'Billing: your Stripe customer, the status and renewal date of your subscription, and your card’s brand, last four digits and expiry. The card number is typed on Stripe’s page and never reaches us.',
      'Using Totali: a log of who did what and when (not the contents of what was entered), your IP address and browser type for security and rate limiting, and the messages you send us.',
    ] },
  ] },
  { id: 'use', title: '3. How we use it', blocks: [
    { list: [
      'To run Totali for you: calculate pay and taxes, keep records, write payment files, show your dashboard, send new-hire and verification emails, and bring in hours from your systems.',
      'To keep it secure and working: sign-in, preventing fraud and abuse, fixing problems, and backups.',
      'To bill you and to answer your questions.',
      'To meet legal duties and to protect our rights.',
    ] },
    'We do not sell your information or your employees’ information. We do not use it for advertising and we do not use it to train outside advertising or data products.',
  ] },
  { id: 'share', title: '4. Who else handles it', blocks: [
    'We use a small number of companies to run Totali. They may handle your information only to do their job for us:',
    { list: [
      'Stripe: subscription payments, the billing portal, and linking bank accounts.',
      'Resend: sending our emails (verification codes, new-hire links, reminders).',
      'Render: the servers and storage where Totali runs.',
      'Google: if you choose to sign in with Google.',
      'The point of sale or time clock you connect (for example Toast, Square, Clover or 7shifts), only where you connect it.',
    ] },
    'We may also disclose information if the law or a valid legal process requires it, or to protect people’s safety or our rights, and as part of a sale or reorganization of the business, in which case the buyer must honor this policy. If you ask us to send reports to your accountant or bank, we send them to who you say.',
  ] },
  { id: 'protect', title: '5. How we protect it', blocks: [
    { list: [
      'Social Security numbers, bank account numbers, tax IDs, tokens for connected services and uploaded documents are encrypted with AES-256 before they are stored. Only the last four digits are shown on screen.',
      'Everything travels over encrypted connections (HTTPS). Passwords are stored only as salted hashes. Sign-in codes expire. Repeated failed attempts are blocked.',
      'A new hire’s link to their forms is private and expires, and shows only their own forms.',
      'We limit who at Totali can reach customer data, and record what is done.',
    ] },
    'No method is perfectly secure, and we cannot promise absolute security. If we learn of a breach affecting you, we will tell you as the law requires.',
  ] },
  { id: 'cookies', title: '6. Cookies', blocks: [
    'Totali uses a few cookies that it needs to work: one that keeps you signed in, and a short-lived one used only while you sign in with Google. We do not use advertising or analytics cookies, and there are no third-party trackers on the pages you use when signed in.',
  ] },
  { id: 'keep', title: '7. How long we keep it', blocks: [
    'We keep your payroll records for as long as your account is open and afterward for as long as employers are expected to keep them. For federal payroll tax records that is generally at least four years, and some states and some records require longer. Sign-in sessions and one-time codes expire quickly. A request that is kept private to a new hire expires on its own.',
    'When you ask us to close your account, we delete or de-identify the information we are not required to keep, and keep the rest, locked from other use, until the legal period ends. Backups are removed on their normal cycle.',
  ] },
  { id: 'rights', title: '8. Your choices and rights', blocks: [
    'You can see and correct your account information in the app, export your reports, disconnect any connected service, and cancel your subscription. You can ask us to give you a copy of, correct, or delete the personal information we hold about you, and to explain how it is used. Email ' + CONTACT + ' and we will answer within 30 days.',
    'If you are an employee of a business that uses Totali, your employer decides what is entered about you. Please ask your employer first; we can help them respond to you.',
    'California and some other states give residents extra rights over their personal information, including to know what we collect, to delete it, and not to be discriminated against for using these rights. We do not sell personal information or share it for advertising. You can use these rights by emailing us. We may need to verify who you are first.',
  ] },
  { id: 'where', title: '9. Where it is processed', blocks: [
    'Totali is run from servers in the United States and is meant for businesses in the United States. If you use it from elsewhere, your information goes to the United States.',
  ] },
  { id: 'changes', title: '10. Changes and contact', blocks: [
    'If we change this policy in a way that matters, we will tell you by email or in the app, and update the date at the top. Questions or requests: ' + CONTACT + '.',
  ] },
];
