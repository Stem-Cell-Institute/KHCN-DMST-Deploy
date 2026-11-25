/**
 * Helper thống kê đối tác hợp tác và xử lý thời hạn thỏa thuận (HTQT).
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const db = require('../lib/db-bridge');

module.exports = function createCooperationPartnerHelpers() {
  function cooperationComputePartnerStats() {
    const thoaThuans = db.prepare('SELECT id, ten, doi_tac, loai, het_han, trang_thai, quoc_gia, loai_doi_tac FROM cooperation_thoa_thuan').all();
    const mouDeXuats = db.prepare('SELECT id, ten_doi_tac, quoc_gia, loai_thoa_thuan, status FROM cooperation_mou_de_xuat').all();
    let missions = [];
    try {
      missions = db.prepare('SELECT id, cooperating_units, status FROM missions WHERE cooperating_units IS NOT NULL AND cooperating_units != \'\'').all();
    } catch (e) { /* bảng missions có thể chưa có cột */ }
    const partnerMap = new Map();
    const normalize = (s) => (s || '').trim().toLowerCase();
    const addPartner = (name, source, extra) => {
      const key = normalize(name);
      if (!key) return;
      if (!partnerMap.has(key)) {
        partnerMap.set(key, { name: (name || '').trim(), country: '', loai_doi_tac: null, agreements: [], proposals: [], projectCount: 0 });
      }
      const p = partnerMap.get(key);
      if (source === 'thoa_thuan' && extra) {
        p.agreements.push(extra);
        if (extra.quoc_gia) p.country = extra.quoc_gia;
        if (extra.loai_doi_tac) p.loai_doi_tac = extra.loai_doi_tac;
      }
      if (source === 'mou' && extra) {
        p.proposals.push(extra);
        if (extra.quoc_gia) p.country = extra.quoc_gia;
      }
    };
    for (const r of thoaThuans || []) {
      addPartner(r.doi_tac, 'thoa_thuan', { loai: r.loai, trang_thai: r.trang_thai, het_han: r.het_han, ten: r.ten, quoc_gia: r.quoc_gia, loai_doi_tac: r.loai_doi_tac });
    }
    for (const r of mouDeXuats || []) {
      addPartner(r.ten_doi_tac, 'mou', { quoc_gia: r.quoc_gia, loai: r.loai_thoa_thuan, status: r.status });
    }
    for (const p of partnerMap.values()) {
      const name = (p.name || '').toLowerCase();
      for (const m of missions) {
        const cu = (m.cooperating_units || '').toLowerCase();
        if (cu && name && (cu.includes(name) || name.split(/\s+/).some(w => w.length > 3 && cu.includes(w)))) {
          p.projectCount++;
        }
      }
    }
    const partners = Array.from(partnerMap.values()).map(p => ({
      name: p.name,
      country: p.country,
      loai_doi_tac: p.loai_doi_tac,
      agreements: p.agreements,
      proposals: p.proposals,
      projectCount: p.projectCount,
      bestAgreementStatus: p.agreements.length ? (p.agreements.find(a => a.trang_thai === 'hieu_luc') ? 'hieu_luc' : p.agreements.find(a => a.trang_thai === 'sap_het_han') ? 'sap_het_han' : p.agreements[0].trang_thai) : null,
      bestAgreementLoai: p.agreements.length ? p.agreements[0].loai : null,
      hasProposal: p.proposals.length > 0
    })).sort((a, b) => (b.agreements.length + b.proposals.length + b.projectCount) - (a.agreements.length + a.proposals.length + a.projectCount));
    const inferLoai = (p) => {
      if (p.loai_doi_tac) return p.loai_doi_tac;
      const q = (p.country || '').toLowerCase();
      if (q.includes('việt nam') || q.includes('viet nam') || q.includes('vn')) return 'trong_nuoc';
      return 'quoc_te';
    };
    const stats = {
      quoc_te: partners.filter(p => inferLoai(p) === 'quoc_te').length,
      trong_nuoc: partners.filter(p => inferLoai(p) === 'trong_nuoc').length,
      doanh_nghiep: partners.filter(p => inferLoai(p) === 'doanh_nghiep').length,
      dia_phuong: partners.filter(p => inferLoai(p) === 'dia_phuong').length
    };
    const countries = new Set(partners.map(p => (p.country || '').trim()).filter(Boolean));
    return { partners, stats: { ...stats, so_quoc_gia: countries.size }, total: partners.length };
  }

  /** Form field / JSON: treat common truthy strings as true (multipart sends strings). */
  function thoaThuanParseOpenEndedFlag(v) {
    if (v === true || v === 1) return true;
    const s = String(v ?? '').trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'on' || s === 'yes';
  }

  function thoaThuanAutoStatusByExpiry(hetHanText) {
    const s = String(hetHanText || '').trim();
    if (!s) return 'hieu_luc';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return 'hieu_luc';
    const exp = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!Number.isFinite(exp.getTime())) return 'hieu_luc';
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const plus3 = new Date(today.getTime()); plus3.setMonth(plus3.getMonth() + 3);
    if (exp < today) return 'het_han';
    if (exp <= plus3) return 'sap_het_han';
    return 'hieu_luc';
  }

  /** Expiry = signing date + N calendar years (same month/day; JS normalizes leap years). Returns YYYY-MM-DD or null. */
  function thoaThuanHetHanFromSigningYears(ngayKyText, yearsNum) {
    const s = String(ngayKyText || '').trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const d = parseInt(m[3], 10);
    const years = parseInt(String(yearsNum).trim(), 10);
    if (!Number.isFinite(years) || years < 1 || years > 99) return null;
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    dt.setFullYear(dt.getFullYear() + years);
    const yy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  }

  return {
    cooperationComputePartnerStats,
    thoaThuanAutoStatusByExpiry,
    thoaThuanHetHanFromSigningYears,
    thoaThuanParseOpenEndedFlag,
  };
};
