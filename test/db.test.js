import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, upsertVacancy, hasVacancy, setScore, getVacancy,
  recordApplication, countApplicationsSince, addMessage, listMessages, upsertChat,
  setVacancyFit, snippetFingerprint, listRuleScored, getApplication, markApplicationDelivered,
  setApplicationHhStatus, applicationFunnel, applicationFunnelByQuery, purgeLowVacancies,
  recordChatForm, getChatForm, markChatHandled, getChatHandled, countPendingChatForms
} from '../src/db.js';

test('схема создаёт индексы для частых фильтров и сортировок', () => {
  const db = openDb(':memory:');
  try {
    const names = (table) => db.prepare(`PRAGMA index_list(${table})`).all().map((r) => r.name);
    assert.ok(names('vacancies').includes('idx_vac_found_at'));
    assert.ok(names('vacancies').includes('idx_vac_score'));
    assert.ok(names('applications').includes('idx_app_applied_at'));
    assert.ok(names('applications').includes('idx_app_hh_status'));
  } finally {
    db.close();
  }
});

test('вакансия не дублируется и хранит скоринг', () => {
  const db = openDb(':memory:');
  upsertVacancy(db, { id: '1', title: 'Директолог', company: 'A', url: 'u', snippet: 's', query: 'q' });
  upsertVacancy(db, { id: '1', title: 'Директолог', company: 'A', url: 'u', snippet: 's', query: 'q' });
  assert.equal(hasVacancy(db, '1'), true);
  setScore(db, '1', { score: 88, reason: 'совпало', resume: 'direct' });
  const v = getVacancy(db, '1');
  assert.equal(v.score, 88);
  assert.equal(v.resume, 'direct');
});

test('дневной лимит считает только успешные отклики', () => {
  const db = openDb(':memory:');
  const now = new Date().toISOString();
  recordApplication(db, { vacancyId: '1', status: 'applied', appliedAt: now });
  recordApplication(db, { vacancyId: '2', status: 'manual' });
  recordApplication(db, { vacancyId: '3', status: 'captcha' });
  const from = new Date(Date.now() - 3600_000).toISOString();
  assert.equal(countApplicationsSince(db, from), 1);
});

test('повторная запись отклика обновляет письмо, резюме и подпись', () => {
  const db = openDb(':memory:');
  recordApplication(db, { vacancyId: '9', resumeKey: 'direct', resumeId: 'r1', letter: 'старое', status: 'captcha' });
  recordApplication(db, { vacancyId: '9', resumeKey: 'ai', resumeId: 'r2', letter: 'новое', status: 'applied' });
  const a = getApplication(db, '9');
  assert.equal(a.status, 'applied');
  assert.equal(a.letter, 'новое');
  assert.equal(a.resume_key, 'ai');
  assert.equal(a.resume_id, 'r2');
});

test('отклик, подтверждённый hh, перестаёт быть captcha/manual', () => {
  const db = openDb(':memory:');
  recordApplication(db, { vacancyId: '7', status: 'captcha', error: 'капча после отправки' });
  assert.equal(markApplicationDelivered(db, '7'), true);
  const a = getApplication(db, '7');
  assert.equal(a.status, 'applied');
  assert.equal(a.error, '');
  assert.equal(markApplicationDelivered(db, '7'), false);
});

test('воронка группирует отклики по резюме и запросу', () => {
  const db = openDb(':memory:');
  upsertVacancy(db, { id: 'v1', title: 'AI', company: 'C', url: 'u', snippet: 's', query: 'q1' });
  upsertVacancy(db, { id: 'v2', title: 'DIR', company: 'C', url: 'u', snippet: 's', query: 'q2' });
  recordApplication(db, { vacancyId: 'v1', resumeKey: 'ai', status: 'applied' });
  recordApplication(db, { vacancyId: 'v2', resumeKey: 'direct', status: 'applied' });
  setApplicationHhStatus(db, 'v1', 'invitation');
  setApplicationHhStatus(db, 'v2', 'rejected');

  const byResume = applicationFunnel(db);
  assert.deepEqual(
    byResume.map((r) => [r.key, r.status, r.n]).sort(),
    [['ai', 'invitation', 1], ['direct', 'rejected', 1]]
  );
  const byQuery = applicationFunnelByQuery(db);
  assert.deepEqual(
    byQuery.map((r) => [r.key, r.status]).sort(),
    [['q1', 'invitation'], ['q2', 'rejected']]
  );
});

