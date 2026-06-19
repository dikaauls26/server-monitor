'use strict';

/**
 * CyberPanel domain list, HTTP status check, and delete via official CLI.
 */

const os = require('os');
const { run } = require('./execHelper');
const { remoteBash } = require('./shellScript');

const isLinux = os.platform() === 'linux';
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** One SSH/local round-trip: list CyberPanel sites + optional HTTP probe. */
const LIST_SCRIPT = remoteBash(`
CHECK_HTTP="\${CHECK_HTTP:-1}"
if ! command -v cyberpanel >/dev/null 2>&1; then
  python3 -c "import json; print(json.dumps({'available':False,'error':'CyberPanel CLI not found on this server.','sites':[]}))"
  exit 0
fi

python3 << 'PY'
import json, subprocess, os, sys

check_http = os.environ.get('CHECK_HTTP', '1') == '1'

def sh(cmd, timeout=30):
    try:
        r = subprocess.run(cmd, shell=True, text=True, capture_output=True, timeout=timeout)
        return (r.stdout or '').strip()
    except Exception:
        return ''

sites = []
seen = set()

raw = sh('cyberpanel listWebsitesJson 2>/dev/null', 45)
if raw:
    try:
        data = json.loads(raw)
        if isinstance(data, str):
            data = json.loads(data)
        if isinstance(data, dict):
            data = data.get('data') or data.get('websites') or [data]
        if not isinstance(data, list):
            data = []
        for w in data:
            if isinstance(w, str):
                d, wobj = w, {}
            else:
                wobj = w
                d = wobj.get('domain') or wobj.get('domainName') or ''
            if d and d not in seen:
                seen.add(d)
                sites.append({'domain': d, 'type': 'primary', 'master': None})
            master = d
            for key in ('childDomains', 'children', 'childdomains'):
                for c in (wobj.get(key) or []):
                    cd = c if isinstance(c, str) else (c.get('domain') if isinstance(c, dict) else None)
                    if cd and cd not in seen:
                        seen.add(cd)
                        sites.append({'domain': cd, 'type': 'child', 'master': master})
    except Exception:
        pass

pw_file = '/etc/cyberpanel/mysqlPassword'
if os.path.isfile(pw_file):
    db_pass = open(pw_file, encoding='utf-8', errors='replace').read().strip()
    if db_pass:
        def mysql_q(sql):
            try:
                r = subprocess.run(
                    ['mysql', '-u', 'root', '-p' + db_pass, 'cyberpanel', '-N', '-e', sql],
                    text=True, capture_output=True, timeout=20
                )
                return (r.stdout or '').strip()
            except Exception:
                return ''
        for line in mysql_q('SELECT domain FROM websiteFunctions_childdomains').splitlines():
            cd = line.strip()
            if cd and cd not in seen:
                seen.add(cd)
                sites.append({'domain': cd, 'type': 'child', 'master': None})
        for line in mysql_q('SELECT domain FROM websiteFunctions_websites').splitlines():
            d = line.strip()
            if d and d not in seen:
                seen.add(d)
                sites.append({'domain': d, 'type': 'primary', 'master': None})

def probe(domain):
    code = '000'
    proto = None
    err = None
    for p in ('https', 'http'):
        try:
            r = subprocess.run(
                ['curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '-L', '--max-time', '10', '-k', p + '://' + domain + '/'],
                text=True, capture_output=True, timeout=12
            )
            c = (r.stdout or '').strip()
            if c and c != '000':
                code = c
                proto = p
                break
        except Exception as ex:
            err = str(ex)[:120]
    status = 'down'
    if code == '404':
        status = '404'
    elif code and code[0] in '23':
        status = 'active'
    elif code and code != '000':
        status = 'other'
    return {'httpCode': code, 'protocol': proto, 'status': status, 'error': err}

out = []
for s in sites:
    row = dict(s)
    if check_http:
        row.update(probe(s['domain']))
    else:
        row.update({'httpCode': None, 'protocol': None, 'status': 'unknown', 'error': None})
    out.append(row)

print(json.dumps({'available': True, 'sites': out, 'total': len(out)}))
PY
`);

