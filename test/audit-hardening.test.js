import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('profile.json исключён из Git до инициализации репозитория', () => {
  const ignore = fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.ok(ignore.split(/\r?\n/).includes('profile.json'));
});
