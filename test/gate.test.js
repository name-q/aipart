import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { apply } from '../lib/files.js';
import { init } from '../lib/project.js';
import { makeRule, updateRule } from '../lib/rules.js';
import { hookStatus, installHook } from '../lib/hooks.js';

const modules = fileURLToPath(new URL('../node_modules', import.meta.url));
test('提交按暂存内容校验，保留旧钩子和未暂存修改', (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'aipart-git-')),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const put = (name, data) => fs.writeFileSync(path.join(root, name), data);
  git('init', '-q');
  git('config', 'core.hooksPath', '.git/hooks');
  fs.symlinkSync(modules, path.join(root, 'node_modules'), 'dir');
  put('.gitignore', 'node_modules\n');
  put('eslint.config.cjs', 'module.exports=[{files:["**/*.js"],rules:{}}];\n');
  put('.git/hooks/pre-commit', '#!/bin/sh\nexit 17\n');
  fs.chmodSync(path.join(root, '.git/hooks/pre-commit'), 0o755);
  apply(root, init(root, 'pi'));
  const binding = { rule: 'no-debugger', options: [] };
  const rule = makeRule(root, {
    scope: '.',
    title: '清理断点',
    decision: '删除调试断点',
    request: '清理调试',
    suggestion: '检查暂存区',
    stages: { commit: 'error', ci: 'warn' },
    bindings: { commit: binding, ci: binding },
  });
  apply(root, updateRule(root, rule));
  installHook(root);
  installHook(root);
  assert.equal(hookStatus(root), '已安装');
  const runHook = () =>
    spawnSync(path.join(root, '.git/hooks/pre-commit'), [], {
      cwd: root,
      encoding: 'utf8',
    });
  put('with space.js', 'debugger;');
  git('add', '.');
  put('with space.js', 'const valid=1;');
  let result = runHook();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /清理断点/);
  git('add', 'with space.js');
  put('with space.js', 'debugger;');
  result = runHook();
  assert.equal(result.status, 17, result.stderr);
  const ci = spawnSync(process.execPath, ['.aipart/gate.cjs', 'ci'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(ci.status, 0, ci.stderr);
  assert.match(ci.stderr, /提醒/);
  assert.equal(
    fs.readFileSync(path.join(root, 'with space.js'), 'utf8'),
    'debugger;',
  );
});
