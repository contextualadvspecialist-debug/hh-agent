import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildLetter, buildTemplateLetter, letterSimilarity, prepareLetter } from '../src/letter.js';

const profile = JSON.parse(fs.readFileSync(new URL('../profile.json', import.meta.url), 'utf8'));

test('письмо директолога соответствует шаблону, не дублирует кейс и укладывается в maxChars', () => {
  const text = buildTemplateLetter(profile, {
    title: 'Специалист по контекстной рекламе',
    company: 'Клиника «Тест»',
    salary: '100 000 ₽'
  }, 'direct');

  assert.match(text, /^Здравствуйте!/);
  assert.match(text, /Занимаюсь контекстной рекламой в Яндекс\.Директ более 2 лет\./);
  assert.match(text, /Для роли «Специалист по контекстной рекламе» в команде Клиника «Тест»/);
  assert.match(text, /Чем буду полезен команде:/);
  assert.match(text, /• Кругозор — /);
  assert.match(text, /• Настраивал и проверял/);
  assert.match(text, /Яндекс\.Директ/);
  assert.match(text, /\(Яндекс\.Метрика\)/);
  assert.ok(!/\(Яндекс\.Директ, Яндекс\.Метрика\)/.test(text), 'Яндекс.Директ не должен дублироваться в скобках');
  assert.match(text, /Telegram:\s*@dmt_north/);
  assert.match(text, /С уважением, Дмитрий$/);
  assert.ok(!/Откликаюсь на вакансию|Доброго времени суток|2 года 2 месяца/i.test(text));
  assert.ok(!/«Клиника «Тест»»/.test(text));
  assert.ok(!/• Кругозор —[\s\S]*в клинике «Кругозор»/i.test(text));
  assert.ok(!/^• [а-яё]/m.test(text), 'буллиты должны начинаться с заглавной буквы');
  assert.ok(text.length <= profile.letterRules.maxChars, `length=${text.length}`);
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
  assert.ok(!/фокус — [^.\n]*google ads/i.test(text));
});

test('если в кейсе задан url, он попадает в шаблон; без url ссылки не выдумываются', () => {
  const custom = structuredClone(profile);
  custom.roles.ai.cases[0].url = 'https://github.com/example/hh-agent';
  const text = buildTemplateLetter(custom, {
    id: '334', title: 'AI-инженер', company: 'Тест', snippet: 'LLM, агенты'
  }, 'ai');
  assert.match(text, /https:\/\/github\.com\/example\/hh-agent/);
});

test('обрезанное письмо от LLM перегенерируется, а не уходит как есть', async () => {
  const full = 'Здравствуйте!\n\nРаботаю в AI-автоматизации 2 года 2 месяца — закрываю задачи по LLM-агентам и автоматизации процессов.\n\nЧем буду полезен команде:\n— Собрал hh-agent: Telegram-бот оценивает вакансии через LLM, готовит письма и ведёт статусы.\n— Выпустил HR Manager PRO: CRM с канбаном, рассылками и синхронизацией с Google Sheets.\n\nФормат: удалённо, СПб. Быстрее всего отвечаю в Telegram: @dmt_north.\n\nС уважением, Дмитрий';
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
  assert.ok(text.length > 360);
  assert.match(text, /Чем буду полезен команде:/);
  assert.match(text, /С уважением, Дмитрий$/);
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
  assert.match(text, /С уважением, Дмитрий$/);
  assert.ok(text.length > 360);
});

test('LLM-письмо без приветствия получает «Здравствуйте!», а приветствие по имени сохраняется', async () => {
  const body = 'Работаю в AI-автоматизации 2 года 2 месяца — закрываю настройку LLM-сценариев и оценку качества ответов.\n\nЧем буду полезен команде:\n— Собрал hh-agent: AI-агент оценивает вакансии через LLM, готовит письма и ведёт статусы откликов.\n— Сделал HR Manager PRO: CRM с канбаном и синхронизацией с Google Sheets.\n\nФормат: удалённо, СПб, готов к тестовому.\nБуду рад обсудить задачи. Быстрее всего отвечаю в Telegram: @dmt_north.';
  const text1 = await buildLetter({
    llmChat: async () => `${body}\n\nС уважением, Дмитрий`,
    profile,
    vacancy: { id: '666', title: 'AI-инженер', company: 'Тест', snippet: 'LLM-агенты' },
    resumeKey: 'ai'
  });
  assert.match(text1, /^Здравствуйте!/);

  const text2 = await buildLetter({
    llmChat: async () => `Здравствуйте, Анна!\n\n${body}\n\nС уважением, Дмитрий`,
    profile,
    vacancy: { id: '667', title: 'AI-инженер', company: 'Тест', snippet: 'Контакт: Анна' },
    resumeKey: 'ai'
  });
  assert.match(text2, /^Здравствуйте, Анна!\n\nРаботаю в AI-автоматизации/);
});

