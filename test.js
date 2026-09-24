'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const plugin = require('./main');
const t = plugin.__test;
const fakeKey = 'sk-' + 'a'.repeat(30);
const fakeGithub = 'ghp_' + 'b'.repeat(30);

const workspace = JSON.stringify({
  resources: [
    { _type: 'request', name: 'Dev delete user', method: 'DELETE', url: 'https://api.production.example.com/users/42', body: { text: '' } },
    { _type: 'request', name: 'Get users', method: 'GET', url: 'https://api.example.com/users?api_key=' + fakeKey },
    { _type: 'request', name: 'Get users', method: 'GET', url: 'https://api.example.com/users?api_key=' + fakeKey },
    { _type: 'request', name: 'Broken', method: 'POST', url: 'https://{{ base_url }}/broken', body: { text: '{"tenant":"{{ tenant_id }}"}' } },
    { _type: 'request', name: '   ', method: 'GET', url: 'https://api.example.com/blank-name' },
    { _type: 'environment', name: 'Dev', data: { client_secret: fakeGithub, other: 'value' } },
    { _type: 'environment', name: 'Tiny', data: { region: 'us' } }
  ]
});

function makeContext(outputPath, raw = workspace) {
  const alerts = [];
  return {
    alerts,
    data: { export: { insomnia: async () => raw } },
    app: {
      showSaveDialog: async () => outputPath,
      getPath: async key => key === 'documents' ? os.tmpdir() : '',
      alert: async (title, msg) => alerts.push({ title, msg }),
    },
  };
}

