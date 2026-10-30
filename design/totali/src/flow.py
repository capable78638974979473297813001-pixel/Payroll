from lib import *
from dash import *

# ---------- landing ----------
def landing():
    h=open(os.path.join(ROOT,'..','totali-landing','v3','index.html')).read()
    h=h.replace('href="fonts.css"','href="../assets/fonts.css"').replace('href="style.css"','href="../assets/style.css"').replace('src="img/','src="../assets/img/')
    h=h.replace('<a class="btn sm" href="#pricing">Request early access</a>','<a class="link" style="margin-right:6px" href="login.html">Log in</a><a class="btn sm" href="signup.html">Create account</a>')
    h=h.replace('<form class="join" onsubmit="return false">','<form class="join" action="signup.html">').replace('<button class="btn">Request early access</button>','<button class="btn">Create account</button>',1)
    h=h.replace('.top nav{','.top nav{')
    open(os.path.join(ROOT,'pages','landing.html'),'w').write(h)
    PAGES.append(dict(id='landing',title='Landing',group='1 · Get started',file='pages/landing.html',desktop='out/landing.png',mobile='out/landing-mobile.png',description='v3 landing page, now linked to sign up and log in.'))

# ---------- auth ----------
def authtop(right):
    return f'<header class="authtop ui">{LOGO}<span>{right}</span></header>'
def signup():
    form='''<div class="acard ui"><div class="steps3"><span class="on">Account</span><i></i><span>Verify</span><i></i><span>Your business</span></div>
<h1>Create your <em>account</em></h1><p>Start with you. We\u2019ll ask about the business next.</p>
<div class="f">
<div class="oauth"><i></i>Continue with Google</div><div class="or">or with email</div>
<div class="r2"><div><label>First name</label><div class="in fill">Scott</div></div><div><label>Last name</label><div class="in fill">Holdan</div></div></div>
<div><label>Business name</label><div class="in fill">Harbor Street Kitchen</div></div>
<div><label>Work email</label><div class="in fill">owner@harborstreet.example</div></div>
<div><label>Password</label><div class="in foc">&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</div><div class="pwbar"><span class="on"></span><span class="on"></span><span class="on"></span><span></span></div><div class="help">At least 10 characters. A phrase works well.</div></div>
<div class="ck2 on"><span class="cb"></span><span class="fine">I agree to the <a>Terms</a> and <a>Privacy Policy</a> of OMNIA TAX LLC.</span></div>
<a class="btn lg" href="verify-email.html" style="text-align:center">Create account</a>
</div></div>'''
    vis='''<div class="avis"><figure class="photo"><img src="../assets/img/waiter.jpg" alt="A server carrying plates" style="object-position:50% 30%"></figure>
<div class="hand" style="left:-20px;top:70px;width:200px;font-size:26px">Takes about five minutes. Stop any time, we save as you go.</div>
<div class="hand" style="left:30px;top:200px">'''+arrow(110,60,False,"M6 8 C 30 2, 70 14, 100 46")+'''</div></div>'''
    reg('signup','Create account','1 · Get started',authtop('Already have an account?<a class="l2" href="login.html">Log in</a>')+f'<main class="auth">{form}{vis}</main>',True,'Account creation: name, business, email, password.')
def verify():
    form='''<div class="acard ui"><div class="steps3"><span class="done">Account</span><i></i><span class="on">Verify</span><i></i><span>Your business</span></div>
<h1>Check your <em>email</em></h1><p>We sent a 6-digit code to owner@harborstreet.example. It works for 15 minutes.</p>
<div class="codes"><span>4</span><span>8</span><span>1</span><span>0</span><span class="cur">2</span><span></span></div>
<a class="btn lg" href="industry.html" style="display:block;text-align:center">Verify and continue</a>
<p class="fine" style="margin-top:16px">Nothing there? Check spam, or <a>send a new code</a>. Wrong address? <a>Change it</a>.</p></div>'''
    mail='''<div class="avis"><div class="mail" style="position:absolute;left:40px;top:30px"><div class="mh2"><b style="color:var(--ink)">Totali</b> &lt;no-reply@totali.example&gt;<br>To: owner@harborstreet.example<br>Subject: Your Totali code</div>
<div class="mb">Hi Scott,<br>Use this code to finish creating your account.<div class="code">481 025</div><span class="fine">It expires in 15 minutes. If you didn\u2019t ask for it, ignore this email.</span><br><br><span class="fine">OMNIA TAX LLC · sample email</span></div></div>
<div class="hand" style="left:60px;top:370px;width:260px;font-size:26px;transform:rotate(-3deg)">This is what lands in your inbox.</div></div>'''
    reg('verify-email','Verify email','1 · Get started',authtop('Wrong account?<a class="l2" href="signup.html">Start over</a>')+f'<main class="auth">{form}{mail}</main>',True,'Six-digit email verification.')
