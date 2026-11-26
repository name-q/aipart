import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/aipart.js', import.meta.url));

for (const provider of ['openai', 'deepseek']) {
  test(
    provider + ' 使用自身 API 列出模型、完成初始化并生成规则草案',
    async (t) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aipart-provider-'));
      t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
      const model = provider === 'openai' ? 'gpt-6.2-sol' : 'deepseek-test';
      const requests = [];
      const token = 'fixture-credentials';
      const route =
        provider === 'openai' ? '/v1/responses' : '/v1/chat/completions';
      const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
        requests.push({
          route: req.url,
          authorization: req.headers.authorization,
          body,
        });
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/v1/models') {
          res.end(
            JSON.stringify({ data: [{ id: 'gpt-image-test' }, { id: model }] }),
          );
          return;
        }
        if (req.url !== route) {
          res.writeHead(404);
          res.end('{}');
          return;
        }
        const messages = body.input ?? body.messages;
        const value = messages[0].content.includes('规则。给出纯 JSON')
          ? {
              draft: {
                title: '数据处理',
                decision: '先复用公共方法',
                request: '统一入口',
                suggestion: '记录项目约定',
                scope: '.',
                stages: { guide: 'warn' },
              },
            }
          : { summary: '项目仅有基础约定', findings: [], recommend: ['guide'] };
        const text = JSON.stringify(value);
        res.end(
          JSON.stringify(
            provider === 'openai'
              ? {
                  output: [
                    {
                      type: 'message',
                      content: [{ type: 'output_text', text }],
                    },
                  ],
                }
              : { choices: [{ message: { content: text } }] },
          ),
        );
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(() => new Promise((resolve) => server.close(resolve)));
      const prefix = provider.toUpperCase();
      const options = {
        cwd,
        env: {
          ...process.env,
          AIPART_HOME: path.join(cwd, 'private'),
          [prefix + '_BASE_URL']:
            'http://127.0.0.1:' + server.address().port + '/v1',
          [prefix + '_API_KEY']: token,
        },
      };
      const init = await execute(
        process.execPath,
        [cli, 'init', '--ai', provider, '--yes'],
        options,
      );
      assert.ok(init.stdout.includes(model));
      await execute(
        process.execPath,
        [cli, 'ask', '统一公共方法', '--stages', 'guide', '--yes'],
        options,
      );
      const { stdout } = await execute(
        process.execPath,
        [cli, 'check', '--json'],
        options,
      );
      const status = JSON.parse(stdout);
      assert.equal(status.ai, provider);
      assert.equal(
        status.rules.find((r) => r.title === '数据处理').decision,
        '先复用公共方法',
      );
      assert.deepEqual(
        requests.map((r) => r.route),
        ['/v1/models', route, route],
      );
      assert.ok(requests.every((r) => r.authorization === 'Bearer ' + token));
      assert.ok(requests.slice(1).every((r) => r.body.model === model));
      assert.ok(
        !fs.readFileSync(path.join(cwd, '.aipart.sqlite')).includes(token),
      );
      if (provider === 'openai')
        assert.ok(requests.slice(1).every((r) => r.body.store === false));
    },
  );
}
