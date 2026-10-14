// 全銀協フォーマット（総合振込・固定長120バイト・Shift_JIS）。使用文字は数字・英大文字・半角カナ・一部記号のみ。
import { check } from './domain.mjs';

const FW = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンァィゥェォッャュョヮヰヱ';
const HW = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝｱｲｳｴｵﾂﾔﾕﾖﾜｲｴ'; // 小書き文字は全銀では大文字に置換
const HALF_SMALL = { 'ｧ': 'ｱ', 'ｨ': 'ｲ', 'ｩ': 'ｳ', 'ｪ': 'ｴ', 'ｫ': 'ｵ', 'ｯ': 'ﾂ', 'ｬ': 'ﾔ', 'ｭ': 'ﾕ', 'ｮ': 'ﾖ', 'ｰ': '-' };
const ALLOWED = /^[0-9A-Zｦ-ﾝﾞﾟ ().,\-/\\]*$/;
// Converts typed names (hiragana / full-width katakana / full-width alnum) to the Zengin character set.
export function toZenginKana(input) {
  let s = String(input ?? '').normalize('NFD');
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x3041 && cp <= 0x3096) { out += toZenginKana(String.fromCodePoint(cp + 0x60)); continue; } // hiragana → katakana
    if (cp === 0x3099) { out += 'ﾞ'; continue; } if (cp === 0x309a) { out += 'ﾟ'; continue; }
    if (ch === 'ヴ') { out += 'ｳﾞ'; continue; }
    const i = FW.indexOf(ch); if (i >= 0) { out += HW[i]; continue; }
    if (cp >= 0xff01 && cp <= 0xff5e) { out += String.fromCodePoint(cp - 0xfee0).toUpperCase(); continue; }
    if (ch === '　') { out += ' '; continue; } if (ch === 'ー' || ch === '－' || ch === '‐') { out += '-'; continue; }
    out += HALF_SMALL[ch] || ch.toUpperCase();
  }
  return out;
}
export const zenginInvalid = s => [...s].filter(ch => !ALLOWED.test(ch));
const kana = (v, len) => toZenginKana(v).slice(0, len).padEnd(len, ' ');
const digits = (v, len) => String(v ?? '').padStart(len, '0').slice(-len);
const blank = n => ' '.repeat(n);
// Shift_JIS for the allowed set: ASCII bytes as-is, half-width kana U+FF61-U+FF9F → 0xA1-0xDF.
export function sjis(text) {
  const out = Buffer.alloc(text.length);
  [...text].forEach((ch, i) => { const cp = ch.codePointAt(0); out[i] = cp < 0x80 ? cp : cp >= 0xff61 && cp <= 0xff9f ? cp - 0xfec0 : 0x20; });
  return out;
}
/**
 * payer: { requesterCode(10), requesterName, bank(4), bankName, branch(3), branchName, type, account(7) }
 * transfers: [{ bank(4), branch(3), type, account, holder, amount, customer1 }]
 */
export function zenginFile({ date, payer, transfers }) {
  const errors = [];
  const req = (ok, msg) => { if (!ok) errors.push(msg); };
  req(/^\d{10}$/.test(payer.requesterCode || ''), '振込依頼人コード（10桁）が未設定です（マスタ管理 → 銀行）');
  req(/^\d{4}$/.test(payer.bank || '') && /^\d{3}$/.test(payer.branch || '') && /^\d{1,7}$/.test(payer.account || ''), '振込元の銀行4桁・支店3桁・口座番号（7桁以内）が未設定です');
  const reqName = toZenginKana(payer.requesterName || ''); req(reqName.trim() && !zenginInvalid(reqName).length, `振込依頼人名（カナ）が不正です: ${payer.requesterName || '未設定'}`);
  const recs = [];
  const header = '1' + '21' + '0' + digits(payer.requesterCode, 10) + kana(payer.requesterName, 40) + date.slice(5, 7) + date.slice(8, 10)
    + digits(payer.bank, 4) + kana(payer.bankName, 15) + digits(payer.branch, 3) + kana(payer.branchName, 15) + String(payer.type || '1').slice(0, 1) + digits(payer.account, 7) + blank(17);
  recs.push(header);
  let total = 0;
  for (const t of transfers) {
    const holder = toZenginKana(t.holder);
    req(/^\d{4}$/.test(t.bank || '') && /^\d{3}$/.test(t.branch || '') && /^\d{1,7}$/.test(t.account || ''), `${t.label}: 振込先の銀行・支店・口座番号（7桁以内）を確認してください`);
    req(holder.trim() && !zenginInvalid(holder).length, `${t.label}: 受取人名に全銀で使えない文字があります（${zenginInvalid(holder).join('') || '未入力'}）。半角カナで登録してください`);
    req(Number.isSafeInteger(t.amount) && t.amount > 0 && t.amount <= 9999999999, `${t.label}: 振込金額が範囲外です`);
    total += t.amount;
    recs.push('2' + digits(t.bank, 4) + kana(t.bankName, 15) + digits(t.branch, 3) + kana(t.branchName, 15) + blank(4) + String(t.type || '1').slice(0, 1) + digits(t.account, 7)
      + kana(t.holder, 30) + digits(t.amount, 10) + '0' + kana(t.customer1 || '', 10) + blank(10) + '7' + ' ' + blank(7));
  }
  recs.push('8' + digits(transfers.length, 6) + digits(total, 12) + blank(101));
  recs.push('9' + blank(119));
  for (const r of recs) check(r.length === 120, '全銀レコード長エラー（内部）');
  return { records: recs, count: transfers.length, total, errors, body: sjis(recs.join('\r\n') + '\r\n') };
}
