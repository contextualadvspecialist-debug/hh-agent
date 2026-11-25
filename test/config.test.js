import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig, merge, DEFAULTS } from '../src/config.js';

test('merge объединяет вложенные объекты и перезаписывает массивы целиком', () => {
  const merged = merge(
    { hh: { minSalary: 50000, queriesAI: ['a', 'b'], remoteOnly: true } },
    { hh: { minSalary: 90000, queriesAI: ['only-one'] } }
  );
  assert.equal(merged.hh.minSalary, 90000);
  assert.equal(merged.hh.remoteOnly, true);
  assert.deepEqual(merged.hh.queriesAI, ['only-one']);
});

test('loadConfig создаёт дефолтный config.json и подхватывает env fallback без перекрытия явных полей', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-cfg-'));
  try {
    const configPath = path.join(tmp, 'config.json');
    const created = loadConfig({ configPath, env: {} });
    assert.ok(fs.existsSync(configPath));
    assert.equal(created.paths.root, tmp);
    assert.equal(created.paths.config, configPath);
    assert.equal(created.hh.base, DEFAULTS.hh.base);

    fs.writeFileSync(configPath, JSON.stringify({
      hh: { minSalary: 120000, queriesAI: ['custom'] },
      telegram: { token: 'cfg-token', chatId: '' },
      llm: { model: 'cfg-model' }
    }), 'utf8');

    const loaded = loadConfig({
      configPath,
      env: {
        HH_TG_TOKEN: 'env-token',
        HH_TG_CHAT_ID: '42',
        HH_LLM_BASE_URL: 'https://llm.local/v1',
        HH_LLM_API_KEY: 'sk-test',
        HH_LLM_MODEL: 'env-model',
        HH_LLM_REASONING: 'low'
      }
    });
    assert.equal(loaded.hh.minSalary, 120000);
    assert.deepEqual(loaded.hh.queriesAI, ['custom']);
    assert.equal(loaded.telegram.token, 'cfg-token');
    assert.equal(loaded.telegram.chatId, '42');
    assert.equal(loaded.llm.baseUrl, 'https://llm.local/v1');
    assert.equal(loaded.llm.apiKey, 'sk-test');
    assert.equal(loaded.llm.model, 'cfg-model');
    assert.equal(loaded.llm.reasoningEffort, 'low');

    loaded.threshold = 77;
    saveConfig(loaded);
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(saved.threshold, 77);
    assert.equal('paths' in saved, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadConfig выбрасывает понятную ошибку при битом JSON', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-cfg-bad-'));
  try {
    const configPath = path.join(tmp, 'config.json');
    fs.writeFileSync(configPath, '{broken json', 'utf8');
    assert.throws(() => loadConfig({ configPath, env: {} }), /config\.json не читается/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
