import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {block,change,json,read,target} from './files.js';
import {instruction,manifest,project,rules,templateVersion} from './project.js';

export const stageNames=['guide','code','commit','ci'];

export function validateScope(root, scope) {
  if (scope==='.') return scope;
  if (typeof scope!=='string' || path.isAbsolute(scope) || path.normalize(scope)!==scope || scope.startsWith('.') || !fs.statSync(target(root,scope)).isDirectory()) throw Error('无效的应用范围');
  return scope;
}

function checkedPatch(root, stage, patch) {
  const {file,before,after}=patch;
  if (typeof file!=='string' || path.isAbsolute(file) || path.normalize(file)!==file || file.split(/[\\/]/).some(x=>['.git','node_modules','.aipart'].includes(x))) throw Error('无效的配置路径');
  target(root,file);
  const name=path.basename(file);
  const allowed = stage==='code' ? /^(eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.[\w]+)?|package\.json)$/u.test(name)
    : stage==='ci' && (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file) || ['.gitlab-ci.yml','Jenkinsfile','azure-pipelines.yml'].includes(name));
  if (!allowed || typeof before!=='string' || typeof after!=='string' || !before || !after || before===after) throw Error('配置修改需要有效路径、非空且不同的原文和替换文本');
  return {file,before,after};
}

export function makeRule(root,draft) {
  const {title,decision,request,suggestion,exceptions='',scope='.',stages,bindings={}}=draft;
  for (const value of [title,decision,request,suggestion]) if(typeof value!=='string'||!value.trim()) throw Error('请填写标题、决定、需求和建议摘要');
  if(typeof exceptions!=='string') throw Error('例外说明应为文本');
  if (!stages || !Object.keys(stages).length) throw Error('请选择生效位置');
  const checked={};
  for (const [stage,level] of Object.entries(stages)) {
    if (!stageNames.includes(stage) || !['warn','error'].includes(level)) throw Error('无效的生效位置或级别');
    if (stage==='guide') continue;
    const patch=bindings[stage];
    if (stage==='commit' || (stage==='ci' && patch?.rule)) {
      if (!patch || typeof patch.rule!=='string' || !/^[\w@/-]+$/.test(patch.rule) || !Array.isArray(patch.options)) throw Error('请输入 ESLint 规则及参数');
      checked[stage]={rule:patch.rule,options:patch.options};
    } else checked[stage]=checkedPatch(root,stage,patch ?? {});
  }
  const id=randomUUID();
  return {id,title,scope:validateScope(root,scope),enabled:true,stages,bindings:checked,request,suggestion,decision,exceptions};
}

export function updateRule(root,next,previous) {
  const p=project(root), items=rules(root);
  const file='.aipart/rules/'+next.id+'.json';
  if (!/^[\w-]+$/.test(next.id)) throw Error('规则编号无效');
  const entry=change(root,file,json(next));
  if (previous ? entry.before!==json(previous) : entry.before!==null) throw Error('规则已发生修改，请重新查看');
  const edits=new Map();
  for(const [stage,binding] of Object.entries(next.bindings ?? {})) {
    if (!binding.file) continue;
    const active=Boolean(next.enabled && next.stages[stage]);
    if (active===Boolean(previous?.enabled && previous?.stages[stage])) continue;
    const {file,before,after}=checkedPatch(root,stage,binding);
    const edit=edits.get(file) ?? change(root,file,read(root,file));
    const from=active?before:after, to=active?after:before;
    if (edit.after===null || edit.after.split(from).length!==2) throw Error('配置片段缺失或不唯一：'+file);
    edit.after=edit.after.replace(from,()=>to);
    edits.set(file,edit);
  }
  const updated=previous ? items.map(r=>r.id===next.id?next:r) : [...items,next];
  const body=instruction(updated.sort((a,b)=>a.id.localeCompare(b.id)));
  return [...edits.values(),entry,change(root,'AGENTS.md',block(read(root,'AGENTS.md'),'rules',body,p.body)),change(root,manifest,json({...p,body}))];
}

export function snapshot(root) {
  const p=project(root), items=rules(root);
  const issues=[];
  try {
    const text=read(root,'AGENTS.md');
    if (text!==block(text,'rules',p.body,p.body) || p.body!==instruction(items.sort((a,b)=>a.id.localeCompare(b.id)))) issues.push('项目指引与规则不一致');
  } catch(e) { issues.push(e.message); }
  if (p.agents.includes('claude') && !/^@(?:\.\/)?AGENTS\.md\s*$/m.test(read(root,'CLAUDE.md') ?? '')) issues.push('Claude 入口缺失');
  for (const r of items) for(const [stage,b] of Object.entries(r.bindings ?? {})) {
    if (b.file && r.enabled && r.stages[stage] && !read(root,b.file)?.includes(b.after)) issues.push(r.title+'：配置已变化 '+b.file);
  }
  const local=JSON.parse(read(root,'.aipart/local/settings.json') ?? '{}');
  const ci=['.github/workflows','.gitlab-ci.yml','Jenkinsfile','azure-pipelines.yml'].filter(n=>fs.existsSync(path.join(root,n)));
  return {format:p.format,template:p.template,availableTemplate:templateVersion,defaultAI:p.defaultAI,ai:local.ai ?? p.defaultAI,agents:p.agents,ci,rules:items,issues};
}
