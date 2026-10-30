import os, json, re
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES=[]   # registry
def money(x,d=2): return ("${:,.%df}"%d).format(x)
def initials(n): return "".join(w[0] for w in n.split()[:2])
def av(n,cls=""): return f'<span class="av {cls}">{initials(n)}</span>'
def who(n,sub=""): return f'<div class="who">{av(n)}<span><b>{n}</b><i>{sub}</i></span></div>'

LOGO='<a class="logo" href="landing.html" aria-label="Totali">totali<svg viewBox="0 0 120 10" preserveAspectRatio="none"><path d="M2 6 C 22 1, 40 9, 62 5 S 100 2, 118 6" fill="none" stroke="#F0613A" stroke-width="2.6" stroke-linecap="round"/></svg></a>'
LOGO_SM=LOGO.replace('class="logo"','class="logo sm"')
CHEV='<svg viewBox="0 0 12 8"><path d="M1 1.5l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
def arrow(w=120,h=60,flip=False,d="M6 8 C 40 2, 90 20, 112 52",color="#0E5A66"):
    return f'<svg viewBox="0 0 {w} {h}" width="{w}" height="{h}" style="{"transform:scaleX(-1);" if flip else ""}"><path d="{d}" fill="none" stroke="{color}" stroke-width="2.4" stroke-linecap="round"/><path d="M{w-24} {h-8} L{w-6} {h-6} L{w-10} {h-24}" fill="none" stroke="{color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
def stamp(txt="draft",extra=""):
    return f'<svg class="stamp" {extra} viewBox="0 0 120 120"><defs><path id="circ{abs(hash(txt))%999}" d="M60 60 m-44 0 a44 44 0 1 1 88 0 a44 44 0 1 1 -88 0"/></defs><circle cx="60" cy="60" r="55" fill="none" stroke="#F0613A" stroke-width="3"/><circle cx="60" cy="60" r="33" fill="none" stroke="#F0613A" stroke-width="1.5"/><text font-family="Inter" font-weight="600" font-size="11.5" letter-spacing="3.2" fill="#F0613A"><textPath href="#circ{abs(hash(txt))%999}">SAMPLE DATA · SAMPLE DATA ·</textPath></text><text x="60" y="66" text-anchor="middle" font-family="Fraunces" font-style="italic" font-size="19" fill="#F0613A">{txt}</text></svg>'

CO={
 'restaurants':dict(name="Harbor Street Kitchen",mark="H",state="Michigan",ab="MI",legal="Harbor Street Kitchen LLC"),
 'hospitality':dict(name="Lakeshore Inn",mark="L",state="Ohio",ab="OH",legal="Lakeshore Hospitality LLC"),
 'trades':dict(name="Northgate Electric",mark="N",state="Pennsylvania",ab="PA",legal="Northgate Electric Inc."),
 'office':dict(name="Birch & Lane Studio",mark="B",state="Texas",ab="TX",legal="Birch & Lane Studio LLC"),
 'delivery':dict(name="Switchback Delivery",mark="S",state="Colorado",ab="CO",legal="Switchback Delivery LLC"),
}
TABS={
 'restaurants':[('Overview','dash-restaurants'),('Payroll','run-payroll'),('People','employees'),('Time &amp; tips','time-tips'),('Onboarding','onboarding')],
 'hospitality':[('Overview','dash-hospitality'),('Payroll','#'),('People','#'),('Departments','#'),('Onboarding','#')],
 'trades':[('Overview','dash-trades'),('Payroll','#'),('People','#'),('Jobs','job-costing'),('Onboarding','#')],
 'office':[('Overview','dash-office'),('Payroll','#'),('People','#'),('Time off','#'),('Onboarding','#')],
 'delivery':[('Overview','dash-delivery'),('Payroll','#'),('People','#'),('Deliveries','#'),('Onboarding','#')],
}
def nav(ind='restaurants',active='Overview',badge=None):
    c=CO[ind]; t=""
    for lab,href in TABS[ind]:
        on=' class="on"' if lab.replace('&amp;','&')==active.replace('&amp;','&') else ''
        em=f'<em>{badge}</em>' if (badge and lab=='Onboarding') else ''
        t+=f'<a{on} href="{href+".html" if href!="#" else "dash-"+ind+".html"}">{lab}{em}</a>'
    return f'''<header class="nav ui">{LOGO_SM}<span class="org"><span class="orgmark">{c["mark"]}</span><b>{c["name"]}</b>{CHEV}</span>
<nav class="tabs">{t}</nav><span class="rt2"><a class="hl" href="help.html">Help</a><a class="hl" href="settings.html">Settings</a>{av("Scott H")}</span></header>'''

