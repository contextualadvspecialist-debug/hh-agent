import test from 'node:test';
import assert from 'node:assert/strict';
import { isDuplicate, companyKey, isDescriptionDuplicate } from '../src/dedupe.js';

test('та же компания и похожее название — дубль', () => {
  const a = { id: '1', title: 'AI-специалист (удалённо)', company: 'ООО «Ромашка»', salary: '100 000 ₽' };
  const b = { id: '2', title: 'AI специалист', company: 'Ромашка', salary: '' };
  assert.equal(isDuplicate(a, b), true);
});

test('та же вакансия от разных агентств — дубль по названию и зарплате', () => {
  const a = { id: '1', title: 'Промпт-инженер', company: 'Агентство А', salary: '120 000 ₽' };
  const b = { id: '2', title: 'Промпт-инженер', company: 'Агентство Б', salary: 'от 120 000 ₽' };
  assert.equal(isDuplicate(a, b), true);
});

test('одна компания, разные роли — не дубль', () => {
  const a = { id: '1', title: 'Директолог', company: 'Ромашка', salary: '100 000 ₽' };
  const b = { id: '2', title: 'Бухгалтер', company: 'Ромашка', salary: '100 000 ₽' };
  assert.equal(isDuplicate(a, b), false);
});

test('разные компании без зарплаты — не дубль', () => {
  const a = { id: '1', title: 'AI-специалист', company: 'Альфа', salary: '' };
  const b = { id: '2', title: 'AI-специалист', company: 'Бета', salary: '' };
  assert.equal(isDuplicate(a, b), false);
});

test('companyKey убирает юрформу и кавычки', () => {
  assert.equal(companyKey('ООО «Ромашка»'), 'ромашка');
});

test('репост с другим заголовком ловится по тексту требований', () => {
  const text = 'Обязанности: сбор семантики, запуск кампаний в Яндекс Директ, контроль бюджета, отчётность по итогам недели. Требования: опыт от года, внимательность, работа с таблицами и аналитикой. Условия: удалённо, гибкий график, оформление по ТК.';
  const a = { id: '1', title: 'Директолог', company: 'Агентство А', snippet: text };
  const b = { id: '2', title: 'Специалист по контекстной рекламе', company: 'Агентство Б', snippet: text };
  assert.equal(isDuplicate(a, b), false);
  assert.equal(isDescriptionDuplicate(a, b), true);
});

test('короткие описания не считаются дублем по тексту', () => {
  const a = { id: '1', snippet: 'Ищем директолога. Удалённо.' };
  const b = { id: '2', snippet: 'Ищем директолога. Удалённо.' };
  assert.equal(isDescriptionDuplicate(a, b), false);
});
