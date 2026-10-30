import sys,os,json,glob,shutil,subprocess,re
sys.path.insert(0,os.path.join(os.path.dirname(os.path.abspath(__file__)),'src'))
import lib
from lib import ROOT,PAGES
import flow,dashpages,apppages as A
for f in glob.glob(ROOT+'/pages/*.html'): os.remove(f)
flow.landing();flow.signup();flow.verify();flow.login();flow.industry();flow.builders()
for k in ['restaurants','hospitality','trades','office','delivery']: dashpages.dash_page(k)
A.run_payroll();A.pay_review();A.pay_stub();A.employees();A.profile();A.onboarding();A.w4();A.i9();A.deposit();A.time_tips();A.job_costing();A.settings();A.company();A.billing();A.help_()
# dedupe by id keep last; order
seen={};
for p in PAGES: seen[p['id']]=p
ORDER=['landing','signup','verify-email','login','industry','build-rest-1','build-rest-2','build-rest-3','build-rest-4','build-rest-5','build-rest-6','build-hospitality-1','build-trades-1','build-office-1','build-delivery-1','dash-restaurants','dash-hospitality','dash-trades','dash-office','dash-delivery','run-payroll','pay-run-review','pay-stub','employees','employee-profile','onboarding','onboard-w4','onboard-i9','onboard-deposit','time-tips','job-costing','settings','company-setup','billing','help']
idx=[seen[i] for i in ORDER]
assert len(idx)==len(seen),set(seen)-set(ORDER)
for n,p in enumerate(idx,1): p['n']=n
json.dump(idx,open(ROOT+'/pages.json','w'),indent=1)
print(len(idx),'pages')
