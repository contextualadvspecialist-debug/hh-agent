import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { searchQuery, getVacancyDetails, detectCaptcha, CaptchaError } from '../src/hh-search.js';

const SERP_BASE = 'https://spb.hh.ru/search/vacancy';
const VAC_URL = 'https://spb.hh.ru/vacancy/12345678';

const SERP_HTML = `<!doctype html>
<html lang="ru">
  <body>
    <div data-qa="captcha" style="display:none">Скрытая капча</div>
    <div data-qa="vacancy-serp__vacancy">
      <a data-qa="serp-item__title" href="/vacancy/12345678?from=serp">AI-инженер / LLM разработчик</a>
      <a data-qa="vacancy-serp__vacancy-employer">ООО\u00a0НейроТех</a>
      <div class="compensation-labels-xyz">
        <div>Удалённо</div>
        <div>150\u00a0000 – 220\u00a0000 ₽</div>
      </div>
      <div data-qa="vacancy-serp__vacancy-work-experience-between1And3">Опыт 1–3 года</div>
      <div data-qa="vacancy-serp__vacancy_snippet_responsibility">Разработка AI-агентов и автоматизация.</div>
      <div data-qa="vacancy-serp__vacancy_snippet_requirement">Опыт работы с LLM API и Python/JS.</div>
      <span data-qa="vacancy-label-work-schedule-remote">Можно удалённо</span>
    </div>
    <div data-qa="vacancy-serp__vacancy">
      <a data-qa="serp-item__title" href="https://spb.hh.ru/vacancy/87654321?query=direct">Специалист по Яндекс Директ</a>
      <a data-qa="vacancy-serp__vacancy-employer">Агентство Трафик</a>
      <div data-qa="vacancy-serp__compensation">По договорённости</div>
      <div data-qa="vacancy-serp__vacancy-work-experience-between3And6">Опыт 3–6 лет</div>
      <div data-qa="vacancy-serp__vacancy_snippet_requirement">Настройка кампаний РСЯ и Поиск.</div>
    </div>
    <div data-qa="vacancy-serp__vacancy">
      <a data-qa="serp-item__title" href="/employer/999">Карточка без id вакансии</a>
    </div>
  </body>
</html>`;

const VACANCY_HTML = `<!doctype html>
<html lang="ru">
  <body>
    <h1 data-qa="vacancy-title">AI-инженер\u00a0(LLM &amp; Автоматизация)</h1>
    <div data-qa="vacancy-company-name">ООО\u00a0НейроТех</div>
    <div data-qa="vacancy-salary">от 180\u00a0000 ₽ на руки</div>
    <div data-qa="vacancy-description">
      <p>Автоматизация процессов и разработка чат-ботов на базе LLM.</p>
      <p>Полностью удалённый формат.</p>
    </div>
  </body>
</html>`;

test('searchQuery, getVacancyDetails и detectCaptcha работают на HTML-фикстурах hh.ru', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    let seenSearchUrl = '';

    await page.route('https://spb.hh.ru/**', async (route) => {
      const url = route.request().url();
      if (url.startsWith(SERP_BASE)) {
        seenSearchUrl = url;
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: SERP_HTML });
      }
      if (url.startsWith(VAC_URL)) {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: VACANCY_HTML });
      }
      if (url.includes('captcha-page')) {
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: '<html><body><p>Подтвердите, что вы не робот</p></body></html>'
        });
      }
      return route.fulfill({ status: 404, body: 'not found' });
    });

    const cfg = { hh: { base: 'https://spb.hh.ru', area: '113', remoteOnly: true, itemsOnPage: 50 } };
    const list = await searchQuery(page, cfg, 'AI-инженер', 1);

    const parsedUrl = new URL(seenSearchUrl);
    assert.equal(parsedUrl.searchParams.get('text'), 'AI-инженер');
    assert.equal(parsedUrl.searchParams.get('order_by'), 'publication_time');
    assert.equal(parsedUrl.searchParams.get('items_on_page'), '50');
    assert.equal(parsedUrl.searchParams.get('page'), '1');
    assert.equal(parsedUrl.searchParams.get('work_format'), 'REMOTE');
    assert.equal(parsedUrl.searchParams.get('area'), '113');

    assert.equal(list.length, 2);
    assert.deepEqual(list[0], {
      id: '12345678',
      experience: 'between1And3',
      title: 'AI-инженер / LLM разработчик',
      company: 'ООО НейроТех',
      salary: '150 000 – 220 000 ₽',
      url: 'https://spb.hh.ru/vacancy/12345678',
      snippet: 'Разработка AI-агентов и автоматизация. Опыт работы с LLM API и Python/JS.',
      remote: true
    });
    assert.equal(list[1].id, '87654321');
    assert.equal(list[1].experience, 'between3And6');
    assert.equal(list[1].salary, 'По договорённости');
    assert.equal(list[1].remote, false);
    assert.equal(list[1].url, 'https://spb.hh.ru/vacancy/87654321');

    // Скрытый блок капчи не должен ложно срабатывать.
    assert.equal(await detectCaptcha(page), false);

    const details = await getVacancyDetails(page, cfg, '12345678');
    assert.deepEqual(details, {
      id: '12345678',
      title: 'AI-инженер (LLM & Автоматизация)',
      company: 'ООО НейроТех',
      salary: 'от 180 000 ₽ на руки',
      snippet: 'Автоматизация процессов и разработка чат-ботов на базе LLM. Полностью удалённый формат.',
      url: 'https://spb.hh.ru/vacancy/12345678'
    });

    await assert.rejects(
      () => getVacancyDetails(page, cfg, 'captcha-page'),
      (e) => e instanceof CaptchaError && /капча/.test(e.message)
    );
    assert.equal(await detectCaptcha(page), true);

    await page.route('https://spb.hh.ru/search/vacancy**', (route) => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<html><body><div data-qa="captcha">Пройдите капчу</div></body></html>'
    }));
    await assert.rejects(
      () => searchQuery(page, cfg, 'AI', 0),
      (e) => e instanceof CaptchaError && /выдаче/.test(e.message)
    );
  } finally {
    await browser.close();
  }
});
