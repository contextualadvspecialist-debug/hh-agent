import fs from 'node:fs';
import path from 'node:path';
import { assertLoggedIn } from './browser.js';
import { CaptchaError } from './hh-search.js';
import { applyToVacancy, readResponseQuestions, fillResponseAnswers, submitResponseForm } from './hh-apply.js';
import { withinWindow, msUntilWindow } from './schedule.js';
import { buildLetter, prepareLetter } from './letter.js';
import { esc, manualApplyKeyboard } from './tg.js';
import { setVacancyStatus, getVacancy, recordApplication, recentLetters } from './db.js';
import { formatQuestionLine } from './agent-prompts.js';
import { isAuthError, getPauseState } from './agent-ops.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (min, max) => min + Math.floor(Math.random() * (max - min));

export async function sendQuestionsCard(agent, v, { vacancyId, resumeKey, questions, answers }) {
  const qText = questions.length
    ? questions.map((q, i) => formatQuestionLine(q, i)).join('\n')
    : 'поля не распознались';
  const aText = answers.length
    ? answers.map((t, i) => `${i + 1}) ${t}`).join('\n')
    : '';
  const body = `📝 <b>Анкета: ${esc(v.title || vacancyId)}</b>\n${esc(v.company || '')}\n\n`
    + `<b>Вопросы</b>\n${esc(qText)}\n\n`
    + (answers.length
      ? `<b>Черновики ответов</b>\n${esc(aText)}\n\n<i>Заполню поля только после нажатия кнопки.</i>`
      : '<i>Черновик не сгенерирован — перепишите или заполните вручную.</i>');

  const formUrl = typeof agent.responseUrl === 'function'
    ? agent.responseUrl(vacancyId)
    : `${agent.cfg.hh.base}/applicant/vacancy_response?vacancyId=${vacancyId}&startedWithQuestion=false`;

  const row1 = [
    ...(answers.length ? [{ text: '✍️ Заполнить поля', callback_data: `afill:${vacancyId}:${resumeKey}` }] : []),
    ...(questions.length ? [{ text: '🔄 Переписать', callback_data: `arewrite:${vacancyId}:${resumeKey}` }] : [])
  ];
  const keyboard = [
    ...(row1.length ? [row1] : []),
    [
      { text: '🔗 Открыть форму', url: formUrl },
      { text: '🗑 Пропустить', callback_data: `sk:${vacancyId}` }
    ]
  ];
  await agent.send(body, keyboard);
}

export async function applyLoop(agent) {
  let notifiedLimit = false;
  let notifiedWindow = false;
  let notifiedPause = false;
  while (!agent.stopped) {
    const paused = typeof agent.isPaused === 'function'
      ? agent.isPaused('apply')
      : getPauseState(agent.db).apply;
    if (paused) {
      if (!notifiedPause) {
        agent.log?.('apply loop: автоотклик на паузе (/resume чтобы включить)');
        if (Array.isArray(agent.queue) && agent.queue.length > 0) {
          await agent.send(`⏸ Автоотклик на паузе (в очереди: ${agent.queue.length}). Включить: /resume apply`);
        }
        notifiedPause = true;
      }
      await sleep(15_000);
      continue;
    }
    notifiedPause = false;

    const job = agent.queue.shift();
    if (!job) {
      await sleep(1500);
      continue;
    }
    agent.saveQueue();

    if (!withinWindow(new Date(), agent.cfg.limits.sendWindow)) {
      agent.queue.unshift(job);
      agent.saveQueue();
      if (!notifiedWindow) {
        const w = agent.cfg.limits.sendWindow;
        await agent.send(`🕒 Отклики отправляются с ${w.from}:00 до ${w.to}:00 — очередь ждёт.`);
        notifiedWindow = true;
      }
      await sleep(Math.min(60_000, msUntilWindow(new Date(), agent.cfg.limits.sendWindow)));
      continue;
    }
    notifiedWindow = false;

    if (agent.applicationsToday() >= agent.cfg.limits.dailyApplications) {
      agent.queue.unshift(job);
      agent.saveQueue();
      if (!notifiedLimit) {
        await agent.send(`Дневной лимит откликов (${agent.cfg.limits.dailyApplications}) исчерпан. Остальные — завтра.`);
        notifiedLimit = true;
      }
      await sleep(60_000);
      continue;
    }
    notifiedLimit = false;
    try {
      await agent.processApply(job);
    } catch (e) {
      agent.log?.(`apply ${job.vacancyId}: ${e.message}`);
      if (isAuthError(e)) {
        await agent.alertAuthLost?.(e.message).catch((err) => agent.log?.(`auth alert: ${err?.message || err}`));
      }
      setVacancyStatus(agent.db, job.vacancyId, 'error');
      const v = getVacancy(agent.db, job.vacancyId) || { id: job.vacancyId };
      await agent.send(
        `⚠️ Ошибка отклика на <b>${esc(v.title || job.vacancyId)}</b>: ${esc(e.message.slice(0, 300))}`,
        manualApplyKeyboard(v, agent.cfg, { resumeKey: job.resumeKey, retry: true })
      );
    }
    await sleep(rnd(agent.cfg.limits.minDelaySec, agent.cfg.limits.maxDelaySec) * 1000);
  }
}