def login():
    form='''<div class="acard ui"><h1>Welcome <em>back</em></h1><p>Log in to your Totali account.</p>
<div class="f"><div class="oauth"><i></i>Continue with Google</div><div class="or">or with email</div>
<div><label>Work email</label><div class="in fill">owner@harborstreet.example</div></div>
<div><label>Password <small style="float:right"><a class="link" style="font-size:12.5px">Forgot it?</a></small></label><div class="in foc">&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</div></div>
<div class="ck2 on"><span class="cb"></span><span class="fine">Keep me signed in on this device</span></div>
<a class="btn lg" href="dash-restaurants.html" style="text-align:center">Log in</a></div>
<p class="fine" style="margin-top:20px">Staying signed in lasts until you choose <b>Sign out</b> in the top menu.</p></div>'''
    vis='''<div class="avis"><figure class="photo"><img src="../assets/img/chef.jpg" alt="Cooks plating dishes" style="object-position:50% 40%"></figure>
<div class="hand" style="left:10px;top:420px;width:260px;font-size:26px;transform:rotate(-3deg)">Your pay run is where you left it.</div></div>'''
    reg('login','Log in','1 · Get started',authtop('New here?<a class="l2" href="signup.html">Create account</a>')+f'<main class="auth">{form}{vis}</main>',True,'Log in with email, stays signed in until sign out.')

# ---------- industry ----------
ICON={
'restaurants':'<path d="M4 21h22M6 21a9 9 0 0 1 18 0M15 10V7M13 7h4"/>',
'hospitality':'<circle cx="10" cy="16" r="4.5"/><path d="M14.5 16H27M23 16v4.5M27 16v3"/>',
'trades':'<path d="M7 24l9-9M15 6l9 9-3.2 3.2-9-9zM13 8.5l-4 4"/>',
'office':'<rect x="4" y="10" width="22" height="15" rx="2.2"/><path d="M11 10V7h8v3M4 17.5h22"/>',
'delivery':'<path d="M4 10l11-5 11 5v11l-11 5-11-5zM4 10l11 5 11-5M15 15v11"/>'}
def industry():
    def tile(k,title,em,desc,tags,color,span="",extra="",on=False):
        t="".join(chip(x,"line") for x in tags)
        photo='<figure class="photo ph3"><img src="../assets/img/chef.jpg" alt="" style="object-position:60% 40%"></figure>' if False else ''
        return f'''<a class="it {span} {"on" if on else ""}" href="build-rest-1.html" style="{extra}"><span class="ic" style="background:{color}"><svg viewBox="0 0 30 30">{ICON[k]}</svg></span><span class="tick"></span>
{photo}<h3>{title} <em>{em}</em></h3><p>{desc}</p><div class="tags">{t}</div></a>'''
    t=''.join([
     tile('restaurants','Restaurants','and bars','Servers, cooks and bartenders. Hours, tips and tip pools on one pay run.',['Tips','Shift hours','Tip pool'],'#8E1F4E','',"",True),
     tile('hospitality','Hotels','and venues','Front desk to housekeeping. Departments, split shifts and service charges.',['Departments','Seasonal staff','Service charge'],'#0E5A66'),
     tile('trades','Trades','and construction','Crews, jobs and cost codes. Prevailing wage and union rates when you need them.',['Job costing','Crews','Workers\u2019 comp classes'],'#F0613A'),
     tile('office','Office','and studios','Salaried and hourly staff, time off, and people in more than one state.',['Salaried and hourly','Time off','Multi-state'],'#3B2A33','span-3'),
     tile('delivery','Delivery','and couriers','Drivers paid by the hour and by the trip. Mileage and contractor drivers.',['Trips','Mileage','Contractor drivers'],'#0E4D5A','span-3'),
    ]).replace('class="it  ','class="it ').replace('span-3','w3')
    head='''<div class="indhead ui"><div class="steps3"><span class="done">Account</span><i></i><span class="done">Verify</span><i></i><span class="on">Your business</span></div>
<h1 class="pt" style="font-size:30px">What kind of <em>business</em> is it?</h1><p class="cap" style="margin-top:8px;max-width:560px;font-size:15px">Each one starts with its own dashboard. A few questions later, it\u2019s yours.</p></div>'''
    foot='''<div class="indfoot ui"><span class="hand">Not sure? Pick the closest. You can change it later.</span><div class="acts"><a class="link">Back</a><a class="btn lg" href="build-rest-1.html">Continue with Restaurants</a></div></div>'''
    reg('industry','Pick your industry','1 · Get started',authtop('Signed in as owner@harborstreet.example')+head+f'<div class="indgrid ui">{t}</div>'+foot+'<div style="height:70px"></div>',True,'Choose a broad industry; each one starts from a base dashboard.')

