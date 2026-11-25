import { AuthError, checkLoggedIn } from './browser.js';
import { searchQuery, getVacancyDetails, CaptchaError } from './hh-search.js';
import { isDuplicate, isDescriptionDuplicate } from './dedupe.js';
import { ruleScore, llmRefine } from './score.js';
import {
  upsertVacancy, setScore, setVacancyStatus, hasVacancy,
  kvSet, recentVacancies, listRuleScored, recentSnippets
} from './db.js';
import { isAuthError } from './agent-ops.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (min, max) => min + Math.floor(Math.random() * (max - min));

// Дооценка вакансий, которые правила занизили до порога, а LLM ещё не смотрел.
export async function rescoreBorderline(agent, budget = 20) {
  if (!agent.llm) return [];
  const rows = listRuleScored(agent.db, Math.max(40, agent.cfg.threshold - 10), agent.cfg.threshold - 1, budget);
  const negatives = agent.skipExamples();
  const matched = [];
  for (const row of rows) {
    const base = { score: row.score, reason: row.reason ?? '', resume: row.resume === 'direct' ? 'direct' : 'ai' };
    try {
      const refined = await llmRefine(agent.llm, agent.profile, row, base, negatives);
      const ok = refined !== base;
      if (ok) agent.log?.(`rescore ${row.id}: ${row.score} → ${refined.score}`);
      // llm_at ставим и при неразобранном ответе, иначе такие вакансии навсегда займут бюджет переоценки.
      setScore(agent.db, row.id, { ...(ok ? refined : base), by: ok ? 'llm' : 'rule', llmAt: new Date().toISOString() });
      if (refined.score >= agent.cfg.threshold) {
        setVacancyStatus(agent.db, row.id, 'new');
        matched.push({ ...row, ...refined });
      }
    } catch (e) {
      agent.log?.(`rescore ${row.id}: ${e.message}`);
    }
  }
  matched.sort((a, b) => b.score - a.score);
  return matched;
}

