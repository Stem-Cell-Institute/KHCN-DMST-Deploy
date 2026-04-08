#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sàng lọc định danh tác giả (standalone) — tương đương logic trên server Node.
Chạy ngoài web: đọc CSV/JSON, xuất CSV có cột Trust_Score và classification.

Cài đặt:
  pip install pandas beautifulsoup4 requests

Lưu ý:
  - Selenium không bắt buộc; nhiều trang chỉ cần HTML tĩnh (BeautifulSoup).
  - Tôn trọng robots.txt và tần suất request khi crawl hàng loạt.
"""

from __future__ import annotations

import argparse
import json
import re
import time
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd
import requests
from bs4 import BeautifulSoup

# --- Bước 1: từ khóa (lowercase) ---
KW_STRONG = [
    "stem cell",
    "mesenchymal",
    "exosome",
    "regenerative",
    "cancer stem cell",
    "ipsc",
    "prp",
]
KW_MEDIUM = ["nanoparticle", "curcumin", "extract", "apoptosis"]

POSITIVE_AFF = [
    "university of science",
    "vnu-hcm",
    "vnu hcm",
    "stem cell institute",
    "laboratory of stem cell research and application",
]
NEGATIVE_AFF = [
    "vietnam academy of science and technology",
    "vast",
    "hanoi",
]
KNOWN_COAUTHORS = [
    "phan kim ngoc",
    "truong dinh kiet",
    "le van dong",
    "vu bich ngoc",
]

UA = "Mozilla/5.0 (compatible; SCI-KHCN-disambiguation-script/1.0)"


def score_keywords_and_year(title: str, year: Any) -> int:
    """Bước 1–2: điểm từ tiêu đề + mốc năm."""
    score = 0
    t = (title or "").lower()
    for kw in KW_STRONG:
        if kw in t:
            score += 10
    for kw in KW_MEDIUM:
        if kw in t:
            score += 5
    try:
        y = int(year) if year is not None and str(year).strip() != "" else None
    except (TypeError, ValueError):
        y = None
    if y is not None:
        if y >= 2007:
            score += 5
        if y < 2005:
            score -= 20
    return score


def fetch_page_text_lower(url: str, timeout: float = 15.0) -> Tuple[bool, str, Optional[str]]:
    """Tải trang và trả chuỗi chữ thường (để so khớp affiliation)."""
    if not url or not str(url).strip():
        return False, "", "invalid_or_missing_url"
    u = str(url).strip()
    if not u.startswith(("http://", "https://")):
        return False, "", "invalid_or_missing_url"
    try:
        r = requests.get(u, timeout=timeout, headers={"User-Agent": UA})
        if not r.ok:
            return False, "", f"http_{r.status_code}"
        soup = BeautifulSoup(r.text, "html.parser")
        for tag in soup(["script", "style", "noscript"]):
            tag.decompose()
        text = soup.get_text(separator=" ", strip=True)
        text = re.sub(r"\s+", " ", text).lower()
        return True, text, None
    except requests.RequestException as e:
        return False, "", str(e)


def score_affiliation_from_text(page_lower: str) -> Tuple[int, Dict[str, List[str]]]:
    """Bước 3: cộng/trừ điểm theo nội dung trang."""
    delta = 0
    matched: Dict[str, List[str]] = {"positive": [], "negative": [], "coauthors": []}
    if not page_lower:
        return delta, matched
    for m in POSITIVE_AFF:
        if m in page_lower:
            delta += 100
            matched["positive"].append(m)
            break
    for m in NEGATIVE_AFF:
        if m in page_lower:
            delta -= 100
            matched["negative"].append(m)
            break
    for name in KNOWN_COAUTHORS:
        if name in page_lower:
            delta += 50
            matched["coauthors"].append(name)
    return delta, matched


def classify_trust_score(score: int) -> str:
    if score > 80:
        return "High Confidence - Keep"
    if 0 <= score <= 80:
        return "Manual Review Needed"
    return "Exclude"


def disambiguate_records(
    rows: List[Dict[str, Any]],
    crawl_delay_sec: float = 0.45,
    do_crawl: bool = True,
) -> List[Dict[str, Any]]:
    """Chạy toàn bộ pipeline cho danh sách dict có id, title, year, detail_url."""
    out: List[Dict[str, Any]] = []
    for row in rows:
        title = row.get("title", "")
        year = row.get("year")
        detail_url = row.get("detail_url") or row.get("detailUrl") or ""
        rid = row.get("id")

        score = score_keywords_and_year(title, year)
        crawl_note = "no_detail_url"
        if do_crawl and detail_url:
            ok, text, err = fetch_page_text_lower(detail_url)
            if ok:
                d_aff, matched = score_affiliation_from_text(text)
                score += d_aff
                crawl_note = json.dumps(matched, ensure_ascii=False)
            else:
                crawl_note = f"crawl: {err}"
            time.sleep(crawl_delay_sec)
        out.append(
            {
                "id": rid,
                "title": title,
                "year": year,
                "detail_url": detail_url or None,
                "trust_score": score,
                "classification": classify_trust_score(score),
                "crawl_note": crawl_note,
            }
        )
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Academic author disambiguation (standalone)")
    parser.add_argument("--input", required=True, help="CSV hoặc JSON (mảng object)")
    parser.add_argument("--output", default="disambiguation_out.csv", help="CSV đầu ra")
    parser.add_argument("--no-crawl", action="store_true", help="Chỉ keyword + năm, không tải URL")
    args = parser.parse_args()

    path = args.input
    if path.lower().endswith(".json"):
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, list):
            raise SystemExit("JSON phải là mảng các object")
        rows = data
    else:
        df_in = pd.read_csv(path)
        rows = df_in.to_dict("records")

    results = disambiguate_records(rows, do_crawl=not args.no_crawl)
    df_out = pd.DataFrame(results)
    df_out.to_csv(args.output, index=False, encoding="utf-8-sig")
    print(f"Đã ghi {len(results)} dòng → {args.output}")


if __name__ == "__main__":
    main()
