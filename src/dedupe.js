const normalize = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\u00a0/g, ' ').trim();

const LEGAL_FORM = /^(ооо|оао|зао|пао|ао|ип|нко|llc|ltd|inc|gmbh)\s+/i;

const NOISE = /\b(удаленн\w*|remote|senior|junior|middle|lead|ведущий|старший|младший|г\.?\s+[a-zа-я-]+)\b/gi;

export function companyKey(name) {
  return normalize(name)
    .replace(/[«»"'`]/g, ' ')
    .replace(LEGAL_FORM, '')
    .replace(/[^a-zа-я0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleKey(title) {
  return normalize(title)
    .replace(/\([^)]*\)/g, ' ')
    .replace(NOISE, ' ')
    .replace(/[^a-zа-я0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function maxSalary(salary) {
  const nums = String(salary ?? '').match(/\d[\d\s\u00a0]*/g) ?? [];
  return nums.reduce((max, s) => Math.max(max, Number(s.replace(/[\s\u00a0]/g, '')) || 0), 0);
}

function jaccard(a, b) {
  const A = new Set(a.split(' ').filter(Boolean));
  const B = new Set(b.split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

// Один и тот же оффер от того же работодателя или от кадрового агентства.
export function isDuplicate(a, b) {
  if (!a?.title || !b?.title || a.id === b.id) return false;
  const ta = titleKey(a.title);
  const tb = titleKey(b.title);
  if (!ta || !tb) return false;
  if (ta !== tb && jaccard(ta, tb) < 0.85) return false;

  const ca = companyKey(a.company);
  const cb = companyKey(b.company);
  if (ca && ca === cb) return true;

  const sa = maxSalary(a.salary);
  const sb = maxSalary(b.salary);
  return Boolean(sa && sb && sa === sb);
}

// Кадровые агентства и репостеры меняют заголовок и вилку, оставляя текст требований.
export function descriptionKey(text) {
  return normalize(text)
    .replace(/[^a-zа-я0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 120)
    .join(' ');
}

export function isDescriptionDuplicate(a, b) {
  if (!a || !b || a.id === b.id) return false;
  const A = descriptionKey(a.snippet);
  const B = descriptionKey(b.snippet);
  if (A.length < 200 || B.length < 200) return false;
  return jaccard(A, B) >= 0.9;
}
