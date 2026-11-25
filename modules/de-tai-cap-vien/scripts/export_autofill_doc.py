# -*- coding: utf-8 -*-
"""
Dịch vụ tự động điền sẵn thông tin đề tài (Auto-Fill Document Engine v2)
chuẩn Nghị định 30/2020/NĐ-CP và chuẩn Viện Tế bào gốc (Viện TBG - SCI).
Tự động kế thừa thông tin đề tài qua các giai đoạn:
Quyết định phê duyệt -> Hợp đồng NCKH -> Báo cáo 6T -> Đơn gia hạn -> Đơn nghiệm thu -> Biên bản họp HĐ -> Giải trình -> Biên bản thanh lý.
"""

import os
import sys
import sqlite3
import docx
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn

sys.stdout.reconfigure(encoding='utf-8')

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, "data", "de-tai-cap-vien.db")

def _read_three_digits(n, full=False):
    digits = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"]
    tr = n // 100
    ch = (n % 100) // 10
    dv = n % 10
    res = []
    if tr > 0 or full:
        res.append(digits[tr] + " trăm")
    if ch > 1:
        res.append(digits[ch] + " mươi")
        if dv == 1:
            res.append("mốt")
        elif dv == 4:
            res.append("tư")
        elif dv == 5:
            res.append("lăm")
        elif dv > 0:
            res.append(digits[dv])
    elif ch == 1:
        res.append("mười")
        if dv == 5:
            res.append("lăm")
        elif dv > 0:
            res.append(digits[dv])
    elif ch == 0 and dv > 0:
        if tr > 0 or full:
            res.append("lẻ")
        res.append(digits[dv])
    return " ".join(res)

def num_to_vietnamese_words(n):
    try:
        n = int(round(abs(float(n))))
        if n == 0:
            return "Không đồng"
        units = ["", "nghìn", "triệu", "tỷ", "nghìn tỷ"]
        groups = []
        temp = n
        while temp > 0:
            groups.append(temp % 1000)
            temp //= 1000
        parts = []
        for i in range(len(groups) - 1, -1, -1):
            g = groups[i]
            if g > 0:
                is_full = (i < len(groups) - 1)
                w = _read_three_digits(g, full=is_full)
                if units[i]:
                    w += " " + units[i]
                parts.append(w)
        text = " ".join(parts).strip()
        text = text[0].upper() + text[1:]
        return f"{text} đồng chẵn"
    except:
        return f"{n} đồng"

def format_date_vn(date_str):
    if not date_str:
        return "ngày .... tháng .... năm 20..."
    try:
        parts = date_str.split('-')
        if len(parts) == 3:
            return f"ngày {parts[2]} tháng {parts[1]} năm {parts[0]}"
    except:
        pass
    return f"ngày {date_str}"

def set_page_margins_nd30(doc):
    for section in doc.sections:
        section.top_margin = Inches(0.79)
        section.bottom_margin = Inches(0.79)
        section.left_margin = Inches(1.18)
        section.right_margin = Inches(0.59)

def set_cell_margins(cell, top=100, bottom=100, left=140, right=140):
    tcPr = cell._tc.get_or_add_tcPr()
    tcMar = OxmlElement('w:tcMar')
    for m, val in [('w:top', top), ('w:bottom', bottom), ('w:left', left), ('w:right', right)]:
        node = OxmlElement(m)
        node.set(qn('w:w'), str(val))
        node.set(qn('w:type'), 'dxa')
        tcMar.append(node)
    tcPr.append(tcMar)

def set_cell_shd(cell, hex_color):
    shd = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{hex_color}"/>')
    cell._tc.get_or_add_tcPr().append(shd)

def apply_table_border(table, color="94A3B8"):
    tblPr = table._tbl.tblPr
    borders = parse_xml(
        f'<w:tblBorders {nsdecls("w")}>\n'
        f'  <w:top w:val="single" w:sz="4" w:space="0" w:color="{color}"/>\n'
        f'  <w:bottom w:val="single" w:sz="4" w:space="0" w:color="{color}"/>\n'
        f'  <w:left w:val="single" w:sz="4" w:space="0" w:color="{color}"/>\n'
        f'  <w:right w:val="single" w:sz="4" w:space="0" w:color="{color}"/>\n'
        f'  <w:insideH w:val="single" w:sz="4" w:space="0" w:color="{color}"/>\n'
        f'  <w:insideV w:val="single" w:sz="4" w:space="0" w:color="{color}"/>\n'
        f'</w:tblBorders>'
    )
    tblPr.append(borders)

def add_header_nd30(doc, code_str="", date_str="Thành phố Hồ Chí Minh, ngày .... tháng .... năm 20..."):
    tbl = doc.add_table(rows=1, cols=2)
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    tbl.autofit = False
    
    c0 = tbl.cell(0, 0)
    c0.width = Inches(3.2)
    p0 = c0.paragraphs[0]
    p0.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p0.paragraph_format.line_spacing = 1.15
    p0.paragraph_format.space_after = Pt(2)
    
    r0_1 = p0.add_run("ĐẠI HỌC QUỐC GIA TP. HỒ CHÍ MINH\n")
    r0_1.font.name = "Times New Roman"; r0_1.font.size = Pt(9.5)
    
    r0_2 = p0.add_run("TRƯỜNG ĐH KHOA HỌC TỰ NHIÊN\n")
    r0_2.font.name = "Times New Roman"; r0_2.font.size = Pt(10); r0_2.font.bold = True
    
    r0_3 = p0.add_run("VIỆN TẾ BÀO GỐC")
    r0_3.font.name = "Times New Roman"; r0_3.font.size = Pt(11); r0_3.font.bold = True
    
    p0_sub = c0.add_paragraph()
    p0_sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p0_sub.paragraph_format.space_after = Pt(2)
    r_sub = p0_sub.add_run("-----------------")
    r_sub.font.name = "Times New Roman"; r_sub.font.bold = True
    
    if code_str:
        p0_code = c0.add_paragraph()
        p0_code.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p0_code.paragraph_format.space_after = Pt(2)
        r_code = p0_code.add_run(code_str)
        r_code.font.name = "Times New Roman"; r_code.font.size = Pt(10); r_code.font.italic = True
    
    c1 = tbl.cell(0, 1)
    c1.width = Inches(3.8)
    p1 = c1.paragraphs[0]
    p1.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p1.paragraph_format.line_spacing = 1.15
    p1.paragraph_format.space_after = Pt(2)
    
    r1_1 = p1.add_run("CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM\n")
    r1_1.font.name = "Times New Roman"; r1_1.font.size = Pt(10.5); r1_1.font.bold = True
    
    r1_2 = p1.add_run("Độc lập – Tự do – Hạnh phúc")
    r1_2.font.name = "Times New Roman"; r1_2.font.size = Pt(11); r1_2.font.bold = True
    
    p1_sub = c1.add_paragraph()
    p1_sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p1_sub.paragraph_format.space_after = Pt(4)
    r1_s = p1_sub.add_run("-----------------------")
    r1_s.font.name = "Times New Roman"; r1_s.font.bold = True
    
    p1_date = c1.add_paragraph()
    p1_date.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    p1_date.paragraph_format.space_after = Pt(4)
    r1_d = p1_date.add_run(date_str)
    r1_d.font.name = "Times New Roman"; r1_d.font.size = Pt(10); r1_d.font.italic = True
    
    tblBorders = parse_xml(
        f'<w:tblBorders {nsdecls("w")}>\n'
        f'  <w:top w:val="none"/><w:bottom w:val="none"/><w:left w:val="none"/><w:right w:val="none"/>\n'
        f'  <w:insideH w:val="none"/><w:insideV w:val="none"/>\n'
        f'</w:tblBorders>'
    )
    tbl._tbl.tblPr.append(tblBorders)

def add_p(doc, text="", font_size=12, bold=False, italic=False, align=WD_ALIGN_PARAGRAPH.JUSTIFY, space_after=3, line_spacing=1.15):
    p = doc.add_paragraph()
    p.alignment = align
    p.paragraph_format.space_after = Pt(space_after)
    p.paragraph_format.line_spacing = line_spacing
    if text:
        r = p.add_run(text)
        r.font.name = "Times New Roman"
        r.font.size = Pt(font_size)
        r.font.bold = bold
        r.font.italic = italic
    return p

