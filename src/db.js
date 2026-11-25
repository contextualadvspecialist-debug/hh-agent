import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vacancies (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  company TEXT,
  salary TEXT,
  experience TEXT DEFAULT '',
  url TEXT,
  snippet TEXT,
  query TEXT,
  score INTEGER DEFAULT 0,
  reason TEXT,
  resume TEXT,
  scored_by TEXT DEFAULT '',
  llm_at TEXT DEFAULT '',
  fit TEXT DEFAULT '',
  fit_at TEXT DEFAULT '',
  status TEXT DEFAULT 'new',
  found_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vacancy_id TEXT NOT NULL UNIQUE,
  resume_key TEXT,
  resume_id TEXT,
  letter TEXT,
  status TEXT NOT NULL,
  error TEXT,
  hh_status TEXT DEFAULT '',
  hh_status_at TEXT DEFAULT '',
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  title TEXT,
  subtitle TEXT,
  vacancy TEXT,
  vacancy_id TEXT DEFAULT '',
  last_text TEXT,
  last_ts TEXT,
  draft TEXT,
  state TEXT DEFAULT 'new',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  ext_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  author TEXT,
  text TEXT NOT NULL,
  ts TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (chat_id, ext_id)
);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT
);
CREATE TABLE IF NOT EXISTS chat_forms (
  chat_id TEXT NOT NULL,
  url TEXT NOT NULL,
  msg_ext_id TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  notified_at TEXT DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, url)
);
CREATE INDEX IF NOT EXISTS idx_vac_status ON vacancies(status);
CREATE INDEX IF NOT EXISTS idx_vac_found_at ON vacancies(found_at);
CREATE INDEX IF NOT EXISTS idx_vac_score ON vacancies(score);
CREATE INDEX IF NOT EXISTS idx_app_applied_at ON applications(applied_at);
CREATE INDEX IF NOT EXISTS idx_app_hh_status ON applications(hh_status);
CREATE INDEX IF NOT EXISTS idx_msg_chat ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_forms_status ON chat_forms(status);
`;

export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  // CLI и демон могут писать одновременно: без таймаута вторая запись падает с SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);

  const cols = db.prepare('PRAGMA table_info(applications)').all().map((c) => c.name);
  for (const name of ['hh_status', 'hh_status_at']) {
    if (!cols.includes(name)) db.exec(`ALTER TABLE applications ADD COLUMN ${name} TEXT DEFAULT ''`);
  }
  const vacCols = db.prepare('PRAGMA table_info(vacancies)').all().map((c) => c.name);
  if (!vacCols.includes('experience')) db.exec("ALTER TABLE vacancies ADD COLUMN experience TEXT DEFAULT ''");
  for (const name of ['fit', 'fit_at', 'fit_src', 'scored_by', 'llm_at']) {
    if (!vacCols.includes(name)) db.exec(`ALTER TABLE vacancies ADD COLUMN ${name} TEXT DEFAULT ''`);
  }
  const chatCols = db.prepare('PRAGMA table_info(chats)').all().map((c) => c.name);
  if (!chatCols.includes('vacancy_id')) db.exec("ALTER TABLE chats ADD COLUMN vacancy_id TEXT DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_chats_vacancy_id ON chats(vacancy_id)');
  return db;
}

const now = () => new Date().toISOString();

export function upsertVacancy(db, v) {
  const ts = now();
  const res = db.prepare(`
    INSERT INTO vacancies (id, title, company, salary, experience, url, snippet, query, found_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      company = excluded.company,
      salary = excluded.salary,
      experience = COALESCE(NULLIF(excluded.experience, ''), vacancies.experience),
      url = excluded.url,
      snippet = excluded.snippet,
      updated_at = excluded.updated_at
  `).run(v.id, v.title, v.company ?? '', v.salary ?? '', v.experience ?? '', v.url ?? '', v.snippet ?? '', v.query ?? '', ts, ts);
  return res.changes > 0;
}

// by — кто поставил оценку: 'rule' (правила) или 'llm'. llmAt отмечает,
// что модель уже спрашивали, чтобы пограничные вакансии не переоценивались бесконечно.
export function setScore(db, id, { score, reason, resume, by = 'rule', llmAt = '' }) {
  db.prepare(`UPDATE vacancies
    SET score = ?, reason = ?, resume = ?, scored_by = ?,
        llm_at = CASE WHEN ? = '' THEN llm_at ELSE ? END,
        updated_at = ?
    WHERE id = ?`)
    .run(score, reason ?? '', resume ?? '', by, llmAt, llmAt || now(), now(), id);
}

export function listRuleScored(db, min, max, limit = 20) {
  return db.prepare(`
    SELECT * FROM vacancies
    WHERE status = 'low' AND score BETWEEN ? AND ? AND COALESCE(llm_at, '') = ''
    ORDER BY score DESC, found_at DESC
    LIMIT ?
  `).all(min, max, limit);
}

export function setVacancyStatus(db, id, status) {
  db.prepare('UPDATE vacancies SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
}

export function getVacancy(db, id) {
  return db.prepare('SELECT * FROM vacancies WHERE id = ?').get(id);
}

// fit_src — отпечаток описания, по которому сделан разбор: пересканирование вакансии
// не должно обнулять кэш, а изменённое описание — должно.
export function setVacancyFit(db, id, text, src = '') {
  db.prepare('UPDATE vacancies SET fit = ?, fit_at = ?, fit_src = ? WHERE id = ?').run(text, now(), src, id);
}

export function snippetFingerprint(text) {
  let h = 5381;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${s.length}:${h.toString(36)}`;
}

