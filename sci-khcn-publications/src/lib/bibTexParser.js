/**
 * Parse nội dung BibTeX (.bib) → danh sách object thống nhất cho import.
 * Dùng package bibtex-parse (không giải mã LaTeX đầy đủ).
 */

import { entries as bibEntries } from 'bibtex-parse';

/** Map loại entry BibTeX → nhãn pub_type (tiếng Việt) theo spec import. */
function mapBibTypeToPubTypeLabel(bibType) {
  const t = String(bibType || '').toLowerCase().trim();
  if (t === 'article') return 'Bài báo tạp chí';
  if (t === 'inproceedings' || t === 'conference') return 'Kỷ yếu hội nghị';
  if (t === 'incollection' || t === 'inbook' || t === 'book') return 'Chương sách / Sách';
  return 'Khác';
}

/** Đưa chuỗi tác giả BibTeX (and) về dạng "Họ A, Họ B". */
function authorsBibToCommaString(raw) {
  if (raw == null || String(raw).trim() === '') return '';
  return String(raw)
    .split(/\s+and\s+/i)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ');
}

function pickField(entry, ...keys) {
  for (const k of keys) {
    const v = entry[k];
    if (v != null && String(v).trim() !== '') return v;
  }
  return null;
}

function toNumberYear(y) {
  if (y == null || y === '') return null;
  const n = typeof y === 'number' ? y : parseInt(String(y).replace(/[^0-9-]/g, '').slice(0, 5), 10);
  return Number.isFinite(n) ? n : null;
}

function cleanDoi(d) {
  if (d == null || String(d).trim() === '') return null;
  let s = String(d).trim();
  const m = /^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i.exec(s);
  if (m) s = s.slice(m[0].length).trim();
  s = s.replace(/^doi:\s*/i, '').trim();
  return s || null;
}

/** Strip common LaTeX / Scholar quirks from TITLE before storing (no lowercase). */
function cleanBibTitle(raw) {
  if (!raw) return null;
  const s = String(raw)
    .replace(/\\&/g, '&')
    .replace(/\\%/g, '%')
    .replace(/\{([^{}]*)\}/g, '$1')
    .replace(/[\u2010\u2011\u2012\u2013\u2014]/g, '-')
    .replace(/\s*[…\.]{2,}\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s || null;
}

/**
 * @param {string} rawText — toàn bộ file .bib
 * @returns {Array<object>}
 */
export function parseBibTeX(rawText) {
  const text = String(rawText || '');
  if (!text.trim()) return [];

  const parsed = bibEntries(text);
  const out = [];

  for (const ent of parsed) {
    if (!ent || !ent.type) continue;

    const title = cleanBibTitle(pickField(ent, 'TITLE', 'Title'));
    const authorRaw = pickField(ent, 'AUTHOR', 'Author', 'EDITOR', 'Editor');
    const authors = authorsBibToCommaString(authorRaw);
    const year = toNumberYear(pickField(ent, 'YEAR', 'Year', 'DATE', 'Date'));
    const journal =
      pickField(ent, 'JOURNAL', 'Journal', 'BOOKTITLE', 'Booktitle') || null;
    const volume = pickField(ent, 'VOLUME', 'Volume') ?? null;
    const number = pickField(ent, 'NUMBER', 'Number', 'ISSUE', 'Issue') ?? null;
    const pages = pickField(ent, 'PAGES', 'Pages') ?? null;
    const doi = cleanDoi(pickField(ent, 'DOI', 'Doi'));
    const abstract = pickField(ent, 'ABSTRACT', 'Abstract') ?? null;
    const url = pickField(ent, 'URL', 'Url', 'LINK', 'Link') ?? null;
    const keywords = pickField(ent, 'KEYWORDS', 'Keywords') ?? null;
    const note = pickField(ent, 'NOTE', 'Note', 'ANNOTE', 'Annote') ?? null;
    const pub_type = mapBibTypeToPubTypeLabel(ent.type);

    out.push({
      title,
      authors,
      year,
      journal,
      volume: volume != null ? String(volume) : null,
      number: number != null ? String(number) : null,
      pages: pages != null ? String(pages) : null,
      doi,
      abstract,
      url,
      keywords,
      note,
      pub_type,
    });
  }

  return out;
}

/**
 * Ánh xạ nhãn tiếng Việt pub_type từ parse → slug cột publications.pub_type.
 */
export function pubTypeLabelToSlug(label) {
  const s = String(label || '').trim();
  if (s === 'Bài báo tạp chí') return 'journal';
  if (s === 'Kỷ yếu hội nghị') return 'conference';
  if (s === 'Chương sách / Sách') return 'book_chapter';
  return 'journal';
}
