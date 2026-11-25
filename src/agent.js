import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { checkLoggedIn, closeContext, assertLoggedIn } from './browser.js';
import { searchQuery, getVacancyDetails, CaptchaError } from './hh-search.js';
import { applyToVacancy, readResponseQuestions, fillResponseAnswers, submitResponseForm } from './hh-apply.js';
import { listUnreadChats, listAllChats, readChat, sendChatMessage, cleanVacancyTitle, extractFormLinks } from './hh-chats.js';
import { listNegotiations } from './hh-status.js';
import { isDuplicate, isDescriptionDuplicate } from './dedupe.js';
import { withinWindow, msUntilWindow } from './schedule.js';
import { ruleScore, llmRefine } from './score.js';
import { buildLetter, prepareLetter } from './letter.js';
import { proposeFollowups } from './followup.js';
import { makeLlmClient } from './llm.js';
import { Telegram, esc, vacancyKeyboard, vacancyText, chatReplyKeyboard } from './tg.js';
import {
  openDb, closeDb, upsertVacancy, setScore, setVacancyStatus, getVacancy, hasVacancy, listVacancies,
  recordApplication, getApplication, countApplicationsSince, recentLetters, upsertChat, setChatVacancy,
  setChatDraft, getChat, addMessage, kvGet, kvSet,
  recentVacancies, setApplicationHhStatus, listApplications, adoptNegotiation,
  listRuleScored, markApplicationDelivered, recentSnippets, recordChatForm, getChatForm, markChatHandled, getChatHandled
} from './db.js';
import {
  formatQuestionLine, draftFormDoneReply,
  fitText as _fitText, fitNote as _fitNote, analyzeFit as _analyzeFit,
  generateLetter as _generateLetter, draftAnswers as _draftAnswers,
  sentLetterFor as _sentLetterFor, draftReply as _draftReply
} from './agent-prompts.js';
import { buildDigest, buildStatsText, statusView as _statusView } from './agent-analytics.js';
import {
  localDayKey, isAuthError, alertCooldownMs as _alertCooldownMs,
  alertAuthLost as _alertAuthLost, maybeAlertAuthRecovered as _maybeAlertAuthRecovered,
  clearSchedulerError as _clearSchedulerError, recordSchedulerError as _recordSchedulerError,
  runScheduledTask as _runScheduledTask, acquirePage, recyclePages, runMaintenance
} from './agent-ops.js';
import { telegramPollBackoffMs, handleTelegramUpdate, runBotLoop } from './agent-telegram.js';

export { telegramPollBackoffMs };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (min, max) => min + Math.floor(Math.random() * (max - min));

