export const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Обрезка HTML-строки не должна рвать тег или &entity: Telegram отвечает 400.
export function truncateHtml(text, max = 4000) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  if (cut.lastIndexOf('<') > cut.lastIndexOf('>')) cut = cut.slice(0, cut.lastIndexOf('<'));
  const amp = cut.lastIndexOf('&');
  if (amp > cut.lastIndexOf(';') && cut.length - amp <= 12) cut = cut.slice(0, amp);
  return `${cut.trimEnd()}…`;
}

export function chatIdOf(update) {
  return String(update?.callback_query?.message?.chat?.id ?? update?.message?.chat?.id ?? '');
}

// Бот приватный: любые update не из чата владельца — попытка управлять откликами со стороны.
export function isOwnerUpdate(update, chatId) {
  const id = chatIdOf(update);
  return Boolean(id) && id === String(chatId);
}

export class Telegram {
  constructor({ token, chatId }) {
    if (!token || !chatId) throw new Error('Telegram: не заданы token и chatId');
    this.token = token;
    this.chatId = String(chatId);
    this.api = `https://api.telegram.org/bot${token}`;
  }

  async call(method, payload = {}) {
    const res = await fetch(`${this.api}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(70000)
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
    return data.result;
  }

  send(text, keyboard, replyKeyboard) {
    return this.call('sendMessage', {
      chat_id: this.chatId,
      text: truncateHtml(text),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: replyKeyboard
        ? { keyboard: replyKeyboard, resize_keyboard: true, is_persistent: true }
        : keyboard ? { inline_keyboard: keyboard } : undefined
    });
  }

  edit(messageId, text, keyboard) {
    return this.call('editMessageText', {
      chat_id: this.chatId,
      message_id: messageId,
      text: truncateHtml(text),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined
    }).catch(() => {});
  }

  answerCallback(id, text = '') {
    return this.call('answerCallbackQuery', { callback_query_id: id, text }).catch(() => {});
  }

  poll(offset, timeout = 45) {
    return this.call('getUpdates', {
      offset,
      timeout,
      allowed_updates: ['message', 'callback_query']
    });
  }
}

// Текст кнопки совпадает с командой — нажатие отправляет её боту.
export const MAIN_KEYBOARD = [
  [{ text: '/scan' }, { text: '/direct' }],
  [{ text: '/chats' }, { text: '/statuses' }],
  [{ text: '/digest' }, { text: '/status' }],
  [{ text: '/blocked' }, { text: '/help' }]
];

export function vacancyKeyboard(v, cfg) {
  const rd = cfg.resumes.direct?.title ?? 'Директолог';
  const ra = cfg.resumes.ai?.title ?? 'AI';
  return [
    [
      { text: `🎯 Отклик · ${ra}`, callback_data: `ap:${v.id}:ai` },
      { text: `🎯 Отклик · ${rd}`, callback_data: `ap:${v.id}:direct` }
    ],
    [
      { text: '🔎 Разбор', callback_data: `fit:${v.id}` },
      { text: '✉️ Письмо', callback_data: `let:${v.id}` }
    ],
    [
      { text: '🔗 Вакансия', url: v.url || `https://hh.ru/vacancy/${v.id}` },
      { text: '🗑 Пропустить', callback_data: `sk:${v.id}` }
    ]
  ];
}

const EXPERIENCE = {
  noExperience: 'без опыта',
  between1And3: '1–3 года',
  between3And6: '3–6 лет',
  moreThan6: '6+ лет'
};

export function experienceLabel(code) {
  return EXPERIENCE[code] ?? '';
}

export function excerpt(text, max = 320) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '), cut.lastIndexOf(' '));
  return (end > max / 2 ? cut.slice(0, end) : cut).replace(/[\s.,;:—-]+$/, '') + '…';
}

export function vacancyText(v) {
  const resume = v.resume === 'ai' ? 'AI-специалист' : 'Директолог';
  const experience = experienceLabel(v.experience);
  const meta = [
    v.salary ? `💰 ${esc(v.salary)}` : '',
    experience ? `Опыт: ${esc(experience)}` : ''
  ].filter(Boolean).join(' · ');
  const description = excerpt(v.snippet);
  const lines = [
    `🎯 <b>${esc(v.title)}</b>`,
    v.company ? esc(v.company) : '',
    meta,
    `Оценка <b>${v.score}</b> · резюме ${esc(resume)}`,
    v.reason ? `<i>Совпало: ${esc(v.reason)}</i>` : '',
    v.fitNote ? `🔎 ${esc(v.fitNote)}` : '',
    description ? `\n<b>О вакансии</b>\n${esc(description)}` : ''
  ];
  return lines.filter(Boolean).join('\n');
}
