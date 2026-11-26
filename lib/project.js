import fs from 'node:fs';
import path from 'node:path';
import {block,change,json,read,target} from './files.js';

export const agents = ['codex','claude','pi','cursor'];
export const manifest = '.aipart/project.json';
export const baseline = {id:'reuse', title:'先查项目已有实现', scope:'.', enabled:true, stages:{guide:'warn'}, decision:'新增数据转换、接口调用或图片处理前，先查项目已有实现；有影响行为的歧义时询问业务方。'};
export const templateVersion = 1;
export function findRoot(cwd) {
  for (let dir = cwd;; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir,manifest)) || fs.existsSync(path.join(dir,'.git'))) return dir;
    if (path.dirname(dir) === dir) return cwd;
  }
}
export function project(root) {
  const raw = read(root,manifest);
  if (!raw) throw Error('项目尚未接入，请先运行 aipart init');
  const p = JSON.parse(raw);
  if (p.format !== 1 || p.template > templateVersion) throw Error('项目版本需要更新的 aipart');
  return p;
}
export function rules(root) {
  return fs.readdirSync(target(root,'.aipart/rules')).filter(n=>n.endsWith('.json')).sort()
    .map(n=>JSON.parse(read(root,'.aipart/rules/'+n)));
}
export function instruction(items) {
  return items.filter(r=>r.enabled && Object.values(r.stages).some(Boolean))
    .map(r=>'- ['+r.scope+'] '+r.decision+(r.exceptions?' 例外：'+r.exceptions:'')).join('\n') || '当前没有启用的项目规则。';
}
export function init(root, ai, upgrade) {
  if (!agents.includes(ai)) throw Error('请选择 '+agents.join(' / '));
  const exists = read(root,manifest) !== null;
  const p = exists ? project(root) : {format:1,template:templateVersion,initialAI:ai,defaultAI:ai,agents:[]};
  if (p.template < templateVersion && !upgrade) throw Error('需要 init --upgrade');
  const items = exists ? rules(root) : [baseline];
  if (exists && !items.some(r=>r.id==='reuse')) throw Error('缺少基础规则，请先恢复配置');
  const body = instruction(items);
  const edits = [change(root,'AGENTS.md',block(read(root,'AGENTS.md'),'rules',body,p.body))];
  if (ai === 'claude' || p.agents.includes('claude')) {
    const text = read(root,'CLAUDE.md') ?? '';
    if (!/^@(?:\.\/)?AGENTS\.md\s*$/m.test(text)) edits.push(change(root,'CLAUDE.md',block(text,'entry','@AGENTS.md')));
  }
  const ignored = read(root,'.aipart/.gitignore') ?? '';
  if (!ignored.split(/\r?\n/).includes('/local/')) edits.push(change(root,'.aipart/.gitignore',ignored+(ignored && !ignored.endsWith('\n')?'\n':'')+'/local/\n'));
  if (!exists) edits.push(change(root,'.aipart/rules/reuse.json',json(baseline)));
  p.body=body;
  p.template=templateVersion;
  p.agents=[...new Set([...p.agents,ai])];
  edits.push(change(root,manifest,json(p)));
  return edits;
}
