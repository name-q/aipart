import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';

const issuer = 'https://auth.openai.com';
export const openAIBase = 'https://api.openai.com/v1';
const scope = 'chatgpt.tokens.use.direct';
const callbackPath = '/auth/callback';
const random = () => randomBytes(32).toString('base64url');
const validClient = (value) =>
  typeof value === 'string' &&
  /^[\w-]{1,200}$/.test(value) &&
  value !== 'dynamic_agent_client';

async function registration() {
  const home = process.env.AIPART_HOME || path.join(homedir(), '.aipart');
  const file = path.join(home, 'chatgpt-registration.json');
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  async function load() {
    if (!(await fs.lstat(file)).isFile())
      throw Error('ChatGPT 注册文件不是普通文件。');
    const info = JSON.parse(await fs.readFile(file, 'utf8'));
    if (
      !/^urn:uuid:[0-9a-f-]{36}$/.test(info.host) ||
      (info.clientId && !validClient(info.clientId))
    )
      throw Error('ChatGPT 注册信息无效。');
    return info;
  }
  let info;
  try {
    info = await load();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    info = { host: 'urn:uuid:' + randomUUID() };
    try {
      await fs.writeFile(file, JSON.stringify(info), {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      info = await load();
    }
  }
  return {
    info,
    async saveClient(clientId) {
      const temp = file + '.' + randomUUID();
      try {
        await fs.writeFile(temp, JSON.stringify({ ...info, clientId }), {
          flag: 'wx',
          mode: 0o600,
        });
        await fs.rename(temp, file);
      } finally {
        await fs.rm(temp, { force: true });
      }
    },
  };
}

function openBrowser(url) {
  const [cmd, ...args] =
    process.platform === 'darwin'
      ? ['open']
      : process.platform === 'win32'
        ? ['rundll32.exe', 'url.dll,FileProtocolHandler']
        : ['xdg-open'];
  const child = spawn(cmd, [...args, url], { stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

async function callback(state, clientId) {
  let resolve;
  let reject;
  const result = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  const server = createServer((req, res) => {
    let address;
    try {
      address = new URL(req.url ?? '/', redirectUri);
    } catch {
      res.writeHead(400).end();
      return;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method !== 'GET' || address.pathname !== callbackPath) {
      res.writeHead(404).end();
      return;
    }
    const q = address.searchParams;
    if (q.getAll('state').length !== 1 || q.get('state') !== state) {
      res.writeHead(400).end('登录请求不匹配。');
      return;
    }
    if (q.has('error')) {
      res.writeHead(400).end('登录未完成，可以返回终端重试。');
      reject(Error('ChatGPT 登录未完成，请重新授权。'));
      return;
    }
    const issued = q.get('client_id') ?? clientId;
    const code = q.get('code');
    if (
      q.getAll('code').length !== 1 ||
      !code ||
      q.getAll('client_id').length > 1 ||
      !validClient(issued) ||
      (clientId && issued !== clientId)
    ) {
      res.writeHead(400).end('登录回调无效。');
      reject(Error('ChatGPT 登录回调无效。'));
      return;
    }
    res.end('已收到授权，可以返回 aipart 终端。');
    resolve({ code, issued });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const redirectUri =
    'http://127.0.0.1:' + server.address().port + callbackPath;
  const timeout = setTimeout(
    () => reject(Error('等待 ChatGPT 浏览器授权超时。')),
    180000,
  );
  return {
    redirectUri,
    result,
    close() {
      clearTimeout(timeout);
      server.close();
    },
  };
}

async function verifyIdentity(idToken, clientId, nonce) {
  const { createRemoteJWKSet, jwtVerify } = await import('jose');
  const jwks = createRemoteJWKSet(new URL(issuer + '/.well-known/jwks.json'));
  try {
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer,
      audience: clientId,
      requiredClaims: ['sub', 'nonce', 'exp'],
    });
    if (payload.nonce !== nonce) throw Error();
  } catch {
    throw Error('无法验证 ChatGPT 登录凭据。');
  }
}

export async function signInWithChatGPT({
  show,
  open = openBrowser,
  newAccount = false,
} = {}) {
  const saved = await registration();
  const clientId = newAccount ? undefined : saved.info.clientId;
  const state = random(),
    nonce = random(),
    verifier = random();
  const login = await callback(state, clientId);
  try {
    const url = new URL(issuer + '/api/accounts/authorize');
    url.search = new URLSearchParams({
      client_id: clientId ?? 'dynamic_agent_client',
      ...(!clientId ? { agent_name_hint: 'aipart' } : {}),
      ext_agent_host_id: saved.info.host,
      response_type: 'code',
      redirect_uri: login.redirectUri,
      scope: 'openid profile email offline_access resource.invoke ' + scope,
      resource: openAIBase,
      state,
      nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    show?.(url.href);
    open(url.href);
    const { code, issued } = await login.result;
    const response = await fetch(issuer + '/api/accounts/oauth/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: issued,
        code,
        code_verifier: verifier,
        redirect_uri: login.redirectUri,
        resource: openAIBase,
      }),
      signal: AbortSignal.timeout(12000),
      redirect: 'error',
    }).catch(() => {
      throw Error('无法连接 ChatGPT 登录服务。');
    });
    const data = await response.json().catch(() => null);
    if (
      !response.ok ||
      typeof data?.id_token !== 'string' ||
      typeof data?.access_token !== 'string' ||
      !data.access_token ||
      /[\s\p{Cc}]/u.test(data.access_token) ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    )
      throw Error('ChatGPT 未返回有效的登录凭据，请重试。');
    await verifyIdentity(data.id_token, issued, nonce);
    await saved.saveClient(issued);
    if (
      typeof data.scope !== 'string' ||
      !data.scope.split(/\s+/).includes(scope)
    )
      throw Error('当前 ChatGPT 账号未授权使用订阅额度。');
    return {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  } finally {
    login.close();
  }
}
