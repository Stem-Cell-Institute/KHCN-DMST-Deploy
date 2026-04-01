# HƯỚNG DẪN CẤU TRÚC VÀ LIÊN KẾT WEBSITE

## 📁 CẤU TRÚC THỦ MỤC ĐÚNG

Khi upload lên hosting, bạn cần tổ chức như sau:

```
your-website/
│
├── index.html              ← Trang chủ
├── nhom-1.html            ← Trang Nhóm 1
├── nhom-2.html            ← Trang Nhóm 2
├── nhom-3.html            ← Trang Nhóm 3
├── huong-dan.html         ← Trang Hướng dẫn
├── styles.css             ← File CSS
├── README.md              ← Hướng dẫn
│
└── files/                 ← Thư mục chứa file tải về
    ├── 00_MUC_LUC_HE_THONG.docx
    ├── HUONG_DAN_TONG_HOP_HO_SO.docx
    ├── NHOM_1_1_Huong_dan_van_tat_thao_tac_dong_vat.docx
    ├── NHOM_1_2_Quy_che_to_chuc_va_hoat_dong_HDDD.docx
    ├── NHOM_2_1_Don_de_nghi_xet_duyet_SCI-ACE-01.docx
    ├── NHOM_2_2_Phieu_thuyet_minh_de_tai_SCI-ACE-02.docx
    ├── NHOM_2_3_Bao_cao_tuan_thu_3R_SCI-ACE-03.docx
    ├── NHOM_2_4_Bao_cao_giai_trinh_SCI-ACE-04.docx
    ├── NHOM_2_5_Bao_cao_thay_doi_ke_hoach_SCI-ACE-06.docx
    ├── NHOM_2_6_Bao_cao_ket_qua_tuan_thu_SCI-ACE-07.docx
    ├── NHOM_3_1_Phieu_nhan_xet_SCI-ACE-PDG.docx
    ├── NHOM_3_2_Bien_ban_hop_SCI-ACE-05.docx
    ├── NHOM_3_3_Quyet_dinh_phe_duyet_SCI-ACE-QD_VN.docx
    └── NHOM_3_3_Quyet_dinh_phe_duyet_SCI-ACE-QD_EN.docx
```

---

## 🔗 CÁCH LIÊN KẾT HOẠT ĐỘNG

### 1. Navigation Menu (Liên kết giữa các trang HTML)

**Trong EVERY file HTML**, có đoạn code này:

```html
<nav>
    <div class="container">
        <a href="index.html">🏠 Trang chủ</a>
        <a href="nhom-1.html">📚 Nhóm 1: Hướng dẫn</a>
        <a href="nhom-2.html">📝 Nhóm 2: Nghiên cứu viên</a>
        <a href="nhom-3.html">👥 Nhóm 3: Hội đồng</a>
        <a href="huong-dan.html">❓ Hướng dẫn sử dụng</a>
    </div>
</nav>
```

**Giải thích:**
- `href="index.html"` = file index.html ở cùng thư mục
- `href="nhom-1.html"` = file nhom-1.html ở cùng thư mục
- Khi user click vào link → trình duyệt load file HTML đó

---

### 2. Download Links (Liên kết đến file .docx)

**Trong nhom-1.html, nhom-2.html, nhom-3.html:**

```html
<a href="files/NHOM_2_1_Don_de_nghi_xet_duyet_SCI-ACE-01.docx" download class="download-btn">
    📥 Tải xuống
</a>
```

**Giải thích:**
- `href="files/..."` = file trong thư mục `files/`
- `download` = khi click sẽ tải về thay vì mở

---

## 🛠️ CÁCH TẠO THƯ MỤC `files/`

### BƯỚC 1: Tạo thư mục

**Trên Windows:**
```
1. Mở thư mục website/
2. Chuột phải → New → Folder
3. Đặt tên: files
```

**Trên Mac:**
```
1. Mở thư mục website/
2. Cmd + Shift + N
3. Đặt tên: files
```

### BƯỚC 2: Copy file .docx vào

Copy tất cả 14 file .docx từ thư mục outputs/ vào thư mục `files/`:

