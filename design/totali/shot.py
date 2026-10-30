import subprocess,re,json,os,sys
from concurrent.futures import ThreadPoolExecutor
ROOT=os.path.dirname(os.path.abspath(__file__))
base=["google-chrome","--headless=new","--no-sandbox","--hide-scrollbars","--force-device-scale-factor=1","--virtual-time-budget=6000","--disable-gpu"]
def shot(args):
    pid,w,out=args
    U=f"file://{ROOT}/pages/{pid}.html"
    d=subprocess.run(base+[f"--window-size={w},500","--dump-dom",U],capture_output=True,text=True).stdout
    m=re.search(r'data-h="(\d+)"',d)
    h=int(m.group(1)) if m else 2000
    subprocess.run(base+[f"--window-size={w},{h}",f"--screenshot={ROOT}/out/{out}.png",U],capture_output=True)
    return pid,w,h
if __name__=="__main__":
    only=sys.argv[1:]
    idx=json.load(open(ROOT+'/pages.json'))
    jobs=[]
    for p in idx:
        if only and p['id'] not in only: continue
        jobs.append((p['id'],1440,p['id']))
        if p['mobile']: jobs.append((p['id'],390,p['id']+'-mobile'))
    with ThreadPoolExecutor(6) as ex:
        for r in ex.map(shot,jobs): print(*r)
