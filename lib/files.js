import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  databaseName,
  dataPrefix,
  localPrefix,
  localRoot,
  withDatabase,
} from './storage.js';

export const json = (value) => JSON.stringify(value, null, 2) + '\n';

export function target(root, name) {
  if (name.startsWith(localPrefix))
    return target(localRoot(root), name.slice(localPrefix.length));
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
  if (name.startsWith(dataPrefix)) {
    return (
      withDatabase(
        target(root, databaseName),
        false,
        (db) =>
          db
            .prepare('SELECT value FROM entries WHERE key = ?')
            .get(name.slice(dataPrefix.length))?.value,
      ) ?? null
    );
  }
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

function writeRows(root, edits) {
  if (!edits.length) return;
  withDatabase(target(root, databaseName), true, (db) => {
    db.exec('BEGIN IMMEDIATE');
    const get = db.prepare('SELECT value FROM entries WHERE key = ?');
    const remove = db.prepare('DELETE FROM entries WHERE key = ?');
    const save = db.prepare(
      'INSERT INTO entries(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    );
    for (const { name, before, after } of edits) {
      const key = name.slice(dataPrefix.length);
      if ((get.get(key)?.value ?? null) !== before)
        throw Error('项目规则已变化，请重试');
      if (after === null) remove.run(key);
      else save.run(key, after);
    }
    db.exec('COMMIT');
  });
}

export function apply(root, changes, validate) {
  if (!changes.some((c) => c.before !== c.after)) return;
  const dir = localRoot(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, 'write.lock');
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST')
      throw Error('项目正在写入；确认进程已结束后运行 aipart recover');
    throw e;
  }
  const journal = '@local/transaction.json';
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
    const files = edits.filter((c) => !c.name.startsWith(dataPrefix));
    const rows = edits.filter((c) => c.name.startsWith(dataPrefix));
    for (const c of files) replace(root, c);
    try {
      validate?.();
      writeRows(root, rows);
    } catch (error) {
      for (const c of files)
        if (read(root, c.name) !== c.after)
          throw Error('验证期间文件已变化，请运行 aipart recover');
      for (const c of [...files].reverse())
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
  const lock = target(root, '@local/write.lock');
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
    const journal = '@local/transaction.json';
    const edits = JSON.parse(read(root, journal) ?? '[]');
    for (const c of edits) {
      if (![c.before, c.after].includes(read(root, c.name)))
        throw Error('存在其他修改：' + c.name);
    }
    const rows = [];
    for (const c of edits.reverse()) {
      if (c.name.startsWith(dataPrefix)) {
        const current = read(root, c.name);
        if (current !== c.before)
          rows.push({ name: c.name, before: current, after: c.before });
      } else replace(root, { name: c.name, after: c.before });
    }
    writeRows(root, rows);
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
