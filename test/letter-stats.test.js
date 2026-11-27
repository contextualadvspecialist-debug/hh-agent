import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLetterLog } from '../scripts/letter-stats.mjs';

test('analyzeLetterLog корректно разбирает строки ok, ретраи, SABOTAGE_RE и уходы в шаблон из src/letter.js', () => {
  const sample = [
    '2026-11-20T10:00:00.000Z letter 100: ok (LLM, 600 зн.)',
    '2026-11-26T10:06:47.179Z letter 139874099: LLM не дал целого письма, ушёл шаблон',
    '2026-11-27T07:50:00.000Z letter 201: ok (LLM, 635 зн.)',
    '2026-11-27T07:51:00.000Z letter 202: ретрай #1 (обрыв/коротко: 210 зн.)',
    '2026-11-27T07:51:05.000Z letter 202: ретрай #2 (штамп/оправдание: "Нет коммерческого опыта с")',
    '2026-11-27T07:51:10.000Z letter 202: ok (LLM, 680 зн., ретраев: 2)',
    '2026-11-27T07:52:00.000Z letter 203: ретрай #1 (зачин: "Откликаюсь на вакансию")',
    '2026-11-27T07:52:05.000Z letter 203: ok (LLM, 620 зн., ретраев: 1)',
    '2026-11-27T07:53:00.000Z letter 204: ретрай #1 (повтор зачина: "работаю с контекстной рекламой")',
    '2026-11-27T07:53:05.000Z letter 204: переписывание не убрало шаблон (повтор зачина: "работаю"), ушёл шаблон',
    '2026-11-27T07:54:00.000Z chats: непрочитанных 0, ждут ответа 0'
  ].join('\n');

  const stats = analyzeLetterLog(sample, {
    days: 3,
    now: Date.parse('2026-11-27T12:00:00.000Z')
  });

  assert.equal(stats.totalLetters, 5);
  assert.equal(stats.llmOk, 3);
  assert.equal(stats.firstTry, 1);
  assert.equal(stats.llmWithRetries, 2);
  assert.equal(stats.totalOkRetries, 3);
  assert.equal(stats.fallbacks, 2);
  assert.equal(stats.retryEvents, 4);
  assert.equal(stats.sabotageHits.get('нет коммерческого опыта с'), 1);
  assert.equal(stats.retryReasons.get('BANNED_OPENING_RE (зачин)'), 1);
  assert.equal(stats.retryReasons.get('повтор зачина / похоже на прошлое'), 1);
  assert.equal(stats.retryReasons.get('SABOTAGE_RE (штамп/оправдание)'), 1);
  assert.equal(stats.retryReasons.get('обрыв / коротко'), 1);
  assert.equal(stats.fallbackReasons.get('LLM не дал целого письма'), 1);
  assert.equal(stats.fallbackReasons.get('переписывание не убрало шаблон (повтор зачина: "работаю")'), 1);
});
