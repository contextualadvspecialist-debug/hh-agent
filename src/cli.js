#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from './config.js';
import { Agent } from './agent.js';
import { waitForLogin, closeContext, checkLoggedIn } from './browser.js';
import { makeLlmClient, llmReady } from './llm.js';
import { getVacancyDetails } from './hh-search.js';
import { ruleScore } from './score.js';
import { getVacancy, upsertVacancy, setScore, setVacancyStatus } from './db.js';

const [cmd = 'help', ...args] = process.argv.slice(2);
const cfg = loadConfig();

function flag(name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
}
const first = args.find((a) => !a.startsWith('--'));

function idFrom(value = '') {
  const m = String(value).match(/vacancy\/(\d+)/) || String(value).match(/^(\d{6,})$/);
  return m?.[1] ?? '';
}

// Второй экземпляр демона ломает профиль Chrome и очередь. Смотрим и pid-файл,
// и живые процессы: файл остаётся после падения, процесс можно запустить в обход него.
function otherAgentPids(root) {
  const found = new Set();
  try {
    const pid = Number(fs.readFileSync(path.join(root, 'agent.pid'), 'utf8').trim());
    if (pid && pid !== process.pid) {
      process.kill(pid, 0);
      found.add(pid);
    }
  } catch { /* файла нет или процесс уже завершился */ }

  try {
    const out = execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CommandLine }"
    ], { encoding: 'utf8' });
    for (const line of out.split(/\r?\n/)) {
      if (!/cli\.js\s+run/.test(line)) continue;
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (pid && pid !== process.pid) found.add(pid);
    }
  } catch { /* без PowerShell остаётся проверка pid-файла */ }
  return [...found];
}

async function ensureVacancy(agent, id) {
  let v = getVacancy(agent.db, id);
  if (v) return v;
  const page = await agent.page('search');
  const details = await getVacancyDetails(page, cfg, id);
  upsertVacancy(agent.db, details);
  setScore(agent.db, id, ruleScore(details, cfg));
  setVacancyStatus(agent.db, id, 'new');
  return getVacancy(agent.db, id);
}

const printVacancy = (v) => {
  console.log(`${String(v.score).padStart(3)}  ${v.resume === 'ai' ? 'AI ' : 'DIR'}  ${v.title}`);
  console.log(`     ${v.company || '—'} · ${v.salary || 'зарплата не указана'}`);
  console.log(`     ${v.url}`);
  console.log(`     ${v.reason}`);
  console.log('');
};

