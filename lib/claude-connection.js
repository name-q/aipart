const official = 'https://api.anthropic.com';
let connection;

export function configureClaude({ base, key, header = 'api-key' }) {
  const token = key.trim();
  if (!token || /[\s\p{Cc}]/u.test(token))
    throw Error('Claude API Key 格式无效。');
  if (!base && header !== 'api-key')
    throw Error('官方入口使用 Anthropic API Key。');
  let url;
  try {
    url = new URL(base?.trim() || official);
  } catch {
    throw Error('请输入有效的 Claude 服务地址。');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error(
      '请填写 HTTPS 服务地址，本地回环可用 HTTP。地址中应只有主机和路径。',
    );
  if (!['api-key', 'bearer'].includes(header))
    throw Error('Claude 认证方式无效。');
  const cleanPath = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/v1(?:\/messages)?$/, '');
  const endpoint = url.origin + cleanPath;
  connection = { endpoint, header, token };
  return endpoint;
}

export function useLocalClaude() {
  connection = undefined;
}

export function claudeEnv() {
  if (!connection) {
    if (
      process.env.ANTHROPIC_BASE_URL &&
      (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) &&
      process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === undefined
    )
      return {
        ...process.env,
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
      };
    return process.env;
  }
  const env = { ...process.env };
  for (const name of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_CUSTOM_HEADERS',
    'ANTHROPIC_PROFILE',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_MANTLE',
    'CLAUDE_CODE_USE_VERTEX',
  ])
    delete env[name];
  return {
    ...env,
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
    ANTHROPIC_BASE_URL: connection.endpoint,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY:
      connection.endpoint === official ? '0' : '1',
    [connection.header === 'bearer'
      ? 'ANTHROPIC_AUTH_TOKEN'
      : 'ANTHROPIC_API_KEY']: connection.token,
  };
}

export async function configuredClaudeModels() {
  const selected = connection;
  if (!selected) return null;
  const headers = {
    'anthropic-version': '2023-06-01',
    ...(selected.header === 'bearer'
      ? { Authorization: 'Bearer ' + selected.token }
      : { 'x-api-key': selected.token }),
  };
  const models = [];
  const cursors = new Set();
  const url = new URL(selected.endpoint + '/v1/models');
  url.searchParams.set('limit', '1000');
  for (;;) {
    let response;
    try {
      response = await fetch(url, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(7000),
      });
    } catch {
      throw Error(
        '无法从所选 Claude 服务读取模型列表，请检查地址或手动输入模型 ID。',
      );
    }
    if (response.status === 401 || response.status === 403)
      throw Error('Claude 服务拒绝访问，请检查 Key 和认证方式。');
    if (response.status === 404 || response.status === 405)
      throw Error('此 Claude 服务未提供模型列表，可以手动输入模型 ID。');
    if (!response.ok)
      throw Error('Claude 模型列表请求失败（HTTP ' + response.status + '）。');
    const data = await response.json().catch(() => null);
    if (!Array.isArray(data?.data))
      throw Error('Claude 服务未返回可读取的模型列表，可以手动输入模型 ID。');
    for (const entry of data.data) {
      if (typeof entry?.id !== 'string') continue;
      models.push({
        id: entry.id,
        label: entry.display_name,
        description: entry.description,
      });
    }
    const cursor = data.last_id;
    if (
      !data.has_more ||
      typeof cursor !== 'string' ||
      !cursor ||
      cursors.has(cursor)
    )
      return models;
    cursors.add(cursor);
    url.searchParams.set('after_id', cursor);
  }
}
