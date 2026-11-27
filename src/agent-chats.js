import { CaptchaError } from './hh-search.js';
import { listUnreadChats, listAllChats, readChat, sendChatMessage, findChatIdForVacancy, cleanVacancyTitle, extractFormLinks } from './hh-chats.js';
import { listNegotiations } from './hh-status.js';
import { proposeFollowups } from './followup.js';
import { esc, chatReplyKeyboard, followupVacancyKeyboard } from './tg.js';
import {
  setVacancyStatus, getVacancy, upsertChat, setChatVacancy, setChatDraft,
  getChat, addMessage, kvGet, kvSet, setApplicationHhStatus, listApplications,
  adoptNegotiation, markApplicationDelivered, reconcileDeliveredApplications,
  recordChatForm, getChatForm, markChatHandled, getChatHandled
} from './db.js';
import { draftFormDoneReply, draftVacancyFollowup } from './agent-prompts.js';
import { localDayKey } from './agent-ops.js';

export function chatRetryState(db) {
  try {
    const value = JSON.parse(kvGet(db, 'chatReadRetries', '{}'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function rememberChatRetry(db, chat, error) {
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

export function clearChatRetry(db, chatId) {
  const retries = chatRetryState(db);
  if (!retries[chatId]) return;
  delete retries[chatId];
  kvSet(db, 'chatReadRetries', JSON.stringify(retries));
}

// Полный каталог чатов раз в день: в «только непрочитанные» попадают не все переписки.
export async function refreshChatDirectory(agent, page) {
  const key = `chatDir:${localDayKey()}`;
  if (kvGet(agent.db, key)) return null;
  const list = await listAllChats(page, agent.cfg);
  for (const c of list) {
    upsertChat(agent.db, { id: c.id, title: c.title, subtitle: c.subtitle, vacancy: '', last: c.last, time: c.time });
  }
  kvSet(agent.db, key, '1');
  agent.log?.(`чаты: каталог обновлён (${list.length})`);
  return list;
}

// Разовая починка: восстанавливаем заголовки и vacancy_id в чатах из шапки диалога.
export async function repairChatVacancies(agent) {
  const marker = 'chatVacancyRepair:v2';
  if (kvGet(agent.db, marker)) return 0;
  const junk = new Set(['перейти', 'открыть', 'подробнее', 'вакансия', 'ссылка', 'смотреть']);
  let seen = [];
  try {
    const parsed = JSON.parse(kvGet(agent.db, 'chatVacancyRepairSeen', '[]'));
    if (Array.isArray(parsed)) seen = parsed;
  } catch { /* игнорируем битый список */ }
  const attempted = new Set(seen);

  const broken = agent.db.prepare("SELECT id, vacancy, COALESCE(vacancy_id, '') AS vacancy_id FROM chats").all()
    .filter((c) => {
      if (attempted.has(c.id)) return false;
      const v = String(c.vacancy ?? '').trim().toLowerCase();
      return !v || junk.has(v) || !String(c.vacancy_id ?? '').trim();
    });
  if (!broken.length) {
    kvSet(agent.db, marker, 'ok:0');
    return 0;
  }

  const page = await agent.page('chats');
  const batch = broken.slice(0, 20);
  let fixed = 0;
  for (const c of batch) {
    attempted.add(c.id);
    try {
      const data = await readChat(page, agent.cfg, c.id);
      const vacancyId = data.vacancyId ?? '';
      const known = vacancyId ? getVacancy(agent.db, vacancyId) : null;
      const title = known?.title || cleanVacancyTitle(data.vacancy);
      // Пустая строка затирает мусор: шаблон тогда скажет «по моему отклику».
      setChatVacancy(agent.db, c.id, { vacancy: title, vacancyId });
      if (title || vacancyId) fixed++;
    } catch (e) {
      agent.log?.(`чат ${c.id}: привязка не восстановлена (${e.message})`);
    }
  }
  kvSet(agent.db, 'chatVacancyRepairSeen', JSON.stringify([...attempted].slice(-200)));
  if (broken.length <= batch.length) kvSet(agent.db, marker, `done:${fixed}`);
  agent.log?.(`чаты: привязка и названия восстановлены (${fixed}/${batch.length})`);
  return fixed;
}

export async function checkChatsOnce(agent) {
  const page = await agent.page('chats');
  let directory = null;
  try {
    directory = typeof agent.refreshChatDirectory === 'function'
      ? await agent.refreshChatDirectory(page)
      : await refreshChatDirectory(agent, page);
  } catch (e) {
    agent.log?.(`чаты: каталог не обновлён (${e.message})`);
  }
  let chats = [];
  try {
    chats = await listUnreadChats(page, agent.cfg);
  } catch (e) {
    if (e instanceof CaptchaError) {
      await page.bringToFront().catch((err) => agent.log?.(`bringToFront: ${err.message}`));
      await agent.send('🤖 Капча в чатах hh. Решите её в окне Chrome — следующий опрос пройдёт сам.');
      return { chats: 0, pending: 0, captcha: true, captchaReason: 'чаты hh' };
    }
    throw e;
  }

  const backfillEveryMinutes = agent.cfg.limits.chatsBackfillEveryMinutes ?? 120;
  const recentLimit = agent.cfg.limits.chatsRecentLimit ?? 20;
  const lastBackfill = Date.parse(kvGet(agent.db, 'lastChatBackfill', ''));
  const backfillDue = !Number.isFinite(lastBackfill)
    || Date.now() - lastBackfill >= backfillEveryMinutes * 60_000;
  let recent = [];
  if (backfillDue && backfillEveryMinutes > 0) {
    try {
      const all = directory ?? await listAllChats(page, agent.cfg);
      recent = all.slice(0, recentLimit);
      for (const c of recent) {
        upsertChat(agent.db, { id: c.id, title: c.title, subtitle: c.subtitle, vacancy: '', last: c.last, time: c.time });
      }
      kvSet(agent.db, 'lastChatBackfill', new Date().toISOString());
      if (recent.length) agent.log?.(`чаты: запланировано перечитывание последних ${recent.length}`);
    } catch (e) {
      agent.log?.(`чаты: периодическая проверка не удалась (${e.message})`);
    }
  }

  const retries = Object.values(chatRetryState(agent.db))
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
      data = await readChat(page, agent.cfg, c.id);
    } catch (e) {
      agent.log?.(`chat ${c.id}: ${e.message}`);
      rememberChatRetry(agent.db, c, e);
      continue;
    }
    clearChatRetry(agent.db, c.id);

    // Название вакансии надёжнее брать из своей базы по id из ссылки: в DOM
    // заголовок соседствует с кнопкой «Перейти».
    const knownVacancy = data.vacancyId ? getVacancy(agent.db, data.vacancyId) : null;
    upsertChat(agent.db, {
      id: c.id,
      title: data.employer || c.title,
      subtitle: c.subtitle,
      vacancy: knownVacancy?.title || cleanVacancyTitle(data.vacancy),
      vacancyId: data.vacancyId ?? '',
      last: c.last,
      time: c.time
    });

    for (const m of data.messages) {
      addMessage(agent.db, {
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
        const existing = getChatForm(agent.db, c.id, url);
        if (existing?.status === 'pending') {
          recordChatForm(agent.db, {
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
    const handled = getChatHandled(agent.db, c.id);
    if (handled?.extId && handled.extId === lastKey) continue;

    const chat = getChat(agent.db, c.id);
    if (chat?.state && chat.state !== 'new') {
      agent.db.prepare('UPDATE chats SET state = ?, updated_at = ? WHERE id = ?')
        .run('new', new Date().toISOString(), c.id);
    }

    const aiPending = pending.some((m) => m.isAi);
    const pendingForms = extractFormLinks(pending);
    for (const url of pendingForms) {
      recordChatForm(agent.db, { chatId: c.id, url, msgExtId: lastKey, status: 'pending' });
    }
    const unnotifiedForms = pendingForms.filter((url) => {
      if (kvGet(agent.db, `notifiedForm:${c.id}:${url}`)) return false;
      return getChatForm(agent.db, c.id, url)?.status !== 'submitted';
    });

    let deliveryFailed = false;
    if (aiPending) {
      if (kvGet(agent.db, `notifiedAiChat:${c.id}`) === lastKey) continue;
      pendingCount++;
      const quote = pending
        .slice(-3)
        .map((m) => `<i>${esc(m.isAi ? 'ИИ-помощник' : m.author || 'Работодатель')}:</i> ${esc(m.text.slice(0, 600))}`)
        .join('\n');
      const title = chat?.title || c.title || 'Чат hh';
      const sent = await agent.send(
        `<b>ИИ-помощник в чате</b>\n${esc(title)}${chat?.vacancy ? ` — ${esc(chat.vacancy)}` : ''}\n\n${quote}\n\nАвтоматически отвечать не буду — откройте чат и ответьте вручную.`,
        [[{ text: 'Открыть чат', url: `${agent.cfg.hh.base}/chat/${c.id}` }]]
      );
      if (sent) kvSet(agent.db, `notifiedAiChat:${c.id}`, lastKey);
      else {
        deliveryFailed = true;
        agent.log?.(`chat ${c.id}: уведомление об ИИ-помощнике не доставлено, повторю`);
      }
      if (deliveryFailed) rememberChatRetry(agent.db, c, new Error('telegram delivery failed'));
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
                { text: '🔗 Открыть чат', url: `${agent.cfg.hh.base}/chat/${c.id}` }
              ]
            ]
          : [
              [
                { text: 'Открыть анкету', url },
                { text: '✅ Анкета заполнена', callback_data: `fmdone:${c.id}` }
              ]
            ];
        const sent = await agent.send(body, keyboard);
        if (sent) {
          kvSet(agent.db, `notifiedForm:${c.id}:${url}`, '1');
          recordChatForm(agent.db, {
            chatId: c.id,
            url,
            msgExtId: lastKey,
            status: 'pending',
            notifiedAt: new Date().toISOString()
          });
        } else {
          deliveryFailed = true;
          agent.log?.(`форма ${c.id}: уведомление не доставлено, повторю`);
        }
      }
      if (deliveryFailed) rememberChatRetry(agent.db, c, new Error('telegram delivery failed'));
      else kvSet(agent.db, `notifiedChat:${c.id}`, lastKey);
      continue;
    }

    if (kvGet(agent.db, `notifiedChat:${c.id}`) === lastKey) continue;
    pendingCount++;

    let draft = '';
    if (agent.llm) {
      try {
        draft = await agent.draftReply(c.id);
        setChatDraft(agent.db, c.id, draft);
      } catch (e) {
        agent.log?.(`draft ${c.id}: ${e.message}`);
      }
    }
    const sent = await agent.notifyChat(c, chat, pending, draft);
    // Метку ставим только после доставки — иначе карточка теряется навсегда.
    if (sent) kvSet(agent.db, `notifiedChat:${c.id}`, lastKey);
    else {
      deliveryFailed = true;
      agent.log?.(`chat ${c.id}: карточка не доставлена, повторю`);
    }
    if (deliveryFailed) rememberChatRetry(agent.db, c, new Error('telegram delivery failed'));
  }

  kvSet(agent.db, 'lastChatsCheck', new Date().toISOString());
  agent.log?.(`chats: непрочитанных ${chats.length}, ждут ответа ${pendingCount}`);
  try {
    const proposed = await proposeFollowups(agent);
    if (proposed) agent.log?.(`follow-up предложений: ${proposed}`);
  } catch (e) {
    agent.log?.(`follow-ups: ${e.message}`);
  }
  return { chats: chats.length, pending: pendingCount };
}

export async function checkStatusesOnce(agent) {
  const page = await agent.page('status');
  let items = [];
  try {
    items = await listNegotiations(page, agent.cfg);
  } catch (e) {
    if (e instanceof CaptchaError) {
      await page.bringToFront().catch((err) => agent.log?.(`bringToFront: ${err.message}`));
      await agent.send('🤖 Капча в «Переговорах». Решите её в Chrome — проверю в следующий раз.');
      return { total: 0, changed: 0, adopted: 0, captcha: true, captchaReason: 'Переговоры hh' };
    }
    throw e;
  }

  const byId = new Map(listApplications(agent.db, 1000).map((a) => [a.vacancy_id, a]));
  let changed = 0;
  let adopted = 0;
  for (const item of items) {
    const app = byId.get(item.id);
    if (item.chatId && /^\d+$/.test(item.chatId)) {
      upsertChat(agent.db, {
        id: item.chatId,
        title: item.company || app?.company || '',
        vacancy: item.title || app?.title || '',
        vacancyId: item.id
      });
    }
    if (!app) {
      adoptNegotiation(agent.db, { ...item, url: `${agent.cfg.hh.base}/vacancy/${item.id}` });
      adopted++;
      continue;
    }
    // «Переговоры» — источник истины: отклик дошёл, даже если локально была капча или ручной сбой.
    if (['captcha', 'manual', 'error'].includes(app.status) && markApplicationDelivered(agent.db, item.id)) {
      setVacancyStatus(agent.db, item.id, 'applied');
      agent.log?.(`statuses: ${item.id} подтверждён на hh (${item.status}), локальный ${app.status} исправлен`);
    }
    if (app.hh_status === item.status) continue;
    setApplicationHhStatus(agent.db, item.id, item.status);
    changed++;
    const title = app.title || item.title || `Вакансия ${item.id}`;
    const company = app.company || item.company || '';
    const vacUrl = app.url || `${agent.cfg.hh.base}/vacancy/${item.id}`;
    const label = `<b>${esc(title)}</b>${company ? ` — ${esc(company)}` : ''}`;
    const vacLink = `\n<a href="${esc(vacUrl)}">Открыть вакансию</a>`;
    if (item.status === 'invitation') {
      await agent.send(`🎉 Приглашение: ${label}${vacLink}`);
    } else if (item.status === 'hired') {
      await agent.send(`🥳 Принят / оффер: ${label}${vacLink}`);
    } else if (item.status === 'rejected') {
      await agent.send(`❌ Отказ: ${label}`);
    } else if (item.status === 'viewed') {
      await agent.send(`👀 Просмотрен отклик: ${label}${vacLink}`);
    }
  }

  const reconciled = reconcileDeliveredApplications(agent.db);
  if (reconciled > 0) {
    agent.log?.(`statuses: исправлено старых зависших откликов: ${reconciled}`);
  }
  kvSet(agent.db, 'lastStatusCheck', new Date().toISOString());
  agent.log?.(`статусы: ${items.length} откликов, изменений ${changed}, новых ${adopted}`);
  return { total: items.length, changed, adopted };
}

export async function notifyChat(agent, c, chat, pending, draft) {
  const quote = pending
    .slice(-3)
    .map((m) => `<i>${esc(m.author || 'Работодатель')}:</i> ${esc(m.text.slice(0, 600))}`)
    .join('\n');
  const head = `💬 <b>${esc(chat?.title || c.title || 'Чат hh')}</b>${chat?.vacancy ? ` — ${esc(chat.vacancy)}` : ''}`;
  const body = draft
    ? `${head}\n\n${quote}\n\n<b>Черновик ответа:</b>\n${esc(draft)}\n\n<i>Ответьте на это сообщение правкой — перепишу черновик.</i>`
    : `${head}\n\n${quote}`;
  const keyboard = chatReplyKeyboard(agent.cfg, c.id, { hasDraft: Boolean(draft), retryLabel: '🔄 Переписать', kind: 'chat' });
  const msg = await agent.send(body, keyboard);
  if (msg?.message_id) {
    kvSet(agent.db, `chatMsg:${msg.message_id}`, JSON.stringify({ chatId: String(c.id), kind: 'chat', at: Date.now() }));
  }
  return msg;
}

export async function sendChatReply(agent, chatId, { notify = true } = {}) {
  const chat = await agent.lock('chats', async () => {
    const current = getChat(agent.db, chatId);
    if (!current?.draft) throw new Error('нет черновика');
    const page = await agent.page('chats');
    await sendChatMessage(page, agent.cfg, chatId, current.draft);
    addMessage(agent.db, {
      chatId,
      extId: `local-${Date.now()}`,
      direction: 'out',
      author: '',
      text: current.draft,
      ts: new Date().toISOString()
    });
    markChatHandled(agent.db, chatId, { state: 'handled' });
    return current;
  });
  if (notify) await agent.send(`📨 Отправлено в чат <b>${esc(chat.title || chatId)}</b>`);
  return chat;
}

export async function markFormDone(agent, chatId, { replyInChat = false } = {}) {
  const chat = getChat(agent.db, chatId);
  const replyText = replyInChat ? await draftFormDoneReply(agent, chatId, chat) : '';
  if (replyInChat) {
    await agent.lock('chats', async () => {
      const page = await agent.page('chats');
      await sendChatMessage(page, agent.cfg, chatId, replyText);
    });
    addMessage(agent.db, {
      chatId,
      extId: `local-${Date.now()}`,
      direction: 'out',
      author: '',
      text: replyText,
      ts: new Date().toISOString()
    });
  }
  const res = markChatHandled(agent.db, chatId, { state: 'form_submitted' });
  agent.log?.(`chat ${chatId}: анкета отмечена как заполненная${replyInChat ? ' (+ ответ отправлен HR)' : ''}`);
  return { chat, ...res };
}

export function markChatDone(agent, chatId) {
  const chat = getChat(agent.db, chatId);
  const res = markChatHandled(agent.db, chatId, { state: 'handled' });
  agent.log?.(`chat ${chatId}: чат отмечен как обработанный`);
  return { chat, ...res };
}

export async function redraft(agent, chatId, { hint = '', kind = 'chat' } = {}) {
  const draft = await agent.draftReply(chatId, hint);
  setChatDraft(agent.db, chatId, draft);
  const chat = getChat(agent.db, chatId);
  const mode = kind === 'followup' ? 'followup' : 'chat';
  const heading = mode === 'followup' ? '🔄 Новый follow-up для' : '🔄 Новый черновик для';
  const msg = await agent.send(
    `${heading} <b>${esc(chat?.title || chatId)}</b>${chat?.vacancy ? ` — ${esc(chat.vacancy)}` : ''}:\n\n${esc(draft)}\n\n<i>Ответьте на это сообщение правкой — перепишу черновик.</i>`,
    chatReplyKeyboard(agent.cfg, chatId, { hasDraft: true, retryLabel: '🔄 Ещё вариант', kind: mode })
  );
  if (msg?.message_id) {
    kvSet(agent.db, `chatMsg:${msg.message_id}`, JSON.stringify({ chatId: String(chatId), kind: mode, at: Date.now() }));
  }
  return msg;
}

export async function sendVacancyFollowup(agent, vacancyId, { notify = true } = {}) {
  const result = await agent.lock('chats', async () => {
    let parsed = null;
    try {
      parsed = JSON.parse(kvGet(agent.db, `followupVacDraft:${vacancyId}`, 'null'));
    } catch { /* битый черновик */ }
    const text = String(parsed?.text ?? '').trim();
    if (!text) throw new Error('нет черновика follow-up');

    const vac = getVacancy(agent.db, vacancyId);
    const existing = agent.db.prepare('SELECT id, title FROM chats WHERE vacancy_id = ? LIMIT 1').get(vacancyId);
    const page = await agent.page('chats');
    const chatId = existing?.id || await findChatIdForVacancy(page, agent.cfg, vacancyId);
    if (!chatId) {
      throw new Error('Чат по этому отклику на hh.ru пока не найден — откройте вакансию по ссылке и напишите вручную.');
    }

    const title = parsed?.employer || existing?.title || vac?.company || 'Работодатель';
    const vacancy = parsed?.vacancy || vac?.title || '';
    upsertChat(agent.db, { id: chatId, title, vacancy, vacancyId });
    setChatDraft(agent.db, chatId, text);
    await sendChatMessage(page, agent.cfg, chatId, text);
    addMessage(agent.db, {
      chatId,
      extId: `local-${Date.now()}`,
      direction: 'out',
      author: '',
      text,
      ts: new Date().toISOString()
    });
    markChatHandled(agent.db, chatId, { state: 'handled' });
    kvSet(agent.db, `followupDone:${chatId}`, `sent:${new Date().toISOString()}`);
    kvSet(agent.db, `followupVacDraft:${vacancyId}`, '');
    return { chatId, title };
  });
  if (notify) await agent.send(`📨 Отправлено в чат <b>${esc(result.title || vacancyId)}</b>`);
  return result;
}

export async function redraftVacancyFollowup(agent, vacancyId, { hint = '' } = {}) {
  const draft = await draftVacancyFollowup(agent, vacancyId, hint);
  const vac = getVacancy(agent.db, vacancyId);
  let prev = {};
  try {
    prev = JSON.parse(kvGet(agent.db, `followupVacDraft:${vacancyId}`, '{}')) || {};
  } catch { /* игнорируем */ }
  const employer = prev.employer || vac?.company || 'Работодатель';
  const vacancy = prev.vacancy || vac?.title || '';
  const vacancyUrl = prev.vacancyUrl || vac?.url || '';
  kvSet(agent.db, `followupVacDraft:${vacancyId}`, JSON.stringify({
    text: draft,
    employer,
    vacancy,
    vacancyUrl,
    updatedAt: new Date().toISOString()
  }));

  const msg = await agent.send(
    `🔄 Новый follow-up для <b>${esc(employer)}</b>${vacancy ? ` — ${esc(vacancy)}` : ''}:\n\n${esc(draft)}\n\n<i>Ответьте на это сообщение правкой — перепишу черновик.</i>`,
    followupVacancyKeyboard(agent.cfg, vacancyId, vacancyUrl)
  );
  if (msg?.message_id) {
    kvSet(agent.db, `chatMsg:${msg.message_id}`, JSON.stringify({ vacancyId: String(vacancyId), kind: 'followup-vac', at: Date.now() }));
  }
  return msg;
}
