import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { AuthError } from '../src/browser.js';
import { readResponseQuestions, fillResponseAnswers, submitResponseForm, applyToVacancy } from '../src/hh-apply.js';

const FORM_URL = 'https://spb.hh.ru/applicant/vacancy_response?vacancyId=777123';

const MIXED_FORM_HTML = `<!doctype html>
<html lang="ru">
  <body>
    <header>
      <div data-qa="search">
        <input type="text" placeholder="Поиск вакансий" aria-label="Поиск" />
      </div>
    </header>
    <main>
      <form action="/applicant/vacancy_response">
        <div data-qa="vacancy-response-popup">
          <h2>Ответьте на вопросы работодателя</h2>
          <div data-qa="question-1">
            <label for="q_exp">Сколько лет опыта в Яндекс Директ?</label>
            <input id="q_exp" type="text" />
          </div>

          <fieldset data-qa="question-2">
            <legend>Формат работы</legend>
            <label style="display:inline-flex;align-items:center;">
              <input type="radio" name="work_format" value="remote" style="opacity:0;width:0;height:0;position:absolute;" />
              <span>Удалённо</span>
            </label>
            <label style="display:inline-flex;align-items:center;">
              <input type="radio" name="work_format" value="office" style="opacity:0;width:0;height:0;position:absolute;" />
              <span>Офис</span>
            </label>
          </fieldset>

          <div data-qa="question-3" role="group">
            <div>Какие площадки вели?</div>
            <label style="display:inline-flex;align-items:center;">
              <input type="checkbox" name="channels" value="yd" style="opacity:0;width:0;height:0;position:absolute;" />
              <span>Яндекс Директ</span>
            </label>
            <label style="display:inline-flex;align-items:center;">
              <input type="checkbox" name="channels" value="vk" style="opacity:0;width:0;height:0;position:absolute;" />
              <span>VK Реклама</span>
            </label>
            <label style="display:inline-flex;align-items:center;">
              <input type="checkbox" name="channels" value="tg" style="opacity:0;width:0;height:0;position:absolute;" />
              <span>Telegram Ads</span>
            </label>
          </div>

          <div data-qa="question-4">
            <label for="q_city">Готовность к релокации</label>
            <select id="q_city">
              <option value="">Выберите вариант</option>
              <option value="yes">Да</option>
              <option value="no">Нет</option>
            </select>
          </div>

          <div data-qa="question-5">
            <p>Расскажите про лучший кейс</p>
            <textarea></textarea>
          </div>

          <textarea name="letter" placeholder="Сопроводительное письмо"></textarea>
        </div>
        <button type="submit" data-qa="vacancy-response-submit-popup">Откликнуться</button>
      </form>
    </main>
  </body>
</html>`;

test('readResponseQuestions и fillResponseAnswers работают со смешанными полями анкеты', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.route((u) => u.href.startsWith(FORM_URL), (route) => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: MIXED_FORM_HTML
    }));
    await page.goto(FORM_URL, { waitUntil: 'domcontentloaded' });

    const questions = await readResponseQuestions(page);
    assert.deepEqual(
      questions.map((q) => ({ index: q.index, type: q.type, options: q.options })),
      [
        { index: 0, type: 'input', options: [] },
        { index: 1, type: 'radio', options: ['Удалённо', 'Офис'] },
        { index: 2, type: 'checkbox', options: ['Яндекс Директ', 'VK Реклама', 'Telegram Ads'] },
        { index: 3, type: 'select', options: ['Да', 'Нет'] },
        { index: 4, type: 'textarea', options: [] }
      ]
    );
    assert.match(questions[0].label, /Яндекс Директ/);
    assert.match(questions[1].label, /Формат работы/);
    assert.match(questions[2].label, /Какие площадки вели/);
    assert.match(questions[3].label, /релокации/);
    assert.match(questions[4].label, /лучший кейс/);

    const filled = await fillResponseAnswers(page, [
      '4 года',
      'Удалённо',
      'Яндекс Директ, Telegram Ads',
      'Нет',
      'Снизил CPL на 35% в SaaS'
    ]);
    assert.deepEqual(filled, { ok: true, count: 5 });

    assert.equal(await page.locator('#q_exp').inputValue(), '4 года');
    assert.equal(await page.locator('input[name="work_format"][value="remote"]').isChecked(), true);
    assert.equal(await page.locator('input[name="channels"][value="yd"]').isChecked(), true);
    assert.equal(await page.locator('input[name="channels"][value="vk"]').isChecked(), false);
    assert.equal(await page.locator('input[name="channels"][value="tg"]').isChecked(), true);
    assert.equal(await page.locator('#q_city').inputValue(), 'no');
    assert.equal(await page.locator('[data-qa="question-5"] textarea').inputValue(), 'Снизил CPL на 35% в SaaS');
    assert.equal(await page.locator('textarea[name="letter"]').inputValue(), '');

    const badSelect = await fillResponseAnswers(page, [
      '4 года',
      'Удалённо',
      'Яндекс Директ',
      'Неизвестно',
      'Кейс'
    ]);
    assert.equal(badSelect.ok, false);
    assert.equal(badSelect.index, 3);
  } finally {
    await browser.close();
  }
});

