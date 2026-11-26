#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { apply,recover } from '../lib/files.js';
import { agents,findRoot,init } from '../lib/project.js';

import { snapshot,updateRule,stageNames } from '../lib/rules.js';
import { rules } from '../lib/project.js';

import {accept,drafts,propose,switchClient} from '../lib/session.js';

const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
async function question(label) {
  if (!tty) throw Error('此操作需要交互终端');
  const rl = createInterface({input:process.stdin,output:process.stdout});
  try { return (await rl.question(label+' ')).trim(); } finally { rl.close(); }
}
function toggle(item,stage,enabled) {
    const next=structuredClone(item);
    if(stage) {
      if(!stageNames.includes(stage) || !(stage in next.stages)) throw Error('规则没有这个阶段');
      next.levels ??= {};
      if(next.stages[stage]) next.levels[stage]=next.stages[stage];
      next.stages[stage]=enabled ? next.levels[stage] ?? 'warn' : false;
    } else next.enabled=enabled;
    return next;
}
async function main() {
  const {values,positionals:[cmd,...args]}=parseArgs({allowPositionals:true,options:{
    ai:{type:'string'},yes:{type:'boolean'},upgrade:{type:'boolean'},help:{type:'boolean'},version:{type:'boolean'},json:{type:'boolean'},scope:{type:'string'},stages:{type:'string'},resume:{type:'string'},team:{type:'boolean'}
  }});
  if(values.version) return console.log('0.1.0');
  if(!cmd || values.help) return console.log('aipart init --ai <codex|claude|pi|cursor> [--upgrade] [--yes]\naipart check [--json]\naipart ask [需求] [--scope 路径] [--stages guide,code,commit,ci] [--resume 编号]\naipart ai use <工具> [--team]\naipart accept <草案编号>\naipart enable|disable <规则编号> [阶段]\naipart recover');
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
  const confirm=async()=>values.yes || await question('确认写入？[y/N]')==='y';
  const ask=async(request)=>{
    let stages=values.stages;
    if(!stages && tty && !values.resume) stages=await question('位置 guide 指引 / code 代码 / commit 提交 / ci 流水线（可用逗号组合，回车为 guide）：');
    await propose(root,{ai:values.ai,request,scope:values.scope ?? '.',stages:(stages || 'guide').split(',').map(s=>s.trim()),resume:values.resume},question,tty || values.yes ? confirm : null);
  };
  const select=async(name)=>{
    const edits=switchClient(root,name,values.team);
    console.log(edits.filter(e=>e.before!==e.after).map(e=>e.name).join('\n'));
    if(!tty || await confirm()) apply(root,edits);
  };
  if(cmd==='ask') return ask(args.join(' '));
  if(cmd==='accept') return accept(root,args[0],confirm);
  if(cmd==='ai' && args[0]==='use') return select(args[1]);
  if(cmd==='check') {
    const state=snapshot(root);
    if(values.json) { console.log(JSON.stringify(state,null,2)); if(state.issues.length) process.exitCode=1; return; }
    console.log('当前 '+state.ai+' · 项目推荐 '+state.defaultAI+' · 模板 '+state.template+' · 启用 '+state.rules.filter(r=>r.enabled).length+' 条 · CI '+(state.ci.join(', ') || '未发现'));
    for(const rule of state.rules) console.log(rule.id,rule.enabled?'开':'关',rule.title,JSON.stringify(rule.stages));
    for(const issue of state.issues) console.error(issue);
    if(state.issues.length) process.exitCode=1;
    if(tty) {
      const choice=await question('1 查看详情  2 新增规则  3 启用或停用  4 切换工具  5 未完成草案  回车退出');
      if(choice==='1') console.log(JSON.stringify(state,null,2));
      if(choice==='2') return ask(await question('输入需求：'));
      if(choice==='4') return select(await question(agents.join('/')+'：'));
      if(choice==='5') console.log(drafts(root).join('\n') || '没有草案');
      if(choice==='3') {
        const id=await question('规则编号：');
        const stage=await question('阶段（回车为整条规则）：');
        const rule=state.rules.find(r=>r.id===id);
        if(!rule || (stage && !(stage in rule.stages))) throw Error('规则或阶段不存在');
        const next=toggle(rule,stage,!(stage?rule.stages[stage]:rule.enabled));
        if(await confirm()) apply(root,updateRule(root,next,rule));
      }
    }
    return;
  }
  if(cmd==='enable' || cmd==='disable') {
    const item=rules(root).find(r=>r.id===args[0]);
    if(!item) throw Error('没有这个规则');
    const next=toggle(item,args[1],cmd==='enable');
    apply(root,updateRule(root,next,item));
    return;
  }
  throw Error('未知命令：'+[cmd,...args].join(' '));
}
main().catch(e=>{ console.error(e.message); process.exitCode=1; });
