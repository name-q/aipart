import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { databaseName } from './storage.js';

const legacy = [
  'node .aipart/gate.cjs commit || exit $?',
  'if [ -f .aipart/gate.cjs ]; then node .aipart/gate.cjs commit || exit $?; fi',
];
const quote = (text) => "'" + text.replaceAll("'", "'\"'\"'") + "'";
const marker = '# aipart: pre-commit';
const cli = fileURLToPath(new URL('../bin/aipart.js', import.meta.url));
const command =
  'if git ls-files --error-unmatch ' +
  databaseName +
  ' >/dev/null 2>&1; then if [ -x ./node_modules/.bin/aipart ]; then ./node_modules/.bin/aipart lint commit || exit $?; elif [ -f ' +
  quote(cli) +
  ' ]; then node ' +
  quote(cli) +
  ' lint commit || exit $?; elif command -v aipart >/dev/null 2>&1; then aipart lint commit || exit $?; else echo "请安装 aipart，或重新执行 aipart hooks install" >&2; exit 2; fi; fi';

function hookPath(root) {
  const git = (args) =>
    execFileSync('git', args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  try {
    if (
      fs.realpathSync(git(['rev-parse', '--show-toplevel'])) !==
      fs.realpathSync(root)
    )
      throw Error();
    const location = git([
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'hooks/pre-commit',
    ]);
    const common = path.resolve(root, git(['rev-parse', '--git-common-dir']));
    if (![root, common].some((base) => location.startsWith(base + path.sep)))
      throw Error();
    return location;
  } catch {
    return null;
  }
}
export function hookStatus(root) {
  const file = hookPath(root);
  if (!file) return '不可自动接入';
  if (!fs.existsSync(file)) return '未安装';
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) return '需手工接入';
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).includes(command) &&
    stat.mode & 0o111
    ? '已安装'
    : '已有其他钩子';
}
export function installHook(root) {
  const file = hookPath(root);
  if (!file) throw Error('请在项目现有 pre-commit 中调用 ' + command);
  if (hookStatus(root) === '已安装') return;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.realpathSync(dir) !== dir)
    throw Error('钩子目录包含符号链接，请手工接入');
  let previous = '';
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat) {
    if (!stat.isFile() || !(stat.mode & 0o111))
      throw Error('现有钩子需手工接入：' + command);
    previous = fs.readFileSync(file, 'utf8');
    if (
      !/^#!\s*\/bin\/(?:ba)?sh(?:\r?\n)/.test(previous) ||
      file.includes('/.husky/_/')
    )
      throw Error('请在现有提交脚本中加入：' + command);
  }
  const header = previous
    ? previous.slice(0, previous.indexOf('\n') + 1)
    : '#!/bin/sh\n';
  const rest = previous
    .slice(header.length)
    .split(/\r?\n/)
    .filter(
      (line, index, lines) =>
        !legacy.includes(line) &&
        line !== marker &&
        lines[index - 1] !== marker,
    )
    .join('\n');
  const updated = header + marker + '\n' + command + '\n' + rest;
  if (!stat) fs.writeFileSync(file, updated, { flag: 'wx', mode: 0o755 });
  else {
    const tmp = file + '.aipart-' + process.pid;
    try {
      fs.writeFileSync(tmp, updated, { flag: 'wx', mode: stat.mode });
      if (fs.readFileSync(file, 'utf8') !== previous)
        throw Error('钩子已变化，请重试');
      fs.renameSync(tmp, file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
}
