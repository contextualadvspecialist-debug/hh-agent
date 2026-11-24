import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildLetter, buildTemplateLetter, letterSimilarity, prepareLetter } from '../src/letter.js';

const profile = JSON.parse(fs.readFileSync(new URL('../profile.json', import.meta.url), 'utf8'));

test('письмо директолога содержит вакансию, компанию и подпись', () => {
  const text = buildTemplateLetter(profile, {
    title: 'Специалист по контекстной рекламе',
    company: 'Клиника «Тест»',
    salary: '100 000 ₽'
  }, 'direct');

  assert.match(text, /Специалист по контекстной рекламе/);
  assert.match(text, /Клиника «Тест»/);
  assert.match(text, /Яндекс\.Директ/);
  assert.match(text, /Дмитрий$/);
  assert.ok(text.length <= profile.letterRules.maxChars);
  assert.ok(!text.includes('undefined'));
});

test('письма под разные вакансии заметно различаются', () => {
  const a = buildTemplateLetter(profile, {
    id: '111', title: 'AI-специалист', company: 'Альфа', snippet: 'нейросети, LLM, промпты'
  }, 'ai');
  const b = buildTemplateLetter(profile, {
    id: '222', title: 'Промпт-инженер', company: 'Бета', snippet: 'чат-боты, автоматизация процессов'
  }, 'ai', { variant: 2 });
  assert.ok(letterSimilarity(a, b) < 0.8, `similarity=${letterSimilarity(a, b).toFixed(2)}`);
});

test('Google Ads не подставляется как ключевой навык вакансии', () => {
  const text = buildTemplateLetter(profile, {
    id: '333', title: 'Специалист по рекламе', company: 'Агентство',
    snippet: 'Google Ads, AdWords, ведение кампаний'
  }, 'direct');
  assert.ok(!/В вакансии важны[^.]*google ads/i.test(text));
});

test('обрезанное письмо от LLM перегенерируется, а не уходит как есть', async () => {
  const full = 'Здравствуйте!\n\nСобрал hh-agent — AI-агента для поиска работы. Ближе всего к вакансии AI-инженера в компании «Тест»: там нужны LLM-агенты и автоматизация рутины.\n\nПочему подойду:\n— hh-agent: собрал Telegram-бота, который оценивает вакансии через LLM, готовит письма и ведёт статусы.\n— HR Manager PRO: сделал CRM с рассылками, канбаном и отчётами.\n\nГотов работать удалённо, часовой пояс Санкт-Петербурга, начать могу в ближайшее время.\n\nДмитрий';
  let calls = 0;
  const llmChat = async () => {
    calls++;
    return calls === 1 ? 'Главное в описании — настройка критериев оценки и промпта' : full;
  };

  const text = await buildLetter({
    llmChat,
    profile,
    vacancy: { id: '444', title: 'AI-инженер', company: 'Тест', snippet: 'LLM-агенты, автоматизация' },
    resumeKey: 'ai'
  });

  assert.equal(calls, 2);
  assert.ok(text.length > 400);
  assert.match(text, /AI-инженера/);
  assert.match(text, /Дмитрий$/);
});

test('если LLM дважды оборвал письмо, уходит целый шаблон', async () => {
  let calls = 0;
  const llmChat = async () => {
    calls++;
    return 'Главное в описании — настройка критериев оценки и промпта';
  };

  const text = await buildLetter({
    llmChat,
    profile,
    vacancy: { id: '555', title: 'AI-инженер', company: 'Тест', snippet: 'LLM-агенты, автоматизация' },
    resumeKey: 'ai'
  });

  assert.equal(calls, 2);
  assert.match(text, /^Здравствуйте!/);
  assert.match(text, /Дмитрий$/);
  assert.ok(text.length > 400);
});

test('LLM-письмо без приветствия получает «Здравствуйте!»', async () => {
  const body = 'У вас в описании важна связка LLM с рабочими процессами, и это ровно то, чем занимаюсь каждый день: собираю сценарии, оцениваю качество ответов и довожу промпт до стабильного результата. Работаю удалённо, часовой пояс Санкт-Петербурга, начать могу в ближайшее время.';
  const llmChat = async () => `${body}\n\nДмитрий`;

  const text = await buildLetter({
    llmChat,
    profile,
    vacancy: { id: '666', title: 'AI-инженер', company: 'Тест', snippet: 'LLM-агенты, автоматизация' },
    resumeKey: 'ai'
  });

  assert.match(text, /^Здравствуйте!/);
  assert.match(text, /Дмитрий$/);
});

