import test from 'node:test';
import assert from 'node:assert/strict';
import {
  excerpt, vacancyText, truncateHtml, isOwnerUpdate, MAIN_KEYBOARD,
  vacancyKeyboard, manualApplyKeyboard
} from '../src/tg.js';

test('excerpt режет длинный текст по границе слова', () => {
  const text = `${'слово '.repeat(40)}конец`;
  const cut = excerpt(text, 100);
  assert.ok(cut.length <= 101);
  assert.ok(cut.endsWith('…'));
});

test('excerpt оставляет короткий текст как есть', () => {
  assert.equal(excerpt('Короткое описание.'), 'Короткое описание.');
});

test('карточка вакансии показывает опыт и описание', () => {
  const text = vacancyText({
    id: '1',
    title: 'AI-инженер',
    company: 'ООО Тест',
    salary: '100 000 ₽',
    experience: 'between1And3',
    score: 80,
    resume: 'ai',
    reason: 'ai, ии',
    snippet: 'Делать чат-ботов на LLM и автоматизировать поддержку.'
  });
  assert.match(text, /Опыт: 1–3 года/);
  assert.match(text, /О вакансии/);
  assert.match(text, /чат-ботов на LLM/);
});

test('зарплата экранируется, чтобы HTML не ломался', () => {
  const text = vacancyText({
    id: '1', title: 'AI-инженер', company: 'C', salary: '100 <b>₽</b>', score: 80, resume: 'ai'
  });
  assert.ok(text.includes('100 &lt;b&gt;₽&lt;/b&gt;'));
});

test('truncateHtml не оставляет незакрытый тег', () => {
  const cut = truncateHtml(`${'a'.repeat(3995)}<b>текст</b>`, 3998);
  assert.ok(cut.endsWith('…'));
  assert.ok(!cut.includes('<'));
});

test('truncateHtml не режет &entity пополам', () => {
  const cut = truncateHtml(`${'a'.repeat(3994)}&amp;`, 3998);
  assert.ok(cut.endsWith('…'));
  assert.ok(!cut.includes('&'));
});

test('обновления принимаются только из чата владельца', () => {
  assert.equal(isOwnerUpdate({ message: { chat: { id: 42 } } }, '42'), true);
  assert.equal(isOwnerUpdate({ message: { chat: { id: 43 } } }, '42'), false);
  assert.equal(isOwnerUpdate({ callback_query: { message: { chat: { id: 42 } } } }, '42'), true);
  assert.equal(isOwnerUpdate({ callback_query: { id: 'x' } }, '42'), false);
  assert.equal(isOwnerUpdate({ message: { text: '/scan' } }, '42'), false);
});

test('MAIN_KEYBOARD содержит основные команды меню', () => {
  const buttons = MAIN_KEYBOARD.flat().map((b) => b.text);
  for (const cmd of ['/scan', '/direct', '/more', '/chats', '/forms', '/statuses', '/digest', '/stats', '/status', '/blocked', '/help']) {
    assert.ok(buttons.includes(cmd), `не найдена кнопка ${cmd}`);
  }
});

test('vacancyKeyboard добавляет кнопку blk:<id> в пределах лимита callback_data', () => {
  const cfg = { resumes: { ai: { title: 'AI' }, direct: { title: 'Директолог' } } };
  const withCompany = vacancyKeyboard({
    id: '138197375',
    company: 'Очень длинное название компании ООО Международные Технологии Автоматизации'
  }, cfg);
  const row3 = withCompany[2];
  assert.equal(row3.length, 3);
  assert.equal(row3[2].callback_data, 'blk:138197375');
  assert.ok(Buffer.byteLength(row3[2].callback_data, 'utf8') <= 64);

  const withoutCompany = vacancyKeyboard({ id: '138197375', company: '  ' }, cfg);
  assert.equal(withoutCompany[2].length, 2);
});

test('manualApplyKeyboard формирует кнопки для ручного отклика и ретрая', () => {
  const cfg = { hh: { base: 'https://spb.hh.ru' } };
  const manual = manualApplyKeyboard({ id: '9911', url: 'https://spb.hh.ru/vacancy/9911' }, cfg, { resumeKey: 'ai' });
  assert.deepEqual(manual.flat().map((b) => b.callback_data).filter(Boolean), ['apdone:9911:ai', 'apsk:9911']);
  assert.ok(manual.flat().some((b) => b.url && b.url.includes('vacancy_response?vacancyId=9911')));

  const retry = manualApplyKeyboard({ id: '9911' }, cfg, { resumeKey: 'direct', retry: true });
  assert.deepEqual(retry.flat().map((b) => b.callback_data).filter(Boolean), ['ap:9911:direct', 'apdone:9911:direct', 'apsk:9911']);
});
