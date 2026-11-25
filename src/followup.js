import { kvGet, kvSet, setChatDraft } from './db.js';
import { withinWindow, businessDaysBetween } from './schedule.js';
import { cleanVacancyTitle } from './hh-chats.js';
import { esc, chatReplyKeyboard } from './tg.js';

const SKILL_HINTS = [
  { label: 'LLM и промпт-инжинирингом', re: /\bllm\b|промпт|нейросет|ai-?агент|gpt/i },
  { label: 'чат-ботами и автоматизацией', re: /чат-?бот|автоматизац|воронк/i },
  { label: 'Яндекс.Директом и аналитикой', re: /директ|контекст|рся|ppc|performance/i }
];

const vacancyPhrase = (title) => (title ? `по вакансии «${title}»` : 'по моему отклику');

const GENERAL_TEMPLATES = [
  ({ title, skill }) =>
    `Здравствуйте! Уточню ${vacancyPhrase(title)} — позиция ещё открыта?${skill ? ` Опыт с ${skill} есть,` : ''} готов обсудить задачи и формат работы.`,
  ({ title }) =>
    `Добрый день! Подскажите, пожалуйста, ${vacancyPhrase(title)} — поиск ещё открыт? Буду рад пообщаться, если мой профиль подходит под задачи.`,
  ({ title }) =>
    `Здравствуйте! Уточню ${vacancyPhrase(title)} — актуально ли ещё моё резюме? Если позиция открыта, готов ответить на вопросы или созвониться.`
];

const DIALOG_TEMPLATE = ({ title }) =>
  `Здравствуйте! Возвращаюсь к нашему диалогу${title ? ` по вакансии «${title}»` : ''} — подскажите, удалось ли посмотреть ответ и актуален ли ещё следующий этап?`;

export function workingDaysSince(iso, now = new Date()) {
  return businessDaysBetween(iso, now);
}

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function followupsSentToday(db, now = new Date()) {
  return Number(kvGet(db, `followupCount:${dayKey(now)}`, '0')) || 0;
}

export function incrementFollowupsToday(db, now = new Date()) {
  const k = `followupCount:${dayKey(now)}`;
  kvSet(db, k, String(followupsSentToday(db, now) + 1));
}

export function pickSkill(snippet = '') {
  return SKILL_HINTS.find((s) => s.re.test(snippet))?.label ?? '';
}

// Ротация по chatId: у hh.ru одинаковые сообщения подряд выглядят как спам.
export function buildFollowupText(item) {
  const title = cleanVacancyTitle(item.vacancy);
  if (item.hadEmployerDialog) return DIALOG_TEMPLATE({ title });
  const seed = [...String(item.chatId ?? '')].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const tpl = GENERAL_TEMPLATES[seed % GENERAL_TEMPLATES.length];
  return tpl({ title, skill: pickSkill(item.snippet) });
}

export function findFollowupCandidates(db, { minWorkingDays = 3, limit = 3, now = new Date() } = {}) {
  // Кандидаты: последнее сообщение исходящее (ждём ответа) либо отклик просмотрен и молчит.
  const rows = db.prepare(`
    SELECT
      c.id AS chatId,
      c.title AS employer,
      c.vacancy AS vacancy,
      c.updated_at AS chatUpdatedAt,
      m.direction AS lastDir,
      m.created_at AS lastMsgAt,
      (SELECT COUNT(*) FROM messages mi WHERE mi.chat_id = c.id AND mi.direction = 'in') AS inCount,
      COALESCE(NULLIF(c.resolved_vacancy_id, ''), a.vacancy_id) AS vacancyId,
      a.hh_status AS hhStatus,
      a.hh_status_at AS hhStatusAt,
      a.applied_at AS appliedAt,
      v.snippet AS snippet
    FROM (
      SELECT
        chats.*,
        COALESCE(
          NULLIF(chats.vacancy_id, ''),
          (
            SELECT v1.id
            FROM vacancies v1
            WHERE lower(trim(v1.title)) = lower(trim(chats.vacancy))
              AND lower(trim(v1.company)) = lower(trim(chats.title))
              AND COALESCE(chats.vacancy, '') <> ''
            ORDER BY v1.found_at DESC
            LIMIT 1
          ),
          (
            SELECT v2.id
            FROM vacancies v2
            WHERE lower(trim(v2.title)) = lower(trim(chats.vacancy))
              AND COALESCE(chats.vacancy, '') <> ''
            ORDER BY v2.found_at DESC
            LIMIT 1
          )
        ) AS resolved_vacancy_id
      FROM chats
    ) c
    LEFT JOIN messages m ON m.id = (
      SELECT id FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1
    )
    LEFT JOIN vacancies v ON v.id = c.resolved_vacancy_id
    LEFT JOIN applications a ON a.vacancy_id = c.resolved_vacancy_id
    WHERE COALESCE(a.hh_status, '') NOT IN ('rejected', 'invitation', 'hired')
      AND COALESCE(m.direction, 'out') = 'out'
      AND NOT EXISTS (
        SELECT 1 FROM chat_forms cf WHERE cf.chat_id = c.id AND cf.status = 'pending'
      )
    ORDER BY COALESCE(NULLIF(a.hh_status_at, ''), m.created_at, c.updated_at) ASC
  `).all();

  const picked = [];
  for (const r of rows) {
    if (picked.length >= limit) break;
    if (kvGet(db, `followupDone:${r.chatId}`)) continue;

    const anchorTs = r.lastMsgAt || r.hhStatusAt || r.appliedAt || r.chatUpdatedAt;
    if (workingDaysSince(anchorTs, now) < minWorkingDays) continue;

    const hadEmployerDialog = Number(r.inCount) > 0;
    const text = buildFollowupText({ ...r, hadEmployerDialog });
    picked.push({ ...r, hadEmployerDialog, text, anchorTs });
  }
  return picked;
}

export async function proposeFollowups(agent) {
  const dailyLimit = agent.cfg.limits?.dailyFollowups ?? 3;
  const minDays = agent.cfg.limits?.followupWorkingDays ?? 3;

  if (!withinWindow(new Date(), agent.cfg.limits?.sendWindow)) return 0;
  const remaining = dailyLimit - followupsSentToday(agent.db);
  if (remaining <= 0) return 0;

  const candidates = findFollowupCandidates(agent.db, { minWorkingDays: minDays, limit: remaining });
  for (const c of candidates) {
    setChatDraft(agent.db, c.chatId, c.text);
    // Метка предложения: без неё карточка повторялась бы каждые полчаса.
    kvSet(agent.db, `followupDone:${c.chatId}`, `proposed:${new Date().toISOString()}`);

    const badge = c.hhStatus === 'viewed' ? '👀 просмотрено' : '⏳ без ответа';
    const msg = await agent.send(
      `🔔 <b>Follow-up</b> (${badge}, ≥${minDays} раб. дн.)\n`
      + `<b>${esc(c.employer || 'Работодатель')}</b>${c.vacancy ? ` — ${esc(c.vacancy)}` : ''}\n\n`
      + `<b>Черновик:</b>\n${esc(c.text)}\n\n`
      + '<i>Ответьте на это сообщение правкой — перепишу текст.</i>',
      chatReplyKeyboard(agent.cfg, c.chatId, { hasDraft: true, retryLabel: '🔄 Переписать', kind: 'followup' })
    );
    if (msg?.message_id) {
      kvSet(agent.db, `chatMsg:${msg.message_id}`, JSON.stringify({ chatId: String(c.chatId), kind: 'followup', at: Date.now() }));
    }
  }
  return candidates.length;
}
