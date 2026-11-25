import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { idFrom, parseFlag, resolveTarget, formatHelp, formatVacancyLines } from '../src/cli.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('idFrom извлекает ID из URL hh.ru и числового аргумента', () => {
  assert.equal(idFrom('https://spb.hh.ru/vacancy/138197375?from=favorite'), '138197375');
  assert.equal(idFrom('138441227'), '138441227');
  assert.equal(idFrom('abc'), '');
});

test('parseFlag и resolveTarget корректно разбирают флаги и позиционные аргументы', () => {
  const args = ['--resume', 'ai', '138197375', '--direct', '--empty'];
  assert.equal(parseFlag(args, 'resume'), 'ai');
  assert.equal(parseFlag(args, 'empty', 'fallback'), 'fallback');
  assert.equal(resolveTarget(args), 'ai');
  assert.equal(resolveTarget(['--direct', '138197375']), '138197375');
});

test('formatVacancyLines и formatHelp формируют читаемый CLI-вывод', () => {
  const lines = formatVacancyLines({
    score: 88,
    resume: 'ai',
    title: 'AI-инженер',
    company: 'Альфа',
    salary: '150 000 ₽',
    url: 'https://hh.ru/vacancy/101',
    reason: 'сильное совпадение'
  });
  assert.match(lines[0], /^\s*88\s+AI\s+AI-инженер$/);
  assert.match(lines[1], /Альфа · 150 000 ₽/);
  assert.match(formatHelp(), /npm run scan/);
});

test('node src/cli.js help выводит справку с кодом возврата 0', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'src', 'cli.js'), 'help'], { encoding: 'utf8' });
  assert.match(out, /hh-agent/);
  assert.match(out, /npm run digest/);
});
