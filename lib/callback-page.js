import fs from 'node:fs';

const logo =
  'data:image/png;base64,' +
  fs.readFileSync(new URL('./assets/logo.png', import.meta.url), 'base64');

const escape = (text) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );

export function callbackPage({ ok, title, detail }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>aipart · ${escape(title)}</title>
<style>
:root {
  --bg: #fbf8f3;
  --card: #ffffff;
  --text: #2b2118;
  --muted: #7a6a5c;
  --line: #f0e4d4;
  --accent: #f07800;
  --state: ${ok ? '#2f9e5b' : '#d0452f'};
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17120e;
    --card: #221b15;
    --text: #f5ece2;
    --muted: #b3a291;
    --line: #3a2e24;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px 16px;
  background: radial-gradient(circle at 50% 0%, rgba(240,120,0,.12), transparent 60%), var(--bg);
  color: var(--text);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif;
}
main {
  width: 100%;
  max-width: 420px;
  padding: 40px 32px 32px;
  text-align: center;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 20px;
  box-shadow: 0 12px 40px rgba(90, 50, 10, .08);
}
img { width: 96px; height: 96px; border-radius: 22px; }
.brand { margin: 12px 0 28px; font-weight: 600; letter-spacing: .08em; color: var(--accent); }
.state {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 4px 12px; border-radius: 999px;
  font-size: 13px; color: var(--state);
  background: color-mix(in srgb, var(--state) 12%, transparent);
}
.state::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
h1 { margin: 16px 0 8px; font-size: 22px; }
p { margin: 0; color: var(--muted); }
footer { margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); }
code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text); }
</style>
</head>
<body>
<main>
  <img src="${logo}" alt="aipart">
  <div class="brand">AIPART</div>
  <span class="state">${ok ? 'ChatGPT 已授权' : '授权未完成'}</span>
  <h1>${escape(title)}</h1>
  <p>${escape(detail)}</p>
  <footer>可以关闭此页面，回到运行 <code>aipart</code> 的终端</footer>
</main>
</body>
</html>`;
}
