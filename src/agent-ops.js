import fs from 'node:fs';
import path from 'node:path';
import { getContext, newPage, AuthError } from './browser.js';
import { kvGet, kvSet, purgeLowVacancies, archiveStaleNewVacancies, purgeStaleKv } from './db.js';
import { esc } from './tg.js';

export const localDayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const SCHEDULER_LABELS = {
  scan: 'скан вакансий',
  chats: 'чаты hh',
  status: 'статусы откликов'
};

export const isAuthError = (err) => err instanceof AuthError
  || err?.name === 'AuthError'
  || /нет логина на hh\.ru|сессия hh\.ru истекла/i.test(String(err?.message ?? ''));

export function alertCooldownMs(agent) {
  return (agent.cfg?.limits?.alertCooldownHours ?? 3) * 3600_000;
}

export async function alertAuthLost(agent, reason = '') {
  kvSet(agent.db, 'authAlertActive', '1');
  const last = Number(kvGet(agent.db, 'lastAuthAlertAt', 0)) || 0;
  const now = Date.now();
  const cooldown = typeof agent.alertCooldownMs === 'function' ? agent.alertCooldownMs() : alertCooldownMs(agent);
  if (last && now - last < cooldown) {
    agent.log?.('hh auth: повторный алерт подавлен (cooldown)');
    return false;
  }
  kvSet(agent.db, 'lastAuthAlertAt', String(now));
  await agent.send(
    '🔐 <b>Потеряна авторизация на hh.ru</b>\n'
    + (reason ? `<i>${esc(reason)}</i>\n\n` : '\n')
    + 'Фоновый скан, чаты и статусы временно не работают.\n'
    + 'Перелогиньтесь в Chrome профиля <code>profile/</code> и выполните /restart.'
  );
  return true;
}

export async function maybeAlertAuthRecovered(agent) {
  if (kvGet(agent.db, 'authAlertActive', '') !== '1') return false;
  kvSet(agent.db, 'authAlertActive', '');
  kvSet(agent.db, 'lastAuthAlertAt', '0');
  await agent.send('🟢 <b>Авторизация на hh.ru восстановлена.</b>');
  return true;
}

export function clearSchedulerError(agent, kind) {
  agent.schedulerErrors ??= { scan: 0, chats: 0, status: 0 };
  agent.schedulerErrors[kind] = 0;
  kvSet(agent.db, `lastErrorAlert:${kind}`, '0');
}

export async function recordSchedulerError(agent, kind, error) {
  if (isAuthError(error)) {
    const fn = typeof agent.alertAuthLost === 'function'
      ? () => agent.alertAuthLost(error?.message || `ошибка в ${SCHEDULER_LABELS[kind] || kind}`)
      : () => alertAuthLost(agent, error?.message || `ошибка в ${SCHEDULER_LABELS[kind] || kind}`);
    await fn();
    return { kind, auth: true };
  }
  agent.schedulerErrors ??= { scan: 0, chats: 0, status: 0 };
  const count = (agent.schedulerErrors[kind] = (agent.schedulerErrors[kind] ?? 0) + 1);
  if (count < 3) return { kind, count, alerted: false };

  const key = `lastErrorAlert:${kind}`;
  const last = Number(kvGet(agent.db, key, 0)) || 0;
  const now = Date.now();
  const cooldown = typeof agent.alertCooldownMs === 'function' ? agent.alertCooldownMs() : alertCooldownMs(agent);
  if (last && now - last < cooldown) {
    return { kind, count, alerted: false, throttled: true };
  }
  kvSet(agent.db, key, String(now));
  const label = SCHEDULER_LABELS[kind] || kind;
  await agent.send(
    `⚠️ <b>Сбой планировщика (${esc(label)})</b>: ${count} ошибок подряд.\n`
    + `Последняя: <code>${esc(String(error?.message ?? error ?? 'неизвестно').slice(0, 300))}</code>`
  );
  return { kind, count, alerted: true };
}

export async function runScheduledTask(agent, kind, fn) {
  try {
    const res = await fn();
    if (kind === 'scan' && res && res.totalBatches > 0 && res.errors?.length >= res.totalBatches && res.found === 0) {
      await recordSchedulerError(agent, 'scan', new Error(res.errors[0] || 'все поисковые запросы завершились ошибкой'));
      return res;
    }
    if (typeof agent.clearSchedulerError === 'function') agent.clearSchedulerError(kind);
    else clearSchedulerError(agent, kind);
    if (kind !== 'scan' || (res?.totalBatches > 0 && (!res.errors || res.errors.length === 0))) {
      if (typeof agent.maybeAlertAuthRecovered === 'function') await agent.maybeAlertAuthRecovered();
      else await maybeAlertAuthRecovered(agent);
    }
    return res;
  } catch (e) {
    agent.log?.(`${kind}: ${e.message}`);
    const errFn = typeof agent.recordSchedulerError === 'function'
      ? () => agent.recordSchedulerError(kind, e)
      : () => recordSchedulerError(agent, kind, e);
    await errFn().catch(() => {});
    return null;
  }
}

