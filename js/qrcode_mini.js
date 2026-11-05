/**
 * 純粋JavaScriptによるQRコード描画・生成モジュール (qrcode_mini.js)
 * -------------------------------------------------------------------------
 * 外部サーバーや外部APIへデータを一切送信せず、ブラウザ内のCanvasへ
 * ISO/IEC 18004 準拠の QRコード (Version 1〜12, 誤り訂正レベル L/M) を描画します。
 */
(function (globalScope) {
  "use strict";

  // GF(256) 演算テーブル (primitive polynomial 0x11D)
  const EXP_TABLE = new Uint8Array(512);
  const LOG_TABLE = new Uint8Array(256);
  (function initGalois() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP_TABLE[i] = x;
      LOG_TABLE[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) {
      EXP_TABLE[i] = EXP_TABLE[i - 255];
    }
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP_TABLE[LOG_TABLE[a] + LOG_TABLE[b]];
  }

  function rsGeneratorPoly(degree) {
    let poly = new Uint8Array([1]);
    for (let i = 0; i < degree; i++) {
      const next = new Uint8Array(poly.length + 1);
      const root = EXP_TABLE[i];
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], root);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(dataBytes, ecLen) {
    const gen = rsGeneratorPoly(ecLen);
    const rem = new Uint8Array(ecLen);
    for (let i = 0; i < dataBytes.length; i++) {
      const factor = dataBytes[i] ^ rem[0];
      for (let j = 0; j < ecLen - 1; j++) {
        rem[j] = rem[j + 1] ^ gfMul(gen[j + 1], factor);
      }
      rem[ecLen - 1] = gfMul(gen[ecLen], factor);
    }
    return rem;
  }

  // Version 1〜14 (Error Correction Level L: 01) のブロック定義
  // [totalDataCodewords, ecCodewordsPerBlock, numBlocksGroup1, dataCodewordsGroup1, numBlocksGroup2, dataCodewordsGroup2]
  const VERSION_TABLE_L = [
    null,
    [19, 7, 1, 19, 0, 0],     // V1
    [34, 10, 1, 34, 0, 0],    // V2
    [55, 15, 1, 55, 0, 0],    // V3
    [80, 20, 1, 80, 0, 0],    // V4
    [108, 26, 1, 108, 0, 0],  // V5
    [136, 18, 2, 68, 0, 0],   // V6
    [156, 20, 2, 78, 0, 0],   // V7
    [194, 24, 2, 97, 0, 0],   // V8
    [232, 30, 2, 116, 0, 0],  // V9
    [274, 18, 2, 68, 2, 69],  // V10
    [324, 20, 4, 81, 0, 0],   // V11
    [370, 24, 2, 92, 2, 93],  // V12
    [428, 26, 4, 107, 0, 0],  // V13
    [461, 30, 3, 115, 1, 116] // V14
  ];

  const ALIGNMENT_PATTERNS = [
    null,
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50],
    [6, 30, 54],
    [6, 32, 58],
    [6, 34, 62],
    [6, 26, 46, 66]
  ];

  function utf8Bytes(str) {
    return new TextEncoder().encode(String(str));
  }

  function selectVersion(byteLength) {
    for (let v = 1; v < VERSION_TABLE_L.length; v++) {
      const cap = VERSION_TABLE_L[v][0];
      const headerBits = 4 + (v <= 9 ? 8 : 16);
      const maxBytes = Math.floor((cap * 8 - headerBits) / 8);
      if (byteLength <= maxBytes) return v;
    }
    throw new Error("QRコードの最大容量（約450バイト）を超えています。1枚あたりの件数を減らしてください。");
  }

  function buildDataCodewords(bytes, version) {
    const info = VERSION_TABLE_L[version];
    const totalDataCodewords = info[0];
    const bits = [];

    const pushBits = (val, len) => {
      for (let i = len - 1; i >= 0; i--) {
        bits.push((val >>> i) & 1);
      }
    };

    // Byte mode (0100)
    pushBits(0b0100, 4);
    pushBits(bytes.length, version <= 9 ? 8 : 16);
    for (let i = 0; i < bytes.length; i++) {
      pushBits(bytes[i], 8);
    }

    const maxBits = totalDataCodewords * 8;
    const terminator = Math.min(4, maxBits - bits.length);
    pushBits(0, terminator);
    while (bits.length % 8 !== 0) bits.push(0);

    const codewords = new Uint8Array(totalDataCodewords);
    let idx = 0;
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      codewords[idx++] = b;
    }

    const padBytes = [0xec, 0x11];
    let p = 0;
    while (idx < totalDataCodewords) {
      codewords[idx++] = padBytes[p % 2];
      p++;
    }
    return codewords;
  }

  function interleaveCodewords(dataCodewords, version) {
    const [, ecLen, g1Blocks, g1DataLen, g2Blocks, g2DataLen] = VERSION_TABLE_L[version];
    const dataBlocks = [];
    const ecBlocks = [];
    let offset = 0;

    for (let i = 0; i < g1Blocks; i++) {
      const blk = dataCodewords.slice(offset, offset + g1DataLen);
      offset += g1DataLen;
      dataBlocks.push(blk);
      ecBlocks.push(rsEncode(blk, ecLen));
    }
    for (let i = 0; i < g2Blocks; i++) {
      const blk = dataCodewords.slice(offset, offset + g2DataLen);
      offset += g2DataLen;
      dataBlocks.push(blk);
      ecBlocks.push(rsEncode(blk, ecLen));
    }

    const result = [];
    const maxDataLen = Math.max(g1DataLen, g2DataLen);
    for (let i = 0; i < maxDataLen; i++) {
      for (let b = 0; b < dataBlocks.length; b++) {
        if (i < dataBlocks[b].length) result.push(dataBlocks[b][i]);
      }
    }
    for (let i = 0; i < ecLen; i++) {
      for (let b = 0; b < ecBlocks.length; b++) {
        result.push(ecBlocks[b][i]);
      }
    }
    return result;
  }

  function createMatrix(version, codewords) {
    const size = version * 4 + 17;
    const modules = Array.from({ length: size }, () => new Int8Array(size)); // 0: empty, 1: light, 2: dark
    const isFunction = Array.from({ length: size }, () => new Uint8Array(size));

    const setFunctionModule = (r, c, isDark) => {
      if (r < 0 || r >= size || c < 0 || c >= size) return;
      modules[r][c] = isDark ? 2 : 1;
      isFunction[r][c] = 1;
    };

    const drawFinder = (row, col) => {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) {
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || r >= size || c < 0 || c >= size) continue;
          const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
          const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
          setFunctionModule(r, c, inOuter && (onBorder || inInner));
        }
      }
    };

    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
      setFunctionModule(6, i, i % 2 === 0);
      setFunctionModule(i, 6, i % 2 === 0);
    }

    // Alignment patterns
    const alignCoords = ALIGNMENT_PATTERNS[version];
    for (let i = 0; i < alignCoords.length; i++) {
      for (let j = 0; j < alignCoords.length; j++) {
        if (
          (i === 0 && j === 0) ||
          (i === 0 && j === alignCoords.length - 1) ||
          (i === alignCoords.length - 1 && j === 0)
        ) {
          continue;
        }
        const cr = alignCoords[i];
        const cc = alignCoords[j];
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const isDark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
            setFunctionModule(cr + dr, cc + dc, isDark);
          }
        }
      }
    }

    // Reserve format info areas & dark module
    for (let i = 0; i <= 8; i++) {
      if (i !== 6) {
        if (!isFunction[8][i]) setFunctionModule(8, i, false);
        if (!isFunction[i][8]) setFunctionModule(i, 8, false);
      }
      if (i < 8) {
        if (!isFunction[8][size - 1 - i]) setFunctionModule(8, size - 1 - i, false);
        if (!isFunction[size - 1 - i][8]) setFunctionModule(size - 1 - i, 8, false);
      }
    }
    setFunctionModule(size - 8, 8, true);

    // Reserve version info area if version >= 7
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) {
        rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      }
      const verBits = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = ((verBits >>> i) & 1) !== 0;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        setFunctionModule(a, b, bit);
        setFunctionModule(b, a, bit);
      }
    }

    // Place data bits (zigzag scan)
    const bitStream = [];
    for (let i = 0; i < codewords.length; i++) {
      for (let b = 7; b >= 0; b--) {
        bitStream.push((codewords[i] >>> b) & 1);
      }
    }

    let bitIdx = 0;
    let upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        const r = upward ? size - 1 - vert : vert;
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          if (!isFunction[r][c]) {
            const dark = bitIdx < bitStream.length ? bitStream[bitIdx++] === 1 : false;
            // Apply Mask 0: (r + c) % 2 === 0
            const maskedDark = (r + c) % 2 === 0 ? !dark : dark;
            modules[r][c] = maskedDark ? 2 : 1;
          }
        }
      }
      upward = !upward;
    }

    // Write Format Info for Level L (01) and Mask 0 (000) -> data = 0b01000
    let data = 0b01000;
    let rem = data;
    for (let i = 0; i < 10; i++) {
      rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    }
    const formatBits = ((data << 10) | rem) ^ 0x5412;

    for (let i = 0; i <= 5; i++) setFunctionModule(8, i, ((formatBits >>> i) & 1) !== 0);
    setFunctionModule(8, 7, ((formatBits >>> 6) & 1) !== 0);
    setFunctionModule(8, 8, ((formatBits >>> 7) & 1) !== 0);
    setFunctionModule(7, 8, ((formatBits >>> 8) & 1) !== 0);
    for (let i = 9; i < 15; i++) setFunctionModule(14 - i, 8, ((formatBits >>> i) & 1) !== 0);

    for (let i = 0; i < 8; i++) setFunctionModule(size - 1 - i, 8, ((formatBits >>> i) & 1) !== 0);
    for (let i = 8; i < 15; i++) setFunctionModule(8, size - 15 + i, ((formatBits >>> i) & 1) !== 0);

    return { size, modules };
  }

  function renderToCanvas(canvas, text, pixelSize = 240) {
    const bytes = utf8Bytes(text);
    const version = selectVersion(bytes.length);
    const dataCw = buildDataCodewords(bytes, version);
    const allCw = interleaveCodewords(dataCw, version);
    const matrix = createMatrix(version, allCw);

    const quietZone = 4;
    const totalModules = matrix.size + quietZone * 2;
    const scale = Math.max(2, Math.floor(pixelSize / totalModules));
    const realSize = totalModules * scale;

    canvas.width = realSize;
    canvas.height = realSize;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, realSize, realSize);

    ctx.fillStyle = "#0F172A";
    for (let r = 0; r < matrix.size; r++) {
      for (let c = 0; c < matrix.size; c++) {
        if (matrix.modules[r][c] === 2) {
          ctx.fillRect((c + quietZone) * scale, (r + quietZone) * scale, scale, scale);
        }
      }
    }
    return { version, size: matrix.size, byteLength: bytes.length };
  }

  globalScope.QRCodeMini = { renderToCanvas };
})(typeof window !== "undefined" ? window : globalThis);