# ---------- builder ----------
STATE_NAMES={'restaurants':'Michigan'}
def stepper(ind,answered,cur,summ):
    li=""
    for k,lab in QDEF[ind]:
        cls="cur" if k==cur else ("done" if k in answered else "")
        li+=f'<li class="{cls}">{lab}{"<i>"+summ[k]+"</i>" if k in answered and k!=cur and k in summ else ""}</li>'
    li+=f'<li class="{"cur" if cur=="review" else ""}">Review</li>'
    return f'<ul class="stepper">{li}</ul>'
def opts(items,sel,cols=1,kind="rd"):
    o=""
    for t,s in items:
        on=t in sel
        o+=f'<div class="opt {"on" if on else ""}"><span class="{kind}"></span><span>{t}{"<small>"+s+"</small>" if s else ""}</span></div>'
    return f'<div class="opts {"c%d"%cols if cols>1 else ""}">{o}</div>'
def adds(items):
    if not items: return ""
    li="".join(f'<li style="padding:3px 0 3px 16px;position:relative"><span style="position:absolute;left:0;top:11px;width:6px;height:6px;border-radius:50%;background:var(--tang)"></span>{x}</li>' for x in items)
    return f'<div style="margin-top:18px;padding:12px 14px;background:#FFF1E6;border-radius:9px;font:13.5px Inter"><b style="color:var(--berry);font-weight:600">This adds to your dashboard</b><ul style="list-style:none;margin-top:6px;color:#5a4048">{li}</ul></div>'
def build_page(id,title,ind,answered,cur,qn,qtitle,qsub,qbody,summ,latest=None,llabel="",note="",addsl=None,mobile=False,review=False,desc="",group="2 · Build your dashboard",btn="Continue",qnote=""):
    Q=QDEF[ind];n=len(Q)+1;c=CO[ind]
    seg="".join(f'<span class="{"on" if i<qn-1 else ("cur" if i==qn-1 else "")}"></span>' for i in range(n))
    bh=f'<header class="bhead ui">{LOGO_SM}<div class="prog"><span>{"Review" if review else "Question %d of %d"%(qn,len(Q))}</span><div class="seg">{seg}</div></div><a class="link">Save and finish later</a></header>'
    html,mods=render_dash(ind,answered,latest,llabel)
    nm,ni,nf=count(mods)
    base_m,base_i,base_f=count(mods_for(ind,{}))
    up=lambda cur,base:" up" if cur!=base else ""
    cnt=f'<div class="counts"><span class="{up(nm,base_m).strip()}"><b>{nm}</b>modules</span><span class="{up(ni,base_i).strip()}"><b>{ni}</b>items</span><span class="{up(nf,base_f).strip()}"><b>{nf}</b>forms</span></div>'
    notehtml=f'<div class="hand" style="margin:0 0 12px 4px;display:flex;gap:6px;align-items:flex-end;font-size:24px">{note}</div>' if note else ""
    tabs='<a class="on">Overview</a><a>Payroll</a><a>People</a><a>Time &amp; tips</a>' if ind=='restaurants' else '<a class="on">Overview</a><a>Payroll</a><a>People</a>'
    pv=f'''<div class="pvwrap ui"><div class="pvtop"><h3>Your dashboard, as it builds</h3>{cnt}</div>{notehtml}
<div class="pv"><div class="atop"><span class="org"><span class="orgmark">{c["mark"]}</span><b>{c["name"]}</b></span><span class="tabs">{tabs}</span></div>
<div class="pvb">{html}{leftout(ind,answered)}</div>{stamp("preview")}</div></div>'''
    if review:
        q=qbody
    else:
        q=f'''<div class="qcard"><div class="qn">QUESTION {qn} OF {len(Q)}</div><h2>{qtitle}</h2><p class="q">{qsub}</p>{qbody}{adds(addsl)}
<div class="qfoot"><a class="link">{"Back" if qn>1 else ""}</a><a class="btn" href="#">{btn}</a></div></div>'''
    qn_html=f'<div class="hand" style="margin:20px 0 0 8px;font-size:24px;transform:rotate(-1.5deg)">{qnote}</div>' if qnote else ''
    body=f'{bh}<main class="bgrid ui">{stepper(ind,answered,cur,summ)}<div>{q}{qn_html}</div>{pv}</main>'
    reg(id,title,group,body,mobile,desc)

