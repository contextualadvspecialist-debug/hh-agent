import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

let contextPromise = null;

export async function getContext(cfg) {
  if (contextPromise) return contextPromise;
  fs.mkdirSync(cfg.paths.profile, { recursive: true });
  contextPromise = chromium.launchPersistentContext(cfg.paths.profile, {
    channel: cfg.browser.channel || 'chrome',
    headless: Boolean(cfg.browser.headless),
    viewport: { width: 1440, height: 900 },
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    args: ['--disable-blink-features=AutomationControlled', '--disk-cache-size=104857600']
  }).then((ctx) => {
    // Браузер могут закрыть руками — тогда следующий вызов запустит его заново.
    ctx.on('close', () => { contextPromise = null; });
    return ctx;
  }).catch((e) => {
    contextPromise = null;
    throw e;
  });
  return contextPromise;
}

export async function closeContext() {
  if (!contextPromise) return;
  const ctx = await contextPromise.catch(() => null);
  contextPromise = null;
  if (ctx) await ctx.close().catch(() => {});
}

export async function newPage(ctx) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(45000);
  return page;
}

export class AuthError extends Error {
  constructor(message = 'нет логина на hh.ru') {
    super(message);
    this.name = 'AuthError';
  }
}

export async function looksLoggedOut(page) {
  const url = typeof page?.url === 'function' ? String(page.url() || '') : '';
  if (/\/account\/login|\/logon/.test(url)) return true;

  const bodyLoc = page?.locator?.('body');
  const rawBody = bodyLoc && typeof bodyLoc.innerText === 'function'
    ? await bodyLoc.innerText().catch(() => '')
    : '';
  const body = rawBody.replace(/\u00a0/g, ' ');
  if (!/Войти с паролем|Вход в личный кабинет/.test(body)) return false;

  const uiLoc = page?.locator?.('[data-qa="chatik-layout"], [data-qa="mainmenu_applicantProfile"], [data-qa="mainmenu_profile"]');
  const hasUiCount = uiLoc && typeof uiLoc.count === 'function'
    ? await uiLoc.count().catch(() => 0)
    : 0;
  const hasLoggedUi = /Отклики и приглашения|Отклики|Ожидание|Резюме и профиль|Мои резюме|Создать резюме/.test(body)
    || Boolean(hasUiCount);
  return !hasLoggedUi;
}

export async function assertLoggedIn(page, message = 'нет логина на hh.ru') {
  if (await looksLoggedOut(page)) throw new AuthError(message);
}

export async function checkLoggedIn(page, cfg) {
  await page.goto(`${cfg.hh.base}/applicant/negotiations`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  if (/\/account\/login|\/logon/.test(page.url())) return false;

  // Просроченный hhtoken остаётся в cookie, поэтому смотрим на содержимое страницы.
  const body = (await page.locator('body').innerText().catch(() => '')).replace(/\u00a0/g, ' ');
  if (/Подтвердите, что вы не робот|captcha/i.test(body)) return false;
  if (/Войти с паролем|Обязательное поле/.test(body)) return false;

  const menu = await page
    .locator('[data-qa="mainmenu_applicantProfile"], [data-qa="mainmenu_profile"]')
    .count()
    .catch(() => 0);
  if (menu) return true;
  // Актуальное меню hh: «Резюме и профиль», «Отклики и приглашения».
  return /Резюме и профиль|Отклики и приглашения|Мои резюме|Создать резюме/.test(body);
}

export async function waitForLogin(cfg, { timeoutMs = 20 * 60 * 1000, log = console.log } = {}) {
  const ctx = await getContext(cfg);
  const loginPage = ctx.pages()[0] ?? (await ctx.newPage());
  await loginPage.goto(cfg.hh.base, { waitUntil: 'domcontentloaded' });
  log('Войдите в hh.ru в открытом окне Chrome. Агент ждёт до 20 минут.');

  const probe = await newPage(ctx);
  const started = Date.now();
  let ok = false;
  while (Date.now() - started < timeoutMs) {
    await probe.waitForTimeout(15000);
    try {
      ok = await checkLoggedIn(probe, cfg);
    } catch {
      ok = false;
    }
    if (ok) break;
  }
  await probe.close().catch(() => {});
  if (!ok) throw new Error('Логин не выполнен за отведённое время');
  log('Логин подтверждён.');
  return true;
}
