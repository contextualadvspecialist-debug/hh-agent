import {
  getVacancy, countVacanciesSince, countApplicationsSince, countApplicationsByHhStatus,
  countApplicationsByHhStatusSince, listApplicationsByHhStatus, applicationFunnel, applicationFunnelByQuery,
  countPendingChatForms, listPendingChatForms, countPendingChats, kvGet, getLlmUsageSummary
} from './db.js';
import { withinWindow } from './schedule.js';
import { esc } from './tg.js';
import { localDayKey, getPauseState } from './agent-ops.js';

const SEEN_BY_EMPLOYER = ['viewed', 'invitation', 'rejected', 'hired'];
const POSITIVE = ['invitation', 'hired'];

export function funnelGroups(rows) {
  const map = new Map();
  for (const r of rows) {
    const g = map.get(r.key) ?? { key: r.key, total: 0, viewed: 0, invited: 0, rejected: 0 };
    g.total += r.n;
    if (SEEN_BY_EMPLOYER.includes(r.status)) g.viewed += r.n;
    if (POSITIVE.includes(r.status)) g.invited += r.n;
    if (r.status === 'rejected') g.rejected += r.n;
    map.set(r.key, g);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

export function pct(part, total) {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : '0%';
}

export function formatCheckTime(iso, now = new Date()) {
  const ts = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(ts)) return 'не было';
  const d = new Date(ts);
  const diffMin = Math.max(0, Math.round((now.getTime() - ts) / 60_000));
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  const stamp = sameDay
    ? hhmm
    : `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${hhmm}`;
  let rel = 'только что';
  if (diffMin >= 1 && diffMin < 60) rel = `${diffMin} мин назад`;
  else if (diffMin >= 60 && diffMin < 24 * 60) rel = `${Math.floor(diffMin / 60)} ч назад`;
  else if (diffMin >= 24 * 60) rel = `${Math.floor(diffMin / (24 * 60))} дн. назад`;
  return `${stamp} (${rel})`;
}

const shortTitle = (text, max = 22) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

export function statusView(agent, now = new Date()) {
  const since = typeof agent.startOfToday === 'function'
    ? agent.startOfToday()
    : (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.toISOString(); })();
  const applied = typeof agent.applicationsToday === 'function'
    ? agent.applicationsToday()
    : countApplicationsSince(agent.db, since);
  const daily = agent.cfg?.limits?.dailyApplications ?? 8;
  const queue = Array.isArray(agent.queue) ? agent.queue : [];
  const pendingChats = countPendingChats(agent.db);
  const pendingForms = countPendingChatForms(agent.db);

  const lastScan = kvGet(agent.db, 'lastScan', '');
  const lastChats = kvGet(agent.db, 'lastChatsCheck', '');
  const lastStatus = kvGet(agent.db, 'lastStatusCheck', '');
  const authPaused = kvGet(agent.db, 'authAlertActive', '') === '1';
  const pause = typeof agent.pauseModes === 'function' ? agent.pauseModes() : getPauseState(agent.db);
  const paused = Boolean(pause?.scan || pause?.apply);

  const w = agent.cfg?.limits?.sendWindow;
  const winText = w ? `${w.from ?? 10}:00–${w.to ?? 19}:00` : '10:00–19:00';
  const activeWindow = withinWindow(now, w);

  const errEntries = Object.entries(agent.schedulerErrors ?? {})
    .filter(([, count]) => Number(count) > 0)
    .map(([k, count]) => `${k}: ${count}`);

  const lines = [
    '📌 <b>Статус агента</b>',
    '',
    `Откликов сегодня: <b>${applied}</b> из ${daily} · окно ${winText} (${activeWindow ? 'активно' : 'пауза'})`,
    `Ожидают ответа: чаты <b>${pendingChats}</b> · анкеты <b>${pendingForms}</b>`,
    `Проверки: скан ${esc(formatCheckTime(lastScan, now))} · чаты ${esc(formatCheckTime(lastChats, now))} · статусы ${esc(formatCheckTime(lastStatus, now))}`
  ];
  const pausedLabels = [];
  if (pause?.scan) pausedLabels.push('автоскан');
  if (pause?.apply) pausedLabels.push('отклики');
  if (pausedLabels.length) lines.push(`⏸ <b>На паузе:</b> ${pausedLabels.join(' · ')} (/resume)`);
  if (authPaused) lines.push('🔐 <b>Сессия hh.ru на паузе</b> — нужен повторный вход и /restart.');
  if (errEntries.length) lines.push(`⚠️ Сбои планировщика: ${esc(errEntries.join(', '))}`);

  const keyboard = [];
  if (queue.length) {
    lines.push('', `<b>Очередь откликов (${queue.length}):</b>`);
    const preview = queue.slice(0, 8);
    preview.forEach((j, idx) => {
      const v = getVacancy(agent.db, j.vacancyId);
      const role = j.resumeKey === 'ai' ? 'AI' : 'Директолог';
      const label = v?.title ? `${v.title}${v.company ? ` — ${v.company}` : ''}` : `Вакансия ${j.vacancyId}`;
      lines.push(`${idx + 1}. ${esc(label)} (${role})`);
    });
    if (queue.length > preview.length) {
      lines.push(`<i>…и ещё ${queue.length - preview.length}</i>`);
    }

    const dropButtons = queue
      .slice(0, 6)
      .filter((j) => /^\d{3,}$/.test(String(j.vacancyId ?? '')))
      .map((j) => {
        const v = getVacancy(agent.db, j.vacancyId);
        return {
          text: `❌ ${shortTitle(v?.title || j.vacancyId)}`,
          callback_data: `qdrop:${j.vacancyId}`
        };
      });
    for (let i = 0; i < dropButtons.length; i += 2) {
      keyboard.push(dropButtons.slice(i, i + 2));
    }
    keyboard.push([{ text: `🧹 Очистить очередь (${queue.length})`, callback_data: 'qclear' }]);
  } else {
    lines.push('', 'Очередь откликов пуста.');
  }
  keyboard.push([
    { text: paused ? '▶️ Возобновить' : '⏸ Пауза', callback_data: paused ? 'mode:resume' : 'mode:pause' },
    { text: '🧹 Обслуживание', callback_data: 'mode:maint' }
  ]);

  return {
    text: lines.join('\n'),
    keyboard,
    applied,
    daily,
    queueLength: queue.length,
    pendingChats,
    pendingForms,
    pause: { scan: Boolean(pause?.scan), apply: Boolean(pause?.apply) }
  };
}