test('служебная преамбула LLM в письмо не попадает', async () => {
  const letter = 'Здравствуйте!\n\nСобрал несколько рабочих систем на LLM и автоматизации процессов — закрываю полный цикл от промптов до интеграции в продакшене.\n\nЧем буду полезен команде:\n— hh-agent: собрал Telegram-бота и AI-агента, который оценивает вакансии через LLM, готовит письма и ведёт статусы.\n— HR Manager PRO: сделал CRM рекрутера с рассылками, канбаном, отчётами и синхронизацией с Google Sheets.\n\nФормат: удалённо, часовой пояс СПб. Быстрее всего отвечаю в Telegram: @dmt_north.\n\nС уважением, Дмитрий';
  const llmChat = async () => `Письмо готово. Одно уточнение: опирался на факты кандидата.\n\n---\n\n${letter}`;

  const text = await buildLetter({
    llmChat,
    profile,
    vacancy: { id: '777', title: 'AI-инженер', company: 'Тест', snippet: 'LLM-агенты, автоматизация' },
    resumeKey: 'ai'
  });

  assert.ok(!/Письмо готово/.test(text));
  assert.match(text, /^Здравствуйте!\n\nСобрал несколько рабочих систем/);
  assert.match(text, /Чем буду полезен команде:/);
});

test('повторный зачин из прошлых писем уходит на переписывание', async () => {
  const first = 'Здравствуйте!\n\nПишу по вакансии маркетолога в «Альфа». '.repeat(6) + '\n\nС уважением, Дмитрий';
  let calls = 0;
  const llmChat = async () => {
    calls++;
    if (calls === 1) return first;
    return 'Здравствуйте!\n\nРаботаю с рекламными кампаниями 2 года 2 месяца, основной фокус — запуск кампаний и сквозная отчётность.\n\nЧем буду полезен команде:\n— Вёл около 15 проектов в «Кругозоре»: семантика, бюджеты, цели и аналитика.\n— Собрал автоворонку уведомлений и учёта статусов.\n\nУдалённо, часовой пояс СПб. Telegram: @dmt_north.\n\nС уважением, Дмитрий';
  };

  const text = await buildLetter({
    llmChat,
    profile,
    vacancy: { id: '888', title: 'Маркетолог', company: 'Альфа', snippet: 'воронки, аналитика' },
    resumeKey: 'direct',
    previous: [first]
  });

  assert.ok(calls >= 2);
  assert.match(text, /^Здравствуйте!/);
  assert.ok(!/Пишу по вакансии/.test(text));
});

test('письмо из файла приводится в форму без дублирования подписи', () => {
  const raw = 'Работаю с отчётами и аналитикой 2 года. Настроил цели и сводки по 15 проектам, готов показать на созвоне. Работаю удалённо, часовой пояс Санкт-Петербурга.\n\nС уважением, Дмитрий';
  const text = prepareLetter(raw, profile);
  assert.match(text, /^Здравствуйте!/);
  assert.match(text, /С уважением, Дмитрий$/);
  assert.equal((text.match(/С уважением/g) ?? []).length, 1);

  const shortSigRaw = `${raw.replace('С уважением, Дмитрий', 'Дмитрий')}`;
  const textShort = prepareLetter(shortSigRaw, profile);
  assert.match(textShort, /Дмитрий$/);
  assert.ok(!/С уважением, Дмитрий$/.test(textShort));
});

test('письмо из файла со служебной преамбулой вычищается', () => {
  const raw = 'Письмо готово.\n\n---\n\nЗдравствуйте!\n\nРаботаю с метриками 2 года 2 месяца, основной фокус — контроль событий и отчётность по 15 проектам. Быстрее всего отвечаю в Telegram: @dmt_north.\n\nС уважением, Дмитрий';
  const text = prepareLetter(raw, profile);
  assert.ok(!/Письмо готово/.test(text));
  assert.match(text, /^Здравствуйте!/);
});

