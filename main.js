'use strict';

const DEFAULT_CONFIG = {
  productionHostPatterns: ['prod', 'production', 'live'],
  developmentNamePatterns: ['dev', 'local', 'test', 'sandbox'],
  allowedHosts: [],
  maxDuplicateReports: 50,
  maxUrlReports: 100,
};

const AUTH_QUERY_KEYS = new Set(['access_token', 'api_key', 'apikey', 'key', 'token', 'auth', 'authorization', 'client_secret', 'secret', 'password', 'signature', 'sig']);
const SECRET_PATTERNS = [
  { name: 'OpenAI-style key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g },
  { name: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'Private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'Generic secret assignment', pattern: /\b(?:api[_-]?key|access[_-]?token|secret|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9_\-.]{24,}["']?/gi },
];

function normalizeConfig(input) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, input || {});
  for (const key of ['productionHostPatterns', 'developmentNamePatterns', 'allowedHosts']) {
    cfg[key] = Array.isArray(cfg[key]) ? cfg[key].map(String) : DEFAULT_CONFIG[key].slice();
  }
  return cfg;
}

function safeString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function parseExport(raw) {
  const text = safeString(raw);
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

function walk(value, visit, path = '$') {
  if (value == null) return;
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, visit, `${path}[${i}]`));
  } else if (typeof value === 'object') {
    Object.keys(value).forEach(k => walk(value[k], visit, `${path}.${k}`));
  }
}

function isRequestLike(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (typeof obj.url === 'string' && (typeof obj.method === 'string' || obj._type === 'request')) return true;
  return false;
}

function extractBodyText(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (typeof body === 'object') {
    if (typeof body.text === 'string') return body.text;
    if (typeof body.body === 'string') return body.body;
    if (typeof body.value === 'string') return body.value;
  }
  return safeString(body);
}

function isEnvironmentLike(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const t = String(obj._type || obj.type || '').toLowerCase();
  return t.includes('environment') || (obj.data && typeof obj.data === 'object' && typeof obj.name === 'string');
}

function collectResources(parsed) {
  const requests = [];
  const environments = [];
  const named = [];
  walk(parsed, (obj, path) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    if (typeof obj.name === 'string') named.push({ obj, path, name: obj.name });
    if (isRequestLike(obj)) requests.push({ obj, path });
    if (isEnvironmentLike(obj)) environments.push({ obj, path });
  });
  return { requests, environments, named };
}

function parseUrl(rawUrl) {
  try { return new URL(rawUrl); } catch { return null; }
}

function hostAllowed(host, cfg) {
  const h = String(host || '').toLowerCase();
  return cfg.allowedHosts.some(a => h === a.toLowerCase() || h.endsWith('.' + a.toLowerCase()));
}

function isProductionHost(host, cfg) {
  const h = String(host || '').toLowerCase();
  if (!h || hostAllowed(h, cfg)) return false;
  return cfg.productionHostPatterns.some(p => {
    const x = String(p).toLowerCase();
    return x && (h.includes(x) || new RegExp(`(^|[-.])${escapeRegExp(x)}($|[-.])`).test(h));
  });
}