export async function sendStatus(agent) {
  const view = statusView(agent);
  await agent.send(view.text, view.keyboard.length ? view.keyboard : undefined);
  return view;
}

export async function editStatusMessage(agent, message, notice = '') {
  const view = statusView(agent);
  const body = notice ? `${notice}\n\n${view.text}` : view.text;
  if (message?.message_id && agent.tg?.edit) {
    await agent.tg.edit(message.message_id, body, view.keyboard);
    return view;
  }
  await agent.send(body, view.keyboard.length ? view.keyboard : undefined);
  return view;
}

export async function buildDigest(agent) {
  const since = typeof agent.startOfToday === 'function'
    ? agent.startOfToday()
    : (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); })();
  const found = countVacanciesSince(agent.db, since);
  const applied = typeof agent.applicationsToday === 'function'
    ? agent.applicationsToday()
    : countApplicationsSince(agent.db, since);
  const invitationsToday = countApplicationsByHhStatusSince(agent.db, 'invitation', since);
  const rejectedToday = countApplicationsByHhStatusSince(agent.db, 'rejected', since);

  const viewedPending = countApplicationsByHhStatus(agent.db, 'viewed');
  const unreadPending = countApplicationsByHhStatus(agent.db, 'sent')
    + countApplicationsByHhStatus(agent.db, '');
  const pending = viewedPending + unreadPending;
  const invitations = countApplicationsByHhStatus(agent.db, 'invitation');
  const rejected = countApplicationsByHhStatus(agent.db, 'rejected');
  const pendingForms = countPendingChatForms(agent.db);
  const pendingChats = countPendingChats(agent.db);

  const sent = Boolean(await agent.send(
    '📊 <b>Итоги дня</b>\n\n' +
    '<b>За сегодня</b>\n' +
    `Найдено вакансий: <b>${found}</b>\n` +
    `Откликов: <b>${applied}</b> из ${agent.cfg.limits.dailyApplications}\n` +
    `Новых приглашений: <b>${invitationsToday}</b> · отказов: <b>${rejectedToday}</b>\n\n` +
    '<b>Всего в воронке</b>\n' +
    `Ждут ответа: <b>${pending}</b> (👀 просмотрено: <b>${viewedPending}</b> · ⏳ не просмотрено: <b>${unreadPending}</b>)\n` +
    `Приглашения: <b>${invitations}</b> · отказы: <b>${rejected}</b>\n` +
    (pendingForms > 0 ? `Анкеты ждут заполнения: <b>${pendingForms}</b>\n` : '') +
    (pendingChats > 0 ? `Чаты ждут ответа: <b>${pendingChats}</b>\n` : '') +
    `В очереди: ${agent.queue?.length ?? 0}`
  ));
  return {
    found,
    applied,
    invitationsToday,
    rejectedToday,
    pending,
    viewedPending,
    unreadPending,
    invitations,
    rejected,
    pendingForms,
    pendingChats,
    sent
  };
}

