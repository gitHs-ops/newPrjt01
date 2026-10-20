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
  assert.throws(() => parseCsv('"open'), DomainError);
});
