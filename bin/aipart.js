#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  tty,
  menu,
  multiple,
  question,
  confirm as approve,
  heading,
  panel,
  progress,
  stagesLabels,
  ruleDetails,
} from '../lib/ui.js';
import { apply, change, json, read, recover } from '../lib/files.js';
import {
  agents,
  findRoot,
  init,
  manifest,
  legacyManifest,
  rules,
} from '../lib/project.js';

import {
  snapshot,
  updateRule,
  stageNames,
  validateScope,
} from '../lib/rules.js';

import { accept, drafts, propose, switchClient } from '../lib/session.js';

import { installHook } from '../lib/hooks.js';
import { check as lint } from '../lib/gate.js';

import { databaseName, dataPrefix, localPrefix } from '../lib/storage.js';
import { pruneLegacy } from '../lib/migrate.js';
import { modelCatalog, connect, signIn } from '../lib/client.js';
import { inspect } from '../lib/inspect.js';
const toolNames = {
  codex: 'Codex',
  claude: 'Claude Code',
  pi: 'Pi',
  cursor: 'Cursor',
};
function changedFiles(edits) {
  return [
    ...new Set(
      edits
        .filter((e) => e.before !== e.after && !e.name.startsWith(localPrefix))
        .map((e) => (e.name.startsWith(dataPrefix) ? databaseName : e.name)),
    ),
  ];
}
const choice = (value, name, description) => ({ value, name, description });
function chooseAgent(selected) {
  return menu(
    '选择你使用的工具',
    agents.map((name) =>
      choice(
        name,
        toolNames[name],
        name === 'cursor'
          ? '复制任务到 Cursor IDE 继续'
          : '沿用本机已登录的客户端',
      ),
    ),
    selected,
  );
}
function toggle(item, stage, enabled) {
  const next = structuredClone(item);
  if (stage) {
    if (!stageNames.includes(stage) || !(stage in next.stages))
      throw Error('规则没有这个阶段');
    next.levels ??= {};
    if (next.stages[stage]) next.levels[stage] = next.stages[stage];
    next.stages[stage] = enabled ? (next.levels[stage] ?? 'warn') : false;
  } else next.enabled = enabled;
  return next;
}
async function main() {
  const {
    values,
    positionals: [cmd, ...args],
  } = parseArgs({
    allowPositionals: true,
    options: {
      ai: { type: 'string' },
      yes: { type: 'boolean' },
      upgrade: { type: 'boolean' },
      help: { type: 'boolean' },
      version: { type: 'boolean' },
      json: { type: 'boolean' },
      scope: { type: 'string' },
      stages: { type: 'string' },
      resume: { type: 'string' },
      team: { type: 'boolean' },
      offline: { type: 'boolean' },
      model: { type: 'string' },
    },
  });
  if (values.version) return console.log('0.1.0');
  if (!cmd || values.help)
    return console.log(
      'aipart init --ai <codex|claude|pi|cursor> [--upgrade] [--model 模型] [--offline] [--yes]\naipart check [--json]\naipart ask [需求] [--scope 路径] [--stages guide,code,commit,ci] [--resume 编号]\naipart ai use <工具> [--team]\naipart accept <草案编号>\naipart enable|disable <规则编号> [阶段]\naipart hooks install\naipart lint <commit|ci>\naipart recover',
    );
  const root = findRoot(process.cwd());
  if (cmd === 'hooks' && args[0] === 'install') {
    snapshot(root);
    return installHook(root);
  }
  if (cmd === 'lint') {
    process.exitCode = await lint(root, args[0] ?? 'ci');
    return;
  }
  if (cmd === 'recover') return recover(root);
  const confirm = () => values.yes || approve('保存以上改动？');
  const sessionModels = new Map();
  const modelFile = (ai) => '@local/model-' + ai + '.txt';
  const selectedModel = (ai) =>
    sessionModels.get(ai) ??
    values.model ??
    read(root, modelFile(ai)) ??
    undefined;
  const login = async (ai, device = false) => {
    if (ai === 'pi')
      panel('Pi 登录', [
        '在 Pi 输入 /login 并选择服务商，完成后退出 Pi 继续。',
      ]);
    try {
      signIn(root, ai, device);
    } catch (error) {
      panel('登录未完成', [error.message]);
    }
  };
  const chooseModel = async (ai, current, { initial = false } = {}) => {
    for (;;) {
      const models = await progress(
        '读取 ' + toolNames[ai] + ' 的模型列表',
        () => modelCatalog(root, ai),
      );
      if (!models.length)
        panel('暂无模型列表', [
          '请确认客户端已安装并登录，或输入已知的模型 ID。',
        ]);
      const selection = await menu(
        '选择 ' + toolNames[ai] + ' 模型',
        [
          ...models.map((m) =>
            choice(
              'model=' + m.id,
              ai === 'claude' ? m.id + ' · ' + m.label : m.label,
              m.description ? m.id + ' · ' + m.description : m.id,
            ),
          ),
          ...(!models.length
            ? [
                choice('login', '登录后刷新列表'),
                choice('refresh', '重新读取模型'),
              ]
            : []),
          choice('manual', '手动输入模型 ID'),
          ...(initial
            ? [
                choice('offline', '仅用本地检查'),
                choice('cancel', '取消初始化'),
              ]
            : [choice('back', '返回连接菜单')]),
        ],
        current ? 'model=' + current : undefined,
      );
      if (selection === 'refresh') continue;
      if (selection === 'login') {
        await login(ai);
        continue;
      }
      if (selection === 'manual')
        return { model: await question('输入模型 ID') };
      return selection.startsWith('model=')
        ? { model: selection.slice(6) }
        : { action: selection };
    }
  };
  const review = async (ai, scope, request, { initial = false } = {}) => {
    if (values.offline) return null;
    if (ai === 'cursor') {
      if (tty) panel('Cursor IDE', ['规则和草案可在 IDE 中继续']);
      return null;
    }
    let model = selectedModel(ai);
    if (initial && tty && !values.model) {
      const selection = await chooseModel(ai, model, { initial: true });
      if (selection.action === 'offline') return null;
      if (selection.action === 'cancel')
        throw Object.assign(Error('已取消'), { name: 'ExitPromptError' });
      model = selection.model;
    }
    for (;;) {
      try {
        const result = await progress(
          '连接 ' + toolNames[ai] + ' 并读取项目',
          () => connect(root, ai, { scope, request, model }),
        );
        if (result.model) sessionModels.set(ai, result.model);
        panel(
          '扫描完成 · ' +
            toolNames[ai] +
            (result.model ? ' / ' + result.model : ''),
          [result.summary, ...result.findings],
        );
        return result;
      } catch (error) {
        if (!tty) throw error;
        panel('连接未完成', [error.message]);
        const action = await menu('接下来怎么做？', [
          choice('model', '选择其他模型'),
          ...(ai === 'codex'
            ? [
                choice('login', '在浏览器登录 ChatGPT', '登录完成后会重新连接'),
                choice('device', '使用设备码登录', '适用于远程终端'),
              ]
            : [
                choice(
                  'login',
                  ai === 'pi' ? '在 Pi 中登录' : '登录 Claude Code',
                ),
              ]),
          choice('retry', '重试连接'),
          choice('offline', '仅用本地检查'),
          choice('cancel', '取消'),
        ]);
        if (action === 'offline') return null;
        if (action === 'cancel')
          throw Object.assign(Error('已取消'), { name: 'ExitPromptError' });
        if (action === 'model') {
          const next = await chooseModel(ai, model);
          if (next.model) model = next.model;
        }
        if (action === 'login' || action === 'device') {
          await login(ai, action === 'device');
          const next = await chooseModel(ai, model);
          if (next.model) model = next.model;
        }
      }
    }
  };
  const ask = async (request) => {
    let stages = values.stages;
    if (tty && !request && !values.resume)
      request = await question('希望项目遵循哪条规则？');
    if (!stages && tty && !values.resume) {
      const scope = validateScope(root, values.scope ?? '.');
      const scan = await review(values.ai ?? snapshot(root).ai, scope, request);
      const ci = inspect(root, scope).ci;
      stages = (
        await multiple('规则在哪里生效？', [
          {
            ...choice('guide', stagesLabels.guide, '记录业务约定，供团队参考'),
            checked: !scan || scan.recommend.includes('guide'),
          },
          {
            ...choice('code', stagesLabels.code, '编辑或运行 lint 时反馈'),
            checked: scan?.recommend.includes('code'),
          },
          {
            ...choice('commit', stagesLabels.commit, '只检查本次暂存的文件'),
            checked: scan?.recommend.includes('commit'),
          },
          ...(ci.length
            ? [
                {
                  ...choice('ci', stagesLabels.ci, '接入项目已有流水线'),
                  checked: scan?.recommend.includes('ci'),
                },
              ]
            : []),
        ])
      ).join(',');
    }
    await propose(
      root,
      {
        ai: values.ai,
        model: selectedModel(values.ai ?? snapshot(root).ai),
        request,
        scope: values.scope ?? '.',
        stages: (stages || 'guide').split(',').map((s) => s.trim()),
        resume: values.resume,
      },
      question,
      tty || values.yes ? confirm : null,
    );
  };
  const select = async (name) => {
    const edits = switchClient(root, name, values.team);
    const files = changedFiles(edits);
    panel('切换工具', [toolNames[name], ...files]);
    if (!tty || (await confirm())) apply(root, edits);
  };
  const dashboard = async () => {
    while (true) {
      const state = snapshot(root);
      const enabled = state.rules.filter((r) => r.enabled);
      heading(
        '项目控制台',
        toolNames[state.ai] +
          '  ·  ' +
          enabled.length +
          '/' +
          state.rules.length +
          ' 条规则启用',
      );
      if (state.issues.length) panel('需要处理', state.issues);
      const action = await menu('下一步', [
        choice('view', '查看规则', '查看生效范围、校验方式和业务例外'),
        choice('add', '新增规则', '根据当前项目选择规则和校验位置'),
        choice('toggle', '启用或停用', '调整整条规则或其中一个执行阶段'),
        choice('switch', '切换工具', '使用另一款工具继续'),
        choice('draft', '继续草案', '恢复未完成的规则'),
        choice('quit', '退出'),
      ]);
      if (action === 'quit') return;
      try {
        if (action === 'add') await ask('');
        if (action === 'switch') await select(await chooseAgent(state.ai));
        if (action === 'draft') {
          const list = drafts(root);
          if (!list.length) panel('草案', ['暂无草案']);
          else {
            const resume = await menu('选择草案', [
              ...list.map((id) => choice(id, id)),
              choice('', '返回'),
            ]);
            if (resume)
              await propose(
                root,
                {
                  resume,
                  model: selectedModel(state.ai),
                },
                question,
                confirm,
              );
          }
        }
        if (action === 'view' || action === 'toggle') {
          const id = await menu('选择规则', [
            ...state.rules.map((r) =>
              choice(r.id, (r.enabled ? '●  ' : '○  ') + r.title, r.scope),
            ),
            choice('', '返回'),
          ]);
          if (!id) continue;
          const rule = state.rules.find((r) => r.id === id);
          if (action === 'view') {
            panel(rule.title, ruleDetails(rule));
            await menu('规则详情', [choice('back', '返回控制台')]);
          } else {
            const stage = await menu('选择执行阶段', [
              choice('all', '整条规则'),
              ...Object.keys(rule.stages).map((key) =>
                choice(key, stagesLabels[key]),
              ),
              choice('', '返回'),
            ]);
            if (!stage) continue;
            const key = stage === 'all' ? undefined : stage;
            const next = toggle(
              rule,
              key,
              !(key ? rule.stages[key] : rule.enabled),
            );
            if (await confirm()) apply(root, updateRule(root, next, rule));
          }
        }
      } catch (error) {
        if (
          error.name === 'ExitPromptError' ||
          error.name === 'AbortPromptError'
        )
          throw error;
        panel('操作未完成', [error.message]);
      }
    }
  };
  if (cmd === 'init') {
    if (tty)
      heading('项目设置', '选择工具  →  选择模型  →  检查项目  →  管理规则');
    const selected =
      read(root, manifest) === null ? undefined : snapshot(root).ai;
    const ai = values.ai ?? (await chooseAgent(selected));
    const migrating =
      read(root, manifest) === null && read(root, legacyManifest) !== null;
    const edits = init(root, ai, values.upgrade);
    const scan = await review(ai, '.', '', { initial: true });
    if (scan?.model) edits.push(change(root, modelFile(ai), scan.model));
    if ((selected && selected !== ai) || migrating) {
      const personal = edits.find((e) => e.name === '@local/settings.json');
      if (personal) personal.after = json({ ai });
      else edits.push(change(root, '@local/settings.json', json({ ai })));
    }
    const env = inspect(root);
    console.log(
      '工程配置：' +
        ([...env.files, ...env.packages.map((p) => p.file), ...env.ci].join(
          ' ',
        ) || '未发现'),
    );
    const files = changedFiles(edits);
    if (edits.some((e) => e.before !== e.after)) {
      panel('将写入', files.length ? files : ['本机连接设置']);
      if (!tty || (await confirm())) apply(root, edits);
      else return;
      if (migrating) {
        pruneLegacy(root);
        if (rules(root).some((r) => r.bindings?.commit?.rule)) {
          try {
            installHook(root);
          } catch (error) {
            console.error(error.message);
          }
        }
        if (read(root, '.aipart/gate.cjs') !== null)
          panel('保留了旧目录中的自定义文件', [
            '请检查 .aipart/gate.cjs 的调用并按需清理。',
          ]);
      }
    }
    if (tty) return dashboard();
    const state = snapshot(root);
    panel('项目检查', [
      state.rules.filter((rule) => rule.enabled).length + ' 条规则启用',
      ...state.issues,
    ]);
    if (state.issues.length) process.exitCode = 1;
    return;
  }
  if (cmd === 'ask') return ask(args.join(' '));
  if (cmd === 'accept') return accept(root, args[0], confirm);
  if (cmd === 'ai' && args[0] === 'use') return select(args[1]);
  if (cmd === 'check') {
    if (read(root, manifest) === null) {
      const status = read(root, legacyManifest)
        ? '检测到旧版配置'
        : read(root, 'AGENTS.md') === null
          ? '未接入'
          : '已有项目指引，尚未接入';
      console.log(
        values.json
          ? JSON.stringify({ initialized: false, status })
          : status + '，请运行 aipart init',
      );
      return;
    }
    const state = snapshot(root);
    if (values.json) {
      console.log(JSON.stringify(state, null, 2));
      if (state.issues.length) process.exitCode = 1;
      return;
    }
    if (tty) return dashboard();
    console.log(
      '当前 ' +
        state.ai +
        ' · 项目推荐 ' +
        state.defaultAI +
        ' · 模板 ' +
        state.template +
        ' · 启用 ' +
        state.rules.filter((r) => r.enabled).length +
        ' 条 · CI ' +
        (state.ci.join(', ') || '未发现'),
    );
    for (const rule of state.rules)
      console.log(
        rule.id,
        rule.enabled ? '开' : '关',
        rule.title,
        JSON.stringify(rule.stages),
      );
    for (const issue of state.issues) console.error(issue);
    if (state.issues.length) process.exitCode = 1;
    return;
  }
  if (cmd === 'enable' || cmd === 'disable') {
    const item = rules(root).find((r) => r.id === args[0]);
    if (!item) throw Error('没有这个规则');
    const next = toggle(item, args[1], cmd === 'enable');
    apply(root, updateRule(root, next, item));
    return;
  }
  throw Error('未知命令：' + [cmd, ...args].join(' '));
}
main().catch((e) => {
  if (e.name === 'ExitPromptError' || e.name === 'AbortPromptError') return;
  console.error(e.message);
  process.exitCode = 1;
});
