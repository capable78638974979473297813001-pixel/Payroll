from lib import *

QDEF={
'restaurants':[('state','State'),('loc','Locations'),('team','Team size'),('tips','Tipped staff'),('freq','Pay frequency'),('contr','Contractors')],
'hospitality':[('state','State'),('loc','Properties'),('team','Team size'),('tips','Tips and service charge'),('seasonal','Seasonal staff'),('freq','Pay frequency')],
'trades':[('state','State'),('loc','Offices and job sites'),('team','Team size'),('union','Union or prevailing wage'),('subs','Subcontractors'),('freq','Pay frequency')],
'office':[('state','States'),('loc','Offices'),('team','Team size'),('pay','Salary and hourly'),('ben','Deductions'),('freq','Pay frequency')],
'delivery':[('state','State'),('loc','Hubs'),('team','Team size'),('drv','Drivers'),('miles','Mileage'),('freq','Pay frequency')],
}
FREQ={'weekly':'Weekly','biweekly':'Every two weeks','semi':'Twice a month'}
def L(src,t,d,c="Auto",k="ok"): return dict(src=src,t=t,d=d,c=c,k=k)
def M(id,title,src,lines,w=1,rich="",tag=None): return dict(id=id,title=title,src=src,lines=lines,w=w,rich=rich,tag=tag)

# full-dashboard rich blocks -------------------------------------------------
def r_bars(vals,labels,hi=None,note=""):
    mx=max(vals)
    b="".join(f'<span class="{"t" if i==hi else ""}" style="height:{int(v/mx*100)}%"></span>' for i,v in enumerate(vals))
    l="".join(f'<span>{x}</span>' for x in labels)
    return f'<div class="rich"><div class="bars">{b}</div><div class="bl">{l}</div>{("<p class=cap style=margin-top:8px>"+note+"</p>") if note else ""}</div>'
def r_rows(rows):
    return '<div class="rich"><table>'+"".join(f"<tr><td>{a}</td><td>{b}</td></tr>" for a,b in rows)+'</table></div>'
def r_run(label,period,date,gross,tax,net,n,note,btn="Review and approve",href="pay-run-review.html"):
    return f'''<div class="rich"><div class="big2"><div><i>{period}</i><span class="n">{label}</span></div><a class="btn sm" href="{href}">{btn}</a></div>
<div class="stats"><div><i>Gross pay</i><b>{gross}</b></div><div><i>Employee taxes</i><b>{tax}</b></div><div><i>Net pay</i><b>{net}</b></div><div><i>Employees</i><b>{n}</b></div></div>
<div class="alert" style="margin-top:12px"><span class="dot"></span><span>{note}</span></div></div>'''
SAMPLE_NUM=dict(restaurants=(TOT['gross'],TOT['tax'],TOT['net'],TOT['n']))

def pay_line(a,sched_default="Not set yet. Choose how often you pay"):
    if 'freq' in a:
        f=FREQ[a['freq']]
        return L('freq','Pay schedule',{'weekly':'Weekly, paid on Fridays. Next pay date Oct 30','biweekly':'Every other Friday. Next pay date Nov 6','semi':'The 15th and last day of the month. Next pay date Oct 30'}[a['freq']],f,'ok')
    return L('base','Pay schedule',sched_default,'To set','warn')

