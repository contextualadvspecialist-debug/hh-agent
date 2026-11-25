import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = path.join(ROOT, 'config.json');

const DEFAULTS = {
  hh: {
    base: 'https://spb.hh.ru',
    area: '113',
    queriesAI: [
      'AI-специалист',
      'промпт-инженер',
      'специалист по нейросетям',
      'нейросети для бизнеса',
      'AI-ассистент',
      'AI-креатор',
      'автоматизация бизнес-процессов',
      'LLM',
      'разработка чат-ботов',
      'AI-маркетолог'
    ],
    queriesDirect: [
      'директолог',
      'специалист по Яндекс.Директ',
      'Яндекс Директ',
      'контекстная реклама Яндекс Директ'
    ],
    minSalary: 50000,
    remoteOnly: true,
    itemsOnPage: 50,
    pages: 1,
    excludeCompanies: [],
    excludeKeywordExceptions: ['водитель трафика'],
    excludeKeywords: [
      'холодные звонки',
      'продажи по телефону',
      'только офис',
      'без оплаты',
      'неоплачиваем',
      'курьер',
      'водитель',
      'бухгалтер',
      '1С'
    ]
  },
  resumes: {
    direct: {
      id: '5c32e6f1ff07dfc1e40039ed1f757444716958',
      title: 'Директолог'
    },
    ai: {
      id: '6a66fedbff115c09c00039ed1f6a3045786b62',
      title: 'AI'
    }
  },
  limits: {
    dailyApplications: 8,
    minDelaySec: 90,
    maxDelaySec: 240,
    scanEveryHours: 6,
    chatsEveryMinutes: 30,
    statusEveryHours: 3,
    digestHour: 20,
    followupWorkingDays: 3,
    dailyFollowups: 3,
    alertCooldownHours: 3,
    pageMaxAgeHours: 6,
    sendWindow: { from: 10, to: 19 }
  },
  threshold: 55,
  autoApply: false,
  telegram: {
    token: '',
    chatId: ''
  },
  llm: {
    baseUrl: '',
    apiKey: '',
    model: '',
    reasoningEffort: ''
  },
  browser: {
    channel: 'chrome',
    headless: false,
    profile: 'profile'
  }
};

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

export function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2), 'utf8');
  }
  let user;
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    throw new Error(`config.json не читается: ${e.message}`);
  }
  const cfg = merge(DEFAULTS, user);
  cfg.telegram.token = cfg.telegram.token || process.env.HH_TG_TOKEN || '';
  cfg.telegram.chatId = cfg.telegram.chatId || process.env.HH_TG_CHAT_ID || '';
  cfg.llm.baseUrl = cfg.llm.baseUrl || process.env.HH_LLM_BASE_URL || '';
  cfg.llm.apiKey = cfg.llm.apiKey || process.env.HH_LLM_API_KEY || '';
  cfg.llm.model = cfg.llm.model || process.env.HH_LLM_MODEL || '';
  cfg.llm.reasoningEffort = cfg.llm.reasoningEffort || process.env.HH_LLM_REASONING || '';
  cfg.paths = {
    root: ROOT,
    config: CONFIG_PATH,
    db: path.join(ROOT, 'data.db'),
    profile: path.join(ROOT, cfg.browser.profile),
    letters: path.join(ROOT, 'letters')
  };
  return cfg;
}

export function saveConfig(cfg) {
  const { paths, ...rest } = cfg;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(rest, null, 2), 'utf8');
}
