import fs from 'node:fs';
import path from 'node:path';
import { assertLoggedIn } from './browser.js';
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

// Общий DOM-обход полей анкеты в одном порядке: выполняется внутри page.evaluate.
function collectQuestionFieldsInDom(tagFields) {
  const clean = (s) => String(s ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const root = document.querySelector('[data-qa="vacancy-response-popup"]')
    || document.querySelector('form[action*="vacancy_response"]')
    || document.querySelector('main')
    || document.body;
  if (!root) return [];

  const isExcludedRegion = (el) => Boolean(el.closest(
    'header, nav, [role="listbox"], [role="option"], [data-qa*="navi"], [data-qa*="search"], [data-qa*="resume-list"], form[action*="login"]'
  ));
  const isCoverLetter = (el) => {
    const name = String(el.getAttribute('name') || '');
    const qa = String(el.getAttribute('data-qa') || '');
    const ph = String(el.getAttribute('placeholder') || '');
    return name === 'letter' || /letter/i.test(qa) || /сопроводительн/i.test(ph);
  };
  const isVisible = (el, forToggle = false) => {
    const target = (forToggle && el.closest('label')) || el;
    if (!target || target.closest('[hidden], [aria-hidden="true"]')) return false;
    const st = getComputedStyle(target);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    if (target.getClientRects().length === 0 && st.position !== 'fixed') return false;
    return true;
  };
  const textInputs = new Set(['', 'text', 'number', 'url', 'email', 'tel']);

  let seq = 0;
  const nodeIds = new WeakMap();
  const nodeId = (node) => {
    if (!node) return '';
    let id = nodeIds.get(node);
    if (!id) {
      id = `n${++seq}`;
      nodeIds.set(node, id);
    }
    return id;
  };

  const labelForControl = (el) => {
    if (el.id) {
      const explicit = root.querySelector(`label[for="${CSS.escape(el.id)}"]`)
        || document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (explicit) return clean(explicit.innerText || explicit.textContent);
    }
    const wrapping = el.closest('label');
    if (wrapping) {
      const clone = wrapping.cloneNode(true);
      clone.querySelectorAll('input, select, textarea').forEach((n) => n.remove());
      const txt = clean(clone.textContent);
      if (txt) return txt;
    }
    return clean(el.getAttribute('aria-label') || el.value || '');
  };

  const extractQuestionLabel = (box, excludedLabels, fallbackText) => {
    if (!box) return clean(fallbackText).slice(0, 600);
    const parts = [];
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || parent.closest('select, textarea, button, style, script')) continue;
      const lbl = parent.closest('label');
      if (lbl && excludedLabels.has(lbl)) continue;
      const st = getComputedStyle(parent);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      const txt = clean(node.textContent);
      if (txt) parts.push(txt);
    }
    const joined = clean(parts.join(' '));
    return (joined || clean(fallbackText)).slice(0, 600);
  };

  const fields = [];
  const groups = new Map();

  for (const el of root.querySelectorAll('textarea, input, select')) {
    if (el.disabled || isExcludedRegion(el) || isCoverLetter(el)) continue;
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? String(el.getAttribute('type') || 'text').toLowerCase() : tag;

    if (tag === 'textarea' || (tag === 'input' && textInputs.has(type))) {
      if (!isVisible(el, false)) continue;
      const box = el.closest('[data-qa*="question"], fieldset, [role="group"], form > div') || el.parentElement;
      const fallback = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
      const label = extractQuestionLabel(box, new Set(), fallback);
      if (!label) continue;
      const index = fields.length;
      if (tagFields) el.setAttribute('data-hh-q-idx', String(index));
      fields.push({ index, type: tag === 'textarea' ? 'textarea' : 'input', label, options: [] });
      continue;
    }

    if (tag === 'select') {
      if (!isVisible(el, false)) continue;
      const box = el.closest('[data-qa*="question"], fieldset, [role="group"], form > div') || el.parentElement;
      const fallback = el.getAttribute('aria-label') || '';
      const label = extractQuestionLabel(box, new Set(), fallback);
      const rawOpts = [...el.options]
        .filter((o) => !o.disabled)
        .map((o) => ({ label: clean(o.textContent), value: String(o.value ?? '') }));
      const nonEmpty = rawOpts.filter((o) => o.value !== '' && !/^выберите\b/i.test(o.label));
      const options = nonEmpty.length ? nonEmpty : rawOpts.filter((o) => o.label);
      if (!label || !options.length) continue;
      const index = fields.length;
      if (tagFields) el.setAttribute('data-hh-q-idx', String(index));
      fields.push({ index, type: 'select', label, options });
      continue;
    }

    if (tag === 'input' && (type === 'radio' || type === 'checkbox')) {
      if (!isVisible(el, true)) continue;
      const qBox = el.closest('[data-qa*="question"], [role="radiogroup"], [role="group"], fieldset');
      const name = String(el.getAttribute('name') || '');
      const key = type === 'radio'
        ? `radio:${name || (qBox ? nodeId(qBox) : nodeId(el))}`
        : `checkbox:${qBox ? nodeId(qBox) : nodeId(el.parentElement)}:${name}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          index: fields.length,
          type,
          box: qBox || el.closest('div') || el.parentElement,
          excludedLabels: new Set(),
          items: []
        };
        groups.set(key, group);
        fields.push(group);
      }
      const optIdx = group.items.length;
      const wrapLabel = el.closest('label')
        || (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
      if (wrapLabel) group.excludedLabels.add(wrapLabel);
      const optLabel = labelForControl(el) || `Вариант ${optIdx + 1}`;
      if (tagFields) {
        el.setAttribute('data-hh-q-idx', String(group.index));
        el.setAttribute('data-hh-opt-idx', String(optIdx));
      }
      group.items.push({ optIndex: optIdx, label: optLabel, value: String(el.value ?? '') });
    }
  }

  return fields
    .map((f) => {
      if (f.type !== 'radio' && f.type !== 'checkbox') return f;
      const fallback = f.items[0]?.label || '';
      const label = extractQuestionLabel(f.box, f.excludedLabels, fallback);
      return { index: f.index, type: f.type, label, options: f.items };
    })
    .filter((f) => f.label && (f.type === 'textarea' || f.type === 'input' || f.options.length > 0))
    .map((f, index) => ({ ...f, index }));
}

export async function readResponseQuestions(page) {
  const fields = await page.evaluate(collectQuestionFieldsInDom, false);
  return fields.map((f) => ({
    index: f.index,
    type: f.type,
    label: f.label,
    options: (f.options ?? []).map((o) => o.label)
  }));
}

function normMatch(s) {
  return String(s ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function matchOption(options, answer) {
  const want = normMatch(answer);
  if (!want) return null;
  const exact = options.find((o) => normMatch(o.label) === want || normMatch(o.value) === want);
  if (exact) return exact;
  return options.find((o) => {
    const lbl = normMatch(o.label);
    return lbl && (lbl.includes(want) || (want.length >= 2 && want.includes(lbl)));
  }) ?? null;
}

function parseCheckboxTokens(answer, options) {
  if (Array.isArray(answer)) return answer.map((v) => String(v).trim()).filter(Boolean);
  const raw = String(answer ?? '').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
    } catch {}
  }
  const wantRaw = normMatch(raw);
  if (options.length > 1 && options.some((o) => normMatch(o.label) === wantRaw || normMatch(o.value) === wantRaw)) {
    return [raw];
  }
  if (/[;\n]/.test(raw)) return raw.split(/[;\n]+/).map((s) => s.trim()).filter(Boolean);
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export async function fillResponseAnswers(page, answers) {
  const fields = await page.evaluate(collectQuestionFieldsInDom, true);
  if (fields.length !== answers.length) return { ok: false, count: fields.length };
  const norm = (s) => String(s).replace(/\r\n/g, '\n').replace(/\s+$/, '');

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.type === 'textarea' || field.type === 'input') {
      const loc = page.locator(`[data-hh-q-idx="${i}"]`).first();
      const val = String(answers[i] ?? '').trim();
      await loc.fill(val);
      const got = await loc.inputValue().catch(() => '');
      if (norm(got) !== norm(val)) {
        return { ok: false, count: fields.length, index: i, reason: 'текст не применился' };
      }
      continue;
    }

    if (field.type === 'select') {
      const loc = page.locator(`[data-hh-q-idx="${i}"]`).first();
      const matched = matchOption(field.options, answers[i]);
      if (!matched) {
        return { ok: false, count: fields.length, index: i, reason: `не найден вариант «${answers[i]}»` };
      }
      await loc.selectOption(matched.value ? { value: matched.value } : { label: matched.label });
      const selected = await loc.inputValue().catch(() => '');
      if (matched.value && selected !== matched.value) {
        return { ok: false, count: fields.length, index: i, reason: 'вариант select не применился' };
      }
      continue;
    }

    if (field.type === 'radio') {
      const matched = matchOption(field.options, answers[i]);
      if (!matched) {
        return { ok: false, count: fields.length, index: i, reason: `не найден вариант «${answers[i]}»` };
      }
      const optLoc = page.locator(`[data-hh-q-idx="${i}"][data-hh-opt-idx="${matched.optIndex}"]`).first();
      await optLoc.check({ force: true }).catch(() => optLoc.evaluate((el) => el.click()));
      if (!(await optLoc.isChecked().catch(() => false))) {
        return { ok: false, count: fields.length, index: i, reason: 'radio не отметился' };
      }
      continue;
    }

    if (field.type === 'checkbox') {
      if (field.options.length === 1) {
        const opt = field.options[0];
        const w = normMatch(answers[i]);
        const optLoc = page.locator(`[data-hh-q-idx="${i}"][data-hh-opt-idx="${opt.optIndex}"]`).first();
        const wantFalse = /^(нет|no|false|0)$/i.test(w) || w === '';
        const wantTrue = !wantFalse && (/^(да|yes|true|1|согласен|согласна)$/i.test(w) || Boolean(matchOption([opt], w)));
        if (!wantFalse && !wantTrue) {
          return { ok: false, count: fields.length, index: i, reason: `не распознан checkbox «${answers[i]}»` };
        }
        if (wantTrue) {
          await optLoc.check({ force: true }).catch(() => optLoc.evaluate((el) => el.click()));
          if (!(await optLoc.isChecked().catch(() => false))) {
            return { ok: false, count: fields.length, index: i, reason: 'checkbox не отметился' };
          }
        } else if (await optLoc.isChecked().catch(() => false)) {
          await optLoc.uncheck({ force: true }).catch(() => optLoc.evaluate((el) => el.click()));
          if (await optLoc.isChecked().catch(() => false)) {
            return { ok: false, count: fields.length, index: i, reason: 'checkbox не снялся' };
          }
        }
        continue;
      }

      const tokens = parseCheckboxTokens(answers[i], field.options);
      const selectedSet = new Set();
      for (const token of tokens) {
        const matched = matchOption(field.options, token);
        if (!matched) {
          return { ok: false, count: fields.length, index: i, reason: `не найден checkbox «${token}»` };
        }
        selectedSet.add(matched.optIndex);
      }
      if (!selectedSet.size) {
        return { ok: false, count: fields.length, index: i, reason: 'не выбран ни один checkbox' };
      }
      for (const opt of field.options) {
        const optLoc = page.locator(`[data-hh-q-idx="${i}"][data-hh-opt-idx="${opt.optIndex}"]`).first();
        const shouldCheck = selectedSet.has(opt.optIndex);
        const isNow = await optLoc.isChecked().catch(() => false);
        if (shouldCheck && !isNow) {
          await optLoc.check({ force: true }).catch(() => optLoc.evaluate((el) => el.click()));
          if (!(await optLoc.isChecked().catch(() => false))) {
            return { ok: false, count: fields.length, index: i, reason: 'checkbox не отметился' };
          }
        } else if (!shouldCheck && isNow) {
          await optLoc.uncheck({ force: true }).catch(() => optLoc.evaluate((el) => el.click()));
          if (await optLoc.isChecked().catch(() => false)) {
            return { ok: false, count: fields.length, index: i, reason: 'checkbox не снялся' };
          }
        }
      }
    }
  }
  return { ok: true, count: fields.length };
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
  await assertLoggedIn(page, 'сессия hh.ru истекла (отклик)');

  const body = await safeBodyText(page);
  if (ALREADY.test(body)) return { status: 'already' };
  if (CLOSED.test(body)) return { status: 'closed' };
  if (QUESTIONS.test(body)) {
    const hasSubmitPopup = Boolean(await page.locator('[data-qa="vacancy-response-submit-popup"]').count().catch(() => 0));
    const questions = await readResponseQuestions(page).catch(() => []);
    if (!hasSubmitPopup || questions.length > 0) {
      await saveResponseSnapshot(page, cfg, vacancy.id);
      // Анкета: форму заполняем только после подтверждения в Telegram, поэтому отдаём вопросы наверх.
      return { status: 'questions', questions };
    }
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