# ---------------- restaurants ----------------
def restaurants(a,full=False):
    m=[];ST=a.get('state')
    tipsno=a.get('tips')=='no'
    pr=[pay_line(a),L('base','Overtime flags','Hours over 40 are marked for review before approval'),L('base','Pay stubs','One for each employee when you approve')]
    n=SAMPLE_NUM['restaurants']
    rich=r_run("Weekly pay run","Oct 19 to Oct 25, 2026 · pay date Fri, Oct 30",None,money(n[0]),money(n[1]),money(n[2]),n[3],"<b>2 items to review.</b> Jordan Pike has no W-4 on file. Marcus Bell has 6 overtime hours.") if full else ""
    m.append(M('pay','Pay run','base',pr,2,rich))
    tl=[L('base','Employees','Add people one at a time or send an invite link','Open','line')]
    if 'team' in a: tl.append(L('team','Bulk invite','Upload a spreadsheet for a team of 11 to 25','Added'))
    rich=""
    if full:
        rich='<div class="rich"><div class="big2"><div><i>On the roster</i><span class="n">14 employees</span></div><div class="minis"><div><i>Detroit</i><b>8</b></div><div><i>Ferndale</i><b>6</b></div></div></div><div class="prg"><span style="width:79%"></span></div><p class="cap">11 of 14 have finished their paperwork. 3 still to do.</p></div>'
    m.append(M('team','Team','base',tl,1,rich))
    tt=[L('base','Hours','Enter by week or import a spreadsheet','Manual','line')]
    if not tipsno: tt.append(L('base','Tip entry','Card and cash tips for each shift','Manual','line'))
    if a.get('tips')=='yes':
        tt+= [L('tips','Tip reporting','Tips show on each stub and count toward taxable pay'),L('tips','Tip pool','Split by hours worked or by role','Set up','ok')]
    rich=r_bars([62,58,70,74,96,118,104],["M","T","W","T","F","S","S"],5,"Hours by day this week. Weekend nights are the busy ones. Sample data.") if full else ""
    m.append(M('time','Time and tips','base',tt,1,rich))
    ft=[L('base','Federal income tax','From each employee\u2019s W-4'),L('base','Social Security and Medicare','Employee and employer shares'),L('base','FUTA','Employer federal unemployment')]
    if a.get('tips')=='yes': ft.append(L('tips','Tips in taxable wages','Included when taxes are worked out'))
    rich=r_rows([("Federal income tax",money(TOT['fed'])),("Social Security",money(TOT['ss'])),("Medicare",money(TOT['med']))])+'<p class="cap" style="padding-bottom:6px">Worked out by the Omnia.tax engine, this run.</p>' if full else ""
    m.append(M('fed','Federal taxes','base',ft,1,rich))
    pp=[L('base','W-4','Federal withholding form, filled in on the employee\u2019s phone'),L('base','I-9','Employee fills in section 1; you complete section 2'),L('base','Direct deposit form','Bank details collected for setup')]
    if ST=='MI': pp.append(L('state','MI-W4','Michigan withholding form, added for your state'))
    rich=""
    m.append(M('paper','New-hire paperwork','base',pp,1,rich))
    if ST=='MI':
        ml=[L('state','Michigan income tax withholding','Uses each employee\u2019s MI-W4'),
            L('state','Unemployment account','Add your UIA employer account number','To do','warn'),
            L('state','Minimum wage reference','Shown beside each hourly rate','Reference','line'),
            L('state','Earned sick time','Hours build up for each employee; you set the policy')]
        if 'Detroit' in a.get('loc',[]): ml.append(L('loc','Detroit city income tax','For staff who work in Detroit, resident and non-resident','Auto'))
        if a.get('tips')=='yes': ml.append(L('tips','Tip credit reference','Shown when you set tipped base rates','Reference','line'))
        rich=r_rows([("Michigan withholding",money(TOT['mi'])),("Detroit city tax",money(TOT['city'])),("Earned sick time",'Tracking 14 people')])+'<p class="cap" style="padding-bottom:6px">This run, calculated by the Omnia.tax engine.</p>' if full else ""
        m.append(M('state','Michigan','state',ml,1,rich,tag='state'))
    if 'loc' in a:
        ll=[L('loc',f'Harbor Street Kitchen, {c}',f'Work location · {"8" if c=="Detroit" else "6"} staff' + (" · city income tax applies" if c=="Detroit" else " · no city tax set up"),'Added') for c in a['loc']]
        rich='<div class="rich"><p class="cap">Staff are assigned a work location so the right city tax applies. Pay runs can be split by location.</p></div>' if full else ""
        m.append(M('loc','Locations','loc',ll,1,rich))
    if a.get('contr')=='yes':
        cl=[L('contr','1099 contractors','Payments tracked separately from payroll'),L('contr','W-9 collection','Request and store forms','Ready','ok'),L('contr','Year totals','For your records and your accountant','Ready','ok')]
        rich=r_rows([("Reed Plumbing (sample)","$1,240.00 YTD"),("Kim Ostrowski, bookkeeper (sample)","$3,600.00 YTD")]) if full else ""
        m.append(M('contr','Contractors','contr',cl,1,rich))
    return m
