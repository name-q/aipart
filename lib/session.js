import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {apply,change,json,read,target} from './files.js';
import {agents,init,project} from './project.js';
import {makeRule,snapshot,stageNames,updateRule,validateScope} from './rules.js';

function client(name) {
  if (!agents.includes(name)) throw Error('未知工具：'+name);
  if (name==='cursor') return;
  const result=spawnSync(name,['--version'],{encoding:'utf8',timeout:5000});
  if (result.error || result.status!==0) throw Error('无法启动 '+name+'，请安装后重试或选择 Cursor 交接');
}

export function switchClient(root,name,team) {
  client(name);
  const edits=init(root,name,false);
  if(team) {
    const config=edits.find(e=>e.name==='.aipart/project.json');
    config.after=json({...JSON.parse(config.after),defaultAI:name});
  }
  edits.push(change(root,'.aipart/local/settings.json',json({ai:name})));
  return edits;
}

function draftPath(id) {
  if(!/^[a-f0-9-]{36}$/.test(id)) throw Error('无效草案编号');
  return '.aipart/local/drafts/'+id;
}

export async function propose(root,{ai,scope,stages,request,resume},question,confirm) {
  project(root);
  const id=resume ?? randomUUID();
  const base=draftPath(id);
  let session;
  if(resume) {
    session=JSON.parse(read(root,base+'.session.json') ?? 'null');
    if(!session) throw Error('没有这个草案');
  } else {
    validateScope(root,scope);
    if(!stages.length || stages.some(s=>!stageNames.includes(s))) throw Error('无效的执行阶段');
    session={scope,stages:[...new Set(stages)]};
  }
  const name=ai ?? snapshot(root).ai;
  const input=request || (resume?'请继续已有草案，复用已确认的决定。':await question('输入新规则或希望解决的问题：'));
  if(!input.trim()) throw Error('需求不能为空');
  if(!resume) apply(root,[change(root,base+'.session.json',json(session))]);
  const prompt=[
    '在当前项目协助确定一条前端业务规则。先读 AGENTS.md，并查找真实调用、公共方法和项目配置。只询问会改变实现的业务决定。',
    '仅写下方草案文件，先保留已有草案中的确认内容。不要改生产配置或执行提交。不要保存密钥、聊天原文或敏感样本。',
    '用途：'+input, '作用范围：'+session.scope, '生效阶段：'+session.stages.join(', '),
    '草案绝对路径：'+target(root,base+'.json'),
    '生成 JSON，字段为 title、request（需求摘要）、suggestion（建议摘要）、decision、exceptions（字符串）、scope、stages、bindings。stages 的键为生效阶段，值为 warn 或 error，默认 warn。',
    'guide 无需绑定。code 绑定现有 ESLint 配置的 {file,before,after}，提供唯一的非空原文及替换片段。保留其他项目规则。CI 可同样绑定现有流水线。',
    'commit 绑定 {rule,options}，使用项目 ESLint 能执行的规则和参数；CI 也支持这种绑定。涉及无法静态判断的决定时，向用户建议改用 guide 后重新选择阶段。',
    '确认运行阶段之间是否互相影响，说明适用边界并给出合法、违规和例外样例。file 相对于项目根。'
  ].join('\n');
  console.log('草案编号 '+id);
  if(name==='cursor') { console.log(prompt);return; }
  client(name);
  const cwd=session.scope==='.'?root:target(root,session.scope);
  const result=spawnSync(name,[prompt],{cwd,stdio:'inherit'});
  if(result.error || result.status!==0) throw Error('会话已中断，请查看工具提示。可运行 aipart ask --resume '+id+'，或切换工具后继续');
  if(read(root,base+'.json')===null) { console.log('草案尚未生成，可继续会话：aipart ask --resume '+id); return; }
  if(confirm) await accept(root,id,confirm);
  else console.log('查看并保存：aipart accept '+id);
}

export async function accept(root,id,confirm) {
  const base=draftPath(id);
  const session=JSON.parse(read(root,base+'.session.json') ?? 'null');
  const raw=read(root,base+'.json');
  if(!raw || !session) throw Error('草案或会话记录缺失');
  const draft=JSON.parse(raw);
  if(draft.scope!==session.scope || !draft.stages || Object.keys(draft.stages).sort().join()!==[...session.stages].sort().join()) throw Error('草案范围或阶段与本次选择不同');
  const r=makeRule(root,draft);
  const edits=updateRule(root,r);
  console.log(json(r));
  for(const binding of Object.values(r.bindings)) {
    if(binding.file) console.log(binding.file+'\n- '+binding.before+'\n+ '+binding.after);
  }
  if(await confirm()) {
    apply(root,[...edits,{name:base+'.json',before:raw,after:null},change(root,base+'.session.json',null)]);
    console.log('已保存 '+r.id);
  }
}

export function drafts(root) {
  const dir=target(root,'.aipart/local/drafts');
  return fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>f.endsWith('.session.json')).map(f=>path.basename(f,'.session.json')):[];
}