const DELETE_SCRIPT = (domain, type) => remoteBash(`
python3 << 'PY'
import json, subprocess, os, shlex

domain = ${JSON.stringify(domain)}
dtype = ${JSON.stringify(type)}

def sh(cmd, timeout=120):
    try:
        r = subprocess.run(cmd, shell=True, text=True, capture_output=True, timeout=timeout)
        return (r.stdout or '') + (r.stderr or '')
    except Exception as e:
        return str(e)

if not os.path.isfile('/usr/bin/cyberpanel') and not os.path.isfile('/usr/local/bin/cyberpanel'):
    import shutil
    if not shutil.which('cyberpanel'):
        print(json.dumps({'ok': False, 'error': 'CyberPanel CLI not found'}))
        raise SystemExit(0)

q = shlex.quote(domain)
if dtype == 'child':
    out = sh('sudo -n cyberpanel deleteChild --childDomain ' + q + ' 2>&1 || cyberpanel deleteChild --childDomain ' + q + ' 2>&1')
else:
    out = sh('sudo -n cyberpanel deleteWebsite --domainName ' + q + ' 2>&1 || cyberpanel deleteWebsite --domainName ' + q + ' 2>&1')

acme = '/root/.acme.sh/' + domain
if os.path.isdir(acme):
    subprocess.run(['rm', '-rf', acme], check=False)

verify = sh('cyberpanel listWebsitesJson 2>/dev/null', 45)
still = domain in verify

if still:
    print(json.dumps({'ok': False, 'error': 'Domain still listed in CyberPanel after delete', 'output': out[-600:]}))
else:
    print(json.dumps({'ok': True, 'message': 'Domain removed via CyberPanel (vhost, SSL, mail records)', 'output': out[-600:]}))
PY
`);

function assertDomain(domain) {
  const d = String(domain || '').trim().toLowerCase();
  if (!DOMAIN_RE.test(d)) {
    throw new Error('Invalid domain name.');
  }
  return d;
}

function parseListOutput(stdout) {
  const raw = (stdout || '').trim();
  if (!raw) {
    return { available: false, error: 'Empty response from server.', sites: [], total: 0 };
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) {
    return { available: false, error: raw.slice(0, 200), sites: [], total: 0 };
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    return { available: false, error: 'Failed to parse domain list.', sites: [], total: 0 };
  }
}

function parseDeleteOutput(stdout) {
  const raw = (stdout || '').trim();
  const start = raw.lastIndexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch (err) {
      /* fall through */
    }
  }
  if (/success["\s]*:\s*1/.test(raw)) {
    return { ok: true, message: 'Domain removed via CyberPanel.', output: raw.slice(-500) };
  }
  return { ok: false, error: raw.slice(-400) || 'Delete failed.' };
}

function summarize(sites) {
  const list = sites || [];
  return {
    total: list.length,
    active: list.filter((s) => s.status === 'active').length,
    notFound: list.filter((s) => s.status === '404').length,
    down: list.filter((s) => s.status === 'down').length,
    other: list.filter((s) => s.status === 'other').length,
  };
}

async function listLocal({ checkHttp = true } = {}) {
  if (!isLinux) {
    return {
      ok: true,
      data: {
        available: false,
        error: 'Domain monitoring requires Linux with CyberPanel.',
        sites: [],
        summary: summarize([]),
        timestamp: Date.now(),
      },
    };
  }

  const cmd = checkHttp
    ? `CHECK_HTTP=1 ${LIST_SCRIPT}`
    : `CHECK_HTTP=0 ${LIST_SCRIPT}`;

  const res = await run(cmd, { timeout: checkHttp ? 180000 : 90000 });
  const parsed = parseListOutput(res.stdout || res.stderr);
  return {
    ok: true,
    data: {
      ...parsed,
      summary: summarize(parsed.sites),
      timestamp: Date.now(),
      checkHttp,
    },
  };
}

async function deleteLocal(domain, type) {
  const d = assertDomain(domain);
  const dtype = type === 'child' ? 'child' : 'primary';

  const before = await listLocal({ checkHttp: false });
  const sites = before.data && before.data.sites ? before.data.sites : [];
  const found = sites.find((s) => s.domain === d);
  if (!found) {
    return { ok: false, error: `Domain "${d}" is not in CyberPanel.` };
  }

  const useType = dtype === 'child' || found.type === 'child' ? 'child' : 'primary';
  const res = await run(DELETE_SCRIPT(d, useType), { timeout: 180000 });
  const result = parseDeleteOutput(res.stdout || res.stderr);
  return result;
}

module.exports = {
  assertDomain,
  parseListOutput,
  parseDeleteOutput,
  summarize,
  listLocal,
  deleteLocal,
  LIST_SCRIPT,
  DELETE_SCRIPT,
};