test('служебная преамбула LLM в письмо не попадает', async () => {
  const letter = 'Здравствуйте!\n\nСобрал hh-agent — AI-агента для поиска работы. Ближе всего к вакансии AI-инженера в компании «Тест»: нужны LLM-агенты и автоматизация рутины.\n\nПочему подойду:\n— hh-agent: собрал Telegram-бота, который оценивает вакансии через LLM, готовит письма и ведёт статусы.\n— HR Manager PRO: сделал CRM с рассылками, канбаном и отчётами.\n\nГотов работать удалённо в часовом поясе Санкт-Петербурга, начать могу в ближайшее время.\n\nДмитрий';
  const llmChat = async () => `Письмо готово. Одно уточнение: в описании не хватало деталей, поэтому опирался на факты кандидата.\n\n---\n\n${letter}`;

  const text = await buildLetter({
    llmChat,
    profile,
    vacancy: { id: '777', title: 'AI-инженер', company: 'Тест', snippet: 'LLM-агенты, автоматизация' },
    resumeKey: 'ai'
  });

  assert.ok(!/Письмо готово/.test(text));
  assert.match(text, /^Здравствуйте!\n\nСобрал hh-agent/);
  assert.match(text, /Почему подойду:/);
});

test('повторный зачин из прошлых писем уходит на переписывание', async () => {
  const first = 'Откликаюсь на вакансию маркетолога в «Альфа». '.repeat(8) + '\n\nДмитрий';
  let calls = 0;
  const llmChat = async (messages) => {
    calls++;
    if (calls === 1) return `${first}`;
    if (calls === 2) {
      return `Здравствуйте!\n\nВ вашем описании ключевая задача — собрать воронку с нуля и сопроводить её после запуска. Это как раз то, что я делаю: собираю сценарии, оцениваю качество ответов модели и довожу промпт до стабильного результата. Работаю удалённо в часовом поясе Санкт-Петербурга, готов начать в ближайшее время.\n\nДмитрий`;
    }
    return 'Коротко';
  };

  const text = await buildLetter({
    llmChat,
    profile,
    vacancy: { id: '888', title: 'Маркетолог', company: 'Альфа', snippet: 'воронки, чат-боты' },
    resumeKey: 'ai',
    previous: [first]
  });

  assert.ok(calls >= 2);
  assert.match(text, /^Здравствуйте!/);
  assert.ok(!/^Откликаюсь на вакансию/.test(text));
});

test('письмо из файла приводится в форму: приветствие и подпись', () => {
  const raw = 'Пишу по вакансии аналитика. В описании важны отчёты и контроль метрик, этим занимаюсь каждый день. Работаю удалённо, часовой пояс Санкт-Петербурга, готов начать в ближайшее время.';
  const text = prepareLetter(raw, profile);
  assert.match(text, /^Здравствуйте!/);
  assert.match(text, /Дмитрий$/);
  assert.ok(text.includes('Пишу по вакансии аналитика'));
});

test('письмо из файла со служебной преамбулой вычищается', () => {
  const raw = 'Письмо готово.\n\n---\n\nЗдравствуйте!\n\nВ описании ключевая задача — контроль метрик и отчётность. Этим занимаюсь каждый день: собираю данные, проверяю цели и передачу событий, готовлю сводки для руководителя. Работаю удалённо в часовом поясе Санкт-Петербурга, готов начать в ближайшее время.\n\nДмитрий';
  const text = prepareLetter(raw, profile);
  assert.ok(!/Письмо готово/.test(text));
  assert.match(text, /^Здравствуйте!/);
});

test('AI-письмо опирается на нейросети', () => {
  const text = buildTemplateLetter(profile, {
    title: 'AI-специалист',
    company: 'Стартап'
  }, 'ai');

  assert.match(text, /ChatGPT/);
  assert.match(text, /удалённо/);
  assert.match(text, /Дмитрий$/);
});

