import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  configureClaude,
  claudeEnv,
  useLocalClaude,
} from '../lib/claude-connection.js';
import { assess, modelCatalog } from '../lib/client.js';
import { apply } from '../lib/files.js';
import { init, rules } from '../lib/project.js';
import { propose } from '../lib/session.js';

test('官方 Key 使用 Anthropic 地址，并隔离继承的网关字段', async (t) => {
  const originalFetch = globalThis.fetch;
  const inherited = {
    ANTHROPIC_BASE_URL: 'https://old.example',
    ANTHROPIC_AUTH_TOKEN: 'old-token',
    CLAUDE_CODE_OAUTH_TOKEN: 'old-oauth',
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer old-token',
  };
  const previous = Object.fromEntries(
    Object.keys(inherited).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, inherited);
  t.after(() => {
    useLocalClaude();
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  configureClaude({ key: 'official-fixture' });
  globalThis.fetch = async (url, options) => {
    assert.equal(url.href, 'https://api.anthropic.com/v1/models?limit=1000');
    assert.equal(options.headers['x-api-key'], 'official-fixture');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'error');
    return Response.json({
      data: [{ id: 'official-fixture-model', display_name: '当前官方模型' }],
    });
  };
  assert.equal(
    (await modelCatalog(process.cwd(), 'claude'))[0].id,
    'official-fixture-model',
  );
  const env = claudeEnv();
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
  assert.equal(env.ANTHROPIC_API_KEY, 'official-fixture');
  for (const name of Object.keys(inherited).filter(
    (name) => name !== 'ANTHROPIC_BASE_URL',
  ))
    assert.equal(env[name], undefined);
  assert.equal(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, '1');
  assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, 'old-token');
});

test('网关模型列表、只读扫描和规则会话使用同一连接', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aipart-claude-config-'));
  const originalFetch = globalThis.fetch;
  const originalPath = process.env.PATH;
  const originalHome = process.env.AIPART_HOME;
  process.env.PATH = cwd + path.delimiter + originalPath;
  process.env.AIPART_HOME = path.join(cwd, 'local');
  t.after(() => {
    useLocalClaude();
    globalThis.fetch = originalFetch;
    process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.AIPART_HOME;
    else process.env.AIPART_HOME = originalHome;
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const model = 'gateway-fixture-model';
  const draft = {
    title: '公共数据处理',
    decision: '复用已有公共方法',
    request: '统一处理',
    suggestion: '保留业务例外',
    scope: '.',
    stages: { guide: 'warn' },
  };
  fs.writeFileSync(
    path.join(cwd, 'claude'),
    [
      '#!/usr/bin/env node',
      'const env=process.env, args=process.argv.slice(2);',
      'if(args[0]==="--version")return;',
      'if(env.ANTHROPIC_BASE_URL!=="https://gateway.example/anthropic" || env.ANTHROPIC_AUTH_TOKEN!=="gateway-fixture" || env.ANTHROPIC_API_KEY)process.exit(7);',
      'if(args[args.indexOf("--model")+1]!==' +
        JSON.stringify(model) +
        ')process.exit(8);',
      'if(args.includes("--print")){console.log(JSON.stringify({result:JSON.stringify({summary:"网关扫描完成",findings:[],recommend:["guide"]})}));return;}',
      'const file=args.at(-1).split("\\n").find(line=>line.startsWith("草案绝对路径：")).slice("草案绝对路径：".length);',
      'require("node:fs").writeFileSync(file,' +
        JSON.stringify(JSON.stringify(draft)) +
        ');',
    ].join('\n'),
    { mode: 0o755 },
  );
  configureClaude({
    base: 'https://gateway.example/anthropic/v1/messages',
    key: 'gateway-fixture',
    header: 'bearer',
  });
  globalThis.fetch = async (url, options) => {
    assert.equal(
      url.href,
      'https://gateway.example/anthropic/v1/models?limit=1000',
    );
    assert.equal(options.headers.Authorization, 'Bearer gateway-fixture');
    assert.equal(options.headers['x-api-key'], undefined);
    return Response.json({ data: [{ id: model }] });
  };
  assert.equal((await modelCatalog(cwd, 'claude'))[0].id, model);
  assert.equal(
    (await assess(cwd, 'claude', { model })).summary,
    '网关扫描完成',
  );
  apply(cwd, init(cwd, 'claude'));
  await propose(
    cwd,
    { ai: 'claude', model, scope: '.', stages: ['guide'], request: '统一处理' },
    () => {
      throw Error('本例已有完整需求');
    },
    () => true,
  );
  assert.equal(
    rules(cwd).find((rule) => rule.title === draft.title).decision,
    draft.decision,
  );
  assert.ok(
    !fs
      .readFileSync(path.join(cwd, '.aipart.sqlite'))
      .includes('gateway-fixture'),
  );
});
