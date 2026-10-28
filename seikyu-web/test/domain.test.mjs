import test from 'node:test';
import assert from 'node:assert/strict';
import { yen, qty, lineAmount, taxOf, period, dueDate, isoDate, csv, parseCsv, DomainError, closingDay } from '../server/domain.mjs';

test('money and quantity use exact integer arithmetic', () => {
  assert.equal(lineAmount(qty('0.1'), 3), 0);
  assert.equal(lineAmount(qty('12.35'), 3200), 39520);
  assert.equal(lineAmount(qty('99999.99'), 9999999), 999999800000);
  assert.equal(taxOf(39520, 10), 3952);
  assert.equal(taxOf(999, 8), 79);
  assert.throws(() => qty('1.234'), DomainError);
  assert.throws(() => qty('0'), DomainError);
  assert.equal(qty('0', '在庫', { positive: false }).text, '0.00');
  assert.throws(() => yen('-1'), DomainError);
  assert.equal(yen('1,200'), 1200);
  assert.throws(() => taxOf(100, 5), DomainError);
});
test('billing periods follow closing day including month end', () => {
  assert.deepEqual(period('2026-10', 10), { start: '2026-09-11', end: '2026-10-10' });
  assert.deepEqual(period('2026-03', 31), { start: '2026-03-01', end: '2026-03-31' });
  assert.deepEqual(period('2026-02', 31), { start: '2026-02-01', end: '2026-02-28' });
  assert.deepEqual(period('2026-01', 20), { start: '2025-12-21', end: '2026-01-20' });
  assert.equal(dueDate('2026-10-10'), '2026-11-30');
  assert.equal(dueDate('2026-12-20'), '2027-01-31');
  // 現行 Java と同じく締日は 1〜31（29・30 日締めは短い月では月末）
  assert.equal(closingDay(29), 29);
  assert.deepEqual(period('2026-02', 30), { start: '2026-01-31', end: '2026-02-28' });
  assert.throws(() => closingDay(32), DomainError);
  assert.throws(() => closingDay(0), DomainError);
  assert.throws(() => isoDate('2026-02-30'), DomainError);
});
test('csv round trip neutralises formulas', () => {
  const out = csv([['a', '=SUM(A1)', 'x"y'], ['1', '', '改行\nあり']]);
  assert.ok(out.startsWith('﻿'));
  assert.ok(out.includes(`"'=SUM(A1)"`));
  assert.deepEqual(parseCsv(out), [['a', '=SUM(A1)', 'x"y'], ['1', '', '改行\nあり']]);
  const neg = csv([[-12345, '-678.5', '-cmd', '-1-2']]);
  assert.ok(neg.includes('"-12345","-678.5","\'-cmd","\'-1-2"'));
  assert.throws(() => parseCsv('"open'), DomainError);
});

test('A01 slip numbers: one closing run shares a number, split every 45 customers (Q08)', async () => {
  const { assignSlipNo, AR_SLIP_MAX } = await import('../server/db.mjs');
  let last = 828; const saved = [];
  const c = { query: async (sql, args) => {
    if (sql.startsWith('SELECT last_no')) return [[{ last_no: last }]];
    if (sql.startsWith('INSERT INTO app_slip_series')) { last = args[1]; return [[]]; }
    if (sql.startsWith('SELECT closing_m')) return [[{ closing_m: 10, closing_d: 20 }]]; // 決算 10月20日（期首 10月21日）
    saved.push(args[1]); return [[]];
  } };
  const slip = { max: AR_SLIP_MAX };
  for (let i = 1; i <= 100; i++) await assignSlipNo(c, i, 'A01', slip, '2026-10-28');
  assert.equal(AR_SLIP_MAX, 45);
  assert.deepEqual([...new Set(saved)], ['R202600829', 'R202600830', 'R202600831']); // 頭1桁＋処理年度4桁＋5桁連番（10/26 打合せ）
  assert.deepEqual(['R202600829', 'R202600830', 'R202600831'].map(n => saved.filter(x => x === n).length), [45, 45, 10]);
  assert.equal(await assignSlipNo(c, 101, 'A01', undefined, '2026-10-28'), 'R202600832', 'without a shared run state each journal gets its own number');
  assert.equal(await assignSlipNo(c, 102, 'A01', undefined, '2026-10-20'), 'R202500833', '期首（10/21）より前は前年度');
});

test('単価・運賃：出荷伝票と売上の単価が合わない移行データは売上の単価（運賃0）', async () => {
  const { priceOf } = await import('../server/sales.mjs');
  assert.deepEqual(priceOf('2000', '1200', '0'), { price: 2000, freight: 0 });
  assert.deepEqual(priceOf('9300', '9300', '1500'), { price: 9300, freight: 0 });
  assert.deepEqual(priceOf('10300', '9300', '1000'), { price: 9300, freight: 1000 });
  assert.deepEqual(priceOf('5000', null, null), { price: 5000, freight: 0 });
});
