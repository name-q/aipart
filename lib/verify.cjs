const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

async function verify(root, rule) {
  const cwd = path.resolve(root, rule.scope);
  const bindings = Object.entries(rule.bindings ?? {}).filter(
    ([stage, b]) => stage === 'code' || b.rule,
  );
  if (!bindings.length) return;
  const api = createRequire(path.join(cwd, 'package.json'))('eslint');
  const Engine = api.loadESLint ? await api.loadESLint({ cwd }) : api.ESLint;
  for (const [stage, b] of bindings) {
    const sample = rule.examples?.[stage];
    const lintRule = b.rule ?? sample?.rule;
    if (
      !sample ||
      !lintRule ||
      typeof sample.file !== 'string' ||
      !sample.file ||
      typeof sample.valid !== 'string' ||
      typeof sample.invalid !== 'string'
    )
      throw Error(stage + ' 需要文件名、规则名和正反两个样例');
    const filePath = path.resolve(root, sample.file);
    const relative = path.relative(cwd, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw Error('样例不在规则范围内');
    const engine = new Engine({
      cwd,
      ...(b.rule
        ? {
            overrideConfig: {
              rules: { [lintRule]: [rule.stages[stage], ...b.options] },
            },
          }
        : {}),
    });
    if (await engine.isPathIgnored(filePath))
      throw Error('项目 ESLint 已忽略样例路径：' + sample.file);
    for (const [key, expect] of [
      ['valid', false],
      ['invalid', true],
      ['exception', false],
    ]) {
      if (key === 'exception' && sample[key] === undefined) continue;
      const [result] = await engine.lintText(sample[key], { filePath });
      if (result.messages.some((m) => m.fatal))
        throw Error(stage + ' 样例解析失败');
      const matching = result.messages.filter((m) => m.ruleId === lintRule);
      if (
        Boolean(matching.length) !== expect ||
        matching.some(
          (m) => m.severity !== (rule.stages[stage] === 'error' ? 2 : 1),
        )
      )
        throw Error(stage + ' ' + key + ' 样例与预期不符');
    }
  }
}
if (require.main === module)
  verify(process.cwd(), JSON.parse(fs.readFileSync(0, 'utf8'))).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
