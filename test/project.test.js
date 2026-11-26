import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, change, json, read, recover } from '../lib/files.js';
import { init } from '../lib/project.js';
import { makeRule, snapshot, updateRule } from '../lib/rules.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aipart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('重复初始化保留人工说明，受管内容冲突时停止', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '项目说明');
  apply(root, init(root, 'claude'));
  assert.match(read(root, 'AGENTS.md'), /^项目说明\n/);
  assert.equal(
    init(root, 'claude').filter((e) => e.before !== e.after).length,
    0,
  );
  fs.writeFileSync(
    path.join(root, 'AGENTS.md'),
    read(root, 'AGENTS.md').replace('新增数据', '处理数据'),
  );
  assert.throws(() => init(root, 'claude', true), /手工修改/);
  assert.equal(snapshot(root).issues.length, 1);
});

test('关闭代码检查时保留其他编辑和确认摘要', (t) => {
  const root = fixture(t);
  apply(root, init(root, 'codex'));
  fs.writeFileSync(path.join(root, '.eslintrc.json'), '{"rules":{}}');
  const rule = makeRule(root, {
    scope: '.',
    title: '调试语句',
    request: '提交前清理',
    suggestion: '沿用 lint',
    decision: '移除调试语句',
    stages: { code: 'warn' },
    bindings: {
      code: {
        file: '.eslintrc.json',
        before: '"rules":{}',
        after: '"rules":{"no-debugger":"warn"}',
      },
    },
  });
  apply(root, updateRule(root, rule));
  fs.appendFileSync(path.join(root, '.eslintrc.json'), '\n');
  apply(root, updateRule(root, { ...rule, enabled: false }, rule));
  assert.equal(read(root, '.eslintrc.json'), '{"rules":{}}\n');
  assert.deepEqual(snapshot(root).issues, []);
});

test('过期预览拒绝覆盖新修改，中断的写入可以恢复', (t) => {
  const root = fixture(t);
  apply(root, init(root, 'pi'));
  const edit = change(root, 'one.txt', 'A');
  fs.writeFileSync(path.join(root, 'one.txt'), 'B');
  assert.throws(() => apply(root, [edit]), /变化/);
  fs.writeFileSync(
    path.join(root, '.aipart/local/transaction.json'),
    json([{ name: 'one.txt', before: '原文', after: 'B' }]),
  );
  recover(root);
  assert.equal(read(root, 'one.txt'), '原文');
});

test('业务样例验证失败时恢复待审草案和旧配置', (t) => {
  const root = fixture(t);
  apply(root, init(root, 'pi'));
  fs.writeFileSync(path.join(root, 'pending.json'), '等待确认');
  const edits = [
    change(root, 'pending.json', null),
    change(root, 'eslint.config.js', 'export default [];'),
  ];
  assert.throws(
    () =>
      apply(root, edits, () => {
        throw Error('反例未命中');
      }),
    /反例未命中/,
  );
  assert.equal(read(root, 'pending.json'), '等待确认');
  assert.equal(read(root, 'eslint.config.js'), null);
  assert.equal(read(root, '.aipart/local/transaction.json'), null);
});
