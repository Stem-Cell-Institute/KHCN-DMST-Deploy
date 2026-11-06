/**
 * Mã hóa / đọc ASN.1 DER tối thiểu — đủ cho chữ ký PDF (CMS SignedData) và đọc chứng thư số X.509.
 * Không dùng thư viện ngoài: chỉ vài kiểu dữ liệu cần thiết, mỗi hàm trả về Buffer DER hoàn chỉnh (tag + độ dài + nội dung).
 */

function doDai(n) {
  if (n < 0x80) return Buffer.from([n]);
  const b = [];
  while (n > 0) {
    b.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from([0x80 | b.length, ...b]);
}

function tlv(tag, noiDung) {
  const nd = Buffer.isBuffer(noiDung) ? noiDung : Buffer.concat(noiDung);
  return Buffer.concat([Buffer.from([tag]), doDai(nd.length), nd]);
}

const seq = (...ds) => tlv(0x30, ds);
/** SET OF theo DER: các phần tử phải xếp tăng dần theo mã hóa. */
const set = (...ds) => tlv(0x31, [...ds].sort(Buffer.compare));
const octet = (b) => tlv(0x04, b);
const nul = () => Buffer.from([0x05, 0x00]);
const utf8 = (s) => tlv(0x0c, Buffer.from(String(s), 'utf8'));
/** [n] tường minh (bọc nguyên phần tử bên trong). */
const nguCanh = (n, ...ds) => tlv(0xa0 | n, ds);

function int(v) {
  let b;
  if (Buffer.isBuffer(v)) b = v;
  else {
    let h = BigInt(v).toString(16);
    if (h.length % 2) h = '0' + h;
    b = Buffer.from(h, 'hex');
  }
  // INTEGER dương: thêm 0x00 nếu bit cao bật; bỏ các byte 0 thừa ở đầu.
  let i = 0;
  while (i < b.length - 1 && b[i] === 0 && !(b[i + 1] & 0x80)) i++;
  b = b.subarray(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function oid(s) {
  const p = s.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (const n of p.slice(2)) {
    const nhom = [n & 0x7f];
    let x = Math.floor(n / 128);
    while (x > 0) {
      nhom.unshift((x & 0x7f) | 0x80);
      x = Math.floor(x / 128);
    }
    out.push(...nhom);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime (năm 1950–2049) theo giờ UTC, dạng YYMMDDHHMMSSZ. */
function utcTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  const s = p(d.getUTCFullYear() % 100) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

/**
 * Đọc MỘT phần tử tại vị trí `o`. Trả {tag, dau, cuoi, noiDung, tho}: `tho` là cả phần tử (để chép nguyên văn).
 */
function doc(buf, o = 0) {
  if (o + 2 > buf.length) throw new Error('DER: hết dữ liệu');
  const tag = buf[o];
  let len = buf[o + 1];
  let dau = o + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('DER: độ dài không hỗ trợ');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[dau + i];
    dau += n;
  }
  const cuoi = dau + len;
  if (cuoi > buf.length) throw new Error('DER: độ dài vượt dữ liệu');
  return { tag, dau, cuoi, noiDung: buf.subarray(dau, cuoi), tho: buf.subarray(o, cuoi) };
}

/** Các phần tử con của một phần tử cấu trúc (SEQUENCE, SET, [n]...). */
function con(phanTu) {
  const out = [];
  let o = 0;
  const b = phanTu.noiDung;
  while (o < b.length) {
    const p = doc(b, o);
    out.push(p);
    o = p.cuoi;
  }
  return out;
}

/** OID dạng chuỗi từ phần tử OBJECT IDENTIFIER. */
function docOid(phanTu) {
  const b = phanTu.noiDung;
  const out = [Math.floor(b[0] / 40), b[0] % 40];
  let n = 0;
  for (let i = 1; i < b.length; i++) {
    n = n * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) {
      out.push(n);
      n = 0;
    }
  }
  return out.join('.');
}

/**
 * Lấy từ chứng thư X.509 (DER) những gì CMS cần: tên đơn vị cấp (issuer, nguyên văn DER) và số sê-ri (INTEGER, nguyên văn DER).
 */
function docChungThu(der) {
  const cert = doc(der);
  const tbs = con(cert)[0];
  const ds = con(tbs);
  const k = ds[0].tag === 0xa0 ? 1 : 0; // [0] version là tùy chọn
  return { serial: ds[k].tho, issuer: ds[k + 2].tho };
}

module.exports = { tlv, seq, set, octet, nul, utf8, nguCanh, int, oid, utcTime, doc, con, docOid, docChungThu };
