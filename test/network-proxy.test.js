import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  fetchWithProxy,
  parseMacProxy,
  proxyEnvironment,
} from '../lib/network-proxy.js';

test('提取 macOS Web 代理并保留域名排除项', () => {
  const settings = parseMacProxy(`
<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
    2 : internal.example
  }
  HTTPEnable : 0
  HTTPProxy : 127.0.0.1
  HTTPPort : 7999
  HTTPSEnable : 1
  HTTPSProxy : 127.0.0.1
  HTTPSPort : 7897
}`);
  assert.deepEqual(settings, {
    http: '',
    https: 'http://127.0.0.1:7897',
    noProxy: '*.local,internal.example',
  });
  const explicit = proxyEnvironment({
    https_proxy: 'http://proxy.example:8080',
    NO_PROXY: 'local.example',
  });
  assert.equal(explicit.HTTPS_PROXY, 'http://proxy.example:8080');
  assert.equal(explicit.NO_PROXY, 'localhost,127.0.0.1,[::1],local.example');
  assert.equal(
    proxyEnvironment({
      HTTPS_PROXY: 'http://proxy.example:8080',
      NO_PROXY: '*',
    }).no_proxy,
    '*',
  );
});

test('模型请求使用配置的 HTTP 代理连接远端域名', async (t) => {
  const proxy = http.createServer();
  const connections = [];
  proxy.on('connect', (req, socket) => {
    connections.push(req.url);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', (data) => {
      if (!data.toString().startsWith('GET /v1/models ')) {
        socket.destroy();
        return;
      }
      socket.end(
        'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]',
      );
    });
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const settings = {
    http_proxy: 'http://127.0.0.1:' + proxy.address().port,
    no_proxy: '',
  };
  const previous = Object.fromEntries(
    Object.keys(settings).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, settings);
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise((resolve) => proxy.close(resolve));
  });
  const response = await fetchWithProxy(
    'http://gateway-fixture.invalid/v1/models',
    { signal: AbortSignal.timeout(4500) },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
  assert.deepEqual(connections, ['gateway-fixture.invalid:80']);
});