def restaurants_left(a):
    out=[]
    if 'state' not in a: out.append(('State taxes',0))
    if 'loc' not in a: out.append(('Locations',0))
    if 'contr' not in a: out.append(('Contractors',0))
    elif a['contr']=='no': out.append(('Contractors · not needed',1))
    if a.get('tips')=='no': out.append(('Tip pool · not needed',1))
    if 'tips' not in a: out.append(('Tip pool',0))
    if 'state' in a: out.append(('Multi-state payroll · all staff in one state',1))
    return out

# ---------------- hospitality ----------------
def hospitality(a,full=False):
    m=[];ST=a.get('state')
    pr=[pay_line(a),L('base','Overtime flags','Across shifts and departments'),L('base','Pay stubs','One for each employee when you approve')]
    rich=r_run("Biweekly pay run","Oct 12 to Oct 25, 2026 · pay date Fri, Nov 6",None,"$58,420.00","$12,840.00","$45,580.00",38,"<b>3 items to review.</b> 4 seasonal hires start next week. Two housekeeping timesheets are open.") if full else ""
    m.append(M('pay','Pay run','base',pr,2,rich))
    dl=[L('base','Departments','Front desk, housekeeping, food and beverage, maintenance','Open','line'),L('base','Split shifts','Two or more shifts in a day add up on one stub')]
    if 'team' in a: dl.append(L('team','Department managers','Managers submit hours for their own team','Added'))
    rich=r_rows([("Front desk","7 people"),("Housekeeping","14 people"),("Food and beverage","11 people"),("Maintenance","6 people")]) if full else ""
    m.append(M('dept','Departments','base',dl,1,rich))
    tl=[L('base','Hours','By department or by shift','Manual','line')]
    if a.get('tips')!='no': tl.append(L('base','Gratuity entry','Tips by department','Manual','line'))
    if a.get('tips')=='yes': tl.append(L('tips','Service charge split','Divide by hours or by points','Set up'))
    rich=r_bars([180,150,160,170,260,340,300],["M","T","W","T","F","S","S"],5,"Hours by day. Weekends are heavy. Sample data.") if full else ""
    m.append(M('time','Hours and gratuities','base',tl,1,rich))
    ft=[L('base','Federal income tax','From each employee\u2019s W-4'),L('base','Social Security and Medicare','Employee and employer shares'),L('base','FUTA','Employer federal unemployment')]
    if a.get('tips')=='yes': ft.append(L('tips','Gratuities in taxable wages','Included when taxes are worked out'))
    rich=r_rows([("Federal income tax","$4,964.70"),("Social Security","$3,622.04"),("Medicare","$847.09")]) if full else ""
    m.append(M('fed','Federal taxes','base',ft,1,rich))
    pp=[L('base','W-4','Filled in on the employee\u2019s phone'),L('base','I-9','Section 1 by the employee, section 2 by you'),L('base','Direct deposit form','Bank details collected for setup')]
    if ST=='OH': pp.append(L('state','IT-4','Ohio withholding form, added for your state'))
    m.append(M('paper','New-hire paperwork','base',pp,1,""))
    if ST=='OH':
        ol=[L('state','Ohio income tax withholding','Uses each employee\u2019s IT-4'),L('state','Municipal income tax','Set by the city where each person works'),L('state','School district tax','Set by the employee\u2019s home district','Auto'),L('state','Unemployment account','Add your ODJFS employer account number','To do','warn')]
        rich=r_rows([("Ohio withholding","$2,104.88"),("Municipal tax","$801.17"),("School district tax","$312.40")]) if full else ""
        m.append(M('state','Ohio','state',ol,1,rich,tag='state'))
    if 'loc' in a:
        ll=[L('loc',p,"Property · municipal tax by work city",'Added') for p in a['loc']]
        m.append(M('loc','Properties','loc',ll,1,""))
    if a.get('seasonal')=='yes':
        sl=[L('seasonal','Seasonal roster','Rehire last season\u2019s staff in one click'),L('seasonal','Start and end dates','Each seasonal employee has a date range'),L('seasonal','Year-round and seasonal headcount','Shown side by side','Ready','ok')]
        rich=r_rows([("Seasonal staff this month","12"),("Returning from last season","8"),("Starting next week","4")]) if full else ""
        m.append(M('seasonal','Seasonal staff','seasonal',sl,1,rich))
    return m
