import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { databaseName, withDatabase } from './storage.js';

const keyName = 'credential-vault.key';
const namespace = 'aipart.credentials.v1';
const stat = (file) => fs.lstatSync(file, { throwIfNoEntry: false });

function readKey(file) {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const info = fs.fstatSync(fd);
    if (
      !info.isFile() ||
      info.size !== 32 ||
      (process.platform !== 'win32' &&
        (info.mode & 0o077 || info.uid !== process.getuid()))
    )
      throw Error('本机登录密钥的文件格式或权限不正确。');
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function localKey(root, create) {
  const folder = path.resolve(
    process.env.AIPART_HOME || path.join(homedir(), '.aipart'),
  );
  if (!create && !stat(folder)) return null;
  if (create) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const home = fs.realpathSync(folder);
  const relative = path.relative(fs.realpathSync(root), home);
  if (
    !relative ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith('..' + path.sep))
  )
    throw Error('登录密钥目录必须位于业务项目外，请调整 AIPART_HOME。');
  const file = path.join(home, keyName);
  if (!stat(file)) {
    if (!create) return null;
    const temporary = file + '-' + randomUUID();
    try {
      fs.writeFileSync(temporary, randomBytes(32), { flag: 'wx', mode: 0o600 });
      try {
        fs.linkSync(temporary, file);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  if (!stat(file)?.isFile()) throw Error('本机登录密钥必须是普通文件。');
  return readKey(file);
}

function identifiers(master, provider) {
  const derive = (purpose) =>
    createHmac('sha256', master)
      .update(namespace + ':' + purpose)
      .digest();
  return {
    id: derive('index:' + provider).toString('hex'),
    key: derive('encryption'),
  };
}

function encode(key, id, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(namespace + ':' + id));
  const text = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), text]);
}

function decode(key, id, value) {
  try {
    const bytes = Buffer.from(value);
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(namespace + ':' + id));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        cipher.update(bytes.subarray(28)),
        cipher.final(),
      ]).toString('utf8'),
    );
  } catch {
    throw Error('登录记录无法解密或已损坏，请重新登录。');
  }
}

const hasTable = (db) =>
  Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='login_credentials'",
      )
      .get(),
  );
const row = (db, id) =>
  db.prepare('SELECT encrypted FROM login_credentials WHERE id = ?').get(id)
    ?.encrypted;
const expired = (record) =>
  typeof record.expiresAt === 'number' && record.expiresAt <= Date.now();

export function credentialVault(root) {
  const file = path.join(root, databaseName);

  function remove(id, encrypted) {
    if (!stat(file)) return false;
    return withDatabase(file, true, (db) => {
      db.exec('PRAGMA secure_delete = ON');
      if (!hasTable(db)) return false;
      return Boolean(
        db
          .prepare(
            'DELETE FROM login_credentials WHERE id = ? AND encrypted = ?',
          )
          .run(id, encrypted).changes,
      );
    });
  }

  function read(provider) {
    return withDatabase(file, false, (db) => {
      if (!hasTable(db)) return null;
      const master = localKey(root, false);
      if (!master) return null;
      const { id, key } = identifiers(master, provider);
      const encrypted = row(db, id);
      return encrypted
        ? { id, encrypted, value: decode(key, id, encrypted) }
        : null;
    });
  }

  return {
    load(provider) {
      const record = read(provider);
      if (!record) return null;
      if (expired(record.value)) {
        remove(record.id, record.encrypted);
        return null;
      }
      return record.value;
    },
    save(provider, value) {
      if (!stat(file) || expired(value)) return false;
      const { id, key } = identifiers(localKey(root, true), provider);
      return withDatabase(file, true, (db) => {
        db.exec('PRAGMA secure_delete = ON');
        db.exec(
          'CREATE TABLE IF NOT EXISTS login_credentials (id TEXT PRIMARY KEY, encrypted BLOB NOT NULL) WITHOUT ROWID',
        );
        db.prepare(
          'INSERT INTO login_credentials (id, encrypted) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET encrypted=excluded.encrypted',
        ).run(id, encode(key, id, value));
        return true;
      });
    },
    clear(provider, expected) {
      const record = read(provider);
      if (
        !record ||
        (expected && JSON.stringify(expected) !== JSON.stringify(record.value))
      )
        return false;
      return remove(record.id, record.encrypted);
    },
  };
}