def add_signatures_2cols(doc, left_title="XÁC NHẬN CỦA PHÒNG KẾ HOẠCH TỔNG HỢP", right_title="CHỦ NHIỆM ĐỀ TÀI",
                         left_sub="(Ký và ghi rõ họ tên)", right_sub="(Ký và ghi rõ họ tên)",
                         left_name="Trương Châu Nhật", right_name=""):
    p_sp = doc.add_paragraph()
    p_sp.paragraph_format.space_before = Pt(8); p_sp.paragraph_format.space_after = Pt(4)
    tbl = doc.add_table(rows=4, cols=2)
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER; tbl.autofit = False
    widths = [Inches(3.4), Inches(3.6)]
    titles = [left_title, right_title]; subs = [left_sub, right_sub]; names = [left_name, right_name]
    for i in range(2):
        c0 = tbl.cell(0, i); c0.width = widths[i]
        p0 = c0.paragraphs[0]; p0.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r0 = p0.add_run(titles[i]); r0.font.name = "Times New Roman"; r0.font.size = Pt(11); r0.font.bold = True
        c1 = tbl.cell(1, i); c1.width = widths[i]
        p1 = c1.paragraphs[0]; p1.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r1 = p1.add_run(subs[i]); r1.font.name = "Times New Roman"; r1.font.size = Pt(10); r1.font.italic = True
        c2 = tbl.cell(2, i); c2.width = widths[i]
        c2.paragraphs[0].add_run("\n\n\n")
        c3 = tbl.cell(3, i); c3.width = widths[i]
        p3 = c3.paragraphs[0]; p3.alignment = WD_ALIGN_PARAGRAPH.CENTER
        if names[i]:
            r3 = p3.add_run(names[i]); r3.font.name = "Times New Roman"; r3.font.size = Pt(11); r3.font.bold = True

    tblBorders = parse_xml(
        f'<w:tblBorders {nsdecls("w")}>\n'
        f'  <w:top w:val="none"/><w:bottom w:val="none"/><w:left w:val="none"/><w:right w:val="none"/>\n'
        f'  <w:insideH w:val="none"/><w:insideV w:val="none"/>\n'
        f'</w:tblBorders>'
    )
    tbl._tbl.tblPr.append(tblBorders)

def add_signatures_3cols(doc, left_title="VIỆN TRƯỞNG", mid_title="TRƯỞNG PHÒNG KẾ HOẠCH TỔNG HỢP", right_title="CHỦ NHIỆM ĐỀ TÀI",
                         left_sub="(Ký, đóng dấu và ghi rõ họ tên)", mid_sub="(Ký và ghi rõ họ tên)", right_sub="(Ký và ghi rõ họ tên)",
                         left_name="PGS. TS. Phạm Văn Phúc", mid_name="Trương Châu Nhật", right_name=""):
    p_sp = doc.add_paragraph()
    p_sp.paragraph_format.space_before = Pt(8); p_sp.paragraph_format.space_after = Pt(4)
    tbl = doc.add_table(rows=4, cols=3)
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER; tbl.autofit = False
    widths = [Inches(2.3), Inches(2.4), Inches(2.3)]
    titles = [left_title, mid_title, right_title]; subs = [left_sub, mid_sub, right_sub]; names = [left_name, mid_name, right_name]
    for i in range(3):
        c0 = tbl.cell(0, i); c0.width = widths[i]
        p0 = c0.paragraphs[0]; p0.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r0 = p0.add_run(titles[i]); r0.font.name = "Times New Roman"; r0.font.size = Pt(10.5); r0.font.bold = True
        c1 = tbl.cell(1, i); c1.width = widths[i]
        p1 = c1.paragraphs[0]; p1.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r1 = p1.add_run(subs[i]); r1.font.name = "Times New Roman"; r1.font.size = Pt(9.5); r1.font.italic = True
        c2 = tbl.cell(2, i); c2.width = widths[i]
        c2.paragraphs[0].add_run("\n\n\n")
        c3 = tbl.cell(3, i); c3.width = widths[i]
        p3 = c3.paragraphs[0]; p3.alignment = WD_ALIGN_PARAGRAPH.CENTER
        if names[i]:
            r3 = p3.add_run(names[i]); r3.font.name = "Times New Roman"; r3.font.size = Pt(10.5); r3.font.bold = True

    tblBorders = parse_xml(
        f'<w:tblBorders {nsdecls("w")}>\n'
        f'  <w:top w:val="none"/><w:bottom w:val="none"/><w:left w:val="none"/><w:right w:val="none"/>\n'
        f'  <w:insideH w:val="none"/><w:insideV w:val="none"/>\n'
        f'</w:tblBorders>'
    )
    tbl._tbl.tblPr.append(tblBorders)

# ==================== BUILDERS ĐIỀN SẴN DỮ LIỆU ĐỀ TÀI ====================

def get_contract_info(p):
    contract_num = p.get('contract_number') or f"HĐ-NCKH/{p['code'].replace('/', '.')}/SCI"
    contract_date = p.get('contract_date') or p.get('decision_date')
    return contract_num, format_date_vn(contract_date)

def generate_autofill_hop_dong(p, out_path):
    doc = docx.Document()
    set_page_margins_nd30(doc)
    dec_date_vn = format_date_vn(p.get('decision_date'))
    contract_num, _ = get_contract_info(p)
    add_header_nd30(doc, code_str=f"Số: {contract_num}", date_str=f"Thành phố Hồ Chí Minh, {dec_date_vn}")
    
    p_title = doc.add_paragraph()
    p_title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_title.paragraph_format.space_before = Pt(8); p_title.paragraph_format.space_after = Pt(2)
    r1 = p_title.add_run("HỢP ĐỒNG NGHIÊN CỨU KHOA HỌC VÀ PHÁT TRIỂN CÔNG NGHỆ\n")
    r1.font.name = "Times New Roman"; r1.font.size = Pt(13.5); r1.font.bold = True
    r2 = p_title.add_run(f"Số: {contract_num}")
    r2.font.name = "Times New Roman"; r2.font.size = Pt(11.5); r2.font.bold = True; r2.font.italic = True
    
    add_p(doc, "- Căn cứ Quyết định số 890a/QĐ-KHTN ngày 12 tháng 6 năm 2017 của Hiệu trưởng Trường Đại học Khoa học tự nhiên, ĐHQG-HCM về việc thành lập Viện Tế bào gốc;")
    add_p(doc, "- Căn cứ Quy chế tổ chức và hoạt động của Viện Tế bào gốc;")
    add_p(doc, f"- Căn cứ Quyết định phê duyệt thuyết minh và giao nhiệm vụ KH&CN số {p['decision_number']} {dec_date_vn} của Viện trưởng Viện Tế bào gốc;")
    add_p(doc, f"Hôm nay, {dec_date_vn}, tại Viện Tế bào gốc, chúng tôi gồm có:")
    
    add_p(doc, "BÊN GIAO VIỆC (BÊN A): VIỆN TẾ BÀO GỐC (SCI)", font_size=11.5, bold=True)
    add_p(doc, "- Đại diện: PGS. TS. Phạm Văn Phúc            - Chức vụ: Viện trưởng\n- Địa chỉ: Khu phố 6, Phường Linh Trung, TP. Thủ Đức, TP. Hồ Chí Minh\n- Điện thoại: (028) 3620 3043                  - Cơ quan chủ quản: Trường ĐH Khoa học Tự nhiên")
    
    add_p(doc, "BÊN NHẬN VIỆC (BÊN B): CHỦ NHIỆM ĐỀ TÀI", font_size=11.5, bold=True)
    add_p(doc, f"- Họ và tên: {p['leader_name']}\n- Đơn vị công tác: Nhóm {p['research_group'] or 'Nghiên cứu'}, Viện Tế bào gốc\n- Thành viên tham gia: {p['members'] or 'Cán bộ và học viên thuộc nhóm nghiên cứu'}")
    
    add_p(doc, "Hai bên cùng thống nhất ký kết Hợp đồng thực hiện đề tài NCKH với các điều khoản sau:")
    add_p(doc, f"Điều 1. Nội dung công việc: Bên B chủ trì tổ chức triển khai đề tài: '{p['title']}', Mã số: {p['code']}, theo đúng nội dung và tiến độ được phê duyệt trong Thuyết minh đề tài kèm theo.")
    add_p(doc, f"Điều 2. Thời gian thực hiện: {p['duration_months'] or 12} tháng, từ ngày ký Quyết định giao nhiệm vụ ({p['decision_date']}) đến ngày {p['base_end_date']}. Trường hợp cần mở rộng, Bên B làm thủ tục gia hạn theo quy định (tối đa 2 lần, mỗi lần 6 tháng).")
    budget_val = p['budget_total'] or 50000000
    add_p(doc, f"Điều 3. Kinh phí thực hiện: Tổng kinh phí thực hiện đề tài là {budget_val:,.0f} VNĐ ({num_to_vietnamese_words(budget_val)}). Nguồn kinh phí từ quỹ NCKH thường xuyên của Viện Tế bào gốc.")
    add_p(doc, "Điều 4. Sản phẩm giao nộp: Bên B cam kết bàn giao đầy đủ: (1) Báo cáo tổng kết toàn văn và báo cáo tóm tắt; (2) Bài báo khoa học xuất bản hoặc đơn đăng ký giải pháp hữu ích/sáng chế; (3) Sản phẩm đào tạo học viên cao học/cử nhân theo đúng đăng ký.")
    add_p(doc, "Điều 5. Nghiệm thu và thanh lý: Sau khi hoàn thành toàn bộ khối lượng nghiên cứu, Bên B nộp Đơn đề nghị nghiệm thu. Hai bên tiến hành họp Hội đồng đánh giá và lập Biên bản thanh lý Hợp đồng để tất toán đề tài.")
    
    add_signatures_3cols(doc, left_title="ĐẠI DIỆN BÊN A\nVIỆN TRƯỞNG", mid_title="TRƯỞNG PHÒNG KẾ HOẠCH TỔNG HỢP", right_title="ĐẠI DIỆN BÊN B\nCHỦ NHIỆM ĐỀ TÀI",
                         left_name="PGS. TS. Phạm Văn Phúc", mid_name="Trương Châu Nhật", right_name=p['leader_name'])
    doc.save(out_path)

