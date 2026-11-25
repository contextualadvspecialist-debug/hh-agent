import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  openDb, closeDb, upsertVacancy, hasVacancy, setScore, getVacancy, listVacancies,
  recordApplication, countApplicationsSince, addMessage, listMessages, upsertChat, getChat, setChatVacancy,
  setVacancyFit, snippetFingerprint, listRuleScored, getApplication, markApplicationDelivered,
  setApplicationHhStatus, applicationFunnel, applicationFunnelByQuery, purgeLowVacancies, archiveStaleNewVacancies,
  recordChatForm, getChatForm, markChatHandled, getChatHandled, countPendingChatForms, listPendingChatForms
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

test('chats хранит vacancy_id, не затирается каталогом и мигрирует старую БД', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const tmpFile = path.join(os.tmpdir(), `hh-agent-mig-${Date.now()}.db`);
  try {
    const legacy = new DatabaseSync(tmpFile);
    legacy.exec(`
      CREATE TABLE vacancies (id TEXT PRIMARY KEY, title TEXT NOT NULL, company TEXT, salary TEXT, url TEXT, snippet TEXT, query TEXT, score INTEGER DEFAULT 0, reason TEXT, resume TEXT, status TEXT DEFAULT 'new', found_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE applications (id INTEGER PRIMARY KEY AUTOINCREMENT, vacancy_id TEXT NOT NULL UNIQUE, resume_key TEXT, resume_id TEXT, letter TEXT, status TEXT NOT NULL, error TEXT, hh_status TEXT DEFAULT '', hh_status_at TEXT DEFAULT '', applied_at TEXT NOT NULL);
      CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT, subtitle TEXT, vacancy TEXT, last_text TEXT, last_ts TEXT, draft TEXT, state TEXT DEFAULT 'new', updated_at TEXT NOT NULL);
    `);
    legacy.prepare("INSERT INTO chats (id, title, vacancy, updated_at) VALUES ('c9', 'HR', 'Маркетолог', '2026-01-01T00:00:00.000Z')").run();
    legacy.close();

    const db = openDb(tmpFile);
    try {
      const idx = db.prepare('PRAGMA index_list(chats)').all().map((r) => r.name);
      assert.ok(idx.includes('idx_chats_vacancy_id'));

      upsertChat(db, { id: 'c9', title: 'HR', vacancy: 'Маркетолог', vacancyId: 'vac-42' });
      upsertChat(db, { id: 'c9', title: 'HR', vacancy: '', vacancyId: '' });
      assert.equal(getChat(db, 'c9')?.vacancy_id, 'vac-42');

      setChatVacancy(db, 'c9', { vacancy: 'AI-инженер', vacancyId: 'vac-99' });
      assert.equal(getChat(db, 'c9')?.vacancy, 'AI-инженер');
      assert.equal(getChat(db, 'c9')?.vacancy_id, 'vac-99');
    } finally {
      closeDb(db);
    }
  } finally {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(`${tmpFile}${suffix}`, { force: true }); } catch { /* Windows WAL handle delay */ }
    }
  }
});

test('archiveStaleNewVacancies переводит старые new в stale, а order=recent поднимает свежие дни', () => {
  const db = openDb(':memory:');
  try {
    for (const id of ['oldHigh', 'day1Low', 'day2Mid', 'day2Top']) {
      upsertVacancy(db, { id, title: id, company: 'C', url: 'u', snippet: 's', query: 'q' });
    }
    setScore(db, 'oldHigh', { score: 95, reason: 'r', resume: 'ai' });
    setScore(db, 'day1Low', { score: 60, reason: 'r', resume: 'ai' });
    setScore(db, 'day2Mid', { score: 70, reason: 'r', resume: 'ai' });
    setScore(db, 'day2Top', { score: 85, reason: 'r', resume: 'ai' });
    db.prepare("UPDATE vacancies SET found_at = '2026-01-01T10:00:00.000Z' WHERE id = 'oldHigh'").run();
    db.prepare("UPDATE vacancies SET found_at = '2026-02-10T12:00:00.000Z' WHERE id = 'day1Low'").run();
    db.prepare("UPDATE vacancies SET found_at = '2026-02-12T15:00:00.000Z' WHERE id = 'day2Mid'").run();
    db.prepare("UPDATE vacancies SET found_at = '2026-02-12T09:00:00.000Z' WHERE id = 'day2Top'").run();

    assert.equal(archiveStaleNewVacancies(db, '2026-02-01T00:00:00.000Z'), 1);
    assert.equal(getVacancy(db, 'oldHigh')?.status, 'stale');
    assert.equal(hasVacancy(db, 'oldHigh'), true);

    const recent = listVacancies(db, 'new', 10, { order: 'recent' });
    assert.deepEqual(recent.map((v) => v.id), ['day2Top', 'day2Mid', 'day1Low']);
  } finally {
    db.close();
  }
});

test('listPendingChatForms возвращает только pending с данными чата и сортировкой по свежести', () => {
  const db = openDb(':memory:');
  try {
    upsertChat(db, { id: 'c1', title: 'Alpha HR', vacancy: 'Директолог', vacancyId: 'v1' });
    upsertChat(db, { id: 'c2', title: '', vacancy: 'AI-менеджер', vacancyId: 'v2' });
    upsertChat(db, { id: 'c3', title: 'Gamma', vacancy: 'Маркетолог', vacancyId: 'v3' });

    recordChatForm(db, { chatId: 'c1', url: 'https://tally.so/r/old1', msgExtId: '10', status: 'pending' });
    recordChatForm(db, { chatId: 'c2', url: 'https://forms.gle/new2', msgExtId: '20', status: 'pending' });
    recordChatForm(db, { chatId: 'c3', url: 'https://forms.gle/done3', msgExtId: '30', status: 'submitted' });

    db.prepare("UPDATE chat_forms SET notified_at = '2026-02-01T10:00:00.000Z' WHERE chat_id = 'c1'").run();
    db.prepare("UPDATE chat_forms SET notified_at = '2026-02-02T10:00:00.000Z' WHERE chat_id = 'c2'").run();

    const rows = listPendingChatForms(db, 10);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].chat_id, 'c2');
    assert.equal(rows[0].title, 'c2');
    assert.equal(rows[0].vacancy, 'AI-менеджер');
    assert.equal(rows[0].vacancy_id, 'v2');
    assert.equal(rows[1].chat_id, 'c1');
    assert.equal(rows[1].title, 'Alpha HR');

    assert.equal(listPendingChatForms(db, 1).length, 1);
  } finally {
    db.close();
  }
});
