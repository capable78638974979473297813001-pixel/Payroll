from lib import *
G="4 · App pages"
R='restaurants'
def daysplit(h,seed):
    if h==0: return [0]*7
    n=max(2,round(h/7.5)); per=round(h/n*2)/2
    d=[per]*n; d[-1]=round(h-per*(n-1),1)
    off=(seed*2)%(8-n) if n<7 else 0
    return ([0]*off+d+[0]*7)[:7]
def fh(x): return ("%g"%x)
def stepbar(on):
    labs=["Pick period","Hours and tips","Review","Approve"]
    out=""
    for i,l in enumerate(labs):
        cls="done" if i<on else ("on" if i==on else "")
        out+=f'<span class="{cls}" data-n="{i+1}">{l}</span>'+('<i></i>' if i<3 else '')
    return f'<div class="pstep">{out}</div>'

def run_payroll():
    rows=""
    for e,r in zip(EMPS,RUN):
        nm,role,loc,h,ot,rate,tips,flag,res=e
        note=dt("W-4 missing",False) if flag=='w4' else (chip("6 hrs overtime","warn") if ot else "")
        rows+=f'<tr><td>{who(nm,role)}</td><td class="l hm">{loc}</td><td><input value="{fh(h)}"></td><td><input class="{"e" if ot else ""}" value="{fh(ot)}"></td><td><input value="{tips:,.2f}"></td><td class="l hm">{note}</td></tr>'
    tbl=f'''<div class="card"><div class="ch"><h3 class="ct">Hours and tips</h3><span class="cap">Week of Oct 19. Edit any cell.</span></div>
<table class="tbl"><thead><tr><th>Employee</th><th class="l hm">Location</th><th>Regular hrs</th><th>Overtime hrs</th><th>Tips ($)</th><th class="l hm">Notes</th></tr></thead><tbody>{rows}</tbody></table></div>'''
    side=f'''<div class="grid"><div class="card"><h3 class="ct" style="margin-bottom:10px">This pay run</h3>
<dl class="kv" style="grid-template-columns:110px 1fr;font-size:13.5px"><dt>Period</dt><dd>Oct 19 to Oct 25, 2026</dd><dt>Pay date</dt><dd>Fri, Oct 30</dd><dt>Schedule</dt><dd>Weekly</dd><dt>Locations</dt><dd>Detroit, Ferndale</dd></dl></div>
<div class="card"><h3 class="ct" style="margin-bottom:6px">Tips this week</h3><div class="big2"><div><span class="n">{money(TOT["tips"]+148.5)}</span></div></div><p class="cap">Card and cash tips, split by hours worked. <a class="link">Change split</a></p></div>
<div class="alert"><span class="dot"></span><span><b>Jordan Pike</b> has no W-4 on file, so taxes can\u2019t be worked out yet. <a class="link">Send reminder</a></span></div>
<a class="btn ghost sm" style="text-align:center">Import hours from a spreadsheet</a></div>'''
    body=ph("Run <em>payroll</em>","Weekly pay run for Harbor Street Kitchen",'<a class="btn ghost sm">Save draft</a>')+stepbar(1)+f'<div class="grid g32" style="grid-template-columns:1fr 340px;margin-top:18px">{tbl}{side}</div><div class="acts" style="justify-content:flex-end;margin-top:18px"><a class="link">Back</a><a class="btn" href="pay-run-review.html">Continue to review</a></div>'
    app_page('run-payroll','Run payroll',G,R,'Payroll',body,True,'Step 2: hours and tips for the week.')

