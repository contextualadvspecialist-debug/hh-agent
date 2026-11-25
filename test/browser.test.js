import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthError, looksLoggedOut, assertLoggedIn, checkLoggedIn } from '../src/browser.js';

function fakePage({ url = 'https://spb.hh.ru/', body = '', selectorCounts = {} } = {}) {
  return {
    url: () => url,
    async goto(target) { url = target; },
    async waitForTimeout() {},
    locator(selector) {
      if (selector === 'body') {
        return {
          async innerText() { return body; }
        };
      }
      return {
        async count() {
          return selectorCounts[selector] ?? 0;
        }
      };
    }
  };
}

test('looksLoggedOut определяет разлогин по URL логина', async () => {
  assert.equal(await looksLoggedOut(fakePage({ url: 'https://hh.ru/account/login' })), true);
  assert.equal(await looksLoggedOut(fakePage({ url: 'https://hh.ru/logon?backurl=%2F' })), true);
});

test('looksLoggedOut определяет разлогин по тексту формы без UI кабинета', async () => {
  assert.equal(await looksLoggedOut(fakePage({ body: 'Вход в личный кабинет\nВойти с паролем' })), true);
});

test('looksLoggedOut не даёт ложное срабатывание при наличии UI кабинета', async () => {
  const byBody = fakePage({ body: 'Мои резюме\nВойти с паролем' });
  assert.equal(await looksLoggedOut(byBody), false);

  const byQa = fakePage({
    body: 'Войти с паролем',
    selectorCounts: { '[data-qa="chatik-layout"], [data-qa="mainmenu_applicantProfile"], [data-qa="mainmenu_profile"]': 1 }
  });
  assert.equal(await looksLoggedOut(byQa), false);
});

test('assertLoggedIn бросает AuthError только при разлогине', async () => {
  await assert.rejects(
    () => assertLoggedIn(fakePage({ url: 'https://hh.ru/account/login' }), 'сессия истекла'),
    (err) => err instanceof AuthError && err.message === 'сессия истекла'
  );
  await assertLoggedIn(fakePage({ body: 'Резюме и профиль' }));
});

test('checkLoggedIn проверяет редирект, капчу, форму входа и меню профиля', async () => {
  const cfg = { hh: { base: 'https://spb.hh.ru' } };

  const loginPage = {
    async goto() {},
    async waitForTimeout() {},
    url: () => 'https://spb.hh.ru/account/login',
    locator: () => ({ innerText: async () => '', count: async () => 0 })
  };
  assert.equal(await checkLoggedIn(loginPage, cfg), false);

  assert.equal(await checkLoggedIn(fakePage({ body: 'Подтвердите, что вы не робот' }), cfg), false);
  assert.equal(await checkLoggedIn(fakePage({ body: 'Войти с паролем\nОбязательное поле' }), cfg), false);

  assert.equal(await checkLoggedIn(fakePage({
    selectorCounts: { '[data-qa="mainmenu_applicantProfile"], [data-qa="mainmenu_profile"]': 1 }
  }), cfg), true);
  assert.equal(await checkLoggedIn(fakePage({ body: 'Отклики и приглашения' }), cfg), true);
});