def generate_autofill_bao_cao_6thang(p, out_path, report_row=None):
    """
    Xuất Báo cáo định kỳ 6 tháng (BM-04/SCI-NCKH):
    - Phần I: Tự động kế thừa 100% thông tin hành chính - pháp lý của đề tài.
    - Phần II: Tự động điền tóm tắt tiến độ (progress_summary), tỷ lệ hoàn thành (progress_percent)
      và đánh giá của P. KHCN (nếu đã có trong hệ thống); giữ khung mở để nhà khoa học bổ sung
      số liệu, hình ảnh thí nghiệm, biểu đồ rồi in ký nộp và upload lại.
    """
    doc = docx.Document()
    set_page_margins_nd30(doc)
    contract_num, _ = get_contract_info(p)
    sub_date_vn = format_date_vn(report_row.get('submitted_date')) if (report_row and report_row.get('submitted_date')) else "ngày .... tháng .... năm 20..."
    add_header_nd30(doc, code_str="Mẫu: BM-04/SCI-NCKH", date_str=f"Thành phố Hồ Chí Minh, {sub_date_vn}")
    
    period_num = (report_row.get('period_num') if report_row else None) or 1
    progress_summary = (report_row.get('progress_summary') or '').strip() if report_row else ''
    progress_percent = report_row.get('progress_percent') if (report_row and report_row.get('progress_percent') is not None) else None
    khcn_eval = (report_row.get('khcn_evaluation') or '').strip() if report_row else ''
    evaluated_by = (report_row.get('evaluated_by') or '').strip() if report_row else ''

    p_title = doc.add_paragraph()
    p_title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_title.paragraph_format.space_before = Pt(8); p_title.paragraph_format.space_after = Pt(2)
    r1 = p_title.add_run(f"BÁO CÁO ĐỊNH KỲ TIẾN ĐỘ THỰC HIỆN ĐỀ TÀI (06 THÁNG - KỲ {period_num})\n")
    r1.font.name = "Times New Roman"; r1.font.size = Pt(13.5); r1.font.bold = True
    r2 = p_title.add_run("NGHIÊN CỨU KHOA HỌC CẤP VIỆN TẾ BÀO GỐC")
    r2.font.name = "Times New Roman"; r2.font.size = Pt(12); r2.font.bold = True
    
    add_p(doc, "PHẦN I. THÔNG TIN CHUNG VỀ ĐỀ TÀI (Tự động kế thừa từ hệ thống)", font_size=12, bold=True, space_after=3)
    add_p(doc, f"1. Tên đề tài: {p['title']}")
    add_p(doc, f"2. Mã số đề tài: {p['code']}      - Nhóm chuyên môn: {p['research_group'] or 'Stem Cell Institute'}")
    add_p(doc, "3. Cơ quan chủ trì: Viện Tế bào gốc, Trường ĐH Khoa học Tự nhiên, ĐHQG-HCM")
    add_p(doc, f"4. Chủ nhiệm đề tài: {p['leader_name']}")
    add_p(doc, f"5. Thành viên tham gia: {p['members'] or 'Các thành viên trong nhóm nghiên cứu'}")
    add_p(doc, f"6. Quyết định giao nhiệm vụ số: {p['decision_number']} ngày {p['decision_date']}")
    add_p(doc, f"7. Hợp đồng NCKH số: {contract_num}")
    add_p(doc, f"8. Thời gian thực hiện theo HĐ: {p['duration_months'] or 12} tháng (từ {p['decision_date']} đến {p['current_end_date'] or p['base_end_date']})")
    budget_val = p.get('budget_revised') or p.get('budget_total') or 50000000
    add_p(doc, f"9. Tổng kinh phí được duyệt: {budget_val:,.0f} VNĐ ({num_to_vietnamese_words(budget_val)})")
    
    add_p(doc, "PHẦN II. NỘI DUNG VÀ KẾT QUẢ NGHIÊN CỨU ĐẠT ĐƯỢC TRONG 06 THÁNG", font_size=12, bold=True, space_after=3)
    add_p(doc, "(Chủ nhiệm đề tài tự do trình bày chi tiết kết quả nghiên cứu, bảng biểu số liệu, hình ảnh hiển vi, biểu đồ phân tích... vào các mục dưới đây; sau khi hoàn thiện, in ký nộp bản cứng và upload file hoàn chỉnh lên hệ thống)", font_size=10.5, italic=True, space_after=4)

    add_p(doc, "1. Các nội dung công việc đã triển khai theo thuyết minh:", font_size=12, bold=True)
    tbl_cv = doc.add_table(rows=4, cols=4)
    tbl_cv.alignment = WD_TABLE_ALIGNMENT.CENTER
    apply_table_border(tbl_cv)
    headers_cv = ["STT", "Nội dung công việc theo thuyết minh", "Phương pháp / Thí nghiệm đã thực hiện", "Tỷ lệ hoàn thành (%)"]
    widths_cv = [Inches(0.5), Inches(2.6), Inches(2.7), Inches(1.2)]
    for i, h in enumerate(headers_cv):
        c = tbl_cv.cell(0, i); c.width = widths_cv[i]
        set_cell_margins(c); set_cell_shd(c, "F1F5F9")
        p_h = c.paragraphs[0]; p_h.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r_h = p_h.add_run(h); r_h.font.name = "Times New Roman"; r_h.font.size = Pt(10); r_h.font.bold = True

    pct_cell_default = f"{int(progress_percent)}%" if (progress_percent is not None and int(progress_percent) > 0) else "...%"
    for r_i in range(1, 4):
        for c_idx in range(4):
            c = tbl_cv.cell(r_i, c_idx); c.width = widths_cv[c_idx]
            set_cell_margins(c)
            p_c = c.paragraphs[0]
            if c_idx in [0, 3]: p_c.alignment = WD_ALIGN_PARAGRAPH.CENTER
            if c_idx == 0:
                val = str(r_i)
            elif r_i == 1 and c_idx == 1 and progress_summary:
                val = progress_summary
            elif r_i == 1 and c_idx == 3:
                val = pct_cell_default
            elif c_idx == 3:
                val = "...%"
            else:
                val = ""
            r_c = p_c.add_run(val); r_c.font.name = "Times New Roman"; r_c.font.size = Pt(10.5)

    doc.add_paragraph()
    add_p(doc, "2. Kết quả nghiên cứu khoa học đạt được (Số liệu, bảng biểu, hình ảnh, đồ thị):", font_size=12, bold=True)
    if progress_summary:
        add_p(doc, f"2.1. Tóm tắt kết quả thí nghiệm / phân tích chuyên môn (Kế thừa từ hệ thống):\n{progress_summary}")
    else:
        add_p(doc, "2.1. Kết quả thí nghiệm / phân tích chuyên môn:\n..........................................................................................................................................................................\n..........................................................................................................................................................................")
    add_p(doc, "2.2. Hình ảnh minh họa, biểu đồ, bảng số liệu (Chèn trực tiếp hình ảnh/biểu đồ và chú thích hình tại đây):\n\n\n\n")

    add_p(doc, "3. Tình hình sử dụng kinh phí, hóa chất và vật tư thí nghiệm:", font_size=12, bold=True)
    add_p(doc, "- Tình hình tiếp nhận và sử dụng hóa chất, vật tư đợt vừa qua:\n..........................................................................................................................................................................")

    add_p(doc, "4. Đánh giá chung tiến độ, khó khăn vướng mắc (nếu có) và kế hoạch 06 tháng tiếp theo:", font_size=12, bold=True)
    pct_display = f"{int(progress_percent)}%" if (progress_percent is not None and int(progress_percent) > 0) else ".......... %"
    add_p(doc, f"- Ước tính tổng khối lượng công việc đã hoàn thành của toàn đề tài: {pct_display}")
    if khcn_eval:
        eval_actor = f" ({evaluated_by})" if evaluated_by else ""
        add_p(doc, f"- Nhận xét / Đánh giá của Phòng Kế hoạch tổng hợp{eval_actor}: {khcn_eval}")
    add_p(doc, "- Khó khăn, kiến nghị (nếu có) và kế hoạch triển khai kỳ tiếp theo:\n..........................................................................................................................................................................")
    
    add_signatures_3cols(doc, left_title="PHÊ DUYỆT CỦA VIỆN TRƯỞNG", mid_title="Ý KIẾN CỦA PHÒNG KẾ HOẠCH TỔNG HỢP", right_title="CHỦ NHIỆM ĐỀ TÀI",
                         left_name="PGS. TS. Phạm Văn Phúc", mid_name="Trương Châu Nhật", right_name=p['leader_name'])
    doc.save(out_path)