function chatRetryState(db) {
  try {
    const value = JSON.parse(kvGet(db, 'chatReadRetries', '{}'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function rememberChatRetry(db, chat, error) {
  const retries = chatRetryState(db);
  retries[chat.id] = {
    id: chat.id,
    title: chat.title ?? '',
    subtitle: chat.subtitle ?? '',
    last: chat.last ?? '',
    time: chat.time ?? '',
    error: String(error?.message ?? error).slice(0, 300),
    updatedAt: new Date().toISOString()
  };
  kvSet(db, 'chatReadRetries', JSON.stringify(retries));
}

function clearChatRetry(db, chatId) {
  const retries = chatRetryState(db);
  if (!retries[chatId]) return;
  delete retries[chatId];
  kvSet(db, 'chatReadRetries', JSON.stringify(retries));
}

async function sendQuestionsCard(agent, v, { vacancyId, resumeKey, questions, answers }) {
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

export class Agent {
  constructor(cfg, { log = console.log } = {}) {
    this.cfg = cfg;
    this.log = log;
    this.db = openDb(cfg.paths.db);
    this.profile = JSON.parse(fs.readFileSync(path.join(cfg.paths.root, 'profile.json'), 'utf8'));
    this.llm = makeLlmClient(cfg.llm);
    this.tg = cfg.telegram.token && cfg.telegram.chatId ? new Telegram(cfg.telegram) : null;
    this.ctx = null;
    this.pages = {};
    this.pageCreatedAt = {};
    this.queue = this.loadQueue();
    // Смещение Telegram тоже переживает рестарт: иначе бот заново разбирает старые команды.
    this.offset = Number(kvGet(this.db, 'tgOffset', 0)) || 0;
    this.schedulerErrors = { scan: 0, chats: 0, status: 0 };
    this.stopped = false;
    this.timers = [];
    fs.mkdirSync(cfg.paths.letters, { recursive: true });
  }

  alertCooldownMs() {
    return _alertCooldownMs(this);
  }

  async alertAuthLost(reason = '') {
    return _alertAuthLost(this, reason);
  }

  async maybeAlertAuthRecovered() {
    return _maybeAlertAuthRecovered(this);
  }

  clearSchedulerError(kind) {
    return _clearSchedulerError(this, kind);
  }

  async recordSchedulerError(kind, error) {
    return _recordSchedulerError(this, kind, error);
  }

  async runScheduledTask(kind, fn) {
    return _runScheduledTask(this, kind, fn);
  }

  async page(name) {
    return acquirePage(this, name);
  }

  async recyclePages(opts = {}) {
    return recyclePages(this, opts);
  }

  async lock(name, fn) {
    this.locks ??= {};
    const prev = (this.locks[name] ?? Promise.resolve()).catch(() => {});
    let release;
    const gate = new Promise((r) => (release = r));
    this.locks[name] = prev.then(() => gate);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async init() {
    const page = await this.page('search');
    const ok = await checkLoggedIn(page, this.cfg);
    if (!ok) throw new Error('Нет логина на hh.ru. Запустите: npm run login');
    this.log('hh: логин подтверждён');
  }

  async send(text, keyboard, replyKeyboard) {
    if (this.tg) {
      try {
        const res = await this.tg.send(text, keyboard, replyKeyboard);
        return res || true;
      } catch (e) {
        this.log(`telegram: ${e.message}`);
        return false;
      }
    }
    this.log(text.replace(/<[^>]+>/g, ''));
    return true;
  }

  async notifyVacancy(v) {
    const sent = await this.send(vacancyText(v), vacancyKeyboard(v, this.cfg));
    // Если карточка не ушла, вакансия остаётся 'new' и будет отправлена следующим сканом.
    if (sent) setVacancyStatus(this.db, v.id, 'notified');
    return sent;
  }

  // Разбор соответствия по полному описанию: кэш по отпечатку, чтобы карточка и кнопка не дублировали запрос.
  async fitText(vacancyId) {
    return _fitText(this, vacancyId);
  }

  async fitNote(vacancyId) {
    return _fitNote(this, vacancyId);
  }

  async analyzeFit(vacancyId) {
    return _analyzeFit(this, vacancyId);
  }

  // Дооценка вакансий, которые правила занизили до порога, а LLM ещё не смотрел.
  async rescoreBorderline(budget = 20) {
    if (!this.llm) return [];
    const rows = listRuleScored(this.db, Math.max(40, this.cfg.threshold - 10), this.cfg.threshold - 1, budget);
    const negatives = this.skipExamples();
    const matched = [];
    for (const row of rows) {
      const base = { score: row.score, reason: row.reason ?? '', resume: row.resume === 'direct' ? 'direct' : 'ai' };
      try {
        const refined = await llmRefine(this.llm, this.profile, row, base, negatives);
        const ok = refined !== base;
        if (ok) this.log(`rescore ${row.id}: ${row.score} → ${refined.score}`);
        // llm_at ставим и при неразобранном ответе, иначе такие вакансии навсегда займут бюджет переоценки.
        setScore(this.db, row.id, { ...(ok ? refined : base), by: ok ? 'llm' : 'rule', llmAt: new Date().toISOString() });
        if (refined.score >= this.cfg.threshold) {
          setVacancyStatus(this.db, row.id, 'new');
          matched.push({ ...row, ...refined });
        }
      } catch (e) {
        this.log(`rescore ${row.id}: ${e.message}`);
      }
    }
    matched.sort((a, b) => b.score - a.score);
    return matched;
  }

  async scan({ direct = false } = {}) {
    return this.lock('search', () => this.scanOnce({ direct }));
  }

  async scanOnce({ direct = false } = {}) {
    const page = await this.page('search');
    const seen = new Set();
    const addedAI = [];
    const addedDirect = [];
    const errors = [];
    const known = recentVacancies(this.db, 800);
    const knownTexts = recentSnippets(this.db, 800);

    const batches = [
      ...(this.cfg.hh.queriesAI ?? []).map((q) => ({ query: q, pool: 'ai' })),
      ...(direct ? (this.cfg.hh.queriesDirect ?? []).map((q) => ({ query: q, pool: 'direct' })) : [])
    ];

    let dupCount = 0;
    let nonRemoteCount = 0;
    for (const { query, pool } of batches) {
      for (let p = 0; p < (this.cfg.hh.pages ?? 1); p++) {
        let items = [];
        try {
          items = await searchQuery(page, this.cfg, query, p);
        } catch (e) {
          if (isAuthError(e)) throw e;
          if (e instanceof CaptchaError) {
            errors.push(`капча: «${query}»`);
            break;
          }
          errors.push(`${query}: ${e.message}`);
          break;
        }
        for (const v of items) {
          if (!v.id || seen.has(v.id)) continue;
          seen.add(v.id);
          if (hasVacancy(this.db, v.id)) continue;
          if (this.cfg.hh.remoteOnly && !v.remote) {
            nonRemoteCount++;
            continue;
          }
          if (known.some((k) => isDuplicate(v, k))) {
            dupCount++;
            continue;
          }
          // Тот же текст требований под другим заголовком — репост кадрового агентства.
          if (v.snippet && knownTexts.some((k) => isDescriptionDuplicate(v, k))) {
            dupCount++;
            continue;
          }
          const row = { ...v, query, pool };
          upsertVacancy(this.db, row);
          known.push(row);
          if (row.snippet) knownTexts.push({ id: row.id, snippet: row.snippet.slice(0, 800) });
          (pool === 'ai' ? addedAI : addedDirect).push(row);
        }
        await sleep(rnd(2500, 4500));
      }
    }

    // У части карточек в выдаче нет сниппета — догружаем описание у лучших кандидатов.
    let captchaStop = false;
    const enrich = async (list, budget) => {
      let detailed = 0;
      const preliminary = list
        .map((v) => ({ v, base: ruleScore(v, this.cfg) }))
        .sort((a, b) => b.base.score - a.base.score);

      for (const item of preliminary) {
        if (captchaStop || detailed >= budget) break;
        if (item.base.score < 30 || (item.v.snippet && item.v.snippet.length >= 80)) continue;
        detailed++;
        try {
          const details = await getVacancyDetails(page, this.cfg, item.v.id);
          item.v.snippet = details.snippet || item.v.snippet;
          item.v.company = item.v.company || details.company;
          item.v.salary = item.v.salary || details.salary;
          upsertVacancy(this.db, { ...item.v, query: item.v.query });
          item.base = ruleScore(item.v, this.cfg);
        } catch (e) {
          if (e instanceof CaptchaError) {
            captchaStop = true;
            errors.push('капча на карточке вакансии');
          } else {
            this.log(`details ${item.v.id}: ${e.message}`);
          }
        }
        await sleep(rnd(1200, 2400));
      }
      return preliminary;
    };

    let llmUsed = 0;
    const negatives = this.skipExamples();
    const scoreList = async (preliminary, { status }) => {
      const matched = [];
      for (const { v, base } of preliminary) {
        let result = base;
        let by = 'rule';
        let llmAt = '';
        if (this.llm && base.score >= 35 && llmUsed < 60) {
          llmUsed++;
          try {
            const refined = await llmRefine(this.llm, this.profile, v, base, negatives);
            // llmRefine отдаёт тот же объект, если JSON не разобрался — тогда это оценка правил.
            if (refined !== base) {
              result = refined;
              by = 'llm';
              llmAt = new Date().toISOString();
            }
          } catch (e) {
            this.log(`llm score: ${e.message}`);
          }
        }
        setScore(this.db, v.id, { ...result, by, llmAt });
        if (result.score >= this.cfg.threshold) {
          setVacancyStatus(this.db, v.id, status);
          matched.push({ ...v, ...result });
        } else {
          setVacancyStatus(this.db, v.id, 'low');
        }
      }
      matched.sort((a, b) => b.score - a.score);
      return matched;
    };

    const matched = await scoreList(await enrich(addedAI, 25), { status: 'new' });
    const directMatched = direct
      ? await scoreList(await enrich(addedDirect, 10), { status: 'direct-pool' })
      : [];

    // Топ-3 с высокой оценкой получают разбор сразу — решение по карточке занимает секунды.
    let autoFits = 0;
    for (const v of matched.slice(0, 12)) {
      if (autoFits < 3 && v.score >= 75) {
        try {
          v.fitNote = await this.fitNote(v.id);
          if (v.fitNote) autoFits++;
        } catch (e) {
          this.log(`fit ${v.id}: ${e.message}`);
        }
      }
      await this.notifyVacancy(v);
    }
    if (matched.length > 12) {
      await this.send(`Ещё ${matched.length - 12} подходящих вакансий в базе — команда /more.`);
    }
    if (directMatched.length) {
      this.log(`директ-пул: ${directMatched.length} подходящих (по запросу)`);
    }

    // Пограничные вакансии прошлых сканов, до которых не дошёл бюджет LLM.
    const rescored = await this.rescoreBorderline(20);
    for (const v of rescored.slice(0, 5)) {
      await this.notifyVacancy(v);
    }
    if (rescored.length > 5) {
      await this.send(`Переоценка добавила ещё ${rescored.length - 5} — команда /more.`);
    }
    if (rescored.length) this.log(`переоценка: +${rescored.length} выше порога`);

    kvSet(this.db, 'lastScan', new Date().toISOString());

    if (this.cfg.autoApply) {
      for (const v of matched.slice(0, this.cfg.limits.dailyApplications)) {
        this.enqueueApply(v.id, v.resume);
      }
    }

    if (seen.size === 0 && batches.length > 0 && errors.length === 0) {
      if (!(await checkLoggedIn(page, this.cfg))) {
        throw new AuthError('сессия hh.ru истекла (поиск)');
      }
    }

    this.log(`scan: найдено ${addedAI.length + addedDirect.length}, подходящих ${matched.length}, переоценено +${rescored.length}, дублей ${dupCount}, не удалёнка ${nonRemoteCount}, авторазборов ${autoFits}`);
    if (nonRemoteCount >= 10 && addedAI.length + addedDirect.length === 0) {
      this.log(`scan: все ${nonRemoteCount} новых вакансий отфильтрованы по удалёнке — проверьте разметку hh.ru`);
    }
    return {
      found: addedAI.length + addedDirect.length,
      matched: matched.length,
      vacancies: matched,
      direct: directMatched,
      rescored: rescored.length,
      nonRemote: nonRemoteCount,
      totalBatches: batches.length,
      errors
    };
  }

  loadQueue() {
    try {
      const raw = JSON.parse(kvGet(this.db, 'applyQueue', '[]'));
      return Array.isArray(raw) ? raw.filter((j) => j && j.vacancyId) : [];
    } catch {
      return [];
    }
  }

  saveQueue() {
    kvSet(this.db, 'applyQueue', JSON.stringify(this.queue));
  }

  enqueueApply(vacancyId, resumeKey, letterText) {
    const app = getApplication(this.db, vacancyId);
    const deliveredOnHh = ['sent', 'viewed', 'invitation', 'rejected', 'hired'];
    if (app && (['applied', 'already', 'imported'].includes(app.status) || deliveredOnHh.includes(app.hh_status))) {
      this.log(`vacancy ${vacancyId}: уже есть отклик${app.hh_status ? ` (${app.hh_status})` : ''}`);
      return false;
    }
    const key = resumeKey === 'ai' ? 'ai' : 'direct';
    const job = { vacancyId, resumeKey: key, ...(letterText ? { letterText } : {}) };
    const existing = this.queue.findIndex((j) => j.vacancyId === vacancyId);
    if (existing >= 0) {
      this.queue[existing] = job;
      this.saveQueue();
      return true;
    }
    this.queue.push(job);
    this.saveQueue();
    return true;
  }

  // Черновик письма ждёт подтверждения в Telegram: сохраняем, чтобы он пережил рестарт.
  saveLetterDraft(vacancyId, resumeKey, letter) {
    kvSet(this.db, `letterDraft:${vacancyId}`, JSON.stringify({ letter, resumeKey, at: Date.now() }));
  }

  letterDraft(vacancyId) {
    try {
      const draft = JSON.parse(kvGet(this.db, `letterDraft:${vacancyId}`, 'null'));
      if (!draft?.letter) return null;
      if (Date.now() - (draft.at ?? 0) > 24 * 3600_000) return null;
      return draft;
    } catch {
      return null;
    }
  }

  async previewApply(vacancyId, resumeKey, { hint = '' } = {}) {
    const key = resumeKey === 'ai' ? 'ai' : 'direct';
    const app = getApplication(this.db, vacancyId);
    if (app && (['applied', 'already', 'imported'].includes(app.status)
      || ['sent', 'viewed', 'invitation', 'rejected', 'hired'].includes(app.hh_status))) {
      await this.send(`♻️ По вакансии ${esc(vacancyId)} отклик уже есть (${esc(app.hh_status || app.status)}).`);
      return '';
    }
    const { letter, vacancy } = await this.generateLetter(vacancyId, key, hint);
    this.saveLetterDraft(vacancyId, key, letter);

    const resumeLabel = key === 'ai' ? 'AI-специалист' : 'Директолог';
    const body = `✉️ <b>${esc(vacancy.title)}</b> — ${esc(vacancy.company || 'без компании')}\n`
      + `Резюме: ${esc(resumeLabel)} · ${letter.length} знаков\n\n${esc(letter)}\n\n`
      + '<i>Ответьте на это сообщение короткой правкой («сделай упор на n8n») — перепишу с учётом.</i>';
    const keyboard = [
      [
        { text: '📨 Отправить', callback_data: `apsend:${vacancyId}:${key}` },
        { text: '🔄 Переписать', callback_data: `aprewrite:${vacancyId}:${key}` }
      ],
      [{ text: '🔗 Вакансия', url: vacancy.url || `${this.cfg.hh.base}/vacancy/${vacancyId}` }]
    ];
    const msg = await this.send(body, keyboard);
    if (msg?.message_id) {
      kvSet(this.db, `letterMsg:${msg.message_id}`, JSON.stringify({ vacancyId, resumeKey: key, at: Date.now() }));
    }
    return letter;
  }

  startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }

  applicationsToday() {
    return countApplicationsSince(this.db, this.startOfToday());
  }

  async applyLoop() {
    let notifiedLimit = false;
    let notifiedWindow = false;
    while (!this.stopped) {
      const job = this.queue.shift();
      if (!job) {
        await sleep(1500);
        continue;
      }
      this.saveQueue();

      if (!withinWindow(new Date(), this.cfg.limits.sendWindow)) {
        this.queue.unshift(job);
        this.saveQueue();
        if (!notifiedWindow) {
          const w = this.cfg.limits.sendWindow;
          await this.send(`🕒 Отклики отправляются с ${w.from}:00 до ${w.to}:00 — очередь ждёт.`);
          notifiedWindow = true;
        }
        await sleep(Math.min(60_000, msUntilWindow(new Date(), this.cfg.limits.sendWindow)));
        continue;
      }
      notifiedWindow = false;

      if (this.applicationsToday() >= this.cfg.limits.dailyApplications) {
        this.queue.unshift(job);
        this.saveQueue();
        if (!notifiedLimit) {
          await this.send(`Дневной лимит откликов (${this.cfg.limits.dailyApplications}) исчерпан. Остальные — завтра.`);
          notifiedLimit = true;
        }
        await sleep(60_000);
        continue;
      }
      notifiedLimit = false;
      try {
        await this.processApply(job);
      } catch (e) {
        this.log(`apply ${job.vacancyId}: ${e.message}`);
        if (isAuthError(e)) {
          await this.alertAuthLost?.(e.message).catch(() => {});
        }
        setVacancyStatus(this.db, job.vacancyId, 'error');
        await this.send(
          `⚠️ Ошибка отклика на <b>${esc(job.vacancyId)}</b>: ${esc(e.message.slice(0, 300))}`,
          [[{ text: '🔁 Повторить', callback_data: `ap:${job.vacancyId}:${job.resumeKey}` }]]
        );
      }
      await sleep(rnd(this.cfg.limits.minDelaySec, this.cfg.limits.maxDelaySec) * 1000);
    }
  }

  async readVacancy(vacancyId) {
    return this.lock('read', async () => {
      const page = await this.page('read');
      return getVacancyDetails(page, this.cfg, vacancyId);
    });
  }

  // Перед письмом вакансия читается целиком, а не только название из выдачи.
  async refreshVacancy(vacancyId) {
    const v = getVacancy(this.db, vacancyId);
    if (!v) throw new Error('вакансия не найдена в базе');
    try {
      const details = await this.readVacancy(vacancyId);
      if (details?.snippet) {
        upsertVacancy(this.db, { ...v, ...details, query: v.query });
        return getVacancy(this.db, vacancyId);
      }
    } catch (e) {
      this.log(`read ${vacancyId}: ${e.message}`);
    }
    return v;
  }

  // Письмо из «✉️ Письмо» отправляем тем же текстом, что видел пользователь (свежее — до 6 часов).
  cachedLetter(vacancyId) {
    const file = path.join(this.cfg.paths.letters, `${vacancyId}.txt`);
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs > 6 * 3600_000) return '';
      return fs.readFileSync(file, 'utf8').trim();
    } catch {
      return '';
    }
  }

  async processApply({ vacancyId, resumeKey, letterText }) {
    let v = getVacancy(this.db, vacancyId);
    if (!v) throw new Error('вакансия не найдена в базе');
    v = await this.refreshVacancy(vacancyId);

    const previous = recentLetters(this.db, 20);
    const page = await this.page('apply');
    const supplied = String(letterText ?? '').trim();
    let letter = supplied ? prepareLetter(supplied, this.profile, { log: this.log }) : '';
    if (supplied && letter.length < 40) throw new Error('письмо из файла пустое или битое');
    if (!letter) letter = this.cachedLetter(vacancyId);
    if (!letter) {
      letter = await buildLetter({
        llmChat: this.llm,
        profile: this.profile,
        vacancy: v,
        resumeKey,
        previous,
        log: this.log
      });
    }
    fs.writeFileSync(path.join(this.cfg.paths.letters, `${vacancyId}.txt`), letter, 'utf8');

    const resumeId = this.cfg.resumes[resumeKey]?.id ?? '';
    let result;
    try {
      result = await applyToVacancy(page, this.cfg, v, resumeKey, letter);
    } catch (e) {
      if (e instanceof CaptchaError) {
        setVacancyStatus(this.db, vacancyId, 'captcha');
        recordApplication(this.db, { vacancyId, resumeKey, resumeId, letter, status: 'captcha', error: e.message });
        this.log(`apply ${vacancyId}: капча, ждём ручного решения`);
        await page.bringToFront().catch(() => {});
        await this.send(
          `🤖 Капча на hh для «<b>${esc(v.title)}</b>». Решите её в окне Chrome, затем нажмите кнопку.`,
          [[{ text: '✅ Решил, повторить', callback_data: `cap:${vacancyId}:${resumeKey}` }]]
        );
        return;
      }
      throw e;
    }

    if (result.status === 'applied' || result.status === 'already') {
      recordApplication(this.db, {
        vacancyId, resumeKey, resumeId, letter,
        status: result.status,
        error: ''
      });
      setVacancyStatus(this.db, vacancyId, 'applied');
      this.log(`apply ${vacancyId}: ${result.status} (${resumeKey}, ${letter.length} зн.)`);
      await this.send(
        `${result.status === 'already' ? '♻️ Уже был отклик' : '✅ Отклик отправлен'}: <b>${esc(v.title)}</b> — ${esc(v.company)}\nРезюме: ${esc(result.resume ?? resumeKey)}`
      );
      return;
    }

    if (result.status === 'closed') {
      recordApplication(this.db, { vacancyId, resumeKey, resumeId, letter, status: 'closed' });
      setVacancyStatus(this.db, vacancyId, 'closed');
      await this.send(`🚫 Вакансия закрыта: <b>${esc(v.title)}</b>`);
      return;
    }

    if (result.status === 'questions') {
      await this.handleQuestions(v, { vacancyId, resumeKey, resumeId, letter, questions: result.questions ?? [] });
      return;
    }

    recordApplication(this.db, { vacancyId, resumeKey, resumeId, letter, status: 'manual', error: result.reason ?? '' });
    setVacancyStatus(this.db, vacancyId, 'manual');
    this.log(`apply ${vacancyId}: вручную — ${result.reason ?? 'неизвестно'}`);
    await this.send(
      `✋ Нужно вручную: <b>${esc(v.title)}</b>\nПричина: ${esc(result.reason ?? 'неизвестно')}\n${esc(v.url)}`
    );
  }

  responseUrl(vacancyId) {
    return `${this.cfg.hh.base}/applicant/vacancy_response?vacancyId=${vacancyId}&startedWithQuestion=false&hhtmFrom=vacancy`;
  }

  // Черновики ответов на анкету: только по фактам профиля, заполнение — после подтверждения.
  async draftAnswers(v, questions, opts = {}) {
    return _draftAnswers(this, v, questions, opts);
  }

  saveAnswers(vacancyId, resumeKey, answers, questions = []) {
    const prev = questions.length ? null : this.answersDraft(vacancyId);
    const savedQuestions = questions.length ? questions : (prev?.questions ?? []);
    kvSet(this.db, `answers:${vacancyId}`, JSON.stringify({ answers, questions: savedQuestions, resumeKey, at: Date.now() }));
  }

  answersDraft(vacancyId) {
    try {
      const draft = JSON.parse(kvGet(this.db, `answers:${vacancyId}`, 'null'));
      if (!Array.isArray(draft?.answers)) return null;
      if (Date.now() - (draft.at ?? 0) > 24 * 3600_000) return null;
      return draft;
    } catch {
      return null;
    }
  }

  async handleQuestions(v, { vacancyId, resumeKey, resumeId, letter, questions }) {
    recordApplication(this.db, { vacancyId, resumeKey, resumeId, letter, status: 'manual', error: 'анкета работодателя' });
    setVacancyStatus(this.db, vacancyId, 'manual');
    this.log(`apply ${vacancyId}: анкета, ${questions.length} полей (снимок формы в letters/${vacancyId}-response.html)`);

    const answers = await this.draftAnswers(v, questions);
    if (answers.length || questions.length) this.saveAnswers(vacancyId, resumeKey, answers, questions);

    await sendQuestionsCard(this, v, { vacancyId, resumeKey, questions, answers });
  }

  async rewriteQuestions(vacancyId, resumeKey) {
    const v = getVacancy(this.db, vacancyId) ?? { id: vacancyId, title: vacancyId, company: '', resume: resumeKey };
    const draft = this.answersDraft(vacancyId);
    let questions = Array.isArray(draft?.questions) && draft.questions.length ? draft.questions : [];
    if (!questions.length) {
      const page = await this.page('apply');
      await page.goto(this.responseUrl(vacancyId), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      await assertLoggedIn(page, 'сессия hh.ru истекла (анкета)');
      questions = await readResponseQuestions(page).catch(() => []);
    }
    if (!questions.length) {
      await this.send(`⚠️ Вопросы анкеты по вакансии <b>${esc(vacancyId)}</b> не распознались — откройте форму вручную.`);
      return;
    }
    const answers = await this.draftAnswers(v, questions, {
      hint: 'Сформулируй ответы иначе: конкретнее, по делу, без канцелярита и с опорой только на факты.'
    });
    if (answers.length || questions.length) this.saveAnswers(vacancyId, resumeKey, answers, questions);
    await sendQuestionsCard(this, v, { vacancyId, resumeKey, questions, answers });
  }

  async fillQuestions(vacancyId, resumeKey) {
    const draft = this.answersDraft(vacancyId);
    if (!draft?.answers.length) throw new Error('черновик ответов устарел — нажмите «Отклик» или «Переписать»');
    const page = await this.page('apply');
    await page.goto(this.responseUrl(vacancyId), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await assertLoggedIn(page, 'сессия hh.ru истекла (заполнение анкеты)');
    const r = await fillResponseAnswers(page, draft.answers);
    if (!r.ok) {
      const detail = r.reason ? `, поле #${(r.index ?? 0) + 1}: ${esc(r.reason)}` : '';
      await this.send(`⚠️ Полей ${r.count}, ответов ${draft.answers.length}${detail} — проверьте форму вручную: ${this.responseUrl(vacancyId)}`);
      return;
    }
    this.log(`apply ${vacancyId}: поля анкеты заполнены (${r.count})`);
    await this.send(
      '✍️ Поля заполнены. Проверьте текст в Chrome и отправьте форму кнопкой ниже.',
      [[{ text: '📤 Отправить форму', callback_data: `asend:${vacancyId}:${resumeKey}` }],
       [{ text: '🔗 Открыть форму', url: this.responseUrl(vacancyId) }]]
    );
  }

  async submitQuestions(vacancyId, resumeKey) {
    const page = await this.page('apply');
    // После рестарта или ухода со страницы поля пустые — восстанавливаем ответы перед отправкой.
    if (!page.url().includes('vacancy_response')) {
      await page.goto(this.responseUrl(vacancyId), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const draft = this.answersDraft(vacancyId);
      if (draft?.answers.length) await fillResponseAnswers(page, draft.answers).catch(() => {});
    }
    const resumeId = this.cfg.resumes[resumeKey]?.id ?? '';
    const letter = this.letterDraft(vacancyId)?.letter ?? this.cachedLetter(vacancyId);
    let result;
    try {
      result = await submitResponseForm(page);
    } catch (e) {
      if (e instanceof CaptchaError) {
        recordApplication(this.db, { vacancyId, resumeKey, resumeId, letter, status: 'captcha', error: e.message });
        setVacancyStatus(this.db, vacancyId, 'captcha');
        await page.bringToFront().catch(() => {});
        await this.send('🤖 Капча при отправке анкеты. Решите её в Chrome и отправьте форму вручную.');
        return;
      }
      throw e;
    }

    if (result.status === 'applied') {
      recordApplication(this.db, { vacancyId, resumeKey, resumeId, letter, status: 'applied', error: '' });
      setVacancyStatus(this.db, vacancyId, 'applied');
      this.log(`apply ${vacancyId}: анкета отправлена`);
      await this.send('✅ Анкета отправлена.');
      return;
    }
    recordApplication(this.db, { vacancyId, resumeKey, resumeId, letter, status: 'manual', error: result.reason ?? '' });
    setVacancyStatus(this.db, vacancyId, 'manual');
    await this.send(`✋ Форма не отправилась: ${esc(result.reason ?? 'неизвестно')}`);
  }

  async generateLetter(vacancyId, resumeKey, hint = '') {
    return _generateLetter(this, vacancyId, resumeKey, hint);
  }

  // Полный каталог чатов раз в день: в «только непрочитанные» попадают не все переписки.
  async refreshChatDirectory(page) {
    const key = `chatDir:${localDayKey()}`;
    if (kvGet(this.db, key)) return null;
    const list = await listAllChats(page, this.cfg);
    for (const c of list) {
      upsertChat(this.db, { id: c.id, title: c.title, subtitle: c.subtitle, vacancy: '', last: c.last, time: c.time });
    }
    kvSet(this.db, key, '1');
    this.log(`чаты: каталог обновлён (${list.length})`);
    return list;
  }

  async checkChats() {
    return this.lock('chats', () => this.checkChatsOnce());
  }

  // Разовая починка: восстанавливаем заголовки и vacancy_id в чатах из шапки диалога.
  async repairChatVacancies() {
    const marker = 'chatVacancyRepair:v2';
    if (kvGet(this.db, marker)) return 0;
    const junk = new Set(['перейти', 'открыть', 'подробнее', 'вакансия', 'ссылка', 'смотреть']);
    let seen = [];
    try {
      const parsed = JSON.parse(kvGet(this.db, 'chatVacancyRepairSeen', '[]'));
      if (Array.isArray(parsed)) seen = parsed;
    } catch { /* игнорируем битый список */ }
    const attempted = new Set(seen);

    const broken = this.db.prepare("SELECT id, vacancy, COALESCE(vacancy_id, '') AS vacancy_id FROM chats").all()
      .filter((c) => {
        if (attempted.has(c.id)) return false;
        const v = String(c.vacancy ?? '').trim().toLowerCase();
        return !v || junk.has(v) || !String(c.vacancy_id ?? '').trim();
      });
    if (!broken.length) {
      kvSet(this.db, marker, 'ok:0');
      return 0;
    }

    const page = await this.page('chats');
    const batch = broken.slice(0, 20);
    let fixed = 0;
    for (const c of batch) {
      attempted.add(c.id);
      try {
        const data = await readChat(page, this.cfg, c.id);
        const vacancyId = data.vacancyId ?? '';
        const known = vacancyId ? getVacancy(this.db, vacancyId) : null;
        const title = known?.title || cleanVacancyTitle(data.vacancy);
        // Пустая строка затирает мусор: шаблон тогда скажет «по моему отклику».
        setChatVacancy(this.db, c.id, { vacancy: title, vacancyId });
        if (title || vacancyId) fixed++;
      } catch (e) {
        this.log(`чат ${c.id}: привязка не восстановлена (${e.message})`);
      }
    }
    kvSet(this.db, 'chatVacancyRepairSeen', JSON.stringify([...attempted].slice(-200)));
    if (broken.length <= batch.length) kvSet(this.db, marker, `done:${fixed}`);
    this.log(`чаты: привязка и названия восстановлены (${fixed}/${batch.length})`);
    return fixed;
  }

  async checkChatsOnce() {
    const page = await this.page('chats');
    let directory = null;
    try {
      directory = await this.refreshChatDirectory(page);
    } catch (e) {
      this.log(`чаты: каталог не обновлён (${e.message})`);
    }
    let chats = [];
    try {
      chats = await listUnreadChats(page, this.cfg);
    } catch (e) {
      if (e instanceof CaptchaError) {
        await page.bringToFront().catch(() => {});
        await this.send('🤖 Капча в чатах hh. Решите её в окне Chrome — следующий опрос пройдёт сам.');
        return { chats: 0, pending: 0 };
      }
      throw e;
    }

    const backfillEveryMinutes = this.cfg.limits.chatsBackfillEveryMinutes ?? 120;
    const recentLimit = this.cfg.limits.chatsRecentLimit ?? 20;
    const lastBackfill = Date.parse(kvGet(this.db, 'lastChatBackfill', ''));
    const backfillDue = !Number.isFinite(lastBackfill)
      || Date.now() - lastBackfill >= backfillEveryMinutes * 60_000;
    let recent = [];
    if (backfillDue && backfillEveryMinutes > 0) {
      try {
        const all = directory ?? await listAllChats(page, this.cfg);
        recent = all.slice(0, recentLimit);
        for (const c of recent) {
          upsertChat(this.db, { id: c.id, title: c.title, subtitle: c.subtitle, vacancy: '', last: c.last, time: c.time });
        }
        kvSet(this.db, 'lastChatBackfill', new Date().toISOString());
        if (recent.length) this.log(`чаты: запланировано перечитывание последних ${recent.length}`);
      } catch (e) {
        this.log(`чаты: периодическая проверка не удалась (${e.message})`);
      }
    }

    const retries = Object.values(chatRetryState(this.db))
      .filter((c) => /^\d+$/.test(c.id))
      .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
      .slice(0, 10);
    const candidates = [];
    const seen = new Set();
    for (const c of [...retries, ...chats.slice(0, 10), ...recent]) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      candidates.push(c);
    }

    let pendingCount = 0;
    for (const c of candidates) {
      let data;
      try {
        data = await readChat(page, this.cfg, c.id);
      } catch (e) {
        this.log(`chat ${c.id}: ${e.message}`);
        rememberChatRetry(this.db, c, e);
        continue;
      }
      clearChatRetry(this.db, c.id);

      // Название вакансии надёжнее брать из своей базы по id из ссылки: в DOM
      // заголовок соседствует с кнопкой «Перейти».
      const knownVacancy = data.vacancyId ? getVacancy(this.db, data.vacancyId) : null;
      upsertChat(this.db, {
        id: c.id,
        title: data.employer || c.title,
        subtitle: c.subtitle,
        vacancy: knownVacancy?.title || cleanVacancyTitle(data.vacancy),
        vacancyId: data.vacancyId ?? '',
        last: c.last,
        time: c.time
      });

      for (const m of data.messages) {
        addMessage(this.db, {
          chatId: c.id,
          extId: m.extId,
          direction: m.direction,
          author: m.author,
          text: m.text,
          ts: m.ts
        });
      }

      const lastOut = data.messages.map((m) => m.direction).lastIndexOf('out');
      if (lastOut >= 0) {
        const answeredForms = extractFormLinks(data.messages.slice(0, lastOut).filter((m) => m.direction === 'in'));
        for (const url of answeredForms) {
          const existing = getChatForm(this.db, c.id, url);
          if (existing?.status === 'pending') {
            recordChatForm(this.db, {
              chatId: c.id,
              url,
              msgExtId: existing.msg_ext_id,
              status: 'submitted',
              notifiedAt: existing.notified_at
            });
          }
        }
      }
      const pending = data.messages.slice(lastOut + 1).filter((m) => m.direction === 'in');
      if (!pending.length) continue;

      const lastKey = pending[pending.length - 1].extId;
      const handled = getChatHandled(this.db, c.id);
      if (handled?.extId && handled.extId === lastKey) continue;

      const chat = getChat(this.db, c.id);
      if (chat?.state && chat.state !== 'new') {
        this.db.prepare('UPDATE chats SET state = ?, updated_at = ? WHERE id = ?')
          .run('new', new Date().toISOString(), c.id);
      }

      const aiPending = pending.some((m) => m.isAi);
      const pendingForms = extractFormLinks(pending);
      for (const url of pendingForms) {
        recordChatForm(this.db, { chatId: c.id, url, msgExtId: lastKey, status: 'pending' });
      }
      const unnotifiedForms = pendingForms.filter((url) => {
        if (kvGet(this.db, `notifiedForm:${c.id}:${url}`)) return false;
        return getChatForm(this.db, c.id, url)?.status !== 'submitted';
      });

      let deliveryFailed = false;
      if (aiPending) {
        if (kvGet(this.db, `notifiedAiChat:${c.id}`) === lastKey) continue;
        pendingCount++;
        const quote = pending
          .slice(-3)
          .map((m) => `<i>${esc(m.isAi ? 'ИИ-помощник' : m.author || 'Работодатель')}:</i> ${esc(m.text.slice(0, 600))}`)
          .join('\n');
        const title = chat?.title || c.title || 'Чат hh';
        const sent = await this.send(
          `<b>ИИ-помощник в чате</b>\n${esc(title)}${chat?.vacancy ? ` — ${esc(chat.vacancy)}` : ''}\n\n${quote}\n\nАвтоматически отвечать не буду — откройте чат и ответьте вручную.`,
          [[{ text: 'Открыть чат', url: `${this.cfg.hh.base}/chat/${c.id}` }]]
        );
        if (sent) kvSet(this.db, `notifiedAiChat:${c.id}`, lastKey);
        else {
          deliveryFailed = true;
          this.log(`chat ${c.id}: уведомление об ИИ-помощнике не доставлено, повторю`);
        }
        if (deliveryFailed) rememberChatRetry(this.db, c, new Error('telegram delivery failed'));
        continue;
      }

      if (unnotifiedForms.length) {
        pendingCount++;
        const title = chat?.title || data.employer || c.title || 'Чат hh';
        const vacancy = chat?.vacancy ? ` — ${esc(chat.vacancy)}` : '';
        const quote = pending
          .slice(-3)
          .map((m) => `<i>${esc(m.author || 'Работодатель')}:</i> ${esc(m.text.slice(0, 600))}`)
          .join('\n');
        for (const [idx, url] of unnotifiedForms.entries()) {
          const body = idx === 0
            ? `📝 <b>Новая анкета</b>\n<b>${esc(title)}</b>${vacancy}\n\n${quote}\n\n<i>После заполнения отметьте кнопкой ниже, чтобы карточка закрылась.</i>`
            : `📝 <b>Новая анкета</b>\n<b>${esc(title)}</b>${vacancy}\n\nДополнительная форма для заполнения.`;
          const keyboard = idx === 0
            ? [
                [
                  { text: 'Открыть анкету', url },
                  { text: '✅ Анкета заполнена', callback_data: `fmdone:${c.id}` }
                ],
                [
                  { text: '✅ Заполнена + написать HR', callback_data: `fmsent:${c.id}` },
                  { text: '🔗 Открыть чат', url: `${this.cfg.hh.base}/chat/${c.id}` }
                ]
              ]
            : [
                [
                  { text: 'Открыть анкету', url },
                  { text: '✅ Анкета заполнена', callback_data: `fmdone:${c.id}` }
                ]
              ];
          const sent = await this.send(body, keyboard);
          if (sent) {
            kvSet(this.db, `notifiedForm:${c.id}:${url}`, '1');
            recordChatForm(this.db, {
              chatId: c.id,
              url,
              msgExtId: lastKey,
              status: 'pending',
              notifiedAt: new Date().toISOString()
            });
          } else {
            deliveryFailed = true;
            this.log(`форма ${c.id}: уведомление не доставлено, повторю`);
          }
        }
        if (deliveryFailed) rememberChatRetry(this.db, c, new Error('telegram delivery failed'));
        else kvSet(this.db, `notifiedChat:${c.id}`, lastKey);
        continue;
      }

      if (kvGet(this.db, `notifiedChat:${c.id}`) === lastKey) continue;
      pendingCount++;

      let draft = '';
      if (this.llm) {
        try {
          draft = await this.draftReply(c.id);
          setChatDraft(this.db, c.id, draft);
        } catch (e) {
          this.log(`draft ${c.id}: ${e.message}`);
        }
      }
      const sent = await this.notifyChat(c, chat, pending, draft);
      // Метку ставим только после доставки — иначе карточка теряется навсегда.
      if (sent) kvSet(this.db, `notifiedChat:${c.id}`, lastKey);
      else {
        deliveryFailed = true;
        this.log(`chat ${c.id}: карточка не доставлена, повторю`);
      }
      if (deliveryFailed) rememberChatRetry(this.db, c, new Error('telegram delivery failed'));
    }

    kvSet(this.db, 'lastChatsCheck', new Date().toISOString());
    this.log(`chats: непрочитанных ${chats.length}, ждут ответа ${pendingCount}`);
    try {
      const proposed = await proposeFollowups(this);
      if (proposed) this.log(`follow-up предложений: ${proposed}`);
    } catch (e) {
      this.log(`follow-ups: ${e.message}`);
    }
    return { chats: chats.length, pending: pendingCount };
  }

  async checkStatuses() {
    return this.lock('status', () => this.checkStatusesOnce());
  }

  async checkStatusesOnce() {
    const page = await this.page('status');
    let items = [];
    try {
      items = await listNegotiations(page, this.cfg);
    } catch (e) {
      if (e instanceof CaptchaError) {
        await page.bringToFront().catch(() => {});
        await this.send('🤖 Капча в «Переговорах». Решите её в Chrome — проверю в следующий раз.');
        return { total: 0, changed: 0, adopted: 0 };
      }
      throw e;
    }

    const byId = new Map(listApplications(this.db, 1000).map((a) => [a.vacancy_id, a]));
    let changed = 0;
    let adopted = 0;
    for (const item of items) {
      const app = byId.get(item.id);
      if (!app) {
        adoptNegotiation(this.db, { ...item, url: `${this.cfg.hh.base}/vacancy/${item.id}` });
        adopted++;
        continue;
      }
      // «Переговоры» — источник истины: отклик дошёл, даже если локально была капча или ручной сбой.
      if (['captcha', 'manual', 'error'].includes(app.status) && markApplicationDelivered(this.db, item.id)) {
        setVacancyStatus(this.db, item.id, 'applied');
        this.log(`statuses: ${item.id} подтверждён на hh (${item.status}), локальный ${app.status} исправлен`);
      }
      if (app.hh_status === item.status) continue;
      setApplicationHhStatus(this.db, item.id, item.status);
      changed++;
      if (item.status === 'invitation') {
        await this.send(`🎉 Приглашение: <b>${esc(app.title || item.title)}</b> — ${esc(app.company || '')}`);
      } else if (item.status === 'rejected') {
        await this.send(`❌ Отказ: <b>${esc(app.title || item.title)}</b> — ${esc(app.company || '')}`);
      }
    }

    kvSet(this.db, 'lastStatusCheck', new Date().toISOString());
    this.log(`статусы: ${items.length} откликов, изменений ${changed}, новых ${adopted}`);
    return { total: items.length, changed, adopted };
  }

  async digest() {
    return buildDigest(this);
  }

  statusView() {
    return _statusView(this);
  }

  // Заголовки, которые владелец отклонил кнопкой «Пропустить»: мягкие негативные примеры для llmRefine.
  rememberSkip(vacancyId) {
    const v = getVacancy(this.db, vacancyId);
    if (!v?.title) return;
    let list = [];
    try { list = JSON.parse(kvGet(this.db, 'skippedTitles', '[]')) ?? []; } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    const titles = [v.title, ...list.filter((t) => t !== v.title)].slice(0, 12);
    kvSet(this.db, 'skippedTitles', JSON.stringify(titles));
  }

  skipExamples() {
    try {
      const list = JSON.parse(kvGet(this.db, 'skippedTitles', '[]'));
      return Array.isArray(list) ? list.slice(0, 12) : [];
    } catch {
      return [];
    }
  }

  statsText() {
    return buildStatsText(this);
  }

  // Ночное обслуживание: консистентный бэкап, ротация лога, чистка вакансий/kv и ротация вкладок Chrome.
  async maintenance(opts = {}) {
    return runMaintenance(this, opts);
  }

  persistCompanies(list) {
    const raw = JSON.parse(fs.readFileSync(this.cfg.paths.config, 'utf8'));
    raw.hh ??= {};
    raw.hh.excludeCompanies = list;
    fs.writeFileSync(this.cfg.paths.config, JSON.stringify(raw, null, 2), 'utf8');
    this.cfg.hh.excludeCompanies = list;
  }

  blockCompany(name) {
    const clean = String(name ?? '').trim().slice(0, 120);
    if (!clean) return null;
    const list = [...(this.cfg.hh.excludeCompanies ?? [])];
    if (!list.some((c) => c.toLowerCase() === clean.toLowerCase())) list.push(clean);
    this.persistCompanies(list);
    return list;
  }

  unblockCompany(name) {
    const clean = String(name ?? '').trim().toLowerCase();
    if (!clean) return null;
    const list = (this.cfg.hh.excludeCompanies ?? []).filter((c) => c.toLowerCase() !== clean);
    this.persistCompanies(list);
    return list;
  }

  // Ищем отправленное письмо строго по vacancy_id; фолбэк по названию — только для старых чатов без id.
  sentLetterFor(chat) {
    return _sentLetterFor(this, chat);
  }

  async draftReply(chatId, hint = '') {
    return _draftReply(this, chatId, hint);
  }

  async notifyChat(c, chat, pending, draft) {
    const quote = pending
      .slice(-3)
      .map((m) => `<i>${esc(m.author || 'Работодатель')}:</i> ${esc(m.text.slice(0, 600))}`)
      .join('\n');
    const head = `💬 <b>${esc(chat?.title || c.title || 'Чат hh')}</b>${chat?.vacancy ? ` — ${esc(chat.vacancy)}` : ''}`;
    const body = draft
      ? `${head}\n\n${quote}\n\n<b>Черновик ответа:</b>\n${esc(draft)}\n\n<i>Ответьте на это сообщение правкой — перепишу черновик.</i>`
      : `${head}\n\n${quote}`;
    const keyboard = chatReplyKeyboard(this.cfg, c.id, { hasDraft: Boolean(draft), retryLabel: '🔄 Переписать', kind: 'chat' });
    const msg = await this.send(body, keyboard);
    if (msg?.message_id) {
      kvSet(this.db, `chatMsg:${msg.message_id}`, JSON.stringify({ chatId: String(c.id), kind: 'chat', at: Date.now() }));
    }
    return msg;
  }

  async sendChatReply(chatId, { notify = true } = {}) {
    const chat = await this.lock('chats', async () => {
      const current = getChat(this.db, chatId);
      if (!current?.draft) throw new Error('нет черновика');
      const page = await this.page('chats');
      await sendChatMessage(page, this.cfg, chatId, current.draft);
      addMessage(this.db, {
        chatId,
        extId: `local-${Date.now()}`,
        direction: 'out',
        author: '',
        text: current.draft,
        ts: new Date().toISOString()
      });
      markChatHandled(this.db, chatId, { state: 'handled' });
      return current;
    });
    if (notify) await this.send(`📨 Отправлено в чат <b>${esc(chat.title || chatId)}</b>`);
    return chat;
  }

  async markFormDone(chatId, { replyInChat = false } = {}) {
    const chat = getChat(this.db, chatId);
    const replyText = replyInChat ? await draftFormDoneReply(this, chatId, chat) : '';
    if (replyInChat) {
      await this.lock('chats', async () => {
        const page = await this.page('chats');
        await sendChatMessage(page, this.cfg, chatId, replyText);
      });
      addMessage(this.db, {
        chatId,
        extId: `local-${Date.now()}`,
        direction: 'out',
        author: '',
        text: replyText,
        ts: new Date().toISOString()
      });
    }
    const res = markChatHandled(this.db, chatId, { state: 'form_submitted' });
    this.log(`chat ${chatId}: анкета отмечена как заполненная${replyInChat ? ' (+ ответ отправлен HR)' : ''}`);
    return { chat, ...res };
  }

  markChatDone(chatId) {
    const chat = getChat(this.db, chatId);
    const res = markChatHandled(this.db, chatId, { state: 'handled' });
    this.log(`chat ${chatId}: чат отмечен как обработанный`);
    return { chat, ...res };
  }

  async redraft(chatId, { hint = '', kind = 'chat' } = {}) {
    const draft = await this.draftReply(chatId, hint);
    setChatDraft(this.db, chatId, draft);
    const chat = getChat(this.db, chatId);
    const mode = kind === 'followup' ? 'followup' : 'chat';
    const heading = mode === 'followup' ? '🔄 Новый follow-up для' : '🔄 Новый черновик для';
    const msg = await this.send(
      `${heading} <b>${esc(chat?.title || chatId)}</b>${chat?.vacancy ? ` — ${esc(chat.vacancy)}` : ''}:\n\n${esc(draft)}\n\n<i>Ответьте на это сообщение правкой — перепишу черновик.</i>`,
      chatReplyKeyboard(this.cfg, chatId, { hasDraft: true, retryLabel: '🔄 Ещё вариант', kind: mode })
    );
    if (msg?.message_id) {
      kvSet(this.db, `chatMsg:${msg.message_id}`, JSON.stringify({ chatId: String(chatId), kind: mode, at: Date.now() }));
    }
    return msg;
  }

  async handleUpdate(update) {
    return handleTelegramUpdate(this, update);
  }

  async botLoop() {
    return runBotLoop(this);
  }

  async run() {
    const pidFile = path.join(this.cfg.paths.root, 'agent.pid');
    fs.writeFileSync(pidFile, String(process.pid));
    await this.init();
    await this.send('🟢 Агент запущен, логин hh подтверждён. /scan — проверить выдачу, /status — состояние.');
    this.botLoop().catch((e) => this.log(`bot: ${e.message}`));
    this.applyLoop().catch((e) => this.log(`apply loop: ${e.message}`));

    const scanMs = this.cfg.limits.scanEveryHours * 3600_000;
    const chatMs = this.cfg.limits.chatsEveryMinutes * 60_000;
    const statusMs = (this.cfg.limits.statusEveryHours ?? 3) * 3600_000;
    const lastScan = kvGet(this.db, 'lastScan');
    const lastStatus = kvGet(this.db, 'lastStatusCheck');
    const digestHour = this.cfg.limits.digestHour ?? 20;

    const tickScan = () => this.runScheduledTask('scan', () => this.scan());
    const tickChats = () => this.runScheduledTask('chats', () => this.checkChats());
    const tickStatus = () => this.runScheduledTask('status', () => this.checkStatuses());
    const tickDigest = async () => {
      if (!this.tg) return;
      const now = new Date();
      if (now.getHours() < digestHour) return;
      const day = localDayKey(now);
      if (kvGet(this.db, 'lastDigest') === day) return;
      // Отметку ставим только после доставки: иначе неудачная отправка «съедает» день.
      const r = await this.digest();
      if (r.sent) kvSet(this.db, 'lastDigest', day);
      else this.log('digest: не доставлен, повторю при следующей проверке');
    };

    if (!lastScan || Date.now() - Date.parse(lastScan) > scanMs) tickScan();
    setTimeout(() => tickChats(), 5000);
    setTimeout(() => this.lock('chats', () => this.repairChatVacancies())
      .catch((e) => this.log(`чаты: починка названий не удалась (${e.message})`)), 12000);
    setTimeout(() => tickDigest().catch((e) => this.log(`digest: ${e.message}`)), 8000);
    if (!lastStatus || Date.now() - Date.parse(lastStatus) > statusMs) setTimeout(tickStatus, 20000);

    // Первый скан/сверку статусов ставим от времени последнего запуска, иначе после
    // перезапуска они уезжают на полный интервал и получается разрыв больше нормы.
    const scanAge = lastScan ? Date.now() - Date.parse(lastScan) : Infinity;
    const nextScanIn = scanAge < scanMs ? Math.max(60_000, scanMs - scanAge) : scanMs;
    this.timers.push(setTimeout(() => {
      tickScan();
      this.timers.push(setInterval(tickScan, scanMs));
    }, nextScanIn));

    this.timers.push(setInterval(tickChats, chatMs));

    const statusAge = lastStatus ? Date.now() - Date.parse(lastStatus) : Infinity;
    const nextStatusIn = statusAge < statusMs ? Math.max(60_000, statusMs - statusAge) : statusMs;
    this.timers.push(setTimeout(() => {
      tickStatus();
      this.timers.push(setInterval(tickStatus, statusMs));
    }, nextStatusIn));
    this.timers.push(setInterval(() => tickDigest().catch((e) => this.log(`digest: ${e.message}`)), 10 * 60_000));

    const tickMaintenance = async () => {
      try {
        await this.maintenance();
      } catch (e) {
        this.log(`maintenance: ${e.message}`);
      }
    };
    const nextMaintenance = new Date();
    nextMaintenance.setHours(3, 0, 0, 0);
    if (nextMaintenance <= new Date()) nextMaintenance.setDate(nextMaintenance.getDate() + 1);
    this.timers.push(setTimeout(() => {
      tickMaintenance();
      this.timers.push(setInterval(tickMaintenance, 24 * 3600_000));
    }, nextMaintenance - new Date()));

    this.shutdown = async ({ restart = false } = {}) => {
      if (this.stopped) return;
      this.stopped = true;
      this.timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
      this.tg?.close?.();
      this.llm?.reset?.();
      await closeContext();
      closeDb(this.db);
      try { fs.rmSync(pidFile, { force: true }); } catch { /* файл мог остаться от прошлого запуска */ }
      if (restart) {
        // Новый процесс поднимаем после освобождения профиля Chrome, иначе он не стартует.
        const child = spawn(process.execPath, [path.join(this.cfg.paths.root, 'src', 'cli.js'), 'run'], {
          cwd: this.cfg.paths.root,
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        });
        child.unref();
      }
      process.exit(0);
    };
    const stop = () => this.shutdown();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    this.log('Агент запущен. Ctrl+C — остановить.');
    await new Promise(() => {});
  }
}
