import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export const databaseName = '.aipart.sqlite';
export const dataPrefix = '@data/';
export const localPrefix = '@local/';
export const manifest = '@data/project';
export const legacyManifest = '.aipart/project.json';
export const ruleName = (id) => '@data/rules/' + id;
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
  if (!write && !fs.existsSync(file)) return null;
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink())
    throw Error('规则库不能是符号链接');
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