test('AI-шаблон опирается на кейсы и инструменты AI без упоминаний автооткликов', () => {
  const text = buildTemplateLetter(profile, {
    id: 'ai-901',
    title: 'AI-специалист',
    company: 'Стартап',
    snippet: 'нейросети, ChatGPT, промпты'
  }, 'ai');

  assert.match(text, /• HR Manager PRO — /);
  assert.ok(!/\([^)]*Google Sheets[^)]*\)/.test(text), 'Google Sheets уже в описании HR Manager PRO');
  assert.match(text, /удалённо/);
  assert.match(text, /@dmt_north/);
  assert.match(text, /С уважением, Дмитрий$/);
  assert.ok(!/Откликаюсь на вакансию|Доброго времени суток|отправляет отклики|автоотклик/i.test(text));
  assert.ok(text.length <= profile.letterRules.maxChars, `length=${text.length}`);
});

test('письмо со штампами и позицией просителя переписывается', async () => {
  const bad = 'Здравствуйте!\n\nРаботаю в digital и мечтаю стать частью вашей динамично развивающейся компании. Извините, что подхожу не по всем пунктам — пожалуйста, дайте шанс, я стрессоустойчивый и быстро учусь.\n\nЧем буду полезен команде:\n— Готов изучать всё с нуля в вашей дружной семье.\n\nTelegram: @dmt_north.\n\nС уважением, Дмитрий';
  const good = 'Здравствуйте!\n\nРаботаю в AI-автоматизации 2 года 2 месяца, основной фокус — связка LLM с рабочими процессами.\n\nЧем буду полезен команде:\n— Собрал hh-agent: агент оценивает вакансии через LLM, готовит письма и ведёт статусы.\n— В смежном опыте с Node.js и SQLite быстро переношу пайплайны на новый стек.\n\nУдалённо, СПб. Telegram: @dmt_north.\n\nС уважением, Дмитрий';
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
  assert.ok(!/стрессоустойчивый|извините|дайте шанс|быстро учусь/i.test(text));
});

test('уверенная формулировка со смежным опытом не бракуется фильтром', async () => {
  const confident = 'Здравствуйте!\n\nРаботаю в AI-автоматизации 2 года 2 месяца, основной фокус — настройка сценариев и автоматизация отчётности в Google Sheets.\n\nЧем буду полезен команде:\n— HR Manager PRO: сделал CRM с канбаном и синхронизацией с Google Sheets.\n— В рабочих проектах использовал Node.js и Playwright, с вебхуками n8n сталкивался точечно — принципы общие, смогу переключиться за первую неделю.\n\nУдалённо, СПб. Telegram: @dmt_north.\n\nС уважением, Дмитрий';
  let calls = 0;
  const text = await buildLetter({
    llmChat: async () => { calls++; return confident; },
    profile,
    vacancy: { id: '1005', title: 'AI-инженер', company: 'Тест', snippet: 'n8n, Google Sheets' },
    resumeKey: 'ai'
  });

  assert.equal(calls, 1);
  assert.match(text, /сталкивался точечно/);
});

