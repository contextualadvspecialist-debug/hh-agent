import fs from 'node:fs';
import path from 'node:path';
import { CaptchaError, detectCaptcha, safeBodyText } from './hh-search.js';

const ALREADY = /Вы откликнулись|Отклик (уже )?отправлен|Резюме отправлено|Отклик уже есть/i;
const CLOSED = /Вакансия в архиве|Отклик недоступен|Вакансия закрыта/i;
// «Тестовое задание» из описания вакансии — не повод бросать отклик: ловим только форму вопросов.
const QUESTIONS = /ответьте на вопросы|ответить на вопросы работодателя/i;

async function currentResume(page) {
  return (await page.locator('[data-qa="resume-title"]').first().innerText().catch(() => '')).trim();
}

async function selectResume(page, cfg, resumeKey) {
  const target = cfg.resumes[resumeKey];
  if (!target?.title) return { ok: true, title: await currentResume(page) };

  let title = await currentResume(page);
  if (title.toLowerCase().includes(target.title.toLowerCase())) return { ok: true, title };

  await page.locator('[data-qa="resume-title"]').first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(900);

  const options = page.locator('[role="option"]');
  const count = await options.count();
  for (let i = 0; i < count; i++) {
    const text = (await options.nth(i).innerText().catch(() => '')).toLowerCase();
    if (!text.includes(target.title.toLowerCase())) continue;
    const radio = options.nth(i).locator('input[type="radio"]');
    if (await radio.count()) await radio.first().evaluate((el) => el.click());
    else await options.nth(i).click({ force: true });
    await page.waitForTimeout(700);
    break;
  }

  title = await currentResume(page);
  return { ok: title.toLowerCase().includes(target.title.toLowerCase()), title };
}

async function addCoverLetter(page, letter) {
  if (!letter) return false;
  const add = page.locator('[data-qa="add-cover-letter"]').first();
  if (await add.count()) {
    await add.click({ force: true }).catch(() => {});
  } else {
    const cell = page.locator('[data-qa="cell"]').filter({ hasText: 'Сопроводительное письмо' }).first();
    if (await cell.count()) await cell.click({ force: true }).catch(() => {});
  }
  await page.waitForTimeout(900);

  const ta = page.locator('textarea').last();
  if (!(await ta.count())) return false;
  await ta.click({ force: true });
  await ta.fill(letter);
  await page.waitForTimeout(400);

  const got = (await ta.inputValue().catch(() => ''));
  const norm = (s) => String(s).replace(/\r\n/g, '\n').replace(/\s+$/, '');
  return norm(got) === norm(letter);
}

// Диагностический снимок формы: только контейнер отклика, без скриптов и стилей —
// иначе в файл попадут токены сессии из __INITIAL_STATE__ и мегабайты разметки.
async function saveResponseSnapshot(page, cfg, vacancyId) {
  if (!cfg?.paths?.letters) return;
  try {
    const html = await page.evaluate(() => {
      const root = document.querySelector('[data-qa="vacancy-response-popup"], main') || document.body;
      const clone = root.cloneNode(true);
      clone.querySelectorAll('script, style, noscript, svg, link[rel="stylesheet"]').forEach((el) => el.remove());
      return clone.innerHTML;
    });
    fs.mkdirSync(cfg.paths.letters, { recursive: true });
    fs.writeFileSync(path.join(cfg.paths.letters, `${vacancyId}-response.html`), html, 'utf8');
  } catch {
    // Снимок не должен мешать переводу отклика в ручной режим.
  }
}

export async function readResponseQuestions(page) {
  return page.evaluate(() => {
    const clean = (s) => String(s ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('textarea')].map((ta, index) => {
      const box = ta.closest('[data-qa*="question"], fieldset, form') ?? ta.parentElement;
      return { index, label: clean(box?.innerText).slice(0, 600) };
    }).filter((q) => q.label);
  });
}

export async function fillResponseAnswers(page, answers) {
  const areas = page.locator('textarea');
  const count = await areas.count();
  if (count !== answers.length) return { ok: false, count };
  const norm = (s) => String(s).replace(/\r\n/g, '\n').replace(/\s+$/, '');
  for (let i = 0; i < count; i++) {
    await areas.nth(i).fill(answers[i]);
    const got = await areas.nth(i).inputValue().catch(() => '');
    if (norm(got) !== norm(answers[i])) return { ok: false, count, index: i };
  }
  return { ok: true, count };
}

export async function submitResponseForm(page) {
  const submit = page.locator('[data-qa="vacancy-response-submit-popup"]').first();
  if (!(await submit.count())) return { status: 'manual', reason: 'нет кнопки отправки' };
  await submit.evaluate((el) => el.click());
  await page.waitForTimeout(4000);

  if (await detectCaptcha(page)) throw new CaptchaError('капча после отправки анкеты');

  const after = await safeBodyText(page);
  if (ALREADY.test(after)) return { status: 'applied' };

  const alert = page.locator('[role="alert"]').first();
  if (await alert.count()) {
    const text = (await alert.innerText().catch(() => '')).trim();
    if (text) return { status: 'manual', reason: `ошибка формы: ${text.slice(0, 200)}` };
  }
  return { status: 'applied' };
}

export async function applyToVacancy(page, cfg, vacancy, resumeKey, letter) {
  const url = `${cfg.hh.base}/applicant/vacancy_response?vacancyId=${vacancy.id}&startedWithQuestion=false&hhtmFrom=vacancy`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2800);

  if (await detectCaptcha(page)) throw new CaptchaError('капча перед откликом');

  const body = await safeBodyText(page);
  if (ALREADY.test(body)) return { status: 'already' };
  if (CLOSED.test(body)) return { status: 'closed' };
  if (QUESTIONS.test(body) && !(await page.locator('[data-qa="vacancy-response-submit-popup"]').count())) {
    await saveResponseSnapshot(page, cfg, vacancy.id);
    // Анкета: форму заполняем только после подтверждения в Telegram, поэтому отдаём вопросы наверх.
    const questions = await readResponseQuestions(page).catch(() => []);
    return { status: 'questions', questions };
  }

  const resume = await selectResume(page, cfg, resumeKey);
  if (!resume.ok) return { status: 'manual', reason: `резюме не переключилось: ${resume.title}` };

  const letterOk = await addCoverLetter(page, letter);
  if (letter && !letterOk) return { status: 'manual', reason: 'не удалось вставить письмо' };

  const submit = page.locator('[data-qa="vacancy-response-submit-popup"]').first();
  if (!(await submit.count())) {
    await saveResponseSnapshot(page, cfg, vacancy.id);
    const pageText = await safeBodyText(page);
    if (QUESTIONS.test(pageText)) {
      const questions = await readResponseQuestions(page).catch(() => []);
      return { status: 'questions', questions };
    }
    return { status: 'manual', reason: 'нет кнопки отправки' };
  }

  await submit.evaluate((el) => el.click());
  await page.waitForTimeout(4000);

  if (await detectCaptcha(page)) throw new CaptchaError('капча после отправки');

  const after = await safeBodyText(page);
  if (ALREADY.test(after)) return { status: 'applied', resume: resume.title };

  const alert = page.locator('[role="alert"]').first();
  if (await alert.count()) {
    const text = (await alert.innerText().catch(() => '')).trim();
    if (text) return { status: 'manual', reason: `ошибка формы: ${text.slice(0, 200)}` };
  }

  if (!(await submit.count()) || !(await submit.isVisible().catch(() => false))) {
    return { status: 'applied', resume: resume.title };
  }

  return { status: 'manual', reason: 'форма осталась открытой после отправки' };
}
