const CHAT_FRAME = /chatik\.hh\.ru\/chat\//;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;

const norm = (s) => String(s ?? '').replace(/\u00a0/g, ' ').trim();

// В шапке чата рядом с названием стоит ссылка «Перейти» — её текст нельзя
// принимать за вакансию, иначе она уходит в письма и follow-up.
const JUNK_TITLES = new Set(['перейти', 'открыть', 'подробнее', 'вакансия', 'ссылка', 'смотреть']);

export function cleanVacancyTitle(value) {
  const title = norm(value);
  if (!title || JUNK_TITLES.has(title.toLowerCase())) return '';
  return title;
}

async function chatFrame(page, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const frames = page.frames().filter((f) => CHAT_FRAME.test(f.url()));
    if (frames.length) return frames[frames.length - 1];
    await page.waitForTimeout(400);
  }
  return page.mainFrame();
}

export async function listUnreadChats(page, cfg, { onlyUnread = true } = {}) {
  await page.goto(`${cfg.hh.base}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const firstChat = page.locator('a[data-qa^="chatik-open-chat-"]').first();
  await firstChat.waitFor({ timeout: 15000 }).catch(() => {});

  const unread = page.locator('[data-qa="chatik-checkbox-only-unread"]').first();
  if (await unread.count()) {
    const checked = await unread.isChecked().catch(() => false);
    if (checked !== onlyUnread) {
      await unread.evaluate((el) => el.click()).catch(() => {});
      await page.waitForTimeout(2000);
    }
  }

  return page.evaluate(() => {
    const clean = (s) => String(s ?? '').replace(/\u00a0/g, ' ').trim();
    return Array.from(document.querySelectorAll('a[data-qa^="chatik-open-chat-"]')).map((a) => {
      const qa = a.getAttribute('data-qa') ?? '';
      const id = qa.replace('chatik-open-chat-', '');
      return {
        id,
        title: clean(a.querySelector('[data-qa="chat-cell-title"]')?.innerText),
        subtitle: clean(a.querySelector('[data-qa="chat-cell-subtitle"]')?.innerText),
        last: clean(a.querySelector('[data-qa="chat-cell-last-message"]')?.innerText),
        time: clean(a.querySelector('[data-qa="chat-cell-creation-time"]')?.innerText)
      };
    }).filter((c) => /^\d+$/.test(c.id));
  });
}

// Полный список чатов без фильтра «только непрочитанные»: нужен, чтобы видеть переписки,
// где работодатель только просмотрел отклик, но ничего не написал.
export function listAllChats(page, cfg) {
  return listUnreadChats(page, cfg, { onlyUnread: false });
}

function formUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim().replace(/[.,!?;:)\]}]+$/, ''));
  } catch {
    return '';
  }
  if (!['http:', 'https:'].includes(url.protocol)) return '';
  if (url.hostname === 'forms.gle') return url.href;
  if (url.hostname === 'docs.google.com' && url.pathname.startsWith('/forms/')) return url.href;
  if (url.hostname === 'forms.yandex.ru' || url.hostname === 'forms.yandex.com') return url.href;
  return '';
}

export function extractFormLinks(messages) {
  const found = new Set();
  for (const message of messages) {
    const candidates = [
      ...(Array.isArray(message.links) ? message.links : []),
      ...String(message.text ?? '').match(URL_PATTERN) ?? []
    ];
    for (const candidate of candidates) {
      const url = formUrl(candidate);
      if (url) found.add(url);
    }
  }
  return [...found];
}

export async function readChat(page, cfg, chatId) {
  await page.goto(`${cfg.hh.base}/chat/${chatId}`, { waitUntil: 'domcontentloaded' });
  const frame = await chatFrame(page);
  await frame.locator('[data-qa="chatik-layout"]').waitFor({ timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);

  const meta = await frame.evaluate(() => {
    const clean = (s) => String(s ?? '').replace(/\u00a0/g, ' ').trim();
    // Название берём из блока вакансии, а не из ссылки «Перейти»: у ссылки
    // data-qa="chatik-header-vacancy-link-text", у самого заголовка — соседний узел.
    const label = document.querySelector('[data-qa="chatik-header-vacancy-link-text"]');
    const anchor = label?.closest('a') ?? label?.querySelector('a')
      ?? document.querySelector('[data-qa="chatik-header"] a[href*="/vacancy/"]');
    const href = anchor?.getAttribute('href') ?? '';
    const box = anchor?.closest('[data-qa*="vacancy"]') ?? anchor?.parentElement ?? null;
    const raw = clean(box?.innerText);
    return {
      employer: clean(document.querySelector('[data-qa="participant-info-title"]')?.innerText),
      vacancyId: (href.match(/vacancy\/(\d+)/) ?? [])[1] ?? '',
      vacancy: clean(raw.replace(/^\s*Вакансия\s*/i, '').replace(/\s*Перейти\s*$/i, ''))
    };
  });

  const messages = await frame.evaluate(() => {
    const clean = (s) => String(s ?? '').replace(/\u00a0/g, ' ').trim();
    return Array.from(document.querySelectorAll('[data-qa^="chatik-chat-message-"]'))
      .filter((n) => /^chatik-chat-message-\d+$/.test(n.getAttribute('data-qa') ?? ''))
      .map((n) => {
        const extId = (n.getAttribute('data-qa') ?? '').replace('chatik-chat-message-', '');
        const bubble = n.querySelector('[data-qa="chat-bubble-message"]') ?? n;
        const author = clean(bubble.querySelector('[data-qa="chat-bubble-label"]')?.innerText);
        const text = clean(bubble.querySelector('[data-qa="chat-bubble-text"]')?.innerText);
        const links = Array.from(bubble.querySelectorAll('a[href]'))
          .map((a) => {
            try {
              return new URL(a.getAttribute('href'), location.href).href;
            } catch {
              return '';
            }
          })
          .filter(Boolean);
        const ancestorClasses = [];
        for (let el = bubble; el; el = el.parentElement) {
          ancestorClasses.push(typeof el.className === 'string' ? el.className : '');
          if (el === n) break;
        }
        const marker = ancestorClasses.join(' ');
        const outgoing = /\bmagritte-outgoing(?:_|\b)|\bmessage-my(?:_|--|\b)/.test(marker);
        const isAi = /\bmagritte-bot(?:_|\b)/.test(marker);
        return {
          extId,
          author,
          direction: outgoing ? 'out' : 'in',
          isAi,
          text: text || links.join(' '),
          links: [...new Set(links)],
          ts: clean(bubble.querySelector('[data-qa="chat-bubble-display-time"]')?.innerText)
        };
      })
      .filter((m) => m.text || m.links.length);
  });

  return { ...meta, messages };
}

export async function sendChatMessage(page, cfg, chatId, text) {
  if (!page.url().includes(`/chat/${chatId}`)) {
    await page.goto(`${cfg.hh.base}/chat/${chatId}`, { waitUntil: 'domcontentloaded' });
  }
  const frame = await chatFrame(page);
  const input = frame.locator('textarea[data-qa="text-input"]').last();
  await input.waitFor({ timeout: 20000 });

  await input.evaluate((el, value) => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await page.waitForTimeout(800);

  const send = frame.locator('button[aria-label^="Enter"]').first();
  if (await send.count()) await send.click({ force: true });
  else await input.press('Enter');

  await page.waitForTimeout(1800);
  const left = await input.inputValue().catch(() => '');
  if (left.trim()) throw new Error('сообщение не отправилось: поле не очистилось');
  return true;
}
