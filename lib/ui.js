import { styleText as style } from 'node:util';

export const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const theme = {
  prefix: { idle: style('cyan', '◆'), done: style('green', '✓') },
  style: { highlight: (text) => style('cyan', text) },
  helpMode: 'always',
};

async function prompts() {
  if (!tty) throw Error('请在交互终端操作，或通过命令参数指定选项');
  return import('@inquirer/prompts');
}

export async function menu(message, choices, selected) {
  return (await prompts()).select({
    message,
    choices,
    default: selected,
    theme,
  });
}

export async function searchableMenu(message, choices) {
  return (await prompts()).search({
    message,
    theme,
    source: (term) => {
      const query = (term ?? '').trim().toLowerCase();
      return choices.filter((choice) =>
        [choice.name, choice.description ?? ''].some((text) =>
          text.toLowerCase().includes(query),
        ),
      );
    },
  });
}

export async function multiple(message, choices) {
  return (await prompts()).checkbox({
    message,
    choices,
    theme,
    required: true,
    instructions: '↑↓ 移动 · 空格勾选 · 回车确认',
  });
}

export async function question(message) {
  return (await prompts()).input({
    message,
    theme,
    validate: (answer) => Boolean(answer.trim()) || '请输入内容',
  });
}

export async function confirm(message) {
  return (await prompts()).confirm({ message, default: false, theme });
}

export function heading(title, detail) {
  console.log(
    '\n' + style(['bold', 'cyan'], '◆ aipart') + '  ' + style('bold', title),
  );
  if (detail) console.log('  ' + detail);
}

export function panel(title, lines) {
  console.log('\n' + style('bold', title));
  for (const line of lines) console.log('  ' + line);
}

export async function progress(label, task) {
  if (!tty) return task();
  const frames = ['◐', '◓', '◑', '◒'];
  let index = 0;
  const tick = () =>
    process.stdout.write(
      '\r\x1b[2K' +
        style('cyan', frames[index++ % frames.length]) +
        ' ' +
        label,
    );
  tick();
  const timer = setInterval(tick, 110);
  try {
    return await task();
  } finally {
    clearInterval(timer);
    process.stdout.write('\r\x1b[2K');
  }
}

export const stagesLabels = {
  guide: '团队指引',
  code: '编辑器和 ESLint',
  commit: '提交前检查',
  ci: 'CI 校验',
};

export function ruleDetails(rule) {
  return [
    rule.decision,
    ...(rule.exceptions ? ['例外 · ' + rule.exceptions] : []),
    '范围 · ' + rule.scope,
    ...Object.entries(rule.stages).map(
      ([key, level]) =>
        stagesLabels[key] +
        ' · ' +
        (rule.enabled === false
          ? '已停用'
          : ({ warn: '提醒', error: '阻断' }[level] ?? '已停用')),
    ),
  ];
}
