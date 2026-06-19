'use strict';

/**
 * Cloudflare DNS lookup for domain monitoring (API token stored in settings).
 */

const settingsRepository = require('../repositories/settingsRepository');
const credentialCrypto = require('./credentialCrypto');

const KEY_TOKEN = 'cloudflare_api_token';
const KEY_ZONE = 'cloudflare_zone_id';

let defaultZoneCache = null;

function maskToken(token) {
  if (!token || token.length < 8) return '••••••••';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function readToken() {
  const raw = settingsRepository.get(KEY_TOKEN);
  if (!raw) return null;
  try {
    return credentialCrypto.isEncrypted(raw) ? credentialCrypto.decrypt(raw) : raw;
  } catch (err) {
    throw new Error(`Failed to decrypt Cloudflare token: ${err.message}`);
  }
}

function getPublicConfig() {
  const raw = settingsRepository.get(KEY_TOKEN);
  let configured = false;
  let preview = '';
  if (raw) {
    configured = true;
    try {
      const plain = credentialCrypto.isEncrypted(raw) ? credentialCrypto.decrypt(raw) : raw;
      preview = maskToken(plain);
    } catch (_) {
      preview = 'encrypted (decrypt error)';
    }
  }
  return {
    configured,
    tokenPreview: preview,
    zoneId: settingsRepository.get(KEY_ZONE) || '',
  };
}

function saveConfig({ apiToken, zoneId }) {
  const token = String(apiToken || '').trim();
  if (token) {
    settingsRepository.set(KEY_TOKEN, credentialCrypto.encrypt(token));
    defaultZoneCache = null;
  }
  if (zoneId !== undefined) {
    settingsRepository.set(KEY_ZONE, String(zoneId || '').trim());
    defaultZoneCache = null;
  }
}

function isConfigured() {
  return !!settingsRepository.get(KEY_TOKEN);
}

async function cfRequest(path, options = {}) {
  const token = readToken();
  if (!token) {
    return { ok: false, error: 'Cloudflare API token not configured. Add it in Settings.' };
  }

  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  let body;
  try {
    body = await res.json();
  } catch (_) {
    return { ok: false, error: `Cloudflare HTTP ${res.status}` };
  }

  if (!body.success) {
    const msg = (body.errors && body.errors[0] && body.errors[0].message)
      || (body.messages && body.messages[0] && body.messages[0].message)
      || 'Cloudflare API request failed';
    return { ok: false, error: msg };
  }

  return { ok: true, result: body.result, resultInfo: body.result_info };
}

async function getDefaultZone() {
  const zoneId = settingsRepository.get(KEY_ZONE);
  if (!zoneId) return null;
  if (defaultZoneCache && defaultZoneCache.id === zoneId) return defaultZoneCache;

  const res = await cfRequest(`/zones/${encodeURIComponent(zoneId)}`);
  if (!res.ok) return null;
  defaultZoneCache = res.result;
  return defaultZoneCache;
}

async function findZone(domain) {
  const def = await getDefaultZone();
  if (def && (domain === def.name || domain.endsWith(`.${def.name}`))) {
    return { ok: true, zone: def };
  }

  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i += 1) {
    const candidate = parts.slice(i).join('.');
    const res = await cfRequest(
      `/zones?name=${encodeURIComponent(candidate)}&status=active&per_page=1`
    );
    if (res.ok && Array.isArray(res.result) && res.result.length) {
      return { ok: true, zone: res.result[0] };
    }
  }

  if (def) return { ok: true, zone: def };
  return { ok: false, error: `No Cloudflare zone found for ${domain}` };
}