SUMM_R={'state':'Michigan','loc':'Detroit, Ferndale','team':'11 to 25 people','tips':'Yes','freq':'Weekly','contr':'Yes'}
def q_state(sel=None,ind='restaurants',typed="Mi"):
    opts_={"Mi":["Michigan","Minnesota","Mississippi","Missouri"],"O":["Ohio","Oklahoma","Oregon"],"Pen":["Pennsylvania"],"Co":["Colorado","Connecticut"]}[typed]
    if sel:
        return f'<label class="lab">State</label><div class="in sel foc"><span>{sel}</span>{CHEV}</div><div class="help">Your people\u2019s work location sets state tax, unemployment and notices.</div>'
    rows="".join(f'<div style="padding:9px 12px;{"background:#FCEFEA;color:var(--berry)" if i==0 else ""}">{o}</div>' for i,o in enumerate(opts_))
    return f'''<label class="lab">State</label><div class="in sel foc"><span>{typed}<span style="border-left:1.5px solid var(--berry);margin-left:1px"></span></span>{CHEV}</div>
<div style="border:1px solid #D9C6B6;border-radius:8px;background:#fff;margin-top:4px;box-shadow:0 14px 24px -18px rgba(60,10,30,.4);overflow:hidden;font-size:14.5px">{rows}</div>'''
def q_loc(cities,placeholder="Add another city",help_="",suggest=()):
    ch="".join(f'<span class="pill on">{c} <small>{ab}</small></span>' for c,ab in cities)
    sg="".join(f'<span class="pill">{c}</span>' for c in suggest)
    return f'<label class="lab">Where your team works</label><div class="chips2" style="margin-bottom:12px">{ch}</div><div class="in sel ph"><span>{placeholder}</span></div>{("<div class=chips2 style=margin-top:10px>"+sg+"</div>") if sg else ""}<div class="help">{help_}</div>'
