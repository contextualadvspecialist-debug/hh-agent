import {
  upsertVacancy, setScore, setVacancyStatus, listVacancies, getVacancy,
  setChatDraft, kvGet, kvSet, archiveStaleNewVacancies, recordApplication,
  markApplicationSkipped, skipCompanyVacancies
} from './db.js';
import { getVacancyDetails } from './hh-search.js';
import { ruleScore } from './score.js';
import { followupsSentToday, incrementFollowupsToday } from './followup.js';
import { esc, MAIN_KEYBOARD, isOwnerUpdate, chatIdOf } from './tg.js';
import { sendStatus, editStatusMessage, sendPendingForms } from './agent-analytics.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dropFromQueue(agent, predicate) {
  if (!Array.isArray(agent.queue) || !agent.queue.length) return 0;
  const next = agent.queue.filter((j) => !predicate(j));
  const removed = agent.queue.length - next.length;
  if (removed > 0) {
    agent.queue.splice(0, agent.queue.length, ...next);
    agent.saveQueue?.();
  }
  return removed;
}

function formatMaintenanceReport(r) {
  return `🧹 <b>Обслуживание выполнено:</b> бэкап ${esc(r.backup)}, удалено low ${r.purged}, `
    + `устаревших new в архив ${r.staleNew}, kv ${r.kvPurged}, вкладок закрыто ${r.pagesRecycled}.`;
}

export const telegramPollBackoffMs = (failures) =>
  Math.min(5000 * Math.pow(1.5, Math.min(Math.max(failures, 1) - 1, 6)), 60000);

// Единое завершение Telegram-карточек: дописывает статус и снимает устаревшие кнопки.
export async function finishCard(agent, message, note) {
  if (message?.message_id && agent.tg?.edit) {
    const raw = String(message.text ?? '').trim();
    const trimmed = raw.length > 3600 ? `${raw.slice(0, 3599).trimEnd()}…` : raw;
    const body = trimmed ? `${esc(trimmed)}\n\n${note}` : note;
    await agent.tg.edit(message.message_id, body, []);
    return;
  }
  await agent.send(note);
}

