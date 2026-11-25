import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertChat, upsertVacancy, recordApplication, addMessage, kvSet, recordChatForm, markChatHandled } from '../src/db.js';
import { buildFollowupText, findFollowupCandidates, workingDaysSince, pickSkill } from '../src/followup.js';
import { cleanVacancyTitle } from '../src/hh-chats.js';

test('рабочие дни считаются без выходных', () => {
  assert.equal(workingDaysSince('2026-01-16T12:00:00.000Z', new Date('2026-01-19T12:00:00.000Z')), 1);
  assert.equal(workingDaysSince('2026-01-14T12:00:00.000Z', new Date('2026-01-21T12:00:00.000Z')), 5);
});

test('шаблон подставляет вакансию и релевантный навык', () => {
  // chatId влияет на ротацию: для «102» выпадает шаблон со навыком.
  const text = buildFollowupText({ chatId: '102', vacancy: 'AI-инженер', snippet: 'нужны LLM и промпты' });
  assert.match(text, /AI-инженер/);
  assert.match(text, /LLM/);
  assert.match(pickSkill('воронки и чат-боты'), /чат-ботами/);
});

test('после диалога с работодателем — отдельный шаблон', () => {
  const text = buildFollowupText({ chatId: '101', vacancy: 'Директолог', hadEmployerDialog: true });
  assert.match(text, /Возвращаюсь к нашему диалогу/);
});

test('подпись ссылки «Перейти» не подставляется как вакансия', () => {
  const text = buildFollowupText({ chatId: '102', vacancy: 'Перейти' });
  assert.doesNotMatch(text, /Перейти/);
  assert.match(text, /по моему отклику/);
  assert.equal(cleanVacancyTitle('  Перейти '), '');
  assert.equal(cleanVacancyTitle('AI-инженер'), 'AI-инженер');
});

test('кандидат на follow-up: исходящее сообщение старше 3 рабочих дней', () => {
  const db = openDb(':memory:');
  upsertChat(db, { id: 'c1', title: 'HR', vacancy: 'AI-инженер' });
  upsertVacancy(db, { id: 'v1', title: 'AI-инженер', company: 'C', url: 'u', snippet: 'LLM, промпты', query: 'q' });
  recordApplication(db, { vacancyId: 'v1', resumeKey: 'ai', status: 'applied' });
  addMessage(db, { chatId: 'c1', extId: '10', direction: 'in', text: 'Здравствуйте' });
  addMessage(db, { chatId: 'c1', extId: '11', direction: 'out', text: 'Ответ' });
  db.prepare("UPDATE messages SET created_at = '2026-01-05T10:00:00.000Z' WHERE chat_id = 'c1'").run();

  const found = findFollowupCandidates(db, { minWorkingDays: 3, now: new Date('2026-01-12T10:00:00.000Z') });
  assert.equal(found.length, 1);
  assert.equal(found[0].chatId, 'c1');
  assert.equal(found[0].hadEmployerDialog, true);
  assert.match(found[0].text, /AI-инженер/);

  kvSet(db, 'followupDone:c1', 'proposed');
  assert.equal(findFollowupCandidates(db, { minWorkingDays: 3, now: new Date('2026-01-12T10:00:00.000Z') }).length, 0);
});

test('свежая переписка и отказ не попадают в follow-up', () => {
  const db = openDb(':memory:');
  upsertChat(db, { id: 'c2', title: 'HR', vacancy: 'Директолог' });
  upsertVacancy(db, { id: 'v2', title: 'Директолог', company: 'C', url: 'u', snippet: 'директ', query: 'q' });
  recordApplication(db, { vacancyId: 'v2', resumeKey: 'direct', status: 'applied' });
  db.prepare("UPDATE applications SET hh_status = 'rejected' WHERE vacancy_id = 'v2'").run();
  addMessage(db, { chatId: 'c2', extId: '20', direction: 'out', text: 'Ответ' });
  db.prepare("UPDATE messages SET created_at = '2026-01-05T10:00:00.000Z' WHERE chat_id = 'c2'").run();

  assert.equal(findFollowupCandidates(db, { minWorkingDays: 3, now: new Date('2026-01-12T10:00:00.000Z') }).length, 0);
});

test('чат с незаполненной внешней анкетой не попадает в follow-up до отметки', () => {
  const db = openDb(':memory:');
  try {
    upsertChat(db, { id: 'c3', title: 'HR', vacancy: 'AI-инженер' });
    addMessage(db, { chatId: 'c3', extId: '30', direction: 'out', text: 'Отклик' });
    recordChatForm(db, { chatId: 'c3', url: 'https://forms.gle/pending', msgExtId: '29', status: 'pending' });
    db.prepare("UPDATE messages SET created_at = '2026-01-05T10:00:00.000Z' WHERE chat_id = 'c3'").run();

    assert.equal(findFollowupCandidates(db, { minWorkingDays: 3, now: new Date('2026-01-12T10:00:00.000Z') }).length, 0);

    markChatHandled(db, 'c3', { extId: '29', state: 'form_submitted' });
    assert.equal(findFollowupCandidates(db, { minWorkingDays: 3, now: new Date('2026-01-12T10:00:00.000Z') }).length, 1);
  } finally {
    db.close();
  }
});
