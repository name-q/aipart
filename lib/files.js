import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const json = (value) => JSON.stringify(value, null, 2) + '\n';

export function target(root, name) {
  const full = path.resolve(root, name);
  const relative = path.relative(root, full);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw Error('路径越界：' + name);
  let cursor = root;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink())
      throw Error('路径包含符号链接：' + name);
  }
  return full;
}

export function read(root, name) {
  const file = target(root, name);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export function change(root, name, after) {
  return { name, before: read(root, name), after };
}

function replace(root, { name, after }) {
  const file = target(root, name);
  if (after === null) return fs.rmSync(file, { force: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomUUID();
  try {
    fs.writeFileSync(tmp, after, {
      flag: 'wx',
      mode: fs.statSync(file, { throwIfNoEntry: false })?.mode ?? 0o644,
    });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function apply(root, changes, validate) {
  const dir = target(root, '.aipart/local');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, 'write.lock');
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST')
      throw Error('项目正在写入；确认进程已结束后运行 aipart recover');
    throw e;
  }
  const journal = '.aipart/local/transaction.json';
  try {
    if (read(root, journal) !== null)
      throw Error('有中断的修改，请运行 aipart recover');
    const edits = changes.filter((c) => c.before !== c.after);
    for (const c of changes) {
      if (read(root, c.name) !== c.before)
        throw Error('文件已变化，请重试：' + c.name);
    }
    if (!edits.length) return;
    replace(root, { name: journal, after: json(edits) });
    for (const c of edits) replace(root, c);
    try {
      validate?.();
    } catch (error) {
      for (const c of edits)
        if (read(root, c.name) !== c.after)
          throw Error('验证期间文件已变化，请运行 aipart recover');
      for (const c of [...edits].reverse())
        replace(root, { name: c.name, after: c.before });
      replace(root, { name: journal, after: null });
      throw error;
    }
    replace(root, { name: journal, after: null });
  } finally {
    fs.unlinkSync(lock);
  }
}

export function recover(root) {
  const lock = target(root, '.aipart/local/write.lock');
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('写锁损坏');
    try {
      process.kill(pid, 0);
      throw Error('仍有进程在修改项目');
    } catch (e) {
      if (e.code !== 'ESRCH') throw e;
    }
    fs.unlinkSync(lock);
  }
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  try {
    const journal = '.aipart/local/transaction.json';
    const edits = JSON.parse(read(root, journal) ?? '[]');
    for (const c of edits) {
      if (![c.before, c.after].includes(read(root, c.name)))
        throw Error('存在其他修改：' + c.name);
    }
    for (const c of edits.reverse())
      replace(root, { name: c.name, after: c.before });
    replace(root, { name: journal, after: null });
  } finally {
    fs.unlinkSync(lock);
  }
}

export function block(text, id, body, expected) {
  const start = '<!-- aipart:' + id + ' -->';
  const end = '<!-- /aipart:' + id + ' -->';
  const managed = start + '\n' + body + '\n' + end;
  const original = text ?? '';
  if (!original.includes(start) && !original.includes(end)) {
    if (expected !== undefined) throw Error('受管段落已删除：' + id);
    return (
      original +
      (original && !original.endsWith('\n') ? '\n' : '') +
      managed +
      '\n'
    );
  }
  const i = original.indexOf(start),
    j = original.indexOf(end);
  if (
    i < 0 ||
    j < i ||
    original.indexOf(start, i + 1) >= 0 ||
    original.indexOf(end, j + 1) >= 0
  )
    throw Error('段落标记冲突：' + id);
  const prior = original.slice(i, j + end.length);
  if (prior !== start + '\n' + (expected ?? body) + '\n' + end)
    throw Error('请先核对手工修改的段落：' + id);
  return original.slice(0, i) + managed + original.slice(j + end.length);
}
