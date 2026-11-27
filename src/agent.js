import fs from 'node:fs';
import path from 'node:path';
import { checkLoggedIn, closeContext } from './browser.js';
import { getVacancyDetails } from './hh-search.js';
import { makeLlmClient } from './llm.js';
import { Telegram, esc, vacancyKeyboard, vacancyText } from './tg.js';
import {
  openDb, closeDb, upsertVacancy, getVacancy, setVacancyStatus,
  getApplication, countApplicationsSince, kvGet, kvSet, recordLlmUsage
} from './db.js';
import {
  fitText as _fitText, fitNote as _fitNote, analyzeFit as _analyzeFit,
  generateLetter as _generateLetter, draftAnswers as _draftAnswers,
  sentLetterFor as _sentLetterFor, draftReply as _draftReply
} from './agent-prompts.js';
import { buildDigest, buildStatsText, statusView as _statusView } from './agent-analytics.js';
import {
  localDayKey, alertCooldownMs as _alertCooldownMs,
  alertAuthLost as _alertAuthLost, maybeAlertAuthRecovered as _maybeAlertAuthRecovered,
  clearSchedulerError as _clearSchedulerError, recordSchedulerError as _recordSchedulerError,
  runScheduledTask as _runScheduledTask, acquirePage, recyclePages, runMaintenance,
  getPauseState, setPauseState
} from './agent-ops.js';
import { rescoreBorderline as _rescoreBorderline, scanOnce as _scanOnce } from './agent-scan.js';
import {
  applyLoop as _applyLoop, processApply as _processApply,
  handleQuestions as _handleQuestions, rewriteQuestions as _rewriteQuestions,
  fillQuestions as _fillQuestions, submitQuestions as _submitQuestions
} from './agent-apply.js';
import {
  refreshChatDirectory as _refreshChatDirectory, repairChatVacancies as _repairChatVacancies,
  checkChatsOnce as _checkChatsOnce, checkStatusesOnce as _checkStatusesOnce,
  notifyChat as _notifyChat, sendChatReply as _sendChatReply,
  sendVacancyFollowup as _sendVacancyFollowup, redraftVacancyFollowup as _redraftVacancyFollowup,
  markFormDone as _markFormDone, markChatDone as _markChatDone, redraft as _redraft
} from './agent-chats.js';
import { telegramPollBackoffMs, handleTelegramUpdate, runBotLoop } from './agent-telegram.js';

export { telegramPollBackoffMs };

export class Agent {
  constructor(cfg, { log = console.log } = {}) {
    this.cfg = cfg;
    this.log = log;
    this.db = openDb(cfg.paths.db);
    this.profile = JSON.parse(fs.readFileSync(path.join(cfg.paths.root, 'profile.json'), 'utf8'));
    this.llm = makeLlmClient(cfg.llm, {
      onUsage: (u) => {
        try {
          recordLlmUsage(this.db, { day: localDayKey(), ...u });
        } catch (e) {
          this.log?.(`llm_usage: ${e.message}`);
        }
      }
    });
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

  pauseModes() {
    return getPauseState(this.db);
  }

  isPaused(mode) {
    const state = this.pauseModes();
    if (mode === 'scan' || mode === 'apply') return Boolean(state[mode]);
    return Boolean(state.scan || state.apply);
  }

  setPaused(patch = {}) {
    return setPauseState(this.db, patch);
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
    const prev = this.locks[name] ?? Promise.resolve();
    let release;
    const gate = new Promise((r) => (release = r));
    this.locks[name] = prev.then(() => gate, () => gate);
    try {
      await prev;
    } catch (err) {
      this.log?.(`lock ${name}: ${err?.message || err}`);
    }
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

  async rescoreBorderline(budget = 20) {
    return _rescoreBorderline(this, budget);
  }

  async scan({ direct = false } = {}) {
    return this.lock('search', () => this.scanOnce({ direct }));
  }

  async scanOnce(opts = {}) {
    return _scanOnce(this, opts);
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
    return _applyLoop(this);
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

  async processApply(job) {
    return _processApply(this, job);
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

  async handleQuestions(v, params) {
    return _handleQuestions(this, v, params);
  }

  async rewriteQuestions(vacancyId, resumeKey) {
    return _rewriteQuestions(this, vacancyId, resumeKey);
  }

  async fillQuestions(vacancyId, resumeKey) {
    return _fillQuestions(this, vacancyId, resumeKey);
  }

  async submitQuestions(vacancyId, resumeKey) {
    return _submitQuestions(this, vacancyId, resumeKey);
  }

  async generateLetter(vacancyId, resumeKey, hint = '') {
    return _generateLetter(this, vacancyId, resumeKey, hint);
  }

  async refreshChatDirectory(page) {
    return _refreshChatDirectory(this, page);
  }

  async checkChats() {
    return this.lock('chats', () => this.checkChatsOnce());
  }

  async repairChatVacancies() {
    return _repairChatVacancies(this);
  }

  async checkChatsOnce() {
    return _checkChatsOnce(this);
  }

  async checkStatuses() {
    return this.lock('status', () => this.checkStatusesOnce());
  }

  async checkStatusesOnce() {
    return _checkStatusesOnce(this);
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
    return _notifyChat(this, c, chat, pending, draft);
  }

  async sendChatReply(chatId, opts = {}) {
    return _sendChatReply(this, chatId, opts);
  }

  async markFormDone(chatId, opts = {}) {
    return _markFormDone(this, chatId, opts);
  }

  markChatDone(chatId) {
    return _markChatDone(this, chatId);
  }

  async redraft(chatId, opts = {}) {
    return _redraft(this, chatId, opts);
  }

  async sendVacancyFollowup(vacancyId, opts = {}) {
    return _sendVacancyFollowup(this, vacancyId, opts);
  }

  async redraftVacancyFollowup(vacancyId, opts = {}) {
    return _redraftVacancyFollowup(this, vacancyId, opts);
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

    const tickScan = () => {
      if (this.isPaused('scan')) {
        this.log('scan: автоскан на паузе (/resume чтобы включить)');
        return Promise.resolve(null);
      }
      return this.runScheduledTask('scan', () => this.scan());
    };
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
