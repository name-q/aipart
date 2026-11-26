import { spawn } from 'node:child_process';

export function runCodexScan(root, args, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let pending = '';
    let diagnostics = '';
    let lastError = '';
    let answer;
    let started = false;
    let settled = false;

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        child.kill();
        const cleanup = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGKILL');
        }, 1000);
        cleanup.unref();
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      if (error) reject(error);
      else resolve(answer);
    }

    function receive(line) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === 'turn.started') started = true;
      if (
        event.type === 'item.completed' &&
        event.item?.type === 'agent_message'
      )
        answer = event.item.text;
      if (event.type === 'error') lastError = event.message;
      if (event.type === 'turn.failed')
        finish(
          Error(
            event.error?.message ||
              lastError ||
              diagnostics ||
              'Codex 请求失败',
          ),
        );
      if (event.type === 'turn.completed')
        finish(
          answer
            ? undefined
            : Error(lastError || 'Codex 返回了结束事件，但没有回复'),
        );
    }

    const timeout = setTimeout(() => {
      const error = Error(
        started
          ? 'Codex 已启动，但等待模型回复超时。可以切换工具后继续。'
          : 'Codex 启动超时。可以切换工具后继续。',
      );
      finish(Object.assign(error, { code: 'SCAN_TIMEOUT' }));
    }, 90000);

    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      pending += chunk;
      let newline;
      while (!settled && (newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        receive(line);
      }
      if (!settled && pending.length > 8 * 1024 * 1024)
        finish(Error('Codex 返回的单条事件过大'));
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-8192);
    });
    child.on('error', finish);
    child.on('close', (code) => {
      if (pending.trim() && !settled) receive(pending);
      if (!settled)
        finish(
          code === 0 && answer
            ? undefined
            : Error(lastError || diagnostics || 'Codex 会话未完成'),
        );
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}