switch (cmd) {
  case 'login': {
    await waitForLogin(cfg);
    await closeContext();
    break;
  }

  case 'scan': {
    const agent = new Agent(cfg);
    await agent.init();
    const withDirect = args.includes('--direct');
    const result = await agent.scan({ direct: withDirect });
    console.log(`\nНайдено новых: ${result.found}. Подходящих AI: ${result.matched}.`);
    if (result.errors?.length) console.log(`Проблемы: ${result.errors.join('; ')}`);
    (result.vacancies ?? []).forEach(printVacancy);
    if (result.direct?.length) {
      console.log(`\nДирект-пул (по запросу, Яндекс Директ): ${result.direct.length}`);
      result.direct.forEach(printVacancy);
    }
    await closeContext();
    break;
  }

  case 'chats': {
    const agent = new Agent(cfg);
    await agent.init();
    const result = await agent.checkChats();
    console.log(`\nНепрочитанных чатов: ${result.chats}. Ждут ответа: ${result.pending}.`);
    await closeContext();
    break;
  }

  case 'statuses': {
    const agent = new Agent(cfg);
    await agent.init();
    const result = await agent.checkStatuses();
    console.log(`Переговоры: ${result.total} откликов, изменений ${result.changed}, добавлено ${result.adopted}.`);
    await closeContext();
    break;
  }

  case 'digest': {
    const agent = new Agent(cfg);
    const r = await agent.digest();
    console.log(`Найдено ${r.found}, откликов ${r.applied}, ждут ${r.pending}, приглашений ${r.invitations}, отказов ${r.rejected}.`);
    break;
  }

  case 'block': {
    const name = args.join(' ').trim();
    if (!name) throw new Error('Укажите компанию: npm run block -- "Название"');
    const agent = new Agent(cfg);
    console.log(`В чёрном списке: ${agent.blockCompany(name).join(', ')}`);
    break;
  }

  case 'unblock': {
    const name = args.join(' ').trim();
    if (!name) throw new Error('Укажите компанию: npm run unblock -- "Название"');
    const agent = new Agent(cfg);
    const list = agent.unblockCompany(name);
    console.log(list.length ? `Осталось: ${list.join(', ')}` : 'Чёрный список пуст.');
    break;
  }

  case 'check': {
    const agent = new Agent(cfg);
    console.log(`LLM: ${llmReady(cfg.llm) ? `${cfg.llm.model} @ ${cfg.llm.baseUrl}` : 'не настроен (config.llm или HH_LLM_*)'}`);
    if (llmReady(cfg.llm)) {
      try {
        const t0 = Date.now();
        const reply = await makeLlmClient(cfg.llm)([{ role: 'user', content: 'Ответь одним словом: ок' }], { maxTokens: 64, temperature: 0 });
        console.log(`LLM ответ: ${String(reply).replace(/\s+/g, ' ').trim().slice(0, 60)} (${Date.now() - t0} мс)`);
      } catch (e) {
        console.log(`LLM ошибка: ${e.message}`);
      }
    }
    if (cfg.telegram.token && cfg.telegram.chatId) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${cfg.telegram.token}/getMe`);
        const data = await res.json();
        console.log(`Telegram: ${data.ok ? '@' + data.result.username : data.description}`);
      } catch (e) {
        console.log(`Telegram ошибка: ${e.message}`);
      }
    } else {
      console.log('Telegram: не настроен (config.telegram или HH_TG_*)');
    }
    const page = await agent.page('search');
    const ok = await checkLoggedIn(page, cfg);
    console.log(`hh: ${ok ? 'логин подтверждён' : 'НЕТ ЛОГИНА — запустите npm run login'}`);
    await closeContext();
    break;
  }

  case 'letter': {
    const id = idFrom(first);
    if (!id) throw new Error('Укажите id вакансии или ссылку');
    const agent = new Agent(cfg);
    await ensureVacancy(agent, id);
    const resumeKey = flag('resume');
    const { letter, vacancy, resumeKey: key } = await agent.generateLetter(id, resumeKey);
    console.log(`Вакансия: ${vacancy.title} — ${vacancy.company}`);
    console.log(`Резюме: ${key === 'ai' ? 'AI-специалист' : 'Директолог'}`);
    console.log(`Сохранено: letters/${id}.txt\n`);
    console.log(letter);
    await closeContext();
    break;
  }

  case 'apply': {
    const id = idFrom(first);
    if (!id) throw new Error('Укажите id вакансии или ссылку');
    const agent = new Agent(cfg);
    await agent.init();
    const vacancy = await ensureVacancy(agent, id);
    const resumeKey = flag('resume') ?? vacancy.resume ?? 'direct';
    // --letter: отправить письмо целиком из файла, не давая LLM переписать его.
    const letterFile = flag('letter');
    const letterText = letterFile ? fs.readFileSync(letterFile, 'utf8') : undefined;
    console.log(`Отклик: ${vacancy.title} — ${vacancy.company} (${resumeKey})`);
    await agent.processApply({ vacancyId: id, resumeKey, letterText });
    await closeContext();
    break;
  }

  case 'task': {
    const action = (first ?? 'install').toLowerCase();
    const taskName = 'HH Agent';
    const root = cfg.paths.root;
    if (action === 'status') {
      try {
        const out = execFileSync('schtasks', ['/Query', '/TN', taskName, '/FO', 'LIST'], { encoding: 'utf8' });
        console.log(out);
      } catch {
        console.log(`Задача «${taskName}» не зарегистрирована.`);
      }
      break;
    }
    if (action === 'remove') {
      try {
        execFileSync('schtasks', ['/Delete', '/TN', taskName, '/F'], { stdio: 'ignore' });
        console.log(`Задача «${taskName}» удалена.`);
      } catch {
        console.log(`Задачи «${taskName}» нет.`);
      }
      break;
    }
    if (action !== 'install') throw new Error('task: допустимо install | status | remove');
    const cli = path.join(root, 'src', 'cli.js');
    const q = (s) => s.replace(/'/g, "''");
    // Запуск node.exe напрямую: через npm Планировщик убил бы только оболочку cmd,
    // а node и Chrome остались бы держать профиль. LogonType Interactive — иначе
    // Chrome стартует в Session 0 и окно капчи не покажется на рабочем столе.
    const script = [
      `$a = New-ScheduledTaskAction -Execute '${q(process.execPath)}' -Argument '"${q(cli)}" run' -WorkingDirectory '${q(root)}'`,
      '$t = New-ScheduledTaskTrigger -AtLogOn',
      '$p = New-ScheduledTaskPrincipal -UserId "$($env:USERDOMAIN)\\$($env:USERNAME)" -LogonType Interactive -RunLevel Limited',
      '$s = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable',
      `Register-ScheduledTask -TaskName '${q(taskName)}' -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null`
    ].join('; ');
    try {
      execFileSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'inherit' });
    } catch {
      throw new Error(
        'Нет прав на регистрацию задачи. Откройте PowerShell «от имени администратора» и выполните:\n'
        + '  cd C:\\hh-agent\n  npm run task -- install'
      );
    }
    console.log(`Задача «${taskName}» зарегистрирована: запуск при входе, интерактивная сессия, до 3 перезапусков.`);
    console.log('Запуск сейчас: schtasks /run /tn "HH Agent" (или двойной клик по ярлыку HH Agent.bat).');
    break;
  }

  case 'run': {
    // Демон работает в отдельном окне: без файла ошибки видны только пока окно открыто.
    const logFile = `${cfg.paths.root}\\agent.log`;
    const log = (m) => {
      console.log(m);
      try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`); } catch { /* лог не должен ронять агента */ }
    };
    const running = otherAgentPids(cfg.paths.root);
    if (running.length) {
      console.log(`Агент уже запущен (PID ${running.join(', ')}). Второй экземпляр не стартую.`);
      process.exitCode = 1;
      break;
    }
    const agent = new Agent(cfg, { log });
    await agent.run();
    break;
  }

  default:
    console.log(`hh-agent

Команды:
  npm run login            войти в hh.ru (один раз)
  npm run scan             проверить AI-выдачу и показать подходящие
  npm run scan -- --direct добавить директ-пул (упор на Яндекс Директ)
  npm run chats            проверить непрочитанные чаты
  npm run statuses         статусы откликов из «Переговоров»
  npm run digest           сводка за день в Telegram/консоль
  npm run block -- "ООО"   добавить компанию в чёрный список
  npm run unblock -- "ООО" убрать компанию из чёрного списка
  npm run check            проверить логин, LLM и Telegram
  npm run letter -- <id>   сгенерировать письмо ([--resume ai|direct])
  npm run apply -- <id>    откликнуться ([--resume ai|direct])
  npm run run              запустить агента с Telegram-ботом
  npm run task -- install  автозапуск при входе (Task Scheduler), status | remove

Конфиг: config.json, факты для писем: profile.json, база: data.db`);
}
