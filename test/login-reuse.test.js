import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { withDatabase } from '../lib/storage.js';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/aipart.js', import.meta.url));
const sessionUrl = new URL('../lib/credential-session.js', import.meta.url)
  .href;
const apiUrl = new URL('../lib/api-client.js', import.meta.url).href;

test('下次启动复用登录及原服务地址，限权保留记录，401 清除记录', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aipart-login-reuse-'));
  const cwd = path.join(temp, 'project');
  fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const secret = 'aipart-test-secret';
  let status = 200;
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + secret) {
      res.writeHead(401).end();
      return;
    }
    requests++;
    for await (const chunk of req) {
      void chunk;
    }
    res.setHeader('Content-Type', 'application/json');
    if (status !== 200) {
      res
        .writeHead(status)
        .end(JSON.stringify({ error: { message: 'test authentication' } }));
      return;
    }
    const text = JSON.stringify({
      summary: '测试项目',
      findings: [],
      recommend: ['guide'],
    });
    res.end(
      JSON.stringify({
        output: [{ content: [{ type: 'output_text', text }] }],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const options = {
    cwd,
    env: {
      ...process.env,
      AIPART_HOME: path.join(temp, 'user'),
      OPENAI_API_KEY: '',
      OPENAI_BASE_URL: 'https://unselected.invalid/v1',
    },
  };
  const initialize = () =>
    run(
      process.execPath,
      [cli, 'init', '--ai', 'openai', '--model', 'fixture-model', '--yes'],
      options,
    );

  await run(
    process.execPath,
    [cli, 'init', '--ai', 'openai', '--offline'],
    options,
  );
  await run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const {credentialSession} = await import(process.argv[1]);
    const {useApiKey} = await import(process.argv[2]);
    const session = credentialSession(process.cwd());
    useApiKey('openai',process.argv[3],process.argv[4]);
    session.changed('openai');
    session.verified('openai');
  `,
      sessionUrl,
      apiUrl,
      secret,
      'http://127.0.0.1:' + server.address().port + '/v1',
    ],
    options,
  );
  const file = path.join(cwd, '.aipart');
  const count = () =>
    withDatabase(
      file,
      false,
      (db) => db.prepare('SELECT count(*) AS n FROM login_credentials').get().n,
    );
  assert.equal(count(), 1);
  assert.equal(fs.readFileSync(file).includes(secret), false);

  assert.match((await initialize()).stdout, /测试项目/);
  assert.equal(requests, 1);
  status = 403;
  await assert.rejects(initialize(), /检查 API Key 和项目权限/);
  assert.equal(count(), 1);
  status = 401;
  await assert.rejects(initialize(), /检查 API Key 和项目权限/);
  assert.equal(count(), 0);
  assert.equal(requests, 3);
  await assert.rejects(initialize(), /请选择使用 ChatGPT 登录/);
  assert.equal(requests, 3);
});