def pay_review():
    rows=""
    for r in RUN:
        if r['flag']=='w4':
            rows+=f'<tr><td>{who(r["name"],r["role"])}</td><td class="l hm">{r["loc"]}</td><td class="hm">{fh(r["hrs"])}</td><td class="hm">{money(r["tips"])}</td><td>{money(r["gross"])}</td><td colspan="4" class="hm l"><span class="warn">Needs W-4. Left out of this run.</span></td><td><span class="mut">&ndash;</span></td></tr>'
            continue
        hrs=fh(r['hrs'])+(f' <span class="otn">OT {fh(r["ot"])}</span>' if r['ot'] else '')
        rows+=f'<tr><td>{who(r["name"],r["role"])}</td><td class="l hm">{r["loc"]}</td><td class="hm">{hrs}</td><td class="hm">{money(r["tips"]) if r["tips"] else "<span class=mut>&ndash;</span>"}</td><td>{money(r["gross"])}</td><td class="hm">{money(r["fed"])}</td><td class="hm">{money(r["ss"]+r["med"])}</td><td class="hm">{money(r["mi"])}</td><td class="hm">{money(r["city"]) if r["city"] else "<span class=mut>&ndash;</span>"}</td><td><b>{money(r["net"])}</b></td></tr>'
    rows+=f'<tr class="tot"><td>Total, {TOT["n"]} employees</td><td class="hm"></td><td class="hm"></td><td class="hm">{money(TOT["tips"])}</td><td>{money(TOT["gross"])}</td><td class="hm">{money(TOT["fed"])}</td><td class="hm">{money(TOT["ss"]+TOT["med"])}</td><td class="hm">{money(TOT["mi"])}</td><td class="hm">{money(TOT["city"])}</td><td>{money(TOT["net"])}</td></tr>'
    er=er_tax()
    stats=f'<div class="stats"><div><i>Gross pay</i><b>{money(TOT["gross"])}</b></div><div><i>Employee taxes</i><b>{money(TOT["tax"])}</b></div><div><i>Net pay</i><b>{money(TOT["net"])}</b></div><div><i>Employees on this run</i><b>{TOT["n"]}</b><small>1 left out</small></div></div>'
    tbl=f'''<div class="card"><div class="ch"><h3 class="ct">Every paycheck, line by line</h3><span class="cap">Taxes by the Omnia.tax engine · Sample data</span></div>
<table class="tbl"><thead><tr><th>Employee</th><th class="l hm">Location</th><th class="hm">Hours</th><th class="hm">Tips</th><th>Gross</th><th class="hm">Federal</th><th class="hm">SS + Medicare</th><th class="hm">Michigan</th><th class="hm">Detroit</th><th>Net</th></tr></thead><tbody>{rows}</tbody></table></div>'''
    side=f'''<div class="grid"><div class="card"><h3 class="ct" style="margin-bottom:8px">Before you approve</h3>
<div class="row"><span class="l1"><b>Jordan Pike, no W-4</b><i>Left out until it\u2019s on file</i></span>{chip("Review","warn")}</div>
<div class="row"><span class="l1"><b>Marcus Bell, 6 overtime hours</b><i>Paid at 1.5 times his rate</i></span>{chip("Looks right","ok")}</div>
<div class="row"><span class="l1"><b>Detroit staff, city tax</b><i>Resident and non-resident rates applied</i></span>{chip("Auto","ok")}</div></div>
<div class="card"><h3 class="ct" style="margin-bottom:6px">What it costs you</h3><table class="tbl"><tbody>
<tr><td>Gross pay</td><td>{money(TOT["gross"])}</td></tr><tr><td>Employer Social Security</td><td>{money(er["ss"])}</td></tr><tr><td>Employer Medicare</td><td>{money(er["med"])}</td></tr><tr><td>Federal unemployment</td><td>{money(er["futa"])}</td></tr><tr><td>Michigan unemployment</td><td>{money(er["mi_ui"])}</td></tr>
<tr class="tot"><td>Total</td><td>{money(TOT["gross"]+er["ss"]+er["med"]+er["futa"]+er["mi_ui"])}</td></tr></tbody></table></div>
<div class="card" style="background:#FBF1E5"><p class="cap" style="margin-bottom:12px">Approving locks these numbers and creates a pay stub for each person. Totali works out the pay and keeps the records. Paying your team happens outside Totali.</p><a class="btn" style="display:block;text-align:center" href="pay-stub.html">Approve pay run</a></div></div>'''
    body=ph("Review the <em>pay run</em>","Weekly · Oct 19 to Oct 25, 2026 · Pay date Fri, Oct 30",'<a class="btn ghost sm">Back to hours</a>')+stepbar(2)+f'<div style="margin:18px 0">{stats}</div><div class="grid" style="grid-template-columns:1fr 360px">{tbl}{side}</div>'
    app_page('pay-run-review','Pay run review',G,R,'Payroll',body,True,'Step 3: every paycheck line by line, with employer cost.')

def pay_stub():
    r=RUN[2]
    def ln(a,b,cls=""): return f'<div class="rl {cls}"><span>{a}</span><span>{b}</span></div>'
    reg_=r['hrs']*r['rate']
    rec=f'''<div class="receipt"><div class="rh"><b>Harbor Street Kitchen</b><span>Pay stub · Elena Ruiz · Server · Detroit</span></div>
<div class="rl"><span>Period</span><span>Oct 19 to Oct 25, 2026</span></div><div class="rl"><span>Pay date</span><span>Fri, Oct 30, 2026</span></div><hr>
{ln("Regular, 32.5 hrs at $15.50",money(reg_))}<div class="rl circle" style="margin:6px 0"><span>Tips, card and cash</span><span>{money(r["tips"])}</span></div>{ln("Gross pay",money(r["gross"]),"t")}<hr>
{ln("Federal income tax",money(r["fed"]))}{ln("Social Security",money(r["ss"]))}{ln("Medicare",money(r["med"]))}{ln("Michigan income tax",money(r["mi"]))}{ln("Detroit city tax, resident",money(r["city"]))}{ln("Total taxes",money(r["tax"]),"t")}<hr>
{ln("Net pay",money(r["net"]),"big")}
<div class="rf">Earned sick time balance: 21.4 hrs<br>Taxes calculated by the Omnia.tax engine.<br>SAMPLE DATA · not a real paycheck.</div></div>'''
    how=f'''<div style="position:relative"><h2 class="st2">How Elena\u2019s check was <em>worked out</em></h2>
<div class="cal">
<div class="calr"><span><b>Gross {money(r["gross"])}</b><i>32.5 hours at $15.50, plus {money(r["tips"])} in tips. Tips count as pay for tax.</i></span><span></span></div>
<div class="calr"><span><b>Federal income tax</b><i>From her W-4. Single, no extra withholding.</i></span><b>{money(r["fed"])}</b></div>
<div class="calr"><span><b>Social Security and Medicare</b><i>6.2% and 1.45% of gross.</i></span><b>{money(r["ss"]+r["med"])}</b></div>
<div class="calr"><span><b>Michigan income tax</b><i>From her MI-W4, one exemption.</i></span><b>{money(r["mi"])}</b></div>
<div class="calr"><span><b>Detroit city tax</b><i>She lives and works in Detroit, so the resident rate applies.</i></span><b>{money(r["city"])}</b></div>
<div class="calr" style="border-bottom:1px solid var(--line)"><span><b>Net pay</b><i>What\u2019s left after taxes.</i></span><b style="color:var(--berry)">{money(r["net"])}</b></div></div>
<div class="hand" style="margin-top:18px;transform:rotate(-1.5deg);font-size:24px">Tap any line on the app to see this.</div>
<div class="acts" style="margin-top:18px"><a class="btn ghost sm">Download PDF</a><a class="btn ghost sm">Next stub</a><a class="link" href="employee-profile.html">Back to Elena</a></div></div>'''
    body=ph("Pay <em>stub</em>","Elena Ruiz · Weekly · Oct 19 to Oct 25",'<span class="sample-tag">Sample data</span>')+f'<div class="stubwrap"><div style="position:relative">{rec}</div>{how}</div>'
    app_page('pay-stub','Pay stub',G,R,'Payroll',body,True,'Pay stub as a receipt, with how each line was worked out.')