// Периодическая ротация фоновых вкладок (прежде всего chatik.hh.ru), чтобы Chromium не копил память 24/7.
export async function acquirePage(agent, name, { maxAgeMs } = {}) {
  agent.pages ??= {};
  agent.pageCreatedAt ??= {};
  if (!agent.ctx) agent.ctx = await getContext(agent.cfg);
  const ttl = maxAgeMs ?? ((agent.cfg?.limits?.pageMaxAgeHours ?? 6) * 3600_000);

  try {
    const existing = agent.pages[name];
    const open = existing && !(existing.isClosed?.());
    if (open && name !== 'apply' && ttl > 0 && agent.pageCreatedAt[name]) {
      if (Date.now() - agent.pageCreatedAt[name] >= ttl) {
        await existing.close?.().catch(() => {});
        delete agent.pages[name];
        delete agent.pageCreatedAt[name];
        agent.log?.(`chrome: пересоздана вкладка ${name} (гигиена памяти)`);
      }
    }
    if (!agent.pages[name] || agent.pages[name].isClosed?.()) {
      agent.pages[name] = await newPage(agent.ctx);
      agent.pageCreatedAt[name] = Date.now();
    }
    return agent.pages[name];
  } catch {
    agent.ctx = null;
    agent.pages = {};
    agent.pageCreatedAt = {};
    agent.ctx = await getContext(agent.cfg);
    agent.pages[name] = await newPage(agent.ctx);
    agent.pageCreatedAt[name] = Date.now();
    return agent.pages[name];
  }
}

export async function recyclePages(agent, { maxAgeMs = 6 * 3600_000, force = false } = {}) {
  const names = Object.keys(agent.pages ?? {});
  let recycled = 0;
  for (const name of names) {
    const run = async () => {
      const p = agent.pages?.[name];
      if (!p || p.isClosed?.()) {
        if (agent.pages) delete agent.pages[name];
        if (agent.pageCreatedAt) delete agent.pageCreatedAt[name];
        return;
      }
      const created = Number(agent.pageCreatedAt?.[name] ?? 0);
      const age = created ? Date.now() - created : Infinity;
      const onApplyForm = name === 'apply'
        && typeof p.url === 'function'
        && String(p.url() || '').includes('vacancy_response');
      if (onApplyForm && age < 12 * 3600_000) return;
      if (!force && age < maxAgeMs) return;

      await p.close?.().catch(() => {});
      delete agent.pages[name];
      if (agent.pageCreatedAt) delete agent.pageCreatedAt[name];
      recycled++;
    };
    if (typeof agent.lock === 'function') await agent.lock(name, run);
    else await run();
  }
  return recycled;
}

// Ночное обслуживание: бэкап, ротация лога, чистка вакансий и одноразовых kv-ключей, ротация вкладок Chrome.
export async function runMaintenance(
  agent,
  {
    keepBackupsDays = 14,
    keepLowDays = 30,
    keepNewDays = 14,
    maxLogBytes = 2 * 1024 * 1024,
    maxDraftHours = 48,
    maxMsgRefDays = 14,
    keepPageHours = 6
  } = {}
) {
  const root = agent.cfg.paths.root;
  const backupDir = path.join(root, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  const file = path.join(backupDir, `data-${localDayKey()}.db`);
  let backup = 'уже есть';
  if (!fs.existsSync(file)) {
    // SQLite на Windows надёжнее принимает прямой слэш; кавычку в пути экранируем.
    const target = file.replace(/\\/g, '/').replace(/'/g, "''");
    agent.db.exec(`VACUUM INTO '${target}'`);
    backup = 'сделан';
  }

  let removed = 0;
  const cutoff = Date.now() - keepBackupsDays * 86400_000;
  for (const name of fs.readdirSync(backupDir)) {
    const full = path.join(backupDir, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) { fs.unlinkSync(full); removed++; }
    } catch { /* файл могли удалить параллельно */ }
  }

  let logRotated = false;
  const logFile = path.join(root, 'agent.log');
  try {
    if (fs.statSync(logFile).size > maxLogBytes) {
      fs.renameSync(logFile, `${logFile}.old`);
      logRotated = true;
    }
  } catch { /* лога может не быть при запуске из CLI */ }

  const purged = purgeLowVacancies(agent.db, new Date(Date.now() - keepLowDays * 86400_000).toISOString());
  const staleNew = archiveStaleNewVacancies(agent.db, new Date(Date.now() - keepNewDays * 86400_000).toISOString());
  const kvPurged = purgeStaleKv(agent.db, {
    todayKey: localDayKey(),
    maxDraftAgeMs: maxDraftHours * 3600_000,
    maxMsgRefAgeMs: maxMsgRefDays * 86400_000
  });
  const pagesRecycled = await recyclePages(agent, { maxAgeMs: keepPageHours * 3600_000, force: true });
  kvSet(agent.db, 'lastMaintenanceAt', new Date().toISOString());

  agent.log?.(
    `обслуживание: бэкап ${backup}, удалено старых бэкапов ${removed}, лог ${logRotated ? 'ротирован' : 'без изменений'}, `
    + `low удалено ${purged}, устаревших new в архив ${staleNew}, kv удалено ${kvPurged}, вкладок закрыто ${pagesRecycled}`
  );
  return { backup, removed, logRotated, purged, staleNew, kvPurged, pagesRecycled };
}
