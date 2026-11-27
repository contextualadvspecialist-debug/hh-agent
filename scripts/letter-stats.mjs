import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PATTERNS = {
  // ISO-таймстамп или дата в начале строки (для фильтра --days).
  datePrefix: /^(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?)/,

  // Успех LLM: "letter 123: ok (LLM, 640 зн.)" и "letter 123: ok (LLM, 640 зн., ретраев: 1)".
  llmOk: /\bletter\s+\S+:\s*ok\s*\(LLM,[^)\n]*?(?:ретраев:\s*(\d+))?\)/i,

  // Падение в шаблон: "... , ушёл шаблон" (и совместимость с "fallback (...)").
  fallback: /\bletter\s+\S+:\s*(?:(.+?),\s*уш[её]л\s+шаблон|fallback\s*(?:[:(—-]\s*([^)\n]+))?)/i,

  // Строка ретрая из buildLetter: "letter 123: ретрай #1 (...)".
  retryLine: /\bletter\s+\S+:\s*(?:ретрай(?:\s+#\d+)?|retry)\b/i,

  // Срабатывание SABOTAGE_RE и захваченный фрагмент.
  sabotage: /(?:штамп\/оправдание|SABOTAGE_RE|sabotage|саботаж)\s*[:=(—-]\s*(?:["«'`]([^"»'`\n]+)["»'`]|\[([^\]\n]+)\]|([^,;\n)]+))/i,

  // Порядок важен: "повтор зачина" должен проверяться раньше "зачин:".
  retryReasons: [
    ['SABOTAGE_RE (штамп/оправдание)', /штамп|оправдан|SABOTAGE_RE|sabotage/i],
    ['повтор зачина / похоже на прошлое', /повтор зачина|похоже на прошлое|повтор\/зачин|repeat|дубл/i],
    ['BANNED_OPENING_RE (зачин)', /(?:^|[(:\s])зачин:|BANNED_OPENING|badOpening|opening/i],
    ['обрыв / коротко', /обрыв|коротк|incomplete|длин|truncat/i]
  ]
};

function parseArgs(argv) {
  let file = 'agent.log';
  let days = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days' && argv[i + 1]) {
      days = Number(argv[++i]);
    } else if (!argv[i].startsWith('-')) {
      file = argv[i];
    }
  }
  return { file, days };
}

const pct = (part, total) => (total ? `${((part / total) * 100).toFixed(1)}%` : '0.0%');
const inc = (map, key) => map.set(key, (map.get(key) || 0) + 1);

export function analyzeLetterLog(content, { days = null, now = Date.now() } = {}) {
  const cutoffMs = Number.isFinite(days) && days > 0 ? now - days * 86_400_000 : null;
  const lines = String(content ?? '').split(/\r?\n/);

  let llmOk = 0;
  let firstTry = 0;
  let llmWithRetries = 0;
  let totalOkRetries = 0;
  let fallbacks = 0;
  let retryEvents = 0;

  const sabotageHits = new Map();
  const retryReasons = new Map();
  const fallbackReasons = new Map();

  for (const line of lines) {
    if (!line.includes('letter ')) continue;

    if (cutoffMs !== null) {
      const dm = line.match(PATTERNS.datePrefix);
      const ts = dm ? Date.parse(dm[1]) : NaN;
      if (Number.isFinite(ts) && ts < cutoffMs) continue;
    }

    const okMatch = line.match(PATTERNS.llmOk);
    if (okMatch) {
      const retries = Number(okMatch[1] ?? 0);
      llmOk++;
      totalOkRetries += retries;
      if (retries === 0) firstTry++;
      else llmWithRetries++;
      continue;
    }

    const fbMatch = line.match(PATTERNS.fallback);
    if (fbMatch) {
      fallbacks++;
      const reason = (fbMatch[1] || fbMatch[2] || 'без уточнения').trim().slice(0, 80);
      inc(fallbackReasons, reason);
      continue;
    }

    const sabMatch = line.match(PATTERNS.sabotage);
    if (sabMatch) {
      const snippet = (sabMatch[1] || sabMatch[2] || sabMatch[3] || '').trim().toLowerCase();
      if (snippet) inc(sabotageHits, snippet);
    }

    if (PATTERNS.retryLine.test(line) || sabMatch) {
      retryEvents++;
      const found = PATTERNS.retryReasons.find(([, re]) => re.test(line));
      inc(retryReasons, found ? found[0] : 'прочее');
    }
  }

  return {
    llmOk,
    firstTry,
    llmWithRetries,
    totalOkRetries,
    fallbacks,
    totalLetters: llmOk + fallbacks,
    hadRetry: llmWithRetries + fallbacks,
    retryEvents,
    sabotageHits,
    retryReasons,
    fallbackReasons
  };
}

function main() {
  const { file, days } = parseArgs(process.argv.slice(2));
  const fullPath = path.resolve(file);

  if (!fs.existsSync(fullPath)) {
    console.error(`Файл не найден: ${fullPath}`);
    process.exit(1);
  }

  const stats = analyzeLetterLog(fs.readFileSync(fullPath, 'utf8'), { days });
  const {
    llmOk, firstTry, llmWithRetries, totalOkRetries,
    fallbacks, totalLetters, hadRetry, retryEvents,
    sabotageHits, retryReasons, fallbackReasons
  } = stats;

  console.log(`\n=== Статистика генерации писем (${path.basename(fullPath)}${days ? `, последние ${days} дн.` : ''}) ===`);
  console.log(`Всего писем:                  ${totalLetters}`);
  console.log(`LLM с 1-й попытки:            ${firstTry} (${pct(firstTry, totalLetters)} от всех / ${pct(firstTry, llmOk)} от LLM)`);
  console.log(`LLM после ретрая:             ${llmWithRetries} (${pct(llmWithRetries, totalLetters)})`);
  console.log(`Падения в шаблон (fallback):  ${fallbacks} (${pct(fallbacks, totalLetters)})`);
  console.log(`Доля писем с ретраями:        ${pct(hadRetry, totalLetters)} (всего событий ретрая в логе: ${retryEvents})`);
  console.log(`Среднее число ретраев на LLM: ${llmOk ? (totalOkRetries / llmOk).toFixed(2) : '0.00'}`);

  const printTop = (title, map, limit = 10) => {
    if (!map.size) return;
    console.log(`\n${title}:`);
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .forEach(([key, count], idx) => {
        console.log(`  ${String(idx + 1).padStart(2)}. [${count}] ${key}`);
      });
  };

  printTop('Причины ретраев', retryReasons);
  printTop('Топ сработавших триггеров SABOTAGE_RE', sabotageHits);
  printTop('Причины падения в шаблон', fallbackReasons);
  console.log('');
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main();
}