def employees():
    extra=[("Noor Patel","Server","Detroit","$15.50/hr","pend")]
    paper={"Jordan Pike":(0,1,1),"Colin Marsh":(1,1,0),"Noor Patel":(0,0,0)}
    rows=""
    for r in RUN+[dict(name="Noor Patel",role="Server",loc="Detroit",rate=15.5)]:
        p=paper.get(r['name'],(1,1,1))
        st=chip("Invited","berry") if r['name']=="Noor Patel" else (chip("Needs paperwork","warn") if p!=(1,1,1) else chip("Active","ok"))
        rows+=f'<tr><td>{who(r["name"],r["role"])}</td><td class="l hm">{r["loc"]}</td><td class="hm">${r["rate"]:.2f}/hr</td><td class="l hm"><span class="dots">{dt("W-4",p[0])}{dt("I-9",p[1])}{dt("Deposit",p[2])}</span></td><td class="l">{st}</td></tr>'
    f=''.join(f'<span class="pill {"on" if i==0 else ""}">{t}</span>' for i,t in enumerate(["All 14","Detroit 8","Ferndale 6","Needs paperwork 3","Tipped 9"]))
    tbl=f'''<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:16px"><div class="chips2">{f}</div><div class="in ph" style="width:240px;min-height:38px;padding:8px 12px;font-size:14px">Search people</div></div>
<table class="tbl"><thead><tr><th>Name</th><th class="l hm">Work location</th><th class="hm">Pay</th><th class="l hm">Paperwork</th><th class="l">Status</th></tr></thead><tbody>{rows}</tbody></table></div>'''
    body=ph("<em>People</em>","14 people across two locations",'<a class="btn ghost sm">Import from spreadsheet</a><a class="btn sm" href="onboarding.html">Add employee</a>')+tbl
    app_page('employees','Employees',G,R,'People',body,False,'Employee list with paperwork status and location filters.')

def profile():
    r=RUN[2]
    head=f'''<div style="display:flex;gap:20px;align-items:center;margin:28px 0 20px"><span class="av" style="width:68px;height:68px;font-size:22px;background:var(--blush);color:var(--berry)">ER</span>
<div style="flex:1"><h1 class="pt" style="font-size:28px">Elena <em>Ruiz</em></h1><p class="cap">Server · Detroit · Started Mar 3, 2025 · {chip("Active","ok")} {chip("Tipped","berry")}</p></div><div class="acts"><a class="btn ghost sm">Edit</a><a class="btn sm" href="pay-stub.html">Latest stub</a></div></div>
<div class="tabs2"><a class="on">Overview</a><a>Pay</a><a>Taxes</a><a>Documents</a><a>Time off</a></div>'''
    c1=f'''<div class="card"><h3 class="ct" style="margin-bottom:12px">Job and pay</h3><dl class="kv"><dt>Role</dt><dd>Server</dd><dt>Hourly rate</dt><dd>$15.50</dd><dt>Pay type</dt><dd>Hourly, tipped</dd><dt>Work location</dt><dd>Detroit</dd><dt>Typical week</dt><dd>32 hours</dd><dt>Pay schedule</dt><dd>Weekly, Fridays</dd></dl></div>'''
    c2=f'''<div class="card"><div class="ch"><h3 class="ct">Tax setup</h3>{chip("Calculated by Omnia.tax","line")}</div><dl class="kv"><dt>Federal W-4</dt><dd>Single, no extra withholding</dd><dt>Michigan MI-W4</dt><dd>1 exemption</dd><dt>City</dt><dd>Detroit resident</dd><dt>Tips</dt><dd>Reported each week</dd></dl></div>'''
    c3=f'''<div class="card"><h3 class="ct" style="margin-bottom:6px">Paperwork</h3>
<div class="row"><span class="l1"><b>W-4</b><i>Signed Mar 2, 2025</i></span>{dt("On file")}</div><div class="row"><span class="l1"><b>MI-W4</b><i>Signed Mar 2, 2025</i></span>{dt("On file")}</div><div class="row"><span class="l1"><b>I-9</b><i>Sections 1 and 2 done</i></span>{dt("On file")}</div><div class="row"><span class="l1"><b>Direct deposit</b><i>Checking ending 4821 (sample)</i></span>{dt("On file")}</div></div>'''
    stubs="".join(f'<tr><td>{d}</td><td>{h}</td><td>{money(g)}</td><td><b>{money(n)}</b></td></tr>' for d,h,g,n in [("Oct 19 to Oct 25",32.5,r['gross'],r['net']),("Oct 12 to Oct 18",30,884.20,666.38),("Oct 5 to Oct 11",34,931.55,702.17),("Sep 28 to Oct 4",29,846.90,638.42)])
    c4=f'''<div class="card"><div class="ch"><h3 class="ct">Recent pay</h3><a class="link" href="pay-stub.html">All stubs</a></div><table class="tbl"><thead><tr><th>Week</th><th>Hours</th><th>Gross</th><th>Net</th></tr></thead><tbody>{stubs}</tbody></table><p class="cap" style="margin-top:10px">Sample data.</p></div>'''
    c5=f'''<div class="card"><div class="ch"><h3 class="ct">Earned sick time</h3>{chip("Michigan","berry")}</div><div class="big2"><div><i>Balance</i><span class="n">21.4 hrs</span></div><div><i>Used this year</i><span class="n">8 hrs</span></div></div><div class="prg"><span style="width:60%"></span></div><p class="cap">Hours build up as she works. You set the policy in Settings.</p></div>'''
    body=head+f'<div class="grid g3" style="grid-template-columns:1fr 1fr 1fr">{c1}{c2}{c3}</div><div class="grid g32" style="grid-template-columns:2fr 1fr;margin-top:18px">{c4}{c5}</div>'
    app_page('employee-profile','Employee profile',G,R,'People',body,False,'Elena Ruiz: job, tax setup, paperwork, pay history, sick time.')

