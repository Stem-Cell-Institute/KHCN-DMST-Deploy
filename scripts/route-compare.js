#!/usr/bin/env node
'use strict';

/**
 * scripts/route-compare.js
 * So hai ảnh do scripts/route-snapshot.js chụp. Thoát mã 0 nếu hành vi giống nhau, mã 1 nếu khác.
 *
 *   node scripts/route-compare.js <ảnh-trước.json> <ảnh-sau.json>
 *   npm run route:compare -- <ảnh-trước.json> <ảnh-sau.json>
 *
 * Phân loại khác biệt:
 *   - ĐỔI MÃ TRẠNG THÁI  (vd 401 → 200: mở toang quyền; 200 → 404: mất route)   → LỖI
 *   - ĐỔI NỘI DUNG       (cùng mã nhưng nội dung khác, bỏ qua mục tự đổi theo thời gian) → LỖI
 *   - CHỈ CÓ Ở MỘT BÊN   (route bị thêm / mất khỏi danh sách được chụp)            → LỖI
 *   - TỰ ĐỔI THEO THỜI GIAN (volatile)                                             → chỉ thông tin
 *
 * Mọi khác biệt đều là "LỖI" vì refactor KHÔNG được đổi hành vi (§1 kế hoạch). Nếu khác biệt là CÓ CHỦ
 * ĐÍCH (vd vá lỗ hổng), nó phải nằm ở PR riêng, và PR đó ghi rõ khác biệt này.
 */

const fs = require('fs');

function load(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error(`Không đọc được ${file}: ${e.message}`); process.exit(2); }
}

const [fa, fb] = process.argv.slice(2);
if (!fa || !fb) {
  console.error('Dùng: node scripts/route-compare.js <ảnh-trước.json> <ảnh-sau.json>');
  process.exit(2);
}
const A = load(fa);
const B = load(fb);

const keys = new Set([...Object.keys(A.results), ...Object.keys(B.results)]);
const status = [], content = [], only = [];
let same = 0, volatile = 0;
for (const k of [...keys].sort()) {
  const a = A.results[k];
  const b = B.results[k];
  if (!a || !b) { only.push(`${k}: chỉ có ở ${a ? 'ảnh TRƯỚC' : 'ảnh SAU'}`); continue; }
  if (a.s !== b.s) { status.push(`${k}: ${a.s} → ${b.s}`); continue; }
  if (a.volatile || b.volatile) { volatile++; continue; }
  if (a.f !== b.f) { content.push(`${k}: ${a.s} ${a.ct} | ${a.f} → ${b.f}`); continue; }
  same++;
}

console.log(`TRƯỚC: ${A.meta && A.meta.commit ? A.meta.commit.slice(0, 7) : '?'} (${A.meta && A.meta.createdAt}) | SAU: ${B.meta && B.meta.commit ? B.meta.commit.slice(0, 7) : '?'} (${B.meta && B.meta.createdAt})`);
console.log(`so ${keys.size} yêu cầu: giống hệt ${same} | tự đổi theo thời gian (bỏ qua) ${volatile}`);
const show = (title, arr) => { console.log(`${title}: ${arr.length}`); arr.slice(0, 40).forEach((x) => console.log('  ' + x)); if (arr.length > 40) console.log(`  … và ${arr.length - 40} dòng nữa`); };
show('ĐỔI MÃ TRẠNG THÁI', status);
show('ĐỔI NỘI DUNG', content);
show('CHỈ CÓ Ở MỘT BÊN', only);

const bad = status.length + content.length + only.length;
console.log(bad === 0 ? '\nKẾT LUẬN: GIỐNG NHAU — hành vi không đổi.' : `\nKẾT LUẬN: KHÁC ${bad} chỗ — refactor đã đổi hành vi.`);
process.exit(bad === 0 ? 0 : 1);
