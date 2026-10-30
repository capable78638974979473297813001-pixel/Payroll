from lib import *
from dash import *
FINAL={
 'restaurants':{'state':'MI','loc':['Detroit','Ferndale'],'team':'11-25','tips':'yes','freq':'weekly','contr':'yes'},
 'hospitality':{'state':'OH','loc':['Lakeshore Inn, Sandusky','Lakeshore Cottages, Port Clinton'],'team':'26-50','tips':'yes','seasonal':'yes','freq':'biweekly'},
 'trades':{'state':'PA','loc':['Pittsburgh shop','Job sites, by project'],'team':'11-25','union':'yes','subs':'yes','freq':'weekly'},
 'office':{'state':['TX','NY','CA'],'loc':['Austin office','Remote in NY and CA'],'team':'11-25','pay':'mixed','ben':'yes','freq':'semi'},
 'delivery':{'state':'CO','loc':['Denver','Aurora'],'team':'26-50','drv':'both','miles':'yes','freq':'weekly'},
}
CHIPS={
 'restaurants':['Michigan','Detroit and Ferndale','11 to 25 people','Tipped staff','Weekly','Contractors'],
 'hospitality':['Ohio','2 properties','26 to 50 people','Tips and service charge','Seasonal staff','Every two weeks'],
 'trades':['Pennsylvania','Shop and job sites','11 to 25 people','Prevailing wage and union','Subcontractors','Weekly'],
 'office':['Texas, New York, California','Austin and remote','11 to 25 people','Salaried and hourly','Benefit deductions','Twice a month'],
 'delivery':['Colorado','Denver and Aurora hubs','26 to 50 people','Employees and contractors','Mileage','Weekly'],
}
SUB={
 'restaurants':'Fri, Oct 30 · 2 locations in Michigan · 14 people',
 'hospitality':'Fri, Oct 30 · 2 properties in Ohio · 38 people',
 'trades':'Fri, Oct 30 · Pennsylvania · 24 people on 6 jobs',
 'office':'Fri, Oct 30 · Austin and remote · 16 people in 3 states',
 'delivery':'Fri, Oct 30 · 2 hubs in Colorado · 31 drivers',
}
NOTE={
 'restaurants':'Michigan, Detroit and tips are all in here because of what you told us.',
 'hospitality':'Ohio city and school district tax are here because you said Ohio.',
 'trades':'Prevailing wage showed up because you said yes to public jobs.',
 'office':'Three states, three cards. Texas has no state income tax.',
 'delivery':'Colorado family leave and Denver tax came with your answers.',
}
def dash_page(ind):
    a=FINAL[ind];c=CO[ind]
    html,mods=render_dash(ind,a,None,"",True,3)
    nm,ni,nf=count(mods)
    chips="".join(chip(x,"berry") for x in CHIPS[ind])
    strip=f'''<div class="card flat" style="display:flex;align-items:center;gap:18px;padding:12px 18px;background:#FBF1E5;margin-bottom:18px">
<span class="cap" style="white-space:nowrap">Built from your answers</span><div class="chips2" style="flex:1">{chips}</div><a class="link" href="settings.html">Edit answers</a></div>
<div class="hand" style="margin:-6px 0 14px 6px;font-size:23px">{NOTE[ind]} <span style="color:var(--mut);font-size:19px">({nm} modules, {ni} items)</span></div>'''
    first=CO[ind]['name']
    body=ph(c['name'],SUB[ind],'<a class="btn ghost sm" href="onboarding.html">Add employee</a><a class="btn sm" href="run-payroll.html">Run payroll</a>')+strip+html
    app_page(f'dash-{ind}',f'Dashboard · {c["name"]}',"3 · Your dashboard",ind,'Overview',body,ind=='restaurants',f'Final custom dashboard for {c["name"]} ({", ".join(CHIPS[ind][:1])}).',badge="3" if ind=='restaurants' else None)
