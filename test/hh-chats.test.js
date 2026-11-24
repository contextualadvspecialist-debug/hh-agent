import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { readChat } from '../src/hh-chats.js';

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
