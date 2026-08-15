import { getSettings } from './store.js';

export async function chatCompletion({ system, user, temperature = 0.3 }) {
  const { llm } = await getSettings();
  if (!llm.apiKey) {
    const err = new Error('请先在「大模型配置」中填写 DeepSeek API Key（或设置 LLM_API_KEY）');
    err.status = 400;
    throw err;
  }
  if (!llm.enabled) {
    const err = new Error('大模型未启用：请在配置中打开「启用」，或设置 LLM_ENABLED=true');
    err.status = 400;
    throw err;
  }

  const url = `${llm.baseUrl}/chat/completions`;
  const body = {
    model: llm.model || 'deepseek-v4-flash',
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
    temperature,
    // V4 Flash: disable thinking for faster cheap summaries
    thinking: { type: 'disabled' },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${llm.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || `DeepSeek API ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }

  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) {
    const err = new Error('模型未返回内容');
    err.status = 502;
    throw err;
  }

  return {
    text,
    model: data.model || llm.model,
    usage: data.usage || null,
  };
}

export async function summarizeProject({ name, projectPath, readme, meta }) {
  const readmeText = (readme?.content || '').slice(0, 24000);
  const system =
    '你是项目管理助手。根据给定的项目磁盘信息与 README，用简洁中文输出项目说明。' +
    '结构固定为：1) 一句话概述 2) 主要功能（要点列表）3) 技术栈 4) 本地运行方式（若文档有写）5) 当前风险/待办（若能推断）。不要编造文档中没有的信息。';

  const user = [
    `项目名：${name}`,
    `路径：${projectPath}`,
    meta?.status ? `状态：${meta.status}` : '',
    meta?.notes ? `备注：${meta.notes}` : '',
    meta?.url ? `网址：${meta.url}` : '',
    meta?.port ? `端口：${meta.port}` : '',
    '',
    readmeText
      ? `README（${readme.name}）：\n${readmeText}`
      : '（未找到 README，请仅根据路径与元信息做有限说明，并明确指出文档缺失。）',
  ]
    .filter(Boolean)
    .join('\n');

  return chatCompletion({ system, user });
}