def hospitality_left(a):
    out=[]
    if 'state' not in a: out.append(('State taxes',0))
    if 'loc' not in a: out.append(('Properties',0))
    if 'seasonal' not in a: out.append(('Seasonal staff',0))
    elif a['seasonal']=='no': out.append(('Seasonal staff · not needed',1))
    if 'tips' not in a: out.append(('Service charge split',0))
    if 'state' in a: out.append(('Multi-state payroll · all staff in one state',1))
    return out

# ---------------- trades ----------------
def trades(a,full=False):
    m=[];ST=a.get('state')
    pr=[pay_line(a),L('base','Overtime flags','Daily and weekly, by job'),L('base','Pay stubs','One for each employee when you approve')]
    rich=r_run("Weekly pay run","Oct 19 to Oct 25, 2026 · pay date Fri, Oct 30",None,"$46,980.00","$9,860.00","$37,120.00",24,"<b>3 items to review.</b> Two crews have hours on a prevailing wage job. One foreman has not submitted hours.") if full else ""
    m.append(M('pay','Pay run','base',pr,2,rich))
    cl=[L('base','Crews','Group people by crew and foreman','Open','line'),L('base','Hours by job','Each entry carries a job and cost code')]
    if 'team' in a: cl.append(L('team','Field entry','Foremen enter hours from the job site on a phone','Added'))
    rich=r_rows([("Crew A, Hale","8 people"),("Crew B, Soto","7 people"),("Service van, Dunn","5 people"),("Shop and office","4 people")]) if full else ""
    m.append(M('crews','Crews and jobs','base',cl,1,rich))
    jl=[L('base','Budget by job','Labor cost against each job\u2019s budget','Open','line'),L('base','Cost codes','Your own codes, or start from ours')]
    rich=r_rows([("Mercer St. panel upgrade","74% of labor budget"),("Harmon Elementary lighting","101% of labor budget"),("Ridge Ave. rewire","38% of labor budget")])+'<a class="link" href="job-costing.html">Open job costing</a>' if full else ""
    m.append(M('jobs','Job costing','base',jl,1,rich))
    wl=[L('base','Hours by class code','Hours and pay split by class code'),L('base','Class code export','A summary you can hand your insurer','Ready','ok')]
    m.append(M('wc','Workers\u2019 comp classes','base',wl,1,r_rows([("5190 Electrical wiring","$31,240.00"),("8810 Clerical","$4,880.00")]) if full else ""))
    ft=[L('base','Federal income tax','From each employee\u2019s W-4'),L('base','Social Security and Medicare','Employee and employer shares'),L('base','FUTA','Employer federal unemployment')]
    m.append(M('fed','Federal taxes','base',ft,1,r_rows([("Federal income tax","$3,992.90"),("Social Security","$2,912.76"),("Medicare","$681.21")]) if full else ""))
    pp=[L('base','W-4','Filled in on the employee\u2019s phone'),L('base','I-9','Section 1 by the employee, section 2 by you'),L('base','Direct deposit form','Bank details collected for setup')]
    m.append(M('paper','New-hire paperwork','base',pp,1,""))
    if ST=='PA':
        pl=[L('state','Pennsylvania income tax','From each employee\u2019s W-4'),L('state','Local earned income tax','By employee home municipality'),L('state','Local services tax','By work municipality, per job','Auto'),L('state','Unemployment account','Add your PA employer account number','To do','warn')]
        if 'loc' in a: pl.append(L('loc','Work municipality on each job','Set when you add a job site','Added'))
        rich=r_rows([("PA income tax","$1,442.29"),("Local earned income tax","$668.40"),("Local services tax","$96.00")]) if full else ""
        m.append(M('state','Pennsylvania','state',pl,1,rich,tag='state'))
    if 'loc' in a:
        ll=[L('loc',p,'Site or office','Added') for p in a['loc']]
        m.append(M('loc','Offices and job sites','loc',ll,1,""))
    if a.get('union')=='yes':
        ul=[L('union','Prevailing wage rates','Rate tables by classification and county'),L('union','Fringe benefit split','Cash or plan contributions per hour'),L('union','Union dues','Deducted by local, listed on the stub'),L('union','Weekly rate report','Hours and rates by classification, for your records','Ready','ok')]
        rich=r_rows([("Journeyman electrician","$46.18 base + $29.40 fringe"),("Apprentice, year 2","$27.71 base + $17.64 fringe")])+'<p class="cap" style="padding-bottom:6px">Sample rates, not for real use.</p>' if full else ""
        m.append(M('union','Prevailing wage and union','union',ul,2,rich))
    if a.get('subs')=='yes':
        sl=[L('subs','Subcontractors','Paid outside payroll, tracked by job'),L('subs','W-9 and insurance papers','Collected and stored per sub','Ready','ok')]
        m.append(M('subs','Subcontractors','subs',sl,1,r_rows([("Ellis Concrete (sample)","$8,400.00 YTD"),("Park Trenching (sample)","$5,150.00 YTD")]) if full else ""))
    return m