def generate_autofill_don_gia_han(p, out_path, ext_row=None, doc_key="", report_row=None):
    doc = docx.Document()
    set_page_margins_nd30(doc)
    contract_num, _ = get_contract_info(p)
    req_date_vn = format_date_vn(ext_row.get('request_date') or ext_row.get('decision_date')) if ext_row else "ngày .... tháng .... năm 20..."
    add_header_nd30(doc, code_str="Mẫu: BM-05/SCI-NCKH", date_str=f"Thành phố Hồ Chí Minh, {req_date_vn}")
    
    p_title = doc.add_paragraph()
    p_title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_title.paragraph_format.space_before = Pt(8); p_title.paragraph_format.space_after = Pt(2)
    r1 = p_title.add_run("ĐƠN ĐỀ NGHỊ GIA HẠN THỜI GIAN THỰC HIỆN\n")
    r1.font.name = "Times New Roman"; r1.font.size = Pt(14); r1.font.bold = True
    r2 = p_title.add_run("ĐỀ TÀI KHOA HỌC VÀ CÔNG NGHỆ CẤP VIỆN")
    r2.font.name = "Times New Roman"; r2.font.size = Pt(12); r2.font.bold = True
    
    add_p(doc, "Kính gửi:  - Viện trưởng Viện Tế bào gốc\n                   - Phòng Khoa học Công nghệ và Quan hệ đối ngoại", italic=True)
    
    add_p(doc, f"1. Tên đề tài: {p['title']}")
    add_p(doc, f"2. Mã số đề tài: {p['code']}")
    add_p(doc, f"3. Chủ nhiệm đề tài: {p['leader_name']}      - Đơn vị: Nhóm {p['research_group'] or 'Nghiên cứu'}")
    add_p(doc, f"4. Quyết định giao nhiệm vụ số: {p['decision_number']} ngày {p['decision_date']}")
    add_p(doc, f"5. Hợp đồng NCKH số: {contract_num}")
    budget_val = p.get('budget_revised') or p.get('budget_total') or 50000000
    add_p(doc, f"6. Tổng kinh phí được phê duyệt: {budget_val:,.0f} VNĐ ({num_to_vietnamese_words(budget_val)})")
    add_p(doc, f"7. Thời gian thực hiện theo HĐ: {p['duration_months'] or 12} tháng (từ {p['decision_date']} đến {p['base_end_date']})")
    
    if ext_row and ext_row.get('extension_num'):
        ext_num = int(ext_row['extension_num'])
    elif '2' in str(doc_key):
        ext_num = 2
    elif '1' in str(doc_key):
        ext_num = 1
    else:
        ext_num = (p.get('extension_count') or 0) if (p.get('extension_count') or 0) > 0 else 1

    ext_label = "Lần 1 (06 tháng)" if ext_num == 1 else "Lần 2 (06 tháng - Lần cuối)"
    months_added = (ext_row.get('months_added') if ext_row else None) or 6
    new_end_date = (ext_row.get('new_end_date') if ext_row else None) or p.get('current_end_date') or 'theo quy định'
    prev_end_date = (ext_row.get('previous_end_date') if ext_row else None) or p.get('base_end_date')

    add_p(doc, f"8. Đề nghị gia hạn thực hiện: {ext_label}")
    if prev_end_date:
        add_p(doc, f"9. Thời gian đề nghị gia hạn: {months_added:02d} tháng (từ ngày {prev_end_date} gia hạn đến ngày: {new_end_date})")
    else:
        add_p(doc, f"9. Thời gian đề nghị gia hạn: {months_added:02d} tháng (gia hạn đến ngày: {new_end_date})")

    prog_pct = report_row.get('progress_percent') if (report_row and report_row.get('progress_percent') is not None) else None
    prog_sum = (report_row.get('progress_summary') or '').strip() if report_row else ''
    if prog_pct and int(prog_pct) > 0 and prog_sum:
        progress_line = f"Khoảng {int(prog_pct)}% khối lượng theo thuyết minh ({prog_sum})."
    elif prog_pct and int(prog_pct) > 0:
        progress_line = f"Khoảng {int(prog_pct)}% khối lượng theo thuyết minh."
    elif prog_sum:
        progress_line = prog_sum
    else:
        progress_line = "Khoảng 80% - 90% khối lượng theo thuyết minh."
    add_p(doc, f"10. Khối lượng công việc đã hoàn thành: {progress_line}")

    reason_text = (ext_row.get('reason') or '').strip() if ext_row else ''
    if not reason_text:
        reason_text = "Cần bổ sung các phép đo lặp lại trên các lô sinh học độc lập, hoàn thiện bản thảo bài báo khoa học và hỗ trợ học viên hoàn thành chỉnh sửa luận văn tốt nghiệp theo góp ý của Hội đồng chấm."
    add_p(doc, f"11. Lý do chi tiết xin gia hạn: {reason_text}")
    add_p(doc, "Tôi làm đơn này kính đề nghị Ban Giám đốc Viện và Phòng Kế hoạch tổng hợp xem xét phê duyệt gia hạn để hoàn thành đúng cam kết.")
    
    add_signatures_3cols(doc, left_title="PHÊ DUYỆT CỦA VIỆN TRƯỞNG", mid_title="Ý KIẾN CỦA PHÒNG KẾ HOẠCH TỔNG HỢP", right_title="CHỦ NHIỆM ĐỀ TÀI",
                         left_name="PGS. TS. Phạm Văn Phúc", mid_name="Trương Châu Nhật", right_name=p['leader_name'])
    doc.save(out_path)

