/**
 * Biểu mẫu báo cáo phòng ban — nghiệp vụ thuần, không biết req/res.
 *
 * Hai việc:
 *   1. chuanHoaMau(): kiểm tra + chuẩn hóa danh sách ô do NGƯỜI QUẢN LÝ module dựng.
 *   2. kiemTraDuLieu(): kiểm tra + làm sạch dữ liệu TRƯỞNG PHÒNG nhập theo một biểu mẫu.
 *
 * Vì sao tách riêng: đây là chỗ nhận dữ liệu từ người dùng rồi lưu thành JSON. Kiểm ở
 * đây (và test riêng) thì không phụ thuộc server hay cơ sở dữ liệu.
 *
 * Nguyên tắc: dữ liệu lưu chỉ gồm các khóa NẰM TRONG biểu mẫu. Khóa lạ bị bỏ chứ không
 * lưu, để client không nhét được trường tùy ý vào cột JSON.
 *
 * Các loại ô:
 *   text, textarea, number, date, select, checkbox — ô đơn.
 *   section   — tiêu đề nhóm, không nhập liệu.
 *   bang      — bảng nhiều dòng; mỗi dòng có các cột do người quản lý khai. Tùy chọn cho phép
 *               chèn "dòng nhóm" (A, B, …) để chia các dòng thành từng cụm.
 *   tong_hop  — số liệu TỰ TÍNH từ một hay nhiều bảng (tổng số việc, hoàn thành, đang làm,
 *               chưa làm). KHÔNG lưu: luôn tính lại từ chính các dòng của bảng, nên không bao
 *               giờ lệch với bảng bên trên.
 *
 * Hình dạng dữ liệu của một bảng trong du_lieu:
 *   [ { nhom: "Nhóm 1: Quản lý KHCN" }, { o: { cotA: "…", cotB: 100 } }, … ]
 * Dòng nhóm và dòng dữ liệu tách bạch bằng khóa `nhom` / `o` để một cột đặt tên "nhom" cũng
 * không bao giờ đụng vào dòng nhóm. STT (1, 2, 3…) và chữ cái nhóm (A, B…) do nơi hiển thị
 * tự đánh, không lưu.
 */

const KIEU_O = ['text', 'textarea', 'number', 'date', 'select', 'checkbox', 'section', 'bang', 'tong_hop'];
const KIEU_COT = ['text', 'textarea', 'number', 'date', 'select'];

const GIOI_HAN = {
  soO: 60,
  nhan: 200,
  troGiup: 300,
  luaChon: 30,
  luaChonDai: 100,
  text: 500,
  textarea: 10000,
  soCot: 8,
  nhanCot: 150,
  soDong: 100,
  nhanNhom: 200,
  textOCot: 500,
  textareaOCot: 5000,
};

const KHOA_HOP_LE = /^[a-z][a-z0-9_]{0,40}$/;
const NGAY_HOP_LE = /^\d{4}-\d{2}-\d{2}$/;

