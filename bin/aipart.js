#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { apply,recover } from '../lib/files.js';
import { agents,findRoot,init } from '../lib/project.js';

const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
async function question(label) {
  if (!tty) throw Error('此操作需要交互终端');
  const rl = createInterface({input:process.stdin,output:process.stdout});
  try { return (await rl.question(label+' ')).trim(); } finally { rl.close(); }
}
async function main() {
  const {values,positionals:[cmd,...args]}=parseArgs({allowPositionals:true,options:{
    ai:{type:'string'},yes:{type:'boolean'},upgrade:{type:'boolean'},help:{type:'boolean'},version:{type:'boolean'}
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
  throw Error('未知命令：'+[cmd,...args].join(' '));
}
main().catch(e=>{ console.error(e.message); process.exitCode=1; });