def generate_autofill_to_trinh_dieu_chinh_du_toan(p, out_path, adj_row=None):
    """
    Builder xuất Tờ trình điều chỉnh dự toán kinh phí chuẩn Nghị định 30/2020/NĐ-CP.
    Lấy trực tiếp old_budget, new_budget, reason, proposal_details từ bảng nckh_budget_adjustments.
    """
    doc = docx.Document()
    set_page_margins_nd30(doc)
    contract_num, _ = get_contract_info(p)

    adj_num = int(adj_row['adjustment_num']) if (adj_row and adj_row.get('adjustment_num')) else 1
    req_date_str = adj_row.get('request_date') if adj_row else None
    req_date_vn = format_date_vn(req_date_str)
    code_str = f"Số: TT-ĐCDT-L{adj_num}/{p['code'].replace('/', '.')}"
    add_header_nd30(doc, code_str=code_str, date_str=f"Thành phố Hồ Chí Minh, {req_date_vn}")

    p_title = doc.add_paragraph()
    p_title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_title.paragraph_format.space_before = Pt(8); p_title.paragraph_format.space_after = Pt(2)
    r1 = p_title.add_run("TỜ TRÌNH\n")
    r1.font.name = "Times New Roman"; r1.font.size = Pt(14); r1.font.bold = True
    r2 = p_title.add_run(f"Về việc đề nghị điều chỉnh dự toán kinh phí thực hiện đề tài KH&CN cấp Viện (Lần {adj_num})")
    r2.font.name = "Times New Roman"; r2.font.size = Pt(12); r2.font.bold = True; r2.font.italic = True

    add_p(doc, "Kính gửi:  - Viện trưởng Viện Tế bào gốc\n                   - Phòng Khoa học Công nghệ và Quan hệ đối ngoại\n                   - Phòng Tài chính - Cung ứng", italic=True)

    add_p(doc, "PHẦN I. THÔNG TIN CHUNG VỀ ĐỀ TÀI", font_size=12, bold=True, space_after=3)
    add_p(doc, f"1. Tên đề tài: {p['title']}")
    add_p(doc, f"2. Mã số đề tài: {p['code']}      - Đơn vị: Nhóm {p.get('research_group') or 'Nghiên cứu'}, Viện Tế bào gốc")
    add_p(doc, f"3. Chủ nhiệm đề tài: {p['leader_name']}")
    add_p(doc, f"4. Quyết định giao nhiệm vụ số: {p.get('decision_number') or '....'} ngày {p.get('decision_date') or '....'}")
    add_p(doc, f"5. Hợp đồng NCKH số: {contract_num}")
    add_p(doc, f"6. Thời gian thực hiện: {p.get('duration_months') or 12} tháng (từ {p.get('decision_date')} đến {p.get('current_end_date') or p.get('base_end_date')})")

    old_budget = float(adj_row['old_budget']) if (adj_row and adj_row.get('old_budget') is not None) else float(p.get('budget_total') or 50000000)
    new_budget = float(adj_row['new_budget']) if (adj_row and adj_row.get('new_budget') is not None) else float(p.get('budget_revised') or old_budget)
    diff_amount = float(adj_row['difference_amount']) if (adj_row and adj_row.get('difference_amount') is not None) else (new_budget - old_budget)

    reason_text = (adj_row.get('reason') or '').strip() if adj_row else ''
    if not reason_text:
        reason_text = "Điều chuyển cơ cấu kinh phí giữa các hạng mục hóa chất, vật tư tiêu hao để phù hợp với thực tế triển khai thí nghiệm."

    details_text = (adj_row.get('proposal_details') or '').strip() if adj_row else ''
    if not details_text:
        details_text = "Điều chỉnh danh mục hóa chất, sinh phẩm và vật tư thí nghiệm phục vụ nghiên cứu."

    if diff_amount > 0:
        diff_label = f"+{diff_amount:,.0f} VNĐ (Tăng {num_to_vietnamese_words(diff_amount).lower()})"
    elif diff_amount < 0:
        diff_label = f"-{abs(diff_amount):,.0f} VNĐ (Giảm {num_to_vietnamese_words(abs(diff_amount)).lower()})"
    else:
        diff_label = "0 VNĐ (Giữ nguyên tổng mức kinh phí được duyệt, điều chuyển nội bộ giữa các hạng mục)"

    add_p(doc, "PHẦN II. NỘI DUNG ĐỀ NGHỊ ĐIỀU CHỈNH DỰ TOÁN KINH PHÍ", font_size=12, bold=True, space_after=3)
    add_p(doc, f"7. Tổng kinh phí dự toán trước điều chỉnh: {old_budget:,.0f} VNĐ ({num_to_vietnamese_words(old_budget)}).")
    add_p(doc, f"8. Tổng kinh phí dự toán đề nghị mới: {new_budget:,.0f} VNĐ ({num_to_vietnamese_words(new_budget)}).")
    add_p(doc, f"9. Chênh lệch tổng kinh phí: {diff_label}.")
    add_p(doc, f"10. Lý do đề nghị điều chỉnh dự toán: {reason_text}")
    add_p(doc, f"11. Chi tiết phương án điều chỉnh các hạng mục dự toán: {details_text}")

    # Bảng đối chiếu kinh phí chuẩn Nghị định 30
    detail_items = [s.strip() for s in details_text.replace('\n', ';').split(';') if s.strip()]
    if not detail_items:
        detail_items = [details_text]

    tbl_adj = doc.add_table(rows=2 + len(detail_items), cols=4)
    tbl_adj.alignment = WD_TABLE_ALIGNMENT.CENTER
    apply_table_border(tbl_adj)
    headers_adj = ["STT", "Nội dung / Hạng mục điều chỉnh dự toán", "Số tiền / Giá trị (VNĐ)", "Ghi chú đối chiếu"]
    widths_adj = [Inches(0.5), Inches(3.2), Inches(1.6), Inches(1.7)]

    for i, h in enumerate(headers_adj):
        c = tbl_adj.cell(0, i); c.width = widths_adj[i]
        set_cell_margins(c); set_cell_shd(c, "F1F5F9")
        p_h = c.paragraphs[0]; p_h.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r_h = p_h.add_run(h); r_h.font.name = "Times New Roman"; r_h.font.size = Pt(10); r_h.font.bold = True

    # Dòng 1: Tổng mức dự toán cũ -> mới
    diff_short = f"+{diff_amount:,.0f} đ" if diff_amount > 0 else (f"-{abs(diff_amount):,.0f} đ" if diff_amount < 0 else "0 đ (Không đổi)")
    summary_row = ("I", "Tổng dự toán kinh phí đề tài (Cũ -> Mới)", f"{old_budget:,.0f} -> {new_budget:,.0f}", f"Chênh lệch: {diff_short}")
    for c_idx, val in enumerate(summary_row):
        c = tbl_adj.cell(1, c_idx); c.width = widths_adj[c_idx]
        set_cell_margins(c); set_cell_shd(c, "FAFAFA")
        p_c = c.paragraphs[0]
        if c_idx in [0, 2]: p_c.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r_c = p_c.add_run(val); r_c.font.name = "Times New Roman"; r_c.font.size = Pt(10); r_c.font.bold = True

    # Các dòng chi tiết từ proposal_details
    for idx, item_str in enumerate(detail_items, 1):
        row_cells = (str(idx), item_str, "Theo phương án điều chỉnh", "Phục vụ chuyên môn đề tài")
        for c_idx, val in enumerate(row_cells):
            c = tbl_adj.cell(1 + idx, c_idx); c.width = widths_adj[c_idx]
            set_cell_margins(c)
            p_c = c.paragraphs[0]
            if c_idx in [0, 2]: p_c.alignment = WD_ALIGN_PARAGRAPH.CENTER
            r_c = p_c.add_run(val); r_c.font.name = "Times New Roman"; r_c.font.size = Pt(10)

    doc.add_paragraph()

    if adj_row and adj_row.get('khcn_opinion'):
        add_p(doc, f"12. Ý kiến thẩm tra của Phòng Kế hoạch tổng hợp: {adj_row['khcn_opinion']}")
    if adj_row and (adj_row.get('decision_number') or adj_row.get('director_decision')):
        dec_info = f" (Quyết định số: {adj_row['decision_number']} ngày {adj_row.get('decision_date') or ''})" if adj_row.get('decision_number') else ""
        add_p(doc, f"13. Ý kiến phê duyệt của Viện trưởng: {adj_row.get('director_decision') or 'Đồng ý phê duyệt điều chỉnh dự toán'}{dec_info}.")

    add_p(doc, "Ban Chủ nhiệm đề tài cam kết việc điều chỉnh dự toán nêu trên hoàn toàn phù hợp với định mức chi tiêu nội bộ của Viện, không làm thay đổi mục tiêu và sản phẩm khoa học đã đăng ký trong Hợp đồng. Kính trình Viện trưởng và Phòng Kế hoạch tổng hợp xem xét, phê duyệt.")

    add_signatures_3cols(doc, left_title="PHÊ DUYỆT CỦA VIỆN TRƯỞNG", mid_title="THẨM TRA CỦA PHÒNG KẾ HOẠCH TỔNG HỢP", right_title="CHỦ NHIỆM ĐỀ TÀI",
                         left_name="PGS. TS. Phạm Văn Phúc", mid_name="Trương Châu Nhật", right_name=p['leader_name'])
    doc.save(out_path)

def generate_autofill_don_nghiem_thu(p, out_path, report_row=None):
    doc = docx.Document()
    set_page_margins_nd30(doc)
    contract_num, _ = get_contract_info(p)
    add_header_nd30(doc, code_str="Mẫu: BM-06/SCI-NCKH", date_str="Thành phố Hồ Chí Minh, ngày .... tháng .... năm 20...")
    
    p_title = doc.add_paragraph()
    p_title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_title.paragraph_format.space_before = Pt(8); p_title.paragraph_format.space_after = Pt(2)
    r1 = p_title.add_run("ĐƠN ĐỀ NGHỊ NGHIỆM THU\n")
    r1.font.name = "Times New Roman"; r1.font.size = Pt(14); r1.font.bold = True
    r2 = p_title.add_run("ĐỀ TÀI NGHIÊN CỨU KHOA HỌC VÀ CÔNG NGHỆ CẤP VIỆN")
    r2.font.name = "Times New Roman"; r2.font.size = Pt(12); r2.font.bold = True
    
    add_p(doc, "Kính gửi:  - Viện trưởng Viện Tế bào gốc\n                   - Phòng Khoa học Công nghệ và Quan hệ đối ngoại", italic=True)
    
    add_p(doc, f"Tôi tên là: {p['leader_name']}, Chủ nhiệm đề tài NCKH cấp Viện.")
    add_p(doc, f"Đơn vị công tác: Nhóm {p['research_group'] or 'Nghiên cứu'}, Viện Tế bào gốc.")
    add_p(doc, f"Được giao thực hiện đề tài theo Quyết định số: {p['decision_number']} ngày {p['decision_date']} của Viện trưởng Viện Tế bào gốc.")
    add_p(doc, f"Tên đề tài: {p['title']}")
    add_p(doc, f"Mã số đề tài: {p['code']}")
    add_p(doc, f"Hợp đồng NCKH số: {contract_num}")
    add_p(doc, f"Thời gian thực hiện theo HĐ: từ {p['decision_date']} đến {p['base_end_date']} (Thời gian hoàn thành thực tế: {p['current_end_date']}).")
    prog_sum = (report_row.get('progress_summary') or '').strip() if report_row else ''
    if prog_sum:
        add_p(doc, f"Tóm tắt kết quả nghiên cứu đã đạt được: {prog_sum}")
    add_p(doc, "Nay Ban chủ nhiệm đã hoàn tất 100% nội dung nghiên cứu theo thuyết minh và giao nộp đầy đủ:")
    add_p(doc, "- 01 Báo cáo tổng kết toàn văn kết quả nghiên cứu & 01 Báo cáo tóm tắt đề tài.")
    add_p(doc, "- Các sản phẩm công bố khoa học (bài báo xuất bản/chấp nhận đăng hoặc giải pháp hữu ích).")
    add_p(doc, "- Sản phẩm đào tạo học viên cao học / cử nhân tốt nghiệp theo đúng hợp đồng.")
    add_p(doc, "Phương án nghiệm thu đề nghị: [X] Nghiệm thu theo Hội đồng Khoa học cấp Viện đánh giá.")
    add_p(doc, "Kính đề nghị Viện trưởng Viện Tế bào gốc và Phòng Kế hoạch tổng hợp xem xét thành lập Hội đồng nghiệm thu đề tài theo quy định.")
    
    add_signatures_2cols(doc, left_title="XÁC NHẬN CỦA PHÒNG KẾ HOẠCH TỔNG HỢP", right_title="CHỦ NHIỆM ĐỀ TÀI",
                         left_sub="(Kiểm tra đủ điều kiện nghiệm thu)", right_sub="(Ký và ghi rõ họ tên)",
                         left_name="Trương Châu Nhật", right_name=p['leader_name'])
    doc.save(out_path)

