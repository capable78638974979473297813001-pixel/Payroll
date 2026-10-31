// The front page. Static and trusted: no user text goes in. Every claim is something the app does today, and the
// figures in the pictures are made up and say so.
export default `
<div class="lp">
<header class="lp-top">
  <a class="logo" href="/" aria-label="Totali">totali</a>
  <nav aria-label="Page"><a href="#how">How it works</a><a href="#restaurants">For restaurants</a><a href="#pos">Your POS</a><a href="#pricing">Pricing</a><a href="#faq">Questions</a></nav>
  <span class="lp-acct"><a class="lp-login" href="/login">Log in</a><a class="btn sm" href="/signup">Get started</a></span>
</header>

<section class="lp-hero">
  <div class="lp-hero-text">
    <h1>Payroll that understands restaurants.</h1>
    <p class="lp-sub">Tips, overtime and taxes worked out, with every line explained. Hours come straight from your point of sale. New hires fill in their own paperwork. <b>$20 every three months</b>, however many people you pay.</p>
    <form class="lp-join" data-signup><input type="email" placeholder="Work email" aria-label="Work email"><button class="btn" type="submit">Get started</button></form>
    <p class="lp-fine">Takes about ten minutes to set up. Cancel any time.</p>
  </div>
  <div class="lp-shot" role="img" aria-label="Totali's home screen for a restaurant, with sample figures">
    <div class="lp-shot-bar"><span class="lp-dot"></span><b>Harbor Street Kitchen</b><span>Full-service restaurant · 2 locations · Michigan</span></div>
    <div class="lp-shot-grid">
      <div class="lp-shot-main">
        <i>Next payroll</i><b class="lp-big">Fri, Nov 6</b><span>Run it by Thu, Nov 5 · 14 people</span>
        <div class="lp-checks"><span class="ok">Hours pulled from Toast today</span><span class="ok">Every W-4 is on file</span><span class="warn">1 person without direct deposit</span></div>
        <span class="lp-fake-btn">Review and approve</span>
      </div>
      <div class="lp-shot-side">
        <i>This week</i>
        <div class="lp-kv"><span>Hours</span><b>412</b></div>
        <div class="lp-kv"><span>Estimated wages</span><b>$7,846</b></div>
        <div class="lp-kv"><span>Tips</span><b>$5,120</b></div>
        <div class="lp-kv"><span>Overtime</span><b>3.4%</b></div>
      </div>
    </div>
    <div class="lp-shot-roles">
      <div><span>Servers</span><b>186 h</b><i>$3,720 tips</i></div>
      <div><span>Line cooks</span><b>112 h</b><i></i></div>
      <div><span>Bartenders</span><b>64 h</b><i>$1,400 tips</i></div>
      <div><span>Hosts</span><b>50 h</b><i></i></div>
    </div>
    <p class="lp-sample">Sample data</p>
  </div>
</section>

<section class="lp-sec" id="how">
  <h2>From signup to first payroll</h2>
  <ol class="lp-steps">
    <li><b>Answer a few questions.</b><span>Your state, locations, whether you have tipped staff, how often you pay. Your dashboard is built from the answers, not from a template.</span></li>
    <li><b>Connect where hours come from.</b><span>Toast, Square or 7shifts, or import the hours report from any other POS. Hours and tips come in without anyone typing them.</span></li>
    <li><b>Review and approve.</b><span>Check the hours, see how each tax was worked out, approve. Totali writes the payment file for your bank.</span></li>
  </ol>
</section>

<section class="lp-sec lp-alt" id="restaurants">
  <h2>Built around how a restaurant pays people</h2>
  <dl class="lp-grid">
    <div><dt>Tips and tip pools</dt><dd>Card and cash tips, split by hours or by role, shown on each stub and counted toward taxable pay.</dd></div>
    <div><dt>The tip credit</dt><dd>Tipped cash wage, the written notice you need, and the minimum wage your state expects, checked before you approve.</dd></div>
    <div><dt>Overtime and split shifts</dt><dd>Overtime is worked out from the week and flagged before you approve, so there are no surprises on payday.</dd></div>
    <div><dt>Different pay by position</dt><dd>A server, a line cook and a dishwasher are each paid the way their job is paid, and your labor is shown by position.</dd></div>
    <div><dt>State and city rules</dt><dd>Your state’s withholding and unemployment, and city income taxes where they apply, set up from your answers.</dd></div>
    <div><dt>More than one location</dt><dd>Add each place. People are paid, and taxed, by where they work.</dd></div>
  </dl>
</section>

<section class="lp-sec" id="pos">
  <div class="lp-two">
    <div>
      <h2>Your hours and tips come from your POS</h2>
      <p>You shouldn’t type the same shifts twice. Connect your system and Totali reads your staff, their hours and their tips. It only reads: it never changes anything in your POS.</p>
      <ul class="lp-list">
        <li><b>Toast</b> Connect with your restaurant’s API credentials.</li>
        <li><b>Square</b> Sign in with Square and approve.</li>
        <li><b>7shifts</b> Connect with an access token.</li>
        <li><b>Anything else</b> Export your hours report as a spreadsheet and import it. Totali finds the columns, and you check them before anything is saved.</li>
      </ul>
    </div>
    <div class="lp-card" role="img" aria-label="An imported hours report, with sample data">
      <div class="lp-card-h"><b>Hours report</b><span>labor.csv</span></div>
      <table><thead><tr><th>Employee</th><th>Date</th><th>Paid hours</th><th>Card tips</th></tr></thead><tbody>
        <tr><td>Dana Okafor</td><td>Oct 20</td><td>6.5</td><td>$84.50</td></tr>
        <tr><td>Tom Whitaker</td><td>Oct 20</td><td>5.0</td><td>$61.75</td></tr>
        <tr><td>Lucia Ferrante</td><td>Oct 21</td><td>4.0</td><td>$22.00</td></tr>
      </tbody></table>
      <p>Columns found: Employee, Date, Paid hours, Card tips. <b>3 shifts ready to import.</b></p>
      <p class="lp-sample">Sample data</p>
    </div>
  </div>
</section>

<section class="lp-sec lp-alt" id="taxes">
  <div class="lp-two lp-rev">
    <div class="lp-receipt" role="img" aria-label="A sample pay stub with each tax line, illustrative figures">
      <div class="lp-card-h"><b>Elena Ruiz, Server</b><span>Oct 19 to 25</span></div>
      <div class="lp-row"><span>Wages, 32.5 h</span><b>$503.75</b></div>
      <div class="lp-row"><span>Tips reported</span><b>$412.30</b></div>
      <div class="lp-row lp-total"><span>Gross pay</span><b>$916.05</b></div>
      <div class="lp-row"><span>Federal income tax</span><b>-$77.86</b></div>
      <div class="lp-row"><span>Social Security</span><b>-$56.80</b></div>
      <div class="lp-row"><span>Medicare</span><b>-$13.28</b></div>
      <div class="lp-row"><span>State income tax</span><b>-$21.99</b></div>
      <div class="lp-row lp-total"><span>Net pay</span><b>$746.12</b></div>
      <p class="lp-sample">Illustrative figures</p>
    </div>
    <div>
      <h2>See how every tax was worked out</h2>
      <p>Open any paycheck and see federal, Social Security, Medicare and state, line by line, and what each was based on. After a run is approved, a separate check recalculates every tax from the payroll register and reports any difference.</p>
      <p>New hires fill in their own W-4, I-9 and direct deposit on their phone from a link you send. You see who is still missing something.</p>
    </div>
  </div>
</section>

<section class="lp-sec" id="control">
  <h2>You stay in control of your money</h2>
  <div class="lp-cols">
    <div><b>Totali never holds your money.</b><span>When you approve a run, Totali writes the payment file. You download it, upload it at your own bank and release it there.</span></div>
    <div><b>Sensitive details are encrypted.</b><span>Social Security numbers, bank account numbers and tax IDs are encrypted before they are stored. Card numbers never reach us: payment is handled by Stripe.</span></div>
    <div><b>You approve everything.</b><span>Nothing is paid until you review the run and approve it. Anything unusual is flagged first.</span></div>
  </div>
</section>

<section class="lp-sec lp-alt" id="pricing">
  <div class="lp-price">
    <div>
      <h2>One price</h2>
      <p>No per-employee fee, no setup fee, no tiers. Cancel any time and keep access until the period you paid for ends.</p>
    </div>
    <div class="lp-plan">
      <div class="lp-amount"><b>$20</b><span>every 3 months</span></div>
      <ul>
        <li>Every employee, however many</li>
        <li>Every pay run</li>
        <li>Tax calculations explained</li>
        <li>POS connection and report import</li>
        <li>New-hire paperwork and reports</li>
      </ul>
      <form class="lp-join" data-signup><input type="email" placeholder="Work email" aria-label="Work email"><button class="btn" type="submit">Get started</button></form>
    </div>
  </div>
</section>

<section class="lp-sec" id="faq">
  <h2>Questions</h2>
  <div class="lp-faq">
    <details><summary>Does Totali pay my employees?</summary><p>No. Totali works out the pay and writes the payment file. You upload it to your own bank, which sends the money. Totali never holds or moves your money.</p></details>
    <details><summary>Does Totali file my taxes?</summary><p>Totali calculates your payroll taxes, shows what is due and when, and prepares the figures for your filings. It does not file returns or send tax payments for you, so you or your accountant still do that.</p></details>
    <details><summary>Which POS systems work?</summary><p>You can connect Toast, Square or 7shifts. Any other system that can export an hours report as a spreadsheet works through the report import. Clover sign-in is coming.</p></details>
    <details><summary>Does it work in my state?</summary><p>Totali sets up your state’s withholding, unemployment and new-hire form from your answers, and city income taxes where they apply. Where a rule is not modeled, the app tells you and asks you to decide it.</p></details>
    <details><summary>What if I have a lot of employees?</summary><p>The price does not change. It is $20 every three months for the whole restaurant.</p></details>
    <details><summary>Can I cancel?</summary><p>Any time, from Billing. You keep access until the three months you paid for are up.</p></details>
  </div>
</section>

<footer class="lp-foot">
  <a class="logo sm" href="/">totali</a>
  <p>Totali is a product of OMNIA TAX LLC. Sample data on this page is made up. <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · hello@omnia.tax</p>
</footer>
</div>
`;
