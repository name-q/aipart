import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';

export function responseText(response) {
  return (Array.isArray(response?.output) ? response.output : [])
    .flatMap((item) => item?.content ?? [])
    .filter(
      (part) => part?.type === 'output_text' && typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('');
}

export async function readResponsesStream(body) {
  if (!body) throw Error('OpenAI 没有返回可读取的响应。');
  const stream = Readable.fromWeb(body);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let data = [];
  let text = '';
  function readEvent() {
    if (!data.length) return;
    let event;
    try {
      event = JSON.parse(data.join('\n'));
    } catch {
      throw Error('OpenAI 返回了无法解析的响应事件。');
    }
    data = [];
    if (
      event.type === 'response.output_text.delta' &&
      typeof event.delta === 'string'
    )
      text += event.delta;
    if (event.type === 'response.completed')
      return { text: responseText(event.response) || text };
    if (
      ['response.failed', 'response.incomplete', 'error'].includes(event.type)
    ) {
      const code = event.response?.error?.code ?? event.code;
      if (
        typeof code === 'string' &&
        code.startsWith('subscription_sharing_usage')
      )
        throw Error('当前 ChatGPT 订阅额度无法完成此请求。');
      if (code === 'model_not_found')
        throw Object.assign(
          Error('当前 ChatGPT 账号无法使用所选模型，请重新选择。'),
          { code: 'MODEL_UNAVAILABLE' },
        );
      throw Error('OpenAI 提前结束了请求，请重试。');
    }
  }
  try {
    for await (const line of lines) {
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      if (!line) {
        const result = readEvent();
        if (result) return result.text;
      }
    }
    const result = readEvent();
    if (result) return result.text;
    throw Error('OpenAI 响应在完成前中断，请重试。');
  } catch (e) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError')
      throw Object.assign(Error('OpenAI 请求超时，可以重试或切换工具。'), {
        code: 'SCAN_TIMEOUT',
      });
    throw e;
  } finally {
    lines.close();
    stream.destroy();
  }
}
