import fs from 'node:fs';
import path from 'node:path';
import { block, change, json, read, target } from './files.js';

import {
  databaseName,
  hasDatabase,
  listData,
  manifest,
  ruleName,
} from './storage.js';
import { agents } from './client.js';
export { agents };
export { manifest, ruleName };
export const baseline = {
  id: 'reuse',
  title: '先查项目已有实现',
  scope: '.',
  enabled: true,
  stages: { guide: 'warn' },
  decision:
    '新增数据转换、接口调用或图片处理前，先查项目已有实现；有影响行为的歧义时询问业务方。',
};
export const templateVersion = 3;
export function findRoot(cwd) {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (hasDatabase(dir) || fs.existsSync(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return cwd;
  }
}
export function project(root) {
  const raw = read(root, manifest);
  if (!raw) throw Error('项目尚未接入，请先运行 aipart init');
  const p = JSON.parse(raw);
  if (p.format !== 1 || p.template > templateVersion)
    throw Error('项目版本需要更新的 aipart');
  return p;
}
export function rules(root) {
  return listData(target(root, databaseName), 'rules/').map(({ value }) =>
    JSON.parse(value),
  );
}
export function instruction(items) {
  const guides =
    items
      .filter((r) => r.enabled && r.stages.guide)
      .map(
        (r) =>
          '- [' +
          r.scope +
          '] ' +
          r.decision +
          (r.exceptions ? ' 例外：' + r.exceptions : ''),
      )
      .join('\n') || '当前没有启用的项目指引。';
  return [
    '下方是本项目启用的约定。按任务范围核对实际调用和业务例外。',
    '优先沿用当前框架和业务已有约定。按需要拆分模块；长期有效的业务决定就近补入项目已有说明。',
    guides,
  ].join('\n');
}
export function init(root, ai, upgrade) {
  if (!agents.includes(ai)) throw Error('请选择 ' + agents.join(' / '));
  const exists = read(root, manifest) !== null;
  const p = exists
    ? project(root)
    : {
        format: 1,
        template: templateVersion,
        initialAI: ai,
        defaultAI: ai,
        agents: [],
      };
  if (p.template < templateVersion && !upgrade)
    throw Error('需要 init --upgrade');
  const items = exists ? rules(root) : [baseline];
  if (exists && !items.some((r) => r.id === 'reuse'))
    throw Error('缺少基础规则，请先恢复配置');
  const body = instruction(items);
  const edits = [
    change(
      root,
      'AGENTS.md',
      block(read(root, 'AGENTS.md'), 'rules', body, p.body),
    ),
  ];
  if (ai === 'claude' || p.agents.includes('claude')) {
    const text = read(root, 'CLAUDE.md') ?? '';
    if (!/^@(?:\.\/)?AGENTS\.md\s*$/m.test(text))
      edits.push(change(root, 'CLAUDE.md', block(text, 'entry', '@AGENTS.md')));
  }
  if (!exists) edits.push(change(root, ruleName('reuse'), json(baseline)));
  p.body = body;
  p.template = templateVersion;
  if (!agents.includes(p.defaultAI)) p.defaultAI = ai;
  if (!agents.includes(p.initialAI)) p.initialAI = ai;
  p.agents = [
    ...new Set([...p.agents.filter((name) => agents.includes(name)), ai]),
  ];
  edits.push(change(root, manifest, json(p)));
  return edits;
}
