#!/usr/bin/env python3
# Writes one row per run and stage for the tracker, from each run's report and transcript.
# Interview is the first pass of the recorded interview stage; Concept is the rest of it. Seconds exist per
# recorded stage only, so Interview holds both. Scaffolding and Coding are one recorded stage, and on this
# path output tokens land late, so their usage sits on Coding and only their activity is split.
import json,os,re,sys
# python3 stages.py <runs dir> <out dir>
H,out=sys.argv[1:3]
rows=[]; odd=[]
for l in open(H+'/runs.jsonl'):
    d=json.loads(l)
    if not d.get('valid'): continue
    D=f"{H}/runs/{d['id']}"
    if not os.path.exists(D+'/report.json'): odd.append(d['id']); continue
    r=json.load(open(D+'/report.json'))['results'][0]
    st=r['stages']; su=r['usage']['stepUsage']; t=open(D+'/transcript.log').read() if os.path.exists(D+'/transcript.log') else ''
    proj=D+'/project'
    lines=lambda p:(sum(1 for _ in open(f'{proj}/{p}')) if os.path.exists(f'{proj}/{p}') else None)
    passes=[int(x) for x in re.findall(r'^· (\d+) steps?,',t,re.M)]
    p1=passes[0] if passes else st['interview']['steps']
    if not t: odd.append(d['id'])
    i=0; sl={}
    for k in ('interview','model','scenario','scaffold'):
        n=st[k]['steps']; sl[k]=su[i:i+n]; i+=n
    use=lambda s:dict(steps=len(s),inputK=round(sum(x['inputTokens'] for x in s)/1000,1),uncachedK=round(sum(x['inputTokens']-x['cachedInputTokens'] for x in s)/1000,1),outputK=round(sum(x['outputTokens'] for x in s)/1000,1))
    sec=lambda k:round((st[k]['durationMs']+st[k]['gateMs'])/1000)
    rep=r.get('repairsByPhase') or {}
    # Activity inside the build stage, split at the first file written under src/.
    cut=[x.end() for x in re.finditer(r'^· \d+ steps?,.*$',t,re.M)]
    n_before=st['interview']['passes']+st['model']['passes']+st['scenario']['passes']
    b=cut[n_before-1] if len(cut)>=n_before else len(t)
    body=t[b:]; w=re.search(r'^· wrote src/',body,re.M); sp=w.start() if w else len(body)
    sc,co=body[:sp],body[sp:]
    calls=lambda s:len(re.findall(r'^· (?:read_reference|list_reference|copy_reference|read_file):',s,re.M))
    wrote=re.findall(r'^· wrote (\S+) \((\d+)b\)',co,re.M)
    cmds=len(re.findall(r'^· \$ ',co,re.M))
    reached_build=st['scaffold']['steps']>0
    coded=bool(w) or not t and reached_build
    concept=os.path.exists(proj+'/spec/concept.md')
    def outcome(reached,repairs,last):
        if not reached: return 'not reached'
        if last: return 'stalled' if d['quality']==0 else 'red'
        return 'repaired' if repairs else 'clean'
    stalled=d['quality']==0
    last='Coding' if not d['passed'] else None
    if stalled: last='Coding' if coded else 'Scaffolding' if reached_build and sc.strip() else 'Scenario' if st['scenario']['steps'] else 'Model' if st['model']['steps'] else 'Concept'
    base=dict(run=d['id'],strategy=d['strategy'],model=d['model'],quality=d['quality'])
    a=use(sl['interview'][:p1]); c=use(sl['interview'][p1:])
    def row(stage,order,u,seconds,produced,label,reached,repairs,passes_):
        rows.append({**base,'key':f"{d['id']}/{stage}",'stage':stage,'order':order,'passes':passes_,'steps':u.get('steps'),'inputK':u.get('inputK'),'uncachedK':u.get('uncachedK'),'outputK':u.get('outputK'),'seconds':seconds,'produced':produced,'producedLabel':label,'outcome':outcome(reached,repairs,last==stage),'repairs':repairs})
    row('Interview',1,a,sec('interview'),d['questions'],'questions asked',True,0,1)
    row('Concept',2,c,None,lines('spec/concept.md'),'concept lines',concept,0,st['interview']['passes']-1)
    row('Model',3,use(sl['model']),sec('model'),lines('spec/model.ts'),'model lines',st['model']['steps']>0,rep.get('model',0),st['model']['passes'])
    row('Scenario',4,use(sl['scenario']),sec('scenario'),d['tests'],'scenario tests',st['scenario']['steps']>0,rep.get('scenario',0),st['scenario']['passes'])
    row('Scaffolding',5,{},None,calls(sc) if t else None,'references read or copied',reached_build,0,None)
    row('Coding',6,use(sl['scaffold']),sec('scaffold'),len(set(p for p,_ in wrote)) if t else None,'files written',coded,d['repairs']-rep.get('model',0)-rep.get('scenario',0) if d['repairs'] else 0,st['scaffold']['passes'])
json.dump(rows,open(out+'/stages-view.json','w'),indent=0)
print(len(rows),'rows',len(rows)//6,'runs; odd:',odd[:5])