def trades_left(a):
    out=[]
    if 'state' not in a: out.append(('State and local taxes',0))
    if 'loc' not in a: out.append(('Offices and job sites',0))
    if 'union' not in a: out.append(('Prevailing wage and union',0))
    elif a['union']=='no': out.append(('Prevailing wage · not needed',1))
    if 'subs' not in a: out.append(('Subcontractors',0))
    elif a['subs']=='no': out.append(('Subcontractors · not needed',1))
    return out

# ---------------- office ----------------
def office(a,full=False):
    m=[];sts=a.get('state',[])
    pr=[pay_line(a),L('base','Salaried and hourly','Both kinds of pay in one run'),L('base','Pay stubs','One for each employee when you approve')]
    if a.get('pay')=='mixed': pr.append(L('pay','Exempt and non-exempt flag','Hourly staff get overtime flags; salaried do not','Added'))
    rich=r_run("Semi-monthly pay run","Oct 16 to Oct 31, 2026 · pay date Sat, Oct 31",None,"$74,180.00","$17,610.00","$56,570.00",16,"<b>2 items to review.</b> One new hire in California has no state withholding form yet. Two people changed salary.") if full else ""
    m.append(M('pay','Pay run','base',pr,2,rich))
    tl=[L('base','Time off balances','Vacation and sick, per person'),L('base','Time off requests','Approved by a manager, shown on the calendar')]
    rich=r_rows([("Vacation owed, all staff","212 hours"),("Out this week","2 people"),("Requests waiting","3")]) if full else ""
    m.append(M('pto','Time off','base',tl,1,rich))
    dl=[L('base','Deduction lines','Before-tax and after-tax lines on every stub','Open','line')]
    if a.get('ben')=='yes': dl+=[L('ben','Health premium','Employee share, taken from each paycheck'),L('ben','401(k) deferral','Percent or dollar amount. Totali records the deduction only','Added')]
    rich=r_rows([("Health premium, employee share","$2,460.00"),("401(k) deferrals","$3,184.00")])+'<p class="cap" style="padding-bottom:6px">Totali records these deductions. It does not run the plans.</p>' if full else ""
    m.append(M('ded','Deductions','base',dl,1,rich))
    ft=[L('base','Federal income tax','From each employee\u2019s W-4'),L('base','Social Security and Medicare','Employee and employer shares'),L('base','FUTA','Employer federal unemployment')]
    m.append(M('fed','Federal taxes','base',ft,1,r_rows([("Federal income tax","$6,305.30"),("Social Security","$4,599.16"),("Medicare","$1,075.61")]) if full else ""))
    pp=[L('base','W-4','Filled in on the employee\u2019s phone'),L('base','I-9','Section 1 by the employee, section 2 by you'),L('base','Direct deposit form','Bank details collected for setup')]
    if 'CA' in sts: pp.append(L('state','CA DE 4','California withholding form, for staff who work there'))
    if 'NY' in sts: pp.append(L('state','NY IT-2104','New York withholding form, for staff who work there'))
    m.append(M('paper','New-hire paperwork','base',pp,1,""))
    if 'TX' in sts: m.append(M('tx','Texas','state',[L('state','No state income tax','Nothing to withhold','Auto'),L('state','Unemployment account','Add your TWC employer account number','To do','warn')],1,r_rows([("Staff working in Texas","9")]) if full else "",tag='state'))
    if 'NY' in sts: m.append(M('ny','New York','state',[L('state','NY income tax withholding','Uses each employee\u2019s IT-2104'),L('state','Disability and paid family leave','Employee deduction and employer cost','Auto'),L('state','Unemployment account','Add your NY employer registration number','To do','warn')],1,r_rows([("NY withholding","$1,184.60"),("Staff working in NY","4")]) if full else "",tag='state'))
    if 'CA' in sts: m.append(M('ca','California','state',[L('state','CA income tax withholding','Uses each employee\u2019s DE 4'),L('state','State disability insurance','Employee deduction','Auto'),L('state','Unemployment and training tax','Employer cost, with your EDD account','To do','warn')],1,r_rows([("CA withholding","$1,390.15"),("Staff working in CA","3")]) if full else "",tag='state'))
    if 'loc' in a:
        ll=[L('loc',p,'Where people work','Added') for p in a['loc']]
        m.append(M('loc','Offices and remote staff','loc',ll,1,""))
    return m
