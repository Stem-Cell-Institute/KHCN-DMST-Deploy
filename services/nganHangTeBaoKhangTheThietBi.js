'use strict';

/**
 * Ngân hàng Tế bào & Kháng thể — danh mục MẪU THIẾT BỊ lưu trữ / nuôi cấy (bình nitơ lỏng, tủ âm sâu, tủ âm nằm ngang, tủ lạnh 2 ngăn, tủ ấm CO₂...).
 * Hàm thuần, không đụng DB. Chọn một mẫu khi thêm thiết bị thì máy chủ tạo thiết bị gốc kèm các NGĂN (khoang) theo mẫu; người dùng thêm Rack / giá / giỏ và hộp
 * vào sau. `kieu` quyết định cách vẽ sơ đồ (public/ngan-hang-te-bao-khang-the/thiet-bi.js; bình nitơ lỏng dùng binh-ln.js):
 *   binh_ln  bình nitơ lỏng — Rack đứng quanh cổ bình (không có ngăn)
 *   tu_dung  tủ đứng: các ngăn xếp từ trên xuống, mỗi ngăn có các kệ / ngăn kéo nằm ngang
 *   tu_nam   tủ nằm ngang (nắp mở lên): các cánh xếp cạnh nhau, mỗi cánh có các giỏ
 *   tu_lanh  tủ lạnh nhiều ngăn: ngăn đá trên, ngăn mát dưới, mỗi ngăn có kệ
 * `hang` chỉ là gợi ý dòng máy tham khảo; số ngăn / kệ thực tế khác nhau tùy model, sửa bằng cách thêm hoặc xóa Rack, giỏ sau khi tạo.
 */

const NHOM = {
  binh: 'Bình nitơ lỏng',
  am_sau: 'Tủ âm sâu (-80 / -86 / -150°C)',
  am: 'Tủ âm (-20°C)',
  lanh: 'Tủ lạnh, tủ mát (2–8°C)',
  nuoi: 'Tủ ấm nuôi cấy',
};

