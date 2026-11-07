/**
 * Chữ ký số PDF theo PAdES (CMS tách rời, SubFilter ETSI.CAdES.detached) — dùng cho ký từ xa kiểu MySign:
 * dịch vụ chỉ ký MÃ BĂM, phần dựng chữ ký trong PDF do hệ thống tự làm. Không dùng thư viện ngoài.
 *
 * Ba bước, có thể cách nhau vài phút (người ký xác nhận trên điện thoại):
 *   1. datChoKy(doc, ...)   — lúc dựng PDF bằng pdfkit: chừa chỗ chữ ký (từ điển /Sig + ô chữ ký) trước doc.end().
 *   2. chuanBi(pdf)         — điền /ByteRange, lấy phần nội dung được ký; thuocTinhKy() tạo các thuộc tính ký (signedAttrs)
 *                             mà mã băm SHA-256 của chúng là thứ gửi sang dịch vụ ký.
 *   3. chenChuKy(...)       — dịch vụ trả chữ ký RSA → dongGoiCms() → ghi vào chỗ đã chừa.
 * kiemTra(pdf) kiểm lại một PDF đã ký (mã băm nội dung + chữ ký trên thuộc tính ký bằng khóa công khai của chứng thư).
 */

const crypto = require('crypto');
const D = require('./der');

const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  sha256: '2.16.840.1.101.3.4.2.1',
  rsa: '1.2.840.113549.1.1.1',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
};

const BYTE_RANGE_MAU = '/ByteRange [0 9999999999 9999999999 9999999999]';
/** Byte dành cho chữ ký CMS (chữ ký RSA + chuỗi 3 chứng thư thường dưới 8 KB). */
const DO_DAI_CHU_KY = 16384;

const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

/**
 * Chừa chỗ chữ ký trên TRANG HIỆN TẠI của tài liệu pdfkit (gọi trước doc.end()).
 * @param {object} doc pdfkit
 * @param {{rect:number[], ten:string, lyDo?:string, noiKy?:string, luc?:Date}} p  rect = [x, y, rộng, cao] theo tọa độ pdfkit (gốc trên-trái)
 */
function datChoKy(doc, { rect, ten, lyDo, noiKy, luc }) {
  const [x, y, w, h] = rect;
  const H = doc.page.height;
  const sig = doc.ref({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'ETSI.CAdES.detached',
    ByteRange: [0, 9999999999, 9999999999, 9999999999],
    Contents: Buffer.alloc(DO_DAI_CHU_KY),
    Name: new String(ten || ''),
    Reason: new String(lyDo || ''),
    Location: new String(noiKy || ''),
    M: luc || new Date(),
    // CHỨNG NHẬN tài liệu (DocMDP, mức P = 2): chỉ cho điền biểu mẫu và ký thêm. Thêm chú thích, sửa nội dung, thêm trang… sau khi ký
    // đều bị trình đọc PDF (Adobe Reader…) cảnh báo là vi phạm chứng nhận. Mức 2 (không phải 1) để sau này người ký thứ hai vẫn ký được.
    Reference: [{ Type: 'SigRef', TransformMethod: 'DocMDP', TransformParams: { Type: 'TransformParams', P: 2, V: '1.2' } }],
  });
  sig.end();
  // Từ điển Perms của Catalog trỏ tới chữ ký chứng nhận (bắt buộc để trình đọc PDF coi đây là chữ ký chứng nhận).
  doc._root.data.Perms = { DocMDP: sig };
  const oKy = doc.ref({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    Rect: [x, H - y - h, x + w, H - y],
    V: sig,
    T: new String('ChuKySo1'),
    F: 4,
    P: doc.page.dictionary,
  });
  oKy.end();
  doc.page.annotations.push(oKy);
  // AcroForm do pdfkit quản lý (initForm/endAcroForm lúc doc.end()); chỉ thêm ô chữ ký vào đó.
  if (!doc._root.data.AcroForm) doc.initForm();
  const form = doc._root.data.AcroForm.data;
  form.Fields.push(oKy);
  form.SigFlags = 3;
  delete form.NeedAppearances;
}

/** Vị trí chuỗi hex /Contents <...> của chữ ký (tính cả hai dấu < >). */
function viTriContents(pdf) {
  const i = pdf.indexOf('/Contents <' + '0'.repeat(32), 0, 'latin1');
  if (i < 0) throw new Error('PDF chưa có chỗ chừa cho chữ ký.');
  const dau = pdf.indexOf('<', i, 'latin1');
  const cuoi = pdf.indexOf('>', dau, 'latin1') + 1;
  return { dau, cuoi };
}

/**
 * Điền /ByteRange thật vào PDF đã chừa chỗ. Trả {pdf, noiDung}: noiDung là mọi byte của tệp trừ chuỗi chữ ký — thứ được băm.
 */
function chuanBi(pdfCho) {
  const pdf = Buffer.from(pdfCho);
  const i = pdf.indexOf(BYTE_RANGE_MAU, 0, 'latin1');
  if (i < 0) throw new Error('PDF chưa có /ByteRange để điền.');
  const { dau, cuoi } = viTriContents(pdf);
  const br = `/ByteRange [0 ${dau} ${cuoi} ${pdf.length - cuoi}]`;
  if (br.length > BYTE_RANGE_MAU.length) throw new Error('Tệp PDF quá lớn để ký.');
  pdf.write(br.padEnd(BYTE_RANGE_MAU.length, ' '), i, 'latin1');
  return { pdf, noiDung: Buffer.concat([pdf.subarray(0, dau), pdf.subarray(cuoi)]) };
}

