export class CaptchaError extends Error {
  constructor(message = 'hh просит капчу') {
    super(message);
    this.name = 'CaptchaError';
  }
}

const CAPTCHA_TEXT = /подтвердите, что вы не робот|пройдите капчу|не робот/i;

export async function safeBodyText(page) {
  return page.locator('body').innerText().catch(() => '');
}

export async function detectCaptcha(page) {
  const url = page.url();
  if (/captcha|checkcaptcha/i.test(url)) return true;
  // Скрытый виджет в разметке — не капча: иначе уже ушедший отклик записывается как captcha.
  const node = page.locator('[data-qa="captcha"], iframe[src*="captcha"]');
  const count = Math.min(await node.count().catch(() => 0), 5);
  for (let i = 0; i < count; i++) {
    if (await node.nth(i).isVisible().catch(() => false)) return true;
  }
  return CAPTCHA_TEXT.test(await safeBodyText(page));
}

export async function getVacancyDetails(page, cfg, id) {
  await page.goto(`${cfg.hh.base}/vacancy/${id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  if (CAPTCHA_TEXT.test(await safeBodyText(page))) throw new CaptchaError('капча на вакансии');

  return page.evaluate((vacancyId) => {
    const clean = (s) => String(s ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      id: vacancyId,
      title: clean(document.querySelector('[data-qa="vacancy-title"]')?.innerText),
      company: clean(document.querySelector('[data-qa="vacancy-company-name"]')?.innerText),
      salary: clean(document.querySelector('[data-qa="vacancy-salary"]')?.innerText),
      snippet: clean(document.querySelector('[data-qa="vacancy-description"]')?.innerText).slice(0, 6000),
      url: location.href.split('?')[0]
    };
  }, id);
}

export async function searchQuery(page, cfg, query, pageNum = 0) {
  const params = new URLSearchParams({
    text: query,
    order_by: 'publication_time',
    items_on_page: String(cfg.hh.itemsOnPage ?? 50),
    page: String(pageNum)
  });
  if (cfg.hh.remoteOnly) params.set('work_format', 'REMOTE');
  if (cfg.hh.area) params.set('area', String(cfg.hh.area));

  await page.goto(`${cfg.hh.base}/search/vacancy?${params}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const body = await safeBodyText(page);
  if (CAPTCHA_TEXT.test(body)) throw new CaptchaError('капча на выдаче');

  const items = await page.evaluate(() => {
    const norm = (s) => String(s ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('[data-qa="vacancy-serp__vacancy"]')).map((el) => {
      const a = el.querySelector('[data-qa="serp-item__title"]');
      const href = a?.getAttribute('href') ?? '';
      const id = (href.match(/\/vacancy\/(\d+)/) || [])[1] ?? '';
      const snippet = [
        el.querySelector('[data-qa="vacancy-serp__vacancy_snippet_responsibility"]')?.innerText,
        el.querySelector('[data-qa="vacancy-serp__vacancy_snippet_requirement"]')?.innerText
      ].filter(Boolean).join(' ');
      const compEl = el.querySelector('[data-qa="vacancy-serp__compensation"]')
        ?? el.querySelector('[class*="compensation-labels"]');
      const compLines = String(compEl?.innerText ?? '')
        .replace(/\u00a0/g, ' ')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const salaryLine = compLines.find((s) => /₽|руб|\$|€|договор[её]нности/i.test(s)) ?? '';
      const expEl = el.querySelector('[data-qa^="vacancy-serp__vacancy-work-experience-"]');
      return {
        id,
        experience: (expEl?.getAttribute('data-qa') ?? '').replace('vacancy-serp__vacancy-work-experience-', ''),
        title: norm(a?.innerText),
        company: norm(el.querySelector('[data-qa="vacancy-serp__vacancy-employer"]')?.innerText),
        salary: salaryLine,
        url: href ? new URL(href, location.origin).toString().split('?')[0] : '',
        snippet: norm(snippet).slice(0, 700),
        remote: Boolean(el.querySelector('[data-qa="vacancy-label-work-schedule-remote"]'))
      };
    }).filter((v) => v.id && v.title);
  });

  return items;
}