export async function handleTelegramUpdate(agent, update) {
  if (!agent.tg) return;
  // Бот приватный: команды, отклики и отправка сообщений работодателю — только из чата владельца.
  if (!isOwnerUpdate(update, agent.tg.chatId)) {
    agent.log?.(`telegram: отклонено обновление из чужого чата (${chatIdOf(update) || 'без chat_id'})`);
    return;
  }

  if (update.callback_query) {
    const q = update.callback_query;
    const data = q.data ?? '';
    await agent.tg.answerCallback(q.id);
    const [cmd, a, b] = data.split(':');
    const idOk = (s) => /^\d{3,}$/.test(s ?? '');
    const resumeOk = (s) => s === 'ai' || s === 'direct';

    try {
      if (cmd === 'ap' && idOk(a) && resumeOk(b)) {
        await agent.previewApply(a, b);
      } else if (cmd === 'apsend' && idOk(a) && resumeOk(b)) {
        const draft = agent.letterDraft(a);
        if (!draft) {
          await agent.send('Черновик устарел — нажмите «🎯 Отклик» ещё раз.');
        } else if (agent.enqueueApply(a, b, draft.letter)) {
          await finishCard(agent, q.message, `📨 <b>Отклик поставлен в очередь</b> (${b === 'ai' ? 'AI' : 'Директолог'})`);
        } else {
          await finishCard(agent, q.message, `♻️ <b>Отклик на ${esc(a)} уже есть</b> — повтор не ставил.`);
        }
      } else if (cmd === 'aprewrite' && idOk(a) && resumeOk(b)) {
        await agent.previewApply(a, b, { hint: 'Перепиши иначе: другой первый абзац, другая структура и формулировки, те же факты.' });
      } else if (cmd === 'afill' && idOk(a) && resumeOk(b)) {
        await agent.fillQuestions(a, b);
      } else if (cmd === 'arewrite' && idOk(a) && resumeOk(b)) {
        await agent.rewriteQuestions(a, b);
      } else if (cmd === 'asend' && idOk(a) && resumeOk(b)) {
        await agent.submitQuestions(a, b);
      } else if (cmd === 'sk' && idOk(a)) {
        setVacancyStatus(agent.db, a, 'skipped');
        markApplicationSkipped(agent.db, a);
        dropFromQueue(agent, (j) => String(j.vacancyId) === a);
        agent.rememberSkip?.(a);
        await finishCard(agent, q.message, `🗑 <b>Пропущено</b> (${esc(a)})`);
      } else if (cmd === 'apdone' && idOk(a)) {
        const key = resumeOk(b) ? b : 'direct';
        const v = getVacancy(agent.db, a);
        const resumeId = agent.cfg?.resumes?.[key]?.id ?? '';
        recordApplication(agent.db, { vacancyId: a, resumeKey: key, resumeId, letter: '', status: 'applied', error: '' });
        setVacancyStatus(agent.db, a, 'applied');
        dropFromQueue(agent, (j) => String(j.vacancyId) === a);
        const label = v?.title ? `<b>${esc(v.title)}</b>` : `вакансия ${esc(a)}`;
        await finishCard(agent, q.message, `✅ <b>Отклик отмечен как отправленный:</b> ${label}`);
      } else if (cmd === 'apsk' && idOk(a)) {
        setVacancyStatus(agent.db, a, 'skipped');
        markApplicationSkipped(agent.db, a);
        agent.rememberSkip?.(a);
        dropFromQueue(agent, (j) => String(j.vacancyId) === a);
        await finishCard(agent, q.message, `🗑 <b>Отклик пропущен</b> (${esc(a)})`);
      } else if (cmd === 'blk' && idOk(a)) {
        const v = getVacancy(agent.db, a);
        if (!v?.company) {
          await finishCard(agent, q.message, `⚠️ Не найдено название компании для ${esc(a)}.`);
        } else {
          const company = String(v.company).trim();
          agent.blockCompany(company);
          setVacancyStatus(agent.db, a, 'skipped');
          markApplicationSkipped(agent.db, a);
          agent.rememberSkip?.(a);
          const closed = skipCompanyVacancies(agent.db, company);
          const norm = company.toLowerCase();
          dropFromQueue(agent, (j) => {
            if (String(j.vacancyId) === a) return true;
            const jv = getVacancy(agent.db, String(j.vacancyId));
            return Boolean(jv?.company && jv.company.trim().toLowerCase() === norm);
          });
          const extra = closed > 0 ? ` Скрыто ещё вакансий: ${closed}.` : '';
          await finishCard(agent, q.message, `🚫 <b>Компания «${esc(company)}» в чёрном списке.</b>${extra}`);
        }
      } else if (cmd === 'mode' && (a === 'pause' || a === 'resume')) {
        const pausing = a === 'pause';
        agent.setPaused?.({ scan: pausing, apply: pausing });
        const note = pausing
          ? '⏸ <b>Пауза включена</b> (автоскан и отклики).'
          : '▶️ <b>Пауза снята</b> — автоскан и отклики возобновлены.';
        await editStatusMessage(agent, q.message, note);
      } else if (cmd === 'mode' && a === 'maint') {
        if (typeof agent.maintenance !== 'function') {
          await agent.send('⚠️ Обслуживание недоступно.');
        } else {
          const runMaint = () => agent.maintenance();
          const r = typeof agent.lock === 'function' ? await agent.lock('maintenance', runMaint) : await runMaint();
          await editStatusMessage(agent, q.message, formatMaintenanceReport(r));
        }
      } else if (cmd === 'qdrop' && idOk(a)) {
        const removed = dropFromQueue(agent, (j) => String(j.vacancyId) === a);
        if (removed > 0) {
          await editStatusMessage(agent, q.message, `🗑 <b>Убрано из очереди</b> (${esc(a)})`);
        } else {
          await editStatusMessage(agent, q.message, `ℹ️ Позиции ${esc(a)} уже нет в очереди.`);
        }
      } else if (cmd === 'qclear') {
        const n = Array.isArray(agent.queue) ? agent.queue.length : 0;
        if (n > 0) {
          agent.queue.length = 0;
          agent.saveQueue?.();
        }
        await editStatusMessage(agent, q.message, n ? `🧹 <b>Очередь очищена</b> (удалено ${n}).` : 'ℹ️ Очередь уже пуста.');
      } else if (cmd === 'let' && idOk(a)) {
        const { letter } = await agent.generateLetter(a, undefined);
        await agent.send(`<b>Письмо:</b>\n${esc(letter)}`);
      } else if (cmd === 'fit' && idOk(a)) {
        await agent.analyzeFit(a);
      } else if (cmd === 'cap' && idOk(a) && resumeOk(b)) {
        agent.enqueueApply(a, b);
        await finishCard(agent, q.message, '🔁 <b>Повтор отклика поставлен в очередь.</b>');
      } else if (cmd === 'fu' && idOk(a)) {
        const limit = agent.cfg.limits.dailyFollowups ?? 3;
        if (followupsSentToday(agent.db) >= limit) {
          await agent.send(`Дневной лимит follow-up (${limit}) исчерпан — отправлю завтра.`);
        } else {
          await agent.sendChatReply(a, { notify: false });
          incrementFollowupsToday(agent.db);
          kvSet(agent.db, `followupDone:${a}`, `sent:${new Date().toISOString()}`);
          await finishCard(agent, q.message, '📨 <b>Follow-up отправлен в чат hh.</b>');
        }
      } else if (cmd === 'fusk' && idOk(a)) {
        setChatDraft(agent.db, a, '');
        kvSet(agent.db, `followupDone:${a}`, `skipped:${new Date().toISOString()}`);
        await finishCard(agent, q.message, '🗑 <b>Follow-up пропущен.</b>');
      } else if (cmd === 'send' && idOk(a)) {
        await agent.sendChatReply(a, { notify: false });
        await finishCard(agent, q.message, '📨 <b>Ответ отправлен в чат hh.</b>');
      } else if (cmd === 'redraft' && idOk(a)) {
        await agent.redraft(a, { kind: b === 'fu' ? 'followup' : 'chat' });
      } else if (cmd === 'fmdone' && idOk(a)) {
        await agent.markFormDone(a, { replyInChat: false });
        await finishCard(agent, q.message, '✅ <b>Анкета отмечена как заполненная.</b>');
      } else if (cmd === 'fmsent' && idOk(a)) {
        const r = await agent.markFormDone(a, { replyInChat: true });
        await finishCard(agent, q.message, `✅ <b>Анкета отмечена как заполненная</b>, ответ отправлен в чат <b>${esc(r.chat?.title || a)}</b>.`);
      } else if (cmd === 'cdone' && idOk(a)) {
        await agent.markChatDone(a);
        await finishCard(agent, q.message, '✅ <b>Чат отмечен как обработанный.</b>');
      }
    } catch (e) {
      await agent.send(`⚠️ ${esc(e.message.slice(0, 300))}`);
    }
    return;
  }

  const text = (update.message?.text ?? '').trim();
  if (!text) return;

  // Реплай на карточку письма или чата — правка к черновику, а не команда.
  const parentId = update.message?.reply_to_message?.message_id;
  if (parentId && !text.startsWith('/')) {
    try {
      const ref = JSON.parse(kvGet(agent.db, `letterMsg:${parentId}`, 'null'));
      if (ref?.vacancyId) {
        await agent.previewApply(ref.vacancyId, ref.resumeKey, { hint: text.slice(0, 300) });
        return;
      }
    } catch { /* нет сохранённой ссылки на письмо */ }
    try {
      const chatRef = JSON.parse(kvGet(agent.db, `chatMsg:${parentId}`, 'null'));
      if (chatRef?.chatId) {
        await agent.redraft(chatRef.chatId, { hint: text.slice(0, 300), kind: chatRef.kind === 'followup' ? 'followup' : 'chat' });
        return;
      }
    } catch { /* нет сохранённой ссылки на чат */ }
  }

  if (text === '/start' || text === '/help') {
    await agent.send(
      'Я ищу вакансии на hh, пишу письма и откликаюсь.\n\n' +
      '/scan — проверить выдачу сейчас (AI)\n/direct — директ-пул по запросу (Яндекс Директ)\n' +
      '/more — показать отложенные подходящие вакансии\n' +
      '/chats — проверить чаты\n/forms — незаполненные внешние анкеты\n/statuses — статусы откликов (просмотрено/приглашение/отказ)\n' +
      '/digest — сводка за день и по воронке\n/status — очередь, ожидания и проверки\n/stats — конверсия и расход LLM\n' +
      '/pause [scan|apply] · /resume — пауза и возобновление фона\n/maintenance — бэкап и чистка базы/вкладок\n/restart — перезапустить агента\n' +
      '/block Компания — в чёрный список\n/blocked — список\n/unblock Компания — убрать\n' +
      'Или пришлите ссылку на вакансию — подготовлю карточку с откликом.',
      undefined,
      MAIN_KEYBOARD
    );
    return;
  }
  if (text === '/scan') {
    await agent.send('Сканирую hh…');
    const r = await agent.scan();
    const errors = r.errors?.length
      ? `\n${r.errors.slice(0, 3).map((e) => `⚠️ ${esc(e)}`).join('\n')}`
      : '';
    const rescored = r.rescored ? `, переоценка +${r.rescored}` : '';
    await agent.send(`Готово: новых ${r.found}, подходящих ${r.matched}${rescored}.${errors}`);
    return;
  }
  if (text === '/direct') {
    await agent.send('Сканирую директ-пул (упор на Яндекс Директ)…');
    const r = await agent.scan({ direct: true });
    const pool = (r.direct ?? []).slice(0, 10);
    if (!pool.length) {
      await agent.send('Новых подходящих директ-вакансий нет.');
      return;
    }
    for (const v of pool) {
      await agent.notifyVacancy(v);
      await sleep(300);
    }
    await agent.send(`Директ-пул: ${r.direct.length} подходящих.`);
    return;
  }
  if (text === '/chats') {
    const r = await agent.checkChats();
    await agent.send(`Чаты: непрочитанных ${r.chats}, ждут ответа ${r.pending}.`);
    return;
  }
  if (text === '/forms') {
    await sendPendingForms(agent);
    return;
  }
  if (text === '/more') {
    const staleArchived = archiveStaleNewVacancies(agent.db, new Date(Date.now() - 14 * 86400_000).toISOString());
    const rest = listVacancies(agent.db, 'new', 12, { order: 'recent' });
    if (!rest.length) {
      const hint = staleArchived ? ` (устаревших старше 14 дн. в архив: ${staleArchived})` : '';
      await agent.send(`Свежих новых вакансий в базе нет${hint}. /scan — проверить выдачу.`);
      return;
    }
    for (const v of rest) {
      await agent.notifyVacancy(v);
    }
    return;
  }
  if (text === '/status') {
    await sendStatus(agent);
    return;
  }
  if (text === '/statuses') {
    const r = await agent.checkStatuses();
    await agent.send(`Переговоры: ${r.total} откликов, изменений ${r.changed}, добавлено ${r.adopted}.`);
    return;
  }
  if (text === '/digest') {
    await agent.digest();
    return;
  }
  if (text === '/stats') {
    await agent.send(agent.statsText());
    return;
  }
  const pauseCmd = text.match(/^\/(pause|resume)(?:\s+(\S+))?$/i);
  if (pauseCmd) {
    const pausing = pauseCmd[1].toLowerCase() === 'pause';
    const target = (pauseCmd[2] ?? 'all').toLowerCase();
    if (!['all', 'scan', 'apply'].includes(target)) {
      await agent.send('Используйте: /pause [scan|apply|all] или /resume [scan|apply|all].');
      return;
    }
    const patch = target === 'all'
      ? { scan: pausing, apply: pausing }
      : target === 'scan'
        ? { scan: pausing }
        : { apply: pausing };
    const state = agent.setPaused(patch);
    const what = target === 'all' ? 'автоскан и отклики' : target === 'scan' ? 'автоскан' : 'отклики';
    const remaining = [state.scan && 'автоскан', state.apply && 'отклики'].filter(Boolean);
    await agent.send(
      pausing
        ? `⏸ <b>На паузе:</b> ${what}. Вернуть: /resume${target === 'all' ? '' : ` ${target}`}`
        : `▶️ <b>Возобновлено:</b> ${what}.${remaining.length ? ` На паузе остаётся: ${remaining.join(', ')}.` : ''}`
    );
    return;
  }
  if (text === '/maintenance') {
    const runMaint = () => agent.maintenance();
    const r = typeof agent.lock === 'function' ? await agent.lock('maintenance', runMaint) : await runMaint();
    await agent.send(formatMaintenanceReport(r));
    return;
  }
  if (text === '/restart') {
    if (!agent.shutdown) {
      await agent.send('Перезапуск доступен только у демона (npm run run).');
      return;
    }
    await agent.send('♻️ Перезапускаю агента…');
    setTimeout(() => agent.shutdown({ restart: true }).catch((e) => agent.log?.(`restart: ${e.message}`)), 800);
    return;
  }
  const block = text.match(/^\/block\s+(.+)$/i);
  if (block) {
    const list = agent.blockCompany(block[1]);
    await agent.send(`🚫 В чёрном списке: «${esc(block[1].trim())}». Всего компаний: ${list.length}.`);
    return;
  }
  const unblock = text.match(/^\/unblock\s+(.+)$/i);
  if (unblock) {
    const list = agent.unblockCompany(unblock[1]);
    await agent.send(`✅ Убрано из чёрного списка: «${esc(unblock[1].trim())}». Осталось: ${list.length}.`);
    return;
  }
  if (text === '/blocked') {
    const list = agent.cfg.hh.excludeCompanies ?? [];
    await agent.send(list.length ? `🚫 <b>Чёрный список:</b>\n${list.map((c) => `— ${esc(c)}`).join('\n')}` : 'Чёрный список пуст.');
    return;
  }

  const m = text.match(/vacancy\/(\d+)/) || text.match(/^(\d{6,})$/);
  if (m) {
    const id = m[1];
    const details = await agent.lock('search', async () => {
      const page = await agent.page('search');
      return getVacancyDetails(page, agent.cfg, id);
    });
    upsertVacancy(agent.db, details);
    const base = ruleScore(details, agent.cfg);
    setScore(agent.db, id, base);
    setVacancyStatus(agent.db, id, 'new');
    await agent.notifyVacancy({ ...details, ...base });
    return;
  }

  await agent.send('Не понял. Команды: /scan, /chats, /forms, /status, /stats — или ссылка на вакансию hh.');
}

export async function runBotLoop(agent) {
  if (!agent.tg) {
    agent.log?.('Telegram не настроен — работаю без бота (команды через CLI)');
    return;
  }
  let pollFailures = 0;
  while (!agent.stopped) {
    let updates = [];
    try {
      updates = await agent.tg.poll(agent.offset);
      if (pollFailures > 0) {
        agent.log?.(`telegram poll: связь восстановлена после ${pollFailures} сбоев`);
        pollFailures = 0;
      }
    } catch (e) {
      pollFailures++;
      const backoffMs = telegramPollBackoffMs(pollFailures);
      if (pollFailures === 1 || pollFailures % 10 === 0) {
        agent.log?.(`telegram poll: ${e.message} (сбой #${pollFailures}, пауза ${Math.round(backoffMs / 1000)}с)`);
      }
      await sleep(backoffMs);
      continue;
    }
    for (const u of updates) {
      agent.offset = u.update_id + 1;
      kvSet(agent.db, 'tgOffset', agent.offset);
      try {
        await agent.handleUpdate(u);
      } catch (e) {
        agent.log?.(`update: ${e.message}`);
      }
    }
  }
}