def generate_autofill_bien_ban_thanh_ly(p, out_path):
    doc = docx.Document()
    set_page_margins_nd30(doc)
    contract_num, contract_date_vn = get_contract_info(p)
    add_header_nd30(doc, code_str="Mẫu: BM-12/SCI-NCKH", date_str="Thành phố Hồ Chí Minh, ngày .... tháng .... năm 20...")
    
    p_title = doc.add_paragraph()
    p_title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_title.paragraph_format.space_before = Pt(8); p_title.paragraph_format.space_after = Pt(2)
    r1 = p_title.add_run("BIÊN BẢN THANH LÝ HỢP ĐỒNG\n")
    r1.font.name = "Times New Roman"; r1.font.size = Pt(14); r1.font.bold = True
    r2 = p_title.add_run("NGHIÊN CỨU KHOA HỌC VÀ PHÁT TRIỂN CÔNG NGHỆ CẤP VIỆN")
    r2.font.name = "Times New Roman"; r2.font.size = Pt(12); r2.font.bold = True
    
    add_p(doc, f"- Căn cứ Hợp đồng NCKH số: {contract_num} {contract_date_vn} đã ký giữa Viện Tế bào gốc và Chủ nhiệm đề tài;")
    add_p(doc, f"- Căn cứ Quyết định giao nhiệm vụ số {p['decision_number']} ngày {p['decision_date']} của Viện trưởng Viện Tế bào gốc;")
    add_p(doc, f"- Căn cứ Biên bản họp Hội đồng đánh giá nghiệm thu đề tài '{p['title']}', Mã số: {p['code']};")
    add_p(doc, "Hôm nay, tại Viện Tế bào gốc, các bên gồm có:")
    
    add_p(doc, "BÊN A: VIỆN TẾ BÀO GỐC (SCI)", font_size=11.5, bold=True)
    add_p(doc, "- Đại diện: PGS. TS. Phạm Văn Phúc                - Chức vụ: Viện trưởng\n- Trương Châu Nhật                             - Chức vụ: Trưởng phòng Kế hoạch tổng hợp")
    
    add_p(doc, "BÊN B: CHỦ NHIỆM ĐỀ TÀI", font_size=11.5, bold=True)
    add_p(doc, f"- Họ và tên: {p['leader_name']}                 - Đơn vị công tác: Nhóm {p['research_group'] or 'Nghiên cứu'}")
    
    budget_val = p['budget_total'] or 50000000
    add_p(doc, "Hai bên cùng thống nhất tiến hành thanh lý Hợp đồng NCKH nêu trên với các nội dung sau:")
    add_p(doc, f"Điều 1. Đánh giá hoàn thành nhiệm vụ: Bên B đã hoàn tất đầy đủ 100% nội dung nghiên cứu đề tài '{p['title']}', nộp Báo cáo tổng kết và các sản phẩm khoa học đào tạo đạt yêu cầu Hội đồng nghiệm thu.")
    add_p(doc, f"Điều 2. Tình hình tài chính và quyết toán kinh phí:\n- Tổng kinh phí theo Hợp đồng: {budget_val:,.0f} VNĐ ({num_to_vietnamese_words(budget_val)})\n- Tổng kinh phí thực tế đã quyết toán hợp lệ: {budget_val:,.0f} VNĐ\n- Số dư kinh phí còn lại: 0 đồng.")
    add_p(doc, f"Điều 3. Hai bên thống nhất thanh lý Hợp đồng số {contract_num}. Kể từ ngày ký Biên bản này, Hợp đồng hết hiệu lực pháp lý và hai bên không còn bất kỳ nghĩa vụ hay khiếu nại nào liên quan.")
    
    add_signatures_3cols(doc, left_title="ĐẠI DIỆN BÊN A\nVIỆN TRƯỞNG", mid_title="TRƯỞNG PHÒNG KẾ HOẠCH TỔNG HỢP", right_title="ĐẠI DIỆN BÊN B\nCHỦ NHIỆM ĐỀ TÀI",
                         left_name="PGS. TS. Phạm Văn Phúc", mid_name="Trương Châu Nhật", right_name=p['leader_name'])
    doc.save(out_path)

def generate_autofill_bien_ban_nghiem_thu(p, out_path):
    doc = docx.Document()
    set_page_margins_nd30(doc)
    contract_num, _ = get_contract_info(p)
    add_header_nd30(doc, code_str="Mẫu: BM-11/SCI-NCKH", date_str="Thành phố Hồ Chí Minh, ngày .... tháng .... năm 20...")
    
    p_title = doc.add_paragraph()
    p_title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_title.paragraph_format.space_before = Pt(8); p_title.paragraph_format.space_after = Pt(2)
    r1 = p_title.add_run("BIÊN BẢN HỌP HỘI ĐỒNG ĐÁNH GIÁ NGHIỆM THU\n")
    r1.font.name = "Times New Roman"; r1.font.size = Pt(13.5); r1.font.bold = True
    r2 = p_title.add_run("ĐỀ TÀI NGHIÊN CỨU KHOA HỌC VÀ CÔNG NGHỆ CẤP VIỆN")
    r2.font.name = "Times New Roman"; r2.font.size = Pt(12); r2.font.bold = True
    
    add_p(doc, f"1. Tên đề tài: {p['title']}")
    add_p(doc, f"2. Mã số đề tài: {p['code']}          - Cơ quan chủ trì: Viện Tế bào gốc")
    add_p(doc, f"3. Chủ nhiệm đề tài: {p['leader_name']} - Đơn vị: Nhóm {p['research_group'] or 'Nghiên cứu'}")
    add_p(doc, f"4. Căn cứ Quyết định giao nhiệm vụ số: {p['decision_number']} ngày {p['decision_date']}")
    add_p(doc, f"5. Căn cứ Hợp đồng NCKH số: {contract_num}")
    add_p(doc, "6. Thành phần Hội đồng đánh giá nghiệm thu:")
    add_p(doc, "1. PGS. TS. Phạm Văn Phúc          - Viện trưởng, Viện Tế bào gốc               - Chủ tịch Hội đồng\n2. Cán bộ phản biện 1                     - Nhà khoa học chuyên ngành                  - Phản biện 1\n3. Cán bộ phản biện 2                     - Nhà khoa học chuyên ngành                  - Phản biện 2\n4. Trương Châu Nhật                    - Trưởng phòng Kế hoạch tổng hợp                   - Thư ký khoa học\n5. Cán bộ chuyên môn                      - Nhà khoa học Viện                          - Ủy viên Hội đồng")
    add_p(doc, "7. Đánh giá của Hội đồng: Đề tài hoàn thành đầy đủ khối lượng, sản phẩm đạt và vượt chỉ tiêu đăng ký trong thuyết minh.")
    add_p(doc, "8. Kết quả đánh giá: ĐẠT LOẠI XUẤT SẮC (5/5 phiếu tán thành thông qua nghiệm thu).")
    
    add_signatures_3cols(doc, left_title="CHỦ TỊCH HỘI ĐỒNG", mid_title="THƯ KÝ KHOA HỌC", right_title="CHỦ NHIỆM ĐỀ TÀI",
                         left_name="PGS. TS. Phạm Văn Phúc", mid_name="Trương Châu Nhật", right_name=p['leader_name'])
    doc.save(out_path)