export async function scanOnce(agent, { direct = false } = {}) {
  const page = await agent.page('search');
  const seen = new Set();
  const addedAI = [];
  const addedDirect = [];
  const errors = [];
  const known = recentVacancies(agent.db, 800);
  const knownTexts = recentSnippets(agent.db, 800);

  const batches = [
    ...(agent.cfg.hh.queriesAI ?? []).map((q) => ({ query: q, pool: 'ai' })),
    ...(direct ? (agent.cfg.hh.queriesDirect ?? []).map((q) => ({ query: q, pool: 'direct' })) : [])
  ];

  let dupCount = 0;
  let nonRemoteCount = 0;
  let searchCaptcha = false;
  let captchaReason = '';

  outer: for (const { query, pool } of batches) {
    for (let p = 0; p < (agent.cfg.hh.pages ?? 1); p++) {
      let items = [];
      try {
        items = await searchQuery(page, agent.cfg, query, p);
      } catch (e) {
        if (isAuthError(e)) throw e;
        if (e instanceof CaptchaError) {
          searchCaptcha = true;
          captchaReason = `поиск «${query}»`;
          errors.push(`капча: «${query}»`);
          await page.bringToFront().catch((err) => agent.log?.(`bringToFront: ${err.message}`));
          break outer;
        }
        errors.push(`${query}: ${e.message}`);
        break;
      }
      for (const v of items) {
        if (!v.id || seen.has(v.id)) continue;
        seen.add(v.id);
        if (hasVacancy(agent.db, v.id)) continue;
        if (agent.cfg.hh.remoteOnly && !v.remote) {
          nonRemoteCount++;
          continue;
        }
        if (known.some((k) => isDuplicate(v, k))) {
          dupCount++;
          continue;
        }
        // Тот же текст требований под другим заголовком — репост кадрового агентства.
        if (v.snippet && knownTexts.some((k) => isDescriptionDuplicate(v, k))) {
          dupCount++;
          continue;
        }
        const row = { ...v, query, pool };
        upsertVacancy(agent.db, row);
        known.push(row);
        if (row.snippet) knownTexts.push({ id: row.id, snippet: row.snippet.slice(0, 800) });
        (pool === 'ai' ? addedAI : addedDirect).push(row);
      }
      await sleep(rnd(2500, 4500));
    }
  }

  // У части карточек в выдаче нет сниппета — догружаем описание у лучших кандидатов.
  let captchaStop = false;
  const enrich = async (list, budget) => {
    let detailed = 0;
    const preliminary = list
      .map((v) => ({ v, base: ruleScore(v, agent.cfg) }))
      .sort((a, b) => b.base.score - a.base.score);

    for (const item of preliminary) {
      if (captchaStop || detailed >= budget) break;
      if (item.base.score < 30 || (item.v.snippet && item.v.snippet.length >= 80)) continue;
      detailed++;
      try {
        const details = await getVacancyDetails(page, agent.cfg, item.v.id);
        item.v.snippet = details.snippet || item.v.snippet;
        item.v.company = item.v.company || details.company;
        item.v.salary = item.v.salary || details.salary;
        upsertVacancy(agent.db, { ...item.v, query: item.v.query });
        item.base = ruleScore(item.v, agent.cfg);
      } catch (e) {
        if (e instanceof CaptchaError) {
          captchaStop = true;
          if (!captchaReason) captchaReason = `карточка вакансии ${item.v.id}`;
          errors.push('капча на карточке вакансии');
          await page.bringToFront().catch((err) => agent.log?.(`bringToFront: ${err.message}`));
        } else {
          agent.log?.(`details ${item.v.id}: ${e.message}`);
        }
      }
      await sleep(rnd(1200, 2400));
    }
    return preliminary;
  };

  let llmUsed = 0;
  const negatives = agent.skipExamples();
  const scoreList = async (preliminary, { status }) => {
    const matched = [];
    for (const { v, base } of preliminary) {
      let result = base;
      let by = 'rule';
      let llmAt = '';
      if (agent.llm && base.score >= 35 && llmUsed < 60) {
        llmUsed++;
        try {
          const refined = await llmRefine(agent.llm, agent.profile, v, base, negatives);
          // llmRefine отдаёт тот же объект, если JSON не разобрался — тогда это оценка правил.
          if (refined !== base) {
            result = refined;
            by = 'llm';
            llmAt = new Date().toISOString();
          }
        } catch (e) {
          agent.log?.(`llm score: ${e.message}`);
        }
      }
      setScore(agent.db, v.id, { ...result, by, llmAt });
      if (result.score >= agent.cfg.threshold) {
        setVacancyStatus(agent.db, v.id, status);
        matched.push({ ...v, ...result });
      } else {
        setVacancyStatus(agent.db, v.id, 'low');
      }
    }
    matched.sort((a, b) => b.score - a.score);
    return matched;
  };

  const matched = await scoreList(await enrich(addedAI, 25), { status: 'new' });
  const directMatched = direct
    ? await scoreList(await enrich(addedDirect, 10), { status: 'direct-pool' })
    : [];

  // Топ-3 с высокой оценкой получают разбор сразу — решение по карточке занимает секунды.
  let autoFits = 0;
  for (const v of matched.slice(0, 12)) {
    if (autoFits < 3 && v.score >= 75) {
      try {
        v.fitNote = await agent.fitNote(v.id);
        if (v.fitNote) autoFits++;
      } catch (e) {
        agent.log?.(`fit ${v.id}: ${e.message}`);
      }
    }
    await agent.notifyVacancy(v);
  }
  if (matched.length > 12) {
    await agent.send(`Ещё ${matched.length - 12} подходящих вакансий в базе — команда /more.`);
  }
  if (directMatched.length) {
    agent.log?.(`директ-пул: ${directMatched.length} подходящих (по запросу)`);
  }

  // Пограничные вакансии прошлых сканов, до которых не дошёл бюджет LLM.
  const rescored = typeof agent.rescoreBorderline === 'function'
    ? await agent.rescoreBorderline(20)
    : await rescoreBorderline(agent, 20);
  for (const v of rescored.slice(0, 5)) {
    await agent.notifyVacancy(v);
  }
  if (rescored.length > 5) {
    await agent.send(`Переоценка добавила ещё ${rescored.length - 5} — команда /more.`);
  }
  if (rescored.length) agent.log?.(`переоценка: +${rescored.length} выше порога`);

  kvSet(agent.db, 'lastScan', new Date().toISOString());

  if (agent.cfg.autoApply) {
    for (const v of matched.slice(0, agent.cfg.limits.dailyApplications)) {
      agent.enqueueApply(v.id, v.resume);
    }
  }

  if (seen.size === 0 && batches.length > 0 && errors.length === 0) {
    if (!(await checkLoggedIn(page, agent.cfg))) {
      throw new AuthError('сессия hh.ru истекла (поиск)');
    }
  }

  agent.log?.(
    `scan: найдено ${addedAI.length + addedDirect.length}, подходящих ${matched.length}, `
    + `переоценено +${rescored.length}, дублей ${dupCount}, не удалёнка ${nonRemoteCount}, авторазборов ${autoFits}`
  );
  if (nonRemoteCount >= 10 && addedAI.length + addedDirect.length === 0) {
    agent.log?.(`scan: все ${nonRemoteCount} новых вакансий отфильтрованы по удалёнке — проверьте разметку hh.ru`);
  }
  return {
    found: addedAI.length + addedDirect.length,
    matched: matched.length,
    vacancies: matched,
    direct: directMatched,
    rescored: rescored.length,
    nonRemote: nonRemoteCount,
    totalBatches: batches.length,
    captcha: searchCaptcha || captchaStop,
    captchaReason,
    errors
  };
}
