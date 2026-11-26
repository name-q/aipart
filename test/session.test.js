import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../bin/aipart.js', import.meta.url));
test('更换工具后复用本地草案，确认后跨工具读取同一规则', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aipart-cli-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  function call(...args) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  assert.notEqual(
    spawnSync(process.execPath, [cli, 'init'], { cwd }).status,
    0,
  );
  assert.deepEqual(fs.readdirSync(cwd), []);
  call('init', '--ai', 'codex');
  call('ai', 'use', 'cursor');
  const out = call('ask', '确认原图例外');
  const id = out.match(/草案编号 ([\w-]+)/)[1];
  assert.match(call('ask', '--resume', id), /继续已有草案/);
  const payload = {
    scope: '.',
    stages: { guide: 'warn' },
    title: '原图处理',
    decision: '凭证保留原图',
    exceptions: '头像可压缩',
    request: '统一处理',
    suggestion: '保留例外',
  };
  fs.writeFileSync(
    path.join(cwd, '.aipart/local/drafts', id + '.json'),
    JSON.stringify(payload),
  );
  call('accept', id, '--yes');
  const state = JSON.parse(call('check', '--json'));
  assert.equal(state.defaultAI, 'codex');
  assert.equal(state.ai, 'cursor');
  assert.match(
    fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8'),
    /头像可压缩/,
  );
  assert.equal(state.rules.length, 2);
  assert.deepEqual(state.issues, []);
});