test('правка кандидата попадает в промпт перегенерации', async () => {
  let seen = '';
  const llmChat = async (messages) => {
    seen = messages[messages.length - 1].content;
    return 'Здравствуйте!\n\nРаботаю в AI-автоматизации 2 года 2 месяца, основной фокус — интеграции с n8n и автоматизация рутины.\n\nЧем буду полезен команде:\n— Собрал hh-agent: Telegram-бот с LLM-скорингом и автооткликами.\n— Сделал HR Manager PRO: CRM с канбаном и синхронизацией с Google Sheets.\n\nУдалённо, СПб. Telegram: @dmt_north.\n\nС уважением, Дмитрий';
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

test('запрещённые зачины («Откликаюсь на», «Доброго времени суток») уходят на переписывание', async () => {
  const good = 'Здравствуйте!\n\nРаботаю в AI-автоматизации 2 года 2 месяца, основной фокус — встраивание LLM в поддержку и контроль качества ответов.\n\nЧем буду полезен команде:\n— Собрал hh-agent для оценки вакансий и генерации писем через LLM.\n— Ежедневно довожу промпты в ChatGPT, Claude и Gemini до стабильного результата.\n\nУдалённо, СПб. Telegram: @dmt_north.\n\nС уважением, Дмитрий';
  for (const banned of [
    `Здравствуйте!\n\nДоброго времени суток! Прошу рассмотреть моё резюме на открытую вакансию AI-инженера. ${'Это ровно моя задача, и я делал её каждый день. '.repeat(6)}\n\nС уважением, Дмитрий`,
    `Здравствуйте!\n\nОткликаюсь на вакансию «AI-инженер». ${'Собрал Telegram-бота и пайплайн скоринга вакансий на Node.js. '.repeat(6)}\n\nС уважением, Дмитрий`,
    `Здравствуйте! Откликаюсь на вакансию «AI-инженер». ${'Собрал Telegram-бота и пайплайн скоринга вакансий на Node.js. '.repeat(6)}\n\nС уважением, Дмитрий`
  ]) {
    let calls = 0;
    const text = await buildLetter({
      llmChat: async () => (++calls === 1 ? banned : good),
      profile,
      vacancy: { id: '1000', title: 'AI-инженер', company: 'Тест', snippet: 'LLM-агенты, автоматизация' },
      resumeKey: 'ai'
    });
    assert.equal(calls, 2);
    assert.ok(!/Доброго времени суток|Прошу рассмотреть|Откликаюсь на/i.test(text));
  }
});

test('письмо с подписью укладывается в maxChars и не рвёт подпись', async () => {
  const body = `Здравствуйте!\n\n${'Контроль метрик и отчётности по 15 проектам, этим занимаюсь ежедневно на практике. '.repeat(12)}\n\nС уважением, Дмитрий`;
  const text = await buildLetter({
    llmChat: async () => body,
    profile,
    vacancy: { id: '1001', title: 'Аналитик', company: 'Тест', snippet: 'аналитика, метрики' },
    resumeKey: 'ai'
  });

  assert.ok(text.length <= profile.letterRules.maxChars, `length=${text.length}`);
  assert.ok(text.endsWith('С уважением, Дмитрий'));
  assert.equal((text.match(/С уважением, Дмитрий/g) ?? []).length, 1);
});

test('markdown-заголовки вычищаются, а списки приводятся к буллитам «• »', async () => {
  const raw = `Здравствуйте!\n\n# Опыт\n**Главное**\n- собрал агентов для поддержки\n* настроил аналитику и отчётность\n• подготовил дашборд\n${'Контроль метрик и отчётности по 15 проектам, этим занимаюсь ежедневно на практике. '.repeat(5)}\n\nС уважением, Дмитрий`;
  const text = await buildLetter({
    llmChat: async () => raw,
    profile,
    vacancy: { id: '1002', title: 'Аналитик', company: 'Тест', snippet: 'аналитика' },
    resumeKey: 'ai'
  });

  assert.ok(!/\*\*/.test(text));
  assert.ok(!/^#{1,6}\s/m.test(text));
  assert.ok(!/^[-*]\s/m.test(text));
  assert.match(text, /^• собрал агентов для поддержки/m);
  assert.match(text, /^• настроил аналитику и отчётность/m);
  assert.match(text, /^• подготовил дашборд/m);
});

test('приветствие с именем и отчеством и запятые в одной строке не скрывают запрещённый зачин', async () => {
  const good = 'Здравствуйте!\n\nЗанимаюсь AI-автоматизацией более 2 лет — выстраиваю LLM-пайплайны и контроль качества ответов.\n\nЧем буду полезен команде:\n— HR Manager PRO — CRM рекрутера с канбаном и синхронизацией Google Sheets.\n— hh-agent — AI-пайплайн мониторинга и LLM-скоринга вакансий.\n\nУдалённо, СПб. Telegram: @dmt_north.\n\nС уважением, Дмитрий';
  for (const bad of [
    `Здравствуйте, Елена Сергеевна!\n\nОткликаюсь на вакансию «AI-инженер». ${'Собрал пайплайн оценки и аналитики на Node.js и LLM. '.repeat(6)}\n\nС уважением, Дмитрий`,
    `Здравствуйте, меня зовут Дмитрий. ${'Собрал несколько AI-пайплайнов и CRM для рекрутинга на Node.js и SQLite. '.repeat(6)}\n\nС уважением, Дмитрий`,
    `Здравствуйте, откликаюсь на вакансию «AI-инженер». ${'Собрал пайплайн оценки и аналитики на Node.js и LLM. '.repeat(6)}\n\nС уважением, Дмитрий`
  ]) {
    let calls = 0;
    const text = await buildLetter({
      llmChat: async () => (++calls === 1 ? bad : good),
      profile,
      vacancy: { id: '1006', title: 'AI-инженер', company: 'Тест', snippet: 'LLM-агенты' },
      resumeKey: 'ai'
    });
    assert.equal(calls, 2);
    assert.ok(!/Откликаюсь на|меня зовут/i.test(text));
  }
});

test('SABOTAGE_RE пропускает смежный опыт с точкой в названии и ловит обратный порядок отрицания', async () => {
  const withDotTool = 'Здравствуйте!\n\nЗанимаюсь контекстной рекламой более 2 лет, фокус — аналитика и оптимизация ставок.\n\nЧем буду полезен команде:\n— Вёл около 15 проектов с настройкой целей и передачей событий в аналитику.\n— С Яндекс.Директ пока не работал в e-commerce, но уже разобрал специфику и перенесу схему запуска.\n\nУдалённо, СПб. Telegram: @dmt_north.\n\nС уважением, Дмитрий';
  let okCalls = 0;
  const kept = await buildLetter({
    llmChat: async () => { okCalls++; return withDotTool; },
    profile,
    vacancy: { id: '1007', title: 'Директолог', company: 'Тест', snippet: 'Яндекс.Директ, аналитика' },
    resumeKey: 'direct'
  });
  assert.equal(okCalls, 1);
  assert.match(kept, /уже разобрал специфику/);

  const good = 'Здравствуйте!\n\nЗанимаюсь AI-автоматизацией более 2 лет, ключевой фокус — LLM-пайплайны и аналитика.\n\nЧем буду полезен команде:\n— HR Manager PRO — CRM рекрутера с канбаном и интеграцией Google Sheets.\n— hh-agent — AI-пайплайн мониторинга и скоринга вакансий.\n\nУдалённо, СПб. Telegram: @dmt_north.\n\nС уважением, Дмитрий';
  for (const bareGap of [
    `Здравствуйте!\n\nНет коммерческого опыта с Python. ${'Веду проекты с LLM и автоматизацией процессов, готов подключиться к задачам. '.repeat(5)}\n\nС уважением, Дмитрий`,
    `Здравствуйте!\n\nС Node.js пока не работал. ${'Веду проекты с LLM и автоматизацией процессов, готов подключиться к задачам. '.repeat(5)}\n\nС уважением, Дмитрий`
  ]) {
    let calls = 0;
    const fixed = await buildLetter({
      llmChat: async () => (++calls === 1 ? bareGap : good),
      profile,
      vacancy: { id: '1008', title: 'AI-инженер', company: 'Тест', snippet: 'Python, Node.js' },
      resumeKey: 'ai'
    });
    assert.equal(calls, 2);
    assert.ok(!/Нет коммерческого опыта|не работал/i.test(fixed));
  }
});

test('внешние кавычки вокруг всего письма снимаются, не удаляя первый абзац', async () => {
  const inner = 'Здравствуйте!\n\nЗанимаюсь AI-автоматизацией более 2 лет — выстраиваю LLM-сценарии в команде ООО «Тест».\n\nЧем буду полезен команде:\n— HR Manager PRO — CRM рекрутера с канбаном и синхронизацией Google Sheets.\n— hh-agent — AI-пайплайн мониторинга и LLM-скоринга вакансий.\n\nУдалённо, СПб. Telegram: @dmt_north.\n\nС уважением, Дмитрий';
  const text = await buildLetter({
    llmChat: async () => `"${inner}"`,
    profile,
    vacancy: { id: '1009', title: 'AI-инженер', company: 'ООО «Тест»', snippet: 'LLM' },
    resumeKey: 'ai'
  });

  assert.match(text, /^Здравствуйте!\n\nЗанимаюсь AI-автоматизацией/);
  assert.ok(!text.startsWith('"') && !text.endsWith('"'));
  assert.equal((text.match(/Здравствуйте!/g) ?? []).length, 1);
});

test('узкая вакансия и кавычки в company/title не дают пустой фокус или двойные кавычки', () => {
  const narrow = structuredClone(profile);
  narrow.roles.direct.skills = ['Яндекс.Директ'];
  delete narrow.roles.direct.defaultFocus;

  const text1 = buildTemplateLetter(narrow, {
    id: '1010',
    title: 'Специалист "Яндекс.Директ"',
    company: 'ООО «Ромашка»',
    snippet: 'Яндекс.Директ'
  }, 'direct');

  assert.match(text1, /Для роли Специалист "Яндекс\.Директ" в команде ООО «Ромашка» ключевой фокус — Яндекс\.Директ\./);
  assert.ok(!/««|»»|«ООО|""/.test(text1));

  const text2 = buildTemplateLetter(profile, {
    id: '1011',
    title: 'Промпт-инженер / AI-специалист',
    company: 'Клиника "Тест"',
    snippet: 'промпты, LLM-агенты, чат-боты'
  }, 'ai');
  assert.match(text2, /в команде Клиника "Тест" ключевой фокус — LLM-агенты и чат-боты\./);
  assert.ok(!/ключевой фокус — [^.\n]*промпт/i.test(text2));
});

test('добор focus до двух разных навыков без тавтологий и дедупликация stack с короткими тегами', async () => {
  const topped = buildTemplateLetter(profile, {
    id: '1012',
    title: 'Директолог',
    company: 'Маркетинг Про',
    snippet: 'Яндекс.Директ, аналитика'
  }, 'direct');
  assert.match(topped, /ключевой фокус — аналитика и семантика\./);
  assert.ok(!/метрика и аналитика/.test(topped), 'не должен дублировать «аналитика» через «метрика и аналитика»');
  assert.match(topped, /• Кругозор — .* \(Яндекс\.Метрика\)\./);

  const customCases = structuredClone(profile);
  customCases.roles.ai.cases = [
    { name: 'AutoStat', what: 'Android-приложение с OBD2 и аналитикой', stack: 'Android, OBD2' },
    { name: 'GoService', what: 'Сервис интеграций внутри Google Cloud', stack: 'Go, AI, Node.js' }
  ];
  const stackText = buildTemplateLetter(customCases, {
    id: '1013', title: 'AI-инженер', company: 'Альфа', snippet: 'LLM'
  }, 'ai');
  assert.match(stackText, /• AutoStat — Android-приложение с OBD2 и аналитикой\./);
  assert.ok(!/AutoStat[^\n]*\(\s*\)/.test(stackText));
  assert.ok(!/\(Android, OBD2\)/.test(stackText));
  assert.match(stackText, /• GoService — Сервис интеграций внутри Google Cloud \(Go, AI, Node\.js\)\./);

  const logs = [];
  let calls = 0;
  await buildLetter({
    llmChat: async () => {
      calls++;
      return calls === 1
        ? `Здравствуйте!\n\nНет коммерческого опыта с Python. ${'Веду проекты с LLM и автоматизацией процессов, готов подключиться к задачам. '.repeat(5)}\n\nС уважением, Дмитрий`
        : 'Здравствуйте!\n\nЗанимаюсь AI-автоматизацией более 2 лет, ключевой фокус — LLM-пайплайны, промпт-инжиниринг и аналитика.\n\nЧем буду полезен команде:\n• HR Manager PRO — CRM рекрутера с рассылками, канбаном, отчётами и синхронизацией Google Sheets.\n• hh-agent — AI-пайплайн для мониторинга рынка вакансий, оценки релевантности и статус-трекинга в Telegram.\n\nУдалённо, часовой пояс СПб, готов к тестовому. Telegram: @dmt_north.\n\nС уважением, Дмитрий';
    },
    profile,
    vacancy: { id: '1014', title: 'AI-инженер', company: 'Тест', snippet: 'Python' },
    resumeKey: 'ai',
    log: (m) => logs.push(m)
  });
  assert.ok(logs.some((l) => /ретрай #1 \(штамп\/оправдание: "Нет коммерческого опыта с"/i.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => /ok \(LLM, .*ретраев: 1\)/.test(l)), logs.join('\n'));
});
