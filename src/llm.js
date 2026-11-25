import { createJsonPoster } from './http.js';

export function llmReady(llm) {
  return Boolean(llm?.baseUrl && llm?.apiKey && llm?.model);
}

export function makeLlmClient(llm) {
  if (!llmReady(llm)) return null;
  const url = `${llm.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const http = createJsonPoster({ timeoutMs: 90000 });
  async function llmChat(messages, opts = {}) {
    const body = {
      model: llm.model,
      messages,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 900
    };
    if (opts.json) body.response_format = { type: 'json_object' };
    const effort = opts.reasoningEffort ?? llm.reasoningEffort;
    if (effort) body.reasoning_effort = effort;

    const res = await http.post(url, body, {
      headers: { Authorization: `Bearer ${llm.apiKey}` },
      timeoutMs: opts.timeoutMs ?? 90000,
      idempotent: true
    });
    if (!res.ok) {
      throw new Error(`LLM ${res.status}: ${res.text().slice(0, 300)}`);
    }
    const data = res.json();
    return data.choices?.[0]?.message?.content ?? '';
  }
  llmChat.reset = () => http.reset();
  return llmChat;
}
