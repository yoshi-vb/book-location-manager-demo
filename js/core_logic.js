/**
 * 蔵書保管場所変更・記録アプリ コアロジック (core_logic.js)
 * -------------------------------------------------------------------------
 * 役割:
 * 1. 全角・半角・記号の正規化、ISBN-10 / ISBN-13 の抽出とチェックディジット検証
 * 2. OCRテキスト・検索クエリからの多段階候補照合（絶対にISBNだけで1冊に自動確定しない）
 * 3. 同一図書（図書登録番号）の二重追加防止と選択リスト管理
 * 4. 外部倉庫（日高倉庫）の箱管理番号（部室G-年度2桁-通し番号4桁BOK）検証・次番号提示
 * 5. 別紙2-3転記用データ（名称100文字以内等）の生成
 * 6. CSV入出力（BOM付きUTF-8、先頭ゼロ保護、列マッピング）とQRコード分割ペイロード生成
 */

(function (globalScope) {
  "use strict";

  // 標準項目定義（将来の実データCSV取込時のマッピング対象）
  const STANDARD_FIELDS = [
    { key: "book_id", label: "図書登録番号", required: true, aliases: ["図書登録番号", "登録番号", "管理番号", "ID", "図書ID", "book_id"] },
    { key: "isbn", label: "ISBN", required: false, aliases: ["ISBN", "ISBNコード", "ISBN-13", "ISBN-10", "isbn"] },
    { key: "title", label: "書名", required: true, aliases: ["書名", "タイトル", "図書名", "書籍名", "名称", "title"] },
    { key: "author", label: "著者・編者", required: false, aliases: ["著者・編者", "著者", "編者", "著者名", "作者", "author"] },
    { key: "publisher", label: "出版社", required: false, aliases: ["出版社", "発行所", "発行元", "出版者", "publisher"] },
    { key: "pub_year", label: "発行年", required: false, aliases: ["発行年", "出版年", "発行年月日", "年度", "pub_year"] },
    { key: "edition", label: "版・巻号", required: false, aliases: ["版・巻号", "版", "巻号", "刷", "版数", "edition"] },
    { key: "department", label: "所管部署", required: false, aliases: ["所管部署", "部署", "管理部署", "部室G", "保有部署", "department"] },
    { key: "location", label: "現在の保管場所", required: false, aliases: ["現在の保管場所", "保管場所", "所在", "設置場所", "棚番", "location"] },
    { key: "box_number", label: "外部倉庫の箱管理番号", required: false, aliases: ["外部倉庫の箱管理番号", "箱管理番号", "箱番号", "文書箱番号", "box_number"] },
    { key: "notes", label: "備考", required: false, aliases: ["備考", "メモ", "注記", "コメント", "notes"] }
  ];

  /**
   * 文字列の正規化（全角英数字→半角、空白・記号除去、小文字化）
   */
  function normalizeText(str) {
    if (!str) return "";
    return String(str)
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\s　・、。，．「」『』（）()［］\[\]【】―ー−‐\-:：;；\/／!！?？"']/g, "");
  }

  /**
   * ISBN文字列のクリーニング（OCRの典型的な誤読 O->0, I/l->1 等も補助補正可能）
   */
  function cleanIsbnDigits(raw, allowOcrFix = false) {
    if (!raw) return "";
    let s = String(raw).normalize("NFKC").toUpperCase();
    s = s.replace(/^ISBN\s*[:：]?\s*/i, "");
    if (allowOcrFix) {
      s = s
        .replace(/[OО]/g, "0")
        .replace(/[IІL|]/g, "1")
        .replace(/[Z]/g, "2")
        .replace(/[S]/g, "5")
        .replace(/[B]/g, "8");
    }
    return s.replace(/[^0-9X]/g, "");
  }

  /**
   * ISBN-10 / ISBN-13 の形式およびチェックディジット検証
   * ※注意: チェックディジットが正しいことは「形式が正常」であることを意味し、
   * 実在する書籍であることを保証するものではない。
   */
  function validateIsbn(rawIsbn) {
    if (!rawIsbn || !String(rawIsbn).trim()) {
      return { isEmpty: true, isValid: false, type: "NONE", normalized: "", message: "ISBN未登録" };
    }
    const cleaned = cleanIsbnDigits(rawIsbn, false);
    if (cleaned.length === 13 && /^\d{13}$/.test(cleaned)) {
      let sum = 0;
      for (let i = 0; i < 12; i++) {
        sum += parseInt(cleaned[i], 10) * (i % 2 === 0 ? 1 : 3);
      }
      const expectedCheck = (10 - (sum % 10)) % 10;
      const actualCheck = parseInt(cleaned[12], 10);
      const isValid = expectedCheck === actualCheck;
      return {
        isEmpty: false,
        isValid,
        type: "ISBN-13",
        normalized: cleaned,
        expectedCheck: String(expectedCheck),
        message: isValid
          ? "ISBN-13 正常形式（チェックディジット一致）"
          : `ISBN-13 チェックディジット不正（末尾:${actualCheck}, 計算値:${expectedCheck}）`
      };
    }

    if (cleaned.length === 10 && /^\d{9}[\dX]$/.test(cleaned)) {
      let sum = 0;
      for (let i = 0; i < 9; i++) {
        sum += parseInt(cleaned[i], 10) * (10 - i);
      }
      const rem = (11 - (sum % 11)) % 11;
      const expectedCheck = rem === 10 ? "X" : String(rem);
      const actualCheck = cleaned[9];
      const isValid = expectedCheck === actualCheck;
      // ISBN-10 から対応する 978 ISBN-13 も算出しておく（互換照合用）
      const body9 = cleaned.slice(0, 9);
      const prefix12 = "978" + body9;
      let sum13 = 0;
      for (let i = 0; i < 12; i++) {
        sum13 += parseInt(prefix12[i], 10) * (i % 2 === 0 ? 1 : 3);
      }
      const cd13 = (10 - (sum13 % 10)) % 10;
      return {
        isEmpty: false,
        isValid,
        type: "ISBN-10",
        normalized: cleaned,
        isbn13Equivalent: prefix12 + String(cd13),
        expectedCheck,
        message: isValid
          ? "ISBN-10 正常形式（チェックディジット一致）"
          : `ISBN-10 チェックディジット不正（末尾:${actualCheck}, 計算値:${expectedCheck}）`
      };
    }

    return {
      isEmpty: false,
      isValid: false,
      type: "INVALID_LENGTH",
      normalized: cleaned,
      message: `ISBN桁数・形式異常（抽出数字:${cleaned.length}桁）`
    };
  }

  /**
   * OCRテキストからISBN候補（完全一致および一部かすれ候補）と書名・著者行を抽出する
   */
  function extractOcrFeatures(rawText) {
    const text = String(rawText || "").normalize("NFKC");
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const exactIsbns = [];
    const fuzzyIsbnPrefixes = [];

    // 1. ISBN表記行・パターンからの抽出
    const isbnRegex = /ISBN\s*[:：]?\s*([0-9OIlZSB\-‐−ー\s]{9,22}[0-9XObIlZSB])/gi;
    let match;
    while ((match = isbnRegex.exec(text)) !== null) {
      const strict = cleanIsbnDigits(match[1], false);
      const vStrict = validateIsbn(strict);
      if (vStrict.isValid) {
        exactIsbns.push(vStrict.normalized);
        if (vStrict.isbn13Equivalent) exactIsbns.push(vStrict.isbn13Equivalent);
      } else {
        // OCR文字化け補正を試みる
        const fixed = cleanIsbnDigits(match[1], true);
        const vFixed = validateIsbn(fixed);
        if (vFixed.isValid) {
          fuzzyIsbnPrefixes.push({ digits: vFixed.normalized, reason: "OCR文字補正一致" });
        } else if (strict.length >= 7) {
          fuzzyIsbnPrefixes.push({ digits: strict.slice(0, 9), reason: "ISBN部分一致（末尾かすれ等）" });
        }
      }
    }

    // 2. 978 / 979 から始まる連続数字・ハイフン列のフォールバック検出
    const raw13Regex = /(97[89][0-9\-‐−ー\s]{9,16}[0-9])/g;
    while ((match = raw13Regex.exec(text)) !== null) {
      const strict = cleanIsbnDigits(match[1], false);
      const vStrict = validateIsbn(strict);
      if (vStrict.isValid && !exactIsbns.includes(vStrict.normalized)) {
        exactIsbns.push(vStrict.normalized);
      }
    }

    // 3. 意味のあるテキスト行（ノイズ除去後）
    const noisyPatterns = /^(printed in|http|tel|fax|〒|\d{3}-\d{4}|落丁|乱丁|無断転載|本書の|定価|コード)/i;
    const meaningfulLines = lines.filter((l) => l.length >= 3 && !noisyPatterns.test(l));

    return {
      rawText: text,
      exactIsbns: Array.from(new Set(exactIsbns)),
      fuzzyIsbnPrefixes,
      lines: meaningfulLines
    };
  }

  /**
   * 蔵書リストに対するOCR結果の照合
   * 重要原則:
   * - 同じISBNが複数冊ある場合を含め、OCRから自動的に1冊へ確定追加することはしない。
   * - 必ずステータス（CANDIDATES_FOUND / MULTIPLE_CANDIDATES / MANUAL_CHECK_REQUIRED / NO_CANDIDATE）と
   *   候補一覧（図書登録番号、版・巻号、所管部署、保管場所付き）を返し、人が選択する。
   */
  function matchBooksFromOcr(rawText, books) {
    const features = extractOcrFeatures(rawText);
    const normFullOcr = normalizeText(rawText);
    const scoredMap = new Map();

    for (const book of books) {
      let score = 0;
      const reasons = [];
      let isExactIsbnHit = false;
      let isFuzzyHit = false;

      const bookIsbnInfo = validateIsbn(book.isbn);
      const bookIsbnNorm = bookIsbnInfo.normalized;
      const bookIsbn13Eq = bookIsbnInfo.isbn13Equivalent || "";

      // 1. ISBN完全一致チェック
      if (bookIsbnNorm && features.exactIsbns.length > 0) {
        if (
          features.exactIsbns.includes(bookIsbnNorm) ||
          (bookIsbn13Eq && features.exactIsbns.includes(bookIsbn13Eq))
        ) {
          score += 100;
          isExactIsbnHit = true;
          reasons.push(`ISBN一致 (${book.isbn})`);
        }
      }

      // 2. ISBN部分一致・OCR補正一致チェック
      if (!isExactIsbnHit && bookIsbnNorm && features.fuzzyIsbnPrefixes.length > 0) {
        for (const fz of features.fuzzyIsbnPrefixes) {
          if (bookIsbnNorm.includes(fz.digits) || fz.digits.includes(bookIsbnNorm.slice(0, 9))) {
            score += 55;
            isFuzzyHit = true;
            reasons.push(`${fz.reason} (${book.isbn})`);
            break;
          }
        }
      }

      // 3. 書名照合（主題＝サブタイトル前の部分も考慮）
      const fullTitleNorm = normalizeText(book.title);
      const mainTitleRaw = String(book.title || "")
        .replace(/^［[^］]+］|^\[[^\]]+\]/g, "")
        .split(/[―ー－\-〜～:：サブタイトル（(]/)[0]
        .trim();
      const mainTitleNorm = normalizeText(mainTitleRaw);

      if (fullTitleNorm.length >= 4 && normFullOcr.includes(fullTitleNorm)) {
        score += 75;
        reasons.push("書名完全一致");
      } else if (mainTitleNorm.length >= 4 && normFullOcr.includes(mainTitleNorm)) {
        // 著者略歴内の『別書名』引用による誤爆を抑えるため、カギ括弧『』内だけの一致か確認
        const quotedInBio = rawText.includes(`『${mainTitleRaw}`);
        if (quotedInBio && !isExactIsbnHit) {
          score += 25;
          isFuzzyHit = true;
          reasons.push("書名部分一致（※著者略歴等の引用の可能性あり）");
        } else {
          score += 65;
          reasons.push(`書名主要部一致 (${mainTitleRaw})`);
        }
      } else if (mainTitleNorm.length >= 5) {
        // 先頭または末尾がOCR文字化け（例: AI -> A1）している場合のN-gram/部分文字列照合
        const tailSub = mainTitleNorm.slice(2);
        const headSub = mainTitleNorm.slice(0, Math.max(4, mainTitleNorm.length - 2));
        if ((tailSub.length >= 4 && normFullOcr.includes(tailSub)) || (headSub.length >= 4 && normFullOcr.includes(headSub))) {
          score += 45;
          isFuzzyHit = true;
          reasons.push("書名類似一致（一部OCR誤読の可能性）");
        }
      }

      // 4. 著者・編者照合
      if (book.author) {
        const authorParts = String(book.author)
          .replace(/（[^）]*）|\([^)]*\)/g, "")
          .split(/[・／\/,、\s　]+/)
          .map((a) => normalizeText(a))
          .filter((a) => a.length >= 2);
        const hitAuthors = authorParts.filter((ap) => normFullOcr.includes(ap));
        if (hitAuthors.length > 0) {
          score += 25;
          reasons.push(`著者名一致 (${book.author})`);
        }
      }

      // 5. 出版社照合
      if (book.publisher) {
        const pubClean = normalizeText(
          String(book.publisher)
            .replace(/株式会社|有限会社|（発売[^）]*）/g, "")
            .trim()
        );
        if (pubClean.length >= 3 && normFullOcr.includes(pubClean)) {
          score += 15;
          reasons.push(`出版社一致 (${book.publisher})`);
        }
      }

      // 6. 図書登録番号が直接印字・入力されていた場合
      const idNorm = normalizeText(book.book_id);
      if (idNorm.length >= 4 && normFullOcr.includes(idNorm)) {
        score += 90;
        reasons.push(`図書登録番号一致 (${book.book_id})`);
      }

      if (score >= 40) {
        scoredMap.set(book.book_id, {
          book,
          score,
          isExactIsbnHit,
          isFuzzyHit,
          reasons
        });
      }
    }

    let candidates = Array.from(scoredMap.values()).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.book.book_id).localeCompare(String(b.book.book_id));
    });

    // ISBN完全一致かつ書名一致する強い候補（140点以上）が存在する場合、
    // 著者略歴内の他書引用や著者名・出版社だけの一致による低スコアノイズ（80点未満）を除外する
    const maxScore = candidates.length > 0 ? candidates[0].score : 0;
    if (maxScore >= 140) {
      candidates = candidates.filter((c) => c.score >= 80 || c.isExactIsbnHit);
    }

    // ステータス判定
    if (candidates.length === 0) {
      return {
        status: "NO_CANDIDATE",
        statusLabel: "候補なし（手動検索へ切り替えてください）",
        requiresManualCheck: true,
        extractedFeatures: features,
        candidates: []
      };
    }

    const topScore = candidates[0].score;
    const highConfidenceCandidates = candidates.filter((c) => c.score >= 80);

    // 同一ISBNの複本が複数ヒットした場合、または高スコア候補が複数ある場合
    const exactIsbnHits = candidates.filter((c) => c.isExactIsbnHit);
    if (exactIsbnHits.length >= 2) {
      return {
        status: "MULTIPLE_CANDIDATES",
        statusLabel: `候補が複数あります（同一ISBNの複本 ${exactIsbnHits.length}冊 等）― 図書登録番号・版・所管部署を確認して選択してください`,
        requiresManualCheck: true,
        extractedFeatures: features,
        candidates
      };
    }

    // 最高スコアが低い（かすれ・誤読フォールバック）場合
    if (topScore < 80 || (candidates[0].isFuzzyHit && !candidates[0].isExactIsbnHit)) {
      return {
        status: "MANUAL_CHECK_REQUIRED",
        statusLabel: "手動確認が必要（OCR読取精度が低いか部分一致のみです。現物とよく照合してください）",
        requiresManualCheck: true,
        extractedFeatures: features,
        candidates
      };
    }

    if (highConfidenceCandidates.length >= 2) {
      return {
        status: "MULTIPLE_CANDIDATES",
        statusLabel: `候補が複数（${candidates.length}件）あります ― 現物の版・発行年・登録番号を確認して選択してください`,
        requiresManualCheck: true,
        extractedFeatures: features,
        candidates
      };
    }

    return {
      status: "CANDIDATES_FOUND",
      statusLabel: `照合候補が見つかりました（有力候補1件 / 全${candidates.length}件）― 現物と図書登録番号を確認して「選択」を押してください`,
      requiresManualCheck: false,
      extractedFeatures: features,
      candidates
    };
  }

  /**
   * 手動検索（図書登録番号、ISBN、書名、著者、出版社、保管場所、箱番号の横断検索）
   * 全角・半角の違いやハイフン有無を吸収する
   */
  function searchBooksManually(query, books, filters = {}) {
    const qRaw = String(query || "").trim();
    const qNorm = normalizeText(qRaw);
    const qDigits = cleanIsbnDigits(qRaw, false);

    return books.filter((book) => {
      // フィルタ条件
      if (filters.department && book.department !== filters.department) return false;
      if (filters.storageType === "HQ" && String(book.location || "").includes("外部倉庫")) return false;
      if (filters.storageType === "WAREHOUSE" && !String(book.location || "").includes("外部倉庫") && !book.box_number) return false;
      if (filters.isbnStatus === "HAS_ISBN" && !book.isbn) return false;
      if (filters.isbnStatus === "NO_ISBN" && book.isbn) return false;

      if (!qRaw) return true;

      const hayRaw = [
        book.book_id,
        book.isbn,
        book.title,
        book.author,
        book.publisher,
        book.pub_year,
        book.edition,
        book.department,
        book.location,
        book.box_number,
        book.notes
      ].join(" ");

      const hayNorm = normalizeText(hayRaw);
      if (qNorm && hayNorm.includes(qNorm)) return true;

      if (qDigits.length >= 3) {
        const bookIsbnDigits = cleanIsbnDigits(book.isbn, false);
        const bookIdDigits = cleanIsbnDigits(book.book_id, false);
        if (bookIsbnDigits.includes(qDigits) || bookIdDigits.includes(qDigits)) return true;
      }
      return false;
    });
  }

  /**
   * 外部倉庫（日高倉庫）の箱管理番号検証
   * 形式: 「部室G-年度2桁-通し番号4桁BOK」 例: 「1101-26-0001BOK」
   * ルール:
   * - 部・Gコードを特定の部署だけに固定しない（任意の英数字・ハイフンなしの2〜8文字コードを許容）
   * - 仮の箱番号（「仮」「TEMP」等）は不可
   * - 形式チェックと既存番号の重複状況（既存箱への追加か新規箱か）を返す
   */
  const BOX_NUMBER_REGEX = /^([A-Z0-9]{2,8})-(\d{2})-(\d{4})BOK$/;

  function validateBoxNumber(boxNumber, books = [], currentSelections = []) {
    const raw = String(boxNumber || "").trim().normalize("NFKC").toUpperCase();
    if (!raw) {
      return {
        isValid: false,
        normalized: "",
        error: "箱管理番号が入力されていません。"
      };
    }
    if (/仮|TEMP|TEST|DUMMY|未定/i.test(raw)) {
      return {
        isValid: false,
        normalized: raw,
        error: "仮の箱番号は使用できません。正式な箱管理番号（部室G-年度2桁-通し番号4桁BOK）を指定してください。"
      };
    }

    const m = BOX_NUMBER_REGEX.exec(raw);
    if (!m) {
      return {
        isValid: false,
        normalized: raw,
        error: "形式が正しくありません。「部室G-年度2桁-通し番号4桁BOK」（例: 1101-26-0001BOK）の形式で入力してください。"
      };
    }

    const [, deptCode, year2, seq4] = m;
    if (seq4 === "0000") {
      return {
        isValid: false,
        normalized: raw,
        error: "通し番号は 0001 以上を指定してください。"
      };
    }

    // 既存台帳および今回選択中リスト内の同一箱番号の冊数を集計
    const existingBooksInBox = books.filter(
      (b) => String(b.box_number || "").toUpperCase() === raw
    );
    const selectedBooksInBox = currentSelections.filter(
      (s) => String(s.new_box_number || "").toUpperCase() === raw
    );

    const isExistingBox = existingBooksInBox.length > 0;
    return {
      isValid: true,
      normalized: raw,
      deptCode,
      year2,
      seq4,
      seqInt: parseInt(seq4, 10),
      isExistingBox,
      existingCount: existingBooksInBox.length,
      selectedCount: selectedBooksInBox.length,
      message: isExistingBox
        ? `既存箱（台帳登録済: ${existingBooksInBox.length}冊 / 今回選択: ${selectedBooksInBox.length}冊）※新規箱として採番する場合は重複に注意してください`
        : `新規箱番号（形式OK / 今回選択: ${selectedBooksInBox.length}冊）`
    };
  }

  /**
   * 部・Gコードと年度（2桁）から次の空き通し番号（部室G-年度2桁-通し番号4桁BOK）を提示する
   */
  function suggestNextBoxNumber(deptCodeInput, year2Input, books = [], currentSelections = []) {
    // 「1101: デジタル推進室」のような文字列が来ても先頭のコード部分を抽出できるようにする
    const cleanedDept = String(deptCodeInput || "")
      .normalize("NFKC")
      .toUpperCase()
      .split(/[:：\s　]/)[0]
      .replace(/[^A-Z0-9]/g, "");

    const deptCode = cleanedDept || "1101";
    const year2 = String(year2Input || "26")
      .normalize("NFKC")
      .replace(/\D/g, "")
      .slice(-2)
      .padStart(2, "0");

    let maxSeq = 0;
    const allBoxNumbers = [
      ...books.map((b) => b.box_number),
      ...currentSelections.map((s) => s.new_box_number)
    ];

    for (const bn of allBoxNumbers) {
      if (!bn) continue;
      const m = BOX_NUMBER_REGEX.exec(String(bn).normalize("NFKC").toUpperCase());
      if (m && m[1] === deptCode && m[2] === year2) {
        const seq = parseInt(m[3], 10);
        if (seq > maxSeq) maxSeq = seq;
      }
    }

    const nextSeq = String(maxSeq + 1).padStart(4, "0");
    return `${deptCode}-${year2}-${nextSeq}BOK`;
  }

  /**
   * 外部倉庫発送時の所在文字列を生成
   * 要件: 発送時に所在を「外部倉庫（日高）＋管理番号」へ更新する
   */
  function formatWarehouseLocation(boxNumber) {
    const cleanBox = String(boxNumber || "").trim().normalize("NFKC").toUpperCase();
    return `外部倉庫（日高）${cleanBox}`;
  }

  /**
   * 別紙2-3 転記用データの生成
   * 要件:
   * - 文書等種類：「文書」
   * - 保存期限：永久、日付値は 2999/12/31
   * - 名称：「図書（部署名）計○冊：主な書名…」
   * - 名称は100文字以内（厳密に100文字以下へトリミング）
   * - 正式様式そのものを再現したと称さず、転記用データとして出力する
   */
  function buildBesshi23Rows(targetBooksByBox) {
    // targetBooksByBox: Map or Object { [box_number]: Array<BookObj> }
    const rows = [];
    const boxEntries =
      targetBooksByBox instanceof Map
        ? Array.from(targetBooksByBox.entries())
        : Object.entries(targetBooksByBox);

    boxEntries.sort((a, b) => a[0].localeCompare(b[0]));

    for (const [boxNumber, boxBooks] of boxEntries) {
      if (!boxNumber || !boxBooks || boxBooks.length === 0) continue;

      // 部署名の抽出（「1101: デジタル推進室」→「デジタル推進室」）
      const deptCounts = new Map();
      for (const b of boxBooks) {
        const rawDept = String(b.department || "部署未設定")
          .replace(/^[A-Z0-9]+\s*[:：]\s*/i, "")
          .trim() || "部署未設定";
        deptCounts.set(rawDept, (deptCounts.get(rawDept) || 0) + 1);
      }
      const sortedDepts = Array.from(deptCounts.entries()).sort((a, b) => b[1] - a[1]);
      const mainDeptName =
        sortedDepts.length > 1
          ? `${sortedDepts[0][0]}ほか`
          : sortedDepts[0][0];

      const count = boxBooks.length;
      const prefix = `図書（${mainDeptName}）計${count}冊：`;
      const titlesJoined = boxBooks.map((b) => String(b.title || "無題").trim()).join("、");

      let fullName = prefix + titlesJoined;
      if (fullName.length > 100) {
        // 末尾に「…他」を付与して厳密に100文字以内に収める
        const suffix = "…他";
        const allowedLen = 100 - suffix.length;
        fullName = fullName.slice(0, allowedLen) + suffix;
      }

      rows.push({
        box_number: boxNumber,
        doc_type: "文書",
        retention_label: "永久",
        retention_date: "2999/12/31",
        item_name: fullName,
        name_length: fullName.length,
        book_count: count,
        department_summary: Array.from(deptCounts.keys()).join(" / "),
        book_ids: boxBooks.map((b) => b.book_id).join(", ")
      });
    }

    return rows;
  }

  /**
   * 選択済み変更リストへの図書追加（二重追加防止チェック付き）
   * 重要原則: 同一の図書登録番号がすでに選択リストにある場合は追加をブロックする
   */
  function addBookToSelection(currentList, book, destinationConfig) {
    if (!book || !book.book_id) {
      return {
        added: false,
        reason: "INVALID_BOOK",
        message: "図書登録番号が不明なため追加できません。",
        list: currentList
      };
    }

    const existingIndex = currentList.findIndex((item) => item.book_id === book.book_id);
    if (existingIndex !== -1) {
      return {
        added: false,
        reason: "DUPLICATE_BOOK_ID",
        message: `図書登録番号「${book.book_id}」（${book.title}）は既に選択済み一覧に追加されています（二重追加防止）。`,
        existingItem: currentList[existingIndex],
        list: currentList
      };
    }

    const isWarehouse = destinationConfig.mode === "WAREHOUSE";
    let newLocation = "";
    let newBoxNumber = "";

    if (isWarehouse) {
      const boxVal = String(destinationConfig.boxNumber || "").trim().toUpperCase();
      newBoxNumber = boxVal;
      newLocation = formatWarehouseLocation(boxVal);
    } else {
      newLocation = String(destinationConfig.location || "").trim();
      newBoxNumber = ""; // 本部内書架へ移動する場合は箱番号をクリア（または維持指定があれば維持）
    }

    if (!newLocation) {
      return {
        added: false,
        reason: "EMPTY_DESTINATION",
        message: "移動先の保管場所（または外部倉庫の箱管理番号）を指定してください。",
        list: currentList
      };
    }

    const newItem = {
      book_id: book.book_id,
      isbn: book.isbn || "",
      title: book.title || "",
      author: book.author || "",
      publisher: book.publisher || "",
      pub_year: book.pub_year || "",
      edition: book.edition || "",
      department: book.department || "",
      old_location: book.location || "",
      new_location: newLocation,
      old_box_number: book.box_number || "",
      new_box_number: newBoxNumber,
      change_mode: isWarehouse ? "外部倉庫（日高）箱詰・発送" : "本部内保管場所変更",
      worker_note: destinationConfig.workerNote || "",
      selected_at: destinationConfig.timestamp || new Date().toISOString()
    };

    const nextList = [newItem, ...currentList];
    return {
      added: true,
      reason: "OK",
      message: `「${book.book_id}: ${book.title}」を移動先「${newLocation}」として追加しました。`,
      item: newItem,
      list: nextList
    };
  }

  /**
   * 台帳データの検証（図書登録番号の重複、必須項目欠落、ISBN形式異常、箱番号形式異常の検査）
   */
  function validateCatalogDataset(books) {
    const seenIds = new Map();
    const duplicateIds = [];
    const missingRequired = [];
    const isbnWarnings = [];
    const boxWarnings = [];

    books.forEach((b, idx) => {
      const rowNum = idx + 1;
      const bid = String(b.book_id || "").trim();
      const title = String(b.title || "").trim();

      if (!bid || !title) {
        missingRequired.push({
          row: rowNum,
          book_id: bid || "(未入力)",
          title: title || "(未入力)",
          message: `${rowNum}行目: 必須項目（図書登録番号 または 書名）が未入力です。`
        });
      }

      if (bid) {
        if (seenIds.has(bid)) {
          duplicateIds.push({
            book_id: bid,
            firstRow: seenIds.get(bid),
            duplicateRow: rowNum,
            title,
            message: `図書登録番号「${bid}」が重複しています（${seenIds.get(bid)}行目 と ${rowNum}行目）。`
          });
        } else {
          seenIds.set(bid, rowNum);
        }
      }

      if (b.isbn) {
        const vIsbn = validateIsbn(b.isbn);
        if (!vIsbn.isValid) {
          isbnWarnings.push({
            row: rowNum,
            book_id: bid,
            isbn: b.isbn,
            message: `${bid}: ${vIsbn.message}`
          });
        }
      }

      if (b.box_number) {
        const vBox = validateBoxNumber(b.box_number, [], []);
        if (!vBox.isValid) {
          boxWarnings.push({
            row: rowNum,
            book_id: bid,
            box_number: b.box_number,
            message: `${bid}: ${vBox.error}`
          });
        }
      }
    });

    return {
      totalCount: books.length,
      isValidCritical: duplicateIds.length === 0 && missingRequired.length === 0,
      duplicateIds,
      missingRequired,
      isbnWarnings,
      boxWarnings
    };
  }

  /**
   * CSVパーサ（ダブルクォート・改行・カンマエスケープ対応、BOM自動除去）
   */
  function parseCsvText(csvText) {
    const text = String(csvText || "").replace(/^\uFEFF/, "");
    const rows = [];
    let currentRow = [];
    let currentVal = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const nextCh = text[i + 1];

      if (inQuotes) {
        if (ch === '"' && nextCh === '"') {
          currentVal += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          currentVal += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ",") {
          // Excel先頭ゼロ保護形式 ="00120" で出力された値も自動アンラップ
          currentRow.push(unwrapExcelProtectedValue(currentVal));
          currentVal = "";
        } else if (ch === "\r" && nextCh === "\n") {
          currentRow.push(unwrapExcelProtectedValue(currentVal));
          rows.push(currentRow);
          currentRow = [];
          currentVal = "";
          i++;
        } else if (ch === "\n" || ch === "\r") {
          currentRow.push(unwrapExcelProtectedValue(currentVal));
          rows.push(currentRow);
          currentRow = [];
          currentVal = "";
        } else {
          currentVal += ch;
        }
      }
    }

    if (currentVal.length > 0 || currentRow.length > 0) {
      currentRow.push(unwrapExcelProtectedValue(currentVal));
      rows.push(currentRow);
    }

    // 空行の除去
    const nonEmptyRows = rows.filter((r) => r.some((cell) => String(cell).trim() !== ""));
    if (nonEmptyRows.length === 0) {
      return { headers: [], records: [] };
    }

    const headers = nonEmptyRows[0].map((h) => String(h).trim());
    const records = nonEmptyRows.slice(1).map((r) => {
      const obj = {};
      headers.forEach((h, idx) => {
        obj[h] = r[idx] !== undefined ? String(r[idx]).trim() : "";
      });
      return obj;
    });

    return { headers, records };
  }

  function unwrapExcelProtectedValue(val) {
    const s = String(val || "").trim();
    const m = /^="([^"]*)"$/.exec(s);
    return m ? m[1] : s;
  }

  /**
   * CSV生成（BOM付きUTF-8対応、先頭ゼロ保護モード対応）
   */
  function generateCsvText(headers, rowsObjArray, options = {}) {
    const protectLeadingZeros = Boolean(options.protectLeadingZeros);
    const includeBom = options.includeBom !== false;

    const escapeCell = (val) => {
      const str = val === null || val === undefined ? "" : String(val);
      // 先頭ゼロ保護オプションがONで、「0」から始まる2桁以上の数字・ハイフン列の場合 ="00120" 形式にする
      if (protectLeadingZeros && /^0[0-9\-]+$/.test(str)) {
        return `"=""${str.replace(/"/g, '""')}"""`;
      }
      if (/[",\r\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const lines = [];
    lines.push(headers.map((h) => escapeCell(h.label || h)).join(","));

    for (const row of rowsObjArray) {
      const line = headers.map((h) => {
        const key = h.key || h;
        return escapeCell(row[key]);
      });
      lines.push(line.join(","));
    }

    return (includeBom ? "\uFEFF" : "") + lines.join("\r\n") + "\r\n";
  }

  /**
   * 元データCSVのヘッダー名から標準項目への初期マッピングを自動推定する
   */
  function guessColumnMapping(csvHeaders) {
    const mapping = {};
    for (const field of STANDARD_FIELDS) {
      let matchedHeader = "";
      for (const h of csvHeaders) {
        const hNorm = normalizeText(h);
        if (field.aliases.some((alias) => normalizeText(alias) === hNorm)) {
          matchedHeader = h;
          break;
        }
      }
      if (!matchedHeader) {
        // 部分一致フォールバック
        for (const h of csvHeaders) {
          const hNorm = normalizeText(h);
          if (field.aliases.some((alias) => hNorm.includes(normalizeText(alias)))) {
            matchedHeader = h;
            break;
          }
        }
      }
      mapping[field.key] = matchedHeader;
    }
    return mapping;
  }

  /**
   * スマホ変更データと現在台帳を突合し、変更前後（Diff）レコードを生成する
   */
  function computeChangesDiff(catalogBooks, changeRecords) {
    const catalogMap = new Map(catalogBooks.map((b) => [String(b.book_id).trim(), b]));
    const diffList = [];

    for (const ch of changeRecords) {
      const bid = String(ch.book_id || ch["図書登録番号"] || "").trim();
      if (!bid) continue;

      const newLoc = String(ch.new_location ?? ch["変更後の保管場所"] ?? ch["移動先保管場所"] ?? "").trim();
      const newBox = String(ch.new_box_number ?? ch["変更後の箱管理番号"] ?? ch["外部倉庫の箱管理番号"] ?? "").trim();
      const note = String(ch.worker_note ?? ch["作業メモ"] ?? "").trim();
      const selectedAt = String(ch.selected_at ?? ch["記録日時"] ?? "").trim();

      const targetBook = catalogMap.get(bid);
      if (!targetBook) {
        diffList.push({
          book_id: bid,
          status: "UNMATCHED_ID",
          statusLabel: "台帳未登録（要確認）",
          applyUpdate: false,
          title: ch.title || ch["書名"] || "(台帳に該当なし)",
          department: ch.department || ch["所管部署"] || "",
          old_location: "(台帳なし)",
          new_location: newLoc,
          old_box_number: "",
          new_box_number: newBox,
          worker_note: note,
          selected_at: selectedAt
        });
        continue;
      }

      const oldLoc = targetBook.location || "";
      const oldBox = targetBook.box_number || "";
      const isSame = oldLoc === newLoc && oldBox === newBox;

      diffList.push({
        book_id: bid,
        status: isSame ? "NO_CHANGE" : "CHANGED",
        statusLabel: isSame ? "変更なし（同一場所）" : "変更あり",
        applyUpdate: !isSame,
        isbn: targetBook.isbn,
        title: targetBook.title,
        author: targetBook.author,
        department: targetBook.department,
        old_location: oldLoc,
        new_location: newLoc,
        old_box_number: oldBox,
        new_box_number: newBox,
        worker_note: note,
        selected_at: selectedAt
      });
    }

    return diffList;
  }

  /**
   * iPhone ⇄ PC 間のQRコード受け渡し用コンパクトペイロード生成・復元
   * - 改善①: 書名（日本語の長い文字列）はPC側の蔵書台帳から図書登録番号で自動復元できるため除外し、
   *   さらに同じ移動先・箱番号・メモの図書をグループ化して登録番号配列のみを格納する超軽量形式 (v:2) にする。
   * - 改善②: 冊数固定ではなく、UTF-8バイト長（上限350バイト目安）を計算して1枚のQRに最大30〜40冊収め、
   *   超えた場合のみ自動で2枚目以降のQRコードへ分割する。
   */
  function getUtf8ByteLength(str) {
    if (typeof TextEncoder !== "undefined") {
      return new TextEncoder().encode(String(str)).length;
    }
    return unescape(encodeURIComponent(String(str))).length;
  }

  function buildCompactGroups(items) {
    const groupMap = new Map();
    for (const item of items) {
      const loc = String(item.new_location || "").trim();
      const box = String(item.new_box_number || "").trim();
      const note = String(item.worker_note || "").trim();
      const key = `${loc}\t${box}\t${note}`;
      if (!groupMap.has(key)) {
        const g = { l: loc, ids: [] };
        if (box) g.b = box;
        if (note) g.n = note;
        groupMap.set(key, g);
      }
      groupMap.get(key).ids.push(String(item.book_id || "").trim());
    }
    return Array.from(groupMap.values());
  }

  function encodeChangesToQrChunks(selectionList, maxBytesPerQr = 360) {
    if (!selectionList || selectionList.length === 0) return [];
    const batchId = Date.now().toString(36).slice(-5).toUpperCase();
    const rawSlices = [];
    let currentSlice = [];

    for (const item of selectionList) {
      const candidateSlice = [...currentSlice, item];
      const testPayload = {
        v: 2,
        tp: "BLM_CHG",
        id: batchId,
        p: 1,
        tc: 1,
        g: buildCompactGroups(candidateSlice)
      };
      const byteLen = getUtf8ByteLength(JSON.stringify(testPayload));
      if (currentSlice.length > 0 && byteLen > maxBytesPerQr) {
        rawSlices.push(currentSlice);
        currentSlice = [item];
      } else {
        currentSlice = candidateSlice;
      }
    }
    if (currentSlice.length > 0) {
      rawSlices.push(currentSlice);
    }

    const totalChunks = rawSlices.length;
    return rawSlices.map((slice, idx) => {
      const payloadObj = {
        v: 2,
        tp: "BLM_CHG",
        id: batchId,
        p: idx + 1,
        tc: totalChunks,
        g: buildCompactGroups(slice)
      };
      return {
        page: idx + 1,
        totalPages: totalChunks,
        itemCount: slice.length,
        jsonText: JSON.stringify(payloadObj)
      };
    });
  }

  function decodeQrChunkText(rawQrText) {
    try {
      const obj = JSON.parse(String(rawQrText || "").trim());
      if (!obj || obj.tp !== "BLM_CHG") {
        return { isValid: false, error: "このアプリの保管場所変更QRコードではありません。" };
      }

      // v2: 移動先グループ化による超軽量フォーマット
      if (Array.isArray(obj.g)) {
        const records = [];
        for (const grp of obj.g) {
          const loc = String(grp.l || "").trim();
          const box = String(grp.b || "").trim();
          const note = String(grp.n || "").trim();
          const ids = Array.isArray(grp.ids) ? grp.ids : [];
          for (const id of ids) {
            records.push({
              book_id: String(id || "").trim(),
              new_location: loc,
              new_box_number: box,
              worker_note: note,
              selected_at: new Date().toISOString()
            });
          }
        }
        return {
          isValid: true,
          batchId: obj.id,
          page: obj.p || 1,
          totalPages: obj.tc || 1,
          records
        };
      }

      // v1: 旧フォーマット互換
      if (Array.isArray(obj.d)) {
        const records = obj.d.map((entry) => ({
          book_id: String(entry.i || "").trim(),
          new_location: String(entry.l || "").trim(),
          new_box_number: String(entry.b || "").trim(),
          worker_note: String(entry.n || "").trim(),
          title: String(entry.t || "").trim(),
          selected_at: new Date().toISOString()
        }));
        return {
          isValid: true,
          batchId: obj.id,
          page: obj.p || 1,
          totalPages: obj.tc || 1,
          records
        };
      }

      return { isValid: false, error: "QRコードデータの形式が不明です。" };
    } catch (e) {
      return { isValid: false, error: "QRコードデータの解析に失敗しました（JSON形式不正）。" };
    }
  }

  const CoreLogic = {
    STANDARD_FIELDS,
    normalizeText,
    cleanIsbnDigits,
    validateIsbn,
    extractOcrFeatures,
    matchBooksFromOcr,
    searchBooksManually,
    validateBoxNumber,
    suggestNextBoxNumber,
    formatWarehouseLocation,
    buildBesshi23Rows,
    addBookToSelection,
    validateCatalogDataset,
    parseCsvText,
    generateCsvText,
    guessColumnMapping,
    computeChangesDiff,
    encodeChangesToQrChunks,
    decodeQrChunkText
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = CoreLogic;
  }
  globalScope.BookLocationCore = CoreLogic;
})(typeof window !== "undefined" ? window : globalThis);
