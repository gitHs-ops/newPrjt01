import test from 'node:test';
import assert from 'node:assert/strict';
import { toZenginKana, zenginInvalid, zenginFile, sjis } from '../server/zengin.mjs';

test('kana normalisation to the Zengin character set', () => {
  assert.equal(toZenginKana('サンプルシザイ'), 'ｻﾝﾌﾟﾙｼｻﾞｲ');
  assert.equal(toZenginKana('かぶしきがいしゃ　デモ'), 'ｶﾌﾞｼｷｶﾞｲｼﾔ ﾃﾞﾓ');
  assert.equal(toZenginKana('ｶ)ﾃﾞﾓｳﾝﾕ'), 'ｶ)ﾃﾞﾓｳﾝﾕ');
  assert.equal(toZenginKana('ｷｬｯｼｭ'), 'ｷﾔﾂｼﾕ');
  assert.equal(toZenginKana('ａｂｃ１２３'), 'ABC123');
  assert.deepEqual(zenginInvalid(toZenginKana('山田')), ['山', '田']);
  assert.deepEqual([...sjis('Aｱﾞ ')], [0x41, 0xb1, 0xde, 0x20]);
});
test('総合振込 file: 120-byte records, totals and validation', () => {
  const payer = { requesterCode: '1234567890', requesterName: 'ｻﾝﾌﾟﾙｹﾝｻﾞｲ(ｶ', bank: '0001', branch: '001', type: '2', account: '1234567' };
  const f = zenginFile({ date: '2026-10-31', payer, transfers: [
    { label: 'V001', bank: '0005', branch: '123', type: '1', account: '7654321', holder: 'デモウンユ', amount: 250000, customer1: 'V001' },
    { label: 'V002', bank: '0009', branch: '456', type: '1', account: '1', holder: 'ｻﾝﾌﾟﾙ', amount: 1000 }] });
  assert.deepEqual(f.errors, []);
  assert.equal(f.records.length, 5); for (const r of f.records) assert.equal(r.length, 120);
  assert.equal(f.body.length, 5 * 122);
  assert.ok(f.records[0].startsWith('1210' + '1234567890')); assert.equal(f.records[0].slice(54, 58), '1031');
  assert.equal(f.records[1].slice(0, 1), '2'); assert.equal(f.records[1].slice(43, 50), '7654321'); assert.equal(f.records[1].slice(80, 90), '0000250000');
  assert.equal(f.records[2].slice(43, 50), '0000001');
  assert.equal(f.records[3], '8' + '000002' + '000000251000' + ' '.repeat(101));
  assert.equal(f.records[4], '9' + ' '.repeat(119));
  const bad = zenginFile({ date: '2026-10-31', payer: { ...payer, requesterCode: '' }, transfers: [{ label: 'X', bank: '1', branch: '1', account: '12345678', holder: '山田', amount: 0 }] });
  assert.equal(bad.errors.length, 4);
});