function chuoi(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function taoKhoa(daDung, tienTo) {
  for (let i = 0; i < 20; i++) {
    const k = (tienTo || 'o_') + Math.random().toString(36).slice(2, 8);
    if (KHOA_HOP_LE.test(k) && !daDung.has(k)) return k;
  }
  throw new Error('Không sinh được khóa duy nhất');
}

function laSoHuuHan(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function ngayThat(s) {
  if (!NGAY_HOP_LE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Phần cấu hình riêng của loại ô (danh sách lựa chọn, giới hạn số). Dùng chung cho ô đơn và cột
 * của bảng. Trả null và ghi lỗi nếu không hợp lệ.
 */
function chuanHoaRieng(nguon, kieu, ten, loi) {
  const out = {};
  if (kieu === 'select') {
    const ds = Array.isArray(nguon.lua_chon) ? nguon.lua_chon.map(chuoi).filter(Boolean) : [];
    const duy = [...new Set(ds)];
    if (duy.length < 2) {
      loi.push(`${ten}: ô chọn cần ít nhất 2 lựa chọn khác nhau.`);
      return null;
    }
    if (duy.length > GIOI_HAN.luaChon || duy.some((x) => x.length > GIOI_HAN.luaChonDai)) {
      loi.push(`${ten}: tối đa ${GIOI_HAN.luaChon} lựa chọn, mỗi lựa chọn ≤ ${GIOI_HAN.luaChonDai} ký tự.`);
      return null;
    }
    out.lua_chon = duy;
  }
  if (kieu === 'number') {
    const min = nguon.min === '' || nguon.min == null ? null : Number(nguon.min);
    const max = nguon.max === '' || nguon.max == null ? null : Number(nguon.max);
    if ((min !== null && !laSoHuuHan(min)) || (max !== null && !laSoHuuHan(max))) {
      loi.push(`${ten}: giới hạn min/max phải là số.`);
      return null;
    }
    if (min !== null && max !== null && min > max) {
      loi.push(`${ten}: min không được lớn hơn max.`);
      return null;
    }
    if (min !== null) out.min = min;
    if (max !== null) out.max = max;
  }
  return out;
}

function chuanHoaCot(c, i, tenBang, daDung, loi) {
  const ten = `${tenBang}, cột ${i + 1}`;
  if (!c || typeof c !== 'object') {
    loi.push(`${ten}: không hợp lệ.`);
    return null;
  }
  const kieu = chuoi(c.kieu);
  if (!KIEU_COT.includes(kieu)) {
    loi.push(`${ten}: loại cột "${kieu || '(trống)'}" không được hỗ trợ.`);
    return null;
  }
  const nhan = chuoi(c.nhan);
  if (!nhan) {
    loi.push(`${ten}: thiếu tiêu đề cột.`);
    return null;
  }
  if (nhan.length > GIOI_HAN.nhanCot) {
    loi.push(`${ten}: tiêu đề cột tối đa ${GIOI_HAN.nhanCot} ký tự.`);
    return null;
  }
  let key = chuoi(c.key);
  if (!key || !KHOA_HOP_LE.test(key)) {
    key = taoKhoa(daDung, 'c_');
    daDung.add(key);
  }
  const rieng = chuanHoaRieng(c, kieu, `${ten} (${nhan})`, loi);
  if (!rieng) return null;
  const out = { key, kieu, nhan, ...rieng };
  // Cột "mức độ hoàn thành (%)": nguồn số liệu cho ô tổng hợp. Chỉ cột số mới làm được.
  if (c.phan_tram === true) {
    if (kieu !== 'number') {
      loi.push(`${ten} (${nhan}): chỉ cột kiểu Số mới được dùng làm mức độ hoàn thành (%).`);
      return null;
    }
    out.phan_tram = true;
  }
  return out;
}

function chuanHoaBang(o, stt, nhan, loi) {
  const ten = `${stt} (${nhan})`;
  const nguon = Array.isArray(o.cot) ? o.cot : [];
  if (nguon.length === 0) {
    loi.push(`${ten}: bảng cần ít nhất một cột.`);
    return null;
  }
  if (nguon.length > GIOI_HAN.soCot) {
    loi.push(`${ten}: bảng tối đa ${GIOI_HAN.soCot} cột.`);
    return null;
  }
  const daDung = new Set();
  for (const c of nguon) {
    const k = c && typeof c.key === 'string' ? c.key : '';
    if (k && KHOA_HOP_LE.test(k)) {
      if (daDung.has(k)) {
        loi.push(`${ten}: khóa cột "${k}" bị trùng.`);
        return null;
      }
      daDung.add(k);
    }
  }
  const cot = [];
  for (let i = 0; i < nguon.length; i++) {
    const c = chuanHoaCot(nguon[i], i, ten, daDung, loi);
    if (!c) return null;
    cot.push(c);
  }
  if (cot.filter((c) => c.phan_tram).length > 1) {
    loi.push(`${ten}: chỉ được chọn MỘT cột làm mức độ hoàn thành (%).`);
    return null;
  }
  const out = { cot, cho_phep_nhom: o.cho_phep_nhom === true };
  if (out.cho_phep_nhom) {
    const t = chuoi(o.nhan_nhom).slice(0, 60);
    if (t) out.nhan_nhom = t;
  }
  return out;
}

/**
 * Chuẩn hóa danh sách ô của biểu mẫu.
 * @returns {{ok: boolean, truong?: object[], loi?: string[]}}
 */
function chuanHoaMau(raw) {
  const loi = [];
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, loi: ['Biểu mẫu phải có ít nhất một ô.'] };
  }
  if (raw.length > GIOI_HAN.soO) {
    return { ok: false, loi: [`Biểu mẫu tối đa ${GIOI_HAN.soO} ô.`] };
  }

  const daDung = new Set();
  // Khóa do client gửi lên (ô cũ) phải được giữ nguyên để dữ liệu của các đợt trước còn khớp.
  for (const o of raw) {
    const k = o && typeof o.key === 'string' ? o.key : '';
    if (k && KHOA_HOP_LE.test(k)) {
      if (daDung.has(k)) loi.push(`Khóa ô "${k}" bị trùng.`);
      daDung.add(k);
    }
  }
  if (loi.length) return { ok: false, loi };

  const truong = [];
  raw.forEach((o, i) => {
    const stt = `Ô ${i + 1}`;
    if (!o || typeof o !== 'object') {
      loi.push(`${stt}: không hợp lệ.`);
      return;
    }
    const kieu = chuoi(o.kieu);
    if (!KIEU_O.includes(kieu)) {
      loi.push(`${stt}: loại ô "${kieu || '(trống)'}" không được hỗ trợ.`);
      return;
    }
    const nhan = chuoi(o.nhan);
    if (!nhan) {
      loi.push(`${stt}: thiếu nhãn.`);
      return;
    }
    if (nhan.length > GIOI_HAN.nhan) {
      loi.push(`${stt}: nhãn tối đa ${GIOI_HAN.nhan} ký tự.`);
      return;
    }

    let key = chuoi(o.key);
    if (!key || !KHOA_HOP_LE.test(key)) {
      key = taoKhoa(daDung);
      daDung.add(key);
    }

    const out = { key, kieu, nhan };
    const troGiup = chuoi(o.tro_giup);
    if (troGiup.length > GIOI_HAN.troGiup) {
      loi.push(`${stt}: gợi ý tối đa ${GIOI_HAN.troGiup} ký tự.`);
      return;
    }

    if (kieu === 'section' || kieu === 'tong_hop') {
      // Không nhập liệu: không có bắt buộc / lựa chọn / giới hạn.
      if (troGiup) out.tro_giup = troGiup;
      if (kieu === 'tong_hop') out.bang = Array.isArray(o.bang) ? [...new Set(o.bang.map(chuoi).filter(Boolean))] : [];
      truong.push(out);
      return;
    }

    out.bat_buoc = o.bat_buoc === true;
    if (troGiup) out.tro_giup = troGiup;

    if (kieu === 'bang') {
      const b = chuanHoaBang(o, stt, nhan, loi);
      if (!b) return;
      Object.assign(out, b);
      truong.push(out);
      return;
    }

    const rieng = chuanHoaRieng(o, kieu, `${stt} (${nhan})`, loi);
    if (!rieng) return;
    Object.assign(out, rieng);
    truong.push(out);
  });

  if (loi.length) return { ok: false, loi };

  // Ô tổng hợp phải trỏ tới bảng CÓ THẬT và bảng đó phải có cột "mức độ hoàn thành (%)".
  for (const o of truong) {
    if (o.kieu !== 'tong_hop') continue;
    if (o.bang.length === 0) {
      loi.push(`Ô tổng hợp "${o.nhan}": cần chọn ít nhất một bảng để thống kê.`);
      continue;
    }
    for (const bk of o.bang) {
      const b = truong.find((x) => x.key === bk && x.kieu === 'bang');
      if (!b) loi.push(`Ô tổng hợp "${o.nhan}": không tìm thấy bảng "${bk}".`);
      else if (!b.cot.some((c) => c.phan_tram)) {
        loi.push(`Ô tổng hợp "${o.nhan}": bảng "${b.nhan}" chưa có cột nào được chọn làm mức độ hoàn thành (%).`);
      }
    }
  }
  if (loi.length) return { ok: false, loi };

  if (!truong.some((o) => o.kieu !== 'section' && o.kieu !== 'tong_hop')) {
    return { ok: false, loi: ['Biểu mẫu cần ít nhất một ô nhập liệu (không chỉ tiêu đề nhóm).'] };
  }
  return { ok: true, truong };
}

/**
 * Kiểm một giá trị đơn (ô đơn hoặc ô trong bảng).
 * @returns {{trong?: true, loi?: string, gia_tri?: any}}
 */
function kiemTraGiaTri(def, v, laCot) {
  const trong = v === undefined || v === null || v === '' || (typeof v === 'string' && !v.trim());
  if (trong) return { trong: true };
  switch (def.kieu) {
    case 'text':
    case 'textarea': {
      if (typeof v !== 'string') return { loi: 'Giá trị phải là văn bản.' };
      const t = v.trim();
      const tran = def.kieu === 'text'
        ? (laCot ? GIOI_HAN.textOCot : GIOI_HAN.text)
        : (laCot ? GIOI_HAN.textareaOCot : GIOI_HAN.textarea);
      return t.length > tran ? { loi: `Tối đa ${tran} ký tự.` } : { gia_tri: t };
    }
    case 'number': {
      // Chấp nhận số hoặc chuỗi số; từ chối "", "abc", NaN, Infinity.
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!laSoHuuHan(n)) return { loi: 'Phải là một số.' };
      if (def.min !== undefined && n < def.min) return { loi: `Không được nhỏ hơn ${def.min}.` };
      if (def.max !== undefined && n > def.max) return { loi: `Không được lớn hơn ${def.max}.` };
      return { gia_tri: n };
    }
    case 'date':
      return typeof v !== 'string' || !ngayThat(v) ? { loi: 'Ngày không hợp lệ (định dạng AAAA-MM-DD).' } : { gia_tri: v };
    case 'select':
      return typeof v !== 'string' || !def.lua_chon.includes(v) ? { loi: 'Chọn một giá trị trong danh sách.' } : { gia_tri: v };
    default:
      return { loi: 'Loại ô không hỗ trợ.' };
  }
}

/** Kiểm + làm sạch một bảng. Trả {trong} / {loi} / {gia_tri: [...]}. */
function kiemTraBang(o, v, nop) {
  if (v === undefined || v === null) return nop && o.bat_buoc ? { loi: 'Cần nhập ít nhất một dòng.' } : { trong: true };
  if (!Array.isArray(v)) return { loi: 'Dữ liệu bảng không hợp lệ.' };
  if (v.length > GIOI_HAN.soDong) return { loi: `Bảng tối đa ${GIOI_HAN.soDong} dòng.` };

  const hang = [];
  let soDong = 0;
  for (let i = 0; i < v.length; i++) {
    const r = v[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) return { loi: `Dòng thứ ${i + 1} trong bảng không hợp lệ.` };

    if (r.o === undefined && typeof r.nhom === 'string') {
      if (!o.cho_phep_nhom) return { loi: 'Bảng này không cho phép chia nhóm.' };
      const t = r.nhom.trim();
      if (t.length > GIOI_HAN.nhanNhom) return { loi: `Tên nhóm tối đa ${GIOI_HAN.nhanNhom} ký tự.` };
      if (t) hang.push({ nhom: t }); // nhóm để trống thì bỏ
      continue;
    }

    if (!r.o || typeof r.o !== 'object' || Array.isArray(r.o)) return { loi: `Dòng thứ ${i + 1} trong bảng không hợp lệ.` };
    const cells = {};
    for (const c of o.cot) {
      const kq = kiemTraGiaTri(c, r.o[c.key], true);
      if (kq.loi) return { loi: `Dòng ${soDong + 1}, cột "${c.nhan}": ${kq.loi}` };
      if (!kq.trong) cells[c.key] = kq.gia_tri;
    }
    if (Object.keys(cells).length === 0) continue; // dòng trống hoàn toàn thì bỏ
    soDong++;
    hang.push({ o: cells });
  }

  if (soDong === 0 && !hang.length) return nop && o.bat_buoc ? { loi: 'Cần nhập ít nhất một dòng.' } : { trong: true };
  if (soDong === 0 && nop && o.bat_buoc) return { loi: 'Cần nhập ít nhất một dòng (không chỉ tên nhóm).' };
  return { gia_tri: hang };
}

/**
 * Kiểm tra + làm sạch dữ liệu nhập theo biểu mẫu.
 * @param {object[]} truong  danh sách ô đã chuẩn hóa
 * @param {object}   duLieu  dữ liệu thô từ client
 * @param {{nop?: boolean}} tuyChon  nop=true: bắt buộc đủ các ô "bắt buộc"
 * @returns {{ok: boolean, du_lieu: object, loi: Object<string,string>}}
 */
function kiemTraDuLieu(truong, duLieu, tuyChon = {}) {
  const nguon = duLieu && typeof duLieu === 'object' && !Array.isArray(duLieu) ? duLieu : {};
  const sach = {};
  const loi = {};

  for (const o of truong) {
    if (o.kieu === 'section' || o.kieu === 'tong_hop') continue;
    const v = nguon[o.key];

    if (o.kieu === 'checkbox') {
      if (v !== undefined && v !== null && typeof v !== 'boolean') {
        loi[o.key] = 'Giá trị ô đánh dấu phải là đúng/sai.';
        continue;
      }
      if (v === true) sach[o.key] = true;
      else if (tuyChon.nop && o.bat_buoc) loi[o.key] = 'Cần đánh dấu ô này.';
      continue;
    }

    if (o.kieu === 'bang') {
      const kq = kiemTraBang(o, v, !!tuyChon.nop);
      if (kq.loi) loi[o.key] = kq.loi;
      else if (!kq.trong) sach[o.key] = kq.gia_tri;
      continue;
    }

    const kq = kiemTraGiaTri(o, v, false);
    if (kq.loi) loi[o.key] = kq.loi;
    else if (kq.trong) {
      if (tuyChon.nop && o.bat_buoc) loi[o.key] = 'Ô này là bắt buộc.';
    } else sach[o.key] = kq.gia_tri;
  }

  return { ok: Object.keys(loi).length === 0, du_lieu: sach, loi };
}

/**
 * Số liệu cho ô tổng hợp: đếm các DÒNG DỮ LIỆU của các bảng được chọn, phân loại theo cột
 * "mức độ hoàn thành (%)" của từng bảng.
 *   hoàn thành      : ≥ 100
 *   đang thực hiện  : > 0 và < 100
 *   chưa thực hiện  : 0 hoặc để trống   <- dòng chưa ghi % được tính vào đây
 * Tỷ lệ làm tròn tới số nguyên, theo đúng cách mẫu Word hiện dùng.
 *
 * Giao diện (public/js/baoCaoPhong.js) có một bản sao thuật toán này để hiện số liệu ngay khi
 * đang gõ. Hai nơi PHẢI khớp nhau — sửa cái này thì sửa cả bên kia.
 */
function tinhTongHop(truong, duLieu, def) {
  let tong = 0;
  let xong = 0;
  let dang = 0;
  let chua = 0;
  for (const bk of def.bang || []) {
    const b = truong.find((o) => o.key === bk && o.kieu === 'bang');
    if (!b) continue;
    const cot = b.cot.find((c) => c.phan_tram);
    const hang = Array.isArray(duLieu && duLieu[bk]) ? duLieu[bk] : [];
    for (const r of hang) {
      if (!r || !r.o) continue;
      tong++;
      const p = cot ? r.o[cot.key] : undefined;
      if (typeof p === 'number' && p >= 100) xong++;
      else if (typeof p === 'number' && p > 0) dang++;
      else chua++;
    }
  }
  const ty = (x) => (tong ? Math.round((x * 100) / tong) : 0);
  return {
    tong,
    hoan_thanh: xong,
    dang_thuc_hien: dang,
    chua_thuc_hien: chua,
    ty_le: { hoan_thanh: ty(xong), dang_thuc_hien: ty(dang), chua_thuc_hien: ty(chua) },
  };
}

module.exports = { KIEU_O, KIEU_COT, GIOI_HAN, chuanHoaMau, kiemTraDuLieu, tinhTongHop };
