import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, change, json, read, recover, target } from '../lib/files.js';
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
  apply(root, init(root, 'openai'));
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
  apply(root, init(root, 'deepseek'));
  const edit = change(root, 'one.txt', 'A');
  fs.writeFileSync(path.join(root, 'one.txt'), 'B');
  assert.throws(() => apply(root, [edit]), /变化/);
  fs.writeFileSync(
    target(root, '@local/transaction.json'),
    json([{ name: 'one.txt', before: '原文', after: 'B' }]),
  );
  recover(root);
  assert.equal(read(root, 'one.txt'), '原文');
});

test('业务样例验证失败时恢复待审草案和旧配置', (t) => {
  const root = fixture(t);
  apply(root, init(root, 'deepseek'));
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
  assert.equal(read(root, '@local/transaction.json'), null);
});

test('旧版规则库改名为 .aipart 后规则保持不变，冲突时停止', async (t) => {
  const root = fixture(t);
  const { project, rules, findRoot } = await import('../lib/project.js');
  const { renameDatabase } = await import('../lib/storage.js');
  apply(root, init(root, 'openai'));
  fs.renameSync(path.join(root, '.aipart'), path.join(root, '.aipart.sqlite'));
  fs.mkdirSync(path.join(root, 'src'));
  assert.equal(findRoot(path.join(root, 'src')), root);
  assert.equal(renameDatabase(root), true);
  assert.equal(renameDatabase(root), false);
  assert.deepEqual(fs.readdirSync(root).sort(), [
    '.aipart',
    'AGENTS.md',
    'src',
  ]);
  assert.equal(project(root).defaultAI, 'openai');
  assert.equal(rules(root)[0].id, 'reuse');
  fs.writeFileSync(path.join(root, '.aipart.sqlite'), '');
  assert.throws(() => renameDatabase(root), /同时存在/);
});

test('自动清理旧版留下的空 .aipart 目录，目录里有文件时停止', async (t) => {
  const root = fixture(t);
  const { renameDatabase } = await import('../lib/storage.js');
  fs.mkdirSync(path.join(root, '.aipart/local'), { recursive: true });
  fs.mkdirSync(path.join(root, '.aipart/rules'));
  assert.equal(renameDatabase(root), false);
  assert.equal(fs.existsSync(path.join(root, '.aipart')), false);
  apply(root, init(root, 'openai'));
  assert.ok(fs.statSync(path.join(root, '.aipart')).isFile());
  fs.rmSync(path.join(root, '.aipart'));
  fs.mkdirSync(path.join(root, '.aipart/rules'), { recursive: true });
  fs.writeFileSync(path.join(root, '.aipart/rules/reuse.json'), '{}');
  assert.throws(() => renameDatabase(root), /rules\/reuse\.json/);
  assert.ok(fs.existsSync(path.join(root, '.aipart/rules/reuse.json')));
});

test('旧工具停用后可重新选择提供方，已有项目规则继续生效', async (t) => {
  const root = fixture(t);
  const { project, manifest } = await import('../lib/project.js');
  apply(root, init(root, 'openai'));
  const old = project(root);
  apply(root, [
    change(
      root,
      manifest,
      json({
        ...old,
        defaultAI: 'codex',
        initialAI: 'codex',
        agents: ['codex'],
      }),
    ),
    change(root, '@local/settings.json', json({ ai: 'codex' })),
  ]);
  assert.equal(snapshot(root).ai, null);
  apply(root, init(root, 'openai'));
  const state = snapshot(root);
  assert.equal(state.ai, 'openai');
  assert.deepEqual(state.agents, ['openai']);
  assert.equal(state.rules[0].id, 'reuse');
});