function formatStatusRow(row, baseUrl) {
  const title = row.title || `Вакансия ${row.vacancy_id}`;
  const company = row.company ? ` — ${esc(row.company)}` : '';
  const url = row.url || `${baseUrl}/vacancy/${row.vacancy_id}`;
  const rawTs = row.hh_status_at || row.applied_at || '';
  const d = rawTs ? new Date(rawTs) : null;
  const date = d && Number.isFinite(d.getTime())
    ? ` (${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')})`
    : '';
  return `• <a href="${esc(url)}">${esc(title)}</a>${company}${date}`;
}

export function buildStatusesText(db, syncResult = {}, cfg = {}) {
  const baseUrl = cfg?.hh?.base || 'https://hh.ru';
  const viewedCount = countApplicationsByHhStatus(db, 'viewed');
  const unreadCount = countApplicationsByHhStatus(db, 'sent') + countApplicationsByHhStatus(db, '');
  const viewedRows = listApplicationsByHhStatus(db, ['viewed'], 8);
  const unreadRows = listApplicationsByHhStatus(db, ['sent', ''], 8);

  const lines = [
    `Переговоры: ${syncResult.total ?? 0} откликов, изменений ${syncResult.changed ?? 0}, добавлено ${syncResult.adopted ?? 0}.`,
    '',
    `👀 <b>Просмотрены, без ответа (${viewedCount}):</b>`
  ];
  if (viewedRows.length) {
    lines.push(...viewedRows.map((r) => formatStatusRow(r, baseUrl)));
    if (viewedCount > viewedRows.length) lines.push(`<i>…и ещё ${viewedCount - viewedRows.length}</i>`);
  } else {
    lines.push('— нет');
  }

  lines.push('', `⏳ <b>Ещё не просмотрены (${unreadCount}):</b>`);
  if (unreadRows.length) {
    lines.push(...unreadRows.map((r) => formatStatusRow(r, baseUrl)));
    if (unreadCount > unreadRows.length) lines.push(`<i>…и ещё ${unreadCount - unreadRows.length}</i>`);
  } else {
    lines.push('— нет');
  }
  return lines.join('\n');
}