export function listVacancies(db, status, limit = 50, { order = 'score' } = {}) {
  const orderBy = order === 'recent'
    ? 'substr(found_at, 1, 10) DESC, score DESC, found_at DESC'
    : 'score DESC, found_at DESC';
  return db.prepare(`SELECT * FROM vacancies WHERE status = ? ORDER BY ${orderBy} LIMIT ?`).all(status, limit);
}

export function hasVacancy(db, id) {
  return !!db.prepare('SELECT 1 AS x FROM vacancies WHERE id = ?').get(id);
}

export function recordApplication(db, a) {
  db.prepare(`
    INSERT INTO applications (vacancy_id, resume_key, resume_id, letter, status, error, applied_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(vacancy_id) DO UPDATE SET
      status = excluded.status,
      error = excluded.error,
      applied_at = excluded.applied_at,
      resume_key = COALESCE(NULLIF(excluded.resume_key, ''), applications.resume_key),
      resume_id = COALESCE(NULLIF(excluded.resume_id, ''), applications.resume_id),
      letter = COALESCE(NULLIF(excluded.letter, ''), applications.letter)
  `).run(a.vacancyId, a.resumeKey ?? '', a.resumeId ?? '', a.letter ?? '', a.status, a.error ?? '', now());
}

// hh подтвердил отклик в «Переговорах» — локальный captcha/manual/error устарел.
export function markApplicationDelivered(db, vacancyId) {
  return db.prepare(`
    UPDATE applications SET status = 'applied', error = ''
    WHERE vacancy_id = ? AND status IN ('captcha', 'manual', 'error')
  `).run(vacancyId).changes > 0;
}

export function closeDb(db) {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* база могла быть закрыта */ }
  try { db.close(); } catch { /* повторное закрытие */ }
}

export function getApplication(db, vacancyId) {
  return db.prepare('SELECT * FROM applications WHERE vacancy_id = ?').get(vacancyId);
}

// Отклики, сделанные до запуска агента: берём из «Переговоров», чтобы отслеживать их статусы.
export function adoptNegotiation(db, n) {
  const ts = now();
  db.prepare(`
    INSERT OR IGNORE INTO vacancies (id, title, company, salary, url, snippet, query, status, found_at, updated_at)
    VALUES (?, ?, ?, '', ?, '', 'negotiations', 'imported', ?, ?)
  `).run(n.id, n.title || `Вакансия ${n.id}`, n.company ?? '', n.url ?? '', ts, ts);
  db.prepare(`
    INSERT OR IGNORE INTO applications
      (vacancy_id, resume_key, resume_id, letter, status, error, hh_status, hh_status_at, applied_at)
    VALUES (?, '', '', '', 'imported', '', ?, ?, '')
  `).run(n.id, n.status, ts);
}

export function recentLetters(db, limit = 20) {
  return db.prepare("SELECT letter FROM applications WHERE letter <> '' ORDER BY applied_at DESC LIMIT ?")
    .all(limit)
    .map((r) => r.letter);
}