def generate_autofill_giai_trinh(p, out_path):
    doc = docx.Document()
    set_page_margins_nd30(doc)
    add_header_nd30(doc, code_str="Mẫu: BM-09/SCI-NCKH", date_str="Thành phố Hồ Chí Minh, ngày .... tháng .... năm 20...")
    
    p_title = doc.add_paragraph()
    p_title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_title.paragraph_format.space_before = Pt(8); p_title.paragraph_format.space_after = Pt(2)
    r1 = p_title.add_run("BẢN GIẢI TRÌNH TIẾP THU Ý KIẾN ĐÓNG GÓP\n")
    r1.font.name = "Times New Roman"; r1.font.size = Pt(13.5); r1.font.bold = True
    r2 = p_title.add_run("CỦA HỘI ĐỒNG ĐÁNH GIÁ NGHIỆM THU ĐỀ TÀI CẤP VIỆN")
    r2.font.name = "Times New Roman"; r2.font.size = Pt(12); r2.font.bold = True
    
    add_p(doc, "Kính gửi:  - Hội đồng đánh giá nghiệm thu đề tài cấp Viện\n                   - Viện trưởng Viện Tế bào gốc", italic=True)
    
    add_p(doc, f"Tên đề tài: {p['title']}")
    add_p(doc, f"Mã số đề tài: {p['code']}")
    add_p(doc, f"Chủ nhiệm đề tài: {p['leader_name']}")
    add_p(doc, "Sau khi tiếp thu đầy đủ các ý kiến nhận xét của Hội đồng nghiệm thu, Ban chủ nhiệm đề tài đã nghiêm túc rà soát, chỉnh sửa và bổ sung vào Báo cáo tổng kết toàn văn như sau:")
    
    t_gt = doc.add_table(rows=4, cols=4)
    t_gt.alignment = WD_TABLE_ALIGNMENT.CENTER
    apply_table_border(t_gt)
    headers_gt = ["STT", "Ý kiến đóng góp của Hội đồng", "Nội dung đã tiếp thu, chỉnh sửa chi tiết\n(ghi rõ số trang, mục)", "Ý kiến giải trình thêm"]
    widths_gt = [Inches(0.5), Inches(2.7), Inches(2.7), Inches(1.1)]
    for i, h in enumerate(headers_gt):
        c = t_gt.cell(0, i); c.width = widths_gt[i]
        set_cell_margins(c); set_cell_shd(c, "F1F5F9")
        para = c.paragraphs[0]; para.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = para.add_run(h); r.font.name = "Times New Roman"; r.font.size = Pt(10); r.font.bold = True
        
    sample_rows = [
        ("1", "Rà soát định dạng bảng biểu và trích dẫn theo chuẩn APA", "Đã chuẩn hóa 100% tài liệu tham khảo và bảng số liệu tại Chương 3 và Chương 4", "Đã hoàn tất"),
        ("2", "Bổ sung minh chứng công nhận tốt nghiệp của học viên", "Đã đính kèm bản sao Quyết định công nhận tốt nghiệp vào Phụ lục minh chứng đào tạo", "Đã hoàn tất"),
        ("3", "Hoàn tất thủ tục thanh lý hợp đồng NCKH", "Đã đối chiếu kho và lập Biên bản thanh lý hợp đồng tài chính", "Đã hoàn tất")
    ]
    for r_i, (c0, c1, c2, c3) in enumerate(sample_rows, 1):
        for c_idx, val in enumerate([c0, c1, c2, c3]):
            c = t_gt.cell(r_i, c_idx); c.width = widths_gt[c_idx]
            set_cell_margins(c)
            para = c.paragraphs[0]
            if c_idx in [0, 3]: para.alignment = WD_ALIGN_PARAGRAPH.CENTER
            r = para.add_run(val); r.font.name = "Times New Roman"; r.font.size = Pt(10)

    doc.add_paragraph()
    add_p(doc, "Kính đề nghị Chủ tịch Hội đồng và Thư ký khoa học xem xét, xác nhận để Chủ nhiệm tiến hành thanh lý Hợp đồng theo quy định.")
    
    add_signatures_3cols(doc, left_title="XÁC NHẬN CỦA CHỦ TỊCH HĐ", mid_title="THƯ KÝ KHOA HỌC HỘI ĐỒNG", right_title="CHỦ NHIỆM ĐỀ TÀI",
                         left_name="PGS. TS. Phạm Văn Phúc", mid_name="Trương Châu Nhật", right_name=p['leader_name'])
    doc.save(out_path)

# ==================== MAIN DISPATCHER ====================

def generate_autofill_quyet_dinh_giao_nhiem_vu(p, out_path):
    doc = docx.Document()
    set_page_margins_nd30(doc)
    dec_date_vn = format_date_vn(p.get('decision_date'))
    dec_num = p.get('decision_number') or f"QĐ-SCI/{p['code'].replace('/', '.')}"
    add_header_nd30(doc, code_str=f"Số: {dec_num}", date_str=f"Thành phố Hồ Chí Minh, {dec_date_vn}")
    
    p_title = doc.add_paragraph()
    p_title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_title.paragraph_format.space_before = Pt(8); p_title.paragraph_format.space_after = Pt(2)
    r1 = p_title.add_run("QUYẾT ĐỊNH\n")
    r1.font.name = "Times New Roman"; r1.font.size = Pt(14); r1.font.bold = True
    year_str = p.get('decision_date', '2026')[:4] if p.get('decision_date') else '2026'
    r2 = p_title.add_run(f"Về việc phê duyệt thuyết minh và giao nhiệm vụ KH&CN cấp cơ sở năm {year_str}")
    r2.font.name = "Times New Roman"; r2.font.size = Pt(11.5); r2.font.bold = True; r2.font.italic = True
    
    p_signer = doc.add_paragraph()
    p_signer.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_signer.paragraph_format.space_before = Pt(6); p_signer.paragraph_format.space_after = Pt(6)
    r_sg = p_signer.add_run("VIỆN TRƯỞNG VIỆN TẾ BÀO GỐC")
    r_sg.font.name = "Times New Roman"; r_sg.font.size = Pt(12.5); r_sg.font.bold = True
    
    add_p(doc, "- Căn cứ Quyết định số 890a/QĐ-KHTN ngày 12 tháng 6 năm 2017 của Hiệu trưởng Trường Đại học Khoa học tự nhiên, ĐHQG-HCM về việc thành lập Viện Tế bào gốc;")
    add_p(doc, "- Căn cứ Quy chế tổ chức và hoạt động của Viện Tế bào gốc;")
    add_p(doc, "- Căn cứ Biên bản họp Hội đồng xét duyệt đề cương đề tài nghiên cứu khoa học cấp cơ sở;")
    add_p(doc, "- Theo đề nghị của Trưởng phòng Khoa học & Công nghệ và Quan hệ Đối ngoại,")
    
    p_decide = doc.add_paragraph()
    p_decide.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_decide.paragraph_format.space_before = Pt(6); p_decide.paragraph_format.space_after = Pt(4)
    r_dc = p_decide.add_run("QUYẾT ĐỊNH:")
    r_dc.font.name = "Times New Roman"; r_dc.font.size = Pt(12.5); r_dc.font.bold = True
    
    budget_val = p.get('budget_total') or 50000000
    words_budget = num_to_vietnamese_words(budget_val)
    dur_months = p.get('duration_months') or 12
    end_date = p.get('base_end_date') or '31/12/2026'
    
    add_p(doc, "Điều 1. Phê duyệt thuyết minh đề tài nghiên cứu khoa học và phát triển công nghệ cấp cơ sở:", bold=True)
    add_p(doc, f"- Tên đề tài: {p['title']}")
    add_p(doc, f"- Mã số đề tài: {p['code']}")
    add_p(doc, f"- Chủ nhiệm đề tài: {p['leader_name']}")
    add_p(doc, f"- Đơn vị / Nhóm nghiên cứu: Nhóm {p.get('research_group') or 'Stem Cell Biology'}, Viện Tế bào gốc")
    add_p(doc, f"- Thành viên tham gia nghiên cứu: {p.get('members') or 'Cán bộ, học viên thuộc nhóm nghiên cứu'}")
    add_p(doc, f"- Thời gian thực hiện: {dur_months} tháng, kể từ ngày ký Quyết định đến ngày {end_date}.")
    
    add_p(doc, f"Điều 2. Tổng kinh phí thực hiện đề tài là {budget_val:,.0f} VNĐ ({words_budget}). Nguồn kinh phí từ quỹ Nghiên cứu Khoa học thường xuyên của Viện Tế bào gốc.")
    add_p(doc, "Điều 3. Chủ nhiệm đề tài có trách nhiệm tổ chức triển khai nghiên cứu theo đúng thuyết minh đã phê duyệt, ký kết Hợp đồng NCKH với Viện, định kỳ báo cáo tiến độ 06 tháng và thực hiện nghiệm thu, quyết toán theo đúng quy định hiện hành.")
    add_p(doc, "Điều 4. Trưởng phòng Kế hoạch tổng hợp, Trưởng phòng TCHC, Trưởng phòng TC-CƯ và Chủ nhiệm đề tài có tên tại Điều 1 chịu trách nhiệm thi hành Quyết định này.")
    
    # Bảng chữ ký
    p_sp = doc.add_paragraph()
    p_sp.paragraph_format.space_before = Pt(8); p_sp.paragraph_format.space_after = Pt(4)
    tbl = doc.add_table(rows=2, cols=2)
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER; tbl.autofit = False
    tbl.cell(0, 0).width = Inches(3.2); tbl.cell(0, 1).width = Inches(3.8)
    tbl.cell(1, 0).width = Inches(3.2); tbl.cell(1, 1).width = Inches(3.8)
    
    p_nn = tbl.cell(0, 0).paragraphs[0]
    p_nn.paragraph_format.line_spacing = 1.05
    r_nn = p_nn.add_run("Nơi nhận:\n")
    r_nn.font.name = "Times New Roman"; r_nn.font.size = Pt(10); r_nn.font.bold = True; r_nn.font.italic = True
    r_nn_list = p_nn.add_run("- Ban Giám đốc Viện;\n- Như Điều 4;\n- Lưu: VT, KHCN.")
    r_nn_list.font.name = "Times New Roman"; r_nn_list.font.size = Pt(9.5)
    
    p_vt = tbl.cell(0, 1).paragraphs[0]
    p_vt.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r_vt = p_vt.add_run("VIỆN TRƯỞNG\n")
    r_vt.font.name = "Times New Roman"; r_vt.font.size = Pt(12); r_vt.font.bold = True
    r_sub = p_vt.add_run("(Ký, ghi rõ họ tên và đóng dấu)\n\n\n\n")
    r_sub.font.name = "Times New Roman"; r_sub.font.size = Pt(10); r_sub.font.italic = True
    r_name = p_vt.add_run("PGS. TS. Phạm Văn Phúc")
    r_name.font.name = "Times New Roman"; r_name.font.size = Pt(12); r_name.font.bold = True
    
    for row in tbl.rows:
        for cell in row.cells:
            tcPr = cell._tc.get_or_add_tcPr()
            tcBorders = parse_xml(f'<w:tcBorders {nsdecls("w")}><w:top w:val="none"/><w:left w:val="none"/><w:bottom w:val="none"/><w:right w:val="none"/></w:tcBorders>')
            tcPr.append(tcBorders)
            
    doc.save(out_path)

