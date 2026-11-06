/**
 * Kiểm vị trí khung chữ ký số do trình duyệt gửi lên (dùng chung cho mọi nơi ký số).
 * {trang, x, y, w, h}: trang tính từ 0; x, y, w, h là TỈ LỆ (0..1) so với khổ trang, gốc ở góc trên-trái.
 * Trang có thật hay không do nơi dựng PDF kiểm (chỉ lúc đó mới biết số trang).
 */

const RONG_TOI_THIEU = 0.1; // khung nhỏ hơn 10% bề ngang / 4% chiều cao trang thì không đọc được chữ (khớp public/js/kysoViTri.js)
const CAO_TOI_THIEU = 0.04;

/** @returns {{vi_tri:{trang:number,x:number,y:number,w:number,h:number}}|{loi:string}} */
function kiemViTri(v) {
  if (!v || typeof v !== 'object') return { loi: 'Vị trí khung chữ ký không hợp lệ.' };
  const { trang, x, y, w, h } = v;
  const so = (n) => typeof n === 'number' && Number.isFinite(n);
  if (!Number.isInteger(trang) || trang < 0 || trang > 500 || ![x, y, w, h].every(so)) return { loi: 'Vị trí khung chữ ký không hợp lệ.' };
  if (w < RONG_TOI_THIEU || h < CAO_TOI_THIEU) return { loi: 'Khung chữ ký quá nhỏ, hãy kéo rộng hơn.' };
  if (x < 0 || y < 0 || x + w > 1.0001 || y + h > 1.0001) return { loi: 'Khung chữ ký nằm ngoài trang.' };
  return { vi_tri: { trang, x, y, w, h } };
}

module.exports = { kiemViTri, RONG_TOI_THIEU, CAO_TOI_THIEU };