export function countApplicationsSince(db, isoFrom) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM applications WHERE applied_at >= ? AND status IN ('applied', 'already')").get(isoFrom);
  return row?.n ?? 0;
}

export function upsertChat(db, c) {
  db.prepare(`
    INSERT INTO chats (id, title, subtitle, vacancy, vacancy_id, last_text, last_ts, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      subtitle = excluded.subtitle,
      vacancy = COALESCE(NULLIF(excluded.vacancy, ''), chats.vacancy),
      vacancy_id = COALESCE(NULLIF(excluded.vacancy_id, ''), chats.vacancy_id),
      last_text = excluded.last_text,
      last_ts = excluded.last_ts,
      updated_at = excluded.updated_at
  `).run(c.id, c.title ?? '', c.subtitle ?? '', c.vacancy ?? '', c.vacancyId ?? '', c.last ?? '', c.time ?? '', now());
}

export function setChatVacancy(db, chatId, { vacancy = '', vacancyId = '' } = {}) {
  db.prepare('UPDATE chats SET vacancy = ?, vacancy_id = ?, updated_at = ? WHERE id = ?')
    .run(vacancy, vacancyId, now(), chatId);
}

export function setChatDraft(db, chatId, draft) {
  db.prepare('UPDATE chats SET draft = ?, updated_at = ? WHERE id = ?').run(draft, now(), chatId);
}

export function getChat(db, chatId) {
  return db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
}