def main():
    if len(sys.argv) < 4:
        print("Usage: python export_autofill_doc.py <project_id> <doc_key> <out_path> [record_id]")
        sys.exit(1)
        
    project_id = sys.argv[1]
    doc_key = sys.argv[2]
    out_path = sys.argv[3]
    record_id = sys.argv[4] if len(sys.argv) >= 5 and sys.argv[4] else None
    key_upper = doc_key.upper()
    
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM nckh_projects WHERE id = ?", (project_id,))
    row = cursor.fetchone()
    
    if not row:
        conn.close()
        print(f"Error: Project with ID {project_id} not found.")
        sys.exit(2)
        
    p = dict(row)

    # 1. Lấy dữ liệu Gia hạn từ bảng nckh_extensions (phục vụ Đơn gia hạn mục 11)
    ext_row = None
    try:
        if record_id and 'GIA_HAN' in key_upper:
            cursor.execute("SELECT * FROM nckh_extensions WHERE id = ? AND project_id = ?", (record_id, project_id))
            r_ext = cursor.fetchone()
            if r_ext:
                ext_row = dict(r_ext)
        if not ext_row:
            if 'GIA_HAN_1' in key_upper:
                cursor.execute("SELECT * FROM nckh_extensions WHERE project_id = ? AND extension_num = 1 ORDER BY id DESC LIMIT 1", (project_id,))
                r_ext = cursor.fetchone()
                if r_ext:
                    ext_row = dict(r_ext)
            elif 'GIA_HAN_2' in key_upper:
                cursor.execute("SELECT * FROM nckh_extensions WHERE project_id = ? AND extension_num = 2 ORDER BY id DESC LIMIT 1", (project_id,))
                r_ext = cursor.fetchone()
                if r_ext:
                    ext_row = dict(r_ext)
        if not ext_row:
            cursor.execute("""
                SELECT * FROM nckh_extensions
                WHERE project_id = ?
                ORDER BY CASE WHEN reason IS NOT NULL AND TRIM(reason) != '' THEN 0 ELSE 1 END,
                         extension_num DESC, id DESC
                LIMIT 1
            """, (project_id,))
            r_ext = cursor.fetchone()
            if r_ext:
                ext_row = dict(r_ext)
    except Exception:
        pass

    # 2. Lấy dữ liệu Báo cáo định kỳ 6 tháng từ bảng nckh_periodic_reports
    report_row = None
    try:
        if record_id and ('BAO_CAO_6' in key_upper or 'BAO_CAO_DINH_KY' in key_upper):
            cursor.execute("SELECT * FROM nckh_periodic_reports WHERE id = ? AND project_id = ?", (record_id, project_id))
            r_rep = cursor.fetchone()
            if r_rep:
                report_row = dict(r_rep)
        if not report_row:
            cursor.execute("""
                SELECT * FROM nckh_periodic_reports
                WHERE project_id = ?
                ORDER BY CASE WHEN progress_summary IS NOT NULL AND TRIM(progress_summary) != '' THEN 0 ELSE 1 END,
                         period_num DESC, id DESC
                LIMIT 1
            """, (project_id,))
            r_rep = cursor.fetchone()
            if r_rep:
                report_row = dict(r_rep)
    except Exception:
        pass

    # 3. Lấy dữ liệu Điều chỉnh dự toán từ bảng nckh_budget_adjustments
    adj_row = None
    try:
        if record_id and ('DIEU_CHINH' in key_upper or 'TO_TRINH' in key_upper or 'DU_TOAN' in key_upper):
            cursor.execute("SELECT * FROM nckh_budget_adjustments WHERE id = ? AND project_id = ?", (record_id, project_id))
            r_adj = cursor.fetchone()
            if r_adj:
                adj_row = dict(r_adj)
        if not adj_row:
            cursor.execute("""
                SELECT old_budget, new_budget, difference_amount, reason, proposal_details,
                       adjustment_num, request_date, status, khcn_opinion, decision_number,
                       decision_date, director_decision
                FROM nckh_budget_adjustments
                WHERE project_id = ?
                ORDER BY adjustment_num DESC, id DESC
                LIMIT 1
            """, (project_id,))
            r_adj = cursor.fetchone()
            if r_adj:
                adj_row = dict(r_adj)
    except Exception:
        pass

    conn.close()
    
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    
    if 'DIEU_CHINH_DU_TOAN' in key_upper or 'TO_TRINH' in key_upper or ('DIEU_CHINH' in key_upper and 'DU_TOAN' in key_upper):
        generate_autofill_to_trinh_dieu_chinh_du_toan(p, out_path, adj_row)
    elif 'QD_PHE_DUYET' in key_upper or 'GIAO_NHIEM_VU' in key_upper or 'QUYET_DINH' in key_upper or 'QD' in key_upper:
        generate_autofill_quyet_dinh_giao_nhiem_vu(p, out_path)
    elif 'HOP_DONG' in key_upper:
        generate_autofill_hop_dong(p, out_path)
    elif 'BAO_CAO_6' in key_upper or 'BAO_CAO_DINH_KY' in key_upper:
        generate_autofill_bao_cao_6thang(p, out_path, report_row)
    elif 'GIA_HAN' in key_upper:
        generate_autofill_don_gia_han(p, out_path, ext_row, doc_key, report_row)
    elif 'DON_NGHIEM_THU' in key_upper or ('NGHIEM_THU' in key_upper and 'BIEN_BAN' not in key_upper and 'BB' not in key_upper):
        generate_autofill_don_nghiem_thu(p, out_path, report_row)
    elif 'BIEN_BAN_THANH_LY' in key_upper or 'THANH_LY' in key_upper:
        generate_autofill_bien_ban_thanh_ly(p, out_path)
    elif 'BIEN_BAN_NGHIEM_THU' in key_upper or 'BB_NGHIEM_THU' in key_upper:
        generate_autofill_bien_ban_nghiem_thu(p, out_path)
    elif 'GIAI_TRINH' in key_upper:
        generate_autofill_giai_trinh(p, out_path)
    else:
        generate_autofill_hop_dong(p, out_path)
        
    print(f"[SUCCESS] Auto-filled document generated at: {out_path}")

if __name__ == "__main__":
    main()
