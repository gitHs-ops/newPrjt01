// 会計月度・会計年度（現行 AS400 仕訳帳 AC2205：月度＝前月締日の翌日〜当月締日、期＝決算月締日の翌日〜翌年の決算月締日）。
// エーシートヨアケ・中部舗材とも 月度 21日〜20日、決算 10月20日（期首 10月21日）。締日 31 は暦月・月末。
const pad = n => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const norm = (y, m) => { const t = new Date(Date.UTC(y, m - 1, 1)); return [t.getUTCFullYear(), t.getUTCMonth() + 1]; };
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export function getsudo({ closingMonth = 3, closingDay = 31 } = {}) {
  const d = Number(closingDay) || 31, cm = Number(closingMonth) || 3;
  const closeOf = (y, m) => { const [yy, mm] = norm(y, m); return `${yy}-${pad(mm)}-${pad(Math.min(d, lastDay(yy, mm)))}`; };
  // 月度ラベル YYYY-MM＝その月度の締日が属する月
  const labelOf = iso => { const y = +iso.slice(0, 4), m = +iso.slice(5, 7); if (iso <= closeOf(y, m)) return iso.slice(0, 7); const [yy, mm] = norm(y, m + 1); return `${yy}-${pad(mm)}`; };
  const monthRange = label => { const y = +label.slice(0, 4), m = +label.slice(5, 7); return { from: addDays(closeOf(y, m - 1), 1), to: closeOf(y, m) }; };
  const fyOf = iso => { const y = +iso.slice(0, 4); return iso > closeOf(y, cm) ? y : y - 1; };
  const fyRange = fy => ({ from: addDays(closeOf(fy, cm), 1), to: closeOf(fy + 1, cm) });
  const months = fy => { const first = labelOf(fyRange(fy).from); return Array.from({ length: 12 }, (_, i) => { const [y, m] = norm(+first.slice(0, 4), +first.slice(5, 7) + i); return `${y}-${pad(m)}`; }); };
  return { closingMonth: cm, closingDay: d, closeOf, labelOf, monthRange, fyOf, fyRange, months };
}
export async function companyPeriod(c) {
  const [rs] = await c.query('SELECT closing_m, closing_d FROM company_info_m WHERE company_info_id=1');
  return getsudo({ closingMonth: rs[0]?.closing_m, closingDay: rs[0]?.closing_d });
}