export function addMessage(db, m) {
  const values = [m.chatId, m.extId, m.direction, m.author ?? '', m.text, m.ts ?? '', now()];
  const res = db.prepare(`
    INSERT OR IGNORE INTO messages (chat_id, ext_id, direction, author, text, ts, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(...values);
  if (res.changes > 0) return true;
  // Повторное чтение чата исправляет старую классификацию, но не создаёт дубль.
  db.prepare(`
    UPDATE messages SET direction = ?, author = ?, text = ?, ts = ?
    WHERE chat_id = ? AND ext_id = ?
  `).run(m.direction, m.author ?? '', m.text, m.ts ?? '', m.chatId, m.extId);
  return false;
}

export function listMessages(db, chatId, limit = 30) {
  return db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?').all(chatId, limit).reverse();
}

export function recentVacancies(db, limit = 800) {
  return db.prepare('SELECT id, title, company, salary, status FROM vacancies ORDER BY found_at DESC LIMIT ?').all(limit);
}

// Для дедупликации по описанию: заголовки не нужны, а сниппеты режем, чтобы не тянуть мегабайты.
export function recentSnippets(db, limit = 800) {
  return db.prepare(`
    SELECT id, title, company, substr(snippet, 1, 800) AS snippet
    FROM vacancies WHERE COALESCE(snippet, '') <> ''
    ORDER BY found_at DESC LIMIT ?
  `).all(limit);
}

export function setApplicationHhStatus(db, vacancyId, status) {
  db.prepare('UPDATE applications SET hh_status = ?, hh_status_at = ? WHERE vacancy_id = ?').run(status, now(), vacancyId);
}

export function listApplications(db, limit = 300) {
  return db.prepare(`
    SELECT a.*, v.title, v.company FROM applications a
    LEFT JOIN vacancies v ON v.id = a.vacancy_id
    ORDER BY a.applied_at DESC LIMIT ?
  `).all(limit);
}

export function countVacanciesSince(db, isoFrom) {
  return db.prepare('SELECT COUNT(*) AS n FROM vacancies WHERE found_at >= ?').get(isoFrom)?.n ?? 0;
}

export function countApplicationsByHhStatus(db, status) {
  return db.prepare('SELECT COUNT(*) AS n FROM applications WHERE hh_status = ?').get(status)?.n ?? 0;
}

export function countApplicationsByHhStatusSince(db, status, isoFrom) {
  return db.prepare('SELECT COUNT(*) AS n FROM applications WHERE hh_status = ? AND hh_status_at >= ?')
    .get(status, isoFrom)?.n ?? 0;
}

export function kvGet(db, k, fallback = null) {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
  return row ? row.v : fallback;
}

// Воронка откликов в разрезе резюме и поискового запроса: только доставленные/подтверждённые отклики.
export function applicationFunnel(db) {
  return db.prepare(`
    SELECT COALESCE(NULLIF(resume_key, ''), '—') AS key, hh_status AS status, COUNT(*) AS n
    FROM applications
    WHERE status IN ('applied', 'already', 'imported') OR COALESCE(hh_status, '') <> ''
    GROUP BY 1, 2
  `).all();
}

export function applicationFunnelByQuery(db) {
  return db.prepare(`
    SELECT COALESCE(NULLIF(v.query, ''), '—') AS key, a.hh_status AS status, COUNT(*) AS n
    FROM applications a
    LEFT JOIN vacancies v ON v.id = a.vacancy_id
    WHERE a.status IN ('applied', 'already', 'imported') OR COALESCE(a.hh_status, '') <> ''
    GROUP BY 1, 2
  `).all();
}

export function purgeLowVacancies(db, isoBefore) {
  return db.prepare(`
    DELETE FROM vacancies
    WHERE status = 'low' AND found_at < ?
      AND id NOT IN (SELECT vacancy_id FROM applications)
  `).run(isoBefore).changes;
}

export function archiveStaleNewVacancies(db, isoBefore) {
  return db.prepare(`
    UPDATE vacancies
    SET status = 'stale', updated_at = ?
    WHERE status = 'new' AND found_at < ?
  `).run(now(), isoBefore).changes;
}

export function kvSet(db, k, v) {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
}

export function recordChatForm(db, { chatId, url, msgExtId = '', status = 'pending', notifiedAt = '' }) {
  const ts = now();
  db.prepare(`
    INSERT INTO chat_forms (chat_id, url, msg_ext_id, status, notified_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, url) DO UPDATE SET
      msg_ext_id = COALESCE(NULLIF(excluded.msg_ext_id, ''), chat_forms.msg_ext_id),
      notified_at = COALESCE(NULLIF(chat_forms.notified_at, ''), excluded.notified_at),
      status = CASE WHEN chat_forms.status = 'submitted' THEN 'submitted' ELSE excluded.status END,
      updated_at = excluded.updated_at
  `).run(chatId, url, msgExtId, status, notifiedAt, ts);
}

export function getChatForm(db, chatId, url) {
  return db.prepare('SELECT * FROM chat_forms WHERE chat_id = ? AND url = ?').get(chatId, url);
}

export function getLatestMessageExtId(db, chatId, direction = 'in') {
  return db.prepare(
    'SELECT ext_id FROM messages WHERE chat_id = ? AND direction = ? ORDER BY id DESC LIMIT 1'
  ).get(chatId, direction)?.ext_id ?? '';
}

export function getChatHandled(db, chatId) {
  try {
    const raw = JSON.parse(kvGet(db, `chatHandled:${chatId}`, 'null'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

export function markChatHandled(db, chatId, { extId = '', state = 'handled' } = {}) {
  const ts = now();
  const resolvedExtId = extId || getLatestMessageExtId(db, chatId, 'in');
  db.prepare('UPDATE chats SET state = ?, draft = ?, updated_at = ? WHERE id = ?')
    .run(state, '', ts, chatId);
  if (resolvedExtId) kvSet(db, `notifiedChat:${chatId}`, resolvedExtId);
  kvSet(db, `chatHandled:${chatId}`, JSON.stringify({ extId: resolvedExtId, state, at: ts }));

  let formsUpdated = 0;
  if (state === 'form_submitted') {
    const legacyPrefix = `notifiedForm:${chatId}:`;
    const legacyForms = db.prepare('SELECT k FROM kv WHERE k LIKE ?').all(`${legacyPrefix}%`);
    for (const row of legacyForms) {
      const url = row.k.slice(legacyPrefix.length);
      if (url) recordChatForm(db, { chatId, url, msgExtId: resolvedExtId, status: 'pending', notifiedAt: ts });
    }
    formsUpdated = db.prepare(`
      UPDATE chat_forms SET status = 'submitted', updated_at = ?
      WHERE chat_id = ? AND status <> 'submitted'
    `).run(ts, chatId).changes;
  }
  return { extId: resolvedExtId, state, formsUpdated };
}

export function countPendingChatForms(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM chat_forms WHERE status = 'pending'").get()?.n ?? 0;
}

export function listPendingChatForms(db, limit = 20) {
  return db.prepare(`
    SELECT
      cf.chat_id,
      cf.url,
      cf.msg_ext_id,
      cf.status,
      cf.notified_at,
      cf.updated_at,
      COALESCE(NULLIF(c.title, ''), cf.chat_id) AS title,
      COALESCE(c.vacancy, '') AS vacancy,
      COALESCE(c.vacancy_id, '') AS vacancy_id
    FROM chat_forms cf
    LEFT JOIN chats c ON c.id = cf.chat_id
    WHERE cf.status = 'pending'
    ORDER BY COALESCE(NULLIF(cf.notified_at, ''), cf.updated_at) DESC, cf.updated_at DESC
    LIMIT ?
  `).all(limit);
}

// Чаты с неотвеченным входящим сообщением (исключаем уже закрытые и ожидающие внешнюю анкету).
export function countPendingChats(db) {
  return db.prepare(`
    SELECT COUNT(*) AS n
    FROM chats c
    JOIN messages m ON m.id = (SELECT id FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1)
    WHERE COALESCE(c.state, 'new') = 'new'
      AND m.direction = 'in'
      AND NOT EXISTS (
        SELECT 1 FROM chat_forms cf WHERE cf.chat_id = c.id AND cf.status = 'pending'
      )
  `).get()?.n ?? 0;
}

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TERMINAL_VACANCY_STATUSES = new Set(['applied', 'skipped', 'closed', 'stale', 'low']);

// Чистим только одноразовые/устаревшие kv-ключи; маркеры дедупликации (notified*, chatHandled*, followupDone*) сохраняем.
export function purgeStaleKv(
  db,
  {
    todayKey = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })(),
    nowMs = Date.now(),
    maxDraftAgeMs = 48 * 3600_000,
    maxMsgRefAgeMs = 14 * 86400_000,
    maxLegacyMsgRefs = 200
  } = {}
) {
  const toDelete = [];

  for (const row of db.prepare("SELECT k FROM kv WHERE k LIKE 'chatDir:%' OR k LIKE 'followupCount:%'").all()) {
    const day = row.k.split(':').slice(1).join(':');
    if (DAY_KEY_RE.test(day) && day < todayKey) toDelete.push(row.k);
  }

  for (const row of db.prepare("SELECT k, v FROM kv WHERE k LIKE 'letterDraft:%' OR k LIKE 'answers:%'").all()) {
    let parsed = null;
    try { parsed = JSON.parse(row.v); } catch { /* битый JSON удаляем */ }
    const at = Number(parsed?.at);
    if (!parsed || typeof parsed !== 'object' || !Number.isFinite(at) || nowMs - at > maxDraftAgeMs) {
      toDelete.push(row.k);
    }
  }

  const collectMsgRefs = (prefix, checkVacancy) => {
    const rows = db.prepare('SELECT k, v FROM kv WHERE k LIKE ?').all(`${prefix}%`);
    const legacy = [];
    for (const row of rows) {
      let parsed = null;
      try { parsed = JSON.parse(row.v); } catch { /* битую ссылку удаляем */ }
      if (!parsed || typeof parsed !== 'object') {
        toDelete.push(row.k);
        continue;
      }
      const at = Number(parsed.at);
      if (Number.isFinite(at)) {
        if (nowMs - at > maxMsgRefAgeMs) toDelete.push(row.k);
        continue;
      }
      if (checkVacancy && parsed.vacancyId) {
        const vac = getVacancy(db, String(parsed.vacancyId));
        if (vac && TERMINAL_VACANCY_STATUSES.has(vac.status)) {
          toDelete.push(row.k);
          continue;
        }
      }
      legacy.push({ k: row.k, msgId: Number(row.k.slice(prefix.length)) || 0 });
    }
    legacy.sort((a, b) => b.msgId - a.msgId);
    for (const item of legacy.slice(maxLegacyMsgRefs)) toDelete.push(item.k);
  };

  collectMsgRefs('letterMsg:', true);
  collectMsgRefs('chatMsg:', false);

  if (!toDelete.length) return 0;
  const del = db.prepare('DELETE FROM kv WHERE k = ?');
  db.exec('BEGIN');
  try {
    for (const key of toDelete) del.run(key);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return toDelete.length;
}