export async function processApply(agent, { vacancyId, resumeKey, letterText }) {
  let v = getVacancy(agent.db, vacancyId);
  if (!v) throw new Error('вакансия не найдена в базе');
  v = await agent.refreshVacancy(vacancyId);

  const previous = recentLetters(agent.db, 20);
  const page = await agent.page('apply');
  const supplied = String(letterText ?? '').trim();
  let letter = supplied ? prepareLetter(supplied, agent.profile, { log: agent.log }) : '';
  if (supplied && letter.length < 40) throw new Error('письмо из файла пустое или битое');
  if (!letter) letter = agent.cachedLetter(vacancyId);
  if (!letter) {
    letter = await buildLetter({
      llmChat: agent.llm,
      profile: agent.profile,
      vacancy: v,
      resumeKey,
      previous,
      log: agent.log
    });
  }
  fs.writeFileSync(path.join(agent.cfg.paths.letters, `${vacancyId}.txt`), letter, 'utf8');

  const resumeId = agent.cfg.resumes[resumeKey]?.id ?? '';
  let result;
  try {
    result = await applyToVacancy(page, agent.cfg, v, resumeKey, letter);
  } catch (e) {
    if (e instanceof CaptchaError) {
      setVacancyStatus(agent.db, vacancyId, 'captcha');
      recordApplication(agent.db, { vacancyId, resumeKey, resumeId, letter, status: 'captcha', error: e.message });
      agent.log?.(`apply ${vacancyId}: капча, ждём ручного решения`);
      await page.bringToFront().catch((err) => agent.log?.(`bringToFront: ${err.message}`));
      await agent.send(
        `🤖 Капча на hh для «<b>${esc(v.title)}</b>». Решите её в окне Chrome, затем нажмите кнопку.`,
        [[{ text: '✅ Решил, повторить', callback_data: `cap:${vacancyId}:${resumeKey}` }]]
      );
      return;
    }
    throw e;
  }

  if (result.status === 'applied' || result.status === 'already') {
    recordApplication(agent.db, {
      vacancyId, resumeKey, resumeId, letter,
      status: result.status,
      error: ''
    });
    setVacancyStatus(agent.db, vacancyId, 'applied');
    agent.log?.(`apply ${vacancyId}: ${result.status} (${resumeKey}, ${letter.length} зн.)`);
    await agent.send(
      `${result.status === 'already' ? '♻️ Уже был отклик' : '✅ Отклик отправлен'}: <b>${esc(v.title)}</b> — ${esc(v.company)}\nРезюме: ${esc(result.resume ?? resumeKey)}`
    );
    return;
  }

  if (result.status === 'closed') {
    recordApplication(agent.db, { vacancyId, resumeKey, resumeId, letter, status: 'closed' });
    setVacancyStatus(agent.db, vacancyId, 'closed');
    await agent.send(`🚫 Вакансия закрыта: <b>${esc(v.title)}</b>`);
    return;
  }

  if (result.status === 'questions') {
    await agent.handleQuestions(v, { vacancyId, resumeKey, resumeId, letter, questions: result.questions ?? [] });
    return;
  }

  recordApplication(agent.db, { vacancyId, resumeKey, resumeId, letter, status: 'manual', error: result.reason ?? '' });
  setVacancyStatus(agent.db, vacancyId, 'manual');
  agent.log?.(`apply ${vacancyId}: вручную — ${result.reason ?? 'неизвестно'}`);
  await agent.send(
    `✋ Нужно вручную: <b>${esc(v.title)}</b>\nПричина: ${esc(result.reason ?? 'неизвестно')}\n${esc(v.url)}`,
    manualApplyKeyboard(v, agent.cfg, { resumeKey })
  );
}

export async function handleQuestions(agent, v, { vacancyId, resumeKey, resumeId, letter, questions }) {
  recordApplication(agent.db, { vacancyId, resumeKey, resumeId, letter, status: 'manual', error: 'анкета работодателя' });
  setVacancyStatus(agent.db, vacancyId, 'manual');
  agent.log?.(`apply ${vacancyId}: анкета, ${questions.length} полей (снимок формы в letters/${vacancyId}-response.html)`);

  const answers = await agent.draftAnswers(v, questions);
  if (answers.length || questions.length) agent.saveAnswers(vacancyId, resumeKey, answers, questions);

  await sendQuestionsCard(agent, v, { vacancyId, resumeKey, questions, answers });
}

