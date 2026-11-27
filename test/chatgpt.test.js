import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { signInWithChatGPT } from '../lib/chatgpt-auth.js';
import {
  apiModels,
  apiReply,
  useApiKey,
  useChatGPT,
} from '../lib/api-client.js';

test('浏览器授权后读取账号模型目录，并流式执行用户选中的模型', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aipart-chatgpt-'));
  const originalHome = process.env.AIPART_HOME;
  const originalBase = process.env.OPENAI_BASE_URL;
  const nativeFetch = globalThis.fetch;
  process.env.AIPART_HOME = home;
  process.env.OPENAI_BASE_URL = 'https://unused.example/v1';
  t.after(async () => {
    useApiKey('openai', 'test-key');
    if (originalHome === undefined) delete process.env.AIPART_HOME;
    else process.env.AIPART_HOME = originalHome;
    if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = originalBase;
    globalThis.fetch = nativeFetch;
    await fs.rm(home, { recursive: true, force: true });
  });
  const issuer = 'https://auth.openai.com';
  const clientId = 'oaiapp_fixture';
  const model = 'future-model-sol';
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: 'aipart-test',
    alg: 'RS256',
  };
  let authorization;
  const requests = [];
  globalThis.fetch = async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === '127.0.0.1') return nativeFetch(input, options);
    requests.push(url.href);
    if (url.href === issuer + '/api/accounts/oauth/token') {
      const form = options.body;
      const expectedChallenge =
        authorization.searchParams.get('code_challenge');
      assert.equal(
        createHash('sha256')
          .update(form.get('code_verifier'))
          .digest('base64url'),
        expectedChallenge,
      );
      assert.equal(form.get('client_id'), clientId);
      assert.equal(form.get('code'), 'short-lived-code');
      const identity = await new SignJWT({
        nonce: authorization.searchParams.get('nonce'),
      })
        .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
        .setIssuer(issuer)
        .setAudience(clientId)
        .setSubject('fixture-user')
        .setExpirationTime('3m')
        .sign(privateKey);
      return Response.json({
        id_token: identity,
        access_token: 'fixture-oauth-token',
        expires_in: 1800,
        scope: 'openid chatgpt.tokens.use.direct',
      });
    }
    if (url.href === issuer + '/.well-known/jwks.json')
      return Response.json({ keys: [jwk] });
    assert.equal(options.headers.Authorization, 'Bearer fixture-oauth-token');
    if (url.href === 'https://api.openai.com/v1/models') {
      return Response.json({
        models: [
          { slug: 'hidden-model', visibility: 'hide' },
          { slug: model, visibility: 'list', display_name: 'Future Model' },
        ],
      });
    }
    assert.equal(url.href, 'https://api.openai.com/v1/responses');
    assert.deepEqual(JSON.parse(options.body), {
      model,
      input: [{ role: 'user', content: '回复 JSON' }],
      store: false,
      stream: true,
    });
    const events = [
      { type: 'response.output_text.delta', delta: '{"ok":' },
      { type: 'response.output_text.delta', delta: 'true}' },
      { type: 'response.completed' },
    ];
    return new Response(
      events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  };
  function open(url) {
    authorization = new URL(url);
    const redirect = new URL(authorization.searchParams.get('redirect_uri'));
    redirect.search = new URLSearchParams({
      state: authorization.searchParams.get('state'),
      code: 'short-lived-code',
      client_id: clientId,
    });
    pages.push(
      nativeFetch(redirect).then(async (response) => ({
        type: response.headers.get('content-type'),
        body: await response.text(),
      })),
    );
  }
  const pages = [];
  useChatGPT(await signInWithChatGPT({ open }));
  assert.equal(
    authorization.searchParams.get('client_id'),
    'dynamic_agent_client',
  );
  const registration = await fs.readFile(
    path.join(home, 'chatgpt-registration.json'),
    'utf8',
  );
  assert.deepEqual(Object.keys(JSON.parse(registration)).sort(), [
    'clientId',
    'host',
  ]);
  assert.ok(!registration.includes('fixture-oauth-token'));
  assert.deepEqual(await apiModels('openai'), [
    { id: model, label: 'Future Model' },
  ]);
  assert.deepEqual(
    await apiReply('openai', model, [{ role: 'user', content: '回复 JSON' }]),
    { model, text: '{"ok":true}' },
  );
  useChatGPT(await signInWithChatGPT({ open }));
  assert.equal(authorization.searchParams.get('client_id'), clientId);
  const page = await pages[0];
  assert.match(page.type, /^text\/html/);
  assert.match(page.body, /登录成功/);
  assert.match(page.body, /data:image\/png;base64,/);
  assert.equal(requests.filter((url) => url.endsWith('/v1/models')).length, 1);
});