def onboarding():
    rows=""
    for nm,role,when,a,b,c,st in [("Noor Patel","Server, Detroit","Invited Oct 28 · starts Nov 2",0,0,0,chip("Waiting","berry")),("Jordan Pike","Server, Ferndale","Started Sep 14",0,1,1,chip("W-4 missing","warn")),("Colin Marsh","Busser, Ferndale","Started Oct 5",1,1,0,chip("Deposit missing","warn")),("Ben Kowalski","Bartender, Ferndale","Started Aug 20",1,1,1,chip("Done","ok"))]:
        rows+=f'<tr><td>{who(nm,role)}</td><td class="l hm">{when}</td><td class="l"><span class="dots">{dt("W-4",a)}{dt("I-9",b)}{dt("Deposit",c)}</span></td><td class="l">{st}</td><td class="l hm"><a class="link">{"Send reminder" if st.find("Done")<0 else "View"}</a></td></tr>'
    tr=f'<div class="card"><div class="ch"><h3 class="ct">Who\u2019s finished</h3><span class="cap">3 of 14 still to do</span></div><table class="tbl"><thead><tr><th>Person</th><th class="l hm">Status</th><th class="l">Paperwork</th><th class="l"></th><th class="l hm"></th></tr></thead><tbody>{rows}</tbody></table></div>'
    form=f'''<div class="card"><h3 class="ct" style="margin-bottom:14px">Invite a new hire</h3><div class="f">
<div class="r2"><div><label>First name</label><div class="in fill">Noor</div></div><div><label>Last name</label><div class="in fill">Patel</div></div></div>
<div><label>Email or phone</label><div class="in fill">noor.p@example.com</div></div>
<div class="r2"><div><label>Role</label><div class="in fill">Server</div></div><div><label>Location</label><div class="in sel fill"><span>Detroit</span>{CHEV}</div></div></div>
<div class="r2"><div><label>Hourly rate</label><div class="in fill">$15.50</div></div><div><label>Start date</label><div class="in fill">Nov 2, 2026</div></div></div>
<div><label>Forms they\u2019ll fill in on their phone</label><div class="opts"><div class="opt on"><span class="cb"></span><span>W-4<small>Federal withholding</small></span></div><div class="opt on"><span class="cb"></span><span>MI-W4<small>Added because you\u2019re in Michigan</small></span><em>Michigan</em></div><div class="opt on"><span class="cb"></span><span>I-9<small>Section 1 by them, section 2 by you</small></span></div><div class="opt on"><span class="cb"></span><span>Direct deposit<small>Bank details for setup</small></span></div></div></div>
<a class="btn" style="text-align:center" href="onboard-w4.html">Send invite</a></div></div>'''
    body=ph("<em>Onboarding</em>","New hires finish their forms on their own phone",'')+f'<div class="grid" style="grid-template-columns:1fr 440px;align-items:start">{tr}{form}</div>'
    app_page('onboarding','Onboarding',G,R,'Onboarding',body,True,'Employer view: invite a hire, see who has finished their paperwork.',badge="3")

def emp_shell(id,title,stepn,h,sub,form,helpd,desc):
    top=f'<header class="eptop ui">{LOGO_SM}<span class="co"><span class="orgmark">H</span>Harbor Street Kitchen</span></header>'
    prog='<div class="steps3" style="margin-bottom:18px">'+'<i></i>'.join(f'<span class="{"done" if i<stepn else ("on" if i==stepn else "")}">{t}</span>' for i,t in enumerate(["W-4","I-9","Deposit"]))+'</div>'
    body=f'''{top}<main class="empage ui"><div><p class="cap" style="margin-bottom:6px">Hi Noor. Three short forms, about 6 minutes.</p>{prog}<h1 class="pt" style="font-size:26px">{h}</h1><p class="cap" style="margin:6px 0 20px">{sub}</p>{form}</div><aside style="position:relative;padding-top:20px">{helpd}</aside></main>
<div class="ui" style="text-align:center;padding:0 20px 40px;color:var(--mut);font-size:12.5px">Sample form with sample data · Totali is a product of OMNIA TAX LLC</div>'''
    reg(id,title,G,body,True,desc)