```
00_MUC_LUC_HE_THONG.docx
HUONG_DAN_TONG_HOP_HO_SO.docx
NHOM_1_1_Huong_dan_van_tat_thao_tac_dong_vat.docx
NHOM_1_2_Quy_che_to_chuc_va_hoat_dong_HDDD.docx
NHOM_2_1_Don_de_nghi_xet_duyet_SCI-ACE-01.docx
NHOM_2_2_Phieu_thuyet_minh_de_tai_SCI-ACE-02.docx
NHOM_2_3_Bao_cao_tuan_thu_3R_SCI-ACE-03.docx
NHOM_2_4_Bao_cao_giai_trinh_SCI-ACE-04.docx
NHOM_2_5_Bao_cao_thay_doi_ke_hoach_SCI-ACE-06.docx
NHOM_2_6_Bao_cao_ket_qua_tuan_thu_SCI-ACE-07.docx
NHOM_3_1_Phieu_nhan_xet_SCI-ACE-PDG.docx
NHOM_3_2_Bien_ban_hop_SCI-ACE-05.docx
NHOM_3_3_Quyet_dinh_phe_duyet_SCI-ACE-QD_VN.docx
NHOM_3_3_Quyet_dinh_phe_duyet_SCI-ACE-QD_EN.docx
```

---

## ✅ KIỂM TRA SAU KHI SETUP

### 1. Kiểm tra cấu trúc

Thư mục của bạn phải trông như thế này:

```
website/
├── files/
│   └── (14 file .docx)
├── index.html
├── nhom-1.html
├── nhom-2.html
├── nhom-3.html
├── huong-dan.html
├── styles.css
└── README.md
```

### 2. Test trên local

**Cách 1: Mở trực tiếp**
- Nhấp đúp vào `index.html`
- Click qua các menu → Phải chuyển trang được
- Click nút "Tải xuống" → File .docx phải tải về

**Cách 2: Dùng web server**
```bash
# Trong thư mục website/
python -m http.server 8000

# Mở trình duyệt: http://localhost:8000
```

### 3. Test các link

✅ Navigation menu hoạt động  
✅ Click "Nhóm 1" → Chuyển đến nhom-1.html  
✅ Click "Nhóm 2" → Chuyển đến nhom-2.html  
✅ Click nút "Tải xuống" → File .docx tải về  

---

## 🚀 UPLOAD LÊN HOSTING

### GitHub Pages

```bash
# 1. Tạo repo mới trên github.com

# 2. Upload toàn bộ thư mục website/
#    (bao gồm cả thư mục files/)

# 3. Bật GitHub Pages trong Settings → Pages
```

### Netlify

```
1. Đăng nhập netlify.com
2. Kéo thả TOÀN BỘ thư mục website/ vào
3. Đợi deploy (tự động)
4. Website sẵn sàng!
```

---

## 🔧 SỬA LỖI THƯỜNG GẶP

### Lỗi: Link menu không hoạt động

**Nguyên nhân:** File HTML không cùng thư mục  
**Giải pháp:** Đảm bảo tất cả file .html ở cùng cấp

### Lỗi: Nút tải xuống không hoạt động

**Nguyên nhân:** Thiếu thư mục `files/` hoặc file .docx  
**Giải pháp:** 
1. Tạo thư mục `files/`
2. Copy 14 file .docx vào
3. Refresh trang

### Lỗi: CSS không load

**Nguyên nhân:** File `styles.css` không cùng thư mục  
**Giải pháp:** Đảm bảo `styles.css` ở cùng cấp với `index.html`

---

## 💡 TIPS

### Đổi tên file?

Nếu bạn đổi tên file .docx, nhớ sửa trong HTML:

```html
<!-- Cũ -->
<a href="files/NHOM_2_1_Don_de_nghi_xet_duyet_SCI-ACE-01.docx">

<!-- Mới (nếu đổi tên) -->
<a href="files/Ten_moi_cua_file.docx">
```

### Thêm file mới?

1. Đặt file vào thư mục `files/`
2. Thêm card trong HTML tương ứng:

```html
<div class="download-card">
    <div style="font-size: 3rem;">📄</div>
    <h4>Tên file mới</h4>
    <p>Mô tả...</p>
    <a href="files/TEN_FILE_MOI.docx" download class="download-btn">
        📥 Tải xuống
    </a>
</div>
```

---

## 📞 CẦN GIÚP?

Nếu vẫn gặp vấn đề:
1. Kiểm tra lại cấu trúc thư mục
2. Đảm bảo tên file khớp chính xác (phân biệt hoa thường)
3. Test trên localhost trước khi upload

---

_Cập nhật: Tháng 1/2026_
