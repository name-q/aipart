import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { target } from '../lib/files.js';

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
  call('init', '--ai', 'codex', '--offline');
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
    target(cwd, '@local/drafts/' + id + '.json'),
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

test('原生会话按项目启动并限定业务目录，离线验证草案的正反样例', (t) => {
  const cwd = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'aipart-session-')),
  );
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const app = path.join(cwd, 'apps/site');
  const bin = path.join(cwd, 'bin');
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(bin);
  fs.symlinkSync(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    path.join(cwd, 'node_modules'),
    'dir',
  );
  fs.writeFileSync(
    path.join(app, 'eslint.config.cjs'),
    'module.exports=[{files:["**/*.js"],rules:{}}];',
  );
  const file = 'apps/site/eslint.config.cjs';
  const draft = {
    scope: 'apps/site',
    title: '页面断点',
    request: '清理调试',
    suggestion: '使用现有检查',
    decision: '页面中清理调试断点',
    stages: { code: 'warn' },
    bindings: {
      code: { file, before: 'rules:{}', after: 'rules:{"no-debugger":"warn"}' },
    },
    examples: {
      code: {
        file: 'apps/site/page.js',
        rule: 'no-debugger',
        valid: 'const a=1;',
        invalid: 'debugger;',
      },
    },
  };
  fs.writeFileSync(
    path.join(bin, 'pi'),
    [
      '#!/usr/bin/env node',
      'if(process.argv[2]==="--version")process.exit(0);',
      'const p=process.argv.at(-1);',
      'if(process.cwd()!==' +
        JSON.stringify(cwd) +
        ' || process.argv.length!==4)process.exit(3);',
      'const file=p.split("\\n").find(l=>l.startsWith("草案绝对路径：")).slice("草案绝对路径：".length);',
      'require("node:fs").writeFileSync(file,' +
        JSON.stringify(JSON.stringify(draft)) +
        ');',
    ].join('\n'),
    { mode: 0o755 },
  );
  function run(...args) {
    const r = spawnSync(process.execPath, [cli, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH },
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  }
  run('init', '--ai', 'pi', '--offline');
  run(
    'ask',
    '--scope',
    'apps/site',
    '--stages',
    'code',
    '--yes',
    '限制调试 "$HOME"',
  );
  const state = JSON.parse(run('check', '--json'));
  const rule = state.rules.find((r) => r.title === '页面断点');
  assert.equal(rule.scope, 'apps/site');
  run('disable', rule.id, 'code');
  assert.match(fs.readFileSync(path.join(cwd, file), 'utf8'), /rules:\{\}/);
});
