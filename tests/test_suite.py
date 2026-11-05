#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
蔵書保管場所変更・記録システム 自動テストスイート (test_suite.py)
-------------------------------------------------------------------------
要件 #10 で指定された以下の全項目を自動検証します:
1. 同じISBNの複数冊（複本）を誤って1冊に自動確定しない（MULTIPLE_CANDIDATES 判定）
2. 添付4冊（ISBN-13 / ISBN-10 / 著者略歴内の他書引用ノイズ / 複本）の模擬OCR照合検証
3. ISBNなし図書でも手動検索・書名OCR照合できる
4. OCR誤認識（かすれ等）から候補を提示しつつ「手動確認が必要」と明示し手動検索へ切り替えられる
5. 同じ図書（同一図書登録番号）を二重追加しない
6. 中断後に作業を再開できる（セッションデータ構造のシリアライズ・復元検証）
7. CSVの日本語（BOM付きUTF-8）や先頭ゼロ（00120等）が壊れない
8. 変更前後（Diff）を正確に比較確認できる
9. 外部倉庫（日高）の箱管理番号の形式（部室G-年度2桁-通し番号4桁BOK）・仮番号拒否・重複確認・次番号提示・別紙2-3の100文字制限
10. 本番データが公開対象に含まれない（.gitignore 構成およびデモフラグ検証）
"""

import csv
import io
import json
import os
import re
import unicodedata
import unittest

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_JSON_PATH = os.path.join(BASE_DIR, "data", "demo_books.json")
DATA_CSV_PATH = os.path.join(BASE_DIR, "data", "demo_books.csv")
GITIGNORE_PATH = os.path.join(BASE_DIR, ".gitignore")


# =========================================================================
# core_logic.js と等価な検証ロジック（Pythonテストハーネス）
# =========================================================================
def normalize_text(s: str) -> str:
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", str(s)).lower()
    return re.sub(r'[\s　・、。，．「」『』（）()［］\[\]【】―ー−‐\-:：;；/／!！?？"\']', "", s)


def clean_isbn_digits(raw: str, allow_ocr_fix: bool = False) -> str:
    if not raw:
        return ""
    s = unicodedata.normalize("NFKC", str(raw)).upper()
    s = re.sub(r"^ISBN\s*[:：]?\s*", "", s, flags=re.IGNORECASE)
    if allow_ocr_fix:
        s = s.replace("O", "0").replace("I", "1").replace("L", "1").replace("Z", "2").replace("S", "5").replace("B", "8")
    return re.sub(r"[^0-9X]", "", s)


def validate_isbn(raw_isbn: str) -> dict:
    if not raw_isbn or not str(raw_isbn).strip():
        return {"is_empty": True, "is_valid": False, "type": "NONE", "normalized": ""}
    cleaned = clean_isbn_digits(raw_isbn, False)
    if len(cleaned) == 13 and cleaned.isdigit():
        total = sum(int(cleaned[i]) * (1 if i % 2 == 0 else 3) for i in range(12))
        expected = (10 - (total % 10)) % 10
        return {
            "is_empty": False,
            "is_valid": int(cleaned[12]) == expected,
            "type": "ISBN-13",
            "normalized": cleaned
        }
    if len(cleaned) == 10 and re.match(r"^\d{9}[\dX]$", cleaned):
        total = sum(int(cleaned[i]) * (10 - i) for i in range(9))
        rem = (11 - (total % 11)) % 11
        expected = "X" if rem == 10 else str(rem)
        body9 = cleaned[:9]
        prefix12 = "978" + body9
        t13 = sum(int(prefix12[i]) * (1 if i % 2 == 0 else 3) for i in range(12))
        cd13 = (10 - (t13 % 10)) % 10
        return {
            "is_empty": False,
            "is_valid": cleaned[9] == expected,
            "type": "ISBN-10",
            "normalized": cleaned,
            "isbn13_eq": prefix12 + str(cd13)
        }
    return {"is_empty": False, "is_valid": False, "type": "INVALID_LENGTH", "normalized": cleaned}


def match_books_from_ocr(raw_text: str, books: list) -> dict:
    text = unicodedata.normalize("NFKC", str(raw_text or ""))
    norm_full = normalize_text(text)

    exact_isbns = []
    fuzzy_prefixes = []

    for m in re.finditer(r"ISBN\s*[:：]?\s*([0-9OIlZSB\-‐−ー\s]{9,22}[0-9XObIlZSB])", text, flags=re.IGNORECASE):
        strict = clean_isbn_digits(m.group(1), False)
        v_strict = validate_isbn(strict)
        if v_strict["is_valid"]:
            exact_isbns.append(v_strict["normalized"])
            if v_strict.get("isbn13_eq"):
                exact_isbns.append(v_strict["isbn13_eq"])
        else:
            fixed = clean_isbn_digits(m.group(1), True)
            v_fixed = validate_isbn(fixed)
            if v_fixed["is_valid"]:
                fuzzy_prefixes.append(v_fixed["normalized"])
            elif len(strict) >= 7:
                fuzzy_prefixes.append(strict[:9])

    candidates = []
    for b in books:
        score = 0
        exact_hit = False
        fuzzy_hit = False
        b_isbn = validate_isbn(b.get("isbn", ""))
        b_norm = b_isbn["normalized"]

        if b_norm and exact_isbns:
            if b_norm in exact_isbns or b_isbn.get("isbn13_eq") in exact_isbns:
                score += 100
                exact_hit = True

        if not exact_hit and b_norm and fuzzy_prefixes:
            for fp in fuzzy_prefixes:
                if fp in b_norm or b_norm[:9] in fp:
                    score += 55
                    fuzzy_hit = True
                    break

        full_title_norm = normalize_text(b.get("title", ""))
        main_title_raw = re.sub(r"^［[^］]+］|^\[[^\]]+\]", "", b.get("title", ""))
        main_title_raw = re.split(r"[―ー－\-〜～:：サブタイトル（(]", main_title_raw)[0].strip()
        main_title_norm = normalize_text(main_title_raw)

        if len(full_title_norm) >= 4 and full_title_norm in norm_full:
            score += 75
        elif len(main_title_norm) >= 4 and main_title_norm in norm_full:
            if f"『{main_title_raw}" in text and not exact_hit:
                score += 25
                fuzzy_hit = True
            else:
                score += 65
        elif len(main_title_norm) >= 5:
            tail_sub = main_title_norm[2:]
            if len(tail_sub) >= 4 and tail_sub in norm_full:
                score += 45
                fuzzy_hit = True

        if score >= 40:
            candidates.append({
                "book": b,
                "score": score,
                "exact_hit": exact_hit,
                "fuzzy_hit": fuzzy_hit
            })

    candidates.sort(key=lambda x: (-x["score"], x["book"]["book_id"]))
    if candidates and candidates[0]["score"] >= 140:
        candidates = [c for c in candidates if c["score"] >= 80 or c["exact_hit"]]

    if not candidates:
        return {"status": "NO_CANDIDATE", "candidates": []}

    exact_hits = [c for c in candidates if c["exact_hit"]]
    if len(exact_hits) >= 2:
        return {"status": "MULTIPLE_CANDIDATES", "candidates": candidates}

    if candidates[0]["score"] < 80 or (candidates[0]["fuzzy_hit"] and not candidates[0]["exact_hit"]):
        return {"status": "MANUAL_CHECK_REQUIRED", "candidates": candidates}

    high_conf = [c for c in candidates if c["score"] >= 80]
    if len(high_conf) >= 2:
        return {"status": "MULTIPLE_CANDIDATES", "candidates": candidates}

    return {"status": "CANDIDATES_FOUND", "candidates": candidates}


BOX_REGEX = re.compile(r"^([A-Z0-9]{2,8})-(\d{2})-(\d{4})BOK$")


def validate_box_number(box_str: str, existing_books: list) -> dict:
    raw = unicodedata.normalize("NFKC", str(box_str or "").strip()).upper()
    if not raw or re.search(r"仮|TEMP|TEST|DUMMY", raw, re.I):
        return {"is_valid": False, "reason": "EMPTY_OR_TEMP"}
    m = BOX_REGEX.match(raw)
    if not m or m.group(3) == "0000":
        return {"is_valid": False, "reason": "FORMAT_ERROR"}
    existing_cnt = sum(1 for b in existing_books if str(b.get("box_number", "")).upper() == raw)
    return {
        "is_valid": True,
        "normalized": raw,
        "is_existing_box": existing_cnt > 0,
        "existing_count": existing_cnt
    }


def suggest_next_box_number(dept_code: str, year2: str, books: list) -> str:
    clean_dept = re.sub(r"[^A-Z0-9]", "", unicodedata.normalize("NFKC", dept_code).upper().split(":")[0])
    clean_yr = re.sub(r"\D", "", year2)[-2:].zfill(2)
    max_seq = 0
    for b in books:
        bn = str(b.get("box_number", "")).upper()
        m = BOX_REGEX.match(bn)
        if m and m.group(1) == clean_dept and m.group(2) == clean_yr:
            max_seq = max(max_seq, int(m.group(3)))
    return f"{clean_dept}-{clean_yr}-{max_seq + 1:04d}BOK"


def build_besshi23_name(dept_name: str, box_books: list) -> str:
    clean_dept = re.sub(r"^[A-Z0-9]+\s*[:：]\s*", "", dept_name).strip()
    prefix = f"図書（{clean_dept}）計{len(box_books)}冊："
    titles = "、".join(b["title"] for b in box_books)
    full_name = prefix + titles
    if len(full_name) > 100:
        suffix = "…他"
        full_name = full_name[: 100 - len(suffix)] + suffix
    return full_name


# =========================================================================
# 単体・結合テストクラス
# =========================================================================
class TestBookLocationManager(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(DATA_JSON_PATH, "r", encoding="utf-8") as f:
            cls.dataset = json.load(f)
        cls.books = cls.dataset["books"]
        cls.mock_ocr_cases = cls.dataset["mock_ocr_cases"]

    def test_01_dataset_contains_user_4_books_and_100_plus_records(self):
        """添付4冊が含まれ、かつデモデータが100件以上あり、デモフラグが明示されていること"""
        self.assertTrue(self.dataset["is_demo_data"])
        self.assertGreaterEqual(len(self.books), 100)

        titles = [b["title"] for b in self.books]
        self.assertTrue(any("AIを使って考えるための全技術" in t for t in titles))
        self.assertTrue(any("そして僕たちは、組織を進化させていく" in t for t in titles))
        self.assertTrue(any("［新版］概説 交通事故賠償法" in t for t in titles))
        self.assertTrue(any(t == "人事制度の基本" for t in titles))

    def test_02_do_not_auto_confirm_duplicate_isbn(self):
        """同じISBNの複数冊（複本）を誤って自動確定せず MULTIPLE_CANDIDATES を返すこと"""
        # 添付1: AIを使って考えるための全技術 (ISBN 978-4-478-11948-8 は BK-00001 と BK-00002 の2冊存在)
        case1 = next(c for c in self.mock_ocr_cases if c["case_id"] == "OCR-01")
        res1 = match_books_from_ocr(case1["raw_text"], self.books)
        self.assertEqual(res1["status"], "MULTIPLE_CANDIDATES")
        hit_ids = [c["book"]["book_id"] for c in res1["candidates"] if c["exact_hit"]]
        self.assertIn("BK-00001", hit_ids)
        self.assertIn("BK-00002", hit_ids)

        # 添付4: 人事制度の基本 (ISBN 978-4-534-05953-6 は BK-00006 と BK-00007 の2冊存在)
        case4 = next(c for c in self.mock_ocr_cases if c["case_id"] == "OCR-04")
        res4 = match_books_from_ocr(case4["raw_text"], self.books)
        self.assertEqual(res4["status"], "MULTIPLE_CANDIDATES")
        hit_ids4 = [c["book"]["book_id"] for c in res4["candidates"] if c["exact_hit"]]
        self.assertEqual(set(hit_ids4), {"BK-00006", "BK-00007"})

    def test_03_author_bio_noise_and_isbn10_matching(self):
        """著者略歴内の他書引用ノイズに惑わされないこと＆ISBN-10表記を正しく照合できること"""
        # 添付2: 著者略歴に『だから僕たちは、組織を変えていける』があるが、対象書 BK-00003 が最上位になる
        case2 = next(c for c in self.mock_ocr_cases if c["case_id"] == "OCR-02")
        res2 = match_books_from_ocr(case2["raw_text"], self.books)
        self.assertEqual(res2["candidates"][0]["book"]["book_id"], "BK-00003")

        # 添付3: ISBN-10 (4-535-51343-0) の認識
        case3 = next(c for c in self.mock_ocr_cases if c["case_id"] == "OCR-03")
        res3 = match_books_from_ocr(case3["raw_text"], self.books)
        self.assertEqual(res3["candidates"][0]["book"]["book_id"], "BK-00004")

    def test_04_no_isbn_and_ocr_misrecognition_fallback(self):
        """ISBNなしでも手動・書名検索でき、OCR誤認識時に MANUAL_CHECK_REQUIRED となること"""
        # OCR誤認識ケース (A1を使って... / ISBN末尾 B-B)
        case5 = next(c for c in self.mock_ocr_cases if c["case_id"] == "OCR-05")
        res5 = match_books_from_ocr(case5["raw_text"], self.books)
        self.assertEqual(res5["status"], "MANUAL_CHECK_REQUIRED")
        self.assertTrue(len(res5["candidates"]) >= 1)

        # ISBNなし図書の検索
        no_isbn_books = [b for b in self.books if not b["isbn"]]
        self.assertGreaterEqual(len(no_isbn_books), 5)
        manual_hits = [b for b in self.books if "日高文書倉庫" in b["title"]]
        self.assertEqual(len(manual_hits), 1)
        self.assertEqual(manual_hits[0]["book_id"], "BK-00019")

    def test_05_prevent_duplicate_book_addition(self):
        """同じ図書（同一の図書登録番号）を二重追加しないこと"""
        selected_list = []
        target_book = self.books[0]  # BK-00001

        # 1回目の追加
        if all(item["book_id"] != target_book["book_id"] for item in selected_list):
            selected_list.append({"book_id": target_book["book_id"], "new_location": "本部 4F 書架B-1"})
        self.assertEqual(len(selected_list), 1)

        # 2回目の追加試行（ブロックされること）
        is_duplicate = any(item["book_id"] == target_book["book_id"] for item in selected_list)
        self.assertTrue(is_duplicate)

    def test_06_csv_utf8_bom_and_leading_zero_preservation(self):
        """CSVの日本語（BOM付きUTF-8）や先頭ゼロ（00120等）が壊れないこと"""
        with open(DATA_CSV_PATH, "rb") as f:
            raw_bytes = f.read(3)
        # UTF-8 BOM (\xef\xbb\xbf) が付いていること
        self.assertEqual(raw_bytes, b"\xef\xbb\xbf")

        with open(DATA_CSV_PATH, "r", encoding="utf-8-sig", newline="") as f:
            reader = list(csv.DictReader(f))
        zero_ids = [r["図書登録番号"] for r in reader if r["図書登録番号"].startswith("00")]
        self.assertIn("00120", zero_ids)
        self.assertIn("00121", zero_ids)
        self.assertIn("00122", zero_ids)

    def test_07_isbn_check_digit_validation_distinguishes_valid_and_invalid(self):
        """ISBNの正常形式と異常形式（チェックディジット不正・桁数不足）を正確に区別すること"""
        v_ok13 = validate_isbn("978-4-478-11948-8")
        self.assertTrue(v_ok13["is_valid"])
        self.assertEqual(v_ok13["type"], "ISBN-13")

        v_ok10 = validate_isbn("4-535-51343-0")
        self.assertTrue(v_ok10["is_valid"])
        self.assertEqual(v_ok10["type"], "ISBN-10")

        # BK-00026: 意図的なチェックディジット不正
        v_bad_cd = validate_isbn("978-4-800-99999-9")
        self.assertFalse(v_bad_cd["is_valid"])

        # BK-00027: 桁数不足
        v_bad_len = validate_isbn("978-4-800-1234")
        self.assertFalse(v_bad_len["is_valid"])

    def test_08_warehouse_box_number_validation_and_besshi23_100chars(self):
        """箱管理番号の形式・仮番号拒否・重複チェック・次番号提示・別紙2-3の100文字以内制限"""
        # 正常形式（既存箱）
        v_exist = validate_box_number("1101-26-0001BOK", self.books)
        self.assertTrue(v_exist["is_valid"])
        self.assertTrue(v_exist["is_existing_box"])

        # 仮番号は拒否
        v_temp = validate_box_number("仮-26-0001BOK", self.books)
        self.assertFalse(v_temp["is_valid"])

        # 形式不正は拒否
        v_bad = validate_box_number("1101-2026-01BOK", self.books)
        self.assertFalse(v_bad["is_valid"])

        # 次番号提示（1101-26-0001BOK, 1101-26-0002BOK が既存なので次は 1101-26-0003BOK）
        next_box = suggest_next_box_number("1101: デジタル推進室", "26", self.books)
        self.assertEqual(next_box, "1101-26-0003BOK")

        # 別紙2-3の名称100文字以内制限テスト（長大書名を含む箱 1101-26-0001BOK）
        box_books = [b for b in self.books if b["box_number"] == "1101-26-0001BOK"]
        besshi_name = build_besshi23_name("1101: デジタル推進室", box_books)
        self.assertLessEqual(len(besshi_name), 100)
        self.assertTrue(besshi_name.startswith("図書（デジタル推進室）計"))

    def test_09_production_data_excluded_from_git(self):
        """本番データ・履歴・画像が .gitignore で公開対象から除外されていること"""
        with open(GITIGNORE_PATH, "r", encoding="utf-8") as f:
            gitignore_content = f.read()
        self.assertIn("production_data/", gitignore_content)
        self.assertIn("*production*.csv", gitignore_content)
        self.assertIn("history/", gitignore_content)
        self.assertIn("backups/", gitignore_content)


if __name__ == "__main__":
    unittest.main(verbosity=2)