export async function rewriteQuestions(agent, vacancyId, resumeKey) {
  const v = getVacancy(agent.db, vacancyId) ?? { id: vacancyId, title: vacancyId, company: '', resume: resumeKey };
  const draft = agent.answersDraft(vacancyId);
  let questions = Array.isArray(draft?.questions) && draft.questions.length ? draft.questions : [];
  if (!questions.length) {
    const page = await agent.page('apply');
    await page.goto(agent.responseUrl(vacancyId), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await assertLoggedIn(page, 'сессия hh.ru истекла (анкета)');
    questions = await readResponseQuestions(page).catch((err) => {
      agent.log?.(`questions read ${vacancyId}: ${err.message}`);
      return [];
    });
  }
  if (!questions.length) {
    await agent.send(`⚠️ Вопросы анкеты по вакансии <b>${esc(vacancyId)}</b> не распознались — откройте форму вручную.`);
    return;
  }
  const answers = await agent.draftAnswers(v, questions, {
    hint: 'Сформулируй ответы иначе: конкретнее, по делу, без канцелярита и с опорой только на факты.'
  });
  if (answers.length || questions.length) agent.saveAnswers(vacancyId, resumeKey, answers, questions);
  await sendQuestionsCard(agent, v, { vacancyId, resumeKey, questions, answers });
}

export async function fillQuestions(agent, vacancyId, resumeKey) {
  const draft = agent.answersDraft(vacancyId);
  if (!draft?.answers.length) throw new Error('черновик ответов устарел — нажмите «Отклик» или «Переписать»');
  const page = await agent.page('apply');
  await page.goto(agent.responseUrl(vacancyId), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await assertLoggedIn(page, 'сессия hh.ru истекла (заполнение анкеты)');
  const r = await fillResponseAnswers(page, draft.answers);
  if (!r.ok) {
    const detail = r.reason ? `, поле #${(r.index ?? 0) + 1}: ${esc(r.reason)}` : '';
    await agent.send(`⚠️ Полей ${r.count}, ответов ${draft.answers.length}${detail} — проверьте форму вручную: ${agent.responseUrl(vacancyId)}`);
    return;
  }
  agent.log?.(`apply ${vacancyId}: поля анкеты заполнены (${r.count})`);
  await agent.send(
    '✍️ Поля заполнены. Проверьте текст в Chrome и отправьте форму кнопкой ниже.',
    [[{ text: '📤 Отправить форму', callback_data: `asend:${vacancyId}:${resumeKey}` }],
     [{ text: '🔗 Открыть форму', url: agent.responseUrl(vacancyId) }]]
  );
}

export async function submitQuestions(agent, vacancyId, resumeKey) {
  const page = await agent.page('apply');
  // После рестарта или ухода со страницы поля пустые — восстанавливаем ответы перед отправкой.
  if (!page.url().includes('vacancy_response')) {
    await page.goto(agent.responseUrl(vacancyId), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const draft = agent.answersDraft(vacancyId);
    if (draft?.answers.length) {
      await fillResponseAnswers(page, draft.answers).catch((err) => agent.log?.(`fill restore ${vacancyId}: ${err.message}`));
    }
  }
  const resumeId = agent.cfg.resumes[resumeKey]?.id ?? '';
  const letter = agent.letterDraft(vacancyId)?.letter ?? agent.cachedLetter(vacancyId);
  let result;
  try {
    result = await submitResponseForm(page);
  } catch (e) {
    if (e instanceof CaptchaError) {
      recordApplication(agent.db, { vacancyId, resumeKey, resumeId, letter, status: 'captcha', error: e.message });
      setVacancyStatus(agent.db, vacancyId, 'captcha');
      await page.bringToFront().catch((err) => agent.log?.(`bringToFront: ${err.message}`));
      await agent.send('🤖 Капча при отправке анкеты. Решите её в Chrome и отправьте форму вручную.');
      return;
    }
    throw e;
  }

  if (result.status === 'applied') {
    recordApplication(agent.db, { vacancyId, resumeKey, resumeId, letter, status: 'applied', error: '' });
    setVacancyStatus(agent.db, vacancyId, 'applied');
    agent.log?.(`apply ${vacancyId}: анкета отправлена`);
    await agent.send('✅ Анкета отправлена.');
    return;
  }
  recordApplication(agent.db, { vacancyId, resumeKey, resumeId, letter, status: 'manual', error: result.reason ?? '' });
  setVacancyStatus(agent.db, vacancyId, 'manual');
  const v = getVacancy(agent.db, vacancyId) || { id: vacancyId };
  await agent.send(
    `✋ Форма не отправилась: ${esc(result.reason ?? 'неизвестно')}`,
    manualApplyKeyboard(v, agent.cfg, { resumeKey })
  );
}