const thuocTinh = (o, giaTri) => D.seq(D.oid(o), D.set(giaTri));

/**
 * Thuộc tính ký (SET DER, thẻ 0x31) cho PAdES-B-B: loại nội dung, mã băm nội dung, và chứng thư người ký (signingCertificateV2).
 * Mã băm SHA-256 của chính khối này là thứ dịch vụ ký từ xa ký.
 */
function thuocTinhKy({ noiDung, chungThu }) {
  return D.set(
    thuocTinh(OID.contentType, D.oid(OID.data)),
    thuocTinh(OID.messageDigest, D.octet(sha256(noiDung))),
    thuocTinh(OID.signingCertificateV2, D.seq(D.seq(D.seq(D.octet(sha256(chungThu))))))
  );
}

/**
 * CMS SignedData tách rời.
 * @param {{thuocTinh:Buffer, chuKy:Buffer, chuoi:Buffer[]}} p chuoi[0] là chứng thư người ký, sau đó tới các CA.
 */
function dongGoiCms({ thuocTinh: tt, chuKy, chuoi }) {
  const { issuer, serial } = D.docChungThu(chuoi[0]);
  const algSha = D.seq(D.oid(OID.sha256), D.nul());
  // Trong SignerInfo, signedAttrs là [0] IMPLICIT: cùng nội dung, chỉ đổi thẻ SET (0x31) thành 0xA0.
  const ttNgam = Buffer.concat([Buffer.from([0xa0]), tt.subarray(1)]);
  const signerInfo = D.seq(D.int(1), D.seq(issuer, serial), algSha, ttNgam, D.seq(D.oid(OID.rsa), D.nul()), D.octet(chuKy));
  const signedData = D.seq(
    D.int(1),
    D.set(algSha),
    D.seq(D.oid(OID.data)),
    D.tlv(0xa0, [...chuoi].sort(Buffer.compare)),
    D.set(signerInfo)
  );
  return D.seq(D.oid(OID.signedData), D.nguCanh(0, signedData));
}

/** Ghi CMS vào chỗ đã chừa của PDF (đã qua chuanBi). */
function chenChuKy(pdfDaChuanBi, cms) {
  const pdf = Buffer.from(pdfDaChuanBi);
  const { dau, cuoi } = viTriContents(pdf);
  const hex = cms.toString('hex');
  if (hex.length > cuoi - dau - 2) throw new Error('Chữ ký lớn hơn chỗ đã chừa trong PDF.');
  pdf.write(hex, dau + 1, 'latin1');
  return pdf;
}

/** Kiểm chữ ký RSA trên thuộc tính ký bằng chứng thư. Dùng ngay khi nhận chữ ký từ dịch vụ, trước khi ghi vào PDF. */
function chuKyKhop({ thuocTinh: tt, chuKy, chungThu }) {
  const cert = new crypto.X509Certificate(chungThu);
  return crypto.verify('sha256', tt, cert.publicKey, chuKy);
}

/**
 * Kiểm một PDF đã ký (chữ ký cuối cùng trong tệp).
 * @returns {{hopLe:boolean, ly_do?:string, chu_the?:string, so_seri?:string}}
 */
function kiemTra(pdf) {
  try {
    return kiemTraCms(pdf);
  } catch (e) {
    return { hopLe: false, ly_do: 'Chữ ký số trong tệp bị hỏng.' };
  }
}

function kiemTraCms(pdf) {
  const s = pdf.toString('latin1');
  const m = [...s.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)].pop();
  if (!m) return { hopLe: false, ly_do: 'Không có chữ ký số.' };
  const [a, b, c, d] = m.slice(1).map(Number);
  if (a !== 0 || c + d !== pdf.length) return { hopLe: false, ly_do: 'Chữ ký không phủ toàn bộ tệp.' };
  const hex = s.slice(b + 1, c - 1);
  const cms = Buffer.from(hex, 'hex');
  const ci = D.doc(cms);
  const sd = D.con(D.con(ci)[1])[0];
  const phan = D.con(sd);
  const certs = D.con(phan.find((x) => x.tag === 0xa0)).map((x) => Buffer.from(x.tho));
  const si = D.con(D.con(phan[phan.length - 1])[0]);
  const ttNgam = si.find((x) => x.tag === 0xa0);
  const tt = Buffer.concat([Buffer.from([0x31]), ttNgam.tho.subarray(1)]);
  const chuKy = si[si.length - 1].noiDung;
  const serial = si[1] && D.con(si[1])[1].tho;
  const chungThu = certs.find((x) => D.docChungThu(x).serial.equals(serial)) || certs[0];

  let digest = null;
  for (const at of D.con(ttNgam)) {
    const [o, v] = D.con(at);
    if (D.docOid(o) === OID.messageDigest) digest = D.con(v)[0].noiDung;
  }
  const noiDung = Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]);
  if (!digest || !sha256(noiDung).equals(digest)) return { hopLe: false, ly_do: 'Nội dung tệp đã bị thay đổi sau khi ký.' };
  if (!chuKyKhop({ thuocTinh: tt, chuKy, chungThu })) return { hopLe: false, ly_do: 'Chữ ký không khớp với chứng thư số.' };
  const cert = new crypto.X509Certificate(chungThu);
  return { hopLe: true, chu_the: cert.subject, so_seri: cert.serialNumber };
}

module.exports = { datChoKy, chuanBi, thuocTinhKy, dongGoiCms, chenChuKy, chuKyKhop, kiemTra, sha256, DO_DAI_CHU_KY };
