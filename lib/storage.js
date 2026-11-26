import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export const databaseName = '.aipart';
export const previousDatabaseName = '.aipart.sqlite';
export const dataPrefix = '@data/';
export const localPrefix = '@local/';
export const manifest = '@data/project';
export const ruleName = (id) => '@data/rules/' + id;

const entry = (file) => fs.lstatSync(file, { throwIfNoEntry: false });

export function hasDatabase(dir) {
  return [databaseName, previousDatabaseName].some((name) =>
    entry(path.join(dir, name))?.isFile(),
  );
}

export function renameDatabase(root) {
  const previous = entry(path.join(root, previousDatabaseName));
  if (!previous) return false;
  const current = entry(path.join(root, databaseName));
  if (current?.isDirectory())
    throw Error('项目里的 .aipart 目录来自更早的版本，请先移走后再运行');
  if (current)
    throw Error('项目中同时存在 .aipart 和 .aipart.sqlite，请保留其中一个');
  if (!previous.isFile()) throw Error('.aipart.sqlite 不是普通文件');
  fs.renameSync(
    path.join(root, previousDatabaseName),
    path.join(root, databaseName),
  );
  return true;
}
export function localRoot(root) {
  const id = createHash('sha256').update(fs.realpathSync(root)).digest('hex');
  return path.join(
    process.env.AIPART_HOME || path.join(homedir(), '.aipart'),
    'projects',
    id,
  );
}

let databaseConstructor;
function sqlite() {
  if (databaseConstructor) return databaseConstructor;
  const emitWarning = process.emitWarning;
  // Node 22 loads this notice synchronously with the built-in module.
  process.emitWarning = function (message, ...options) {
    if (
      message ===
        'SQLite is an experimental feature and might change at any time' &&
      options[0] === 'ExperimentalWarning'
    )
      return;
    return Reflect.apply(emitWarning, this, [message, ...options]);
  };
  try {
    databaseConstructor =
      process.getBuiltinModule?.('node:sqlite')?.DatabaseSync;
  } finally {
    process.emitWarning = emitWarning;
  }
  if (!databaseConstructor) throw Error('规则库需要 Node.js 22.13 或更新版本');
  return databaseConstructor;
}

export function withDatabase(file, write, action) {
  const info = entry(file);
  if (!write && !info) return null;
  if (info?.isSymbolicLink()) throw Error('规则库不能是符号链接');
  if (info && !info.isFile())
    throw Error('项目里的 .aipart 不是规则库文件，请先移走后再运行');
  const Database = sqlite();
  const db = new Database(file, { readOnly: !write });
  try {
    db.exec('PRAGMA busy_timeout = 3000');
    if (write)
      db.exec(
        'CREATE TABLE IF NOT EXISTS entries (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID',
      );
    return action(db);
  } finally {
    db.close();
  }
}

export function listData(file, prefix) {
  return (
    withDatabase(file, false, (db) =>
      db
        .prepare(
          'SELECT key, value FROM entries WHERE substr(key,1,?) = ? ORDER BY key',
        )
        .all(prefix.length, prefix),
    ) ?? []
  );
}