function looksDevelopmentName(name, cfg) {
  const n = String(name || '').toLowerCase();
  return cfg.developmentNamePatterns.some(p => n.includes(String(p).toLowerCase()));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redact(value) {
  const s = safeString(value);
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function redactText(text) {
  let out = safeString(text);
  for (const rule of SECRET_PATTERNS) {
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, match => redact(match));
  }
  out = out.replace(/([?&](?:access_token|api_key|apikey|key|token|auth|authorization|client_secret|secret|password|signature|sig)=)[^&#\s]+/gi, (_, p) => `${p}${redact('redacted-value')}`);
  return out;
}

function remediationFor(type) {
  return {
    secret: 'Move secrets into private environment values or a vault; never store them in request URLs or exported docs.',
    'query-auth': 'Move auth material from query string to Authorization headers or private environment variables.',
    'prod-mutation': 'Add a safer non-production environment, or rename/duplicate this request for explicit production use.',
    'env-name-mismatch': 'Check the selected environment and base URL; dev/test requests should not target production hosts.',
    'duplicate-name': 'Rename duplicates so search and team handoff are unambiguous.',
    'duplicate-route': 'Merge duplicate requests or make their purpose explicit in names/descriptions.',
    'invalid-url': 'Fix malformed URL or replace host/path with a valid environment variable expression.',
    'missing-url': 'Add a URL or archive placeholder requests.',
    'empty-body': 'Add a request body, or document why the mutation intentionally has no body.',
    'environment-missing-base-url': 'Add base_url/api_url/host so environment intent is visible.',
    'missing-description': 'Add a description before using risky destructive requests.',
    'many-hosts': 'Group hosts into environments or split unrelated APIs into separate workspaces.',
  }[type] || 'Review and clean this workspace item.';
}

function add(findings, severity, type, location, message, preview) {
  findings.push({ severity, type, location, message, preview: redactText(preview || ''), remediation: remediationFor(type) });
}

function findSecrets(text, location, findings) {
  const input = safeString(text);
  for (const rule of SECRET_PATTERNS) {
    rule.pattern.lastIndex = 0;
    let m;
    while ((m = rule.pattern.exec(input)) !== null) {
      const nextIndex = rule.pattern.lastIndex;
      add(findings, 'high', 'secret', location, `${rule.name} appears in workspace export`, m[0]);
      rule.pattern.lastIndex = nextIndex;
      if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex += 1;
    }
  }
}

function lintWorkspace(rawExport, config) {
  const cfg = normalizeConfig(config);
  const parsed = parseExport(rawExport);
  const { requests, environments, named } = collectResources(parsed);
  const findings = [];
  const nameCounts = new Map();
  const methodPathCounts = new Map();
  const baseHosts = new Map();

  findSecrets(rawExport, 'workspace-export', findings);

  for (const item of named) {
    const clean = item.name.trim().toLowerCase();
    if (!clean) add(findings, 'low', 'empty-name', item.path, 'Empty request/folder/environment name', item.name);
    if (clean) nameCounts.set(clean, (nameCounts.get(clean) || 0) + 1);
  }

  for (const { obj, path } of requests) {
    const name = safeString(obj.name || '(unnamed request)');
    const method = safeString(obj.method || 'GET').toUpperCase();
    const rawUrl = safeString(obj.url || '');
    const urlObj = parseUrl(rawUrl);
    if (!rawUrl) add(findings, 'medium', 'missing-url', path, 'Request has no URL', name);
    if (rawUrl && !urlObj) add(findings, 'medium', 'invalid-url', path, 'Request URL is not parseable', `${name}: ${rawUrl}`);
    if (urlObj) {
      const route = `${method} ${urlObj.hostname}${urlObj.pathname}`.toLowerCase();
      methodPathCounts.set(route, (methodPathCounts.get(route) || 0) + 1);
      baseHosts.set(urlObj.hostname, (baseHosts.get(urlObj.hostname) || 0) + 1);
      for (const [key, value] of urlObj.searchParams.entries()) {
        if (AUTH_QUERY_KEYS.has(key.toLowerCase())) add(findings, 'high', 'query-auth', `${path}.url`, 'Auth-like value in query string', `${key}=${value}`);
      }
      if (isProductionHost(urlObj.hostname, cfg) && ['DELETE', 'PATCH', 'PUT'].includes(method)) {
        add(findings, 'high', 'prod-mutation', path, 'Destructive method targets production-like host', `${method} ${urlObj.hostname}${urlObj.pathname}`);
      }
      if (looksDevelopmentName(name, cfg) && isProductionHost(urlObj.hostname, cfg)) {
        add(findings, 'medium', 'env-name-mismatch', path, 'Development-looking request name points at production-like host', `${name}: ${rawUrl}`);
      }
    }
    const body = extractBodyText(obj.body);
    if (['POST', 'PUT', 'PATCH'].includes(method) && !body.trim()) add(findings, 'low', 'empty-body', path, `${method} request has empty body`, name);
    if (!safeString(obj.description || obj.metaSortKey || '').trim() && /^delete|remove|purge|destroy/i.test(name)) {
      add(findings, 'low', 'missing-description', path, 'Risky-sounding request has no description', name);
    }
  }

  for (const { obj, path } of environments) {
    const name = safeString(obj.name || 'environment');
    const text = safeString(obj.data || obj);
    findSecrets(text, `${path}.environment`, findings);
    const keys = Object.keys(obj.data || {}).map(k => k.toLowerCase());
    const urlKeys = keys.filter(k => k.includes('url') || k.includes('host') || k.includes('base'));
    if (!urlKeys.length) add(findings, 'low', 'environment-missing-base-url', path, 'Environment has no obvious base URL/host key', name);
  }

  for (const [name, count] of nameCounts) {
    if (count > 1) add(findings, 'low', 'duplicate-name', 'workspace.name', 'Duplicate request/folder/environment name', `${name} (${count})`);
  }
  for (const [route, count] of methodPathCounts) {
    if (count > 1) add(findings, 'medium', 'duplicate-route', 'workspace.requests', 'Duplicate method+host+path route', `${route} (${count})`);
  }
  if (baseHosts.size > 8) add(findings, 'low', 'many-hosts', 'workspace.urls', 'Workspace uses many distinct hosts; consider grouping or environment variables', `${baseHosts.size} hosts`);

  return findings.slice(0, 500);
}

function summarize(findings) {
  return findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; }, { high: 0, medium: 0, low: 0 });
}

function qualityScore(findings) {
  const counts = summarize(findings);
  return Math.max(0, 100 - counts.high * 25 - counts.medium * 10 - counts.low * 3);
}

function makeMarkdown(findings) {
  const counts = summarize(findings);
  const score = qualityScore(findings);
  const rows = findings.map(f => `| ${f.severity} | ${f.type} | ${f.location} | ${f.message} | ${String(f.preview).replace(/\|/g, '\\|')} | ${String(f.remediation || remediationFor(f.type)).replace(/\|/g, '\\|')} |`).join('\n');
  return `# Insomnia Collection Linter Report\n\nGenerated: ${new Date().toISOString()}\n\nLocal-only report. Secrets are redacted.\n\n## Summary\n\n- Quality score: ${score}/100\n- High: ${counts.high}\n- Medium: ${counts.medium}\n- Low: ${counts.low}\n\n## Findings\n\n| Severity | Type | Location | Message | Preview | Fix |\n|---|---|---|---|---|---|\n${rows || '| low | none | workspace | No collection hygiene issues detected. |  | No action needed. |'}\n`;
}

async function getWritableExportPath(context, fileName) {
  const path = require('path');
  const candidates = [];
  if (context.app && typeof context.app.getPath === 'function') {
    for (const key of ['documents', 'desktop', 'downloads', 'userData', 'home']) {
      try {
        const value = await context.app.getPath(key);
        if (value) candidates.push(value);
      } catch {}
    }
  }
  candidates.push(process.env.HOME || process.env.USERPROFILE || process.cwd());
  return path.join(candidates.find(Boolean) || '.', fileName);
}

const action = {
  label: 'Collection Linter: Export Report',
  icon: 'fa-list-check',
  action: async (context) => {
    const raw = await context.data.export.insomnia({ includePrivate: false, format: 'json' });
    const findings = lintWorkspace(raw);
    const report = makeMarkdown(findings);
    const fs = require('fs');
    let output = null;
    if (context.app && typeof context.app.showSaveDialog === 'function') {
      output = await context.app.showSaveDialog({ defaultPath: 'insomnia-collection-lint.md' });
    }
    if (!output) output = await getWritableExportPath(context, 'insomnia-collection-lint.md');
    fs.writeFileSync(output, report, 'utf8');
    if (context.app && typeof context.app.alert === 'function') await context.app.alert('Collection Linter report exported', output);
  }
};

module.exports.workspaceActions = [action];
module.exports.requestGroupActions = [action];
module.exports.requestActions = [action];

module.exports.__test = {
  AUTH_QUERY_KEYS,
  DEFAULT_CONFIG,
  SECRET_PATTERNS,
  collectResources,
  getWritableExportPath,
  isProductionHost,
  lintWorkspace,
  makeMarkdown,
  qualityScore,
  remediationFor,
  normalizeConfig,
  parseExport,
  redactText,
  summarize,
};
