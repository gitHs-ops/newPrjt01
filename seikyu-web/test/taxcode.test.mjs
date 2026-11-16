import test from 'node:test';
import assert from 'node:assert/strict';
import { decode, normalize, taxOf } from '../server/taxcode.mjs';
import { yayoiTax } from '../server/accounting-export.mjs';

// 処税率（消費税区分.xlsx）：1桁目 税込区分・2桁目 税区分・3桁目 税率区分
test('処税率 3桁の分解と税額', () => {
  assert.equal(normalize(' 41'), '041'); assert.equal(normalize('9'), '090'); assert.equal(normalize(' 9 '), '090'); assert.equal(normalize('10%'), '141');
  assert.equal(normalize('351'), null); assert.equal(normalize('99'), null);
  const t141 = decode('141'); assert.equal(t141.side, 'P'); assert.equal(t141.rate, 10); assert.equal(t141.taxable, true); assert.equal(t141.excl, false);
  assert.equal(decode('41').taxable, false); assert.equal(decode('41').excl, false); // 「 41」＝非課税（消費税区分.xlsx の例示、2026-11-16）
  assert.equal(decode('11').taxable, true); assert.equal(decode('251').excl, true);  // それ以外の 1桁目空白は外税のまま（D-025）
  assert.equal(yayoiTax('041'), '非課仕入'); assert.equal(yayoiTax('141'), '課対仕入10%'); assert.equal(yayoiTax('070'), '非課仕入');
  assert.equal(decode('241').excl, true); assert.equal(decode('141').excl, false);
  assert.equal(decode('11').excl, true);                        // 売上行＋仮受消費税行＝税別記
  assert.equal(taxOf(11000, '141'), 1000); assert.equal(taxOf(10800, '148'), 800); assert.equal(taxOf(10000, '011'), 1000); assert.equal(taxOf(10000, '041'), 0); assert.equal(taxOf(10000, '241'), 1000);
});
