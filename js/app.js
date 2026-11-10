/**
 * 蔵書保管場所 変更・記録システム メインUIコントローラ (app.js)
 * -------------------------------------------------------------------------
 * 役割:
 * - iPhone現場モード（移動先設定、カメラ連続スキャン、ブラウザ内OCR、模擬OCR検証、手動検索、
 *   候補選択、二重追加防止、LocalStorage中断再開、変更CSV出力、QRコード生成）
 * - PC台帳管理モード（蔵書一覧検索、CSV取込＆列マッピング、登録番号重複検証、
 *   スマホ変更データのDiff比較、更新用CSV出力、日高倉庫別紙2-3転記データ出力、履歴・バックアップ）
 */

(function () {
  "use strict";

  const Core = window.BookLocationCore;
  const QR = window.QRCodeMini;

  // LocalStorage 保存キー（デモデータと本番データを厳密に分離）
  const STORAGE_KEYS = {
    ACTIVE_DATA_MODE: "blm_active_data_mode_v1", // "DEMO" | "PRODUCTION"
    DEMO_CATALOG: "blm_demo_state_v1",
    PROD_CATALOG: "blm_prod_state_v1",
    MOBILE_SESSION: "blm_mobile_session_v1",
    CHANGE_HISTORY: "blm_change_history_v1"
  };

  // アプリケーション状態
  const state = {
    isDemoMode: true,
    catalogBooks: [],
    mockOcrCases: [],
    // iPhone側の状態
    mobileDestMode: "HQ", // "HQ" | "WAREHOUSE"
    mobileCandidates: [],
    mobileLastMatchInfo: null,
    mobileScannedBatches: [], // 連続スキャンで検出された候補グループを消さずに蓄積する配列
    mobileSelectedList: [],
    mobileQrChunks: [],
    mobileQrPageIndex: 0,
    // カメラ・連続読取の状態
    cameraStream: null,
    cameraIntervalId: null,
    isOcrBusy: false,
    awaitingDisambiguation: false, // 複数候補ヒット時にいずれかを特定するまで次のスキャンを一時停止するフラグ
    cooldownUntilMs: 0,            // 1冊確定直後の3.5秒間、次の本を用意する間のクールタイムお休み時刻
    prevMotionSample: null,        // カメラ映像のモーション（手・本の動き）検知用サンプル
    audioCtx: null,
    tesseractWorker: null,
    lastFrameSignature: "",
    // PC側の状態
    pendingCsvRawHeaders: [],
    pendingCsvRawRecords: [],
    pcDiffRecords: [],
    pcQrStream: null,
    pcQrIntervalId: null,
    changeHistory: []
  };

  // =========================================================================
  // ユーティリティ（トースト・進捗表示・エスケープ・ファイルダウンロード）
  // =========================================================================
  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function showToast(message, type = "info") {
    const container = document.getElementById("toastContainer");
    if (!container) return;
    const div = document.createElement("div");
    div.className = `toast ${type === "error" ? "toast-error" : type === "success" ? "toast-success" : ""}`;
    div.textContent = message;
    container.appendChild(div);
    setTimeout(() => {
      if (div.parentNode) div.parentNode.removeChild(div);
    }, 4200);
  }

  /**
   * 判定結果に応じた振動・電子音（Web Audio API）・画面フラッシュを実行
   * type: "SUCCESS" (1冊確定) | "MULTI" (複数候補・特定待ち) | "ERROR" (該当なし・重複エラー)
   */
  function triggerScanFeedback(type) {
    const enabled = document.getElementById("chkSoundFeedback")?.checked !== false;
    const viewport = document.getElementById("cameraViewport");

    // 1. 画面フラッシュ演出
    if (viewport) {
      viewport.classList.remove("flash-success", "flash-warning", "flash-error");
      void viewport.offsetWidth;
      if (type === "SUCCESS") viewport.classList.add("flash-success");
      else if (type === "MULTI") viewport.classList.add("flash-warning");
      else viewport.classList.add("flash-error");
    }

    if (!enabled) return;

    // 2. バイブレーション（Android用 navigator.vibrate + iOS 18+ switch 触覚トリガー）
    try {
      if (navigator.vibrate) {
        if (type === "SUCCESS") navigator.vibrate(90);
        else if (type === "MULTI") navigator.vibrate([80, 60, 80]);
        else navigator.vibrate([180, 80, 180]);
      }
      const hapticEl = document.getElementById("iosHapticSwitch");
      if (hapticEl) hapticEl.click();
    } catch (_) {}

    // 3. 電子ビープ音（Web Audio API）
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!state.audioCtx) state.audioCtx = new AudioCtx();
      if (state.audioCtx.state === "suspended") state.audioCtx.resume();

      const playTone = (freq, startOffset, duration, wave = "sine") => {
        const osc = state.audioCtx.createOscillator();
        const gain = state.audioCtx.createGain();
        osc.type = wave;
        osc.frequency.setValueAtTime(freq, state.audioCtx.currentTime + startOffset);
        gain.gain.setValueAtTime(0.18, state.audioCtx.currentTime + startOffset);
        gain.gain.exponentialRampToValueAtTime(0.001, state.audioCtx.currentTime + startOffset + duration);
        osc.connect(gain);
        gain.connect(state.audioCtx.destination);
        osc.start(state.audioCtx.currentTime + startOffset);
        osc.stop(state.audioCtx.currentTime + startOffset + duration);
      };

      if (type === "SUCCESS") {
        // 1冊確定: 軽快な「ピッ♪」
        playTone(1320, 0, 0.14, "sine");
      } else if (type === "MULTI") {
        // 複数ヒット（要特定）: 注意音「ピピッ！」
        playTone(880, 0, 0.1, "triangle");
        playTone(1174, 0.13, 0.14, "triangle");
      } else {
        // 該当なし・エラー: 低音「ブブーッ！」
        playTone(240, 0, 0.16, "sawtooth");
        playTone(190, 0.2, 0.24, "sawtooth");
      }
    } catch (_) {}
  }

  function updateProgress(visible, stepName = "", current = 0, total = 0, startTimeMs = 0) {
    const panel = document.getElementById("globalProgressPanel");
    if (!panel) return;
    if (!visible) {
      panel.classList.add("hidden");
      return;
    }
    panel.classList.remove("hidden");
    const elapsedSec = startTimeMs ? ((Date.now() - startTimeMs) / 1000).toFixed(1) : "0.0";
    document.getElementById("progressStepText").textContent = stepName;
    document.getElementById("progressMetaText").textContent = `${current} / ${total}件 (経過: ${elapsedSec}秒)`;
    const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 50;
    document.getElementById("progressBarFill").style.width = `${pct}%`;
  }

  function downloadFile(filename, content, mimeType = "text/csv;charset=utf-8") {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function formatDateTime(isoStr) {
    if (!isoStr) return "";
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // =========================================================================
  // 初期化・データ永続化（デモデータと本番データの分離管理）
  // =========================================================================
  function initApp() {
    const defaultDataset = window.DEMO_DATASET || { books: [], mock_ocr_cases: [] };
    state.mockOcrCases = defaultDataset.mock_ocr_cases || [];

    // 履歴の読込
    try {
      const savedHist = localStorage.getItem(STORAGE_KEYS.CHANGE_HISTORY);
      if (savedHist) state.changeHistory = JSON.parse(savedHist);
    } catch (_) {
      state.changeHistory = [];
    }

    // スマホ作業途中セッションの復元
    try {
      const savedSession = localStorage.getItem(STORAGE_KEYS.MOBILE_SESSION);
      if (savedSession) {
        const parsed = JSON.parse(savedSession);
        if (Array.isArray(parsed.selectedList)) {
          state.mobileSelectedList = parsed.selectedList;
        }
        if (Array.isArray(parsed.scannedBatches)) {
          state.mobileScannedBatches = parsed.scannedBatches;
        }
        if (parsed.destMode) state.mobileDestMode = parsed.destMode;
        if (parsed.hqLocation) {
          document.getElementById("mobileHqLocationInput").value = parsed.hqLocation;
        }
        if (parsed.boxNumber) {
          document.getElementById("mobileBoxNumberInput").value = parsed.boxNumber;
        }
      }
    } catch (_) {
      state.mobileSelectedList = [];
      state.mobileScannedBatches = [];
    }

    // カタログデータの復元（分離されたストレージキーから読込）
    const savedMode = localStorage.getItem(STORAGE_KEYS.ACTIVE_DATA_MODE) || "DEMO";
    if (savedMode === "PRODUCTION") {
      try {
        const prodRaw = localStorage.getItem(STORAGE_KEYS.PROD_CATALOG);
        if (prodRaw) {
          const parsedProd = JSON.parse(prodRaw);
          if (Array.isArray(parsedProd) && parsedProd.length > 0) {
            state.isDemoMode = false;
            state.catalogBooks = parsedProd;
          }
        }
      } catch (_) {}
    }

    if (state.catalogBooks.length === 0) {
      state.isDemoMode = true;
      try {
        const demoRaw = localStorage.getItem(STORAGE_KEYS.DEMO_CATALOG);
        if (demoRaw) {
          const parsedDemo = JSON.parse(demoRaw);
          if (Array.isArray(parsedDemo) && parsedDemo.length > 0) {
            state.catalogBooks = parsedDemo;
          }
        }
      } catch (_) {}
      if (state.catalogBooks.length === 0) {
        state.catalogBooks = JSON.parse(JSON.stringify(defaultDataset.books || []));
      }
    }

    bindEvents();
    populateMockOcrPresets();
    setMobileDestinationMode(state.mobileDestMode);
    refreshAllViews();

    // 初期描画
    renderCandidatesList();
  }

  function saveCurrentCatalogToStorage() {
    try {
      localStorage.setItem(STORAGE_KEYS.ACTIVE_DATA_MODE, state.isDemoMode ? "DEMO" : "PRODUCTION");
      const targetKey = state.isDemoMode ? STORAGE_KEYS.DEMO_CATALOG : STORAGE_KEYS.PROD_CATALOG;
      localStorage.setItem(targetKey, JSON.stringify(state.catalogBooks));
    } catch (e) {
      showToast("ブラウザ内保存領域（LocalStorage）への保存に失敗しました。", "error");
    }
  }

  function saveMobileSessionToStorage() {
    try {
      const payload = {
        destMode: state.mobileDestMode,
        hqLocation: document.getElementById("mobileHqLocationInput").value,
        boxNumber: document.getElementById("mobileBoxNumberInput").value,
        selectedList: state.mobileSelectedList,
        scannedBatches: state.mobileScannedBatches.slice(0, 20),
        savedAt: new Date().toISOString()
      };
      localStorage.setItem(STORAGE_KEYS.MOBILE_SESSION, JSON.stringify(payload));
    } catch (_) {}
  }

  function saveHistoryToStorage() {
    try {
      localStorage.setItem(STORAGE_KEYS.CHANGE_HISTORY, JSON.stringify(state.changeHistory));
    } catch (_) {}
  }

  function refreshAllViews() {
    renderDataModeBanner();
    updateMobileBoxValidationUi();
    renderMobileSelectedList();
    populateDepartmentFilter();
    renderPcCatalogTable();
    renderPcWarehouseView();
    renderPcHistoryTable();
  }

  function renderDataModeBanner() {
    const banner = document.getElementById("dataModeBanner");
    const badge = document.getElementById("dataModeBadge");
    const text = document.getElementById("dataModeText");
    const countLabel = document.getElementById("catalogCountLabel");
    const mobileStatus = document.getElementById("mobileCatalogStatus");

    countLabel.textContent = `蔵書件数: ${state.catalogBooks.length}件`;

    if (state.isDemoMode) {
      banner.className = "data-mode-banner is-demo";
      badge.className = "badge badge-demo";
      badge.textContent = "デモデータ稼働中";
      text.textContent = "現在は開発・検証用の架空データ（添付書籍4冊＋架空蔵書）を表示しています。実データではありません。";
      mobileStatus.className = "badge badge-demo";
      mobileStatus.textContent = `デモデータ ${state.catalogBooks.length}件`;
    } else {
      banner.className = "data-mode-banner is-production";
      badge.className = "badge badge-prod";
      badge.textContent = "取込データ（本番・実務モード）";
      text.textContent = "利用者が取り込んだ蔵書データを表示しています（デモデータとは分離して端末内に保持されています）。";
      mobileStatus.className = "badge badge-prod";
      mobileStatus.textContent = `取込データ ${state.catalogBooks.length}件`;
    }
  }

  // =========================================================================
  // 📱 iPhone現場モード：移動先設定・箱番号次番号提示
  // =========================================================================
  function setMobileDestinationMode(mode) {
    state.mobileDestMode = mode === "WAREHOUSE" ? "WAREHOUSE" : "HQ";
    const btnHq = document.getElementById("btnDestModeHq");
    const btnWh = document.getElementById("btnDestModeWarehouse");
    const areaHq = document.getElementById("hqDestConfigArea");
    const areaWh = document.getElementById("warehouseDestConfigArea");

    if (state.mobileDestMode === "WAREHOUSE") {
      btnHq.className = "btn btn-outline";
      btnWh.className = "btn btn-warehouse";
      areaHq.classList.add("hidden");
      areaWh.classList.remove("hidden");
      updateMobileBoxValidationUi();
    } else {
      btnHq.className = "btn btn-primary";
      btnWh.className = "btn btn-outline";
      areaHq.classList.remove("hidden");
      areaWh.classList.add("hidden");
    }
    saveMobileSessionToStorage();
    renderCandidatesList();
  }

  function updateMobileBoxValidationUi() {
    const boxInput = document.getElementById("mobileBoxNumberInput");
    const statusBox = document.getElementById("mobileBoxValidationStatus");
    if (!boxInput || !statusBox) return;

    const res = Core.validateBoxNumber(boxInput.value, state.catalogBooks, state.mobileSelectedList);
    if (!res.isValid) {
      statusBox.className = "alert alert-danger";
      statusBox.textContent = `❌ ${res.error}`;
    } else if (res.isExistingBox) {
      statusBox.className = "alert alert-warning";
      statusBox.textContent = `⚠️ ${res.message}`;
    } else {
      statusBox.className = "alert alert-success";
      statusBox.textContent = `✅ ${res.message}（発送時の所在表記: ${Core.formatWarehouseLocation(res.normalized)}）`;
    }
  }

  function getActiveDestinationConfig() {
    const workerNote = document.getElementById("mobileWorkerNoteInput").value.trim();
    if (state.mobileDestMode === "WAREHOUSE") {
      const rawBox = document.getElementById("mobileBoxNumberInput").value.trim();
      const vBox = Core.validateBoxNumber(rawBox, state.catalogBooks, state.mobileSelectedList);
      return {
        mode: "WAREHOUSE",
        isValid: vBox.isValid,
        error: vBox.error,
        boxNumber: vBox.normalized,
        location: Core.formatWarehouseLocation(vBox.normalized),
        workerNote
      };
    } else {
      const loc = document.getElementById("mobileHqLocationInput").value.trim();
      return {
        mode: "HQ",
        isValid: loc.length > 0,
        error: loc.length > 0 ? "" : "移動先の保管場所を入力してください。",
        boxNumber: "",
        location: loc,
        workerNote
      };
    }
  }

  // =========================================================================
  // 📱 iPhone現場モード：模擬OCR・実機カメラ連続OCR・手動検索
  // =========================================================================
  function switchMobileScanTab(tabName) {
    const tabs = {
      CAMERA: { btn: "btnScanTabCamera", panel: "scanPanelCamera" },
      MOCK: { btn: "btnScanTabMockOcr", panel: "scanPanelMockOcr" },
      MANUAL: { btn: "btnScanTabManual", panel: "scanPanelManual" }
    };

    Object.entries(tabs).forEach(([key, cfg]) => {
      const b = document.getElementById(cfg.btn);
      const p = document.getElementById(cfg.panel);
      if (key === tabName) {
        b.className = "btn btn-primary btn-sm";
        p.classList.remove("hidden");
      } else {
        b.className = "btn btn-outline btn-sm";
        p.classList.add("hidden");
      }
    });

    if (tabName !== "CAMERA") {
      stopMobileCamera();
    }
  }

  function populateMockOcrPresets() {
    const sel = document.getElementById("mockOcrPresetSelect");
    const ta = document.getElementById("mockOcrRawTextarea");
    if (!sel || !ta) return;

    sel.innerHTML = "";
    state.mockOcrCases.forEach((c, idx) => {
      const opt = document.createElement("option");
      opt.value = String(idx);
      opt.textContent = c.label;
      sel.appendChild(opt);
    });

    if (state.mockOcrCases.length > 0) {
      ta.value = state.mockOcrCases[0].raw_text;
    }
  }

  function runMockOcrByIndex(index, silent = false) {
    const item = state.mockOcrCases[index];
    if (!item) return;
    document.getElementById("mockOcrPresetSelect").value = String(index);
    document.getElementById("mockOcrRawTextarea").value = item.raw_text;
    executeOcrTextMatch(item.raw_text, "【模擬OCR検証データ】", { silentInit: silent });
    if (!silent) {
      showToast(`模擬OCR「${item.label}」で照合を実行しました。`);
    }
  }

  /**
   * カメラフレームの中央ガイド枠エリア（86%）を切り抜き、小文字の漢字・数字も潰れない720px幅の
   * グレースケール＆コントラスト強調画像へ変換する。周囲の机・背景ノイズをカットしつつ1発でのOCR認識率と速度を両立する。
   */
  function prepareFastOcrCanvas(video, targetCanvas) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const cropRatio = 0.86;
    const sx = Math.round(vw * ((1 - cropRatio) / 2));
    const sy = Math.round(vh * ((1 - cropRatio) / 2));
    const sw = Math.max(1, Math.round(vw * cropRatio));
    const sh = Math.max(1, Math.round(vh * cropRatio));
    const scale = Math.min(1, 720 / sw);
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    targetCanvas.width = w;
    targetCanvas.height = h;
    const ctx = targetCanvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);

    try {
      const imgData = ctx.getImageData(0, 0, w, h);
      const d = imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        const lum = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
        // 緩やかなコントラスト強調（文字をくっきりさせる）
        const c = lum < 110 ? Math.max(0, (lum - 110) * 1.35 + 110) : Math.min(255, (lum - 110) * 1.15 + 110);
        d[i] = d[i + 1] = d[i + 2] = c;
      }
      ctx.putImageData(imgData, 0, 0);
    } catch (_) {}
  }

  /**
   * スキャン・OCR照合の即時判定処理（待ち時間ゼロ・高速連続スキャン版）:
   * 1. 該当する図書が「1冊のみ」の場合 ➔ 待ち時間ゼロで即座に自動確定（既に確定済みの本が映り続けている間は静かにスルー）
   * 2. 「複数ヒット」した場合 ➔ ポップアップで特定するまで次のスキャンを一時停止（ロック）
   * 3. 「該当なし」の場合 ➔ 奥付ページ（ISBNまたは本の奥付定型語）を検知したのにDBに該当がない場合は、
   *    即座に警告音・赤フラッシュ・画面表示で「該当なし」を返し、読み取った言葉からワンタップで手動検索できるようにする
   */
  function executeOcrTextMatch(rawText, sourceLabel = "【OCR読取結果】", options = {}) {
    const isContinuousCamera = Boolean(options.isContinuousCamera);
    const silentInit = Boolean(options.silentInit);
    const matchResult = Core.matchBooksFromOcr(rawText, state.catalogBooks);
    const features = matchResult.extractedFeatures || {
      exactIsbns: [],
      fuzzyIsbnPrefixes: [],
      lines: [],
      isColophonPage: false,
      searchKeywords: []
    };

    // A. 蔵書リストに該当するものがない場合
    if (matchResult.candidates.length === 0) {
      const isColophonDetected = features.exactIsbns.length > 0 || Boolean(features.isColophonPage);
      // 連続カメラの自動スキャン中は、机や背景など「奥付ページではないフレーム」は静かにスルーし、未登録本のロックも解除する
      if (isContinuousCamera && !isColophonDetected) {
        state.lastUnmatchedIsbn = "";
        return { matched: false, count: 0, status: "RESTING_NON_COLOPHON" };
      }
      const detectedSample =
        features.exactIsbns[0] ||
        features.fuzzyIsbnPrefixes[0]?.digits ||
        features.searchKeywords?.[0] ||
        (features.lines[0] ? features.lines[0].slice(0, 22) : "読取文字");

      const nowMs = Date.now();
      // 同じ未登録本をかざし続けている3.5秒間は連続で何度も警告音が鳴らないようにする
      if (
        isContinuousCamera &&
        state.lastUnmatchedIsbn === detectedSample &&
        nowMs < (state.unmatchedAlertUntilMs || 0)
      ) {
        return { matched: false, count: 0, status: "NO_CANDIDATE_HOLD", detectedSample };
      }
      state.lastUnmatchedIsbn = detectedSample;
      state.unmatchedAlertUntilMs = nowMs + 3500;

      state.mobileLastMatchInfo = {
        sourceLabel,
        status: "NO_CANDIDATE",
        statusLabel: `❌ 奥付を読み取りましたが、蔵書リストに該当する図書がありません（読取: "${detectedSample}"）`,
        detectedSample,
        extractedKeywords: features.searchKeywords || []
      };
      if (!silentInit) {
        triggerScanFeedback("ERROR");
        showToast(`❌ 蔵書リストに該当する図書がありません（読取: ${detectedSample}）`, "error");
      }
      renderCandidatesList();
      return { matched: false, count: 0, status: "NO_CANDIDATE", detectedSample };
    }

    state.lastUnmatchedIsbn = "";
    state.unmatchedAlertUntilMs = 0;
    state.mobileLastMatchInfo = {
      sourceLabel,
      ...matchResult
    };
    state.mobileCandidates = matchResult.candidates;

    // B. 蔵書リストに該当するものが「1冊」であれば、スキャンした瞬間に自動確定（レストタイム0秒ですぐ次へ）！
    if (matchResult.candidates.length === 1 && !silentInit) {
      const singleBook = matchResult.candidates[0].book;
      const destConfig = getActiveDestinationConfig();

      if (destConfig.isValid) {
        const addRes = Core.addBookToSelection(state.mobileSelectedList, singleBook, {
          mode: destConfig.mode,
          location: destConfig.location,
          boxNumber: destConfig.boxNumber,
          workerNote: destConfig.workerNote
        });

        if (addRes.added) {
          state.mobileSelectedList = addRes.list;
          state.awaitingDisambiguation = false;
          saveMobileSessionToStorage();
          triggerScanFeedback("SUCCESS");
          showToast(`✅ 1冊確定: ${singleBook.book_id}『${singleBook.title}』`, "success");
        } else {
          // 既に登録済みの本がカメラの前に残っている間は、連続カメラ時は無音でスルー（手動実行時のみ通知）
          if (!isContinuousCamera) {
            triggerScanFeedback("ERROR");
            showToast(`⚠️ ${addRes.message}`, "error");
          } else {
            return { matched: true, count: 1, status: "ALREADY_CONFIRMED_SILENT" };
          }
        }
      } else {
        triggerScanFeedback("MULTI");
        showToast("移動先が未設定のため保留しました。移動先を指定してください。", "error");
      }

      pushToScannedBatches({
        sourceLabel: `${sourceLabel}（1冊即時確定）`,
        status: matchResult.status,
        statusLabel: `✅ 1冊該当（${singleBook.book_id}）のため自動確定しました。`,
        candidates: matchResult.candidates,
        detectedAt: new Date().toLocaleTimeString()
      });
      renderCandidatesList();
      renderMobileSelectedList();
      updateMobileBoxValidationUi();
      return { matched: true, count: 1, status: "AUTO_CONFIRMED" };
    }

    // C. 複数ヒットした場合：もしその複数候補のうち1冊が「すでに登録済み」で、同じ本がカメラに映り続けているだけなら再ポップアップしない
    if (
      isContinuousCamera &&
      state.lastConfirmedMultiKey === matchResult.candidates.map((c) => c.book.book_id).join(",")
    ) {
      return { matched: true, count: matchResult.candidates.length, status: "ALREADY_CONFIRMED_SILENT" };
    }

    // C. 複数ヒットした場合（または初回デモ表示時）：いずれの図書かを特定するまで次のスキャンを一時ロック！
    if (!silentInit) {
      state.awaitingDisambiguation = true;
      triggerScanFeedback("MULTI");
      showToast(
        `⚠️ ${matchResult.candidates.length}冊ヒットしました！どの図書か特定（選択）してから次の奥付をスキャンしてください。`,
        "info"
      );
      const statusPill = document.getElementById("cameraStatusPill");
      if (statusPill && state.cameraStream) {
        statusPill.textContent = `⏸️ 複数候補（${matchResult.candidates.length}冊）特定待ち ― 下の候補から1冊選ぶとスキャン再開します`;
      }
    }

    pushToScannedBatches({
      sourceLabel,
      status: matchResult.status,
      statusLabel: matchResult.statusLabel,
      candidates: matchResult.candidates,
      detectedAt: new Date().toLocaleTimeString()
    });

    renderCandidatesList();
    return { matched: true, count: matchResult.candidates.length, status: "MULTIPLE_AWAITING" };
  }

  /**
   * 連続スキャンされた候補バッチを重複なくストック先頭に追加する
   */
  function pushToScannedBatches(batchObj) {
    const key = batchObj.candidates.map((c) => c.book.book_id).sort().join(",");
    if (!key) return;

    // すでに同じ候補セット（同じISBN/同じ図書群）がストックにあれば、時刻とラベルを更新して先頭へ移動（消えない）
    const existingIdx = state.mobileScannedBatches.findIndex(
      (b) => b.key === key
    );
    const entry = {
      batchId: "SCAN-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      key,
      sourceLabel: batchObj.sourceLabel,
      status: batchObj.status,
      statusLabel: batchObj.statusLabel,
      candidates: batchObj.candidates,
      detectedAt: batchObj.detectedAt || new Date().toLocaleTimeString()
    };

    if (existingIdx !== -1) {
      state.mobileScannedBatches.splice(existingIdx, 1);
    }
    state.mobileScannedBatches.unshift(entry);
    saveMobileSessionToStorage();
  }

  function executeMobileManualSearch(queryText) {
    const results = Core.searchBooksManually(queryText, state.catalogBooks);
    if (results.length === 0) {
      state.mobileLastMatchInfo = {
        sourceLabel: `【手動検索: "${queryText || ""}"】`,
        status: "NO_CANDIDATE",
        statusLabel: `❌ 「${queryText}」に一致する図書は見つかりませんでした。`
      };
      state.mobileCandidates = [];
      triggerScanFeedback("ERROR");
      renderCandidatesList();
      return;
    }

    if (results.length === 1) {
      executeOcrTextMatch(results[0].book_id + " " + results[0].title, `【手動検索1冊確定】`);
      return;
    }

    const candidates = results.slice(0, 30).map((b) => ({
      book: b,
      score: 100,
      isExactIsbnHit: false,
      isFuzzyHit: false,
      reasons: ["手動検索ヒット"]
    }));

    state.mobileLastMatchInfo = {
      sourceLabel: `【手動検索: "${queryText || "全件"}"】`,
      status: "MULTIPLE_CANDIDATES",
      statusLabel: `手動検索で ${results.length} 冊ヒットしました。対象の図書をタップして特定してください。`,
      requiresManualCheck: true
    };
    state.mobileCandidates = candidates;
    state.awaitingDisambiguation = true;
    triggerScanFeedback("MULTI");
    renderCandidatesList();
  }

  // 複数ヒット時のポップアップ（モーダル）描画＆ステータスバナー更新
  function renderCandidatesList() {
    const banner = document.getElementById("matchStatusBanner");
    const modal = document.getElementById("multiHitModal");
    const modalTitle = document.getElementById("multiHitModalTitle");
    const modalSub = document.getElementById("multiHitModalSub");
    const container = document.getElementById("candidatesContainer");
    if (!banner || !container) return;

    const info = state.mobileLastMatchInfo;
    if (info && info.status === "NO_CANDIDATE") {
      const kws = Array.isArray(info.extractedKeywords) ? info.extractedKeywords : [];
      const chipsHtml = kws.length > 0
        ? `<div style="margin-top:8px; display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
             <span style="font-size:0.76rem; color:var(--text-sub);">👆 読取文字で手動検索:</span>
             ${kws
               .map(
                 (kw) =>
                   `<button type="button" class="btn btn-outline btn-sm btn-quick-search-kw" data-kw="${escapeHtml(
                     kw
                   )}" style="min-height:28px; padding:2px 8px; font-size:0.76rem; background:#fff;">🔍 ${escapeHtml(
                     kw
                   )}</button>`
               )
               .join("")}
           </div>`
        : "";
      banner.className = "alert alert-danger";
      banner.innerHTML = `<strong>${escapeHtml(info.sourceLabel)}</strong><br/>${escapeHtml(info.statusLabel)}${chipsHtml}`;
      banner.querySelectorAll(".btn-quick-search-kw").forEach((btn) => {
        btn.addEventListener("click", () => {
          const kw = btn.getAttribute("data-kw") || "";
          const manualInput = document.getElementById("mobileManualSearchInput");
          if (manualInput) manualInput.value = kw;
          executeMobileManualSearch(kw);
        });
      });
    } else if (state.awaitingDisambiguation) {
      banner.className = "alert alert-warning";
      banner.innerHTML = `<strong>⏸️ 複数冊ヒット（${state.mobileCandidates.length}冊）― ポップアップ画面で図書を特定してください</strong>`;
    } else if (state.mobileSelectedList.length > 0) {
      const latest = state.mobileSelectedList[0];
      banner.className = "alert alert-success";
      banner.innerHTML = `<strong>✅ 直近確定: ${escapeHtml(latest.book_id)}『${escapeHtml(latest.title)}』</strong> ― 続けて次の奥付をスキャンできます`;
    } else {
      banner.className = "alert alert-info";
      banner.innerHTML = "奥付をスキャンすると、1冊該当なら即座に一覧へ確定され、複数該当ならポップアップ画面で特定できます。";
    }

    // 複数ヒット特定待ちでない場合はポップアップを閉じる
    if (!state.awaitingDisambiguation || state.mobileCandidates.length === 0) {
      if (modal) modal.classList.add("hidden");
      container.innerHTML = "";
      return;
    }

    const destConfig = getActiveDestinationConfig();
    const destLabel = destConfig.mode === "WAREHOUSE"
      ? `📦 ${destConfig.location}`
      : `🏢 ${destConfig.location || "(移動先未入力)"}`;

    if (modal) modal.classList.remove("hidden");
    if (modalTitle) {
      modalTitle.textContent = `⚠️ ${state.mobileCandidates.length}冊ヒット：いずれの図書か特定してください`;
    }
    if (modalSub) {
      modalSub.textContent = `${info ? info.sourceLabel : ""} ― 現物と一致する1冊をタップすると確定され、次のスキャンへ進みます。`;
    }

    container.innerHTML = state.mobileCandidates
      .map((cand) => {
        const b = cand.book;
        const alreadySelected = state.mobileSelectedList.some((s) => s.book_id === b.book_id);
        return `
          <div class="candidate-card ${alreadySelected ? "is-already-selected" : "high-match"}" style="padding:10px; margin-bottom:8px;">
            <div class="candidate-id-row" style="margin-bottom:4px;">
              <span class="book-id-tag" style="font-size:0.85rem;">${escapeHtml(b.book_id)}</span>
              <span style="font-size:0.78rem; font-weight:700; color:var(--text-sub);">
                ${escapeHtml(b.edition || "版未登録")} (${escapeHtml(b.pub_year || "-")}年) / ${escapeHtml(b.department || "-")}
              </span>
            </div>
            <div style="font-weight:700; font-size:0.92rem; margin-bottom:4px;">${escapeHtml(b.title)}</div>
            <div style="font-size:0.78rem; color:var(--text-sub); margin-bottom:8px;">
              現在場所: <strong>${escapeHtml(b.location || "未登録")}</strong>
              ${b.notes ? ` / <span style="color:var(--warning);">${escapeHtml(b.notes)}</span>` : ""}
            </div>
            <button
              type="button"
              class="btn ${alreadySelected ? "btn-outline" : "btn-primary"} btn-sm btn-block btn-select-candidate"
              data-book-id="${escapeHtml(b.book_id)}"
              ${alreadySelected ? "disabled" : ""}
            >
              ${alreadySelected
                ? `✅ スキャン完了済み（${escapeHtml(b.book_id)}）`
                : `👆 この図書（${escapeHtml(b.book_id)}）に特定して確定（➔ ${escapeHtml(destLabel)}）`}
            </button>
          </div>
        `;
      })
      .join("");

    container.querySelectorAll(".btn-select-candidate").forEach((btn) => {
      btn.addEventListener("click", () => {
        const bookId = btn.getAttribute("data-book-id");
        handleSelectCandidateBook(bookId);
      });
    });
  }

  function handleSelectCandidateBook(bookId) {
    const book = state.catalogBooks.find((b) => b.book_id === bookId);
    if (!book) return;

    const destConfig = getActiveDestinationConfig();
    if (!destConfig.isValid) {
      triggerScanFeedback("ERROR");
      showToast(destConfig.error || "移動先の設定を確認してください。", "error");
      return;
    }

    const res = Core.addBookToSelection(state.mobileSelectedList, book, {
      mode: destConfig.mode,
      location: destConfig.location,
      boxNumber: destConfig.boxNumber,
      workerNote: destConfig.workerNote
    });

    if (!res.added) {
      triggerScanFeedback("ERROR");
      showToast(res.message, "error");
      return;
    }

    state.mobileSelectedList = res.list;
    // 特定が完了したのでポップアップを閉じ、同じ複数候補セットでの再ポップアップを抑止して即座に次のスキャンを再開！
    state.lastConfirmedMultiKey = state.mobileCandidates.map((c) => c.book.book_id).join(",");
    state.awaitingDisambiguation = false;
    const statusPill = document.getElementById("cameraStatusPill");
    if (statusPill && state.cameraStream) {
      statusPill.textContent = "✅ 図書を特定・確定しました！続けて次の奥付をスキャンできます";
    }

    triggerScanFeedback("SUCCESS");
    saveMobileSessionToStorage();
    renderCandidatesList();
    renderMobileSelectedList();
    updateMobileBoxValidationUi();
    showToast(res.message, "success");
  }

  // 4. スキャン完了した図書一覧（本が特定できる最小情報のみのスリム表示）
  function renderMobileSelectedList() {
    const countSpan = document.getElementById("mobileSelectedCount");
    const bulkCountSpan = document.getElementById("mobileBulkUpdateCount");
    const container = document.getElementById("mobileSelectedListContainer");
    if (!countSpan || !container) return;

    countSpan.textContent = String(state.mobileSelectedList.length);
    if (bulkCountSpan) {
      bulkCountSpan.textContent = String(state.mobileSelectedList.length);
    }

    if (state.mobileSelectedList.length === 0) {
      container.innerHTML = `
        <div style="text-align:center; padding:12px; color:var(--text-muted); font-size:0.83rem; background:#fff;">
          まだスキャン完了した図書はありません。
        </div>
      `;
      return;
    }

    container.innerHTML = state.mobileSelectedList
      .map((item, idx) => {
        return `
          <div class="compact-book-row">
            <div style="min-width:0; flex:1;">
              <div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                <span class="book-id-tag" style="font-size:0.75rem; padding:1px 6px; margin-right:4px;">${escapeHtml(item.book_id)}</span>
                <strong>${escapeHtml(item.title)}</strong>
              </div>
              <div style="font-size:0.74rem; color:var(--text-sub); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px;">
                ${escapeHtml(item.edition || "-")} / ${escapeHtml(item.department || "-")} ➔ <span class="diff-new">${escapeHtml(item.new_location)}</span>
              </div>
            </div>
            <button type="button" class="btn btn-outline btn-sm btn-remove-selected" data-index="${idx}" style="min-height:28px; padding:2px 8px; font-size:0.74rem; color:var(--danger); border-color:var(--danger); flex-shrink:0;">
              取消
            </button>
          </div>
        `;
      })
      .join("");

    container.querySelectorAll(".btn-remove-selected").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.getAttribute("data-index"), 10);
        const removed = state.mobileSelectedList[idx];
        state.mobileSelectedList.splice(idx, 1);
        saveMobileSessionToStorage();
        renderCandidatesList();
        renderMobileSelectedList();
        updateMobileBoxValidationUi();
        if (removed) {
          showToast(`「${removed.book_id}: ${removed.title}」の選択を取り消しました。`);
        }
      });
    });

    // QRコードが表示中なら更新
    if (!document.getElementById("mobileQrArea").classList.contains("hidden")) {
      renderMobileQrCode();
    }
  }

  // QRコード表示
  function renderMobileQrCode() {
    const qrArea = document.getElementById("mobileQrArea");
    const canvas = document.getElementById("mobileQrCanvas");
    const pageLabel = document.getElementById("mobileQrPageLabel");
    const payloadTa = document.getElementById("mobileQrPayloadText");

    if (state.mobileSelectedList.length === 0) {
      qrArea.classList.add("hidden");
      showToast("選択済みの図書が0件のため、QRコードを生成できません。", "error");
      return;
    }

    state.mobileQrChunks = Core.encodeChangesToQrChunks(state.mobileSelectedList);
    if (state.mobileQrPageIndex >= state.mobileQrChunks.length) {
      state.mobileQrPageIndex = 0;
    }

    const chunk = state.mobileQrChunks[state.mobileQrPageIndex];
    try {
      QR.renderToCanvas(canvas, chunk.jsonText, 240);
      pageLabel.textContent = `QR ${chunk.page} / ${chunk.totalPages} 枚目（このQRに ${chunk.itemCount}冊 収録）`;
      payloadTa.value = chunk.jsonText;
      qrArea.classList.remove("hidden");
    } catch (e) {
      showToast("QRコードの生成中にエラーが発生しました: " + e.message, "error");
    }
  }

  // =========================================================================
  // 📷 実機カメラ連続スキャン＆ブラウザ内OCR (Tesseract.js / BarcodeDetector)
  // =========================================================================
  async function startMobileCamera() {
    const statusPill = document.getElementById("cameraStatusPill");
    const video = document.getElementById("cameraVideo");
    const btnStart = document.getElementById("btnStartCamera");
    const btnStop = document.getElementById("btnStopCamera");
    const btnSnapNow = document.getElementById("btnAnalyzeCurrentFrameNow");

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      statusPill.textContent = "カメラAPI非対応（HTTPSまたはlocalhostが必要です）";
      showToast(
        "このブラウザ環境ではカメラ直接起動が制限されています。下の「奥付写真を選択」または「模擬OCR」「手動検索」をご利用ください。",
        "error"
      );
      return;
    }

    try {
      statusPill.textContent = "カメラ起動中...";
      statusPill.style.backgroundColor = "rgba(15, 23, 42, 0.82)";
      statusPill.style.color = "#38bdf8";

      // 再開時に黒帯（レターボックス）が出ないよう、端末の自然なカメラ比率＋object-fit:coverで全面描画する
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" }
        },
        audio: false
      });

      state.cameraStream = stream;
      video.srcObject = stream;
      video.style.width = "100%";
      video.style.height = "100%";
      video.style.objectFit = "cover";
      await new Promise((resolve) => {
        if (video.readyState >= 1) {
          resolve();
        } else {
          video.onloadedmetadata = () => resolve();
        }
      });
      await video.play();

      btnStart.disabled = true;
      btnStop.disabled = false;
      btnSnapNow.disabled = false;
      statusPill.textContent = "🟢 高速連続読取中（奥付をかざしてください）";

      // 解析完了後すぐに次フレームへ回る連続ループを開始（無駄なタイマー待ちゼロ）
      scheduleNextCameraFrame(150);
    } catch (err) {
      statusPill.textContent = "カメラ起動不可（権限拒否または非HTTPS）";
      showToast(
        `カメラを開始できませんでした（理由: ${err.message}）。写真選択または手動検索へ切り替えてください。`,
        "error"
      );
    }
  }

  function scheduleNextCameraFrame(delayMs = 220) {
    if (state.cameraIntervalId) {
      clearTimeout(state.cameraIntervalId);
      state.cameraIntervalId = null;
    }
    if (!state.cameraStream) return;
    state.cameraIntervalId = setTimeout(async () => {
      await analyzeCurrentVideoFrame(false);
      if (state.cameraStream) {
        scheduleNextCameraFrame(220);
      }
    }, delayMs);
  }

  function stopMobileCamera() {
    const statusPill = document.getElementById("cameraStatusPill");
    const video = document.getElementById("cameraVideo");
    const btnStart = document.getElementById("btnStartCamera");
    const btnStop = document.getElementById("btnStopCamera");
    const btnSnapNow = document.getElementById("btnAnalyzeCurrentFrameNow");

    if (state.cameraIntervalId) {
      clearTimeout(state.cameraIntervalId);
      state.cameraIntervalId = null;
    }
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach((t) => t.stop());
      state.cameraStream = null;
    }
    if (video) {
      try {
        video.pause();
        video.srcObject = null;
        video.removeAttribute("src");
        video.load();
      } catch (_) {}
    }
    if (btnStart) btnStart.disabled = false;
    if (btnStop) btnStop.disabled = true;
    if (btnSnapNow) btnSnapNow.disabled = true;
    if (statusPill) {
      statusPill.style.backgroundColor = "rgba(15, 23, 42, 0.82)";
      statusPill.style.color = "#38bdf8";
      statusPill.textContent = "カメラ停止中";
    }
  }

  async function ensureTesseractLoaded() {
    if (state.tesseractWorker) return state.tesseractWorker;
    const statusPill = document.getElementById("cameraStatusPill");
    if (statusPill) statusPill.textContent = "ブラウザ内OCRエンジン(Tesseract.js)読込中...";

    // 動的にTesseract.jsスクリプトをCDNからロード（業務データの送信ではなくライブラリのGET取得のみ）
    if (!window.Tesseract) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
        script.onload = resolve;
        script.onerror = () => reject(new Error("OCRライブラリの取得に失敗しました（オフライン環境）"));
        document.head.appendChild(script);
      });
    }

    state.tesseractWorker = await window.Tesseract.createWorker("jpn+eng");
    try {
      // 単一テキストブロックモード(PSM 6)に固定してレイアウト解析のオーバーヘッドを削減
      await state.tesseractWorker.setParameters({ tessedit_pageseg_mode: "6" });
    } catch (_) {}
    return state.tesseractWorker;
  }

  async function analyzeCurrentVideoFrame(forceRun = false) {
    if (state.isOcrBusy && !forceRun) return;
    const video = document.getElementById("cameraVideo");
    const canvas = document.getElementById("cameraCaptureCanvas");
    const statusPill = document.getElementById("cameraStatusPill");
    if (!video || !video.videoWidth || !canvas) return;

    // 複数冊ヒットして利用者が特定（選択）中の場合は、勝手に次の奥付を読み取らないようポーズする
    if (state.awaitingDisambiguation && !forceRun) {
      statusPill.style.backgroundColor = "rgba(180, 83, 9, 0.92)";
      statusPill.style.color = "#ffffff";
      statusPill.textContent = "⏸️ 複数候補の特定待ち ― ポップアップ画面から1冊選択してください";
      return;
    }

    state.isOcrBusy = true;
    try {
      // 1. 中央ガイド枠切り抜き＋720pxグレースケール＆コントラスト強調キャンバスを作成
      prepareFastOcrCanvas(video, canvas);

      // 2. ブラウザが BarcodeDetector (EAN_13 / ISBNバーコード) に対応している場合は高速併用
      if ("BarcodeDetector" in window) {
        try {
          const detector = new window.BarcodeDetector({ formats: ["ean_13", "qr_code"] });
          const barcodes = await detector.detect(video);
          if (barcodes && barcodes.length > 0) {
            const codeVal = barcodes[0].rawValue;
            if (codeVal) {
              const res = executeOcrTextMatch(`ISBN ${codeVal}`, "【カメラ読取（ISBNバーコード）】", {
                isContinuousCamera: !forceRun
              });
              if (res.status === "AUTO_CONFIRMED") {
                statusPill.style.backgroundColor = "rgba(22, 101, 52, 0.92)";
                statusPill.style.color = "#ffffff";
                statusPill.textContent = `🟢 確定完了 (${codeVal}) ― 続けて次の奥付をかざしてください`;
              } else if (res.status === "MULTIPLE_AWAITING") {
                statusPill.style.backgroundColor = "rgba(180, 83, 9, 0.92)";
                statusPill.style.color = "#ffffff";
                statusPill.textContent = `⏸️ 複数候補（${res.count}冊）特定待ち`;
              } else if (res.status === "NO_CANDIDATE" || res.status === "NO_CANDIDATE_HOLD") {
                statusPill.style.backgroundColor = "rgba(185, 28, 28, 0.94)";
                statusPill.style.color = "#ffffff";
                statusPill.textContent = `❌ 蔵書リストに該当なし (${codeVal})`;
              }
              state.isOcrBusy = false;
              return;
            }
          }
        } catch (_) {}
      }

      // 3. ブラウザ内OCR (Tesseract.js) で奥付文字を高速認識
      const worker = await ensureTesseractLoaded();
      const { data } = await worker.recognize(canvas);
      const recognizedText = (data && data.text ? data.text : "").trim();

      if (recognizedText.length >= 3) {
        const res = executeOcrTextMatch(recognizedText, "【実機カメラ ブラウザ内OCR】", {
          isContinuousCamera: !forceRun
        });
        if (res.status === "AUTO_CONFIRMED") {
          statusPill.style.backgroundColor = "rgba(22, 101, 52, 0.92)";
          statusPill.style.color = "#ffffff";
          statusPill.textContent = `🟢 1冊確定完了！（計 ${state.mobileSelectedList.length} 冊）― すぐ次の奥付をかざせます`;
        } else if (res.status === "MULTIPLE_AWAITING") {
          statusPill.style.backgroundColor = "rgba(180, 83, 9, 0.92)";
          statusPill.style.color = "#ffffff";
          statusPill.textContent = `⏸️ 複数候補（${res.count}冊）特定待ち ― ポップアップで選択してください`;
        } else if (res.status === "NO_CANDIDATE" || res.status === "NO_CANDIDATE_HOLD") {
          statusPill.style.backgroundColor = "rgba(185, 28, 28, 0.94)";
          statusPill.style.color = "#ffffff";
          statusPill.textContent = `❌ 該当図書なし（読取: "${res.detectedSample || state.lastUnmatchedIsbn}"）― 下のボタンから検索可`;
        } else if (Date.now() < (state.unmatchedAlertUntilMs || 0)) {
          // 該当なし警告表示中（3.5秒間）は赤ピル表示を維持して見落としを防ぐ
          statusPill.style.backgroundColor = "rgba(185, 28, 28, 0.94)";
          statusPill.style.color = "#ffffff";
        } else {
          statusPill.style.backgroundColor = "rgba(15, 23, 42, 0.82)";
          statusPill.style.color = "#38bdf8";
          statusPill.textContent = `🟢 高速連続読取中（確定済: ${state.mobileSelectedList.length}冊 / 奥付をかざしてください）`;
        }
      } else if (Date.now() >= (state.unmatchedAlertUntilMs || 0)) {
        statusPill.style.backgroundColor = "rgba(15, 23, 42, 0.82)";
        statusPill.style.color = "#38bdf8";
        statusPill.textContent = `🟢 高速連続読取中（確定済: ${state.mobileSelectedList.length}冊 / 奥付をかざしてください）`;
      }
    } catch (err) {
      statusPill.textContent = "ブラウザ内OCR待機中（オフライン時は下のテキスト認識入力をご利用ください）";
      if (forceRun) {
        showToast(`OCR解析エラー: ${err.message}`, "error");
      }
    } finally {
      state.isOcrBusy = false;
    }
  }

  async function handlePhotoFallbackOcr(file) {
    if (!file) return;
    const startMs = Date.now();
    updateProgress(true, "選択された奥付写真をブラウザ内OCRで解析しています...", 0, 1, startMs);
    try {
      const worker = await ensureTesseractLoaded();
      const { data } = await worker.recognize(file);
      const text = (data && data.text ? data.text : "").trim();
      updateProgress(false);
      if (!text) {
        showToast("画像から文字を検出できませんでした。手動検索をご利用ください。", "error");
        return;
      }
      executeOcrTextMatch(text, `【写真ファイルOCR (${file.name})】`);
      showToast("写真からのブラウザ内OCR照合が完了しました。", "success");
    } catch (err) {
      updateProgress(false);
      showToast(
        `ブラウザ内OCRライブラリの読込に失敗しました（${err.message}）。模擬OCRまたは手動検索をご利用ください。`,
        "error"
      );
    }
  }

  // =========================================================================
  // 💻 PC台帳管理モード：蔵書一覧・検索・フィルタ
  // =========================================================================
  function populateDepartmentFilter() {
    const sel = document.getElementById("pcFilterDept");
    if (!sel) return;
    const currentVal = sel.value;
    const depts = Array.from(
      new Set(state.catalogBooks.map((b) => b.department).filter((d) => Boolean(d)))
    ).sort();

    sel.innerHTML = `<option value="">すべての所管部署（${depts.length}部署）</option>`;
    depts.forEach((d) => {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d;
      sel.appendChild(opt);
    });
    sel.value = currentVal;
  }

  function renderPcCatalogTable() {
    const tbody = document.getElementById("pcCatalogTableBody");
    const summary = document.getElementById("pcCatalogFilterSummary");
    if (!tbody || !summary) return;

    const query = document.getElementById("pcCatalogSearchInput").value;
    const filters = {
      department: document.getElementById("pcFilterDept").value,
      storageType: document.getElementById("pcFilterStorage").value,
      isbnStatus: document.getElementById("pcFilterIsbn").value
    };

    const filtered = Core.searchBooksManually(query, state.catalogBooks, filters);
    summary.textContent = `表示中: ${filtered.length} 件 / 全 ${state.catalogBooks.length} 件`;

    tbody.innerHTML = filtered
      .map((b) => {
        const vIsbn = Core.validateIsbn(b.isbn);
        let isbnBadge = "";
        if (vIsbn.isEmpty) {
          isbnBadge = `<span style="color:var(--text-muted); font-size:0.78rem;">(ISBNなし)</span>`;
        } else if (vIsbn.isValid) {
          isbnBadge = `<div><code>${escapeHtml(b.isbn)}</code></div><span style="color:var(--success); font-size:0.73rem;">✓ ${escapeHtml(vIsbn.type)}正常</span>`;
        } else {
          isbnBadge = `<div><code>${escapeHtml(b.isbn)}</code></div><span style="color:var(--danger); font-weight:700; font-size:0.73rem;">⚠️ ${escapeHtml(vIsbn.message)}</span>`;
        }

        const isWh = String(b.location || "").includes("外部倉庫") || Boolean(b.box_number);
        return `
          <tr>
            <td><span class="book-id-tag" style="font-size:0.8rem;">${escapeHtml(b.book_id)}</span></td>
            <td>${isbnBadge}</td>
            <td><strong>${escapeHtml(b.title)}</strong></td>
            <td>
              <div>${escapeHtml(b.author || "(著者未登録)")}</div>
              <div style="color:var(--text-sub); font-size:0.78rem;">${escapeHtml(b.publisher || "(出版社未登録)")}</div>
            </td>
            <td>
              <div>${escapeHtml(b.pub_year || "-")}年</div>
              <div style="color:var(--text-sub); font-size:0.78rem;">${escapeHtml(b.edition || "-")}</div>
            </td>
            <td>${escapeHtml(b.department || "-")}</td>
            <td>
              <span style="font-weight:600; color:${isWh ? "var(--accent-warehouse)" : "var(--text-main)"};">
                ${escapeHtml(b.location || "-")}
              </span>
            </td>
            <td>${b.box_number ? `<code>${escapeHtml(b.box_number)}</code>` : "-"}</td>
            <td style="font-size:0.78rem; color:var(--text-sub);">${escapeHtml(b.notes || "")}</td>
          </tr>
        `;
      })
      .join("");
  }

  // =========================================================================
  // 💻 PC台帳管理モード：CSV取込と列マッピング・重複検証
  // =========================================================================
  function handlePcCsvFileSelected(file) {
    if (!file) return;
    const encoding = document.getElementById("pcCsvEncodingSelect").value || "UTF-8";
    const startMs = Date.now();
    updateProgress(true, `CSVファイル「${file.name}」を読み込んでいます...`, 0, 1, startMs);

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      const parsed = Core.parseCsvText(text);
      updateProgress(false);

      if (parsed.headers.length === 0) {
        showToast("CSVファイルにヘッダー行が見つかりませんでした。", "error");
        return;
      }

      state.pendingCsvRawHeaders = parsed.headers;
      state.pendingCsvRawRecords = parsed.records;
      renderColumnMappingUi(parsed.headers);
      showToast(`CSVから ${parsed.records.length} 件のレコードを検出しました。列の対応付けを確認してください。`);
    };
    reader.onerror = () => {
      updateProgress(false);
      showToast("ファイルの読込に失敗しました。", "error");
    };
    reader.readAsText(file, encoding);
  }

  function renderColumnMappingUi(csvHeaders) {
    const section = document.getElementById("columnMappingSection");
    const grid = document.getElementById("columnMappingGrid");
    if (!section || !grid) return;

    const guessed = Core.guessColumnMapping(csvHeaders);
    grid.innerHTML = Core.STANDARD_FIELDS.map((field) => {
      const optionsHtml = [
        `<option value="">(対応列なし / 空欄にする)</option>`,
        ...csvHeaders.map(
          (h) =>
            `<option value="${escapeHtml(h)}" ${guessed[field.key] === h ? "selected" : ""}>${escapeHtml(h)}</option>`
        )
      ].join("");

      return `
        <div>
          <label class="form-label">
            ${escapeHtml(field.label)}
            ${field.required ? `<span style="color:var(--danger);">*必須</span>` : ""}
          </label>
          <select class="select col-map-select" data-field-key="${escapeHtml(field.key)}">
            ${optionsHtml}
          </select>
        </div>
      `;
    }).join("");

    section.classList.remove("hidden");
  }

  function applyMappedCsvImport() {
    const mapSelects = document.querySelectorAll(".col-map-select");
    const mapping = {};
    mapSelects.forEach((sel) => {
      mapping[sel.getAttribute("data-field-key")] = sel.value;
    });

    if (!mapping.book_id || !mapping.title) {
      showToast("必須項目「図書登録番号」と「書名」に対応する列を選択してください。", "error");
      return;
    }

    const startMs = Date.now();
    const total = state.pendingCsvRawRecords.length;
    updateProgress(true, "列マッピング適用とデータ検証を実行中...", 0, total, startMs);

    const mappedBooks = state.pendingCsvRawRecords.map((raw, idx) => {
      if (idx % 25 === 0) {
        updateProgress(true, "列マッピング適用とデータ検証を実行中...", idx, total, startMs);
      }
      const bookObj = {};
      Core.STANDARD_FIELDS.forEach((f) => {
        const srcCol = mapping[f.key];
        bookObj[f.key] = srcCol && raw[srcCol] !== undefined ? String(raw[srcCol]).trim() : "";
      });
      return bookObj;
    });

    const validation = Core.validateCatalogDataset(mappedBooks);
    updateProgress(false);
    renderCatalogValidationReport(validation);

    if (!validation.isValidCritical) {
      showToast(
        "図書登録番号の重複または必須項目の欠落があるため、台帳への反映を保留しました。エラー内容を確認してください。",
        "error"
      );
      return;
    }

    const dataKind = document.getElementById("pcCsvDataKindSelect").value;
    state.isDemoMode = dataKind === "DEMO";
    state.catalogBooks = mappedBooks;
    saveCurrentCatalogToStorage();
    refreshAllViews();
    showToast(`蔵書データ ${mappedBooks.length} 件を取り込みました。`, "success");
  }

  function renderCatalogValidationReport(v) {
    const box = document.getElementById("catalogValidationResultBox");
    if (!box) return;

    const dupHtml =
      v.duplicateIds.length === 0
        ? `<div style="color:var(--success);">✓ 図書登録番号の重複はありません（全 ${v.totalCount} 件一意）</div>`
        : `<div style="color:var(--danger); font-weight:700;">❌ 図書登録番号の重複が ${v.duplicateIds.length} 件あります:</div>
           <ul>${v.duplicateIds.map((d) => `<li>${escapeHtml(d.message)}</li>`).join("")}</ul>`;

    const reqHtml =
      v.missingRequired.length === 0
        ? `<div style="color:var(--success);">✓ 必須項目（図書登録番号・書名）の欠落はありません</div>`
        : `<div style="color:var(--danger); font-weight:700;">❌ 必須項目の欠落が ${v.missingRequired.length} 件あります:</div>
           <ul>${v.missingRequired.map((m) => `<li>${escapeHtml(m.message)}</li>`).join("")}</ul>`;

    const isbnHtml =
      v.isbnWarnings.length === 0
        ? `<div style="color:var(--success);">✓ 登録済みISBNのチェックディジット・形式はすべて正常です</div>`
        : `<div style="color:var(--warning); font-weight:700;">⚠️ ISBN形式またはチェックディジットの注意項目が ${v.isbnWarnings.length} 件あります（取込は可能ですが手動検索対象となります）:</div>
           <ul style="margin:4px 0;">${v.isbnWarnings.slice(0, 10).map((w) => `<li>${escapeHtml(w.message)}</li>`).join("")}</ul>`;

    box.innerHTML = `
      <div class="alert ${v.isValidCritical ? "alert-success" : "alert-danger"}">
        <h4 style="margin:0 0 6px 0;">📋 台帳データ検証レポート（対象: ${v.totalCount}件）</h4>
        ${dupHtml}
        ${reqHtml}
        ${isbnHtml}
      </div>
    `;
  }

  // =========================================================================
  // 💻 PC台帳管理モード：スマホ変更データの取込・Diff比較・更新用CSV出力
  // =========================================================================
  function loadChangesIntoPcDiff(rawChangeRecords, sourceDescription) {
    state.pcDiffRecords = Core.computeChangesDiff(state.catalogBooks, rawChangeRecords);
    renderPcDiffTable(sourceDescription);
  }

  function renderPcDiffTable(sourceDescription = "") {
    const banner = document.getElementById("pcDiffSummaryBanner");
    const tbody = document.getElementById("pcDiffTableBody");
    if (!banner || !tbody) return;

    if (state.pcDiffRecords.length === 0) {
      banner.className = "alert alert-info";
      banner.textContent = "比較対象の変更データがありません。ファイルを選択するか、iPhoneモードの選択リストを読み込んでください。";
      tbody.innerHTML = "";
      return;
    }

    const changedCount = state.pcDiffRecords.filter((r) => r.status === "CHANGED").length;
    const unmatchedCount = state.pcDiffRecords.filter((r) => r.status === "UNMATCHED_ID").length;
    const selectedForUpdate = state.pcDiffRecords.filter((r) => r.applyUpdate).length;

    banner.className = unmatchedCount > 0 ? "alert alert-warning" : "alert alert-success";
    banner.innerHTML = `
      <strong>${escapeHtml(sourceDescription || "変更データ取込完了")}</strong> ―
      全 ${state.pcDiffRecords.length} 件中、変更あり: <strong>${changedCount}件</strong> /
      台帳未登録: <strong>${unmatchedCount}件</strong> /
      現在チェック選択中: <strong>${selectedForUpdate}件</strong>
    `;

    tbody.innerHTML = state.pcDiffRecords
      .map((d, idx) => {
        const statusBadge =
          d.status === "CHANGED"
            ? `<span class="badge" style="background:#dcfce7; color:#166534;">変更あり</span>`
            : d.status === "UNMATCHED_ID"
            ? `<span class="badge" style="background:#fee2e2; color:#991b1b;">台帳未登録</span>`
            : `<span class="badge" style="background:#e2e8f0; color:#475569;">変更なし</span>`;

        return `
          <tr>
            <td>
              <input
                type="checkbox"
                class="diff-row-check"
                data-index="${idx}"
                ${d.applyUpdate ? "checked" : ""}
                ${d.status === "UNMATCHED_ID" ? "disabled" : ""}
              />
            </td>
            <td>${statusBadge}</td>
            <td><span class="book-id-tag" style="font-size:0.8rem;">${escapeHtml(d.book_id)}</span></td>
            <td>
              <strong>${escapeHtml(d.title)}</strong>
              <div style="font-size:0.78rem; color:var(--text-sub);">${escapeHtml(d.department || "-")}</div>
            </td>
            <td>
              <div class="diff-old">${escapeHtml(d.old_location || "(未設定)")}</div>
              <div class="diff-new">➔ ${escapeHtml(d.new_location || "(未設定)")}</div>
            </td>
            <td>
              <div class="diff-old">${escapeHtml(d.old_box_number || "(箱なし)")}</div>
              <div class="diff-new">➔ ${escapeHtml(d.new_box_number || "(箱なし)")}</div>
            </td>
            <td style="font-size:0.78rem;">
              <div>${escapeHtml(d.worker_note || "-")}</div>
              <div style="color:var(--text-muted);">${escapeHtml(formatDateTime(d.selected_at))}</div>
            </td>
          </tr>
        `;
      })
      .join("");

    tbody.querySelectorAll(".diff-row-check").forEach((chk) => {
      chk.addEventListener("change", () => {
        const idx = parseInt(chk.getAttribute("data-index"), 10);
        if (state.pcDiffRecords[idx]) {
          state.pcDiffRecords[idx].applyUpdate = chk.checked;
          renderPcDiffTable(sourceDescription);
        }
      });
    });
  }

  function applySelectedDiffToCatalog() {
    const targets = state.pcDiffRecords.filter((d) => d.applyUpdate && d.status !== "UNMATCHED_ID");
    if (targets.length === 0) {
      showToast("更新対象としてチェックされている行がありません。", "error");
      return;
    }

    // 更新前スナップショットを履歴に保存（いつでも復元可能にする）
    const snapshotBefore = JSON.parse(JSON.stringify(state.catalogBooks));
    const targetMap = new Map(targets.map((t) => [t.book_id, t]));

    state.catalogBooks = state.catalogBooks.map((book) => {
      const change = targetMap.get(book.book_id);
      if (!change) return book;
      return {
        ...book,
        location: change.new_location,
        box_number: change.new_box_number
      };
    });

    const historyEntry = {
      history_id: "HIST-" + Date.now(),
      executed_at: new Date().toISOString(),
      data_mode: state.isDemoMode ? "デモデータ" : "本番データ",
      updated_count: targets.length,
      summary: targets
        .slice(0, 3)
        .map((t) => `${t.book_id}(${t.old_location}→${t.new_location})`)
        .join(" / "),
      snapshot_before: snapshotBefore
    };

    state.changeHistory.unshift(historyEntry);
    saveCurrentCatalogToStorage();
    saveHistoryToStorage();
    refreshAllViews();
    loadChangesIntoPcDiff(state.pcDiffRecords, "台帳反映後の再比較");
    showToast(`${targets.length} 件の保管場所変更を画面上の台帳へ反映し、変更履歴を保存しました。`, "success");
  }

  // =========================================================================
  // 📦 外部倉庫（日高倉庫）箱管理・別紙2-3転記用データプレビュー＆出力
  // =========================================================================
  function renderPcWarehouseView() {
    const tbody = document.getElementById("pcBesshi23TableBody");
    if (!tbody) return;

    const booksByBox = new Map();
    for (const b of state.catalogBooks) {
      const boxNo = String(b.box_number || "").trim();
      if (!boxNo) continue;
      if (!booksByBox.has(boxNo)) booksByBox.set(boxNo, []);
      booksByBox.get(boxNo).push(b);
    }

    const rows = Core.buildBesshi23Rows(booksByBox);
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--text-muted);">外部倉庫の箱管理番号が設定されている図書はありません。</td></tr>`;
      return;
    }

    tbody.innerHTML = rows
      .map(
        (r) => `
        <tr>
          <td><code><strong>${escapeHtml(r.box_number)}</strong></code></td>
          <td>${escapeHtml(r.doc_type)}</td>
          <td>${escapeHtml(r.retention_label)}</td>
          <td><code>${escapeHtml(r.retention_date)}</code></td>
          <td><strong>${escapeHtml(r.item_name)}</strong></td>
          <td>${r.name_length}文字 / 100</td>
          <td>${r.book_count}冊</td>
          <td style="font-size:0.78rem; color:var(--text-sub);">${escapeHtml(r.book_ids)}</td>
        </tr>
      `
      )
      .join("");
  }

  // =========================================================================
  // 🕒 変更履歴・バックアップと復元
  // =========================================================================
  function renderPcHistoryTable() {
    const tbody = document.getElementById("pcHistoryTableBody");
    if (!tbody) return;

    if (state.changeHistory.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">まだ変更履歴はありません。</td></tr>`;
      return;
    }

    tbody.innerHTML = state.changeHistory
      .map(
        (h, idx) => `
        <tr>
          <td>${escapeHtml(formatDateTime(h.executed_at))}</td>
          <td><span class="badge ${h.data_mode === "デモデータ" ? "badge-demo" : "badge-prod"}">${escapeHtml(h.data_mode)}</span></td>
          <td><strong>${h.updated_count}件</strong></td>
          <td style="font-size:0.82rem;">${escapeHtml(h.summary)}</td>
          <td>
            <button type="button" class="btn btn-outline btn-sm btn-restore-snapshot" data-hist-index="${idx}">
              ⏪ この変更前の状態に戻す
            </button>
          </td>
        </tr>
      `
      )
      .join("");

    tbody.querySelectorAll(".btn-restore-snapshot").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.getAttribute("data-hist-index"), 10);
        const hist = state.changeHistory[idx];
        if (!hist || !Array.isArray(hist.snapshot_before)) return;
        state.catalogBooks = JSON.parse(JSON.stringify(hist.snapshot_before));
        saveCurrentCatalogToStorage();
        refreshAllViews();
        showToast(`変更履歴（${formatDateTime(hist.executed_at)}）の直前スナップショットへ復元しました。`, "success");
      });
    });
  }

  // =========================================================================
  // イベントバインディング
  // =========================================================================
  function bindEvents() {
    // 1. iPhone / PC モード切替
    const btnMobile = document.getElementById("btnSwitchMobile");
    const btnPc = document.getElementById("btnSwitchPc");
    const secMobile = document.getElementById("mobileViewSection");
    const secPc = document.getElementById("pcViewSection");

    btnMobile.addEventListener("click", () => {
      btnMobile.classList.add("active");
      btnPc.classList.remove("active");
      secMobile.classList.remove("hidden");
      secPc.classList.add("hidden");
    });

    btnPc.addEventListener("click", () => {
      stopMobileCamera();
      btnPc.classList.add("active");
      btnMobile.classList.remove("active");
      secPc.classList.remove("hidden");
      secMobile.classList.add("hidden");
      refreshAllViews();
    });

    // デモデータへリセット
    document.getElementById("btnResetToDemo").addEventListener("click", () => {
      const defaultDataset = window.DEMO_DATASET || { books: [] };
      state.isDemoMode = true;
      state.catalogBooks = JSON.parse(JSON.stringify(defaultDataset.books || []));
      saveCurrentCatalogToStorage();
      refreshAllViews();
      renderCandidatesList();
      showToast("初期のデモデータ（105件）に戻しました。", "success");
    });

    // 2. iPhone側：照合ファイル読込・作業データ消去
    document.getElementById("mobileLoadCatalogInput").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const content = ev.target.result;
        if (file.name.toLowerCase().endsWith(".json")) {
          try {
            const parsed = JSON.parse(content);
            const books = Array.isArray(parsed) ? parsed : parsed.books || [];
            if (books.length > 0) {
              state.isDemoMode = Boolean(parsed.is_demo_data);
              state.catalogBooks = books;
              saveCurrentCatalogToStorage();
              refreshAllViews();
              showToast(`照合用JSONから ${books.length} 件の蔵書を読み込みました。`, "success");
            }
          } catch (err) {
            showToast("JSONの解析に失敗しました: " + err.message, "error");
          }
        } else {
          const parsedCsv = Core.parseCsvText(content);
          const mapping = Core.guessColumnMapping(parsedCsv.headers);
          const books = parsedCsv.records.map((r) => {
            const obj = {};
            Core.STANDARD_FIELDS.forEach((f) => {
              const col = mapping[f.key];
              obj[f.key] = col && r[col] !== undefined ? r[col] : "";
            });
            return obj;
          });
          if (books.length > 0) {
            state.catalogBooks = books;
            saveCurrentCatalogToStorage();
            refreshAllViews();
            showToast(`照合用CSVから ${books.length} 件の蔵書を読み込みました。`, "success");
          }
        }
      };
      reader.readAsText(file, "UTF-8");
    });

    document.getElementById("btnMobileClearStorage").addEventListener("click", () => {
      state.mobileSelectedList = [];
      state.mobileScannedBatches = [];
      localStorage.removeItem(STORAGE_KEYS.MOBILE_SESSION);
      renderMobileSelectedList();
      renderCandidatesList();
      document.getElementById("mobileQrArea").classList.add("hidden");
      showToast("iPhone側の選択済み作業データとスキャン候補ストックを消去しました。");
    });

    const btnCancelMultiModal = document.getElementById("btnCancelMultiModal");
    if (btnCancelMultiModal) {
      btnCancelMultiModal.addEventListener("click", () => {
        state.awaitingDisambiguation = false;
        state.mobileCandidates = [];
        renderCandidatesList();
        const statusPill = document.getElementById("cameraStatusPill");
        if (statusPill && state.cameraStream) {
          statusPill.textContent = "連続読取中（キャンセルされました ― 次の奥付をスキャンできます）";
        }
      });
    }

    const btnBulkUpdateDest = document.getElementById("btnBulkUpdateSelectedDest");
    if (btnBulkUpdateDest) {
      btnBulkUpdateDest.addEventListener("click", () => {
        if (state.mobileSelectedList.length === 0) {
          showToast("先に上の候補ストックから対象の図書を選択してください。", "error");
          return;
        }
        const destConfig = getActiveDestinationConfig();
        if (!destConfig.isValid) {
          showToast(destConfig.error || "移動先の設定を確認してください。", "error");
          return;
        }
        state.mobileSelectedList = state.mobileSelectedList.map((item) => ({
          ...item,
          new_location: destConfig.location,
          new_box_number: destConfig.mode === "WAREHOUSE" ? destConfig.boxNumber : "",
          change_mode: destConfig.mode === "WAREHOUSE" ? "外部倉庫（日高）箱詰・発送" : "本部内保管場所変更",
          worker_note: destConfig.workerNote || item.worker_note,
          selected_at: new Date().toISOString()
        }));
        saveMobileSessionToStorage();
        renderMobileSelectedList();
        updateMobileBoxValidationUi();
        showToast(
          `選択済みの全 ${state.mobileSelectedList.length} 冊の移動先を「${destConfig.location}」へ一括確定・更新しました！`,
          "success"
        );
      });
    }

    // 3. iPhone側：移動先モード・定型書架・箱番号設定
    document.getElementById("btnDestModeHq").addEventListener("click", () => setMobileDestinationMode("HQ"));
    document.getElementById("btnDestModeWarehouse").addEventListener("click", () => setMobileDestinationMode("WAREHOUSE"));

    document.getElementById("mobileHqLocationInput").addEventListener("input", () => {
      saveMobileSessionToStorage();
      renderCandidatesList();
    });

    document.getElementById("mobileHqPresetSelect").addEventListener("change", (e) => {
      if (e.target.value) {
        document.getElementById("mobileHqLocationInput").value = e.target.value;
        saveMobileSessionToStorage();
        renderCandidatesList();
      }
    });

    document.getElementById("btnSuggestNextBoxMobile").addEventListener("click", () => {
      const dept = document.getElementById("mobileBoxDeptInput").value;
      const yr = document.getElementById("mobileBoxYearInput").value;
      const nextBox = Core.suggestNextBoxNumber(dept, yr, state.catalogBooks, state.mobileSelectedList);
      document.getElementById("mobileBoxNumberInput").value = nextBox;
      updateMobileBoxValidationUi();
      saveMobileSessionToStorage();
      renderCandidatesList();
      showToast(`次番号「${nextBox}」をセットしました。`, "success");
    });

    document.getElementById("mobileBoxNumberInput").addEventListener("input", () => {
      updateMobileBoxValidationUi();
      saveMobileSessionToStorage();
      renderCandidatesList();
    });

    // 4. iPhone側：スキャンタブ切替・カメラ・模擬OCR・手動検索
    document.getElementById("btnScanTabCamera").addEventListener("click", () => switchMobileScanTab("CAMERA"));
    document.getElementById("btnScanTabMockOcr").addEventListener("click", () => switchMobileScanTab("MOCK"));
    document.getElementById("btnScanTabManual").addEventListener("click", () => switchMobileScanTab("MANUAL"));
    document.getElementById("btnSwitchToManualFromResult").addEventListener("click", () => {
      switchMobileScanTab("MANUAL");
      document.getElementById("mobileManualSearchInput").focus();
    });

    document.getElementById("btnStartCamera").addEventListener("click", startMobileCamera);
    document.getElementById("btnStopCamera").addEventListener("click", stopMobileCamera);
    document.getElementById("btnAnalyzeCurrentFrameNow").addEventListener("click", () => analyzeCurrentVideoFrame(true));

    document.getElementById("cameraPhotoFallbackInput").addEventListener("change", (e) => {
      handlePhotoFallbackOcr(e.target.files[0]);
    });

    document.getElementById("btnRunLiveTextMatch").addEventListener("click", () => {
      const val = document.getElementById("iosLiveTextInput").value.trim();
      if (!val) {
        showToast("テキスト認識結果またはISBNを入力してください。", "error");
        return;
      }
      executeOcrTextMatch(val, "【iOSテキスト認識/直接入力】");
    });

    document.getElementById("mockOcrPresetSelect").addEventListener("change", (e) => {
      const idx = parseInt(e.target.value, 10);
      runMockOcrByIndex(idx, false);
    });

    document.getElementById("btnExecuteMockOcrMatch").addEventListener("click", () => {
      const raw = document.getElementById("mockOcrRawTextarea").value;
      executeOcrTextMatch(raw, "【模擬OCR検証データ】");
      showToast("模擬OCR文字列で照合を実行しました。");
    });

    document.getElementById("btnMobileManualSearch").addEventListener("click", () => {
      const q = document.getElementById("mobileManualSearchInput").value;
      executeMobileManualSearch(q);
    });

    document.getElementById("mobileManualSearchInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        executeMobileManualSearch(e.target.value);
      }
    });

    document.querySelectorAll(".quick-search-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const q = btn.getAttribute("data-query");
        document.getElementById("mobileManualSearchInput").value = q;
        executeMobileManualSearch(q);
      });
    });

    // 5. iPhone側：変更用CSV出力 & QRコード表示
    document.getElementById("btnExportMobileCsv").addEventListener("click", () => {
      if (state.mobileSelectedList.length === 0) {
        showToast("選択済みの図書がありません。", "error");
        return;
      }
      const headers = [
        { key: "book_id", label: "図書登録番号" },
        { key: "isbn", label: "ISBN" },
        { key: "title", label: "書名" },
        { key: "edition", label: "版・巻号" },
        { key: "department", label: "所管部署" },
        { key: "old_location", label: "変更前の保管場所" },
        { key: "new_location", label: "変更後の保管場所" },
        { key: "old_box_number", label: "変更前の箱管理番号" },
        { key: "new_box_number", label: "変更後の箱管理番号" },
        { key: "change_mode", label: "変更区分" },
        { key: "worker_note", label: "作業メモ" },
        { key: "selected_at", label: "記録日時" }
      ];
      const csv = Core.generateCsvText(headers, state.mobileSelectedList, { includeBom: true });
      const ts = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      downloadFile(`location_changes_${ts}.csv`, csv);
      showToast(`変更用CSV（${state.mobileSelectedList.length}冊）を出力しました。`, "success");
    });

    document.getElementById("btnShowMobileQr").addEventListener("click", () => {
      state.mobileQrPageIndex = 0;
      renderMobileQrCode();
    });

    document.getElementById("btnPrevQrPage").addEventListener("click", () => {
      if (state.mobileQrChunks.length <= 1) return;
      state.mobileQrPageIndex =
        (state.mobileQrPageIndex - 1 + state.mobileQrChunks.length) % state.mobileQrChunks.length;
      renderMobileQrCode();
    });

    document.getElementById("btnNextQrPage").addEventListener("click", () => {
      if (state.mobileQrChunks.length <= 1) return;
      state.mobileQrPageIndex = (state.mobileQrPageIndex + 1) % state.mobileQrChunks.length;
      renderMobileQrCode();
    });

    // 6. PC側：サブタブ切替
    document.querySelectorAll(".sub-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const targetId = btn.getAttribute("data-pctab");
        document.querySelectorAll(".sub-tab-btn").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".pc-tab-panel").forEach((p) => p.classList.add("hidden"));
        btn.classList.add("active");
        document.getElementById(targetId).classList.remove("hidden");
      });
    });

    // 7. PC側タブ1：検索フィルタ＆スマホ用データ出力・台帳別名CSV出力
    ["pcCatalogSearchInput", "pcFilterDept", "pcFilterStorage", "pcFilterIsbn"].forEach((id) => {
      const el = document.getElementById(id);
      el.addEventListener("input", renderPcCatalogTable);
      el.addEventListener("change", renderPcCatalogTable);
    });

    document.getElementById("btnExportPhoneJson").addEventListener("click", () => {
      const payload = {
        is_demo_data: state.isDemoMode,
        exported_at: new Date().toISOString(),
        record_count: state.catalogBooks.length,
        books: state.catalogBooks
      };
      const ts = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      downloadFile(`books_for_iphone_${ts}.json`, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
      showToast("スマホ用照合データ(JSON)を出力しました。", "success");
    });

    document.getElementById("btnExportCatalogCsv").addEventListener("click", () => {
      const protectZero = document.getElementById("chkProtectLeadingZero")?.checked || false;
      const csv = Core.generateCsvText(Core.STANDARD_FIELDS, state.catalogBooks, {
        includeBom: true,
        protectLeadingZeros: protectZero
      });
      const ts = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      downloadFile(`books_catalog_export_${ts}.csv`, csv);
      showToast("蔵書台帳CSVを別ファイルとして出力しました。", "success");
    });

    // 8. PC側タブ2：CSV取込＆マッピング
    document.getElementById("pcCsvFileInput").addEventListener("change", (e) => {
      handlePcCsvFileSelected(e.target.files[0]);
    });
    document.getElementById("btnApplyMappedCsv").addEventListener("click", applyMappedCsvImport);

    // 9. PC側タブ3：変更データ取込・QR読取・Diff適用・更新CSV出力
    document.getElementById("pcImportChangesFileInput").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target.result;
        if (file.name.toLowerCase().endsWith(".json")) {
          try {
            const parsed = JSON.parse(text);
            const list = Array.isArray(parsed) ? parsed : parsed.records || parsed.selectedList || [];
            loadChangesIntoPcDiff(list, `JSONファイル (${file.name})`);
          } catch (err) {
            showToast("変更JSONの読込に失敗しました: " + err.message, "error");
          }
        } else {
          const parsed = Core.parseCsvText(text);
          loadChangesIntoPcDiff(parsed.records, `変更用CSVファイル (${file.name})`);
        }
      };
      reader.readAsText(file, "UTF-8");
    });

    document.getElementById("btnLoadChangesFromMobileSession").addEventListener("click", () => {
      if (state.mobileSelectedList.length === 0) {
        showToast("iPhone現場モードの選択済み一覧が空です。", "error");
        return;
      }
      loadChangesIntoPcDiff(state.mobileSelectedList, "iPhone現場モードの選択済みリスト");
      showToast(`iPhone現場モードの選択済みデータ（${state.mobileSelectedList.length}件）を読み込みました。`, "success");
    });

    document.getElementById("btnImportQrText").addEventListener("click", () => {
      const rawQr = document.getElementById("pcQrPasteInput").value.trim();
      if (!rawQr) {
        showToast("QRコード文字列を貼り付けてください。", "error");
        return;
      }
      const decoded = Core.decodeQrChunkText(rawQr);
      if (!decoded.isValid) {
        showToast(decoded.error, "error");
        return;
      }
      loadChangesIntoPcDiff(
        decoded.records,
        `QRコード取込 (バッチ:${decoded.batchId} ${decoded.page}/${decoded.totalPages}枚目)`
      );
      showToast(`QRコードから ${decoded.records.length} 件の変更データを読み込みました。`, "success");
    });

    document.getElementById("btnStartPcQrCamera").addEventListener("click", async () => {
      const box = document.getElementById("pcQrCameraBox");
      const video = document.getElementById("pcQrVideo");
      if (state.pcQrStream) {
        state.pcQrStream.getTracks().forEach((t) => t.stop());
        state.pcQrStream = null;
        if (state.pcQrIntervalId) clearInterval(state.pcQrIntervalId);
        box.classList.add("hidden");
        return;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showToast("このブラウザではカメラ起動がサポートされていません。QR文字列の貼り付けをご利用ください。", "error");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        state.pcQrStream = stream;
        video.srcObject = stream;
        box.classList.remove("hidden");
        await video.play();

        if ("BarcodeDetector" in window) {
          const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
          state.pcQrIntervalId = setInterval(async () => {
            try {
              const codes = await detector.detect(video);
              if (codes && codes.length > 0) {
                const raw = codes[0].rawValue;
                const decoded = Core.decodeQrChunkText(raw);
                if (decoded.isValid) {
                  document.getElementById("pcQrPasteInput").value = raw;
                  loadChangesIntoPcDiff(decoded.records, `PCカメラQR読取 (${decoded.page}/${decoded.totalPages})`);
                  showToast(`QRコードを検出し ${decoded.records.length} 件を取り込みました！`, "success");
                }
              }
            } catch (_) {}
          }, 1000);
        } else {
          showToast("カメラを起動しました（BarcodeDetector非対応環境ではQRテキスト貼付またはCSVをご利用ください）。");
        }
      } catch (err) {
        showToast("PCカメラの起動に失敗しました: " + err.message, "error");
      }
    });

    document.getElementById("btnDiffSelectAll").addEventListener("click", () => {
      state.pcDiffRecords.forEach((d) => {
        if (d.status !== "UNMATCHED_ID") d.applyUpdate = true;
      });
      renderPcDiffTable();
    });

    document.getElementById("btnDiffDeselectAll").addEventListener("click", () => {
      state.pcDiffRecords.forEach((d) => {
        d.applyUpdate = false;
      });
      renderPcDiffTable();
    });

    document.getElementById("btnApplyDiffToMemory").addEventListener("click", applySelectedDiffToCatalog);

    document.getElementById("btnExportUpdatedCatalogCsv").addEventListener("click", () => {
      const protectZero = document.getElementById("chkProtectLeadingZero").checked;
      // チェックされている変更を反映した新しい台帳配列を作成（元ファイルは上書きせず別名出力）
      const targetMap = new Map(
        state.pcDiffRecords.filter((d) => d.applyUpdate && d.status !== "UNMATCHED_ID").map((d) => [d.book_id, d])
      );
      const updatedCatalog = state.catalogBooks.map((b) => {
        const ch = targetMap.get(b.book_id);
        if (!ch) return b;
        return {
          ...b,
          location: ch.new_location,
          box_number: ch.new_box_number
        };
      });
      const csv = Core.generateCsvText(Core.STANDARD_FIELDS, updatedCatalog, {
        includeBom: true,
        protectLeadingZeros: protectZero
      });
      const ts = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      downloadFile(`updated_catalog_${ts}.csv`, csv);
      showToast("更新反映済みの全件台帳CSVを別ファイルとして出力しました。", "success");
    });

    document.getElementById("btnExportDiffOnlyCsv").addEventListener("click", () => {
      const selected = state.pcDiffRecords.filter((d) => d.applyUpdate);
      if (selected.length === 0) {
        showToast("出力対象の行が選択されていません。", "error");
        return;
      }
      const protectZero = document.getElementById("chkProtectLeadingZero").checked;
      const headers = [
        { key: "book_id", label: "図書登録番号" },
        { key: "title", label: "書名" },
        { key: "department", label: "所管部署" },
        { key: "old_location", label: "変更前の保管場所" },
        { key: "new_location", label: "変更後の保管場所" },
        { key: "old_box_number", label: "変更前の箱管理番号" },
        { key: "new_box_number", label: "変更後の箱管理番号" },
        { key: "worker_note", label: "作業メモ" }
      ];
      const csv = Core.generateCsvText(headers, selected, {
        includeBom: true,
        protectLeadingZeros: protectZero
      });
      const ts = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      downloadFile(`diff_selected_${ts}.csv`, csv);
      showToast(`変更差分CSV（${selected.length}件）を出力しました。`, "success");
    });

    // 10. PC側タブ4：外部倉庫（日高）次番号提示・箱番号チェッカー・別紙2-3出力
    document.getElementById("btnPcSuggestBox").addEventListener("click", () => {
      const dept = document.getElementById("pcBoxDeptInput").value;
      const yr = document.getElementById("pcBoxYearInput").value;
      const suggested = Core.suggestNextBoxNumber(dept, yr, state.catalogBooks, state.mobileSelectedList);
      document.getElementById("pcCheckBoxNumberInput").value = suggested;
      const boxRes = document.getElementById("pcBoxCheckerResult");
      boxRes.className = "alert alert-success";
      boxRes.innerHTML = `💡 部室G「<strong>${escapeHtml(dept)}</strong>」・年度「<strong>${escapeHtml(yr)}</strong>」の次の空き箱管理番号は <code><strong>${escapeHtml(suggested)}</strong></code> です（発送時の所在表記: <code>${escapeHtml(Core.formatWarehouseLocation(suggested))}</code>）。`;
    });

    document.getElementById("pcCheckBoxNumberInput").addEventListener("input", (e) => {
      const val = e.target.value;
      const res = Core.validateBoxNumber(val, state.catalogBooks, state.mobileSelectedList);
      const boxRes = document.getElementById("pcBoxCheckerResult");
      if (!res.isValid) {
        boxRes.className = "alert alert-danger";
        boxRes.textContent = `❌ ${res.error}`;
      } else if (res.isExistingBox) {
        boxRes.className = "alert alert-warning";
        boxRes.textContent = `⚠️ ${res.message}`;
      } else {
        boxRes.className = "alert alert-success";
        boxRes.textContent = `✅ ${res.message}`;
      }
    });

    document.getElementById("btnExportBesshi23Csv").addEventListener("click", () => {
      const booksByBox = new Map();
      for (const b of state.catalogBooks) {
        const boxNo = String(b.box_number || "").trim();
        if (!boxNo) continue;
        if (!booksByBox.has(boxNo)) booksByBox.set(boxNo, []);
        booksByBox.get(boxNo).push(b);
      }
      const rows = Core.buildBesshi23Rows(booksByBox);
      if (rows.length === 0) {
        showToast("外部倉庫の箱番号が設定された図書がありません。", "error");
        return;
      }
      const headers = [
        { key: "box_number", label: "箱管理番号" },
        { key: "doc_type", label: "文書等種類" },
        { key: "retention_label", label: "保存期限" },
        { key: "retention_date", label: "保存期限日付値" },
        { key: "item_name", label: "名称（100文字以内）" },
        { key: "name_length", label: "名称文字数" },
        { key: "book_count", label: "冊数" },
        { key: "department_summary", label: "対象部署" },
        { key: "book_ids", label: "格納図書登録番号一覧" }
      ];
      const csv = Core.generateCsvText(headers, rows, { includeBom: true });
      const ts = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      downloadFile(`besshi2_3_transfer_data_${ts}.csv`, csv);
      showToast(`別紙2-3 転記用データ（${rows.length}箱分）をCSV出力しました。`, "success");
    });

    // 11. PC側タブ5：バックアップ保存・復元・全消去
    document.getElementById("btnDownloadBackupJson").addEventListener("click", () => {
      const backupObj = {
        backup_version: 1,
        created_at: new Date().toISOString(),
        is_demo_mode: state.isDemoMode,
        catalog_books: state.catalogBooks,
        mobile_selected_list: state.mobileSelectedList,
        change_history: state.changeHistory
      };
      const ts = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      downloadFile(`book_location_backup_${ts}.json`, JSON.stringify(backupObj, null, 2), "application/json;charset=utf-8");
      showToast("全体バックアップファイル(JSON)を保存しました。", "success");
    });

    document.getElementById("pcRestoreBackupInput").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const parsed = JSON.parse(ev.target.result);
          if (!Array.isArray(parsed.catalog_books)) {
            throw new Error("バックアップファイルの形式が正しくありません。");
          }
          state.isDemoMode = Boolean(parsed.is_demo_mode);
          state.catalogBooks = parsed.catalog_books;
          state.mobileSelectedList = Array.isArray(parsed.mobile_selected_list) ? parsed.mobile_selected_list : [];
          state.changeHistory = Array.isArray(parsed.change_history) ? parsed.change_history : [];
          saveCurrentCatalogToStorage();
          saveMobileSessionToStorage();
          saveHistoryToStorage();
          refreshAllViews();
          showToast(`バックアップから蔵書 ${state.catalogBooks.length} 件と履歴を復元しました。`, "success");
        } catch (err) {
          showToast("バックアップ復元に失敗しました: " + err.message, "error");
        }
      };
      reader.readAsText(file, "UTF-8");
    });

    document.getElementById("btnClearAllLocalData").addEventListener("click", () => {
      Object.values(STORAGE_KEYS).forEach((k) => localStorage.removeItem(k));
      const defaultDataset = window.DEMO_DATASET || { books: [] };
      state.isDemoMode = true;
      state.catalogBooks = JSON.parse(JSON.stringify(defaultDataset.books || []));
      state.mobileSelectedList = [];
      state.changeHistory = [];
      refreshAllViews();
      renderCandidatesList();
      showToast("ブラウザ内のすべての保存データを消去し、初期状態に戻しました。", "success");
    });
  }

  document.addEventListener("DOMContentLoaded", initApp);
})();
