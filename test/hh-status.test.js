import test from 'node:test';
import assert from 'node:assert/strict';
import { listNegotiations } from '../src/hh-status.js';

function pageWithNegotiations() {
  let currentUrl = '';
  return {
    goto: async (url) => { currentUrl = url; },
    waitForTimeout: async () => {},
    url: () => currentUrl,
    locator: (selector) => selector === 'body'
      ? { innerText: async () => 'Отклики Ожидание' }
      : { count: async () => 0 },
    evaluate: async () => {
      if (currentUrl.includes('state=READ') && !currentUrl.includes('state=UNREAD')) {
        return [{ id: '101', title: 'AI-инженер', company: 'Альфа', text: 'просмотрено' }];
      }
      if (currentUrl.includes('state=UNREAD') && !currentUrl.includes('state=READ')) {
        return [{ id: '102', title: 'Директолог', company: 'Бета', text: 'не просмотрено' }];
      }
      return [];
    }
  };
}

test('READ становится viewed, а UNREAD остаётся sent', async () => {
  const rows = await listNegotiations(pageWithNegotiations(), { hh: { base: 'https://hh.ru' } });
  assert.deepEqual(
    Object.fromEntries(rows.map((r) => [r.id, r.status])),
    { '101': 'viewed', '102': 'sent' }
  );
});