test('письмо с фразами о недостающем опыте переписывается', async () => {
  const bad = `Здравствуйте!\n\nВ вакансии важны вебхуки и REST API. Скажу честно: опыта с REST API у меня пока нет, зато я быстро учусь. ${'Работаю с LLM и автоматизацией каждый день. '.repeat(10)}\n\nДмитрий`;
  const good = 'Здравствуйте!\n\nВ вакансии важна связка LLM с рабочими процессами — этим и занимаюсь: собираю сценарии, проверяю качество ответов модели и довожу промпт до стабильного результата. Работаю удалённо в часовом поясе Санкт-Петербурга, готов начать в ближайшее время.\n\nДмитрий';
  let calls = 0;
  const llmChat = async () => {
    calls++;
    return calls === 1 ? bad : good;
  };

  const text = await buildLetter({
    llmChat,
    profile,
    vacancy: { id: '1003', title: 'AI-инженер', company: 'Тест', snippet: 'вебхуки, REST API' },
    resumeKey: 'ai'
  });

  assert.equal(calls, 2);
  assert.ok(!/опыта с REST API у меня пока нет/i.test(text));
});

test('правка кандидата попадает в промпт перегенерации', async () => {
  let seen = '';
  const llmChat = async (messages) => {
    seen = messages[messages.length - 1].content;
    return 'Здравствуйте!\n\nВ описании важна интеграция с n8n и автоматизация рутины — как раз этим занимаюсь: собираю сценарии, связываю сервисы между собой и проверяю результат на устойчивость. Отдельно умею оценивать качество ответов моделей и доводить промпт до предсказуемого вида. Работаю удалённо в часовом поясе Санкт-Петербурга, готов начать в ближайшее время.\n\nДмитрий';
  };
  await buildLetter({
    llmChat,
    profile,
    vacancy: { id: '1004', title: 'AI-инженер', company: 'Тест', snippet: 'n8n, автоматизация' },
    resumeKey: 'ai',
    hint: 'сделай упор на n8n'
  });
  assert.match(seen, /сделай упор на n8n/);
});

test('шаблон не начинается с заезженного зачина', () => {
  const text = buildTemplateLetter(profile, { id: '999', title: 'AI-специалист', company: 'Бета' }, 'ai');
  assert.ok(!/Откликаюсь на вакансию|Пишу по вакансии|Заинтересовала вакансия/i.test(text));
});

test('письмо с запрещённым зачином уходит на переписывание', async () => {
  const banned = `Здравствуйте!\n\nОткликаюсь на вакансию AI-инженера. ${'Это ровно моя задача, и я делал её каждый день. '.repeat(10)}\n\nДмитрий`;
  const good = 'Здравствуйте!\n\nВ вакансии AI-инженера ключевая задача — встроить LLM в поддержку и держать качество ответов под контролем. С этим работаю ежедневно: собираю сценарии, проверяю результат модели и правлю промпт до стабильного вида. Работаю удалённо в часовом поясе Санкт-Петербурга, готов начать в ближайшее время.\n\nДмитрий';
  let calls = 0;
  const llmChat = async () => {
    calls++;
    return calls === 1 ? banned : good;
  };

  const text = await buildLetter({
    llmChat,
    profile,
    vacancy: { id: '1000', title: 'AI-инженер', company: 'Тест', snippet: 'LLM-агенты, автоматизация' },
    resumeKey: 'ai'
  });

  assert.equal(calls, 2);
  assert.ok(!/^Откликаюсь на вакансию/m.test(text));
});

test('письмо с подписью укладывается в maxChars', async () => {
  const body = `Здравствуйте!\n\n${'В описании важна встроенная аналитика и контроль метрик, этим занимаюсь ежедневно. '.repeat(20)}\n\nДмитрий`;
  const text = await buildLetter({
    llmChat: async () => body,
    profile,
    vacancy: { id: '1001', title: 'Аналитик', company: 'Тест', snippet: 'аналитика, метрики' },
    resumeKey: 'ai'
  });

  assert.ok(text.length <= profile.letterRules.maxChars);
  assert.ok(text.endsWith('Дмитрий'));
});

test('markdown-заголовки и списки вычищаются из письма', async () => {
  const raw = `Здравствуйте!\n\n# Опыт\n**Главное**\n- собрал агентов для поддержки\n- настроил аналитику и отчётность\n${'В описании важна встроенная аналитика и контроль метрик, этим занимаюсь ежедневно. '.repeat(8)}\n\nДмитрий`;
  const text = await buildLetter({
    llmChat: async () => raw,
    profile,
    vacancy: { id: '1002', title: 'Аналитик', company: 'Тест', snippet: 'аналитика' },
    resumeKey: 'ai'
  });

  assert.ok(!/\*\*/.test(text));
  assert.ok(!/^#{1,6}\s/m.test(text));
  assert.ok(!/^[-*•]\s/m.test(text));
});
