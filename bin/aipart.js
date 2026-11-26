#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { apply,recover } from '../lib/files.js';
import { agents,findRoot,init } from '../lib/project.js';

import { snapshot,updateRule,stageNames } from '../lib/rules.js';
import { rules } from '../lib/project.js';

const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
async function question(label) {
  if (!tty) throw Error('此操作需要交互终端');
  const rl = createInterface({input:process.stdin,output:process.stdout});
  try { return (await rl.question(label+' ')).trim(); } finally { rl.close(); }
}
async function main() {
  const {values,positionals:[cmd,...args]}=parseArgs({allowPositionals:true,options:{
    ai:{type:'string'},yes:{type:'boolean'},upgrade:{type:'boolean'},help:{type:'boolean'},version:{type:'boolean'},json:{type:'boolean'}
  }});
  if(values.version) return console.log('0.1.0');
  if(!cmd || values.help) return console.log('aipart init --ai <codex|claude|pi|cursor> [--upgrade] [--yes]\naipart recover');
  const root=findRoot(process.cwd());
  if(cmd==='recover') return recover(root);
  if(cmd==='init') {
    const ai=values.ai ?? await question('选择工具 ('+agents.join('/')+')：');
    const edits=init(root,ai,values.upgrade);
    const files=edits.filter(c=>c.before!==c.after).map(c=>c.name);
    if (!files.length) return console.log('项目配置已是当前版本');
    console.log(files.join('\n'));
    if(values.yes || !tty || await question('写入以上配置？[y/N]')==='y') apply(root,edits);
    return;
  }
  if(cmd==='check') {
    const state=snapshot(root);
    if(values.json) { console.log(JSON.stringify(state,null,2)); if(state.issues.length) process.exitCode=1; return; }
    console.log('当前 '+state.ai+' · 项目推荐 '+state.defaultAI+' · 模板 '+state.template+' · 启用 '+state.rules.filter(r=>r.enabled).length+' 条 · CI '+(state.ci.join(', ') || '未发现'));
    for(const rule of state.rules) console.log(rule.id,rule.enabled?'开':'关',rule.title,JSON.stringify(rule.stages));
    for(const issue of state.issues) console.error(issue);
    if(state.issues.length) process.exitCode=1;
    return;
  }
  if(cmd==='enable' || cmd==='disable') {
    const item=rules(root).find(r=>r.id===args[0]);
    if(!item) throw Error('没有这个规则');
    const next=structuredClone(item);
    if(args[1]) {
      const stage=args[1];
      if(!stageNames.includes(stage) || !(stage in next.stages)) throw Error('规则没有这个阶段');
      next.levels ??= {};
      if(next.stages[stage]) next.levels[stage]=next.stages[stage];
      next.stages[stage]=cmd==='enable' ? next.levels[stage] ?? 'warn' : false;
    } else next.enabled=cmd==='enable';
    apply(root,updateRule(root,next,item));
    return;
  }
  throw Error('未知命令：'+[cmd,...args].join(' '));
}
main().catch(e=>{ console.error(e.message); process.exitCode=1; });
