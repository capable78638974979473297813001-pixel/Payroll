// The marketing page. Static and trusted: no user text goes in. Every claim here is something the app does today.
export default `
<div class="lp">
<header class="lp-top">
  <a class="logo" href="/" aria-label="Totali">totali<svg viewBox="0 0 120 10" preserveAspectRatio="none"><path d="M2 6 C 22 1, 40 9, 62 5 S 100 2, 118 6" fill="none" stroke="#F0613A" stroke-width="2.6" stroke-linecap="round"/></svg></a>
  <nav aria-label="Page"><a href="#what">What it does</a><a href="#industries">Industries</a><a href="#limits">What it doesn’t do</a><a href="#pricing">Pricing</a></nav>
  <span class="lp-acct"><a href="/employee">Employee sign in</a><a href="/login">Log in</a><a class="btn sm" href="/signup">Create account</a></span>
</header>

<section class="lp-hero">
  <div class="lp-hero-copy">
    <h1>Payroll for restaurants, crews and small teams.</h1>
    <p>Totali figures out each paycheck, shows you how every tax was worked out, and writes the bank file you upload to pay your people. New hires fill in their own tax forms. Employees sign in to see their own stubs.</p>
    <form class="lp-join" data-signup><input type="email" placeholder="Work email" aria-label="Work email"><button class="btn" type="submit">Create account</button></form>
    <p class="lp-fine">Setup takes about five minutes. Taxes are calculated by the Omnia.tax engine.</p>
  </div>
  <div class="lp-shot" role="img" aria-label="A weekly pay run with sample figures">
    <div class="lp-shot-h"><b>Weekly pay run</b><span>Oct 19 to Oct 25 · pays Fri, Oct 30</span></div>
    <table>
      <thead><tr><th>Employee</th><th>Hours</th><th>Tips</th><th>Gross</th><th>Taxes</th><th>Net</th></tr></thead>
      <tbody>
        <tr><td>Priya Raman<i>Line cook</i></td><td>40</td><td>&ndash;</td><td>$860.00</td><td>$159.53</td><td><b>$700.47</b></td></tr>
        <tr><td>Marcus Bell<i>Sous chef</i></td><td>46</td><td>&ndash;</td><td>$1,274.00</td><td>$236.33</td><td><b>$1,037.67</b></td></tr>
        <tr><td>Elena Ruiz<i>Server</i></td><td>32.5</td><td>$412.30</td><td>$916.05</td><td>$169.93</td><td><b>$746.12</b></td></tr>
        <tr><td>Jordan Pike<i>Server</i></td><td>18</td><td>$148.50</td><td>$427.50</td><td class="warn">Needs a W-4</td><td>&ndash;</td></tr>
      </tbody>
    </table>
    <p class="lp-fine">Sample figures. Marcus is paid 6 hours of overtime. Jordan is left out of the totals until their W-4 is on file.</p>
  </div>
</section>

<section class="lp-sec" id="what">
  <h2>What Totali does</h2>
  <dl class="lp-list">
    <div><dt>Runs payroll</dt><dd>Enter hours and tips, or import a spreadsheet. Totali works out regular and overtime pay, tips, bonuses, commissions and reimbursements, then federal, state and local taxes, Social Security and Medicare. Before you approve a run it flags anything missing, like a W-4 that isn’t on file.</dd></div>
    <div><dt>Shows its math</dt><dd>Open any paycheck and see each tax line and what it was based on. After a run is approved, a separate program recalculates every tax from the payroll register and reports any difference.</dd></div>
    <div><dt>Helps you pay your team</dt><dd>When you approve a run, Totali writes the direct deposit file. You download it, upload it at your own bank and release it there. Totali never holds your money.</dd></div>
    <div><dt>Keeps track of taxes</dt><dd>It lists what is due and when, for federal and state deposits and quarterly forms, and lets you mark each one paid. You make the payments yourself.</dd></div>
    <div><dt>Onboards new hires</dt><dd>Enter a name and an email. They get a link to fill in their W-4, their state form, I-9 section 1 and their bank details on a phone. You see who is still missing something and can send a reminder.</dd></div>
    <div><dt>Gives employees their own sign-in</dt><dd>You get a code like <span class="mono">K7PM-4QXR</span> to hand out. Employees use it with their email to see pay stubs and hours, update their W-4, and ask to change their bank account. Nothing changes until you approve it.</dd></div>
  </dl>
</section>

<section class="lp-sec lp-alt" id="answers">
  <div class="lp-two">
    <div>
      <h2>Your dashboard is built from your answers</h2>
      <p>After you sign up, you answer a short list of questions about your business. Each answer adds the screens and rules you need and leaves out the ones you don’t. You can change an answer later and the dashboard follows.</p>
      <p>Then you arrange it. Move cards around, resize them, add or remove tabs, and pick the colors and name. A high-end restaurant and a roofing crew end up with different dashboards because they answered differently.</p>
    </div>
    <ul class="lp-qs" aria-label="Examples of what the questions decide">
      <li><b>Which state are you in?</b> Sets state taxes, the new-hire form and the minimum wage.</li>
      <li><b>Do staff earn tips?</b> Adds tip entry, a tip pool and the tip rules for your state.</li>
      <li><b>Do you pay a lower cash wage to tipped staff?</b> Turns on the tip credit and asks for the written notice at hire.</li>
      <li><b>Do you pay bonuses or reimbursements?</b> Adds them to the pay run. Reimbursements aren’t taxed.</li>
      <li><b>Do you take anything out of pay?</b> Adds health plans, 401(k) and other deductions on each person.</li>
      <li><b>Did you pay people earlier this year somewhere else?</b> Lets you enter their year-to-date so Social Security limits come out right.</li>
      <li><b>How often do you pay?</b> Sets your schedule and the date to run payroll by.</li>
    </ul>
  </div>
</section>

<section class="lp-sec" id="industries">
  <div class="lp-two lp-photo">
    <figure><img src="/assets/img/chef.jpg" alt="Cooks plating dishes at the pass" loading="lazy"></figure>
    <div>
      <h2>Set up for how your team gets paid</h2>
      <p>Pick one when you sign up. It decides which questions you’re asked.</p>
      <dl class="lp-defs">
        <div><dt>Restaurants</dt><dd>Tips, tip pools, tip credit and split shifts.</dd></div>
        <div><dt>Hospitality</dt><dd>Seasonal staff and more than one location.</dd></div>
        <div><dt>Trades and construction</dt><dd>Hours by job and crew, job costing and workers’ comp classes.</dd></div>
        <div><dt>Office</dt><dd>Salaried and hourly staff.</dd></div>
        <div><dt>Delivery</dt><dd>Hourly staff and contractor drivers. Pay per trip and mileage are not built yet.</dd></div>
      </dl>
    </div>
  </div>
</section>

<section class="lp-sec lp-alt" id="limits">
  <h2>What it doesn’t do yet</h2>
  <p class="lp-lead">We’d rather tell you now.</p>
  <ul class="lp-plain">
    <li>It doesn’t move money. You upload the bank file yourself.</li>
    <li>It doesn’t file your tax forms or 1099s. It tracks due dates and gives you the numbers and exports for your accountant.</li>
    <li>Only the owner signs in to the main dashboard. There are no manager accounts yet.</li>
    <li>Michigan has its own new-hire tax form. Other states use the federal W-4 and the state’s standard withholding.</li>
    <li>Invites go by email, not text.</li>
  </ul>
</section>

<section class="lp-sec" id="pricing">
  <div class="lp-two">
    <div>
      <h2>One price per employee</h2>
      <p>You’re billed for people who are on a pay run that month, and nothing else. We confirm your price before your first invoice.</p>
    </div>
    <form class="lp-join lp-end" data-signup>
      <label for="em">Work email</label>
      <input id="em" type="email" placeholder="you@yourrestaurant.com">
      <button class="btn" type="submit">Create account</button>
    </form>
  </div>
</section>

<footer class="lp-foot">
  <a class="logo sm" href="/">totali</a>
  <p>Totali is a product of OMNIA TAX LLC. Figures on this page are made up. Photo: Madeline Liu on Unsplash. <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></p>
</footer>
</div>
`;
