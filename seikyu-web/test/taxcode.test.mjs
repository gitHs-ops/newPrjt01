import test from 'node:test';
import assert from 'node:assert/strict';
import { decode, normalize, taxOf } from '../server/taxcode.mjs';

// 処税率（消費税区分.xlsx）：1桁目 税込区分・2桁目 税区分・3桁目 税率区分
test('処税率 3桁の分解と税額', () => {
  assert.equal(normalize(' 41'), '041'); assert.equal(normalize('9'), '090'); assert.equal(normalize(' 9 '), '090'); assert.equal(normalize('10%'), '141');
  assert.equal(normalize('351'), null); assert.equal(normalize('99'), null);
  const t141 = decode('141'); assert.equal(t141.side, 'P'); assert.equal(t141.rate, 10); assert.equal(t141.taxable, true); assert.equal(t141.excl, false);
  assert.equal(decode('41').taxable, true); assert.equal(decode('41').excl, true); // 1桁目空白＝外税（2 と同じ、10/21 打合せ）
  assert.equal(decode('241').excl, true); assert.equal(decode('141').excl, false);
  assert.equal(decode('11').excl, true);                        // 売上行＋仮受消費税行＝税別記
  assert.equal(taxOf(11000, '141'), 1000); assert.equal(taxOf(10800, '148'), 800); assert.equal(taxOf(10000, '011'), 1000); assert.equal(taxOf(10000, '041'), 1000); assert.equal(taxOf(10000, '241'), 1000);
});