def w4():
    form='''<div class="f"><div><div class="sec2">Step 1 · Filing status</div>
<div class="opts" style="margin-top:8px"><div class="opt on"><span class="rd"></span>Single or married filing separately</div><div class="opt"><span class="rd"></span>Married filing jointly</div><div class="opt"><span class="rd"></span>Head of household</div></div></div>
<div><div class="sec2">Step 2 · More than one job?</div><div class="opts c2" style="margin-top:8px"><div class="opt on"><span class="rd"></span>No, just this one</div><div class="opt"><span class="rd"></span>Yes</div></div></div>
<div><div class="sec2">Step 3 · Dependents</div><div class="r2" style="margin-top:8px"><div><label>Children under 17</label><div class="in fill">0</div></div><div><label>Other dependents</label><div class="in fill">0</div></div></div></div>
<div><div class="sec2">Michigan · MI-W4</div><div style="margin-top:8px"><label>Exemptions</label><div class="in fill">1</div></div></div>
<div><div class="sec2">Sign</div><div class="sig" style="margin-top:8px">Noor Patel</div><p class="help">By signing you say this is correct to the best of your knowledge.</p></div>
<a class="btn lg" style="text-align:center" href="onboard-i9.html">Save and continue</a></div>'''
    helpd=f'''<div class="card" style="background:#FBF1E5;box-shadow:none"><h3 class="ct" style="margin-bottom:8px">Why we ask</h3><p class="cap" style="font-size:14px">Your answers tell payroll how much tax to hold back from each paycheck. You can change them any time.</p></div>
<div class="hand" style="margin-top:20px;font-size:25px;transform:rotate(-2deg)">Not sure? Single, no extras is a fine place to start.</div>'''
    emp_shell('onboard-w4','New hire · W-4',0,'Your <em>tax</em> withholding','Federal W-4, plus Michigan\u2019s MI-W4.',form,helpd,'Employee phone form: federal W-4 and MI-W4.')
def i9():
    form='''<div class="f"><div class="sec2">Section 1 · About you</div>
<div class="r2"><div><label>Legal first name</label><div class="in fill">Noor</div></div><div><label>Legal last name</label><div class="in fill">Patel</div></div></div>
<div class="r2"><div><label>Date of birth</label><div class="in fill">Mar 14, 2001</div></div><div><label>Social Security no.</label><div class="in fill">&bull;&bull;&bull;-&bull;&bull;-4410 <span class="sample-tag" style="float:right">Sample</span></div></div></div>
<div><label>I am</label><div class="opts" style="gap:8px"><div class="opt on"><span class="rd"></span>A citizen of the United States</div><div class="opt"><span class="rd"></span>A noncitizen national</div><div class="opt"><span class="rd"></span>A lawful permanent resident</div><div class="opt"><span class="rd"></span>A noncitizen authorized to work</div></div></div>
<div><label>Signature</label><div class="sig">Noor Patel</div></div>
<div class="dropz"><b>Section 2 is next, with your manager.</b><br>Bring your documents on your first day. Your manager looks at them and completes the rest.</div>
<a class="btn lg" style="text-align:center" href="onboard-deposit.html">Save and continue</a></div>'''
    helpd='''<div class="card" style="background:#FBF1E5;box-shadow:none"><h3 class="ct" style="margin-bottom:8px">Who sees this</h3><p class="cap" style="font-size:14px">Only the owner and the people they allow. Your Social Security number is hidden on screen after you save it.</p></div>
<div class="hand" style="margin-top:20px;font-size:25px;transform:rotate(-2deg)">You only do section 1. Your manager does the rest in person.</div>'''
    emp_shell('onboard-i9','New hire · I-9',1,'Your <em>work</em> eligibility','Form I-9, section 1.',form,helpd,'Employee phone form: I-9 section 1.')
def deposit():
    form='''<div class="f"><div><label>Bank name</label><div class="in fill">Huron Valley Credit Union (sample)</div></div>
<div class="r2"><div><label>Routing number</label><div class="in fill">&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</div></div><div><label>Account number</label><div class="in foc">&bull;&bull;&bull;&bull;&bull;&bull;4821</div></div></div>
<div><label>Account type</label><div class="opts c2"><div class="opt on"><span class="rd"></span>Checking</div><div class="opt"><span class="rd"></span>Savings</div></div></div>
<div><label>How much to this account?</label><div class="opts c2"><div class="opt on"><span class="rd"></span>All of my pay</div><div class="opt"><span class="rd"></span>A set amount</div></div></div>
<div class="ck2 on"><span class="cb"></span><span class="fine">I confirm these details are mine and correct.</span></div>
<a class="btn lg" style="text-align:center" href="onboarding.html">Finish</a></div>'''
    helpd='''<div class="card" style="background:#FBF1E5;box-shadow:none"><h3 class="ct" style="margin-bottom:8px">Heads up</h3><p class="cap" style="font-size:14px">This sets up your deposit details with your employer. Payments aren\u2019t made through Totali. Your employer tells you how you\u2019ll be paid.</p></div>
<div class="hand" style="margin-top:20px;font-size:25px;transform:rotate(-2deg)">Last one. You\u2019re done after this.</div>'''
    emp_shell('onboard-deposit','New hire · Direct deposit',2,'Where should your <em>pay</em> go?','Direct deposit details.',form,helpd,'Employee phone form: direct deposit details.')