HEAD='''<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>%s · Totali</title>
<link rel="stylesheet" href="../assets/fonts.css">
<link rel="stylesheet" href="../assets/style.css">
<link rel="stylesheet" href="../assets/app.css">
</head><body class="tapp">
'''
TAIL='''
<script>addEventListener("load",()=>document.documentElement.setAttribute("data-h",document.documentElement.scrollHeight))</script>
</body></html>'''
LEGAL='''<div class="legal ui"><p>Totali is a product of OMNIA TAX LLC. Tax amounts are calculated by the Omnia.tax engine. All names, numbers and amounts on this page are sample data.</p><span>Sample data</span></div>'''
def reg(id,title,group,body,mobile=False,desc="",full_title=None):
    html=HEAD%title+body+TAIL
    open(os.path.join(ROOT,'pages',id+'.html'),'w').write(html)
    PAGES.append(dict(id=id,title=title,group=group,file=f"pages/{id}.html",desktop=f"out/{id}.png",mobile=(f"out/{id}-mobile.png" if mobile else None),description=desc))
def app_page(id,title,group,ind,active,body,mobile=False,desc="",badge=None,legal=True):
    reg(id,title,group,nav(ind,active,badge)+f'<main class="wrap ui">{body}{LEGAL if legal else ""}</main>',mobile,desc)
def ph(title,sub="",acts="",em=None):
    return f'<div class="ph2"><div><h1 class="pt">{title}</h1>{"<p>"+sub+"</p>" if sub else ""}</div><div class="acts">{acts}</div></div>'
def chip(t,k=""): return f'<span class="chip {k}">{t}</span>'
def dt(t,ok=True): return f'<span class="dt {"ok" if ok else "no"}">{t}</span>'

# ---------- sample roster (Harbor Street Kitchen) ----------
EMPS=[ # name, role, loc, hrs, ot, rate, tips, flag, resident_detroit
("Priya Raman","Line cook","Detroit",40,0,21.50,0,"",0),
("Marcus Bell","Sous chef","Detroit",40,6,26.00,0,"ot",1),
("Elena Ruiz","Server","Detroit",32.5,0,15.50,412.30,"",1),
("Tom Whitaker","Server","Detroit",28,0,15.50,361.75,"",0),
("Dana Okafor","Bartender","Detroit",36,0,16.00,504.20,"",0),
("Sam Ito","Dishwasher","Detroit",30,0,16.50,0,"",1),
("Lucia Ferrante","Host","Detroit",22,0,16.00,96.00,"",0),
("Hana Cole","Prep cook","Ferndale",38,0,18.75,0,"",0),
("Jordan Pike","Server","Ferndale",18,0,15.50,148.50,"w4",0),
("Reggie Tran","Line cook","Ferndale",40,0,20.00,0,"",0),
("Amira Haddad","Server","Ferndale",30,0,15.50,338.40,"",0),
("Colin Marsh","Busser","Ferndale",24,0,15.00,112.00,"",0),
("Ben Kowalski","Bartender","Ferndale",34,0,16.00,468.90,"",0),
]
def calc(e):
    nm,role,loc,h,ot,rate,tips,flag,res=e
    gross=round(h*rate+ot*rate*1.5+tips,2)
    fed=round(gross*0.085,2);ss=round(gross*0.062,2);med=round(gross*0.0145,2);mi=round(gross*0.0425,2)
    city=round(gross*(0.024 if res else 0.012),2) if loc=="Detroit" else 0.0
    tx=fed+ss+med+mi+city
    return dict(name=nm,role=role,loc=loc,hrs=h+ot,ot=ot,rate=rate,tips=tips,flag=flag,res=res,gross=gross,fed=fed,ss=ss,med=med,mi=mi,city=city,tax=round(tx,2),net=round(gross-tx,2))
RUN=[calc(e) for e in EMPS]
OK=[r for r in RUN if r['flag']!='w4']
TOT={k:round(sum(r[k] for r in OK),2) for k in ('gross','fed','ss','med','mi','city','tax','net','tips')}
TOT['n']=len(OK)
def er_tax(): # employer side sample
    g=TOT['gross']; return dict(ss=round(g*0.062,2),med=round(g*0.0145,2),futa=round(g*0.006,2),mi_ui=round(g*0.027,2))