test('applyToVacancy возвращает questions даже с кнопкой submit и бросает AuthError при разлогине', async () => {
  const lettersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-apply-test-'));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.route((u) => u.href.startsWith(FORM_URL), (route) => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: MIXED_FORM_HTML
    }));
    const cfg = { hh: { base: 'https://spb.hh.ru' }, resumes: {}, paths: { letters: lettersDir } };
    const vacancy = { id: '777123', url: 'https://spb.hh.ru/vacancy/777123' };

    const res = await applyToVacancy(page, cfg, vacancy, 'direct', 'Привет');
    assert.equal(res.status, 'questions');
    assert.equal(res.questions.length, 5);
    assert.equal(fs.existsSync(path.join(lettersDir, '777123-response.html')), true);

    const loginPage = {
      url: () => 'https://spb.hh.ru/account/login',
      async goto() {},
      async waitForTimeout() {},
      locator() {
        return {
          first() { return this; },
          async count() { return 0; },
          async innerText() { return 'Вход в личный кабинет'; }
        };
      }
    };
    await assert.rejects(
      () => applyToVacancy(loginPage, cfg, vacancy, 'direct', 'Привет'),
      (err) => err instanceof AuthError && /истекла/.test(err.message)
    );
  } finally {
    await browser.close();
    fs.rmSync(lettersDir, { recursive: true, force: true });
  }
});

test('checkbox с запятой в названии и одиночный checkbox заполняются корректно', async () => {
  const html = `<!doctype html>
  <html lang="ru"><body><main><form action="/applicant/vacancy_response">
    <div data-qa="vacancy-response-popup">
      <div data-qa="q-comma" role="group">
        <div>Какие связки настраивали?</div>
        <label><input type="checkbox" name="stack" value="ads" /><span>Яндекс Директ, Telegram Ads</span></label>
        <label><input type="checkbox" name="stack" value="seo" /><span>SEO</span></label>
      </div>
      <div data-qa="q-agree">
        <div>Согласие на тестовое</div>
        <label><input type="checkbox" name="agree" value="yes" /><span>Да, готов</span></label>
      </div>
    </div>
  </form></main></body></html>`;

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.route((u) => u.href.startsWith(FORM_URL), (route) => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: html
    }));
    await page.goto(FORM_URL, { waitUntil: 'domcontentloaded' });
    const questions = await readResponseQuestions(page);
    assert.equal(questions.length, 2);
    assert.deepEqual(questions[0].options, ['Яндекс Директ, Telegram Ads', 'SEO']);

    const res = await fillResponseAnswers(page, ['Яндекс Директ, Telegram Ads', 'Да']);
    assert.deepEqual(res, { ok: true, count: 2 });
    assert.equal(await page.locator('input[name="stack"][value="ads"]').isChecked(), true);
    assert.equal(await page.locator('input[name="stack"][value="seo"]').isChecked(), false);
    assert.equal(await page.locator('input[name="agree"]').isChecked(), true);

    const unchecked = await fillResponseAnswers(page, ['SEO', 'Нет']);
    assert.deepEqual(unchecked, { ok: true, count: 2 });
    assert.equal(await page.locator('input[name="stack"][value="seo"]').isChecked(), true);
    assert.equal(await page.locator('input[name="agree"]').isChecked(), false);
  } finally {
    await browser.close();
  }
});

test('applyToVacancy обрабатывает applied, already, closed, alert-ошибку и submitResponseForm', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    let mode = 'apply_ok';

    await page.route((u) => u.href.startsWith(FORM_URL), (route) => {
      if (mode === 'already') {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><body><p>Вы откликнулись на эту вакансию</p></body></html>' });
      }
      if (mode === 'closed') {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><body><p>Вакансия в архиве</p></body></html>' });
      }
      const afterSubmitHtml = mode === 'alert_err'
        ? 'document.body.insertAdjacentHTML("beforeend", "<div role=\\"alert\\">Обязательное поле</div>");'
        : 'document.body.innerHTML = "<p>Отклик отправлен</p>";';
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html lang="ru"><body><main>
          <div data-qa="resume-title">AI-инженер</div>
          <button type="button" data-qa="add-cover-letter" onclick="document.getElementById('let').hidden=false">Добавить письмо</button>
          <textarea id="let" name="letter" hidden></textarea>
          <button type="button" data-qa="vacancy-response-submit-popup" onclick='${afterSubmitHtml}'>Откликнуться</button>
        </main></body></html>`
      });
    });

    const cfg = {
      hh: { base: 'https://spb.hh.ru' },
      resumes: { ai: { title: 'AI' } }
    };
    const vacancy = { id: '777123', url: 'https://spb.hh.ru/vacancy/777123' };

    const ok = await applyToVacancy(page, cfg, vacancy, 'ai', 'Сопроводительное письмо');
    assert.deepEqual(ok, { status: 'applied', resume: 'AI-инженер' });

    mode = 'alert_err';
    const manual = await applyToVacancy(page, cfg, vacancy, 'ai', 'Письмо');
    assert.equal(manual.status, 'manual');
    assert.match(manual.reason, /Обязательное поле/);

    mode = 'apply_ok';
    await page.goto(FORM_URL, { waitUntil: 'domcontentloaded' });
    const submitted = await submitResponseForm(page);
    assert.deepEqual(submitted, { status: 'applied' });

    mode = 'already';
    assert.deepEqual(await applyToVacancy(page, cfg, vacancy, 'ai', 'Письмо'), { status: 'already' });

    mode = 'closed';
    assert.deepEqual(await applyToVacancy(page, cfg, vacancy, 'ai', 'Письмо'), { status: 'closed' });
  } finally {
    await browser.close();
  }
});