def builders():
    ind='restaurants';S=SUMM_R
    T='Pick the state your team works in. We\u2019ll add the right taxes and notices.'
    build_page('build-rest-1','Builder 1 · Restaurants, empty base',ind,{},'state',1,'Where is <em>Harbor Street Kitchen</em>?',T,q_state(),S,None,"",'Every restaurant starts here',None,True,qnote='Pick Michigan and watch the right side.',desc='Restaurants: base dashboard before any answer. State question open.')
    build_page('build-rest-2','Builder 2 · Michigan added',ind,{'state':'MI'},'state',1,'Where is <em>Harbor Street Kitchen</em>?',T,q_state('Michigan'),S,'state','Michigan','Michigan added a whole card',['Michigan withholding, plus the MI-W4 form','Unemployment account','Minimum wage reference and earned sick time'],True,qnote='One answer, five new items.',desc='Choosing Michigan adds the Michigan card and the MI-W4 form.')
    body=q_loc([("Detroit","MI"),("Ferndale","MI")],"Add another city","City income tax follows the work location. Detroit has one. Ferndale has none set up.",("Royal Oak","Dearborn","Ann Arbor"))
    build_page('build-rest-3','Builder 3 · Detroit city tax added',ind,{'state':'MI','loc':['Detroit','Ferndale']},'loc',2,'Where does your team <em>work</em>?','Add each place you have a location.',body,S,'loc','Locations','Detroit city tax appeared',['Detroit city income tax, inside the Michigan card','A Locations card with both sites'],True,qnote='Ferndale has no city tax, so it adds nothing.',desc='Adding Detroit adds Detroit city income tax and a Locations card.')
    body=opts([("Yes","Servers, bartenders, hosts, others"),("No","Nobody earns tips")],["Yes"])
    build_page('build-rest-4','Builder 4 · Tips and tip credit added',ind,{'state':'MI','loc':['Detroit','Ferndale'],'team':'11-25','tips':'yes'},'tips',4,'Does anyone earn <em>tips</em>?','Tips change how pay stubs and taxes are worked out.',body,S,'tips','Tipped staff','Tip lines landed in three cards',['Tip pool and tip reporting','Tip credit reference, in the Michigan card','Tips counted in taxable wages'],True,qnote='Say No and these lines never appear.',desc='Answering yes to tipped staff adds tip reporting, tip pool, Michigan tip credit reference.')
    body=opts([("Yes","A plumber, a bookkeeper, a sign painter"),("No","Everyone is on payroll")],["Yes"])+'<div class="r2" style="margin-top:14px"><div><label class="lab">About how many?</label><div class="in fill">2</div></div><div></div></div>'
    build_page('build-rest-5','Builder 5 · Contractors added',ind,{'state':'MI','loc':['Detroit','Ferndale'],'team':'11-25','tips':'yes','freq':'weekly','contr':'yes'},'contr',6,'Do you pay <em>contractors</em>?','People you pay by invoice and send a 1099, not a paycheck.',body,S,'contr','Contractors','A Contractors card, kept apart',['1099 contractor tracking','W-9 collection and year totals'],True,qnote='Kept apart from the pay run on purpose.',desc='Contractors answer adds a separate contractors card.')
    a6={'state':'MI','loc':['Detroit','Ferndale'],'team':'11-25','tips':'yes','freq':'weekly','contr':'yes'}
    summ="".join(f'<div class="row"><span class="l1"><b>{lab}</b></span><span style="font-family:Fraunces;font-style:italic;color:var(--berry)">{S[k]}</span><a class="link">Edit</a></div>' for k,lab in QDEF['restaurants'])
    rv=f'''<div class="qcard"><div class="qn">ALL SET</div><h2>Your dashboard is <em>ready</em></h2><p class="q">Here\u2019s what you told us. Change any answer and the dashboard changes with it.</p>{summ}
<div class="qfoot"><a class="link">Back</a><a class="btn lg" href="dash-restaurants.html">Build my dashboard</a></div></div>
<div class="hand" style="margin:18px 0 0 6px;font-size:25px">__SUMMARY__</div>'''
    _m=mods_for(ind,a6);_n=count(_m);rv=rv.replace('__SUMMARY__',f'{_n[0]} modules, {_n[1]} items. One account number still to add.')
    build_page('build-rest-6','Builder 6 · Review, complete',ind,a6,'review',7,'','',rv,S,None,"",'Everything you answered is here',None,True,review=True,desc='Final review of answers; dashboard complete.')
    # other industries: base builder + question 1
    base_q={
     'hospitality':('Hotels','Where is <em>Lakeshore Inn</em>?','Ohio','O'),
     'trades':('Trades','Where is <em>Northgate Electric</em> based?','Pennsylvania','Pen'),
     'office':('Office','Where does <em>Birch &amp; Lane Studio</em> have people?',None,'Te'),
     'delivery':('Delivery','Where is <em>Switchback Delivery</em> based?','Colorado','Co')}
    for k,(lab,qt,stt,typed) in base_q.items():
        if k=='office':
            body='<label class="lab">States where people work</label><div class="chips2" style="margin-bottom:12px"><span class="pill on">Texas</span></div><div class="in sel foc"><span>Add another state<span style="border-left:1.5px solid var(--berry);margin-left:1px"></span></span>'+CHEV+'</div><div class="help">Add every state you have a paid employee in, including remote staff.</div>'
            ans={}
        else:
            body=q_state(None,k,typed)+""
            ans={}
        build_page(f'build-{k}-1',f'Builder · {lab} base',k,ans,'state',1,qt,T if k!='office' else 'Each state adds its own taxes and forms.',body,{},None,"",'Starts from a base for '+{'hospitality':'hotels','trades':'trades','office':'offices','delivery':'delivery'}[k],None,k=='trades',desc=f'{lab}: empty base dashboard, first question open.')