def time_tips():
    hdr=''.join(f'<th>{d}</th>' for d in ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"])
    rows=""
    tot=[0]*7
    for i,e in enumerate(EMPS):
        ds=daysplit(e[3]+e[4],i)
        for j,v in enumerate(ds): tot[j]+=v
        cells="".join(f'<td>{fh(v) if v else "<span class=mut>&ndash;</span>"}</td>' for v in ds)
        rows+=f'<tr><td>{who(e[0],e[1])}</td>{cells}<td><b>{fh(e[3]+e[4])}</b></td></tr>'
    rows+='<tr class="tot"><td>Total hours</td>'+"".join(f'<td>{fh(round(t,1))}</td>' for t in tot)+f'<td>{fh(round(sum(tot),1))}</td></tr>'
    grid=f'<div class="card"><div class="ch"><h3 class="ct">Hours this week</h3><span class="cap">Oct 19 to Oct 25 · Both locations</span></div><table class="tbl"><thead><tr><th>Employee</th>{hdr}<th>Total</th></tr></thead><tbody>{rows}</tbody></table></div>'
    tipped=[r for r in RUN if r['tips']]
    th=sum(r['hrs'] for r in tipped)
    tr="".join(f'<tr><td>{r["name"]}</td><td>{fh(r["hrs"])} hrs</td><td><b>{money(r["tips"])}</b></td></tr>' for r in tipped)
    tips=f'''<div class="grid"><div class="card"><div class="ch"><h3 class="ct">Tips</h3>{chip("Tip pool on","ok")}</div><div class="stats s3" style="margin-bottom:12px"><div><i>Card tips</i><b>{money(TOT["tips"]*0.78+148.5*0.78)}</b></div><div><i>Cash tips</i><b>{money((TOT["tips"]+148.5)*0.22)}</b></div><div><i>Total</i><b>{money(TOT["tips"]+148.5)}</b></div></div>
<table class="tbl"><thead><tr><th>Who shares</th><th>Hours</th><th>Their share</th></tr></thead><tbody>{tr}</tbody></table><p class="cap" style="margin-top:10px">Split by hours worked. <a class="link">Change to by role</a></p></div>
<div class="card" style="background:#E6F1F2;border-color:#BBD8DC;box-shadow:none"><h3 class="ct" style="margin-bottom:6px;color:var(--teal)">Michigan tip credit reference</h3><p class="cap" style="color:#274f58;font-size:13.5px">Your tipped base rate is shown here for reference. Compare it with the state\u2019s published figures before you set a rate.</p></div></div>'''
    body=ph("Time and <em>tips</em>","Edit hours by day, then enter tips",'<a class="btn ghost sm">Previous week</a><a class="btn ghost sm">Import</a>')+f'<div class="tabs2"><a class="on">This week</a><a>Tip pool</a><a>Shift notes</a></div><div class="grid" style="grid-template-columns:1fr 420px;align-items:start">{grid}{tips}</div>'
    app_page('time-tips','Time and tips',G,R,'Time & tips',body,False,'Weekly hours grid and tip pool for restaurants.')

def job_costing():
    jobs=[("Mercer St. panel upgrade",74,"$18,400","$13,616"),("Harmon Elementary lighting",101,"$22,000","$22,220"),("Ridge Ave. rewire",38,"$9,600","$3,648"),("Calloway Bldg service",62,"$14,500","$8,990"),("Fenn Hall emergency lights",88,"$6,200","$5,456"),("Shop work, unbilled",0,"$2,400","$0")]
    jb="".join(f'<div class="jc"><span><b>{n}</b><br><span class="cap">Budget {b}</span></span><div class="jbar"><span class="{"over" if p>100 else ""}" style="width:{min(p,100)}%"></span><b style="left:100%"></b></div><span class="right"><b>{p}%</b><br><span class="cap">{a}</span></span></div>' for n,p,b,a in jobs)
    codes=[("01 Rough-in",212,"$9,540","$9,200"),("02 Fixtures",168,"$7,350","$6,800"),("03 Controls",96,"$4,400","$4,800"),("04 Punch list",38,"$1,230","$1,200")]
    ct="".join(f'<tr><td class="l">{c}</td><td>{h}</td><td>{l}</td><td>{b}</td><td>{chip("Over","warn") if float(l.replace("$","").replace(",",""))>float(b.replace("$","").replace(",","")) else chip("On track","ok")}</td></tr>' for c,h,l,b,*_ in [(c,h,l,b) for c,h,l,b in codes])
    stats='<div class="stats"><div><i>Active jobs</i><b>6</b></div><div><i>Labor this week</i><b>$46,980.00</b></div><div><i>Over budget</i><b>1</b></div><div><i>Prevailing wage jobs</i><b>2</b></div></div>'
    left=f'<div class="card"><div class="ch"><h3 class="ct">Labor against budget</h3><span class="cap">Line shows 100% of budget</span></div>{jb}</div>'
    right=f'''<div class="grid"><div class="card"><div class="ch"><h3 class="ct">Harmon Elementary lighting</h3>{chip("Prevailing wage","berry")}</div><table class="tbl"><thead><tr><th class="l">Cost code</th><th>Hours</th><th>Labor</th><th>Budget</th><th></th></tr></thead><tbody>{ct}</tbody></table></div>
<div class="alert"><span class="dot"></span><span><b>Harmon is 1% over its labor budget</b> with two weeks to go. Controls ran long.</span></div></div>'''
    body=ph("Job <em>costing</em>","Northgate Electric · Week of Oct 19",'<a class="btn ghost sm">Add job</a><a class="btn sm">Export for the week</a>')+f'<div style="margin-bottom:18px">{stats}</div><div class="grid" style="grid-template-columns:1fr 1fr;align-items:start">{left}{right}</div><div class="hand" style="margin-top:14px;font-size:24px">Sample data. Rates and budgets are made up.</div>'
    app_page('job-costing','Job costing',G,'trades','Jobs',body,False,'Trades: labor against budget by job, and cost-code detail with prevailing wage flag.')

def settings():
    nav='<div class="subnav"><a class="on">Your dashboard</a><a>Company</a><a>Pay schedule</a><a>State accounts</a><a>People and roles</a><a>Notifications</a><a>Account</a></div>'
    ans="".join(f'<div class="row"><span class="l1"><b>{q}</b></span><span style="font-family:Fraunces;font-style:italic;color:var(--berry)">{a}</span><a class="link">Edit</a></div>' for q,a in [("State","Michigan"),("Locations","Detroit, Ferndale"),("Team size","11 to 25 people"),("Tipped staff","Yes"),("Pay frequency","Weekly"),("Contractors","Yes, 2")])
    c1=f'<div class="card"><div class="ch"><h3 class="ct">Your answers</h3><span class="cap">Change one and the dashboard follows</span></div>{ans}<div class="alert teal" style="margin-top:12px"><span class="dot"></span><span>Switching Contractors to No removes the Contractors card. History stays saved.</span></div></div>'
    c2=f'''<div class="card"><div class="ch"><h3 class="ct">State and city accounts</h3><span class="cap">Michigan</span></div>
<div class="row"><span class="l1"><b>Unemployment (UIA) account number</b><i>Needed for state unemployment lines</i></span><div class="in ph" style="width:200px;min-height:36px;padding:7px 11px;font-size:14px">Add number</div></div>
<div class="row"><span class="l1"><b>State withholding account</b><i>Michigan Treasury</i></span>{chip("To do","warn")}</div>
<div class="row"><span class="l1"><b>Detroit city income tax account</b><i>For staff working in Detroit</i></span>{chip("To do","warn")}</div></div>'''
    c3=f'''<div class="card"><h3 class="ct" style="margin-bottom:6px">Who can do what</h3>
<div class="row"><span class="l1"><b>Owner</b><i>Everything, including billing</i></span><span class="cap">1 person</span></div><div class="row"><span class="l1"><b>Manager</b><i>Hours, tips, onboarding. No pay rates</i></span><span class="cap">2 people</span></div><div class="row"><span class="l1"><b>Employee</b><i>Own stubs, forms and time off</i></span><span class="cap">14 people</span></div></div>'''
    c4=f'''<div class="card"><h3 class="ct" style="margin-bottom:6px">Notifications</h3>
<div class="row"><span>Paperwork reminders to new hires</span><span class="tgl on"></span></div><div class="row"><span>Overtime before approval</span><span class="tgl on"></span></div><div class="row"><span>Weekly summary email</span><span class="tgl"></span></div></div>'''
    c5=f'''<div class="card"><h3 class="ct" style="margin-bottom:6px">This device</h3><p class="cap">You stay signed in here until you sign out. Last sign-in Oct 30, 3:41 PM ET.</p><div class="acts" style="margin-top:12px"><a class="btn ghost sm" href="login.html">Sign out</a><a class="link">Sign out everywhere</a></div></div>'''
    body=ph("<em>Settings</em>","Company, taxes and who has access")+f'<div class="grid" style="grid-template-columns:200px 1fr 1fr;align-items:start"><div>{nav}</div><div class="grid">{c1}{c3}{c5}</div><div class="grid">{c2}{c4}</div></div>'
    app_page('settings','Settings',G,R,'Overview',body,False,'Settings: your answers (editable), state accounts, roles, notifications, sign out.')

def company():
    steps='<div class="pstep" style="margin-top:6px">'+'<i></i>'.join(f'<span class="{c}" data-n="{i+1}">{t}</span>' for i,(t,c) in enumerate([("Business","done"),("Owners","on"),("Address",""),("Documents",""),("Review","")]))+'</div>'
    form=f'''<div class="card"><h3 class="ct" style="margin-bottom:14px">Business details</h3><div class="f">
<div class="r2"><div><label>Legal business name</label><div class="in fill">Harbor Street Kitchen LLC</div></div><div><label>Doing business as</label><div class="in fill">Harbor Street Kitchen</div></div></div>
<div class="r3"><div><label>Entity type</label><div class="in sel fill"><span>LLC</span>{CHEV}</div></div><div><label>EIN</label><div class="in fill">&bull;&bull;-&bull;&bull;&bull;6789 <span class="sample-tag" style="float:right">Sample</span></div></div><div><label>State formed</label><div class="in sel fill"><span>Michigan</span>{CHEV}</div></div></div>
<div><label>Business address</label><div class="in fill">1412 Harbor St, Detroit, MI 48207 (sample)</div></div></div>
<hr class="sep"><h3 class="ct" style="margin-bottom:6px">Owners and control</h3><p class="cap" style="margin-bottom:10px">Everyone who owns 25% or more, plus one person who runs the business.</p>
<div class="row"><span class="l1"><b>Scott Holdan</b><i>Owner · 60%</i></span>{chip("Added","ok")}</div><div class="row"><span class="l1"><b>Maya Brandt</b><i>Owner · 40% · Runs the business</i></span>{chip("Added","ok")}</div>
<div class="row" style="border-top:1px dashed #D3BFAE"><a class="link">Add another owner</a><span></span></div>
<hr class="sep"><h3 class="ct" style="margin-bottom:10px">Documents</h3><div class="dropz">Drop a formation document or EIN letter here, or <a class="link">choose a file</a></div>
<div class="qfoot"><a class="link">Back</a><a class="btn">Save and continue</a></div></div>'''
    side=f'''<div class="grid"><div class="card" style="background:#FBF1E5;box-shadow:none"><h3 class="ct" style="margin-bottom:8px">Why we ask</h3><p class="cap" style="font-size:14px">Totali confirms who the business is before your first pay run. Everything here is stored for your account and not shown to your team.</p></div>
<div class="card"><h3 class="ct" style="margin-bottom:6px">Progress</h3><div class="prg"><span style="width:40%"></span></div><p class="cap">2 of 5 sections done</p></div>
<div class="hand" style="font-size:25px;transform:rotate(-2deg)">Have your EIN letter handy. That\u2019s the slow part.</div></div>'''
    body=ph("Company <em>setup</em>","Business details for Harbor Street Kitchen LLC")+steps+f'<div class="grid" style="grid-template-columns:1fr 340px;align-items:start;margin-top:14px">{form}{side}</div>'
    app_page('company-setup','Company setup (KYB)',G,R,'Overview',body,False,'Business verification: entity details, owners, documents.')

def billing():
    plan=f'''<div class="card"><div class="ch"><h3 class="ct">Your plan</h3>{chip("Early access","berry")}</div><div class="big2"><div><i>Totali</i><span class="n">Simple per-employee pricing</span></div></div>
<p class="cap" style="margin-top:4px">You\u2019re billed for people on your roster who are on a pay run that month. Your price is confirmed before your first invoice.</p>
<div class="stats s3" style="margin-top:16px"><div><i>On a pay run this month</i><b>12</b></div><div><i>Invited, not yet counted</i><b>1</b></div><div><i>Next invoice</i><b>Nov 30</b></div></div></div>'''
    pm=f'''<div class="card"><h3 class="ct" style="margin-bottom:6px">Payment method</h3><div class="row"><span class="l1"><b>Card ending 0000 (sample)</b><i>Expires 08/29</i></span><a class="link">Change</a></div><div class="row"><span class="l1"><b>Billing email</b><i>owner@harborstreet.example</i></span><a class="link">Change</a></div></div>'''
    inv=f'''<div class="card"><div class="ch"><h3 class="ct">Invoices</h3></div><div style="text-align:center;padding:28px 0 22px;color:var(--mut)"><div style="font:italic 300 22px Fraunces,serif;color:var(--berry);margin-bottom:6px">Nothing to pay yet</div>Your first invoice shows up here after your first approved pay run.</div></div>'''
    ent=f'''<div class="card" style="background:#FBF1E5;box-shadow:none"><h3 class="ct" style="margin-bottom:8px">Who bills you</h3><dl class="kv" style="grid-template-columns:110px 1fr"><dt>Seller</dt><dd>OMNIA TAX LLC</dd><dt>Product</dt><dd>Totali</dd><dt>Billed to</dt><dd>Harbor Street Kitchen LLC</dd><dt>Tax engine</dt><dd>Omnia.tax</dd></dl></div>'''
    body=ph("<em>Billing</em>","One price per employee, nothing else")+f'<div class="grid" style="grid-template-columns:1.5fr 1fr;align-items:start"><div class="grid">{plan}{inv}</div><div class="grid">{pm}{ent}</div></div>'
    app_page('billing','Billing',G,R,'Overview',body,False,'Billing: per-employee plan (no number), payment method, invoices, legal entity.')

def help_():
    topics=[("Getting started","Account, industry and your first questions"),("Running payroll","Hours, review, approval and stubs"),("Taxes and state setup","Michigan, Detroit and your account numbers"),("New hires and paperwork","W-4, MI-W4, I-9 and direct deposit forms"),("Time, tips and sick time","Tip pools and earned sick time"),("Billing and your account","Plan, invoices and signing out")]
    tp="".join(f'<div class="card" style="min-height:110px"><h3 class="ct" style="margin-bottom:6px">{t}</h3><p class="cap">{d}</p></div>' for t,d in topics)
    faq="".join(f'<div><b>{q}<span style="color:var(--faint)">+</span></b>{"<p>"+a+"</p>" if a else ""}</div>' for q,a in [("Why did Michigan items appear on my dashboard?","They came from your answer to \u201cWhere is your business?\u201d. Change the answer in Settings and the items go away."),("Can I change my industry later?","",),("Where do I add my unemployment account number?",""),("What happens if someone has no W-4?",""),("Does Totali pay my team?","")])
    body=ph("How can we <em>help</em>?","")+'<div class="srch"><svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M11 11l4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>Search help articles</div>'+f'<div class="grid g3" style="margin-top:26px">{tp}</div><div class="grid" style="grid-template-columns:1.4fr 1fr;margin-top:30px;align-items:start"><div><h2 class="st2" style="margin-bottom:12px">Common <em>questions</em></h2><div class="faq">{faq}</div></div><div class="card" style="background:#FBF1E5;box-shadow:none;position:relative"><h3 class="ct" style="margin-bottom:6px">Still stuck?</h3><p class="cap" style="margin-bottom:14px">Tell us what you were doing and we\u2019ll write back.</p><a class="btn">Message us</a><div class="hand" style="margin-top:20px;font-size:24px;transform:rotate(-2deg)">A person reads these.</div></div></div>'
    app_page('help','Help',G,R,'Overview',body,False,'Help center: topics, common questions, message us.')
