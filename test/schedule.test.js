import test from 'node:test';
import assert from 'node:assert/strict';
import { withinWindow, msUntilWindow, businessDaysBetween } from '../src/schedule.js';

const at = (h, m = 0) => new Date(2026, 0, 15, h, m, 0, 0);

test('окно 10–19', () => {
  assert.equal(withinWindow(at(10), { from: 10, to: 19 }), true);
  assert.equal(withinWindow(at(18, 59), { from: 10, to: 19 }), true);
  assert.equal(withinWindow(at(19), { from: 10, to: 19 }), false);
  assert.equal(withinWindow(at(9), { from: 10, to: 19 }), false);
});

test('без окна отклики разрешены всегда', () => {
  assert.equal(withinWindow(at(3), null), true);
});

test('ночное окно 22–6', () => {
  assert.equal(withinWindow(at(23), { from: 22, to: 6 }), true);
  assert.equal(withinWindow(at(5), { from: 22, to: 6 }), true);
  assert.equal(withinWindow(at(12), { from: 22, to: 6 }), false);
});

test('msUntilWindow считает до открытия окна', () => {
  assert.equal(msUntilWindow(at(8, 30), { from: 10, to: 19 }), 90 * 60 * 1000);
});

test('рабочие дни не считают выходные', () => {
  // Пятница 16.01.2026 → понедельник 19.01.2026: один рабочий день.
  assert.equal(businessDaysBetween(new Date(2026, 0, 16, 12), new Date(2026, 0, 19, 12)), 1);
  // Среда → среда следующей недели: 5 рабочих дней.
  assert.equal(businessDaysBetween(new Date(2026, 0, 14, 12), new Date(2026, 0, 21, 12)), 5);
  // Внутри одного дня — ноль.
  assert.equal(businessDaysBetween(new Date(2026, 0, 14, 9), new Date(2026, 0, 14, 18)), 0);
});
