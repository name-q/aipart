import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { credentialVault } from '../lib/credential-vault.js';
import { withDatabase, databaseName } from '../lib/storage.js';

test('项目 SQLite 只保存密文且本机密钥可复用，其他机器只读取自己的登录', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aipart-vault-'));
  const project = path.join(temp, 'project');
  const first = path.join(temp, 'first');
  const second = path.join(temp, 'second');
  const previous = process.env.AIPART_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.AIPART_HOME;
    else process.env.AIPART_HOME = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  });
  fs.mkdirSync(project);
  const db = path.join(project, databaseName);
  withDatabase(db, true, () => {});
  const saved = {
    kind: 'api-key',
    key: 'fixture-first-token',
    base: 'https://api.example',
  };
  process.env.AIPART_HOME = first;
  assert.equal(credentialVault(project).save('openai', saved), true);
  assert.deepEqual(credentialVault(project).load('openai'), saved);
  assert.equal(
    fs.readFileSync(path.join(first, 'credential-vault.key')).length,
    32,
  );
  if (process.platform !== 'win32')
    assert.equal(
      fs.statSync(path.join(first, 'credential-vault.key')).mode & 0o777,
      0o600,
    );
  assert.deepEqual(fs.readdirSync(project), [databaseName]);
  assert.equal(fs.readFileSync(db).includes(saved.key), false);
  assert.equal(fs.readFileSync(db).includes(saved.base), false);

  process.env.AIPART_HOME = second;
  assert.equal(credentialVault(project).load('openai'), null);
  credentialVault(project).save('openai', {
    ...saved,
    key: 'fixture-second-token',
  });
  process.env.AIPART_HOME = first;
  assert.deepEqual(credentialVault(project).load('openai'), saved);
  assert.equal(
    credentialVault(project).clear('openai', {
      ...saved,
      key: 'different-token',
    }),
    false,
  );
  assert.equal(credentialVault(project).clear('openai', saved), true);
  process.env.AIPART_HOME = second;
  assert.equal(
    credentialVault(project).load('openai').key,
    'fixture-second-token',
  );
});

test('读取过期登录时从 SQLite 删除对应记录', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aipart-expiry-'));
  const project = path.join(temp, 'project');
  const previous = process.env.AIPART_HOME;
  const now = Date.now;
  t.after(() => {
    Date.now = now;
    if (previous === undefined) delete process.env.AIPART_HOME;
    else process.env.AIPART_HOME = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  });
  fs.mkdirSync(project);
  process.env.AIPART_HOME = path.join(temp, 'home');
  const db = path.join(project, databaseName);
  withDatabase(db, true, () => {});
  const vault = credentialVault(project);
  Date.now = () => 1000;
  assert.equal(
    vault.save('openai', {
      kind: 'chatgpt',
      accessToken: 'fixture-access-token',
      expiresAt: 2000,
    }),
    true,
  );
  assert.equal(vault.load('openai').kind, 'chatgpt');
  Date.now = () => 2000;
  assert.equal(vault.load('openai'), null);
  assert.equal(
    withDatabase(
      db,
      false,
      (sqlite) =>
        sqlite.prepare('SELECT count(*) AS count FROM login_credentials').get()
          .count,
    ),
    0,
  );
});