async function fetchRecords(zoneId, name) {
  const res = await cfRequest(
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}&per_page=50`
  );
  if (!res.ok) return [];
  return (res.result || []).filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type));
}

async function getDomainDns(domain) {
  if (!isConfigured()) {
    return { ok: false, configured: false, records: [], note: null };
  }

  try {
    const zoneRes = await findZone(domain);
    if (!zoneRes.ok) {
      return {
        ok: false,
        configured: true,
        records: [],
        note: buildNote([], null, domain, zoneRes.error),
      };
    }

    const zone = zoneRes.zone;
    const names = new Set([domain, `www.${domain}`]);
    const records = [];
    const seen = new Set();

    for (const name of names) {
      const rows = await fetchRecords(zone.id, name);
      for (const rec of rows) {
        const key = `${rec.type}:${rec.name}:${rec.content}`;
        if (seen.has(key)) continue;
        seen.add(key);
        records.push({
          type: rec.type,
          name: rec.name,
          content: rec.content,
          proxied: !!rec.proxied,
          ttl: rec.ttl,
        });
      }
    }

    return {
      ok: true,
      configured: true,
      zoneId: zone.id,
      zoneName: zone.name,
      records,
      note: null,
    };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      records: [],
      note: buildNote([], null, domain, err.message),
    };
  }
}

function normalizeIp(ip) {
  return String(ip || '').trim().toLowerCase();
}

function buildNote(records, serverIp, domain, error) {
  if (error) {
    return { status: 'error', text: error };
  }
  if (!records || !records.length) {
    return {
      status: 'missing',
      text: 'No A/CNAME record in Cloudflare — DNS may be elsewhere or not configured.',
    };
  }

  const server = normalizeIp(serverIp);
  const lines = records.map((r) => {
    const proxy = r.proxied ? ' (proxied)' : '';
    return `${r.type} ${r.name} → ${r.content}${proxy}`;
  });

  const aRecords = records.filter((r) => r.type === 'A');
  const aaaaRecords = records.filter((r) => r.type === 'AAAA');
  const cnames = records.filter((r) => r.type === 'CNAME');

  if (aRecords.length && server) {
    const matching = aRecords.filter((r) => normalizeIp(r.content) === server);
    const proxiedOnly = aRecords.every((r) => r.proxied);
    if (matching.length === aRecords.length) {
      return {
        status: 'ok',
        text: `DNS points to this server (${server}).`,
        lines,
      };
    }
    if (matching.length === 0 && !proxiedOnly) {
      const targets = [...new Set(aRecords.map((r) => r.content))].join(', ');
      return {
        status: 'moved',
        text: `A record → ${targets}, not this server (${server}). Domain likely moved or parked elsewhere.`,
        lines,
      };
    }
    if (proxiedOnly) {
      return {
        status: 'proxied',
        text: `Cloudflare proxied (orange cloud). Origin in CF: ${aRecords.map((r) => r.content).join(', ')}. Compare with server ${server}.`,
        lines,
      };
    }
    return {
      status: 'mixed',
      text: `Mixed A records — some match this server (${server}), some do not.`,
      lines,
    };
  }

  if (cnames.length && !aRecords.length) {
    const targets = [...new Set(cnames.map((r) => r.content))].join(', ');
    const onServer = server && cnames.some((r) => r.content.includes(server));
    return {
      status: onServer ? 'ok' : 'cname',
      text: onServer
        ? `CNAME → ${targets} (may resolve to this server).`
        : `CNAME → ${targets}. Check if target still points to this server (${server || 'unknown'}).`,
      lines,
    };
  }

  if (aaaaRecords.length && server) {
    return {
      status: 'ipv6',
      text: `AAAA records present. IPv6 comparison skipped; server IPv4 is ${server}.`,
      lines,
    };
  }

  return {
    status: 'info',
    text: 'DNS records found — review targets below.',
    lines,
  };
}

async function enrichSites(sites, serverIp) {
  if (!isConfigured() || !sites || !sites.length) {
    return sites.map((s) => ({
      ...s,
      dns: { configured: isConfigured(), records: [], note: isConfigured() ? null : { status: 'off', text: 'Add Cloudflare token in Settings.' } },
    }));
  }

  const out = [];
  for (const site of sites) {
    const dns = await getDomainDns(site.domain);
    const note = dns.note || buildNote(dns.records, serverIp, site.domain, dns.ok ? null : dns.error);
    out.push({
      ...site,
      dns: {
        configured: true,
        zoneId: dns.zoneId || null,
        zoneName: dns.zoneName || null,
        records: dns.records || [],
        note,
      },
    });
  }
  return out;
}

async function testConnection() {
  if (!isConfigured()) {
    return { ok: false, error: 'API token is empty. Save a token first.' };
  }

  const res = await cfRequest('/user/tokens/verify');
  if (!res.ok) return res;

  const zoneId = settingsRepository.get(KEY_ZONE);
  let zone = null;
  if (zoneId) {
    const zr = await cfRequest(`/zones/${encodeURIComponent(zoneId)}`);
    if (zr.ok) zone = { id: zr.result.id, name: zr.result.name };
  }

  return {
    ok: true,
    message: 'Cloudflare connection OK.',
    status: res.result && res.result.status,
    zone,
  };
}

module.exports = {
  getPublicConfig,
  saveConfig,
  isConfigured,
  getDomainDns,
  buildNote,
  enrichSites,
  testConnection,
};