async function main() {
  assert(Array.isArray(plugin.workspaceActions), 'workspaceActions exported');
  assert(Array.isArray(plugin.requestGroupActions), 'requestGroupActions exported');
  assert(Array.isArray(plugin.requestActions), 'requestActions exported');
  assert.strictEqual(plugin.workspaceActions[0].label, 'Collection Linter: Export Report');

  const parsed = t.parseExport(workspace);
  const resources = t.collectResources(parsed);
  assert.strictEqual(resources.requests.length, 5, 'collects requests');
  assert.strictEqual(resources.environments.length, 2, 'collects environments');
  assert(t.isProductionHost('api.production.example.com', t.normalizeConfig({})), 'detects prod host');
  assert(!t.isProductionHost('api.example.com', t.normalizeConfig({})), 'non-prod host clean');

  assert(!t.isProductionHost('api.product.example.com', t.normalizeConfig({})), 'product should not match prod');
  assert(!t.isProductionHost('livereload.example.com', t.normalizeConfig({})), 'livereload should not match live');
  assert(t.isProductionHost('api-prod.example.com', t.normalizeConfig({})), 'hyphenated prod host still matches');

  const findings = t.lintWorkspace(workspace);
  const types = new Set(findings.map(f => f.type));
  for (const expected of ['secret', 'query-auth', 'prod-mutation', 'env-name-mismatch', 'duplicate-name', 'duplicate-route', 'unresolved-template', 'empty-name', 'environment-missing-base-url']) {
    assert(types.has(expected), `has ${expected}`);
  }
  const report = t.makeMarkdown(findings);
  assert(report.includes('# Insomnia Collection Linter Report'), 'report title');
  assert(report.includes('Quality score:'), 'report has quality score');
  assert(report.includes('## Fix Priority'), 'report has fix priority section');
  assert(report.includes('1. [high] Move auth material from query string'), 'fix priority lists highest-impact action first');
  assert(report.includes('| Severity | Type | Location | Message | Preview | Fix |'), 'report table');
  assert(t.qualityScore(findings) < 100, 'score penalizes findings');
  assert(t.remediationFor('query-auth').includes('Authorization'), 'remediation exists');
  assert(t.remediationFor('unresolved-template').includes('environment variable'), 'unresolved templates have specific remediation');
  assert(t.remediationFor('empty-name').includes('descriptive'), 'empty names have specific remediation');
  const priorityTypes = t.fixPriority(findings, 20).map(f => f.type);
  assert(priorityTypes.indexOf('unresolved-template') > -1, 'unresolved template is prioritized');
  assert(priorityTypes.indexOf('empty-name') > -1, 'empty-name is prioritized');
  assert(priorityTypes.indexOf('unresolved-template') < priorityTypes.indexOf('empty-name'), 'template fixes rank before empty-name cleanup');
  assert(!report.includes(fakeKey), 'redacts fake key');
  assert(!report.includes(fakeGithub), 'redacts fake github token');

  const tableReport = t.makeMarkdown([{ severity: 'low|risk', type: 'pipe|type', location: 'loc|x', message: 'message|x', preview: 'first|line\nsecond', remediation: 'fix|x' }]);
  assert(tableReport.includes('| low\\|risk | pipe\\|type | loc\\|x | message\\|x | first\\|line<br>second | fix\\|x |'), 'escapes markdown table cells');



  const emptyRaw = JSON.stringify({ resources: [] });
  const fallbackRequest = {
    getName: () => 'Dev delete user',
    getMethod: () => 'DELETE',
    getUrl: () => 'https://api.production.example.com/users/42?api_key=' + fakeKey,
    getBody: () => ({ text: '' }),
  };
  const built = t.buildActionExport(emptyRaw, { request: fallbackRequest }, {});
  assert.strictEqual(built.usedFallback, true, 'uses current-request fallback when export has no requests');
  const fallbackFindings = t.lintWorkspace(built.raw, { diagnostics: built.diagnostics });
  const fallbackTypes = new Set(fallbackFindings.map(f => f.type));
  assert(fallbackTypes.has('export-scope-empty'), 'reports empty export diagnostic');
  assert(fallbackFindings.find(f => f.type === 'export-scope-empty').message.includes('current-request fallback'), 'fallback wording clear');
  assert(fallbackTypes.has('query-auth'), 'fallback catches query auth');
  assert(fallbackTypes.has('prod-mutation'), 'fallback catches prod mutation');
  assert(t.currentRequestFromContext({ request: fallbackRequest }).url.includes('production'), 'reads current request context');

  const noIssues = t.lintWorkspace(JSON.stringify({ resources: [{ _type: 'request', name: 'Health', method: 'GET', url: 'https://api.example.com/health' }, { _type: 'environment', name: 'Env', data: { base_url: 'https://api.example.com' } }] }));
  assert.strictEqual(t.summarize(noIssues).high, 0, 'clean high count');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-linter-'));
  try {
    for (const [name, action] of [['workspace', plugin.workspaceActions[0]], ['group', plugin.requestGroupActions[0]], ['request', plugin.requestActions[0]]]) {
      const out = path.join(tmp, `${name}.md`);
      const ctx = makeContext(out);
      await action.action(ctx);
      assert(fs.existsSync(out), `${name} report written`);
      assert(fs.readFileSync(out, 'utf8').includes('Insomnia Collection Linter Report'), `${name} report valid`);
      assert.strictEqual(ctx.alerts.length, 1, `${name} alert shown`);
    }
    const objectOut = path.join(tmp, 'object-dialog.md');
    const objectCtx = makeContext({ filePath: objectOut, canceled: false });
    await plugin.workspaceActions[0].action(objectCtx);
    assert(fs.existsSync(objectOut), 'object save dialog report written');

    const fallbackCtx = makeContext(null);
    await plugin.requestActions[0].action(fallbackCtx);
    assert(fallbackCtx.alerts[0].msg.includes('insomnia-collection-lint.md'), 'fallback path alert');

    const canceledCtx = makeContext({ canceled: true, filePath: path.join(tmp, 'should-not-write.md') });
    await plugin.requestActions[0].action(canceledCtx);
    assert(!fs.existsSync(path.join(tmp, 'should-not-write.md')), 'canceled dialog ignores filePath');
    assert(canceledCtx.alerts[0].msg.includes('insomnia-collection-lint.md'), 'canceled dialog falls back to writable path');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const fallback = await t.getWritableExportPath({ app: { getPath: async key => key === 'documents' ? '/tmp/docs' : '' } }, 'x.md');
  assert.strictEqual(fallback, path.join('/tmp/docs', 'x.md'));
  assert.strictEqual(t.saveDialogPath('/tmp/out.md'), '/tmp/out.md');
  assert.strictEqual(t.saveDialogPath({ filePath: '/tmp/out.md', canceled: false }), '/tmp/out.md');
  assert.strictEqual(t.saveDialogPath({ filePath: '/tmp/out.md', canceled: true }), null);

  console.log('PASS: all tests');
}

main().catch(err => { console.error(err.stack || err); process.exit(1); });
