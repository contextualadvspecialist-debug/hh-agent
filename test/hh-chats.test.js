import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { AuthError } from '../src/browser.js';
import { readChat, extractFormLinks, listUnreadChats, formUrl } from '../src/hh-chats.js';

const CHAT_ID = '5784028368';
const CHAT_URL = `https://spb.hh.ru/chat/${CHAT_ID}`;

// Сниматая с реального чата Bosscourt структура: у исходящего сообщения есть
// magritte-outgoing/message-my, а у ИИ-помощника — magritte-bot и нет
// data-qa="chat-bubble-label".
const CHAT_FIXTURE = `<!doctype html>
<html lang="ru">
  <body>
    <div data-qa="chatik-layout">
      <div data-qa="participant-info-title">Bosscourt SPA &amp; Beauty</div>

      <div data-qa="chatik-chat-message-101">
        <div data-qa="chatik-chat-message-bubble chatik-chat-message-101-text"
             class="magritte-chat-bubble___test magritte-outgoing___test">
          <div class="message--test message-my--test">
            <div data-qa="chat-bubble-message">
              <p data-qa="chat-bubble-text">Мой ответ</p>
              <span data-qa="chat-bubble-display-time">10:29</span>
            </div>
          </div>
        </div>
      </div>

      <div data-qa="chatik-chat-message-102">
        <div data-qa="chatik-chat-message-bubble chatik-chat-message-102-text"
             class="magritte-chat-bubble___test magritte-bot___test">
          <div class="message--test">
            <div data-qa="chat-bubble-message">
              <span class="magritte-label___test">ИИ-помощник</span>
              <p data-qa="chat-bubble-text">Здравствуйте! Я ИИ-помощник hh. Задам несколько вопросов.</p>
              <span data-qa="chat-bubble-display-time">10:30</span>
            </div>
          </div>
        </div>
      </div>

      <div data-qa="chatik-chat-message-103">
        <div data-qa="chatik-chat-message-bubble chatik-chat-message-103-text"
             class="magritte-chat-bubble___test">
          <div class="message--test">
            <div data-qa="chat-bubble-message">
              <span data-qa="chat-bubble-label">Работодатель</span>
              <p data-qa="chat-bubble-text">Уточните, пожалуйста, опыт.</p>
              <span data-qa="chat-bubble-display-time">10:31</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </body>
</html>`;

test('readChat отличает входящее AI-сообщение без подписи от исходящего', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.route(CHAT_URL, (route) => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: CHAT_FIXTURE
    }));

    const result = await readChat(page, { hh: { base: 'https://spb.hh.ru' } }, CHAT_ID);
    const directions = Object.fromEntries(result.messages.map((message) => [message.extId, message.direction]));
    const aiFlags = Object.fromEntries(result.messages.map((message) => [message.extId, message.isAi]));

    assert.deepEqual(directions, {
      '101': 'out',
      '102': 'in',
      '103': 'in'
    });
    assert.deepEqual(aiFlags, {
      '101': false,
      '102': true,
      '103': false
    });
  } finally {
    await browser.close();
  }
});

test('extractFormLinks распознаёт Google и Яндекс Формы и игнорирует обычные ссылки', () => {
  const links = extractFormLinks([
    { text: 'Заполните https://forms.gle/abc123 и https://example.com/about.' },
    { links: ['https://forms.yandex.ru/u/test/', 'https://hh.ru/vacancy/1'], text: '' }
  ]);
  assert.deepEqual(links.sort(), [
    'https://forms.gle/abc123',
    'https://forms.yandex.ru/u/test/'
  ]);
});

test('formUrl и extractFormLinks распознают tally, airtable, typeform, anketolog и marquiz', () => {
  const valid = [
    'https://tally.so/r/wxyz12',
    'https://airtable.com/shrAbc12345',
    'https://company.typeform.com/to/qwe987',
    'https://typeform.com/to/direct12',
    'https://anketolog.ru/s/123456',
    'https://quiz.marquiz.ru/654321abcd',
    'https://mrqz.me/abcd12'
  ];
  for (const url of valid) {
    assert.equal(formUrl(`${url}.`), url);
  }

  const ignored = [
    'https://tally.so/',
    'https://airtable.com/pricing',
    'https://typeform.com/pricing',
    'https://anketolog.ru/pricing',
    'https://anketolog.ru/blog/article',
    'https://hh.ru/vacancy/123'
  ];
  for (const url of ignored) {
    assert.equal(formUrl(url), '');
  }

  const found = extractFormLinks([
    { text: 'Пройдите https://tally.so/r/wxyz12, https://quiz.marquiz.ru/654321abcd)' },
    { links: ['https://airtable.com/appTest/form', 'https://anketolog.ru/pricing'], text: '' }
  ]);
  assert.deepEqual(found.sort(), [
    'https://airtable.com/appTest/form',
    'https://quiz.marquiz.ru/654321abcd',
    'https://tally.so/r/wxyz12'
  ]);
});

test('listUnreadChats бросает AuthError при редиректе на страницу входа hh.ru', async () => {
  const fakePage = {
    url: () => 'https://spb.hh.ru/account/login?backurl=%2Fchat',
    async goto() {},
    async waitForTimeout() {},
    locator() {
      return {
        first() { return this; },
        async waitFor() {},
        async count() { return 0; },
        async innerText() { return 'Вход в личный кабинет'; }
      };
    }
  };

  await assert.rejects(
    () => listUnreadChats(fakePage, { hh: { base: 'https://spb.hh.ru' } }),
    (err) => err instanceof AuthError && /истекла/.test(err.message)
  );
});