export function buildStatsText(agent) {
  const resumeLabel = { ai: 'AI-резюме', direct: 'Директолог', '—': 'вручную/импорт' };
  const byResume = funnelGroups(applicationFunnel(agent.db));
  const byQuery = funnelGroups(applicationFunnelByQuery(agent.db))
    .filter((g) => g.key !== '—' && g.total >= 3)
    .slice(0, 6);

  let llmSummary = null;
  try {
    llmSummary = getLlmUsageSummary(agent.db, localDayKey());
  } catch (err) {
    agent.log?.(`stats llm_usage: ${err?.message || err}`);
  }
  const fmtInt = (n) => Number(n || 0).toLocaleString('ru-RU');
  const llmLines = llmSummary?.total?.requests > 0
    ? [
        '<b>Расход LLM</b>',
        `Сегодня: ${llmSummary.today.requests} запр. · ${fmtInt(llmSummary.today.totalTokens)} ток. (${fmtInt(llmSummary.today.promptTokens)} in / ${fmtInt(llmSummary.today.completionTokens)} out)`,
        `Всего: ${llmSummary.total.requests} запр. · ${fmtInt(llmSummary.total.totalTokens)} ток. (${fmtInt(llmSummary.total.promptTokens)} in / ${fmtInt(llmSummary.total.completionTokens)} out)`
      ]
    : [];

  if (!byResume.length) {
    const emptyText = '📊 Откликов пока нет — статистика появится после первых отправок.';
    return llmLines.length ? `${emptyText}\n\n${llmLines.join('\n')}` : emptyText;
  }

  const totals = byResume.reduce(
    (acc, g) => ({
      total: acc.total + g.total,
      viewed: acc.viewed + g.viewed,
      invited: acc.invited + g.invited,
      rejected: acc.rejected + g.rejected
    }),
    { total: 0, viewed: 0, invited: 0, rejected: 0 }
  );
  const line = (label, g) =>
    `${label}: ${g.total} откл. · просмотр ${g.viewed} (${pct(g.viewed, g.total)}) · приглашение ${g.invited} (${pct(g.invited, g.total)}) · отказ ${g.rejected}`;

  const parts = [
    '📊 <b>Воронка откликов</b>',
    `Всего: <b>${totals.total}</b> · просмотр <b>${totals.viewed}</b> (${pct(totals.viewed, totals.total)}) · приглашение <b>${totals.invited}</b> (${pct(totals.invited, totals.total)}) · отказ ${totals.rejected}`,
    '',
    ...byResume.map((g) => line(esc(resumeLabel[g.key] ?? g.key), g))
  ];
  if (byQuery.length) {
    parts.push('', '<b>По поисковым запросам</b>');
    for (const g of byQuery) parts.push(line(esc(g.key), g));
  }
  if (llmLines.length) parts.push('', ...llmLines);
  if (totals.total < 10) parts.push('', '<i>Выборка маленькая — выводы делать рано.</i>');
  return parts.join('\n');
}

export async function sendPendingForms(agent) {
  const total = countPendingChatForms(agent.db);
  const forms = listPendingChatForms(agent.db, 15);
  if (!forms.length) {
    await agent.send('📝 Незаполненных анкет в базе сейчас нет.');
    return 0;
  }
  const head = total > forms.length
    ? `📝 <b>Незаполненные анкеты: ${total}</b> (показываю ${forms.length} свежих)`
    : `📝 <b>Незаполненные анкеты: ${total}</b>`;
  await agent.send(head);

  for (const f of forms) {
    const title = f.vacancy
      ? `<b>${esc(f.title)}</b> — ${esc(f.vacancy)}`
      : `<b>${esc(f.title)}</b>`;
    const date = String(f.notified_at || f.updated_at || '').slice(0, 10);
    const body = `📝 ${title}\n<code>${esc(f.url)}</code>${date ? `\n<i>Обнаружена: ${esc(date)}</i>` : ''}`;
    await agent.send(body, [
      [{ text: '📝 Открыть анкету', url: f.url }],
      [
        { text: '✅ Заполнена / закрыть', callback_data: `fmdone:${f.chat_id}` },
        { text: '✅ Заполнена + написать HR', callback_data: `fmsent:${f.chat_id}` }
      ],
      [{ text: '🔗 Открыть чат', url: `${agent.cfg.hh.base}/chat/${f.chat_id}` }]
    ]);
  }
  return forms.length;
}