def office_left(a):
    out=[]
    if 'state' not in a: out.append(('State taxes',0))
    if 'loc' not in a: out.append(('Offices and remote staff',0))
    if 'ben' not in a: out.append(('Benefit deductions',0))
    elif a['ben']=='no': out.append(('Benefit deductions · not needed',1))
    return out

# ---------------- delivery ----------------
def delivery(a,full=False):
    m=[];ST=a.get('state')
    pr=[pay_line(a),L('base','Hourly plus per-delivery','Both on one line of the stub'),L('base','Pay stubs','One for each employee when you approve')]
    rich=r_run("Weekly pay run","Oct 19 to Oct 25, 2026 · pay date Fri, Oct 30",None,"$63,300.00","$12,950.00","$50,350.00",31,"<b>2 items to review.</b> 412 trips were imported on Monday. Two drivers are missing a mileage log.") if full else ""
    m.append(M('pay','Pay run','base',pr,2,rich))
    dl=[L('base','Drivers','License and insurance documents on each profile'),L('base','Document reminders','Flag when a document is about to lapse','Auto')]
    if 'team' in a: dl.append(L('team','Dispatcher access','Dispatchers see hours, not pay','Added'))
    rich=r_rows([("Drivers on the roster","31"),("Documents expiring in 30 days","3"),("Missing insurance proof","1")]) if full else ""
    m.append(M('drv','Drivers','base',dl,1,rich))
    tl=[L('base','Trips','Import from a spreadsheet or add by hand','Manual','line'),L('base','Customer tips','Tips by driver, shown on the stub')]
    rich=r_bars([420,390,410,450,520,610,480],["M","T","W","T","F","S","S"],5,"Trips by day, last 7 days. Sample data.") if full else ""
    m.append(M('trips','Trips and tips','base',tl,1,rich))
    ft=[L('base','Federal income tax','From each employee\u2019s W-4'),L('base','Social Security and Medicare','Employee and employer shares'),L('base','FUTA','Employer federal unemployment')]
    m.append(M('fed','Federal taxes','base',ft,1,r_rows([("Federal income tax","$5,380.50"),("Social Security","$3,924.60"),("Medicare","$917.85")]) if full else ""))
    pp=[L('base','W-4','Filled in on the employee\u2019s phone'),L('base','I-9','Section 1 by the employee, section 2 by you'),L('base','Direct deposit form','Bank details collected for setup')]
    m.append(M('paper','New-hire paperwork','base',pp,1,""))
    if ST=='CO':
        cl=[L('state','Colorado income tax withholding','From each employee\u2019s W-4'),L('state','Family leave premiums','Employee and employer shares','Auto'),L('state','Unemployment account','Add your CDLE employer account number','To do','warn')]
        if 'Denver' in a.get('loc',[]): cl.append(L('loc','Denver occupational privilege tax','For staff who work in Denver','Auto'))
        rich=r_rows([("CO withholding","$2,690.25"),("Family leave premiums","$316.50"),("Denver OPT","$90.00")]) if full else ""
        m.append(M('state','Colorado','state',cl,1,rich,tag='state'))
    if 'loc' in a:
        ll=[L('loc',f'{p} hub','Dispatch and pickup','Added') for p in a['loc']]
        m.append(M('loc','Hubs','loc',ll,1,""))
    if a.get('drv')=='both':
        cl=[L('drv','Contractor drivers','Paid by trip, outside payroll'),L('drv','W-9 and insurance proof','Collected per contractor','Ready','ok'),L('drv','Employees and contractors apart','Each driver is labelled; the lists never mix','Ready','ok')]
        rich=r_rows([("Employee drivers","31"),("Contractor drivers","18")]) if full else ""
        m.append(M('con','Contractor drivers','drv',cl,1,rich))
    if a.get('miles')=='yes':
        ml=[L('miles','Mileage log','One per driver per week'),L('miles','Rate per mile','You set it. The IRS rate is shown for reference','Reference','line'),L('miles','Reimbursement line','Shown on its own line of the stub')]
        rich=r_rows([("Miles logged this week","11,904"),("Reimbursements this run","$7,142.40")]) if full else ""
        m.append(M('miles','Mileage','miles',ml,1,rich))
    return m
