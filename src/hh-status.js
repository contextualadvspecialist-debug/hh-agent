import { CaptchaError, detectCaptcha, safeBodyText } from './hh-search.js';

// hh размечает состояние переговоров вкладками-фильтрами: ?state=INTERVIEW и т.д.
const STATE_FILTERS = [
  { query: 'state=INVITATION', status: 'invitation' },
  { query: 'state=INTERVIEW', status: 'invitation' },
  { query: 'state=HIRED', status: 'hired' },
  { query: 'state=DISCARD', status: 'rejected' },
  { query: 'state=READ', status: 'viewed' },
  { query: 'state=UNREAD', status: 'sent' }
];

const PAGE_SIZE = 20;
const MAX_PAGES = 10;

async function readCards(page) {
  return page.evaluate(() => {
    const clean = (s) => String(s ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('[data-qa="negotiations-item"]')].map((card) => {
      const a = card.querySelector('a[href*="/vacancy/"]');
      const id = (a?.getAttribute('href')?.match(/vacancy\/(\d+)/) || [])[1] ?? '';
      if (!id) return null;
      return {
        id,
        title: clean(card.querySelector('[data-qa="negotiations-item-vacancy"]')?.innerText),
        company: clean(card.querySelector('[data-qa="negotiations-item-company"]')?.innerText),
        text: clean(card.innerText).slice(0, 600)
      };
    }).filter(Boolean);
  });
}

export async function listNegotiations(page, cfg) {
  const base = `${cfg.hh.base}/applicant/negotiations?filter=all&`;

  await page.goto(`${base}state=READ&state=UNREAD`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  if (await detectCaptcha(page)) throw new CaptchaError('капча в переговорах');

  const body = await safeBodyText(page);
  if (/Войти с паролем/.test(body) && !/Отклики|Ожидание/.test(body)) {
    throw new Error('нет логина на hh.ru');
  }

  const byId = new Map();
  for (const { query, status } of STATE_FILTERS) {
    for (let p = 0; p < MAX_PAGES; p++) {
      await page.goto(`${base}${query}&page=${p}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1600);
      if (await detectCaptcha(page)) throw new CaptchaError('капча в переговорах');

      const cards = await readCards(page);
      for (const card of cards) {
        if (!byId.has(card.id)) byId.set(card.id, { ...card, status });
      }
      if (cards.length < PAGE_SIZE) break;
    }
  }

  return [...byId.values()].map(({ text, ...item }) => ({ ...item, text }));
}
