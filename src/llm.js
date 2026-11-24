export function llmReady(llm) {
  return Boolean(llm?.baseUrl && llm?.apiKey && llm?.model);
}

export function makeLlmClient(llm) {
  if (!llmReady(llm)) return null;
  const url = `${llm.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return async function llmChat(messages, opts = {}) {
    const body = {
      model: llm.model,
      messages,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 900
    };
    if (opts.json) body.response_format = { type: 'json_object' };
    const effort = opts.reasoningEffort ?? llm.reasoningEffort;
    if (effort) body.reasoning_effort = effort;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${llm.apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
  };
}
