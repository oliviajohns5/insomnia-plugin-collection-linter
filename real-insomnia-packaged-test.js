'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const plugin = require('insomnia-plugin-collection-linter');
const fakeToken = 'sk-' + 'c'.repeat(30);

function makeContext(outputPath) {
  const alerts = [];
  return {
    alerts,
    data: { export: { insomnia: async () => JSON.stringify({ resources: [
      { _type: 'request', name: 'Prod remove', method: 'DELETE', url: 'https://live.example.com/users/1?token=' + fakeToken },
      { _type: 'request', name: 'Prod remove', method: 'DELETE', url: 'https://live.example.com/users/1?token=' + fakeToken },
      { _type: 'environment', name: 'Env', data: { region: 'us' } }
    ] }) } },
    app: {
      showSaveDialog: async () => outputPath,
      getPath: async key => key === 'documents' ? os.tmpdir() : '',
      alert: async (title, msg) => alerts.push({ title, msg }),
    },
  };
}

async function main() {
  assert(Array.isArray(plugin.workspaceActions), 'workspace action');
  assert(Array.isArray(plugin.requestGroupActions), 'request group action');
  assert(Array.isArray(plugin.requestActions), 'request action');
  assert(plugin.__test.lintWorkspace, 'test helpers exported');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-linter-packaged-'));
  try {
    for (const action of [plugin.workspaceActions[0], plugin.requestGroupActions[0], plugin.requestActions[0]]) {
      const out = path.join(tmp, Math.random().toString(36).slice(2) + '.md');
      const ctx = makeContext(out);
      await action.action(ctx);
      const report = fs.readFileSync(out, 'utf8');
      assert(report.includes('# Insomnia Collection Linter Report'));
      assert(report.includes('query-auth'));
      assert(report.includes('prod-mutation'));
      assert(report.includes('duplicate-route'));
      assert(!report.includes(fakeToken));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('PASS: packaged plugin integration harness');
}

main().catch(err => { console.error(err.stack || err); process.exit(1); });