def delivery_left(a):
    out=[]
    if 'state' not in a: out.append(('State taxes',0))
    if 'loc' not in a: out.append(('Hubs',0))
    if 'drv' not in a: out.append(('Contractor drivers',0))
    elif a['drv']=='emp': out.append(('Contractor drivers · not needed',1))
    if 'miles' not in a: out.append(('Mileage',0))
    elif a['miles']=='no': out.append(('Mileage · not needed',1))
    return out
BUILD={'restaurants':(restaurants,restaurants_left),'hospitality':(hospitality,hospitality_left),'trades':(trades,trades_left),'office':(office,office_left),'delivery':(delivery,delivery_left)}

# ---------------- renderers ----------------
def render_line(l,latest,modnew):
    isn=(not modnew) and latest and l['src']==latest
    return f'<li class="{"isnew" if isn else ""}"><span class="lt"><b>{l["t"]}</b><i>{l["d"]}</i></span>{chip(l["c"],l["k"]) if not isn else chip("new","new")}</li>'
def render_mod(m,latest,latest_label,full=False):
    modnew=bool(latest) and m['src']==latest and m['src']!='base'
    cls="mod"+(" isnew" if modnew else "")+(" w2" if (m['w']==2) else "")
    hd=f'<header><h4>{m["title"]}</h4>{chip("Added: "+latest_label,"new") if modnew else ""}</header>'
    ul='<ul class="ml">'+"".join(render_line(l,latest,modnew) for l in m['lines'])+'</ul>'
    return f'<section class="{cls}">{hd}{m["rich"] if full else ""}{"" if full and m["id"]=="pay" and False else ul}</section>'
def count(mods): return len(mods),sum(len(m['lines']) for m in mods),sum(len(m['lines']) for m in mods if m['id']=='paper')
def mods_for(ind,a,full=False): return BUILD[ind][0](a,full)
def render_dash(ind,a,latest=None,latest_label="",full=False,cols=2):
    mods=mods_for(ind,a,full)
    html='<div class="mgrid%s">'%(" m3" if cols==3 else "")+"".join(render_mod(m,latest,latest_label,full) for m in mods)+'</div>'
    return html,mods
def leftout(ind,a):
    items=BUILD[ind][1](a)
    if not items: return ""
    ch="".join(f'<span class="chip" >{t}</span>' for t,k in items)
    return f'<div class="mods"><span>Left out for now:</span>{ch}</div>'