// khoang: [{ ten, nhiet_do (null = theo thiết bị), so_ke (số kệ / giỏ / ngăn kéo vẽ sẵn trên sơ đồ), loai_ke }]
const MAU_THIET_BI = [
  { ma: 'binh-ln', nhom: 'binh', ten: 'Bình nitơ lỏng (nhiều Rack)', hang: 'Thermo, Taylor-Wharton, Cryoplus, MVE', kieu: 'binh_ln', loai_goc: 'Bình nitơ lỏng', nhiet_do: -196, khoang: [],
    mo_ta: 'Rack đứng quanh cổ bình, hộp xếp từ trên xuống trong Rack. Thêm Rack rồi thêm hộp vào Rack.' },
  { ma: 'tu-86-dung-2-ngan', nhom: 'am_sau', ten: 'Tủ âm sâu -86°C đứng, 2 ngăn', hang: 'Panasonic (dòng 2 ngăn)', kieu: 'tu_dung', loai_goc: 'Tủ âm sâu -86°C', nhiet_do: -86,
    khoang: [{ ten: 'Ngăn trên', nhiet_do: null, so_ke: 3, loai_ke: 'Rack' }, { ten: 'Ngăn dưới', nhiet_do: null, so_ke: 3, loai_ke: 'Rack' }],
    mo_ta: 'Hai ngăn độc lập xếp trên dưới, mỗi ngăn có các Rack nằm ngang. Thêm Rack vào từng ngăn rồi thêm hộp vào Rack.' },
  { ma: 'tu-86-dung-1-ngan', nhom: 'am_sau', ten: 'Tủ âm sâu -86°C đứng, 1 ngăn (nhiều Rack)', hang: 'Thermo, PHCbi, Haier, Eppendorf, Binder', kieu: 'tu_dung', loai_goc: 'Tủ âm sâu -86°C', nhiet_do: -86,
    khoang: [{ ten: 'Ngăn chính', nhiet_do: null, so_ke: 5, loai_ke: 'Rack' }], mo_ta: 'Một ngăn lớn có các Rack nằm ngang xếp từ trên xuống.' },
  { ma: 'tu-86-nam', nhom: 'am_sau', ten: 'Tủ âm sâu -86°C nằm ngang (nắp mở lên)', hang: 'Thermo, Haier, Eppendorf', kieu: 'tu_nam', loai_goc: 'Tủ âm sâu -86°C', nhiet_do: -86,
    khoang: [{ ten: 'Khoang chính', nhiet_do: null, so_ke: 4, loai_ke: 'Giỏ' }], mo_ta: 'Một khoang mở nắp lên, các giỏ đứng cạnh nhau.' },
  { ma: 'tu-150-dung', nhom: 'am_sau', ten: 'Tủ âm siêu sâu -150°C', hang: 'PHCbi, Sanyo', kieu: 'tu_dung', loai_goc: 'Tủ -150°C', nhiet_do: -150,
    khoang: [{ ten: 'Ngăn chính', nhiet_do: null, so_ke: 4, loai_ke: 'Rack' }], mo_ta: 'Một ngăn, các Rack nằm ngang.' },
  { ma: 'tu-20-nam-2-canh', nhom: 'am', ten: 'Tủ âm -20°C nằm ngang, 2 cánh', hang: 'Sanaky, Alaska, Hòa Phát, Sumikura', kieu: 'tu_nam', loai_goc: 'Tủ -20°C nằm ngang', nhiet_do: -20,
    khoang: [{ ten: 'Cánh trái', nhiet_do: null, so_ke: 3, loai_ke: 'Giỏ' }, { ten: 'Cánh phải', nhiet_do: null, so_ke: 3, loai_ke: 'Giỏ' }],
    mo_ta: 'Hai cánh (nắp) mở lên riêng, mỗi cánh có các giỏ. Thêm giỏ vào từng cánh rồi thêm hộp vào giỏ.' },
  { ma: 'tu-20-dung', nhom: 'am', ten: 'Tủ âm -20°C đứng (ngăn kéo)', hang: 'Thermo, Liebherr, Haier', kieu: 'tu_dung', loai_goc: 'Tủ -20°C', nhiet_do: -20,
    khoang: [{ ten: 'Ngăn chính', nhiet_do: null, so_ke: 4, loai_ke: 'Ngăn kéo' }], mo_ta: 'Một cánh, các ngăn kéo xếp từ trên xuống.' },
  { ma: 'tu-lanh-20-4', nhom: 'lanh', ten: 'Tủ lạnh 2 ngăn: trên -20°C, dưới 4°C', hang: 'Panasonic, Toshiba, Sharp, Electrolux', kieu: 'tu_lanh', loai_goc: 'Tủ lạnh 2 ngăn (-20°C / 4°C)', nhiet_do: null,
    khoang: [{ ten: 'Ngăn đá trên (-20°C)', nhiet_do: -20, so_ke: 2, loai_ke: 'Kệ' }, { ten: 'Ngăn mát dưới (4°C)', nhiet_do: 4, so_ke: 3, loai_ke: 'Kệ' }],
    mo_ta: 'Ngăn đá phía trên (-20°C) và ngăn mát phía dưới (4°C), mỗi ngăn có các kệ.' },
  { ma: 'tu-lanh-4-dung', nhom: 'lanh', ten: 'Tủ lạnh / tủ mát 4°C đứng', hang: 'Thermo, Liebherr, Sanyo, Alaska', kieu: 'tu_dung', loai_goc: 'Tủ lạnh 4°C', nhiet_do: 4,
    khoang: [{ ten: 'Ngăn chính', nhiet_do: null, so_ke: 4, loai_ke: 'Kệ' }], mo_ta: 'Một ngăn có các kệ.' },
  { ma: 'tu-am-co2', nhom: 'nuoi', ten: 'Tủ ấm CO₂ (nuôi cấy tế bào)', hang: 'Thermo, Eppendorf, Binder, ESCO', kieu: 'tu_dung', loai_goc: 'Tủ ấm CO₂', nhiet_do: 37,
    khoang: [{ ten: 'Khoang nuôi', nhiet_do: null, so_ke: 4, loai_ke: 'Kệ' }], mo_ta: 'Khoang nuôi 37°C có các kệ đặt đĩa, bình nuôi.' },
];

const THEO_MA = new Map(MAU_THIET_BI.map((m) => [m.ma, m]));

/** Mẫu theo mã; null nếu không có. */
function layMau(ma) {
  return typeof ma === 'string' ? THEO_MA.get(ma) || null : null;
}

/** Loại vật chứa cần có cho một mẫu: [{ten, nhiet_do}] gồm loại thiết bị gốc, «Ngăn» (khoang) và loại kệ của từng khoang. */
function loaiCanCo(mau) {
  const ds = [{ ten: mau.loai_goc, nhiet_do: mau.nhiet_do }];
  if (mau.khoang.length) ds.push({ ten: 'Ngăn', nhiet_do: null });
  for (const k of mau.khoang) if (!ds.some((x) => x.ten === k.loai_ke)) ds.push({ ten: k.loai_ke, nhiet_do: null });
  return ds;
}

module.exports = { NHOM, MAU_THIET_BI, layMau, loaiCanCo };
