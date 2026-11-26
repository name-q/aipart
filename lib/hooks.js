import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {change,read} from './files.js';

const runner='.aipart/gate.cjs';
const command='node .aipart/gate.cjs commit || exit $?';
export function runnerEdit(root) {
  const text=fs.readFileSync(fileURLToPath(new URL('./gate.cjs',import.meta.url)),'utf8');
  const existing=read(root,runner);
  if(existing!==null && existing!==text) throw Error('项目检查器与当前版本不同，请核对 '+runner);
  return change(root,runner,text);
}

function hookPath(root) {
  const git=args=>execFileSync('git',args,{cwd:root,stdio:['ignore','pipe','ignore'],encoding:'utf8'}).trim();
  try {
    if(fs.realpathSync(git(['rev-parse','--show-toplevel']))!==fs.realpathSync(root)) throw Error();
    const location=git(['rev-parse','--path-format=absolute','--git-path','hooks/pre-commit']);
    const common=path.resolve(root,git(['rev-parse','--git-common-dir']));
    if(![root,common].some(base=>location.startsWith(base+path.sep))) throw Error();
    return location;
  } catch { return null; }
}
export function hookStatus(root) {
  const file=hookPath(root);
  if(!file) return '不可自动接入';
  if(!fs.existsSync(file)) return '未安装';
  const stat=fs.lstatSync(file);
  if(!stat.isFile()) return '需手工接入';
  return fs.readFileSync(file,'utf8').split(/\r?\n/).includes(command) && (stat.mode & 0o111)?'已安装':'已有其他钩子';
}
export function installHook(root) {
  const file=hookPath(root);
  if(!file) throw Error('请在项目现有 pre-commit 中调用 '+command);
  if(hookStatus(root)==='已安装') return;
  const dir=path.dirname(file);
  fs.mkdirSync(dir,{recursive:true});
  if(fs.realpathSync(dir)!==dir) throw Error('钩子目录包含符号链接，请手工接入');
  let previous='';
  const stat=fs.lstatSync(file,{throwIfNoEntry:false});
  if(stat) {
    if(!stat.isFile() || !(stat.mode & 0o111)) throw Error('现有钩子需手工接入：'+command);
    previous=fs.readFileSync(file,'utf8');
    if(!/^#!\s*\/bin\/(?:ba)?sh(?:\r?\n)/.test(previous) || file.includes('/.husky/_/')) throw Error('请在现有提交脚本中加入：'+command);
  }
  const header=previous ? previous.slice(0,previous.indexOf('\n')+1) : '#!/bin/sh\n';
  const updated=header+command+'\n'+previous.slice(header.length);
  if(!stat) fs.writeFileSync(file,updated,{flag:'wx',mode:0o755});
  else {
    const tmp=file+'.aipart-'+process.pid;
    try {
      fs.writeFileSync(tmp,updated,{flag:'wx',mode:stat.mode});
      if(fs.readFileSync(file,'utf8')!==previous) throw Error('钩子已变化，请重试');
      fs.renameSync(tmp,file);
    } finally { fs.rmSync(tmp,{force:true}); }
  }
}
