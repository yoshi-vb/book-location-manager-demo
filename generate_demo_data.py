#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
架空の蔵書データ（デモデータ）105件および模擬OCRテストデータを生成するスクリプト。
実在の添付書籍4冊（複本・旧版を含め計7冊）＋架空の蔵書98冊＝計105冊を生成します。

含まれる検証ケース:
1. ユーザー提供の奥付画像4冊（ISBN-13 / ISBN-10、複本、旧版違いを含む）
2. ISBNがある図書／ない図書
3. 同じISBNの複数冊（複本：自動確定せず人が図書登録番号・部署等で選ぶケース）
4. 同じ書名だが版や発行年が異なる図書
5. 似た書名の図書
6. 著者や出版社が未登録の図書
7. 長い書名、全角・半角が混在する書名
8. 本部内保管と外部倉庫（日高）保管
9. 同じ箱（部室G-年度2桁-通し番号4桁BOK）に複数冊入っているケース
10. ISBNの正常形式（チェックディジット正常）と異常形式（チェックディジット不正・桁数不正）
"""

import csv
import json
import os
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)


def calc_isbn13_check_digit(prefix12: str) -> str:
    """12桁の数字文字列からISBN-13のチェックディジットを計算する"""
    digits = [int(c) for c in prefix12 if c.isdigit()]
    assert len(digits) == 12
    total = sum(d * (1 if i % 2 == 0 else 3) for i, d in enumerate(digits))
    rem = (10 - (total % 10)) % 10
    return str(rem)


def make_valid_isbn13(publisher_code: int, item_code: int) -> str:
    """テスト用のチェックディジットが正しい架空ISBN-13（ハイフン付き）を生成"""
    pub_str = f"{publisher_code:03d}"
    item_str = f"{item_code:05d}"
    raw12 = f"9784{pub_str}{item_str}"
    cd = calc_isbn13_check_digit(raw12)
    return f"978-4-{pub_str}-{item_str}-{cd}"


def generate_books():
    books = []

    # =========================================================================
    # A. 添付画像の4冊（およびその複本・旧版ケース：計7件）
    # =========================================================================
    # 1. AIを使って考えるための全技術（複本2冊：同じISBNで所管部署・刷が異なるケース）
    books.append({
        "book_id": "BK-00001",
        "isbn": "978-4-478-11948-8",
        "title": "AIを使って考えるための全技術 ――「最高の発想」を一瞬で生み出す56の技法",
        "author": "石井力重（著）／加藤昌治（監修）",
        "publisher": "ダイヤモンド社",
        "pub_year": "2025",
        "edition": "第1刷",
        "department": "1101: デジタル推進室",
        "location": "本部 4F イノベーション書架A-1",
        "box_number": "",
        "notes": "【実機検証用1-A】複本あり（第1刷・デジタル推進室保管）"
    })
    books.append({
        "book_id": "BK-00002",
        "isbn": "978-4-478-11948-8",
        "title": "AIを使って考えるための全技術 ――「最高の発想」を一瞬で生み出す56の技法",
        "author": "石井力重（著）／加藤昌治（監修）",
        "publisher": "ダイヤモンド社",
        "pub_year": "2025",
        "edition": "第3刷",
        "department": "1201: 経営企画部",
        "location": "本部 3F 企画書架B-2",
        "box_number": "",
        "notes": "【実機検証用1-B】複本あり（2025年7月29日 第3刷・経営企画部保管）"
    })

    # 2. そして僕たちは、組織を進化させていく（発行所と発売元が併記されているケース）
    books.append({
        "book_id": "BK-00003",
        "isbn": "978-4-295-41153-6",
        "title": "そして僕たちは、組織を進化させていく",
        "author": "斉藤 徹",
        "publisher": "クロスメディア・パブリッシング（発売：インプレス）",
        "pub_year": "2025",
        "edition": "初版",
        "department": "1201: 経営企画部",
        "location": "本部 3F 企画書架A-1",
        "box_number": "",
        "notes": "【実機検証用2】2025年11月21日初版発行"
    })

    # 3. ［新版］概説 交通事故賠償法（ISBN-10形式 ＋ 旧版との版違いケース）
    books.append({
        "book_id": "BK-00004",
        "isbn": "4-535-51343-0",
        "title": "［新版］概説 交通事故賠償法",
        "author": "藤村和夫・山野嘉朗",
        "publisher": "株式会社 日本評論社",
        "pub_year": "2003",
        "edition": "新版第1刷",
        "department": "1302: 法務コンプライアンス部",
        "location": "本部 5F 法務書架C-3",
        "box_number": "",
        "notes": "【実機検証用3-A】ISBN-10表記（2003年7月25日 新版第1刷）"
    })
    books.append({
        "book_id": "BK-00005",
        "isbn": "4-535-51188-8",
        "title": "概説 交通事故賠償法",
        "author": "藤村和夫・山野嘉朗",
        "publisher": "株式会社 日本評論社",
        "pub_year": "1999",
        "edition": "初版第1刷",
        "department": "1302: 法務コンプライアンス部",
        "location": "外部倉庫（日高）1302-25-0001BOK",
        "box_number": "1302-25-0001BOK",
        "notes": "【実機検証用3-B】1999年旧版（新版との識別テスト用・日高倉庫保管中）"
    })

    # 4. 人事制度の基本（複本2冊：1冊は本部、1冊は日高倉庫保管）
    books.append({
        "book_id": "BK-00006",
        "isbn": "978-4-534-05953-6",
        "title": "人事制度の基本",
        "author": "西尾 太",
        "publisher": "株式会社 日本実業出版社",
        "pub_year": "2022",
        "edition": "初版",
        "department": "1401: 人事総務部",
        "location": "本部 2F 人事書架D-1",
        "box_number": "",
        "notes": "【実機検証用4-A】2022年10月20日初版発行（人事総務部・常用）"
    })
    books.append({
        "book_id": "BK-00007",
        "isbn": "978-4-534-05953-6",
        "title": "人事制度の基本",
        "author": "西尾 太",
        "publisher": "株式会社 日本実業出版社",
        "pub_year": "2022",
        "edition": "初版（保存用）",
        "department": "1401: 人事総務部",
        "location": "本部 2F 書庫ロッカー2",
        "box_number": "",
        "notes": "【実機検証用4-B】同一ISBNの複本（保存用・書庫ロッカー保管）"
    })

    # =========================================================================
    # B. 特殊検証ケース（BK-00008 〜 BK-00040）
    # =========================================================================
    # 5. 似た書名の図書（BK-00003やBK-00006と紛らわしい架空図書）
    books.extend([
        {
            "book_id": "BK-00008",
            "isbn": make_valid_isbn13(801, 10001),
            "title": "だから僕たちは、組織を変えていける（架空演習版）",
            "author": "斉藤 徹（参考架空版）",
            "publisher": "架空パブリッシング",
            "pub_year": "2023",
            "edition": "第2刷",
            "department": "1201: 経営企画部",
            "location": "本部 3F 企画書架A-2",
            "box_number": "",
            "notes": "似た書名・著者略歴内の書名ヒット検証用"
        },
        {
            "book_id": "BK-00009",
            "isbn": make_valid_isbn13(801, 10002),
            "title": "人事制度の基本と応用実務ハンドブック",
            "author": "東都労務研究会",
            "publisher": "架空実業出版",
            "pub_year": "2023",
            "edition": "初版",
            "department": "1401: 人事総務部",
            "location": "本部 2F 人事書架D-2",
            "box_number": "",
            "notes": "似た書名（『人事制度の基本』との部分一致比較用）"
        },
        {
            "book_id": "BK-00010",
            "isbn": make_valid_isbn13(801, 10003),
            "title": "AIを使って考えるための業務改善フレームワーク50",
            "author": "架空技術研究所",
            "publisher": "東都テック出版",
            "pub_year": "2024",
            "edition": "第1刷",
            "department": "1101: デジタル推進室",
            "location": "本部 4F イノベーション書架A-2",
            "box_number": "",
            "notes": "似た書名（『AIを使って考えるための全技術』との識別用）"
        },
    ])

    # 6. 同じISBNの3冊複本（0始まりの図書登録番号も含む：Excel先頭ゼロ保持検証用）
    dup_isbn = make_valid_isbn13(802, 20001)
    books.extend([
        {
            "book_id": "00120",
            "isbn": dup_isbn,
            "title": "架空組織における情報セキュリティ標準ガイドライン",
            "author": "情報基盤センター編",
            "publisher": "青空技術出版",
            "pub_year": "2024",
            "edition": "第4版 第1刷",
            "department": "0105: 情報システム部",
            "location": "本部 6F システム書架S-1",
            "box_number": "",
            "notes": "【先頭ゼロ登録番号＆3冊複本1】システム部執務室用"
        },
        {
            "book_id": "00121",
            "isbn": dup_isbn,
            "title": "架空組織における情報セキュリティ標準ガイドライン",
            "author": "情報基盤センター編",
            "publisher": "青空技術出版",
            "pub_year": "2024",
            "edition": "第4版 第1刷",
            "department": "1302: 法務コンプライアンス部",
            "location": "本部 5F 法務書架C-1",
            "box_number": "",
            "notes": "【先頭ゼロ登録番号＆3冊複本2】法務部監査用"
        },
        {
            "book_id": "00122",
            "isbn": dup_isbn,
            "title": "架空組織における情報セキュリティ標準ガイドライン",
            "author": "情報基盤センター編",
            "publisher": "青空技術出版",
            "pub_year": "2024",
            "edition": "第4版 第2刷",
            "department": "1401: 人事総務部",
            "location": "本部 2F 研修室書架R-1",
            "box_number": "",
            "notes": "【先頭ゼロ登録番号＆3冊複本3】新入社員研修用"
        },
    ])

    # 7. 同じ書名だが版や発行年・巻号が異なる図書（年鑑・白書シリーズ）
    for idx, yr in enumerate(["2022", "2023", "2024", "2025"], start=14):
        books.append({
            "book_id": f"BK-{idx:05d}",
            "isbn": make_valid_isbn13(803, 30000 + idx),
            "title": "架空産業ロジスティクス年鑑",
            "author": "物流総合調査会",
            "publisher": "みなと経済社",
            "pub_year": yr,
            "edition": f"{yr}年版（第{idx-10}巻）",
            "department": "1503: 物流管理部",
            "location": "外部倉庫（日高）1503-25-0001BOK" if yr in ("2022", "2023") else "本部 3F 物流資料棚L-1",
            "box_number": "1503-25-0001BOK" if yr in ("2022", "2023") else "",
            "notes": f"同名シリーズの年度・巻号違い（{yr}年版）"
        })

    # 8. ISBNがない図書（社内規程集・非売品・古書・調査報告書）
    no_isbn_items = [
        ("BK-00018", "架空グループ長期経営ビジョン30年史（非売品）", "社史編纂室", "架空ホールディングス", "2020", "非売品・初版", "1401: 人事総務部", "本部 2F 役員文庫", ""),
        ("BK-00019", "日高文書倉庫 運用手順および保存年限規程集", "文書管理委員会", "", "2024", "改訂第5版", "1401: 人事総務部", "本部 2F 総務キャビネット1", ""),
        ("BK-00020", "海外インフラ投資リスク調査報告書（東南アジア編）", "国際事業調査班", "架空総合研究所", "2021", "部内限り", "1201: 経営企画部", "外部倉庫（日高）1101-26-0001BOK", "1101-26-0001BOK"),
        ("BK-00021", "設備保全マイスター技術伝承テキスト（電気計装編）", "", "社内技術研修所", "2019", "第2版", "1601: 生産技術部", "本部 1F 技術資料室T-3", ""),
        ("BK-00022", "労働安全衛生協議会 過去のヒヤリハット事例集", "", "", "2018", "合本1号", "1601: 生産技術部", "外部倉庫（日高）1601-25-0002BOK", "1601-25-0002BOK"),
    ]
    for bid, title, auth, pub, yr, ed, dept, loc, box in no_isbn_items:
        books.append({
            "book_id": bid,
            "isbn": "",
            "title": title,
            "author": auth,
            "publisher": pub,
            "pub_year": yr,
            "edition": ed,
            "department": dept,
            "location": loc,
            "box_number": box,
            "notes": "ISBNなし（非売品・部内資料）・著者または出版社未登録ケース含む"
        })

    # 9. 全角・半角混在、長大書名（100文字超の別紙2-3切詰検証にも有効）
    books.extend([
        {
            "book_id": "BK-00023",
            "isbn": make_valid_isbn13(804, 40001),
            "title": "ＤＸ推進のためのＰｙｔｈｏｎ＆ＳＱＬデータ分析実践ガイド Vol.１ ― ０から始めるＡＩ・ＢＩツール活用とクラウド基盤構築（２０２５年改訂版）",
            "author": "山田 太郎／Ｊｏｈｎ Ｓｍｉｔｈ",
            "publisher": "テック・フロンティア出版",
            "pub_year": "2025",
            "edition": "Rev.2.0",
            "department": "1101: デジタル推進室",
            "location": "本部 4F イノベーション書架A-3",
            "box_number": "",
            "notes": "全角英数字・半角英数字・記号混在、長大タイトル検証用"
        },
        {
            "book_id": "BK-00024",
            "isbn": make_valid_isbn13(804, 40002),
            "title": "DX推進のためのPython&SQLデータ分析実践ガイド Vol.2 - 0から始めるAI・BIツール活用とクラウド基盤構築(2025年改訂版)",
            "author": "山田 太郎 / John Smith",
            "publisher": "テック・フロンティア出版",
            "pub_year": "2025",
            "edition": "Rev.2.0",
            "department": "1101: デジタル推進室",
            "location": "本部 4F イノベーション書架A-3",
            "box_number": "",
            "notes": "半角表記タイトル（BK-00023との全半角正規化検索の比較用）"
        },
        {
            "book_id": "BK-00025",
            "isbn": make_valid_isbn13(804, 40003),
            "title": "統合リスクマネジメントおよびサステナビリティ情報開示に関する国際基準と実務対応のすべて――気候変動・人的資本・サプライチェーン・ガバナンス改革を網羅した次世代コーポレートガバナンス完全解説書",
            "author": "サステナブル経営実務研究会",
            "publisher": "中央ガバナンス出版",
            "pub_year": "2024",
            "edition": "初版第1刷",
            "department": "1201: 経営企画部",
            "location": "外部倉庫（日高）1101-26-0001BOK",
            "box_number": "1101-26-0001BOK",
            "notes": "超長大書名（別紙2-3の100文字制限トリミング検証用）"
        },
    ])

    # 10. ISBN異常形式（チェックディジット不正・桁数不正）の検証用データ
    books.extend([
        {
            "book_id": "BK-00026",
            "isbn": "978-4-800-99999-9",  # 末尾チェックディジットが意図的に不正
            "title": "【検証用】旧台帳でISBNチェックディジットが誤入力されている図書",
            "author": "台帳検証テスト著者",
            "publisher": "テスト出版社",
            "pub_year": "2021",
            "edition": "初版",
            "department": "0105: 情報システム部",
            "location": "本部 6F システム書架S-9",
            "box_number": "",
            "notes": "ISBN異常形式テスト（チェックディジット不正：正しくは末尾4）"
        },
        {
            "book_id": "BK-00027",
            "isbn": "978-4-800-1234",  # 桁数不足
            "title": "【検証用】旧台帳でISBNの桁数が途中で切れている図書",
            "author": "台帳検証テスト著者",
            "publisher": "テスト出版社",
            "pub_year": "2020",
            "edition": "初版",
            "department": "0105: 情報システム部",
            "location": "本部 6F システム書架S-9",
            "box_number": "",
            "notes": "ISBN異常形式テスト（桁数不足）"
        },
    ])

    # =========================================================================
    # C. 外部倉庫（日高）の箱に複数冊格納されているケース＆一般架空蔵書（BK-00028 〜 BK-00105）
    # =========================================================================
    departments = [
        ("1101", "1101: デジタル推進室", "本部 4F イノベーション書架"),
        ("1201", "1201: 経営企画部", "本部 3F 企画書架"),
        ("1302", "1302: 法務コンプライアンス部", "本部 5F 法務書架"),
        ("1401", "1401: 人事総務部", "本部 2F 人事書架"),
        ("1503", "1503: 物流管理部", "本部 3F 物流資料棚"),
        ("1601", "1601: 生産技術部", "本部 1F 技術資料室"),
        ("0105", "0105: 情報システム部", "本部 6F システム書架"),
    ]

    # 既存の外部倉庫の箱一覧（同じ箱に複数冊入っている状態を再現）
    existing_boxes = [
        "1101-26-0001BOK",
        "1101-26-0002BOK",
        "1201-26-0001BOK",
        "1302-25-0001BOK",
        "1401-26-0001BOK",
        "1503-25-0001BOK",
        "1601-25-0002BOK",
    ]

    topics = [
        ("クラウドネイティブ設計とマイクロサービス運用実務", "佐藤 健一", "翔泳堂テック"),
        ("実践アジャイル開発とスクラムチーム運営の勘所", "高橋 誠", "みらい技術社"),
        ("製造業におけるサプライチェーン強靭化と在庫最適化", "田中 裕子", "東都マネジメント出版"),
        ("コンプライアンス違反事例から学ぶ企業法務の基礎", "渡辺 剛", "青葉法律出版"),
        ("ゼロトラスト時代のネットワークセキュリティ設計", "伊藤 翔太", "サイバープレス"),
        ("管理職のための1on1ミーティングと目標管理ガイド", "山本 恵美", "人材開発ジャーナル社"),
        ("コーポレートファイナンスとM&Aバリュエーション実務", "中村 俊介", "中央経済リサーチ"),
        ("カーボンニュートラル対応工場の省エネ設計マニュアル", "小林 政則", "環境エンジニアリング社"),
        ("BtoBマーケティングと営業プロセス改革の実践手法", "加藤 真理", "ビジネスクリエイト社"),
        ("国際物流・通関実務とインコタームズ解説", "吉田 浩二", "オーシャン物流出版"),
        ("生成AI時代の知的財産権と著作権法の実務", "松本 隆", "霞が関法規出版"),
        ("データガバナンスとマスターデータ管理（MDM）入門", "井上 拓也", "データサイエンス社"),
        ("心理的安全性とハイパフォーマンス組織の作り方", "木村 彩", "ワークスタイル出版"),
    ]

    for i in range(28, 106):
        dept_code, dept_name, base_shelf = departments[i % len(departments)]
        topic_title, topic_author, topic_pub = topics[i % len(topics)]
        series_num = (i - 28) // len(topics) + 1
        year = str(2018 + (i % 8))
        edition = f"第{series_num}版" if series_num > 1 else "初版第1刷"

        # 約30%を外部倉庫（日高）保管にする
        if i % 3 == 0:
            box_no = existing_boxes[i % len(existing_boxes)]
            location = f"外部倉庫（日高）{box_no}"
        else:
            box_no = ""
            shelf_row = chr(65 + (i % 4))  # A, B, C, D
            shelf_col = (i % 5) + 1
            location = f"{base_shelf}{shelf_row}-{shelf_col}"

        # 一部は著者または出版社を空欄にする
        author_val = "" if i in (45, 78) else topic_author
        pub_val = "" if i in (52, 89) else topic_pub

        books.append({
            "book_id": f"BK-{i:05d}",
            "isbn": make_valid_isbn13(810 + (i % 50), 50000 + i),
            "title": f"{topic_title}（実践編 第{series_num}巻）" if series_num > 1 else topic_title,
            "author": author_val,
            "publisher": pub_val,
            "pub_year": year,
            "edition": edition,
            "department": dept_name,
            "location": location,
            "box_number": box_no,
            "notes": f"デモ用架空データ（{ '日高倉庫保管済み' if box_no else '本部内書架保管' }）"
        })

    return books


def generate_mock_ocr_cases():
    """
    実機カメラを使わずに照合ロジックを検証するための模擬OCR文字列セット。
    （添付4冊の奥付テキスト、OCR誤認識混じり、複本ケース、ISBNなしケースなど）
    """
    return [
        {
            "case_id": "OCR-01",
            "label": "【添付1】AIを使って考えるための全技術（複本2冊ヒット → 手動選択が必要）",
            "description": "奥付のテキストとISBN。同じISBNの図書が2冊（第1刷・第3刷）あるため、自動確定せず2件の候補を提示することを確認します。",
            "raw_text": (
                "AIを使って考えるための全技術\n"
                "――「最高の発想」を一瞬で生み出す56の技法\n"
                "2025年6月10日 第1刷発行\n"
                "2025年7月29日 第3刷発行\n"
                "著者――石井力重\n"
                "監修者――加藤昌治\n"
                "発行所――ダイヤモンド社\n"
                "ISBN 978-4-478-11948-8"
            ),
            "expected_status": "MULTIPLE_CANDIDATES",
            "expected_book_ids": ["BK-00001", "BK-00002"]
        },
        {
            "case_id": "OCR-02",
            "label": "【添付2】そして僕たちは、組織を進化させていく（1件候補＋著者略歴の別書名ノイズ混入）",
            "description": "奥付上部の著者略歴に『だから僕たちは、組織を変えていける』が含まれているが、ISBNと書名から正しく対象図書を上位表示できるか確認します。",
            "raw_text": (
                "斉藤 徹（さいとう・とおる）\n"
                "『だから僕たちは、組織を変えていける』（クロスメディア・パブリッシング）\n"
                "そして僕たちは、組織を進化させていく\n"
                "2025年11月21日 初版発行\n"
                "著者 斉藤 徹\n"
                "発行 株式会社クロスメディア・パブリッシング\n"
                "発売 株式会社インプレス\n"
                "ISBN978-4-295-41153-6 C2034"
            ),
            "expected_status": "CANDIDATES_FOUND",
            "expected_book_ids": ["BK-00003"]
        },
        {
            "case_id": "OCR-03",
            "label": "【添付3】［新版］概説 交通事故賠償法（ISBN-10表記の認識と旧版比較）",
            "description": "978から始まらない旧規格のISBN-10（4-535-51343-0）を正しく抽出し、1999年旧版と区別して候補表示できるか確認します。",
            "raw_text": (
                "［新版］概説 交通事故賠償法（がいせつ こうつうじこばいしょうほう）\n"
                "著者 藤村和夫・山野嘉朗\n"
                "発行所 株式会社 日本評論社\n"
                "1999年6月30日 初版第1刷発行\n"
                "2003年7月25日 新版第1刷発行\n"
                "ISBN4-535-51343-0"
            ),
            "expected_status": "CANDIDATES_FOUND",
            "expected_book_ids": ["BK-00004", "BK-00005"]
        },
        {
            "case_id": "OCR-04",
            "label": "【添付4】人事制度の基本（複本2冊ヒット → 登録番号・保管場所で識別）",
            "description": "『人事制度の基本』（ISBN 978-4-534-05953-6）は常用（BK-00006）と保存用（BK-00007）の2冊が存在するため、自動確定せず人が選択します。",
            "raw_text": (
                "人事制度の基本\n"
                "2022年10月20日 初版発行\n"
                "著者 西尾 太\n"
                "発行所 株式会社 日本実業出版社\n"
                "ISBN 978-4-534-05953-6 Printed in JAPAN"
            ),
            "expected_status": "MULTIPLE_CANDIDATES",
            "expected_book_ids": ["BK-00006", "BK-00007"]
        },
        {
            "case_id": "OCR-05",
            "label": "【OCR誤認識ケース】ISBNの一部かすれ・文字化け（書名・著者フォールバック照合）",
            "description": "照明反射等でISBNの数字が『978-4-478-1194B-B』のように誤読された場合でも、書名・著者キーワードから候補を提示し『手動確認が必要』と表示します。",
            "raw_text": (
                "A1を使って考えるための全技術\n"
                "著 者 石井力重\n"
                "発行所 ダイヤモンド社\n"
                "ISBN 978-4-478-1194B-B"
            ),
            "expected_status": "MANUAL_CHECK_REQUIRED",
            "expected_book_ids": ["BK-00001", "BK-00002"]
        },
        {
            "case_id": "OCR-06",
            "label": "【ISBNなし図書】社内規程集・非売品の奥付読取",
            "description": "ISBNが存在しない非売品・社内資料について、書名と発行元から候補を検索します。",
            "raw_text": (
                "日高文書倉庫 運用手順および保存年限規程集\n"
                "2024年 改訂第5版\n"
                "編纂：文書管理委員会"
            ),
            "expected_status": "CANDIDATES_FOUND",
            "expected_book_ids": ["BK-00019"]
        },
        {
            "case_id": "OCR-07",
            "label": "【該当なしケース】蔵書リストに存在しない全く別の書籍",
            "description": "台帳に未登録の本を読み取った場合、無理に別図書を確定せず『候補なし（手動検索へ切替）』と明示することを確認します。",
            "raw_text": (
                "未登録の最新マーケティング入門\n"
                "2026年1月1日 初版\n"
                "架空未来出版\n"
                "ISBN 978-4-999-88888-7"
            ),
            "expected_status": "NO_CANDIDATE",
            "expected_book_ids": []
        }
    ]


def main():
    books = generate_books()
    mock_ocr = generate_mock_ocr_cases()

    # 1. CSV出力（BOM付きUTF-8：Excelで直接開いても文字化けしない形式）
    csv_path = os.path.join(DATA_DIR, "demo_books.csv")
    fieldnames = [
        "図書登録番号",
        "ISBN",
        "書名",
        "著者・編者",
        "出版社",
        "発行年",
        "版・巻号",
        "所管部署",
        "現在の保管場所",
        "外部倉庫の箱管理番号",
        "備考"
    ]
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for b in books:
            writer.writerow({
                "図書登録番号": b["book_id"],
                "ISBN": b["isbn"],
                "書名": b["title"],
                "著者・編者": b["author"],
                "出版社": b["publisher"],
                "発行年": b["pub_year"],
                "版・巻号": b["edition"],
                "所管部署": b["department"],
                "現在の保管場所": b["location"],
                "外部倉庫の箱管理番号": b["box_number"],
                "備考": b["notes"],
            })

    # 2. JSON出力
    json_path = os.path.join(DATA_DIR, "demo_books.json")
    payload = {
        "is_demo_data": True,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "record_count": len(books),
        "books": books,
        "mock_ocr_cases": mock_ocr
    }
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    # 3. ブラウザから file:// でも直接読み込めるよう JS 変数定義ファイルとしても出力
    js_data_path = os.path.join(BASE_DIR, "js", "demo_data.js")
    with open(js_data_path, "w", encoding="utf-8") as f:
        f.write("// 自動生成された開発・検証用デモデータ（実データではありません）\n")
        f.write("window.DEMO_DATASET = ")
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write(";\n")

    print(f"[完了] デモ蔵書データ {len(books)} 件を生成しました:")
    print(f"  - CSV : {csv_path}")
    print(f"  - JSON: {json_path}")
    print(f"  - JS  : {js_data_path}")


if __name__ == "__main__":
    main()
