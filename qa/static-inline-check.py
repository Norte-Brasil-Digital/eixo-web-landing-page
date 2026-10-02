from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import urlsplit, parse_qs
import json, datetime, re, sys
root=Path(__file__).resolve().parents[1]; site=root/'site'
ready='--ready' in sys.argv
html=(site/'index.html').read_text(encoding='utf-8'); css=(site/'styles.css').read_text(encoding='utf-8'); js=(site/'lead-form.mjs').read_text(encoding='utf-8'); adapter=(site/'evo-integration.mjs').read_text(encoding='utf-8'); headers=(site/'_headers').read_text(encoding='utf-8')
class Parser(HTMLParser):
 def __init__(self): super().__init__(); self.tags=[]
 def handle_starttag(self,tag,attrs): self.tags.append((tag,dict(attrs)))
p=Parser();p.feed(html);tags=p.tags;checks=[]
def check(name,ok):checks.append({'name':name,'passed':bool(ok)})
ids=[a['id'] for t,a in tags if 'id' in a]; links=[a for t,a in tags if t=='a']; inputs=[a for t,a in tags if t=='input']; labels=[a for t,a in tags if t=='label']; forms=[a for t,a in tags if t=='form']
refs=[]
for t,a in tags:
 for key in ('src','href'):
  v=a.get(key,'')
  if v and not v.startswith(('https:','http:','#','data:','mailto:','tel:')):refs.append(v)
check('Local asset references exist',all((site/v).is_file() for v in refs))
check('IDs unique and internal anchors resolve',len(ids)==len(set(ids)) and all(a['href'][1:] in ids for a in links if a.get('href','').startswith('#')))
check('Three demo buttons target inline form',sum('data-demo' in a for a in links)==3 and all(a['href']=='#demonstracao' for a in links if 'data-demo' in a))
check('One native form with exact verified fields',len(forms)==1 and {a['name'] for a in inputs}=={'name','email','phone','company'})
check('Required fields match source', {a['name'] for a in inputs if 'required' in a}=={'name','email','phone'})
check('Every input has label, autocomplete and described error',all(any(x.get('for')==a['id'] for x in labels) and a.get('autocomplete') and a.get('aria-describedby') in ids for a in inputs))
check('Button fails closed without JavaScript',any(t=='button' and a.get('id')=='lead-submit' and 'disabled' in a for t,a in tags))
check('Local adapter matches expected activation state and stays same-origin', ('export const integrationReady = '+str(ready).lower()) in adapter and "submissionUrl = '/api/eixo-lead'" in adapter and "mode: 'same-origin'" in adapter)
check('No iframe, Netlify Forms, remote scripts, browser storage or analytics',not any(t=='iframe' or (t=='script' and a.get('src','').startswith('http')) or 'data-netlify' in a or 'netlify' in a for t,a in tags) and not re.search(r'localStorage|sessionStorage|sendBeacon',js+adapter))
check('CSP allows only the approved connection scope and blocks native posts',"script-src 'self'" in headers and ("connect-src 'self'" if ready else "connect-src 'none'") in headers and "form-action 'none'" in headers and "unsafe-inline" not in headers)
check('Visible focus, reduced motion and mobile rules',all(x in css for x in [':focus-visible','prefers-reduced-motion:reduce','max-width:480px','max-width:780px']))
check('ARIA loading and live/error feedback exist','aria-busy' in js and any(a.get('role')=='status' for t,a in tags) and any(a.get('role')=='alert' for t,a in tags))
check('Submission guarded against duplicate/pending/uncertain state','if (busy || completed || uncertain) return' in js and 'response?.confirmed !== true' in js)
check('Review noindex stays in all three locations','noindex, nofollow' in html and 'X-Robots-Tag: noindex, nofollow' in headers and 'Disallow: /' in (site/'robots.txt').read_text(encoding='utf-8'))
wa=next(a['href'] for a in links if 'data-whatsapp' in a); parsed=urlsplit(wa)
check('Verified WhatsApp alternative preserved',parsed.netloc=='wa.me' and parsed.path=='/5594991636639' and parse_qs(parsed.query)['text']==['Olá, Fabio! Quero conhecer o Eixo Web para minha oficina.'])
check('Fallback to original CRM form preserved',any(a.get('href')=='https://chat.slsistemas.com.br/f/bbba0fbf-ff08-4f3d-9df7-56856c8a9a12' for a in links))
check('Data destination disclosure includes Netlify and actual CRM API','Netlify' in html and 'chatapi.slsistemas.com.br' in html and 'não salva o conteúdo dos campos no navegador' in html)
check('Function directory configured but live sending still requires explicit server flag', 'directory = "netlify/functions"' in (root/'netlify.toml').read_text(encoding='utf-8') and "env.EIXO_LEADS_ENABLED !== 'true'" in (root/'netlify/functions/eixo-lead.mjs').read_text(encoding='utf-8'))
report = {
 'checkedAtUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'expectedSourceMode': 'active' if ready else 'inactive',
 'checks': checks,
 'checksPassed': sum(check['passed'] for check in checks),
 'checksTotal': len(checks),
 'passed': all(check['passed'] for check in checks),
 'scope': 'Static source checks only. No browser, network, CRM submission or deployment is performed.'
}
print(json.dumps(report, ensure_ascii=False, indent=2))
if not report['passed']:
 sys.exit(1)
