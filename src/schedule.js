export function withinWindow(date, window) {
  if (!window || window.from == null || window.to == null || window.from === window.to) return true;
  const h = date.getHours();
  const { from, to } = window;
  return from < to ? h >= from && h < to : h >= from || h < to;
}

export function msUntilWindow(date, window) {
  if (!window || withinWindow(date, window)) return 0;
  const next = new Date(date);
  next.setMinutes(0, 0, 0);
  do next.setHours(next.getHours() + 1);
  while (!withinWindow(next, window));
  return Math.max(1000, next - date);
}

// Рабочие дни без выходных: суббота и воскресенье не считаются.
export function businessDaysBetween(from, to) {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  let days = 0;
  while (day < last) {
    day.setDate(day.getDate() + 1);
    const wd = day.getDay();
    if (wd !== 0 && wd !== 6) days++;
  }
  return days;
}