test('чистка удаляет старые low-вакансии, но не тронутые откликами', () => {
  const db = openDb(':memory:');
  upsertVacancy(db, { id: 'old', title: 'T', company: 'C', url: 'u', snippet: 's', query: 'q' });
  upsertVacancy(db, { id: 'used', title: 'T2', company: 'C', url: 'u', snippet: 's', query: 'q' });
  db.prepare("UPDATE vacancies SET status = 'low', found_at = '2020-01-01T00:00:00.000Z'").run();
  recordApplication(db, { vacancyId: 'used', status: 'applied' });
  assert.equal(purgeLowVacancies(db, '2021-01-01T00:00:00.000Z'), 1);
  assert.equal(hasVacancy(db, 'old'), false);
  assert.equal(hasVacancy(db, 'used'), true);
});

test('разбор кэшируется по описанию, а не по времени', () => {
  const db = openDb(':memory:');
  upsertVacancy(db, { id: '1', title: 'T', company: 'C', url: 'u', snippet: 'описание', query: 'q' });
  setVacancyFit(db, '1', 'Откликаться: да', snippetFingerprint('описание'));
  const v = getVacancy(db, '1');
  assert.equal(v.fit, 'Откликаться: да');
  assert.equal(v.fit_src, snippetFingerprint('описание'));
  assert.notEqual(snippetFingerprint('описание'), snippetFingerprint('описание изменилось'));
});

test('переоценка берёт только пограничные и не тронутые LLM', () => {
  const db = openDb(':memory:');
  for (const id of ['a', 'b', 'c', 'd']) {
    upsertVacancy(db, { id, title: id, company: 'C', url: 'u', snippet: 's', query: 'q' });
  }
  setScore(db, 'a', { score: 57, reason: 'AI: ai', resume: 'ai' });
  setScore(db, 'b', { score: 57, reason: 'LLM', resume: 'ai', by: 'llm', llmAt: new Date().toISOString() });
  setScore(db, 'c', { score: 30, reason: 'AI: ai', resume: 'ai' });
  setScore(db, 'd', { score: 55, reason: 'AI: ai', resume: 'direct' });
  for (const id of ['a', 'b', 'c', 'd']) db.prepare("UPDATE vacancies SET status = 'low' WHERE id = ?").run(id);
  const rows = listRuleScored(db, 50, 59, 20);
  assert.deepEqual(rows.map((r) => r.id).sort(), ['a', 'd']);
});

test('сообщения дедуплицируются по ext_id', () => {
  const db = openDb(':memory:');
  upsertChat(db, { id: 'c1', title: 'HR' });
  assert.equal(addMessage(db, { chatId: 'c1', extId: '101', direction: 'in', text: 'Привет' }), true);
  assert.equal(addMessage(db, { chatId: 'c1', extId: '101', direction: 'in', text: 'Привет' }), false);
  assert.equal(addMessage(db, { chatId: 'c1', extId: '102', direction: 'out', text: 'Здравствуйте' }), true);
  assert.equal(listMessages(db, 'c1').length, 2);
});

test('повторное чтение исправляет направление ранее сохранённого сообщения', () => {
  const db = openDb(':memory:');
  try {
    upsertChat(db, { id: 'c1', title: 'HR' });
    assert.equal(addMessage(db, { chatId: 'c1', extId: '101', direction: 'out', text: 'Вопрос ИИ' }), true);
    assert.equal(addMessage(db, { chatId: 'c1', extId: '101', direction: 'in', text: 'Вопрос ИИ' }), false);
    assert.equal(listMessages(db, 'c1')[0].direction, 'in');
  } finally {
    db.close();
  }
});

test('внешние анкеты и отметка чата переживают повторную запись и мигрируют из kv', () => {
  const db = openDb(':memory:');
  try {
    upsertChat(db, { id: 'c2', title: 'HR' });
    addMessage(db, { chatId: 'c2', extId: '501', direction: 'in', text: 'Заполните форму' });
    db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run('notifiedForm:c2:https://forms.gle/legacy1', '1');
    recordChatForm(db, { chatId: 'c2', url: 'https://forms.gle/new1', msgExtId: '501', status: 'pending' });
    assert.equal(countPendingChatForms(db), 1);

    const res = markChatHandled(db, 'c2', { state: 'form_submitted' });
    assert.equal(res.extId, '501');
    assert.equal(res.formsUpdated, 2);
    assert.equal(countPendingChatForms(db), 0);
    assert.equal(getChatForm(db, 'c2', 'https://forms.gle/legacy1')?.status, 'submitted');
    assert.equal(getChatHandled(db, 'c2')?.extId, '501');

    // Повторное чтение того же сообщения не откатывает submitted обратно в pending.
    recordChatForm(db, { chatId: 'c2', url: 'https://forms.gle/new1', msgExtId: '501', status: 'pending' });
    assert.equal(getChatForm(db, 'c2', 'https://forms.gle/new1')?.status, 'submitted');
  } finally {
    db.close();
  }
});
