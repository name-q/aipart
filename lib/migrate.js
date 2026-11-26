import fs from 'node:fs';
import path from 'node:path';
import { change, read, target } from './files.js';
import { inspect } from './inspect.js';
import { legacyManifest, manifest, ruleName } from './storage.js';

export function migration(root) {
  const raw = read(root, legacyManifest);
  if (!raw || read(root, manifest) !== null) return null;
  if (
    ['.aipart/local/transaction.json', '.aipart/local/write.lock'].some(
      (file) => read(root, file) !== null,
    )
  )
    throw Error('旧版有未完成的写入，请用原版本运行 recover 后再迁移');
  const project = JSON.parse(raw);
  if (
    project.format !== 1 ||
    !Array.isArray(project.agents) ||
    typeof project.body !== 'string'
  )
    throw Error('无法识别旧版项目配置');
  const dir = target(root, '.aipart/rules');
  const rules = fs
    .readdirSync(dir)
    .filter((name) => /^[\w-]+\.json$/.test(name))
    .map((name) => {
      const file = '.aipart/rules/' + name;
      const raw = read(root, file);
      const rule = JSON.parse(raw);
      if (name !== rule.id + '.json')
        throw Error('规则编号与文件名不一致：' + file);
      return { file, raw, rule };
    });
  if (!rules.some(({ rule }) => rule.id === 'reuse'))
    throw Error('旧版项目缺少基础规则');
  const edits = [
    change(root, manifest, raw),
    ...rules.map(({ raw, rule }) => change(root, ruleName(rule.id), raw)),
  ];
  const files = [legacyManifest, ...rules.map(({ file }) => file)];
  const ignore = read(root, '.aipart/.gitignore');
  if (ignore?.trim() === '/local/') files.push('.aipart/.gitignore');
  const previousRunner = read(root, '.aipart/gate.cjs');
  const referenced = inspect(root).ci.some((file) =>
    read(root, file)?.includes('.aipart/gate.cjs'),
  );
  if (previousRunner?.includes('module.exports = { check }') && !referenced)
    files.push('.aipart/gate.cjs');
  const localDir = target(root, '.aipart/local');
  if (fs.existsSync(localDir)) {
    const draftsDir = target(root, '.aipart/local/drafts');
    const personal = [];
    if (read(root, '.aipart/local/settings.json') !== null)
      personal.push('settings.json');
    if (fs.existsSync(draftsDir))
      personal.push(
        ...fs
          .readdirSync(draftsDir)
          .filter((name) => /^[a-f0-9-]{36}(?:\.session)?\.json$/.test(name))
          .map((name) => 'drafts/' + name),
      );
    for (const name of personal) {
      const file = '.aipart/local/' + name;
      const next = change(root, '@local/' + name, read(root, file));
      if (next.before !== null && next.before !== next.after)
        throw Error('存在同名本地资料：' + name);
      edits.push(next);
      files.push(file);
    }
  }
  for (const file of files) {
    const item = change(root, file, null);
    if (!file.startsWith('.aipart/local/'))
      edits.push(
        change(
          root,
          '@local/legacy/' + file.slice('.aipart/'.length),
          item.before,
        ),
      );
    edits.push(item);
  }
  return { project, rules: rules.map(({ rule }) => rule), edits, referenced };
}

export function pruneLegacy(root) {
  for (const dir of [
    '.aipart/local/drafts',
    '.aipart/local',
    '.aipart/rules',
    '.aipart',
  ]) {
    try {
      fs.rmdirSync(target(root, dir));
    } catch (error) {
      if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error;
    }
  }
}
