const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

async function check(root, stage) {
  if (!['commit', 'ci'].includes(stage)) throw Error('无效的检查阶段');
  const git = (args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  const read = (name) =>
    stage === 'commit'
      ? git(['show', ':./' + name])
      : fs.readFileSync(path.join(root, name), 'utf8');
  const list = (args) => git(args).split('\0').filter(Boolean);
  const rules = list(['ls-files', '-z', '--', '.aipart/rules/*.json'])
    .map((p) => JSON.parse(read(p)))
    .filter((r) => r.enabled && r.stages[stage] && r.bindings?.[stage]?.rule);
  if (!rules.length) return 0;
  const files =
    stage === 'commit'
      ? list([
          'diff',
          '--cached',
          '--diff-filter=ACMR',
          '--name-only',
          '--relative',
          '-z',
          '--',
          '.',
        ])
      : list(['ls-files', '-z', '--', '.']);
  let failed = false;
  for (const r of rules) {
    const binding = r.bindings[stage];
    const paths = files.filter(
      (f) =>
        /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i.test(f) &&
        (r.scope === '.' || f.startsWith(r.scope + '/')),
    );
    if (!paths.length) continue;
    try {
      const cwd = path.resolve(root, r.scope);
      const requireLocal = createRequire(path.join(cwd, 'package.json'));
      let api;
      try {
        api = requireLocal('eslint');
      } catch {
        throw Error('请在目标应用安装项目使用的 ESLint：' + cwd);
      }
      const Engine = api.loadESLint
        ? await api.loadESLint({ cwd })
        : api.ESLint;
      if (!Engine) throw Error('需要 ESLint 8 或以上');
      const engine = new Engine({
        cwd,
        overrideConfig: {
          rules: { [binding.rule]: [r.stages[stage], ...binding.options] },
        },
      });
      for (const file of paths) {
        const filePath = path.join(root, file);
        if (await engine.isPathIgnored(filePath)) continue;
        if (stage === 'ci' && !fs.existsSync(filePath)) continue;
        const [result] = await engine.lintText(read(file), { filePath });
        for (const m of result.messages) {
          if (!m.fatal && m.ruleId !== binding.rule) continue;
          const blocking = r.stages[stage] === 'error';
          console.error(
            file +
              ':' +
              (m.line ?? 1) +
              ' ' +
              (blocking ? '错误' : '提醒') +
              ' ' +
              r.title +
              ' — ' +
              m.message,
          );
          if (blocking) failed = true;
        }
      }
    } catch (error) {
      if (r.stages[stage] === 'error') throw error;
      console.error('检查未运行：' + r.title + ' — ' + error.message);
    }
  }
  return failed ? 1 : 0;
}
module.exports = { check };
if (require.main === module)
  check(path.dirname(__dirname), process.argv[2])
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 2;
    });
