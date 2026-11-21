// ScoreLens OMR engine: reads a short printed melody from a grayscale image.
//
// Pipeline: normalize lighting and binarize, measure staff line thickness and
// spacing, deskew, find 5-line staves, erase staff and ledger lines, then find
// noteheads at the half-space positions where they can sit, attach stems,
// beams, flags, dots and accidentals, and read clef, key signature, rests and
// barlines. Everything is measured in staff spaces so it works at any scale.
//
// Works in the browser (window.OMR) and in Node (module.exports).
(function (global) {
  'use strict';

  // ---------- image helpers ----------

  function rgbaToGray(rgba, width, height) {
    const gray = new Uint8Array(width * height);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
      const alpha = rgba[j + 3] / 255;
      const v = rgba[j] * 0.299 + rgba[j + 1] * 0.587 + rgba[j + 2] * 0.114;
      gray[i] = Math.round(v * alpha + 255 * (1 - alpha));
    }
    return gray;
  }

  function resizeGray(src, w, h, nw, nh) {
    const out = new Uint8Array(nw * nh);
    const sx = w / nw;
    const sy = h / nh;
    if (sx > 1 || sy > 1) {
      // Area average for downscaling.
      const ii = new Float64Array((w + 1) * (h + 1));
      for (let y = 0; y < h; y++) {
        let row = 0;
        for (let x = 0; x < w; x++) {
          row += src[y * w + x];
          ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1] + row;
        }
      }
      for (let y = 0; y < nh; y++) {
        const y0 = Math.floor(y * sy);
        const y1 = Math.max(y0 + 1, Math.min(h, Math.floor((y + 1) * sy)));
        for (let x = 0; x < nw; x++) {
          const x0 = Math.floor(x * sx);
          const x1 = Math.max(x0 + 1, Math.min(w, Math.floor((x + 1) * sx)));
          const sum = ii[y1 * (w + 1) + x1] - ii[y0 * (w + 1) + x1] - ii[y1 * (w + 1) + x0] + ii[y0 * (w + 1) + x0];
          out[y * nw + x] = Math.round(sum / ((x1 - x0) * (y1 - y0)));
        }
      }
      return out;
    }
    for (let y = 0; y < nh; y++) {
      const fy = Math.min(h - 1, Math.max(0, (y + 0.5) * sy - 0.5));
      const y0 = Math.floor(fy);
      const y1 = Math.min(h - 1, y0 + 1);
      const ty = fy - y0;
      for (let x = 0; x < nw; x++) {
        const fx = Math.min(w - 1, Math.max(0, (x + 0.5) * sx - 0.5));
        const x0 = Math.floor(fx);
        const x1 = Math.min(w - 1, x0 + 1);
        const tx = fx - x0;
        const a = src[y0 * w + x0] * (1 - tx) + src[y0 * w + x1] * tx;
        const b = src[y1 * w + x0] * (1 - tx) + src[y1 * w + x1] * tx;
        out[y * nw + x] = Math.round(a * (1 - ty) + b * ty);
      }
    }
    return out;
  }

  function rotateGray(src, w, h, degrees) {
    const out = new Uint8Array(w * h).fill(255);
    const a = degrees * Math.PI / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const cx = w / 2;
    const cy = h / 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Inverse map: output (x, y) samples the source rotated by +degrees.
        const dx = x - cx;
        const dy = y - cy;
        const fx = cos * dx - sin * dy + cx;
        const fy = sin * dx + cos * dy + cy;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) continue;
        const tx = fx - x0;
        const ty = fy - y0;
        const p = y0 * w + x0;
        const top = src[p] * (1 - tx) + src[p + 1] * tx;
        const bottom = src[p + w] * (1 - tx) + src[p + w + 1] * tx;
        out[y * w + x] = Math.round(top * (1 - ty) + bottom * ty);
      }
    }
    return out;
  }

  // Divides out uneven lighting (photos), estimating paper brightness from
  // block maxima, then thresholds with Otsu's method. 1 = ink.
  function binarize(gray, w, h, lean = 0) {
    const block = Math.max(16, Math.round(Math.max(w, h) / 40));
    const bw = Math.ceil(w / block);
    const bh = Math.ceil(h / block);
    const maxes = new Float32Array(bw * bh);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let m = 0;
        const y1 = Math.min(h, (by + 1) * block);
        const x1 = Math.min(w, (bx + 1) * block);
        for (let y = by * block; y < y1; y++) {
          for (let x = bx * block; x < x1; x++) if (gray[y * w + x] > m) m = gray[y * w + x];
        }
        maxes[by * bw + bx] = m;
      }
    }
    // Smooth block maxima (3x3 mean, twice) to get a soft background.
    let bg = maxes;
    for (let pass = 0; pass < 2; pass++) {
      const next = new Float32Array(bw * bh);
      for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
          let s = 0, n = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const yy = by + dy, xx = bx + dx;
            if (yy < 0 || xx < 0 || yy >= bh || xx >= bw) continue;
            s += bg[yy * bw + xx]; n++;
          }
          next[by * bw + bx] = s / n;
        }
      }
      bg = next;
    }
    const norm = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / block - 0.5));
      const y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / block - 0.5));
        const x0 = Math.floor(fx), x1 = Math.min(bw - 1, x0 + 1), tx = fx - x0;
        const b = (bg[y0 * bw + x0] * (1 - tx) + bg[y0 * bw + x1] * tx) * (1 - ty) +
          (bg[y1 * bw + x0] * (1 - tx) + bg[y1 * bw + x1] * tx) * ty;
        norm[y * w + x] = Math.min(255, Math.round(gray[y * w + x] * 255 / Math.max(40, b)));
      }
    }
    const hist = new Float64Array(256);
    for (let i = 0; i < norm.length; i++) hist[norm[i]]++;
    let total = norm.length, sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, threshold = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; threshold = t; }
    }
    // Lean toward ink: thin, light staff lines in small images otherwise vanish.
    dbg("otsu", threshold, "lean", lean);
    threshold = Math.min(200, Math.round(threshold + lean * (255 - threshold)));
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < norm.length; i++) bin[i] = norm[i] <= threshold ? 1 : 0;
    return bin;
  }

  // Most common vertical black run (line thickness) and black+white run pair
  // (staff space, line to line).
  function staffMetrics(bin, w, h) {
    const maxRun = Math.max(64, Math.round(h / 4));
    const blackHist = new Float64Array(maxRun + 1);
    const pairHist = new Float64Array(maxRun * 2 + 1);
    const step = Math.max(1, Math.floor(w / 600));
    for (let x = 0; x < w; x += step) {
      let y = 0;
      let lastBlack = -1;
      while (y < h) {
        const v = bin[y * w + x];
        let len = 0;
        while (y < h && bin[y * w + x] === v) { y++; len++; }
        if (v) {
          if (len <= maxRun) blackHist[len]++;
          lastBlack = len;
        } else if (lastBlack > 0 && y < h) {
          const pair = lastBlack + len;
          if (pair <= maxRun * 2) pairHist[pair]++;
          lastBlack = -1;
        }
      }
    }
    let thickness = 1;
    for (let i = 1; i <= maxRun; i++) if (blackHist[i] > blackHist[thickness]) thickness = i;
    let space = 4;
    for (let i = 4; i <= maxRun * 2; i++) if (pairHist[i] > pairHist[space]) space = i;
    // Smooth: weighted mean around the peak gives sub-pixel spacing.
    let s = 0, n = 0;
    for (let i = Math.max(1, space - 2); i <= Math.min(maxRun * 2, space + 2); i++) { s += i * pairHist[i]; n += pairHist[i]; }
    return { thickness, space: n ? s / n : space };
  }

  // Pixels that belong to long horizontal runs (staff lines, beams).
  function longHorizontalPixels(bin, w, h, minRun) {
    const pts = [];
    for (let y = 0; y < h; y++) {
      let x = 0;
      while (x < w) {
        if (!bin[y * w + x]) { x++; continue; }
        const start = x;
        while (x < w && bin[y * w + x]) x++;
        if (x - start >= minRun) {
          for (let xx = start; xx < x; xx += 2) pts.push(xx, y);
        }
      }
    }
    return pts;
  }

  function estimateSkew(bin, w, h, space) {
    const pts = longHorizontalPixels(bin, w, h, Math.round(space * 2));
    if (pts.length < 200) return 0;
    const score = deg => {
      const t = Math.tan(deg * Math.PI / 180);
      const off = Math.ceil(Math.abs(t) * w) + 1;
      const hist = new Float64Array(h + 2 * off);
      for (let i = 0; i < pts.length; i += 2) {
        const y = Math.round(pts[i + 1] - pts[i] * t) + off;
        hist[y]++;
      }
      let s = 0;
      for (let i = 0; i < hist.length; i++) s += hist[i] * hist[i];
      return s;
    };
    let best = 0, bestScore = score(0);
    for (let d = -4; d <= 4.001; d += 0.25) {
      const sc = score(d);
      if (sc > bestScore) { bestScore = sc; best = d; }
    }
    const coarse = best;
    for (let d = coarse - 0.25; d <= coarse + 0.25; d += 0.05) {
      const sc = score(d);
      if (sc > bestScore) { bestScore = sc; best = d; }
    }
    return best;
  }

  const DEBUG = typeof process !== 'undefined' && process.env && process.env.OMR_DEBUG;
  function dbg(...args) { if (DEBUG) console.log('[omr]', ...args); }

  // ---------- connected components ----------

  function labelComponents(bin, w, h) {
    const labels = new Int32Array(w * h);
    const comps = [null];
    const stack = new Int32Array(w * h);
    let next = 1;
    for (let start = 0; start < bin.length; start++) {
      if (!bin[start] || labels[start]) continue;
      const id = next++;
      let sp = 0;
      stack[sp++] = start;
      labels[start] = id;
      let minX = w, minY = h, maxX = -1, maxY = -1, area = 0, sx = 0, sy = 0;
      while (sp) {
        const p = stack[--sp];
        const x = p % w, y = (p - x) / w;
        area++; sx += x; sy += y;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (bin[q] && !labels[q]) { labels[q] = id; stack[sp++] = q; }
          }
        }
      }
      comps.push({ id, minX, minY, maxX, maxY, area, cx: sx / area, cy: sy / area, w: maxX - minX + 1, h: maxY - minY + 1, role: null });
    }
    return { labels, comps };
  }

  // ---------- main recognizer ----------

  const NATURAL_SEMITONES = [0, 2, 4, 5, 7, 9, 11];
  const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
  const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3]; // B E A D G C F
  // Diatonic index (octave * 7 + letter) of the bottom staff line.
  const CLEF_BOTTOM = { treble: 4 * 7 + 2, bass: 2 * 7 + 4, alto: 3 * 7 + 3, tenor: 3 * 7 + 1 };

  // Measures that add up: the share of full bars (not the first or last of
  // a line) whose notes and rests fill the usual bar length.
  function barConsistency(result) {
    let good = 0, all = 0;
    for (const st of result.staves) {
      const sums = new Map();
      for (const e of result.events) if (e.staff === st.index) sums.set(e.measure, (sums.get(e.measure) || 0) + e.beats);
      const vals = [...sums.values()];
      if (vals.length < 2) continue;
      const count = new Map();
      for (const v of vals) count.set(v, (count.get(v) || 0) + 1);
      const mode = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
      vals.forEach((v, i) => { all++; if (Math.abs(v - mode) < 1e-6 || ((i === 0 || i === vals.length - 1) && v < mode)) good++; });
    }
    return all ? good / all : 1;
  }

  // A photo's faint strokes can vanish at the usual threshold. When bars do
  // not add up, read again with a slightly darker threshold and keep the
  // reading whose bars add up better.
  function recognize(rgbaOrGray, width, height, options = {}) {
    const first = recognizeOnce(rgbaOrGray, width, height, options, 0);
    if (options.retry === false || !first.staves.length) return first;
    const c0 = barConsistency(first);
    if (c0 >= 0.999) return first;
    const second = recognizeOnce(rgbaOrGray, width, height, options, 0.1);
    const c1 = barConsistency(second);
    dbg('consistency', c0.toFixed(3), c1.toFixed(3));
    return c1 > c0 + 0.02 ? second : first;
  }

  function recognizeOnce(rgbaOrGray, width, height, options, extraLean) {
    let gray = rgbaOrGray.length === width * height * 4 ? rgbaToGray(rgbaOrGray, width, height) : rgbaOrGray;
    let w = width, h = height, scale = 1;

    // Bring very large photos to a workable size first.
    const maxDim = 3000;
    if (Math.max(w, h) > maxDim) {
      const f = maxDim / Math.max(w, h);
      const nw = Math.round(w * f), nh = Math.round(h * f);
      gray = resizeGray(gray, w, h, nw, nh); w = nw; h = nh; scale *= f;
    }
    let lean = extraLean;
    let bin = binarize(gray, w, h, lean);
    let metrics = staffMetrics(bin, w, h);

    // Normalize so a staff space is about 20 px.
    if (metrics.space < 14 || metrics.space > 32) {
      const f = 20 / metrics.space;
      const nw = Math.round(w * f), nh = Math.round(h * f);
      if (nw * nh < 40e6) {
        gray = resizeGray(gray, w, h, nw, nh); w = nw; h = nh; scale *= f;
        if (f > 1) lean = 0.3 + extraLean;
        bin = binarize(gray, w, h, lean);
        metrics = staffMetrics(bin, w, h);
      }
    }

    let skew = estimateSkew(bin, w, h, metrics.space);
    if (Math.abs(skew) >= 0.1) {
      gray = rotateGray(gray, w, h, skew);
      bin = binarize(gray, w, h, lean);
      metrics = staffMetrics(bin, w, h);
    } else {
      skew = 0;
    }

    const D = metrics.space;
    const T = Math.max(1, metrics.thickness);
    const staves = findStaves(bin, w, h, D, T);
    const result = {
      width: w, height: h, scale, skew, space: D, lineThickness: T,
      staves: [], events: [], warnings: []
    };
    if (options.debug) result.debug = { bin, sym: bin, w, h };
    if (!staves.length) {
      result.warnings.push('No five-line staff found.');
      return result;
    }
    const sym = bin.slice();
    for (const staff of staves) removeStaffLines(sym, bin, w, h, staff, D, T);
    const ii = integral(sym, w, h);
    const { labels, comps } = labelComponents(sym, w, h);
    const ctx = { gray, bin, sym, ii, labels, comps, w, h, D, T, staves };
    if (options.debug) result.debug = { sym, bin, gray, w, h, staves };

    let previousClef = options.clef || 'treble';
    for (let s = 0; s < staves.length; s++) {
      const staff = staves[s];
      staff.index = s;
      // A head belongs to the nearest staff: notes hanging below the right
      // hand's staff must not be read again by the left hand's staff.
      const prev = staves[s - 1], next = staves[s + 1];
      const heads = findHeads(ctx, staff).filter(hd => {
        const xi = Math.max(0, Math.min(w - 1, Math.round(hd.x)));
        if (prev && hd.y < (prev.lineY[4][xi] + staff.lineY[0][xi]) / 2) return false;
        if (next && hd.y > (staff.lineY[4][xi] + next.lineY[0][xi]) / 2) return false;
        return true;
      });
      for (const note of heads) attachStem(ctx, staff, note, heads);
      fixStackStems(ctx, heads);
      dropStemTipBlobs(ctx, heads);
      const header = readHeader(ctx, staff, heads.filter(n => n.valid), previousClef, options);
      previousClef = header.clef;
      staff.clef = header.clef;
      staff.key = header.key;
      staff.headerEnd = header.end;
      staff.timeSignature = header.time;
      const valid = heads.filter(hd => hd.x > header.end && hd.valid);
      for (const note of valid) {
        readDuration(ctx, staff, note);
        markNoteComponents(ctx, note);
      }
      for (const note of valid) {
        findDot(ctx, staff, note);
        findAccidental(ctx, staff, note);
      }
      const bars = findBarlines(ctx, staff, header.end, valid);
      const rests = findRests(ctx, staff, header.end);
      const desc = describeStaff(staff, bars);
      desc.repeats = findRepeats(ctx, staff);
      desc.voltas = findVoltas(ctx, staff);
      result.staves.push(desc);
      result.events.push(...assembleStaff(ctx, staff, valid, rests, bars));
    }
    fillWholeMeasureRests(result.events);
    result.systems = findSystems(ctx, staves, result.staves);
    result.tempo = findTempo(ctx, staves[0]);
    computeTimeline(result);
    // Map coordinates back to the input image.
    result.toImage = (x, y) => {
      const cx = w / 2, cy = h / 2;
      const a = skew * Math.PI / 180;
      const dx = x - cx, dy = y - cy;
      const rx = Math.cos(a) * dx - Math.sin(a) * dy + cx;
      const ry = Math.sin(a) * dx + Math.cos(a) * dy + cy;
      return { x: rx / scale, y: ry / scale };
    };
    // And from the input image into the page's working coordinates.
    result.fromImage = (x, y) => {
      const cx = w / 2, cy = h / 2;
      const a = skew * Math.PI / 180;
      const dx = x * scale - cx, dy = y * scale - cy;
      return { x: Math.cos(a) * dx + Math.sin(a) * dy + cx, y: -Math.sin(a) * dx + Math.cos(a) * dy + cy };
    };
    return result;
  }

  function integral(bin, w, h) {
    const ii = new Int32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += bin[y * w + x];
        ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1] + row;
      }
    }
    return ii;
  }

  function fill(ctx, x0, y0, x1, y1) {
    const { ii, w, h } = ctx;
    x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
    x1 = Math.min(w - 1, Math.round(x1)); y1 = Math.min(h - 1, Math.round(y1));
    if (x1 < x0 || y1 < y0) return 0;
    const W = w + 1;
    const sum = ii[(y1 + 1) * W + x1 + 1] - ii[y0 * W + x1 + 1] - ii[(y1 + 1) * W + x0] + ii[y0 * W + x0];
    return sum / ((x1 - x0 + 1) * (y1 - y0 + 1));
  }

  function pxBin(ctx, x, y) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= ctx.w || y >= ctx.h) return 0;
    return ctx.bin[y * ctx.w + x];
  }

  function px(ctx, x, y) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= ctx.w || y >= ctx.h) return 0;
    return ctx.sym[y * ctx.w + x];
  }

  // ---------- staves ----------

  // Finds 5-line staves. The page is cut into vertical strips: within a
  // strip even a curved or slanted line (a photo of a book page) is nearly
  // straight. Staves found in neighbouring strips are linked, and each line
  // is then traced across the page.
  function findStaves(bin, w, h, D, T) {
    const minRun = Math.round(D * 2);
    const stripW = Math.max(Math.round(12 * D), Math.round(w / 8));
    const strips = [];
    for (let x0 = 0; x0 < w; x0 += stripW) strips.push([x0, Math.min(w, x0 + stripW)]);
    if (strips.length > 1 && strips[strips.length - 1][1] - strips[strips.length - 1][0] < stripW / 2) {
      const last = strips.pop(); strips[strips.length - 1][1] = last[1];
    }
    // Whole-width pass too: on clean images it is the most reliable.
    const passes = [[0, w], ...(strips.length > 1 ? strips : [])];

    // Pixels on short horizontal runs: line pieces even where a line slants.
    const mask = new Uint8Array(w * h);
    const shortRun = Math.round(0.8 * D);
    for (let y = 0; y < h; y++) {
      let x = 0;
      while (x < w) {
        if (!bin[y * w + x]) { x++; continue; }
        const start = x;
        while (x < w && bin[y * w + x]) x++;
        if (x - start >= shortRun) mask.fill(1, y * w + start, y * w + x);
      }
    }
    const findIn = (x0, x1, slope = 0) => {
      const rowScore = new Float64Array(h);
      let max = 0;
      if (slope === 0) {
        for (let y = 0; y < h; y++) {
          let x = x0, count = 0;
          while (x < x1) {
            if (!bin[y * w + x]) { x++; continue; }
            const start = x;
            while (x < x1 && bin[y * w + x]) x++;
            if (x - start >= minRun) count += x - start;
          }
          rowScore[y] = count;
        }
      } else {
        // Sheared projection about the strip centre.
        const xc = (x0 + x1) / 2;
        for (let x = x0; x < x1; x++) {
          const dy = Math.round(slope * (x - xc));
          for (let y = Math.max(0, -dy); y < Math.min(h, h - dy); y++) rowScore[y] += mask[(y + dy) * w + x];
        }
      }
      for (let y = 0; y < h; y++) if (rowScore[y] > max) max = rowScore[y];
      if (max < Math.min(x1 - x0, 6 * D) * 0.5) return [];
      const lines = [];
      const thr = max * 0.25;
      let y = 0;
      while (y < h) {
        if (rowScore[y] < thr) { y++; continue; }
        let sy = 0, n = 0, peak = 0;
        const start = y;
        while (y < h && rowScore[y] >= thr) { sy += y * rowScore[y]; n += rowScore[y]; peak = Math.max(peak, rowScore[y]); y++; }
        if (y - start <= T * 3 + 2) lines.push({ y: sy / n, top: start, bottom: y - 1, peak });
      }
      // Score a run of 5 candidate lines: even spacing and line-like thickness.
      // (A horizontal beam just above a staff can pass for an extra line.)
      const groupScore = i => {
        if (i + 4 >= lines.length) return Infinity;
        const group = lines.slice(i, i + 5);
        const gaps = group.slice(1).map((l, k) => l.y - group[k].y);
        if (!gaps.every(g => g > D * 0.7 && g < D * 1.35)) return Infinity;
        const ratio = Math.max(...gaps) / Math.min(...gaps);
        if (ratio >= 1.4) return Infinity;
        const thick = group.reduce((a, l) => a + Math.max(0, (l.bottom - l.top + 1) - (T + 1)) / T, 0);
        return ratio + 0.15 * thick;
      };
      const found = [];
      for (let i = 0; i + 4 < lines.length;) {
        const here = groupScore(i);
        if (here === Infinity) { i++; continue; }
        if (groupScore(i + 1) < here - 0.05) { i++; continue; }
        const ys = lines.slice(i, i + 5).map(l => l.y);
        ys.score = here;
        ys.slope = slope;
        // The right slope gives the sharpest peaks: judge by the weakest line.
        ys.peak = Math.min(...lines.slice(i, i + 5).map(l => l.peak));
        found.push(ys);
        i += 5;
      }
      return found;
    };

    // Collect anchors: (x, five line ys) from every pass.
    const anchors = [];
    passes.forEach(([x0, x1], pi) => {
      if (pi === 0) {
        for (const ys of findIn(x0, x1)) anchors.push({ x: (x0 + x1) / 2, ys, whole: true });
        return;
      }
      // A strip of a curved page: lines may slant. Try a few slopes and
      // keep the best-scoring group for each staff.
      const got = [];
      for (let sl = -0.15; sl <= 0.151; sl += 0.025) {
        const slope = Math.abs(sl) < 1e-6 ? 0 : sl;
        for (const ys of findIn(x0, x1, slope)) {
          const same = got.find(o => Math.abs(o.ys[2] - ys[2]) < 2 * D);
          if (!same) got.push({ ys });
          else if (ys.peak > same.ys.peak * 1.05 || (ys.peak >= same.ys.peak * 0.95 && ys.score < same.ys.score)) same.ys = ys;
        }
      }
      for (const g of got) {
        // Anchor at the middle of the part of the strip the staff covers
        // (a staff may end inside the strip).
        const xc = (x0 + x1) / 2, sl = g.ys.slope || 0;
        let sx = 0, n = 0;
        for (let x = x0; x < x1; x++) {
          let c = 0;
          for (const ly of g.ys) {
            const yy = Math.round(ly + sl * (x - xc));
            if (yy > 0 && yy < h - 1 && (mask[yy * w + x] || mask[(yy - 1) * w + x] || mask[(yy + 1) * w + x])) c++;
          }
          if (c >= 4) { sx += x; n++; }
        }
        if (n < 3 * D) continue;
        const xm = sx / n;
        const ys = g.ys.map(v => v + sl * (xm - xc));
        ys.slope = sl; ys.score = g.ys.score;
        dbg('strip', x0, x1, sl.toFixed(3), Math.round(xm), ys.map(v => v.toFixed(0)).join(','));
        anchors.push({ x: xm, ys, whole: false });
      }
    });
    dbg('staff anchors', anchors.length, anchors.map(a => Math.round(a.x) + ':' + a.ys.map(v => v.toFixed(0)).join(',')).join(' '));
    // Link anchors into staves: same staff when the lines nearly coincide.
    // Strip anchors are sorted by x so a staff can bend gradually.
    anchors.sort((a, b) => (b.whole - a.whole) || a.x - b.x);
    const groups = [];
    const match = an => {
      let best = null, bestD = Infinity, shifted = false, far = false;
      for (const g of groups) {
        // Compare with the group's anchor nearest in x.
        let near = g.anchors[0];
        for (const o of g.anchors) if (Math.abs(o.x - an.x) < Math.abs(near.x - an.x)) near = o;
        const diff = sh => {
          let s = 0;
          for (let k = 0; k < 5; k++) {
            const j = k + sh;
            const ref = j < 0 ? near.ys[0] - (near.ys[1] - near.ys[0]) : j > 4 ? near.ys[4] + (near.ys[4] - near.ys[3]) : near.ys[j];
            // Carry the neighbour along its own slope to this x.
            s += Math.abs(ref + (near.ys.slope || 0) * (an.x - near.x) - an.ys[k]);
          }
          return s / 5;
        };
        const dy = diff(0);
        const tol = 0.8 * D + 0.6 * D * Math.abs(near.x - an.x) / stripW;
        if (dy < Math.min(tol, 2.4 * D) && dy < bestD) {
          // A group shifted by one line (a beam taken as a staff line)
          // matches the neighbour better when shifted: drop it.
          best = g; bestD = dy;
          shifted = Math.min(diff(-1), diff(1)) < 0.5 * dy;
          far = Math.abs(near.x - an.x) > 1.5 * stripW;
        }
      }
      return { best, shifted, far };
    };
    // Against a far neighbour (or only the whole-width fit) a tilted staff
    // can drift by a full line and look shifted: decide those later, once
    // closer strips have joined the group.
    let pending = [];
    for (const an of anchors) {
      const m = match(an);
      if (!m.best) groups.push({ anchors: [an] });
      else if (!m.shifted) m.best.anchors.push(an);
      else if (m.far) pending.push(an);
    }
    for (let changed = true; changed && pending.length;) {
      changed = false;
      const rest = [];
      for (const an of pending) {
        const m = match(an);
        if (m.best && !m.shifted) { m.best.anchors.push(an); changed = true; }
        else if (m.best && m.far) rest.push(an);
      }
      pending = rest;
    }
    // Still only far neighbours: accept when the shift is under one line.
    for (const an of pending) {
      const m = match(an);
      if (m.best) m.best.anchors.push(an);
    }
    const staves = [];
    for (const g of groups) {
      const pts = g.anchors.filter(a => !a.whole).sort((a, b) => a.x - b.x);
      const whole = g.anchors.find(a => a.whole);
      dbg("group", g.anchors.length, pts.map(p => Math.round(p.x) + ":" + Math.round(p.ys[0])).join(" "));
      if (!whole && pts.length < 2) continue;
      // A guide per line: interpolate between strip anchors.
      const guide = k => {
        const ys = new Float32Array(w);
        if (!pts.length) { ys.fill(whole.ys[k]); return ys; }
        for (let x = 0; x < w; x++) {
          let i = 0;
          while (i + 1 < pts.length && pts[i + 1].x < x) i++;
          const a = pts[i], b = pts[Math.min(i + 1, pts.length - 1)];
          // Each anchor knows its local slope: blend the two tangents.
          const at = (p, xx) => p.ys[k] + (p.ys.slope || 0) * (xx - p.x);
          if (x <= pts[0].x) ys[x] = at(pts[0], x);
          else if (x >= pts[pts.length - 1].x) ys[x] = at(pts[pts.length - 1], x);
          else {
            const t = (x - a.x) / Math.max(1, b.x - a.x);
            ys[x] = at(a, x) * (1 - t) + at(b, x) * t;
          }
        }
        return ys;
      };
      const guides = [0, 1, 2, 3, 4].map(guide);
      const xc = Math.round(pts.length ? pts[Math.floor(pts.length / 2)].x : w / 2);
      staves.push({ lines: guides.map(gy => gy[xc]), guides });
    }
    staves.sort((a, b) => a.lines[0] - b.lines[0]);
    // Drop staves that overlap a better one (duplicates from passes).
    for (let i = staves.length - 1; i > 0; i--) {
      if (staves[i].lines[0] < staves[i - 1].lines[4] - 0.5 * D) staves.splice(i, 1);
    }
    dbg('lines', staves.map(st => st.lines.map(v => v.toFixed(1)).join(' ')).join(' | '), 'D', D.toFixed(2), 'T', T);

    for (const staff of staves) {
      // Horizontal extent: columns where at least 4 of the 5 lines are inked.
      const hit = new Uint8Array(w);
      for (let x = 0; x < w; x++) {
        let c = 0;
        for (const gy of staff.guides) {
          const yy = Math.round(gy[x]);
          let found = 0;
          for (let d = -T - 2; d <= T + 2 && !found; d++) {
            const q = yy + d;
            if (q >= 0 && q < h && bin[q * w + x]) found = 1;
          }
          c += found;
        }
        hit[x] = c >= 4 ? 1 : 0;
      }
      let bestStart = 0, bestEnd = -1, x = 0;
      while (x < w) {
        if (!hit[x]) { x++; continue; }
        const start = x;
        let end = x, gap = 0;
        while (x < w && gap <= D) {
          if (hit[x]) { end = x; gap = 0; } else gap++;
          x++;
        }
        if (end - start > bestEnd - bestStart) { bestStart = start; bestEnd = end; }
      }
      staff.left = bestStart;
      staff.right = bestEnd;
      // Trace each line along its guide to follow curvature.
      staff.lineY = staff.guides.map(gy => {
        const ys = new Float32Array(w);
        let cur;
        // Follow the line as an offset from its guide: where a chord or a
        // beam hides it, the offset is kept and the guide carries the slope.
        let off = 0;
        const track = (x) => {
          const base = gy[x];
          const cur = base + off;
          let best = null;
          for (let d = 0; d <= T + 1 && best === null; d++) {
            for (const sgn of d ? [-1, 1] : [1]) {
              const yy = Math.round(cur + sgn * d);
              if (yy < 0 || yy >= h || !bin[yy * w + x]) continue;
              let a = yy, b = yy;
              while (a > 0 && bin[(a - 1) * w + x]) a--;
              while (b < h - 1 && bin[(b + 1) * w + x]) b++;
              if (b - a + 1 <= T + 2) { best = (a + b) / 2; break; }
            }
          }
          if (best !== null && Math.abs(best - cur) <= 1.5) off = off * 0.7 + (best - base) * 0.3;
          // Stay near the guide: never wander onto a beam or slur.
          const lim = Math.max(2, 0.4 * D);
          off = Math.max(-lim, Math.min(lim, off));
          ys[x] = base + off;
        };
        const mid = Math.round((staff.left + staff.right) / 2);
        for (let x = mid; x <= staff.right; x++) track(x);
        off = ys[mid] - gy[mid];
        for (let x = mid; x >= staff.left; x--) track(x);
        for (let x = 0; x < staff.left; x++) ys[x] = ys[staff.left] + (gy[x] - gy[staff.left]);
        for (let x = staff.right + 1; x < w; x++) ys[x] = ys[staff.right] + (gy[x] - gy[staff.right]);
        return ys;
      });
      staff.lines = staff.lineY.map(ys => ys[Math.round((staff.left + staff.right) / 2)]);
      delete staff.guides;
      staff.space = D;
    }
    return staves.filter(st => st.right - st.left > 6 * D);
  }


  // y of staff position k at column x: k=0 top line, k=8 bottom line,
  // odd k are spaces, negative/over 8 continue with ledger positions.
  function posY(staff, x, k) {
    const xi = Math.max(0, Math.min(staff.lineY[0].length - 1, Math.round(x)));
    const top = staff.lineY[0][xi];
    const bottom = staff.lineY[4][xi];
    const half = (bottom - top) / 8;
    if (k >= 0 && k <= 8) {
      const a = Math.floor(k / 2), b = Math.ceil(k / 2);
      return (staff.lineY[a][xi] + staff.lineY[b][xi]) / 2;
    }
    return k < 0 ? top + k * half : bottom + (k - 8) * half;
  }

  function nearestPos(staff, x, y) {
    const xi = Math.max(0, Math.min(staff.lineY[0].length - 1, Math.round(x)));
    const top = staff.lineY[0][xi];
    const bottom = staff.lineY[4][xi];
    const half = (bottom - top) / 8;
    let k = Math.round((y - top) / half);
    // Refine against tracked lines inside the staff.
    let best = k, bestD = Infinity;
    for (let kk = k - 1; kk <= k + 1; kk++) {
      const d = Math.abs(posY(staff, x, kk) - y);
      if (d < bestD) { bestD = d; best = kk; }
    }
    return { k: best, error: bestD / (half * 2) };
  }

  function removeStaffLines(sym, bin, w, h, staff, D, T) {
    // Measure this staff's real line thickness (90th percentile of the
    // vertical runs found on its lines), since scans vary column to column.
    const runs = [];
    for (let x = staff.left; x <= staff.right; x += 2) {
      for (let l = 0; l < 5; l++) {
        const y0 = Math.round(staff.lineY[l][x]);
        if (!bin[y0 * w + x]) continue;
        let a = y0, b = y0;
        while (a > 0 && bin[(a - 1) * w + x]) a--;
        while (b < h - 1 && bin[(b + 1) * w + x]) b++;
        if (b - a + 1 <= 2 * T + 4) runs.push(b - a + 1);
      }
    }
    runs.sort((p, q) => p - q);
    const p90 = runs.length ? runs[Math.floor(runs.length * 0.9)] : T;
    T = Math.max(T, p90 - 1);
    const erase = (x, yc, needHorizontal) => {
      const y0 = Math.round(yc);
      let y = -1;
      for (let d = 0; d <= T + 1 && y < 0; d++) {
        if (y0 - d >= 0 && sym[(y0 - d) * w + x]) y = y0 - d;
        else if (y0 + d < h && sym[(y0 + d) * w + x]) y = y0 + d;
      }
      if (y < 0) return;
      let a = y, b = y;
      while (a > 0 && sym[(a - 1) * w + x]) a--;
      while (b < h - 1 && sym[(b + 1) * w + x]) b++;
      if (b - a + 1 > (needHorizontal ? Math.max(T + 3, T * 1.8 + 1) : T + 2)) return;
      if (!needHorizontal) {
        // Keep strokes that touch the line from one side: the run must stay
        // within the line's own band (one pixel of slack each way).
        const half = (T - 1) / 2;
        if (a < yc - half - 1.5 || b > yc + half + 1.5) return;
        // Keep the pixel when a slanted stroke crosses the line here.
        const ink = (xx, yy) => xx >= 0 && xx < w && yy >= 0 && yy < h && sym[yy * w + xx];
        if ((ink(x - 1, a - 1) && ink(x + 1, b + 1)) || (ink(x + 1, a - 1) && ink(x - 1, b + 1))) return;
      }
      if (needHorizontal) {
        // Measure on the original image: erasing column by column would
        // otherwise shorten the run as we go.
        let l = x, r = x;
        while (l > 0 && bin[y * w + l - 1]) l--;
        while (r < w - 1 && bin[y * w + r + 1]) r++;
        if (r - l + 1 < D * 1.0) return;
      }
      for (let yy = a; yy <= b; yy++) sym[yy * w + x] = 0;
    };
    const left = Math.max(0, staff.left - Math.round(D));
    const right = Math.min(w - 1, staff.right + Math.round(D));
    for (let x = left; x <= right; x++) {
      for (let l = 0; l < 5; l++) erase(x, staff.lineY[l][x], false);
    }
    // Ledger lines: short horizontal lines at whole-space steps outside the staff.
    // Erase column by column only where the stroke is a thin horizontal line.
    for (let pass = 0; pass < 2; pass++) {
      for (let x = left; x <= right; x++) {
        for (let j = 1; j <= 6; j++) {
          erase(x, posY(staff, x, -2 * j), true);
          erase(x, posY(staff, x, 8 + 2 * j), true);
        }
      }
    }
  }

  // ---------- noteheads ----------

  function findHeads(ctx, staff) {
    const { D } = ctx;
    const heads = [];
    const kMin = -12, kMax = 20;
    const x0 = staff.left, x1 = staff.right;
    // Filled heads: a solid core sitting exactly on a line or space position.
    for (let k = kMin; k <= kMax; k++) {
      let runStart = -1;
      for (let x = x0; x <= x1 + 1; x++) {
        let ok = false;
        if (x <= x1) {
          const y = posY(staff, x, k);
          ok = fill(ctx, x - 0.28 * D, y - 0.16 * D, x + 0.28 * D, y + 0.16 * D) >= 0.93;
        }
        if (ok && runStart < 0) runStart = x;
        if (!ok && runStart >= 0) {
          const cx = Math.round((runStart + x - 1) / 2);
          const cand = measureFilledHead(ctx, staff, cx, k);
          if (cand) heads.push(cand);
          runStart = -1;
        }
      }
    }
    // Hollow heads: an enclosed white hole sitting on a position.
    heads.push(...resolveHollowStacks(ctx, staff, findHollowHeads(ctx, staff, kMin, kMax)));
    // Non-maximum suppression across neighbouring positions.
    heads.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const hd of heads) {
      const clash = kept.some(o => Math.abs(o.x - hd.x) < D * 0.8 && Math.abs(o.k - hd.k) <= 1);
      if (!clash) kept.push(hd);
    }
    kept.sort((a, b) => a.x - b.x);
    // Above or below the staff a note needs its ledger lines; without them a
    // "head" is a page edge, a shadow or text.
    const ledgerAt = (hd, kk) => {
      const y = Math.round(posY(staff, hd.x, kk));
      for (let dy = -ctx.T - 1; dy <= ctx.T + 1; dy++) {
        let run = 0, best = 0;
        for (let x = Math.round(hd.L - 0.6 * D); x <= Math.round(hd.R + 0.6 * D); x++) {
          run = pxBin(ctx, x, y + dy) ? run + 1 : 0;
          best = Math.max(best, run);
        }
        if (best >= Math.min(1.3 * D, hd.R - hd.L + 0.4 * D)) return true;
      }
      return false;
    };
    return kept.filter(hd => {
      for (let kk = -2; kk >= hd.k; kk -= 2) if (!ledgerAt(hd, kk)) return false;
      for (let kk = 10; kk <= hd.k; kk += 2) if (!ledgerAt(hd, kk)) return false;
      return true;
    });
  }

  // Half-note chords in thirds: the rings touch and holes are also found
  // between the real heads. Measure the column's height: n heads stacked a
  // space apart are n spaces tall, which fixes where each head sits.
  function resolveHollowStacks(ctx, staff, cands) {
    const { D } = ctx;
    const sorted = cands.slice().sort((a, b) => a.x - b.x);
    const clusters = [];
    for (const c of sorted) {
      const cl = clusters.find(g => Math.abs(g.x - c.x) < 0.5 * D);
      if (cl) { cl.items.push(c); cl.x = cl.items.reduce((a, o) => a + o.x, 0) / cl.items.length; }
      else clusters.push({ x: c.x, items: [c] });
    }
    const out = [];
    for (const cl of clusters) {
      const ks = cl.items.map(o => o.k);
      const kLo = Math.min(...ks), kHi = Math.max(...ks);
      if (kHi - kLo < 2) { out.push(...cl.items); continue; }
      const ws = cl.items.map(o => o.R - o.L).sort((a, b) => a - b);
      const W = ws[Math.floor(ws.length / 2)];
      const cx = cl.x;
      const y0 = posY(staff, cx, kLo) - 0.9 * D, y1 = posY(staff, cx, kHi) + 0.9 * D;
      let yT = Infinity, yB = -Infinity;
      for (let y = Math.round(y0); y <= y1; y++) {
        // bin, not sym: ring edges on staff lines were erased with them
        if (fillBin(ctx, cx - 0.3 * W, y, cx + 0.3 * W, y) >= 0.5) { yT = Math.min(yT, y); yB = Math.max(yB, y); }
      }
      const H = yB - yT + 1;
      const n = Math.round(H / D);
      let ok = isFinite(H) && n >= 2 && n <= 4 && Math.abs(H / n - D) < 0.3 * D;
      const want = [];
      if (ok) {
        for (let i = 0; i < n; i++) want.push(nearestPos(staff, cx, yT + (i + 0.5) * H / n).k);
        ok = want.every((k, i) => k === want[0] + 2 * i);
        // Each head shows its ring's sides (a fifth leaves a white gap).
        for (let i = 0; i < n && ok; i++) {
          const hy = yT + (i + 0.5) * H / n;
          // (staff lines removed here, so a line through a gap is no ring)
          const l = fill(ctx, cx - 0.5 * W, hy - 0.15 * D, cx - 0.25 * W, hy + 0.15 * D);
          const r = fill(ctx, cx + 0.25 * W, hy - 0.15 * D, cx + 0.5 * W, hy + 0.15 * D);
          // and a white inside (a digit or a clef is ink there)
          // (just above and below the centre: a ledger line may run through it)
          const inner = Math.min(
            fill(ctx, cx - 0.12 * W, hy - 0.1 * D, cx + 0.12 * W, hy + 0.1 * D),
            Math.max(
              fill(ctx, cx - 0.12 * W, hy - 0.3 * D, cx + 0.12 * W, hy - 0.14 * D),
              fill(ctx, cx - 0.12 * W, hy + 0.14 * D, cx + 0.12 * W, hy + 0.3 * D)));
          if (Math.min(l, r) < 0.15 || inner > 0.3) { ok = false; dbg("stack reject", Math.round(cx), i, l.toFixed(2), r.toFixed(2), inner.toFixed(2)); }
        }
      }
      dbg('hollow stack', Math.round(cx), 'k', kLo, kHi, 'H', (H / D).toFixed(2), 'n', n, ok ? want.join(',') : 'no');
      if (!ok) { out.push(...cl.items); continue; }
      for (const k of want) {
        const have = cl.items.filter(o => o.k === k).sort((a, b) => b.score - a.score)[0];
        const y = posY(staff, cx, k);
        const stack = cl;
        out.push(have ? Object.assign(have, { score: 2, stack }) : { x: cx, y, k, L: cx - W / 2, R: cx + W / 2, filled: false, score: 2, stack });
      }
    }
    return out;
  }

  // A stack of hollow heads shares one stem (half notes) or has none
  // (whole notes); single-head stem tests stumble on the touching rings.
  function fixStackStems(ctx, heads) {
    const { D } = ctx;
    const stacks = new Map();
    for (const h of heads) if (h.stack) { if (!stacks.has(h.stack)) stacks.set(h.stack, []); stacks.get(h.stack).push(h); }
    for (const members of stacks.values()) {
      members.sort((a, b) => a.y - b.y);
      const top = members[0], bot = members[members.length - 1];
      const L = Math.min(...members.map(m => m.L)), R = Math.max(...members.map(m => m.R));
      const up = verticalReach(ctx, R - 0.4 * D, R + 0.15 * D, top.y, -1, 9 * D);
      const down = verticalReach(ctx, L - 0.15 * D, L + 0.4 * D, bot.y, 1, 9 * D);
      let stem = null;
      if (up.length >= 2.0 * D && up.length >= down.length) stem = { dir: -1, x: up.x, tip: top.y - up.length, length: up.length + (bot.y - top.y) };
      else if (down.length >= 2.0 * D) stem = { dir: 1, x: down.x, tip: bot.y + down.length, length: down.length + (bot.y - top.y) };
      else if (Math.max(up.length, down.length) > 1.2 * D) continue;
      dbg('stack stem', Math.round(top.x), members.map(m => m.k).join(','), stem ? stem.dir : 'whole');
      for (const m of members) { m.stem = stem ? Object.assign({}, stem) : null; m.valid = true; }
    }
  }

  function fillBin(ctx, x0, y0, x1, y1) {
    let n = 0, t = 0;
    for (let y = Math.round(y0); y <= Math.round(y1); y++) for (let x = Math.round(x0); x <= Math.round(x1); x++) {
      t++; if (pxBin(ctx, x, y)) n++;
    }
    return t ? n / t : 0;
  }

  function measureFilledHead(ctx, staff, cx, k) {
    const { D } = ctx;
    const y = posY(staff, cx, k);
    const bandFill = x => fill(ctx, x, y - 0.28 * D, x, y + 0.28 * D);
    let L = cx, R = cx;
    while (L > cx - 2.5 * D && bandFill(L - 1) >= 0.5) L--;
    while (R < cx + 2.5 * D && bandFill(R + 1) >= 0.5) R++;
    const W = R - L + 1;
    if (W < 0.85 * D || W > 2.1 * D) return null;
    const mx = (L + R) / 2;
    const innerL = L + 0.25 * W, innerR = R - 0.25 * W;
    const above = fill(ctx, innerL, y - 0.85 * D, innerR, y - 0.62 * D);
    const below = fill(ctx, innerL, y + 0.62 * D, innerR, y + 0.85 * D);
    let stacked = false;
    if (above > 0.45 || below > 0.45) {
      // A chord in thirds: heads touch and form one solid column. Accept
      // when this position is a whole number of head heights from the
      // column's top and bottom (positions in between are not heads).
      const row = yy => fill(ctx, innerL, yy, innerR, yy) >= 0.6;
      let yT = Math.round(y), yB = Math.round(y);
      while (yT > y - 5 * D && row(yT - 1)) yT--;
      while (yB < y + 5 * D && row(yB + 1)) yB++;
      const H = yB - yT + 1;
      const n = Math.round(H / D);
      const off = (y - (yT + 0.5 * H / n)) / (H / n);
      if (n < 2 || n > 4 || Math.abs(H / n - D) > 0.3 * D || Math.abs(off - Math.round(off)) > 0.25) return null;
      // The column stands free: little ink beside it (a stem may run up
      // one side). A clef or a smudge has curves wrapping around.
      const sideL = fill(ctx, L - 0.4 * D, yT, L - 0.1 * D, yB);
      const sideR = fill(ctx, R + 0.1 * D, yT, R + 0.4 * D, yB);
      if (Math.min(sideL, sideR) > 0.12 || Math.max(sideL, sideR) > 0.4) return null;
      // Every head in the column is about as wide as this one.
      for (let i = 0; i < n; i++) {
        const hy = yT + (i + 0.5) * H / n;
        let a = Math.round(mx), b = a;
        const bf = x => fill(ctx, x, hy - 0.2 * D, x, hy + 0.2 * D) >= 0.5;
        while (a > mx - 1.5 * D && bf(a - 1)) a--;
        while (b < mx + 1.5 * D && bf(b + 1)) b++;
        if (Math.abs((b - a + 1) - W) > 0.35 * D) return null;
      }
      // Touching oval heads pinch where they meet; a digit or a clef does not.
      let pinch = 0;
      for (let i = 1; i < n; i++) {
        const jy = yT + i * H / n;
        let a = Math.round(mx), b = a;
        const bf = x => fill(ctx, x, jy - 0.06 * D, x, jy + 0.06 * D) >= 0.5;
        while (a > mx - 1.5 * D && bf(a - 1)) a--;
        while (b < mx + 1.5 * D && bf(b + 1)) b++;
        pinch = Math.max(pinch, (b - a + 1) / W);
      }
      // A chord has a thin stem running on past the column (a stacked
      // time signature or a clef does not).
      const thinStem = (xa, xb, y0, dir) => {
        const r = verticalReach(ctx, xa, xb, y0, dir, 10 * D);
        if (r.length < 1.8 * D) return false;
        // Mostly thin past the column (it may cross another head).
        const from = dir < 0 ? y0 - (y0 - yT) : y0 + (yB - y0);
        const beyond = r.length - Math.abs(from - y0);
        if (beyond < 1.2 * D) return false;
        let thin = 0, all = 0;
        for (let t = 0.3 * D; t < beyond; t += 2) {
          const yy = Math.round(from + dir * t);
          let a = r.x, b = r.x;
          while (px(ctx, a - 1, yy) && r.x - a < D) a--;
          while (px(ctx, b + 1, yy) && b - r.x < D) b++;
          all++;
          if (b - a + 1 <= 0.4 * D) thin++;
        }
        return thin >= 0.6 * all && thin * 2 >= 1.0 * D;
      };
      const hasStem = thinStem(R - 0.4 * D, R + 0.15 * D, yT + 0.3 * D, -1) || thinStem(L - 0.15 * D, L + 0.4 * D, yB - 0.3 * D, 1);
      dbg('stack-pinch', Math.round(mx), k, pinch.toFixed(2), hasStem);
      if (!hasStem) return null;
      stacked = true;
      dbg("stacked", Math.round(mx), k, n, sideL.toFixed(2), sideR.toFixed(2));
    }
    const body = fill(ctx, L + 0.1 * W, y - 0.3 * D, R - 0.1 * W, y + 0.3 * D);
    if (body < 0.75) return null;
    return { x: mx, y, k, L, R, filled: true, score: stacked ? body * 0.97 : body, stacked };
  }

  // Hollow heads (half and whole notes): a white centre enclosed by ink on
  // (nearly) all sides within a notehead-sized ellipse. Casting rays instead
  // of requiring a perfectly closed hole tolerates thin, broken rings.
  function findHollowHeads(ctx, staff, kMin, kMax) {
    const { D, w } = ctx;
    const out = [];
    const RAYS = 16;
    const dirs = [];
    for (let i = 0; i < RAYS; i++) {
      const a = (i / RAYS) * Math.PI * 2;
      dirs.push([Math.cos(a), Math.sin(a)]);
    }
    const rx = 0.95 * D, ry = 0.68 * D;
    let allowLines = false;
    const enclosed = (x, y) => {
      let hits = 0;
      for (let i = 0; i < RAYS; i++) {
        const [dx, dy] = dirs[i];
        const lim = 1 / Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
        let hit = false;
        // Steep rays may also stop at staff lines in the original image:
        // thin ring edges lying on a line were erased with it.
        const steep = Math.abs(dy) >= 0.38;
        for (let t = 1; t <= lim; t += 0.75) {
          if (px(ctx, x + dx * t, y + dy * t) || (steep && allowLines && pxBin(ctx, x + dx * t, y + dy * t))) { hit = true; break; }
        }
        if (hit) hits++;
        else if (i - hits >= 2) return false;
      }
      return hits >= RAYS - 1;
    };
    // A ring that exactly fills a staff space lost its top and bottom edges
    // with the staff lines. Accept it when short crescents close it left and
    // right and the (original) staff lines close it above and below.
    const crescent = (x, y, dir) => {
      for (let t = Math.round(0.12 * D); t <= 0.8 * D; t++) {
        const xx = Math.round(x + dir * t);
        if (!px(ctx, xx, y)) continue;
        if (t > 0.75 * D) return false;
        const c = ctx.comps[ctx.labels[Math.round(y) * w + xx]];
        return !!c && c.h >= 0.45 * D && c.h <= 1.3 * D && c.w <= 1.0 * D;
      }
      return false;
    };
    const lineAt = (x, y, dir) => {
      for (let t = 1; t <= 0.7 * D; t++) if (pxBin(ctx, x, y + dir * t)) return true;
      return false;
    };
    const ringInSpace = (x, y) => !px(ctx, x, y) && crescent(x, y, -1) && crescent(x, y, 1) && lineAt(x, y, -1) && lineAt(x, y, 1);
    // Pass 1: enclosed holes. Pass 2: rings in a space, only where pass 1
    // found nothing (they would otherwise shift the centre of good runs).
    for (const pass of [1, 2]) {
      const before = out.length;
      for (let k = kMin; k <= kMax; k++) {
        if (pass === 2 && !(k % 2 !== 0 && k >= 1 && k <= 7)) continue;
        let runStart = -1;
        for (let x = staff.left; x <= staff.right + 1; x++) {
          let ok = false;
          if (x <= staff.right) {
            const y = posY(staff, x, k);
            ok = pass === 1
              ? (!px(ctx, x, y) || thinHorizontal(ctx, x, y)) && enclosed(x, y)
              : ringInSpace(x, y);
          }
          if (ok && runStart < 0) runStart = x;
          if (!ok && runStart >= 0) {
            const cx = Math.round((runStart + x - 1) / 2);
            runStart = -1;
            if (pass === 2 && out.slice(0, before).some(o => Math.abs(o.x - cx) < 1.2 * D && Math.abs(o.k - k) <= 2)) continue;
            const cand = measureHollowHead(ctx, staff, cx, k);
            if (Array.isArray(cand)) out.push(...cand);
            else if (cand) out.push(cand);
          }
        }
      }
    }
    return out;
  }

  // A pixel on a thin horizontal stroke (a leftover line through a hole).
  function thinHorizontal(ctx, x, y) {
    let a = Math.round(y), b = a;
    while (px(ctx, x, a - 1) && a > y - ctx.D) a--;
    while (px(ctx, x, b + 1) && b < y + ctx.D) b++;
    return b - a + 1 <= ctx.T * 2 + 2;
  }

  function measureHollowHead(ctx, staff, cx, k) {
    const { D, w, h } = ctx;
    const y = posY(staff, cx, k);
    const row = Math.round(y);
    let useBin = false;
    const scan = (x, yy, dx, dy, maxSteps) => {
      // Skip white, then cross ink; return the far edge of the ink. Vertical
      // scans also see staff lines, which may carry the ring's thin edge.
      const ink = useBin ? (a, b) => px(ctx, a, b) || pxBin(ctx, a, b) : (a, b) => px(ctx, a, b);
      let steps = 0;
      while (steps < maxSteps && !ink(x, yy)) { x += dx; yy += dy; steps++; }
      if (steps >= maxSteps) return null;
      while (steps < maxSteps * 2 && ink(x + dx, yy + dy) && (dx || Math.abs(yy + dy - y) < 0.75 * D)) { x += dx; yy += dy; steps++; }
      return dx ? x : yy;
    };
    // Use the band around the row to be robust to the slanted hole.
    let L = Infinity, R = -Infinity, top = Infinity, bottom = -Infinity;
    for (let d = -2; d <= 2; d++) {
      const l = scan(cx, row + d, -1, 0, Math.round(1.2 * D));
      const r = scan(cx, row + d, 1, 0, Math.round(1.2 * D));
      if (l !== null) L = Math.min(L, l);
      if (r !== null) R = Math.max(R, r);
      let t = scan(cx + d, row, 0, -1, Math.round(0.8 * D));
      let b = scan(cx + d, row, 0, 1, Math.round(0.8 * D));
      // A ring edge lying on a staff line was erased with it; fall back to
      // the original image for that side only.
      useBin = true;
      if (t === null) t = scan(cx + d, row, 0, -1, Math.round(0.8 * D));
      if (b === null) b = scan(cx + d, row, 0, 1, Math.round(0.8 * D));
      useBin = false;
      if (t !== null) top = Math.min(top, t);
      if (b !== null) bottom = Math.max(bottom, b);
    }
    if (!isFinite(L) || !isFinite(R) || !isFinite(top) || !isFinite(bottom)) return null;
    const W = R - L + 1, H = bottom - top + 1;
    dbg('hollow', cx, k, 'W', (W / D).toFixed(2), 'H', (H / D).toFixed(2), 'ring', fill(ctx, L, top, R, bottom).toFixed(2));
    if (W < 0.95 * D || W > 2.6 * D || H < 0.72 * D || H > 1.5 * D) return null;
    const ring = fill(ctx, L, top, R, bottom);
    if (ring < 0.22 || ring > 0.85) return null;
    // Ring sides are thin crescents, not a neighbouring notehead, and at most
    // one of them may continue into a long stroke (the stem).
    // Take the thinnest of a few rows so a line through the hole is ignored.
    let tl = D, tr = D;
    for (let d = -Math.round(0.25 * D); d <= Math.round(0.25 * D); d += 2) {
      let a = 0, b = 0;
      while (px(ctx, L + a, row + d) && a < D) a++;
      while (px(ctx, R - b, row + d) && b < D) b++;
      if (a) tl = Math.min(tl, a);
      if (b) tr = Math.min(tr, b);
    }
    if (tl > 0.6 * D || tr > 0.6 * D) return null;
    const vRun = x => {
      let a = row, b = row;
      while (px(ctx, x, a - 1) && row - a < 4 * D) a--;
      while (px(ctx, x, b + 1) && b - row < 4 * D) b++;
      return b - a + 1;
    };
    // Both sides may run on when another hollow head is stacked right above
    // or below (a third in a chord): its hole is a space away.
    const holeAt = (xc, yy) => {
      for (let dx = 0; dx <= 0.4 * D; dx++) {
        for (const x0 of dx ? [xc - dx, xc + dx] : [xc]) {
          if (px(ctx, x0, yy)) continue;
          let l = 0, r = 0;
          for (let t = 1; t <= 0.8 * D && (!l || !r); t++) {
            if (!l && px(ctx, x0 - t, yy)) l = t;
            if (!r && px(ctx, x0 + t, yy)) r = t;
          }
          if (!(l > 0 && r > 0 && l + r <= 1.1 * D)) continue;
          let u = 0, d = 0;
          for (let t = 1; t <= 0.75 * D && (!u || !d); t++) {
            if (!u && (px(ctx, x0, yy - t) || pxBin(ctx, x0, yy - t))) u = t;
            if (!d && (px(ctx, x0, yy + t) || pxBin(ctx, x0, yy + t))) d = t;
          }
          if (u > 0 && d > 0) return true;
        }
      }
      return false;
    };
    if (vRun(Math.round(L + tl / 2)) > 1.5 * D && vRun(Math.round(R - tr / 2)) > 1.5 * D &&
        !holeAt(cx, posY(staff, cx, k - 2)) && !holeAt(cx, posY(staff, cx, k + 2))) return null;
    // The head must be centred on this position: compare with its ink box.
    const centerErr = Math.abs((top + bottom) / 2 - y) / D;
    if (centerErr > 0.3) return null;
    // A ring taller than one head is usually two stacked heads seen as one:
    // let the single heads at the neighbouring positions win.
    let tall = Math.max(0, H / D - 1.3) * 1.5;
    // Centred on a line with a hole a space above and below: two heads.
    if (k % 2 === 0 && H > 1.2 * D && holeAt(cx, posY(staff, cx, k - 1)) && holeAt(cx, posY(staff, cx, k + 1))) tall += 0.4;
    return { x: (L + R) / 2, y, k, L, R, filled: false, score: 0.9 - centerErr - tall };
  }

  // Longest vertical ink run through rows near y, measured from y in one direction.
  function verticalReach(ctx, xa, xb, y, dir, maxLen) {
    let best = 0, bestX = Math.round((xa + xb) / 2);
    // A thin stem crossing a staff line can lose a few pixels when the line
    // is erased: bridge breaks of up to a line's thickness.
    const maxGap = Math.max(1, Math.round(0.15 * ctx.D), ctx.T + 2);
    const maxDrift = Math.max(1, Math.round(0.25 * ctx.D));
    const minStraight = Math.round(0.4 * ctx.D);
    for (let x = Math.round(xa); x <= Math.round(xb); x++) {
      // Start at the first inked pixel within 0.3 spaces of y.
      let yy = Math.round(y);
      let found = false;
      for (let d = 0; d <= ctx.D * 0.35; d++) {
        if (px(ctx, x, yy - dir * d)) { yy = yy - dir * d; found = true; break; }
      }
      if (!found) continue;
      let len = 0, gap = 0;
      let cur = yy, cx = x, straight = 0, stepDir = 0;
      while (len < maxLen) {
        const nxt = cur + dir;
        if (px(ctx, cx, nxt) || px(ctx, cx - 1, nxt) && px(ctx, cx + 1, nxt)) { cur = nxt; len += 1 + gap; gap = 0; straight++; continue; }
        // A stem leaning a little in a photo steps sideways now and then,
        // always the same way (a curve bends more often).
        const canStep = sd => straight >= minStraight && (!stepDir || stepDir === sd) && Math.abs(cx + sd - x) <= maxDrift && px(ctx, cx + sd, nxt);
        const sd = canStep(-1) ? -1 : canStep(1) ? 1 : 0;
        if (sd) { cx += sd; stepDir = sd; cur = nxt; len++; straight = 0; continue; }
        // Bridge a short break (a faint stem in a photo).
        let jump = 0;
        let jdx = 0;
        for (let g = 1; g <= maxGap && !jump; g++) {
          for (const dx of [0, -1, 1]) {
            if (Math.abs(cx + dx - x) <= maxDrift && px(ctx, cx + dx, nxt + g * dir)) { jump = g; jdx = dx; break; }
          }
        }
        if (!jump) break;
        cx += jdx;
        cur = nxt + jump * dir; len += 1 + jump; gap = 0;
      }
      const reach = Math.abs(cur - y);
      if (reach > best) { best = reach; bestX = x; }
    }
    return { length: best, x: bestX };
  }

  function attachStem(ctx, staff, note, heads = []) {
    const { D } = ctx;
    const maxLen = 9 * D;
    const upRight = verticalReach(ctx, note.R - 0.4 * D, note.R + 0.15 * D, note.y, -1, maxLen);
    const downLeft = verticalReach(ctx, note.L - 0.15 * D, note.L + 0.4 * D, note.y, 1, maxLen);
    const upLeft = verticalReach(ctx, note.L - 0.15 * D, note.L + 0.3 * D, note.y, -1, maxLen);
    const downRight = verticalReach(ctx, note.R - 0.3 * D, note.R + 0.15 * D, note.y, 1, maxLen);
    const stemMin = 2.0 * D;
    const shortMax = 1.05 * D;
    note.valid = false;
    dbg('stem', Math.round(note.x), note.k, note.filled ? 'filled' : 'hollow', 'upR', (upRight.length / D).toFixed(2), 'downL', (downLeft.length / D).toFixed(2), 'upL', (upLeft.length / D).toFixed(2), 'downR', (downRight.length / D).toFixed(2), 'W', ((note.R - note.L) / D).toFixed(2));
    const side = 1.35 * D;
    // In a chord the stem runs on past this head to the next one: a reach
    // that ends at another head on the same stem side is not a stray line.
    const chordReach = (reach, dir) => reach.length >= side && heads.some(o => o !== note &&
      Math.abs(o.x - note.x) < 0.6 * D && Math.abs(o.y - (note.y + dir * reach.length)) < 1.0 * D && (o.y - note.y) * dir > 0.8 * D);
    const upLeftOk = upLeft.length < side || chordReach(upLeft, -1);
    const downRightOk = downRight.length < side || chordReach(downRight, 1);
    if (upRight.length >= stemMin && upRight.length >= downLeft.length && (upLeft.length < Math.max(side, upRight.length * 0.5)) && downRightOk) {
      note.stem = { dir: -1, x: upRight.x, tip: note.y - upRight.length, length: upRight.length };
      note.valid = true;
    } else if (downLeft.length >= stemMin && upLeftOk && (upRight.length < side || chordReach(upRight, -1))) {
      note.stem = { dir: 1, x: downLeft.x, tip: note.y + downLeft.length, length: downLeft.length };
      note.valid = true;
    } else if (!note.filled && Math.max(upRight.length, downLeft.length, upLeft.length, downRight.length) < 1.2 * D && note.R - note.L >= 1.2 * D) {
      note.stem = null;
      note.valid = true; // whole note
    }
  }

  // A real notehead never sits at the far end of another note's stem: a
  // "head" there is the corner where a beam or flag meets the stem.
  function dropStemTipBlobs(ctx, heads) {
    const { D } = ctx;
    for (const g of heads) {
      if (!g.valid || !g.stem) continue;
      for (const h of heads) {
        if (h === g || !h.valid) continue;
        if (Math.abs(h.y - g.stem.tip) > 0.9 * D) continue;
        if (g.stem.x < h.L - 0.3 * D || g.stem.x > h.R + 0.3 * D) continue;
        dbg('stem-tip blob', Math.round(h.x), h.k, 'on stem of', Math.round(g.x), g.k);
        h.valid = false;
      }
    }
  }

  function countThickRuns(ctx, x, yFrom, yTo, labelsOk) {
    const { D } = ctx;
    const step = yTo > yFrom ? 1 : -1;
    let runs = 0, len = 0, longest = 0, joined = false;
    const lengths = [];
    // With labelsOk, a run counts only if it belongs to the stem's own
    // component (a flag or beam), not a fingering digit or a slur nearby.
    const isOk = (xx, y) => !labelsOk || labelsOk.has(ctx.labels[y * ctx.w + xx]);
    const close = () => {
      if (len >= 0.28 * D && joined) { runs++; lengths.push(len); }
      longest = Math.max(longest, len);
      len = 0; joined = false;
    };
    for (let y = Math.round(yFrom); step > 0 ? y <= yTo : y >= yTo; y += step) {
      const ink = px(ctx, x, y) || px(ctx, x - 1, y) && px(ctx, x + 1, y);
      if (ink) { len++; if (isOk(x, y) || isOk(x - 1, y) || isOk(x + 1, y)) joined = true; continue; }
      close();
    }
    close();
    return { runs, lengths };
  }

  // Mean gray value in a box (0 = black).
  function meanGray(ctx, x0, y0, x1, y1) {
    let sum = 0, n = 0;
    for (let y = Math.round(y0); y <= Math.round(y1); y++) for (let x = Math.round(x0); x <= Math.round(x1); x++) {
      if (x < 0 || y < 0 || x >= ctx.w || y >= ctx.h) continue;
      sum += ctx.gray[y * ctx.w + x]; n++;
    }
    return n ? sum / n : 255;
  }

  // Blur can fill the small hole of a half note. Its middle still stays
  // lighter than the ring around it; a solid head is evenly dark.
  function hollowness(ctx, note) {
    const { D } = ctx;
    const cx = note.x, cy = note.y;
    // Sample just above and below the centre, clear of a line through it.
    const up = meanGray(ctx, cx - 0.12 * D, cy - 0.3 * D, cx + 0.12 * D, cy - 0.14 * D);
    const down = meanGray(ctx, cx - 0.12 * D, cy + 0.14 * D, cx + 0.12 * D, cy + 0.3 * D);
    const ring = Math.min(
      meanGray(ctx, note.L + 0.05 * D, cy - 0.12 * D, note.L + 0.25 * D, cy + 0.12 * D),
      meanGray(ctx, note.R - 0.25 * D, cy - 0.12 * D, note.R - 0.05 * D, cy + 0.12 * D));
    // A hole is darker again further out (the rim). Shading on a solid
    // head in a photo only gets lighter toward the edge.
    const rimUp = meanGray(ctx, cx - 0.12 * D, cy - 0.52 * D, cx + 0.12 * D, cy - 0.4 * D);
    const rimDown = meanGray(ctx, cx - 0.12 * D, cy + 0.4 * D, cx + 0.12 * D, cy + 0.52 * D);
    const score = Math.max(up > rimUp - 12 ? up - ring : 0, down > rimDown - 12 ? down - ring : 0);
    dbg('hollowness', Math.round(cx), note.k, 'up', up.toFixed(0), 'down', down.toFixed(0), 'ring', ring.toFixed(0), 'rim', rimUp.toFixed(0), rimDown.toFixed(0));
    return score;
  }

  function readDuration(ctx, staff, note) {
    const { D } = ctx;
    if (note.filled && note.stem && hollowness(ctx, note) > 25) note.filled = false;
    if (!note.stem) { note.beats = 4; note.base = 'whole'; return; }
    if (!note.filled) { note.beats = 2; note.base = 'half'; return; }
    const s = note.stem;
    // Stem center column at mid-stem.
    const midY = Math.round((note.y + s.tip) / 2);
    let a = s.x, b = s.x;
    while (px(ctx, a - 1, midY) && a > s.x - D) a--;
    while (px(ctx, b + 1, midY) && b < s.x + D) b++;
    const sx = (a + b) / 2;
    const stemHalf = (b - a + 1) / 2;
    const span = Math.min(2.6 * D, s.length - 1.1 * D);
    const yFrom = s.tip + s.dir * 0.35 * D; // a bit beyond the tip
    const yTo = s.tip - s.dir * span; // toward the head
    // Count beams/flags close to the stem; further out a curved flag can be
    // cut twice, so look there only when nothing was found nearby.
    // Components the stem is made of (staff-line removal may cut it).
    const stemLabels = new Set();
    for (let y = Math.round(Math.min(note.y, s.tip)); y <= Math.round(Math.max(note.y, s.tip)); y++) {
      for (let x = Math.round(sx - stemHalf - 1); x <= Math.round(sx + stemHalf + 1); x++) {
        if (x >= 0 && x < ctx.w && y >= 0 && y < ctx.h) { const id = ctx.labels[y * ctx.w + x]; if (id) stemLabels.add(id); }
      }
    }
    let count = 0;
    for (const off of [0.4, 0.75]) {
      for (const side of [-1, 1]) {
        const x = Math.round(sx + side * (stemHalf + off * D));
        const r = countThickRuns(ctx, x, yFrom, yTo, stemLabels);
        let n = 0;
        for (const len of r.lengths) n += len > 1.15 * D ? Math.round(len / (0.75 * D)) : 1;
        count = Math.max(count, n);
      }
      if (count) break;
    }
    count = Math.min(3, count);
    note.beams = count;
    note.beats = 1 / Math.pow(2, count);
    note.base = ['quarter', 'eighth', '16th', '32nd'][count];
  }

  function markNoteComponents(ctx, note) {
    const { labels, comps, w } = ctx;
    const ids = new Set();
    const add = (x, y) => {
      x = Math.round(x); y = Math.round(y);
      if (x < 0 || y < 0 || x >= w || y >= ctx.h) return;
      const id = labels[y * w + x];
      if (id) ids.add(id);
    };
    add(note.x, note.y);
    add(note.L + 1, note.y); add(note.R - 1, note.y);
    if (note.stem) {
      add(note.stem.x, (note.y + note.stem.tip) / 2);
    }
    for (const id of ids) comps[id].role = comps[id].role || 'note';
    note.componentIds = [...ids];
  }

  function findDot(ctx, staff, note) {
    const { comps, D } = ctx;
    // On a line, the dot sits in the space above.
    const dotY = note.k % 2 === 0 ? note.y - 0.5 * D : note.y;
    for (let i = 1; i < comps.length; i++) {
      const c = comps[i];
      if (c.role && c.role !== 'dot-candidate') continue;
      if (c.w < 0.2 * D || c.w > 0.75 * D || c.h < 0.2 * D || c.h > 0.75 * D) continue;
      if (c.area < 0.55 * c.w * c.h) continue;
      if (c.cx < note.R + 0.1 * D || c.cx > note.R + 1.6 * D) continue;
      if (Math.abs(c.cy - dotY) > 0.4 * D && Math.abs(c.cy - note.y) > 0.25 * D) continue;
      note.dots = 1;
      c.role = 'dot';
      // A second dot right after the first.
      for (let j = 1; j < comps.length; j++) {
        const d = comps[j];
        if (d.role || d === c) continue;
        if (Math.abs(d.w - c.w) > 0.2 * D || Math.abs(d.h - c.h) > 0.2 * D) continue;
        if (d.cx > c.cx + 0.3 * D && d.cx < c.cx + 1.0 * D && Math.abs(d.cy - c.cy) < 0.2 * D) {
          note.dots = 2; d.role = 'dot';
        }
      }
      return;
    }
    note.dots = 0;
  }

  function componentFeatures(ctx, c) {
    const { labels, w, D } = ctx;
    // Long vertical strokes inside this component.
    const cols = [];
    for (let x = c.minX; x <= c.maxX; x++) {
      let best = 0, run = 0, bestTop = 0, bestBottom = 0, runTop = 0;
      for (let y = c.minY; y <= c.maxY; y++) {
        if (labels[y * w + x] === c.id) {
          if (!run) runTop = y;
          run++;
          if (run > best) { best = run; bestTop = runTop; bestBottom = y; }
        } else run = 0;
      }
      cols.push({ x, best, top: bestTop, bottom: bestBottom });
    }
    const verticals = [];
    let cur = null;
    for (const col of cols) {
      if (col.best >= 0.55 * c.h && col.best >= 1.2 * D) {
        if (cur && col.x === cur.x1 + 1) { cur.x1 = col.x; cur.top = Math.min(cur.top, col.top); cur.bottom = Math.max(cur.bottom, col.bottom); }
        else { cur = { x0: col.x, x1: col.x, top: col.top, bottom: col.bottom }; verticals.push(cur); }
      } else cur = null;
    }
    const region = (fx0, fy0, fx1, fy1) => {
      let n = 0, t = 0;
      const xa = Math.round(c.minX + fx0 * c.w), xb = Math.round(c.minX + fx1 * c.w);
      const ya = Math.round(c.minY + fy0 * c.h), yb = Math.round(c.minY + fy1 * c.h);
      for (let y = ya; y < Math.max(ya + 1, yb); y++) for (let x = xa; x < Math.max(xa + 1, xb); x++) {
        t++; if (labels[y * w + x] === c.id) n++;
      }
      return t ? n / t : 0;
    };
    const maxColumnRun = cols.reduce((m, col) => Math.max(m, col.best), 0);
    return { verticals, region, fill: c.area / (c.w * c.h), maxColumnRun };
  }

  function classifyAccidental(ctx, c) {
    const { D } = ctx;
    const wD = c.w / D, hD = c.h / D;
    if (hD < 1.4 || hD > 3.8 || wD < 0.35 || wD > 1.6) return null;
    const f = componentFeatures(ctx, c);
    const v = f.verticals;
    if (v.length === 1) {
      const vx = (v[0].x0 + v[0].x1) / 2;
      const rel = (vx - c.minX) / c.w;
      // A flat's stem runs (nearly) its full height; a slanted quarter
      // rest in a photo can show a shorter straight piece.
      if (rel < 0.4 && wD < 1.25 && hD < 3.3 && v[0].bottom - v[0].top + 1 >= 0.8 * c.h) {
        const lower = f.region(0.35, 0.6, 1, 1);
        const upper = f.region(0.35, 0, 1, 0.4);
        if (lower > upper + 0.1) return { type: 'flat', anchor: c.maxY - 0.5 * D };
      }
      return null;
    }
    // Two separate strokes (not one slanted stroke split in two).
    if (v.length === 2 && v[1].x0 - v[0].x1 >= Math.max(3, 0.12 * D)) {
      const topRight = f.region(0.55, 0, 1, 0.18);
      const bottomLeft = f.region(0, 0.82, 0.45, 1);
      const topLeft = f.region(0, 0, 0.45, 0.18);
      const bottomRight = f.region(0.55, 0.82, 1, 1);
      if (topRight < 0.12 && bottomLeft < 0.12 && topLeft > 0.12 && bottomRight > 0.12) {
        return { type: 'natural', anchor: (c.minY + c.maxY) / 2 };
      }
      if (wD >= 0.55) return { type: 'sharp', anchor: (c.minY + c.maxY) / 2 };
    }
    return null;
  }

  function findAccidental(ctx, staff, note) {
    const { comps, D } = ctx;
    let best = null, bestScore = Infinity;
    for (let i = 1; i < comps.length; i++) {
      const c = comps[i];
      if (c.role && c.role !== 'accidental') continue;
      if (c.maxX > note.L - 0.03 * D || c.maxX < note.L - 1.9 * D) continue;
      if (c.minY > note.y + 1.6 * D || c.maxY < note.y - 2.2 * D) continue;
      const acc = c.accidental !== undefined ? c.accidental : (c.accidental = classifyAccidental(ctx, c));
      if (!acc) continue;
      const dy = Math.abs(acc.anchor - note.y);
      if (dy > 0.5 * D) continue;
      const score = dy + (note.L - c.maxX) * 0.2;
      if (score < bestScore) { bestScore = score; best = { c, acc }; }
    }
    if (best) {
      note.accidental = best.acc.type;
      best.c.role = 'accidental';
    }
  }

  // ---------- header: clef, key signature, time signature ----------

  function readHeader(ctx, staff, heads, fallbackClef, options) {
    const { comps, D } = ctx;
    const top = posY(staff, staff.left, 0), bottom = posY(staff, staff.left, 8);
    const near = [];
    for (let i = 1; i < comps.length; i++) {
      const c = comps[i];
      if (c.maxX < staff.left - D || c.minX > staff.right) continue;
      if (c.maxY < top - 4 * D || c.minY > bottom + 4 * D) continue;
      const cy = (c.minY + c.maxY) / 2;
      if (cy < top - 3 * D || cy > bottom + 3 * D) continue;
      near.push(c);
    }
    near.sort((a, b) => a.minX - b.minX);
    let x = staff.left;
    // Skip a brace, bracket or system barline at the very start: they are
    // narrow and reach well beyond this staff (into the other hand's staff).
    let idx = 0;
    for (const c of near) {
      if (c.minX > x + 1.2 * D) break;
      const systemMark = c.h > 5.5 * D && c.w < 1.8 * D;
      const startLine = c.minX < staff.left + 0.8 * D && c.w < 0.8 * D;
      if (!systemMark && !startLine) continue;
      c.role = 'barline';
      x = Math.max(x, c.maxX);
    }
    while (idx < near.length && near[idx].role === 'barline') idx++;
    // Clef: union of components that start within ~3.5 spaces of the staff start.
    let clefBox = null;
    const clefParts = [];
    for (let i = idx; i < near.length; i++) {
      const c = near[i];
      if (c.role === 'barline' || c.maxX <= x) continue;
      if (c.minX > x + 3.5 * D) break;
      if (c.area < 0.05 * D * D || c.w > 4.5 * D) continue;
      if (!clefBox) {
        if (c.h < 1.5 * D) continue;
        clefBox = { minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY };
      } else if (c.minX <= clefBox.maxX + 0.25 * D) {
        clefBox.minX = Math.min(clefBox.minX, c.minX); clefBox.maxX = Math.max(clefBox.maxX, c.maxX);
        clefBox.minY = Math.min(clefBox.minY, c.minY); clefBox.maxY = Math.max(clefBox.maxY, c.maxY);
      } else continue;
      clefParts.push(c);
    }
    dbg('clef parts', clefParts.map(c => [c.minX, c.minY, c.maxX, c.maxY].join(',')).join(' | '), 'near', near.slice(0, 6).map(c => [c.minX, c.minY, c.maxX, c.maxY, c.role].join(',')).join(' | '));
    let clef = fallbackClef;
    let end = staff.left;
    if (clefBox) {
      const topRel = (clefBox.minY - top) / D;
      const botRel = (clefBox.maxY - bottom) / D;
      let detected = null;
      if (topRel < -0.8 && botRel > 0.5) detected = 'treble';
      else if (topRel > -0.6 && topRel < 0.5 && botRel < -0.35) detected = 'bass';
      else if (Math.abs(topRel) < 0.6 && Math.abs(botRel) < 0.35) detected = 'alto';
      // Two dots in the spaces around the F line mean a bass clef.
      const dotsRight = clefParts.concat(near).filter(c => c.minX > clefBox.minX + 0.5 * (clefBox.maxX - clefBox.minX) && c.w < 0.7 * D && c.h < 0.7 * D && c.minX < clefBox.maxX + 1.0 * D);
      const k1 = posY(staff, clefBox.maxX, 1), k3 = posY(staff, clefBox.maxX, 3);
      if (dotsRight.some(c => Math.abs(c.cy - k1) < 0.35 * D) && dotsRight.some(c => Math.abs(c.cy - k3) < 0.35 * D)) detected = 'bass';
      else if (topRel < -0.6 && botRel < -0.6 && botRel > -1.6) detected = 'tenor';
      if (detected) {
        clef = detected;
        for (const c of clefParts) c.role = 'clef';
        end = clefBox.maxX;
        // Bass clef dots.
        if (detected === 'bass') {
          for (const c of near) {
            if (!c.role && c.minX > clefBox.maxX - 0.2 * D && c.minX < clefBox.maxX + 1.0 * D && c.w < 0.6 * D && c.h < 0.6 * D) {
              c.role = 'clef'; end = Math.max(end, c.maxX);
            }
          }
        }
      }
    }
    if (options.clef && options.clef !== 'auto') clef = options.clef;
    // Key signature: a run of sharps or flats, not attached to a following note.
    let keyType = null, keyCount = 0;
    // A "hollow head" inside a staff-high glyph is a loop of a time
    // signature digit, not a note that the accidental belongs to.
    const inDigits = hd => !hd.filled && near.some(c => Math.abs(c.minY - top) < 0.35 * D && Math.abs(c.maxY - bottom) < 0.35 * D &&
      c.w > 0.8 * D && c.w < 2.6 * D && hd.x > c.minX && hd.x < c.maxX);
    const headAt = (c, anchor) => heads.some(hd => hd.L > c.maxX - 0.1 * D && hd.L < c.maxX + 1.4 * D && Math.abs(hd.y - anchor) < 0.5 * D && !inDigits(hd));
    for (const c of near) {
      if (c.role || c.minX <= end - 0.1 * D) continue;
      if (c.minX > end + 1.8 * D) break;
      if (c.area < 0.05 * D * D) continue;
      const acc = classifyAccidental(ctx, c);
      c.accidental = acc;
      if (!acc || acc.type === 'natural') break;
      if (keyType && acc.type !== keyType) break;
      if (headAt(c, acc.anchor)) break;
      keyType = acc.type;
      keyCount++;
      c.role = 'key';
      end = c.maxX;
      if (keyCount === 7) break;
    }
    // Time signature: stacked digits (or a C) right after the key.
    let time = null;
    const hasHead = c => heads.some(hd => hd.stem && hd.x > c.minX - 0.2 * D && hd.x < c.maxX + 0.2 * D && hd.y > c.minY && hd.y < c.maxY);
    // Two digits merged into one staff-high blob can look like a stemmed
    // head (the 4's stroke), so they skip the head guard.
    const mergedDigits = c => Math.abs(c.minY - top) < 0.35 * D && Math.abs(c.maxY - bottom) < 0.35 * D && c.w > 0.8 * D && c.w < 2.6 * D && c.area < 0.75 * c.w * c.h;
    const cand = near.filter(c => !c.role && c.minX > end - 0.1 * D && c.minX < end + 2.5 * D && c.area > 0.1 * D * D && (!hasHead(c) || (mergedDigits(c) && !heads.some(hd => hd.filled && hd.x > c.minX && hd.x < c.maxX && hd.y > c.minY && hd.y < c.maxY))));
    dbg('header end', Math.round(end), 'cands', cand.map(c => [c.minX, c.minY, c.maxX, c.maxY, c.role].join(',')).join(' | '), 'top', Math.round(top), 'bottom', Math.round(bottom));
    const upperHalf = cand.filter(c => c.minY > top - 0.6 * D && c.maxY < top + 2.4 * D && c.h > 1.2 * D);
    const lowerHalf = cand.filter(c => c.minY > top + 1.6 * D && c.maxY < bottom + 0.6 * D && c.h > 1.2 * D);
    const pairs = [];
    for (const u of upperHalf) for (const l of lowerHalf) {
      const overlap = Math.min(u.maxX, l.maxX) - Math.max(u.minX, l.minX);
      if (overlap > 0.3 * Math.min(u.w, l.w)) pairs.push([u, l]);
    }
    if (pairs.length) {
      const gx0 = Math.min(...pairs.map(p => Math.min(p[0].minX, p[1].minX))) - 0.3 * D;
      const gx1 = Math.max(...pairs.map(p => Math.max(p[0].maxX, p[1].maxX))) + 0.3 * D;
      const group = cand.filter(c => c.minX >= gx0 && c.maxX <= gx1 && c.minY > top - 0.6 * D && c.maxY < bottom + 0.6 * D);
      for (const c of group) { c.role = 'time'; end = Math.max(end, c.maxX); }
      time = 'digits';
    } else if (cand.some(c => Math.abs(c.minY - top) < 0.35 * D && Math.abs(c.maxY - bottom) < 0.35 * D && c.w > 0.8 * D && c.w < 2.6 * D && c.area < 0.75 * c.w * c.h)) {
      // Two digits touching each other form one component spanning the staff.
      const c = cand.find(c => Math.abs(c.minY - top) < 0.35 * D && Math.abs(c.maxY - bottom) < 0.35 * D && c.w > 0.8 * D && c.w < 2.6 * D && c.area < 0.75 * c.w * c.h);
      c.role = 'time'; end = Math.max(end, c.maxX); time = 'digits';
    } else {
      const c = cand.find(c => c.h > 1.5 * D && c.h < 3.4 * D && c.w > 0.9 * D && c.w < 2.4 * D &&
        Math.abs((c.minY + c.maxY) / 2 - (top + bottom) / 2) < 0.5 * D &&
        !heads.some(hd => hd.x > c.minX && hd.x < c.maxX));
      if (c) { c.role = 'time'; end = Math.max(end, c.maxX); time = 'C'; }
    }
    return { clef, key: { type: keyType, count: keyCount }, time, end: end + 0.2 * D };
  }

  // ---------- barlines and rests ----------

  function findBarlines(ctx, staff, headerEnd, heads = []) {
    const { comps, D } = ctx;
    const bars = [];
    const nearTopFor = (y, x) => Math.abs(y - posY(staff, x, 0)) <= 0.6 * D || (ctx.staves || []).some(o => o !== staff && Math.abs(y - posY(o, x, 0)) <= 0.6 * D && y < posY(staff, x, 0));
    const nearBottomFor = (y, x) => Math.abs(y - posY(staff, x, 8)) <= 0.6 * D || (ctx.staves || []).some(o => o !== staff && Math.abs(y - posY(o, x, 8)) <= 0.6 * D && y > posY(staff, x, 8));
    for (let i = 1; i < comps.length; i++) {
      const c = comps[i];
      if (c.role && c.role !== 'barline') continue;
      if (c.minX < headerEnd || c.maxX > staff.right + D) continue;
      if (c.w > 0.9 * D) continue;
      const top = posY(staff, c.cx, 0), bottom = posY(staff, c.cx, 8);
      if (c.h > 3 * D) dbg('bar?', c.minX, c.minY, c.maxX, c.maxY, 'top', Math.round(top), 'bottom', Math.round(bottom), 'fill', (c.area / (c.w * c.h)).toFixed(2), c.role);
      // A barline spans this staff; in a grand staff it may run on through
      // the other staff of the system, ending on that staff's outer line.
      const nearTop = y => Math.abs(y - top) <= 0.6 * D || (ctx.staves || []).some(o => o !== staff && Math.abs(y - posY(o, c.cx, 0)) <= 0.6 * D && y < top);
      const nearBottom = y => Math.abs(y - bottom) <= 0.6 * D || (ctx.staves || []).some(o => o !== staff && Math.abs(y - posY(o, c.cx, 8)) <= 0.6 * D && y > bottom);
      if (!nearTop(c.minY) || !nearBottom(c.maxY)) continue;
      let solid = false;
      for (let x = c.minX; x <= c.maxX && !solid; x++) {
        let n = 0;
        for (let y = c.minY; y <= c.maxY; y++) if (ctx.labels[y * ctx.w + x] === c.id) n++;
        if (n >= 0.92 * c.h) solid = true;
      }
      if (!solid) continue;
      c.role = 'barline';
      bars.push(c.cx);
    }
    // In a photo a barline may lean or bend a little, or touch a slur or a
    // head, so it is not always one straight component. Trace thin vertical
    // strokes column by column as well.
    const { bin, w } = ctx;
    const ink = (x, y) => x >= 0 && x < w && y >= 0 && y < ctx.h && bin[y * w + x];
    const trace = (x, y, dir) => {
      let cx = x, cy = y, gap = 0;
      for (;;) {
        const ny = cy + dir;
        if (ink(cx, ny)) { cy = ny; gap = 0; continue; }
        if (ink(cx - 1, ny)) { cx--; cy = ny; gap = 0; continue; }
        if (ink(cx + 1, ny)) { cx++; cy = ny; gap = 0; continue; }
        if (gap < 2 && (ink(cx, ny + dir) || ink(cx, ny + 2 * dir))) { cy = ny; gap++; continue; }
        return { y: cy, x: cx };
      }
    };
    const runWidth = (x, y) => {
      let a = x, b = x;
      while (ink(a - 1, y) && x - a < 2 * D) a--;
      while (ink(b + 1, y) && b - x < 2 * D) b++;
      return b - a + 1;
    };
    const cols = [];
    for (let x = Math.round(headerEnd + 0.5 * D); x <= Math.min(w - 2, staff.right + 0.5 * D); x++) {
      const ym = Math.round(posY(staff, x, 4));
      if (!ink(x, ym)) continue;
      const up = trace(x, ym, -1), down = trace(x, ym, 1);
      if (!nearTopFor(up.y, x) || !nearBottomFor(down.y, x)) continue;
      // Straight: a flag or a slur curves.
      // (A photo taken at an angle leans a barline a few degrees.)
      // Only a long (system-wide) line is trusted to lean; within one staff
      // a leaning stroke is more often a stem whose head was missed.
      const lean = Math.abs(down.x - up.x);
      if (down.y - up.y > 6 * D ? lean > 0.1 * (down.y - up.y) + 2 : (Math.abs(up.x - x) > 0.2 * D || Math.abs(down.x - x) > 0.2 * D)) continue;
      let straight = true;
      for (let k = 1; k <= 7 && straight; k += 2) {
        const yy = Math.round(posY(staff, x, k));
        const lx = Math.round(up.x + (down.x - up.x) * (yy - up.y) / Math.max(1, down.y - up.y));
        if (!ink(lx, yy) && !ink(lx - 1, yy) && !ink(lx + 1, yy)) straight = false;
      }
      if (!straight) continue;
      // Thin all along (skip the rows of staff lines).
      let thin = 0, all = 0;
      for (let k = 1; k <= 7; k += 2) {
        const yy = Math.round(posY(staff, x, k));
        all++;
        if (runWidth(x, yy) <= 0.5 * D) thin++;
      }
      if (thin < all) continue;
      // Not a stem of one of this staff's notes.
      const stem = heads.some(hd => x >= hd.L - 0.3 * D && x <= hd.R + 0.3 * D && hd.y > up.y - 0.8 * D && hd.y < down.y + 0.8 * D);
      if (stem) continue;
      // Nor a flag or stem joined to a notehead.
      let joined = false;
      for (let k = 1; k <= 7 && !joined; k += 2) {
        const yy = Math.round(posY(staff, x, k));
        for (let dx = -1; dx <= 1 && !joined; dx++) {
          const id = ctx.labels[yy * w + x + dx];
          if (id && comps[id].role === 'note') joined = true;
        }
      }
      if (joined) continue;
      cols.push(x);
    }
    for (let i = 0; i < cols.length;) {
      let j = i;
      while (j + 1 < cols.length && cols[j + 1] - cols[j] <= 2) j++;
      if (cols[j] - cols[i] <= 0.6 * D) bars.push((cols[i] + cols[j]) / 2);
      i = j + 1;
    }
    bars.sort((a, b) => a - b);
    const merged = [];
    for (const b of bars) if (!merged.length || b - merged[merged.length - 1] > 1.5 * D) merged.push(b);
    return merged;
  }

  function findRests(ctx, staff, headerEnd) {
    const { comps, D } = ctx;
    const rests = [];
    for (let i = 1; i < comps.length; i++) {
      const c = comps[i];
      if (c.role) continue;
      if (c.minX < headerEnd || c.maxX > staff.right + 0.5 * D) continue;
      const top = posY(staff, c.cx, 0), bottom = posY(staff, c.cx, 8);
      if (c.minY < top - 1.6 * D || c.maxY > bottom + 1.6 * D) continue;
      const wD = c.w / D, hD = c.h / D, fillRatio = c.area / (c.w * c.h);
      dbg('restcomp', c.minX, c.minY, c.maxX, c.maxY, 'h', hD.toFixed(2), 'w', wD.toFixed(2));
      let rest = null;
      if (fillRatio > 0.75 && wD > 0.7 && wD < 1.9 && hD > 0.3 && hD < 0.85) {
        const line1 = posY(staff, c.cx, 2), line2 = posY(staff, c.cx, 4);
        if (Math.abs(c.minY - line1) < 0.35 * D) rest = { beats: 4, base: 'whole', whole: true };
        else if (Math.abs(c.maxY - line2) < 0.35 * D) rest = { beats: 2, base: 'half' };
      } else if (wD > 0.5 && wD < 1.5 && hD > 1.1 && hD < 3.6) {
        const f = componentFeatures(ctx, c);
        const longVertical = (f.maxColumnRun >= 0.85 * c.h && wD < 0.75) || !!classifyAccidental(ctx, c);
        dbg('restfeat', c.minX, 'maxCol', (f.maxColumnRun / c.h).toFixed(2), 'cy', ((c.minY + c.maxY) / 2 - (top + bottom) / 2).toFixed(1));
        if (longVertical) continue;
        const cy = (c.minY + c.maxY) / 2;
        if (Math.abs(cy - (top + bottom) / 2) > 1.6 * D) continue;
        const blobs = countLeftBlobs(ctx, c);
        const shape = restShape(ctx, c);
        dbg('rest?', Math.round(c.cx), 'h', hD.toFixed(2), 'w', wD.toFixed(2), 'fill', fillRatio.toFixed(2), 'blobs', blobs, 'bottomInk', shape.bottomInk.toFixed(2), 'resid', shape.residual.toFixed(2));
        // A flag rest has a round blob on its head; a slur end or a
        // stray thin stroke does not.
        if (shape.bottomInk < 0.32 && shape.residual < 0.1 && blobs >= 1) {
          const flags = Math.max(1, Math.min(3, Math.max(blobs, hD < 2.25 ? 1 : hD < 3.3 ? 2 : 3)));
          rest = { beats: 1 / Math.pow(2, flags), base: ['eighth', '16th', '32nd'][flags - 1] };
        } else if (hD >= 2.1) {
          rest = { beats: 1, base: 'quarter' };
        }
      }
      if (rest) {
        c.role = 'rest';
        // A dotted rest (6/8 music): a small round dot just to its right,
        // inside the staff.
        if (!rest.whole) {
          for (let j = 1; j < comps.length; j++) {
            const d = comps[j];
            if (d.role || d === c) continue;
            if (d.w < 0.2 * D || d.w > 0.7 * D || d.h < 0.2 * D || d.h > 0.7 * D || d.area < 0.55 * d.w * d.h) continue;
            if (d.minX < c.maxX + 0.05 * D || d.minX > c.maxX + 0.9 * D) continue;
            if (d.cy < posY(staff, d.cx, 1) - 0.3 * D || d.cy > posY(staff, d.cx, 7) + 0.3 * D) continue;
            rest.beats *= 1.5; rest.dots = 1; d.role = 'dot';
            break;
          }
        }
        rests.push(Object.assign(rest, { x: c.cx, y: c.cy, box: c }));
      }
    }
    return rests;
  }

  // Flag-style rests (8th, 16th) end in a thin straight diagonal; the
  // quarter rest's lower part is a thick zigzag/hook.
  function restShape(ctx, c) {
    const { labels, w, D } = ctx;
    const rows = [];
    for (let y = c.minY; y <= c.maxY; y++) {
      let ink = 0, right = -1;
      for (let x = c.minX; x <= c.maxX; x++) if (labels[y * w + x] === c.id) { ink++; right = x; }
      rows.push({ y, ink, right });
    }
    const lower = rows.slice(Math.floor(rows.length * 0.6)).filter(r => r.right >= 0);
    const bottomInk = lower.reduce((s, r) => s + r.ink, 0) / Math.max(1, lower.length) / D;
    // Straightness of the right edge over the lower 70% (a diagonal is linear).
    const part = rows.slice(Math.floor(rows.length * 0.3)).filter(r => r.right >= 0);
    let residual = 0;
    if (part.length > 3) {
      const n = part.length;
      const my = part.reduce((s, r) => s + r.y, 0) / n, mx = part.reduce((s, r) => s + r.right, 0) / n;
      let sxy = 0, syy = 0;
      for (const r of part) { sxy += (r.y - my) * (r.right - mx); syy += (r.y - my) * (r.y - my); }
      const slope = syy ? sxy / syy : 0;
      for (const r of part) residual += Math.abs(r.right - (mx + slope * (r.y - my)));
      residual = residual / n / D;
    }
    return { bottomInk, residual };
  }

  // Eighth/16th rests have round blobs on their left; count them.
  function countLeftBlobs(ctx, c) {
    const { labels, w, D } = ctx;
    const widths = [];
    for (let y = c.minY; y <= c.maxY; y++) {
      let run = 0, best = 0;
      for (let x = c.minX; x <= c.minX + Math.round(c.w * 0.7); x++) {
        if (labels[y * w + x] === c.id) { run++; best = Math.max(best, run); } else run = 0;
      }
      widths.push(best);
    }
    let blobs = 0, inBlob = false, blobRows = 0;
    for (const wd of widths) {
      if (wd >= 0.42 * D) { blobRows++; if (!inBlob && blobRows >= 0.25 * D) { blobs++; inBlob = true; } }
      else { inBlob = false; blobRows = 0; }
    }
    return blobs;
  }

  function fillWholeMeasureRests(events) {
    // A whole rest fills its measure: use the most common measure length.
    const measures = new Map();
    for (const e of events) {
      const key = e.staff + ':' + e.measure;
      if (!measures.has(key)) measures.set(key, []);
      measures.get(key).push(e);
    }
    const lengths = new Map();
    for (const list of measures.values()) {
      if (list.some(e => e.wholeRest)) continue;
      const total = list.reduce((s, e) => s + e.beats, 0);
      const r = Math.round(total * 4) / 4;
      lengths.set(r, (lengths.get(r) || 0) + 1);
    }
    let best = 4, bestN = 0;
    for (const [len, n] of lengths) if (n > bestN || (n === bestN && len > best)) { best = len; bestN = n; }
    for (const list of measures.values()) {
      if (list.length === 1 && list[0].wholeRest) list[0].beats = best;
    }
  }

  // ---------- tempo, repeats and endings ----------

  // Digit shapes (0-9) from common serif and sans fonts: aspect ratio and an
  // 8x12 grid of ink levels (hex). Used for tempo marks and ending numbers.
  const DIGIT_TEMPLATES = [
    [0, 0.63, "03baab200e5008e07e0002f7cc0000fcea0000defa0000dffa0000dfeb0000debc0000fb6e0002f60d7009c002bdda00"],
    [1, 0.538, "0019d00039cfd000500fd000000fd000000fd000000fd000000fd000000fd000000fd000000fd000000fd0009abffba8"],
    [2, 0.615, "7cddea30a5000bf3800004f9000003f9000005f600000bd000005f300005d300008b00000a900000cc666665fffffffe"],
    [3, 0.611, "7dbacb30a4000cf1600007f5000007f400001dc0009df80000014bd2000000fc000000dfb00000fde20008f5adddda20"],
    [4, 0.712, "00000d6000009f600005af60000c1f6000840f6004900f600d100f6094000f60feeeeffd88888fb700000f6000000f60"],
    [5, 0.604, "affffff0a8666660a3000000a3000000a30000008baacc70000005f8000000ed000000dfa00000fce10008f4adddea20"],
    [6, 0.648, "007babd109d000912f4000108e000000cc012100ddbbbfb0dc0002f8cc0000cd9e0000be4f2000cb0ba003f4009dcd40"],
    [7, 0.635, "effffffee66666c8800001e00000097000002e000000a6000002e00000096000001d00000088000002f100000a900000"],
    [8, 0.63, "06caac403f4006f38f0002f88f0002f82f4007f205fcdf302e6128e2cb0000ecfa0000cfea0000de7e2004f707dccc50"],
    [9, 0.63, "07caab208e1009e0fa0003f7f90000fbfa0000ed9e1000ee09ecb8ee000000fc000002f9200006f293003e706eddc500"],
    [0, 0.63, "03ceeb200ef22fe07fd00ef7cfb00cfcefa00bfeffa00bffffa00bffefa00bfebfb00cfb6fd00ef60df34fc002bffa00"],
    [1, 0.577, "002af7003bfff700848ff700008ff700008ff700008ff700008ff700008ff700008ff700008ff700008ff700cffffffd"],
    [2, 0.642, "4cffea207b108ff276000ff900000ff900001ff600008fc00004fd10002ed10003e910002e500000dffffffdeffffffe"],
    [3, 0.63, "6dddfb4098009ff284003ff700003ff60001afd000fffb0000238fe400000cfe30000afff1000cfee6006ff59dffea30"],
    [4, 0.731, "00005fd00000dfd00008efd0001e8fd000c77fd007c07fd00e207fd09a338fd2fffffffebbbbdffa00007fd000007fd0"],
    [5, 0.642, "4ffffff04ffffff04a0000004a0000004a2330004daaefa100001ffa00000bff30000bffe1000cfde7005ff49dfffb20"],
    [6, 0.648, "008edec10bf700e24ff100a1bfc00000ffa46400fffcefd1ff801ff9ff900cfdcfb00bfe6fe00cfb0cf52ff301aefc40"],
    [7, 0.635, "fffffffffffffffaf00003f360000bc000004f400000dd000004f600000be000003f700000cf100005fa00000ef40000"],
    [8, 0.63, "07dded606ff00ff6bfc00cfbbfc00dfb4ff22ff407ffff405fd22ef5ef800afeff7008ffff8009ff8fc11df807dffd60"],
    [9, 0.648, "06deec405ff12ff1cfc00df8ffa00bfcdfb00aff8ff109ff0bfdceff00132afe00000cfa76001ff47b10af904dffd600"],
    [0, 0.683, "01add9100ca00bc05f2002f5ae0000eadc0000cdeb0000beeb0000bedc0000cdae0000ea5f2002f50ca00bc001add910"],
    [1, 0.508, "006df1007e9ef100810df100000df100000df100000df100000df100000df100000df100000df100000df1008ccffdcb"],
    [2, 0.644, "4adcdb40d9000af5a10001fb000000fd000003f8000009e100003f300002d500002d500004e500084f73333eefffffff"],
    [3, 0.65, "39dcdc40ab0008f3840001f7000002f500003cb0005deb20000007f4000000dc000000aff00000cef80006f76bdcdc50"],
    [4, 0.763, "0000bf000004ff00000c8f0000586f0000d16f0008706f001e106f0097006f00ecccefcc00006f0000006f00000cefc8"],
    [5, 0.644, "8ffffff08733333084000000840000008bccda2067000af3000002fb000000ee000000eee00001fbf7000af36bdcda20"],
    [6, 0.683, "006ccec308c101d52f2000328d000000cb4bc920eec119f3ef2000ebdf0000bebf0000bf6f2000db0da006f401addc40"],
    [7, 0.655, "ffffffffe33333bbb00001f5000006e000000d6000004e000000a8000001f1000007b000000e4000005e000000d70000"],
    [8, 0.667, "03cddc502f8005f57f1000ea7f1000ea1e8005f302cede302e9107f4be0000beeb00009fdd0000af6f6003f905cddd70"],
    [9, 0.683, "04cdda104f600bd0cd0002f6fa0000fbfb0000fdbe0003fe3f902ced029ca4cc000000e8230003f26d101c703cecc500"],
    [0, 0.8, "02bffa101ef23fd07fc00df6cfa00bfbffa00afeff900affff900affffa00afecfa00bfb7fc00df61ef23fd002bffa10"],
    [1, 0.644, "03bff8009ecff800918ff800008ff800008ff800008ff800008ff800008ff800008ff800008ff800008ff800cfffffff"],
    [2, 0.729, "6ceffc50db11bff6d3001ffe20000fff00000ffe00004ff50000df900009f70001bd20063d90000fefffffffefffffff"],
    [3, 0.75, "7ceffb30da12cff3d0005ff700005ff70002dfe100affd200002bff400001ffc20000efed0000ffdf801aff69cffeb40"],
    [4, 0.831, "0004ff60000bff60003cff6000b5ff6004d1ff600c40ff604d00ff60b833ff83ccccffec0000ff600000ff60005ffffd"],
    [5, 0.729, "8ffffff08ffffff085000000850210008bdefe506600aff300003ffb00001ffe20001ffef0004ffaf702cff28cffea20"],
    [6, 0.767, "008dffd50bf802d85fe00035afa00000dfbbfe80fff42ff7ffe00cfeefc00bffcfc00bff8fe00cfd1ef42ff602aefd60"],
    [7, 0.741, "efffffffefffffffe54444cce10001f5000008d000001f7000008f100001f8000006f100000d9000003f200000bb0000"],
    [8, 0.783, "05dffd604ff22ff59fe00cfb9fe00cfb4ff10ef505feef603ef44ef4cfb009fdff9008ffefa009ff8fe11df907dffd70"],
    [9, 0.783, "05dffa204ff23fd0bfb00cf7efa00bfbefa00bfecfb00cfe6ff23ffe07efbafc000009f944000cf47d207fb04cffd800"],
    [0, 0.655, "01977a100d6008b06f1001f4bd0000daeb0000cefa0000bffa0000bfeb0000cebd0000da6f0001f40d5007b001977910"],
    [1, 0.426, "016bf40055aff400005ff400005ff400005ff400005ff400005ff400005ff400005ff400005ff400005ff50036dffb53"],
    [2, 0.667, "04cfe9003c55bf9080000de0300008f0000009b000000e50000059000001a00000190000009000031b766678bffffff1"],
    [3, 0.582, "03bffc302b204ef0600007f2000007e000002a200017ff8000247df8000000dd0000009d000000b8561006c09ffca600"],
    [4, 0.698, "00000d2000009f2000056f2000172f2000802f2006402f2029002f2090002f20ffffffff00002f2000002f2000002f20"],
    [5, 0.571, "0049999800cbbbb3066000001ec950003adffe4000028ff3000003fa000000bc000000aa000000e475000a90bffba500"],
    [6, 0.618, "00005742004e800005f600001fb000008f579710ef745df3fb0002fcfa0000cfeb0000bf9e0000cd1e5001f403b86940"],
    [7, 0.63, "2ffffffd974444c8500001f2000005c000000a6000000e1000004c000000a7000001f3000006d000000c8000002f2000"],
    [8, 0.564, "08767a50aa0002f3f80000e7ee1002f34fe44b5004fff30004abff607c003cf6f70000edf70000adbc0000d718a66870"],
    [9, 0.625, "03968a201e2007d09d0000f7dc0000dcdd0000de9f3000de1de778fa005743f500000cd00000af30000ac20027950000"],
    [0, 0.643, "01a899000ce01fa05fc00ff3bfb00efaefb00efeffb00effffb00effefb00efebfb00efa6fc00ff30ce01fa001a89900"],
    [1, 0.545, "0015ba004afffa00308ffa00006ffa00006ffa00006ffa00006ffa00006ffa00006ffa00006ffa00007ffb0068efff96"],
    [2, 0.673, "008efb200affffe04812cff430002ff500000ff200004f900000cc000008a0000039000502c6667b1efffff9bffffff6"],
    [3, 0.643, "019efe700a55eff241006ff400005fd00001cf40004efff400008ffe000007ff000000ff350000f7efc106a06dfe9600"],
    [4, 0.655, "00002ec00000bfc00008efc00048bfc001a0bfc00b20bfc06600bfc0c666dfd6ffffffff9999efe90000bfc00000bfc0"],
    [5, 0.636, "00effffe03fffff8074333310a4300000ffffa204fffffe00347dff8000006fb000000ba350000b5ffe505907effc600"],
    [6, 0.643, "00003996001bf50002df40001ef900007ff77600cff6bfd1efc01ffbffb00dffdfc00cff8fd00cfb1ef00ef202b97c40"],
    [7, 0.667, "8ffffffdbffffff6c7666af160000cb000002f6000007f100000db000003f5000009e000000fa000005f500000bf0000"],
    [8, 0.643, "05b78d706f800af6bf9007fabff60af45fffcc3006fffe4006bbfff48f708ffcef300dfeef3009fc8f700df307dabb40"],
    [9, 0.643, "04c7aa204fb02fd0bfa00ff7ffa00efdffb00effbfd00ffe3efa7ffb01678ff50000afc00005fd10006fa00069830000"],
    [0, 0.667, "03bffb301fb33bf28e0001f9ca0000bde800008ff700007ff700007fe800008fba0000bd7f1002f80ed44de103bffb20"],
    [1, 0.636, "007fc0001beec0009a1cc000200cc000000cc000000cc000000cc000000cc000000cc000000cc000333dd333fffffffe"],
    [2, 0.643, "05cffd605fb44bf6cd0000dc120000cd000001f900001cd10002dd20004fc00004f900004f800000ce433333ffffffff"],
    [3, 0.667, "05cffc505f933af5bc0001fa110000fa000007f5002ced400018afd2000001eb3200009fdb0000de6fa44bf706cffd70"],
    [4, 0.727, "00005f700000ef700008cd70002f2d7000c80d7006e00d701e500d70aa000d70ffffffff44444ea400000d7000000d70"],
    [5, 0.679, "4ffffff65f3333316f0000007e0000008d4ab8109fd99ee3340002ec0000009f0000009fba0001ec7f934cf507dffc40"],
    [6, 0.649, "019efd600dd428f56f300084bd000000e94bca30fdc55bf5ff0000eceb00009fcc00009f7f3000ec1ed43bf502affc50"],
    [7, 0.655, "ffffffff333333bd000004f300000e9000007f100000e8000007f100000e9000004f5000007f200000af000000be0000"],
    [8, 0.667, "05cffc504f7118f69d0000fb9d0000fa3f7107f405ffff503f9229f5bb0000cde900009fcb0000cd6f9218f706cffd60"],
    [9, 0.649, "06cffb207f924ce1dc0002f7f80000dbf80000cece1002fe4fd68ece04aca3ad000000ea690005f47f936fb008dfe900"],
    [0, 0.667, "03cffb302ffddff28fd00cf9cf7008fdef5006ffff4005ffff4005ffef5006ffbf7008fc7fd11df81effffe103bffb20"],
    [1, 0.673, "019ff5004efff500ee6ff500901ff500001ff500001ff500001ff500001ff500001ff500001ff500cccffdccffffffff"],
    [2, 0.679, "06cffc605ffffff6cfb00cfc452009fd00000dfb0000aff3001bfe4001efe3000dfd20009fe10000ffffffffffffffff"],
    [3, 0.702, "04cffc404ffddff4bfa00cf9352009f900003ef4003ffd50003fffc100001bfa782005fedfb00afc5ffffff605cffd60"],
    [4, 0.782, "0001ef900008ff90001edf90009f6f9002f85f9009f15f902f705f90ce337fb3ffffffff9aaacfda00005f9000005f90"],
    [5, 0.696, "6ffffff67fecccc58f8000009f700000afadfd50bffffff58a701bfd000004ff120004ffef700bfc8ffffff407dffc50"],
    [6, 0.684, "01affd500dfdcff36fc009d6bf600000ef369820ffdffff3ffc12dfaff5005fecf5005fe7fc00bfb1efffff402bffd50"],
    [7, 0.691, "efffffffefffffff000009fa00003ff10000cf700004fd00000cf600004fe00000bfa00000ff600003ff400004ff3000"],
    [8, 0.684, "07dffd607ff9aff6cf800afacf7008fa6fd44ef407ffff605fe78ff5ef5006fdff2004ffef6008fd8ffbcff707dffd70"],
    [9, 0.684, "06dffb206ffcefe1df800df7ff3007fbff3007fdcfb12dfe5ffffefe05bc86fc000007fa9e702ef45fffffc007efea10"],
    [0, 0.683, "01affa100dd45ed06f3003f5be0000eadb0000bdea0000aeea0000aedb0000bdbe0000ea6f3003f50dd45dd001affa10"],
    [1, 0.603, "7befe000b85de000000de000000de000000de000000de000000de000000de000000de000000de000233de332cffffffe"],
    [2, 0.627, "5aefeb40ea535cf5200001fc000000de000002fb00000cf30000bf60000af700009f60000af50000bf933333ffffffff"],
    [3, 0.633, "4beffb4088534cf6000001fc000000fc000019f500fffe4000334bf6000000de0000009f000000ded7435cf68dffea40"],
    [4, 0.724, "0000bf600005ef60000e6f60008c0f6003f30f600b800f605e000f60e8333f83ffffffff00000f6000000f6000000f60"],
    [5, 0.644, "7ffffff17f3333307f0000007f1310007ffffd4033003cf5000002fc000000df000000df000003fbd7436ef38dffe920"],
    [6, 0.667, "006dffc20af734825f400000bc000000f98efc40ffc44bf4ff1000ecfd0000afdd0000af8f1000eb1ec44bf302affc40"],
    [7, 0.638, "ffffffff333336fb000008f500000ee000005f800000df100003fa000009f300000fd000005f600000be000001f90000"],
    [8, 0.667, "04cffd603fb439f69f0000dc9f0000cb2f8106f403efff503eb439f5bd0000beeb00008fcd0000bf5fb439f805cffd70"],
    [9, 0.667, "04cffa104fb44de1ce0001f7fa0000dcfa0000dfce0001ff4fb44dff05cfe89e000000db000004f428437f902cffd600"],
    [0, 0.8, "02bffa100dffffd07ff22ff6cfa00bfbff8009feff7008ffff7008ffff8009fecfa00bfb7ff23ff60dffffd002bffa10"],
    [1, 0.707, "8bfff600fffff600d98ff600004ff600004ff600004ff600004ff600004ff600004ff600347ff844efffffffefffffff"],
    [2, 0.729, "7beffc40effffff4c6109ffb00000ffd00001ffa0000bff30009ff70008ff90008ff70009ffa3333efffffffefffffff"],
    [3, 0.733, "5ceffc608ffffff643006ffb00000ffb00339ff402ffff6001cdfff500002ffe00000cff83005ffefffffff5adffeb40"],
    [4, 0.828, "0007ff90001fff90008fff9001fbcf9009f2cf903f90cf90be10cf90fd99efd9ffffffffbbbbffeb0000cf900000cf90"],
    [5, 0.746, "9ffffff29ffffff29fa333309f9220009ffffe609fddfff531005ffc00000dff00000dffb4007ffbfffffff38cffea30"],
    [6, 0.767, "007dffd40afffff64ff81043afc00000efbcfd60fffffff7fff41dfeefd008ffcfd008ff7ff41dfc0dfffff402aefc40"],
    [7, 0.759, "ffffffffffffffff34444ffb00005ff50000bfd00002ff800009ff20001ffa00006ff40000cfd00002ff800009ff2000"],
    [8, 0.767, "07dffc607ffffff6cfe12ffbbfb00dfa6ff88ff408ffff606ffbbff5ef900bfdff7009feefc11efd8ffffff707dffc60"],
    [9, 0.783, "04cffa103fffffd0bfc13ff6ef700cfaff700cfdcfc13ffe5ffffffe06efcbfc00000cf924018ff35fffff903dffd700"]
  ];

  function readDigit(ctx, c) {
    const { labels, w } = ctx;
    const GW = 8, GH = 12;
    const cells = new Float32Array(GW * GH);
    for (let gy = 0; gy < GH; gy++) {
      const y0 = c.minY + gy * c.h / GH, y1 = c.minY + (gy + 1) * c.h / GH;
      for (let gx = 0; gx < GW; gx++) {
        const x0 = c.minX + gx * c.w / GW, x1 = c.minX + (gx + 1) * c.w / GW;
        let n = 0, s = 0;
        for (let y = Math.floor(y0); y < Math.max(Math.floor(y0) + 1, Math.ceil(y1)); y++)
          for (let x = Math.floor(x0); x < Math.max(Math.floor(x0) + 1, Math.ceil(x1)); x++) { n++; if (labels[y * w + x] === c.id) s++; }
        cells[gy * GW + gx] = n ? 15 * s / n : 0;
      }
    }
    const aspect = c.w / c.h;
    let best = null, bestErr = Infinity;
    for (const [d, a, bits] of DIGIT_TEMPLATES) {
      let e = 0;
      for (let i = 0; i < GW * GH; i++) e += Math.abs(cells[i] - parseInt(bits[i], 16));
      e = e / (GW * GH * 15) + 0.35 * Math.abs(Math.log(aspect / a));
      if (e < bestErr) { bestErr = e; best = d; }
    }
    return { digit: best, err: bestErr };
  }

  // Reads a row of digit components left to right into a number.
  function readNumber(ctx, list) {
    let s = '';
    for (const c of list) {
      const r = readDigit(ctx, c);
      if (r.err > 0.3) return null;
      s += r.digit;
    }
    return s ? Number(s) : null;
  }

  // "♩ = 89" above the first staff. Finds the "=" (two short bars, one above
  // the other), the number to its right and a note to its left.
  function findTempo(ctx, staff) {
    const { comps, D } = ctx;
    const top = posY(staff, staff.left, 0);
    const inBand = c => c.maxY < top - 0.3 * D && c.minY > top - 9 * D && c.minX > staff.left - 2 * D && c.maxX < staff.left + 25 * D;
    const bars = comps.filter(c => c && inBand(c) && c.w >= 0.4 * D && c.w <= 1.6 * D && c.h <= 0.35 * D + 2 && c.w >= 2.5 * c.h);
    for (let a of bars) {
      let b = bars.find(o => o !== a && o.minY > a.maxY && o.minY - a.maxY < 0.8 * D && Math.abs(o.cx - a.cx) < 0.3 * D && Math.abs(o.w - a.w) < 0.3 * D);
      if (!b && !bars.some(o => o !== a && o.maxY < a.minY && a.minY - o.maxY < 0.8 * D && Math.abs(o.cx - a.cx) < 0.3 * D)) {
        // The other bar may sit where a ledger line would and have been
        // erased with the ledger lines: look for it in the original ink.
        const row = y => { let n = 0; for (let x = a.minX; x <= a.maxX; x++) if (ctx.bin[y * ctx.w + x]) n++; return n / a.w; };
        for (const dir of [-1, 1]) {
          const from = dir < 0 ? a.minY - 2 : a.maxY + 2, to = dir < 0 ? a.minY - 1.2 * D : a.maxY + 1.2 * D;
          let y0 = -1, y1 = -1;
          for (let y = from; dir < 0 ? y >= to : y <= to; y += dir) {
            if (y < 0 || y >= ctx.h) break;
            if (row(y) > 0.8) { if (y0 < 0) y0 = y; y1 = y; } else if (y0 >= 0) break;
          }
          if (y0 < 0) continue;
          const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
          if (hi - lo + 1 > 0.35 * D + 2) continue;
          const twin = { minX: a.minX, maxX: a.maxX, minY: lo, maxY: hi, cx: a.cx, cy: (lo + hi) / 2, w: a.w, h: hi - lo + 1 };
          b = dir < 0 ? a : twin;
          if (dir < 0) { b = a; a = twin; }
          break;
        }
      }
      if (!b) continue;
      const midY = (a.cy + b.cy) / 2;
      // Digits: to the right, about one space tall or more, centred on "=".
      const digits = [];
      let x = Math.max(a.maxX, b.maxX);
      for (;;) {
        const d = comps.find(c => c && c !== a && c !== b && c.minX > x && c.minX - x < 1.2 * D && c.h >= 0.7 * D && c.h <= 3 * D && c.w <= 1.6 * D &&
          Math.abs(c.cy - midY) < 0.6 * D && (!digits.length || Math.abs(c.h - digits[0].h) < 0.25 * digits[0].h));
        if (!d) break;
        digits.push(d); x = d.maxX;
        if (digits.length > 3) break;
      }
      dbg('tempo eq', Math.round(a.minX), Math.round(a.minY), 'digits', digits.map(d => [d.minX, d.minY, d.w, d.h].join(',')).join(' '));
      if (!digits.length || digits.length > 3) continue;
      // The note: a tall narrow symbol (head and stem) just left of "=".
      const left = Math.min(a.minX, b.minX);
      const note = comps.find(c => c && c.maxX < left && left - c.maxX < 3 * D && c.h >= 1.5 * D && c.h <= 5 * D && c.w <= 2 * D &&
        c.maxY > midY - 0.5 * D && c.minY < midY);
      if (!note) continue;
      const n = readNumber(ctx, digits);
      dbg('tempo read', n, digits.map(d => JSON.stringify(readDigit(ctx, d))).join(' '));
      if (!n || n < 20 || n > 300) continue;
      // A dotted note (6/8 and the like) counts dotted quarters; a half
      // note counts halves. The player counts quarters.
      const dot = comps.find(c => c && c.minX > note.maxX && c.maxX < left && c.w < 0.6 * D && c.h < 0.6 * D && c.w > 1 && Math.abs(c.cy - note.maxY + 0.3 * D) < 0.6 * D);
      const headFill = fill(ctx, note.minX, note.maxY - 0.7 * D, note.maxX, note.maxY);
      let unit = 1;
      if (headFill < 0.45) unit = 2;
      if (dot) unit *= 1.5;
      dbg('tempo', n, 'unit', unit, 'at', Math.round(note.minX), Math.round(note.minY));
      return { bpm: Math.round(n * unit), marked: n, unit };
    }
    return null;
  }

  // Repeat signs: two dots in the middle spaces beside a barline. Dots on
  // the right open a repeat, dots on the left close one.
  function findRepeats(ctx, staff) {
    const { comps, D } = ctx;
    const out = [];
    const isDot = c => c && c.w >= 0.25 * D && c.w <= 0.8 * D && c.h >= 0.25 * D && c.h <= 0.8 * D && c.area >= 0.55 * c.w * c.h && (!c.role || c.role === 'dot-candidate');
    for (const a of comps) {
      if (!isDot(a)) continue;
      if (a.cx < staff.left || a.cx > staff.right + D) continue;
      if (Math.abs(a.cy - posY(staff, a.cx, 3)) > 0.3 * D) continue;
      const b = comps.find(c => isDot(c) && Math.abs(c.cx - a.cx) < 0.3 * D && Math.abs(c.cy - posY(staff, a.cx, 5)) < 0.3 * D);
      if (!b) continue;
      // A tall stroke through the whole staff right beside the dots.
      const top = posY(staff, a.cx, 0), bottom = posY(staff, a.cx, 8);
      const tall = c => c && c !== a && c !== b && c.minY <= top + 0.5 * D && c.maxY >= bottom - 0.5 * D && c.w <= 1.2 * D && c.role !== 'note';
      const right = comps.find(c => tall(c) && c.minX > a.maxX && c.minX - a.maxX < 1.2 * D);
      const left = comps.find(c => tall(c) && c.maxX < a.minX && a.minX - c.maxX < 1.2 * D);
      if (!right && !left) continue;
      a.role = b.role = 'repeat';
      out.push({ x: a.cx, type: left ? 'start' : 'end' });
    }
    out.sort((p, q) => p.x - q.x);
    dbg('repeats', staff.index, out.map(r => r.type + '@' + Math.round(r.x)).join(' '));
    return out;
  }

  // First and second endings: a bracket above the staff (a long thin line
  // with a short hook down at its left end), usually numbered "1." / "2.".
  function findVoltas(ctx, staff) {
    const { comps, bin, w, h, D } = ctx;
    const out = [];
    const ink = (x, y) => x >= 0 && x < w && y >= 0 && y < h && bin[y * w + x];
    const topL = posY(staff, staff.left, 0), topR = posY(staff, staff.right, 0);
    // Judged on the original ink: the bracket can sit where a ledger line
    // would and lose pieces when lines are erased.
    const onLine = (y, x) => (ctx.staves || []).some(o => { for (let k = 0; k <= 8; k += 2) if (Math.abs(posY(o, x, k) - y) < 0.3 * D) return true; return false; });
    for (let y = Math.max(1, Math.round(Math.min(topL, topR) - 9 * D)); y <= Math.max(topL, topR) - 0.9 * D; y++) {
      let start = -1, gap = 0;
      const runs = [];
      for (let x = staff.left; x <= staff.right + 3; x++) {
        const on = x <= staff.right && ink(x, y);
        if (on) {
          // After a bridged gap, a hook down starts the next bracket.
          if (start >= 0 && gap > 2) {
            let down = 0;
            for (let yy = y + 1; yy < y + 2 * D; yy++) {
              let any = false;
              for (let xx = x; xx <= x + 0.3 * D; xx++) if (ink(xx, yy)) any = true;
              if (any) down++; else break;
            }
            if (down >= 0.8 * D) { runs.push([start, x - gap - 1]); start = x; }
          }
          if (start < 0) start = x;
          gap = 0; continue;
        }
        if (start < 0) continue;
        // A faint line in a photo breaks up: bridge short gaps.
        if (++gap <= Math.max(2, 0.6 * D) && x <= staff.right) continue;
        runs.push([start, x - gap]);
        start = -1; gap = 0;
      }
      for (const [x0, x1] of runs) {
        if (x1 - x0 + 1 < 3 * D) continue;
        // Judged where the run is (the page may be tilted): clear of every
        // staff's lines, above this staff and below any staff above it.
        const mid = (x0 + x1) / 2;
        if (y > posY(staff, mid, 0) - 0.9 * D || y < posY(staff, mid, 0) - 9 * D || onLine(y, mid)) continue;
        if ((ctx.staves || []).some(o => o !== staff && posY(o, mid, 8) < posY(staff, mid, 0) && y < posY(o, mid, 8) + D)) continue;
        if (out.some(v => v.x0 < x1 && v.x1 > x0 && Math.abs(v.y - y) < D)) continue;
        // Thin: little ink a bit above and below along the run.
        const cover = yy => { let n = 0; for (let xx = x0; xx <= x1; xx++) if (ink(xx, yy)) n++; return n / (x1 - x0 + 1); };
        let thick = 1;
        while (thick < D && cover(y + thick) > 0.6) thick++;
        if (thick > Math.max(2, 0.3 * D)) continue;
        if (cover(Math.round(y + 0.4 * D)) > 0.25 || cover(Math.round(y - 0.4 * D)) > 0.25) continue;
        // The hook: ink straight down at the left end.
        let hook = 0;
        for (let yy = y; yy < y + 3 * D; yy++) {
          let any = false;
          for (let xx = x0 - 1; xx <= x0 + 0.3 * D; xx++) if (ink(xx, yy)) any = true;
          if (any) hook++; else break;
        }
        if (hook < 0.8 * D) continue;
        // The number just under the line near the left end.
        const digit = comps.find(d => d && d.minX > x0 && d.minX < x0 + 2.5 * D && d.minY > y && d.minY < y + 1.5 * D && d.h >= 0.6 * D && d.h <= 2.2 * D && d.w < 1.5 * D);
        // A beam's end stem looks like a hook too, but has no number and
        // ends on a notehead.
        if (!digit) continue;
        const end = y + hook;
        let head = 0;
        for (let xx = Math.round(x0 - D); xx <= x0 + D; xx++) if (ink(xx, Math.round(end - 0.3 * D))) head++;
        if (head > 0.8 * D) continue;
        const num = readDigit(ctx, digit);
        out.push({ x0, x1, y, number: num.err < 0.3 && num.digit > 0 ? num.digit : null });
      }
    }
    out.sort((p, q) => p.x0 - q.x0);
    dbg('voltas', staff.index, out.map(v => Math.round(v.x0) + '-' + Math.round(v.x1) + '#' + v.number).join(' '));
    return out.map(v => ({ x0: v.x0, x1: v.x1, number: v.number }));
  }


  // ---------- systems (grand staff) ----------

  // Staves joined by a brace, bracket or system barline at their left edge
  // are played together (piano: right hand above, left hand below). Without
  // a visible connector, a page that alternates treble and bass staves is
  // read as piano music too.
  function findSystems(ctx, staves, described) {
    const { comps, D } = ctx;
    const n = staves.length;
    const top = st => posY(st, st.left, 0), bottom = st => posY(st, st.left, 8);
    const joined = new Array(Math.max(0, n - 1)).fill(false);
    for (let i = 0; i + 1 < n; i++) {
      const a = staves[i], b = staves[i + 1];
      const left = Math.min(a.left, b.left);
      for (let j = 1; j < comps.length && !joined[i]; j++) {
        const c = comps[j];
        if (c.minX > left + 2 * D || c.maxX < left - 3 * D) continue;
        if (c.w > 2.5 * D) continue;
        if (c.minY <= top(a) + 0.6 * D && c.maxY >= bottom(b) - 0.6 * D) joined[i] = true;
      }
    }
    if (!joined.some(Boolean) && n >= 2 && n % 2 === 0) {
      const alternating = described.every((st, i) => st.clef === (i % 2 ? 'bass' : 'treble'));
      if (alternating) for (let i = 0; i + 1 < n; i += 2) joined[i] = true;
    }
    const systems = [];
    for (let i = 0; i < n; i++) {
      if (i > 0 && joined[i - 1]) systems[systems.length - 1].staves.push(i);
      else systems.push({ staves: [i] });
    }
    systems.forEach((sys, si) => sys.staves.forEach((idx, part) => {
      described[idx].system = si;
      described[idx].part = part;
      described[idx].hand = sys.staves.length === 2 ? (part === 0 ? 'right' : 'left') : null;
    }));
    return systems;
  }

  // The usual bar length: the most common total of a staff's bar.
  function typicalBarLength(events) {
    const sums = new Map();
    for (const e of events) {
      if (e.wholeRest) continue;
      const key = e.staff + ':' + e.measure;
      const v = e.at != null ? Math.max(sums.get(key) || 0, e.at + e.beats) : (sums.get(key) || 0) + e.beats;
      sums.set(key, v);
    }
    const count = new Map();
    for (const v of sums.values()) { const r = Math.round(v * 12) / 12; count.set(r, (count.get(r) || 0) + 1); }
    let best = 4, n = 0;
    for (const [len, c] of count) if (c > n || (c === n && len > best)) { best = len; n = c; }
    return best;
  }

  // Gives every event its start times in beats (more than one when a
  // repeat plays it again). The staves of a system play together, bar by
  // bar. Inside a bar, a hand whose notes do not add up (a missed note or
  // a misread value) is placed by where its notes stand on the page,
  // against the hand that does add up, so the hands stay together.
  function computeTimeline(result) {
    const L = typicalBarLength(result.events);
    const D = result.space || 20;
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    const measures = [];
    for (const sys of result.systems) {
      const idxs = sys.staves;
      const barsOf = idx => result.staves[idx].bars || [];
      // The staff with the most barlines frames the bars; a barline missed
      // on the other staff then does not shift that staff by a bar.
      const ref = idxs.reduce((a, b) => (barsOf(b).length > barsOf(a).length ? b : a), idxs[0]);
      const rb = barsOf(ref);
      for (const idx of idxs) {
        if (idx === ref || barsOf(idx).length === rb.length) continue;
        for (const e of result.events) if (e.staff === idx) e.measure = rb.filter(x => x < e.x).length;
      }
      const measureAt = x => rb.filter(b => b < x).length;
      const evs = result.events.filter(e => idxs.includes(e.staff));
      const ids = [...new Set(evs.map(e => e.measure))].sort((a, b) => a - b);
      const left = Math.min(...idxs.map(i => result.staves[i].headerEnd || result.staves[i].left));
      const right = Math.max(...idxs.map(i => result.staves[i].right));
      const sysMeasures = [];
      for (const m of ids) {
        const lists = idxs.map(idx => evs.filter(e => e.staff === idx && e.measure === m).sort((a, b) => a.x - b.x));
        // A list whose places in the bar are already known (from the other
        // reader) lasts to its last end; otherwise its values add up.
        const timed = l => l.length && l.every(e => e.at != null);
        const sums = lists.map(l => (timed(l) ? Math.max(...l.map(e => e.at + e.beats)) : l.reduce((a, e) => a + e.beats, 0)));
        const filled = lists.map((l, i) => i).filter(i => lists[i].length);
        let len, refList = -1;
        if (filled.every(i => near(sums[i], sums[filled[0]]))) { len = sums[filled[0]] || 0; refList = filled[0]; }
        else {
          refList = filled.find(i => near(sums[i], L));
          if (refList === undefined) refList = -1;
          if (refList < 0) {
            // No hand adds up: a full bar still lasts the usual length
            // (only a first bar may be a shorter pickup).
            refList = filled.reduce((a, i) => (Math.abs(sums[i] - L) < Math.abs(sums[a] - L) ? i : a), filled[0]);
            len = measures.length || sysMeasures.length ? L : Math.max(...sums);
          } else len = L;
        }
        // Onsets from note values.
        for (const l of lists) {
          if (timed(l)) { for (const e of l) e.off = e.at; l.sort((a, b) => a.off - b.off || a.x - b.x); continue; }
          let t = 0; for (const e of l) { e.off = t; t += e.beats; }
        }
        // A hand that does not add up: place it by x against the other.
        const x0 = m > 0 && rb[m - 1] != null ? rb[m - 1] : left, x1 = rb[m] != null ? rb[m] : right;
        const pts = [[x0, 0]];
        for (const e of lists[refList] || []) if (e.x > pts[pts.length - 1][0] + 1 && e.off > pts[pts.length - 1][1]) pts.push([e.x, e.off]);
        if (x1 > pts[pts.length - 1][0]) pts.push([x1, len]);
        const timeAt = x => {
          if (x <= pts[0][0]) return 0;
          for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) {
            const [xa, ta] = pts[i - 1], [xb, tb] = pts[i];
            return ta + (tb - ta) * (x - xa) / Math.max(1, xb - xa);
          }
          return pts[pts.length - 1][1];
        };
        lists.forEach((l, i) => {
          if (i === refList || near(sums[i], len)) return;
          let prev = -1;
          for (const e of l) {
            // Keep the written onset while it agrees with the page.
            let t = timeAt(e.x - 0.3 * D);
            if (Math.abs(e.off - t) <= 0.3) t = e.off;
            else t = Math.abs(t - Math.round(t * 4) / 4) < 0.06 ? Math.round(t * 4) / 4 : Math.round(t * 12) / 12;
            if (t <= prev) t = prev + 1 / 12;
            e.off = Math.min(t, Math.max(0, len - 1 / 12));
            prev = e.off;
          }
        });
        sysMeasures.push({ m, len, events: lists.flat() });
      }
      // Repeat signs and first/second endings, read from the staves.
      const marks = new Map();
      const mark = (m, k, v) => { if (!marks.has(m)) marks.set(m, {}); marks.get(m)[k] = v; };
      for (const idx of idxs) for (const r of result.staves[idx].repeats || []) mark(measureAt(r.x), r.type === 'start' ? 'startRepeat' : 'endRepeat', true);
      const top = result.staves[idxs[0]];
      for (const v of top.voltas || []) {
        for (let m = measureAt(v.x0 + D); m <= measureAt(v.x1 - D); m++) mark(m, 'volta', v);
      }
      for (const sm of sysMeasures) Object.assign(sm, marks.get(sm.m) || {});
      measures.push(...sysMeasures);
      sys.measures = sysMeasures.length;
    }
    // Number the endings: as printed, else counting on from the last one.
    let lastVolta = null, lastNumber = 0;
    measures.forEach((g, i) => {
      if (!g.volta) return;
      if (g.volta !== lastVolta) {
        const prev = i > 0 ? measures[i - 1] : null;
        lastNumber = g.volta.number || (prev && prev.volta ? lastNumber + 1 : 1);
        lastVolta = g.volta;
      }
      g.ending = lastNumber;
    });
    // A first ending runs on to its end repeat (its line may fade out).
    for (let i = 0; i < measures.length; i++) {
      if (measures[i].ending !== 1) continue;
      let j = i;
      while (j < measures.length && !measures[j].endRepeat && !measures[j].startRepeat && (!measures[j].ending || measures[j].ending === 1)) j++;
      if (j < measures.length && measures[j].endRepeat && (!measures[j].ending || measures[j].ending === 1)) for (let k = i; k <= j; k++) measures[k].ending = 1;
    }
    // Endings mean nothing without a repeat (and a misread one must not
    // skip bars).
    if (!measures.some(g => g.endRepeat)) for (const g of measures) delete g.ending;
    // Play order: back to the last start repeat (or the beginning) at an
    // end repeat, once; on the way through again, take the next ending.
    const order = [];
    const done = new Set();
    let i = 0, repStart = 0, pass = 1, back = -1;
    while (i < measures.length && order.length < 4 * measures.length + 8) {
      const g = measures[i];
      if (g.startRepeat && i !== back) { repStart = i; pass = 1; }
      back = -1;
      if (g.ending && g.ending !== pass) { i++; continue; }
      order.push(i);
      if (g.endRepeat && !done.has(i)) { done.add(i); pass++; i = repStart; back = repStart; continue; }
      i++;
    }
    for (const e of result.events) { e.starts = []; }
    let t = 0;
    for (const gi of order) {
      const g = measures[gi];
      for (const e of g.events) e.starts.push(t + e.off);
      t += g.len;
    }
    for (const e of result.events) { e.start = e.starts.length ? e.starts[0] : 0; delete e.off; delete e.at; }
    result.totalBeats = t;
    result.barLength = L;
    result.measures = measures.length;
    result.playOrder = order.map(gi => gi + 1);
    result.repeats = measures.some(g => g.startRepeat || g.endRepeat || g.ending);
    for (const e of result.events) {
      const st = result.staves[e.staff];
      e.hand = st ? st.hand : null;
    }
  }

  // ---------- assemble ----------

  function diatonicToMidi(d, alter) {
    const octave = Math.floor(d / 7);
    const letter = ((d % 7) + 7) % 7;
    return (octave + 1) * 12 + NATURAL_SEMITONES[letter] + alter;
  }

  function noteName(midi) {
    const names = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
    return names[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
  }

  function assembleStaff(ctx, staff, notes, rests, bars) {
    const { D } = ctx;
    const bottom = CLEF_BOTTOM[staff.clef] ?? CLEF_BOTTOM.treble;
    const keyAlter = new Array(7).fill(0);
    if (staff.key.type === 'sharp') for (let i = 0; i < staff.key.count; i++) keyAlter[SHARP_ORDER[i]] = 1;
    if (staff.key.type === 'flat') for (let i = 0; i < staff.key.count; i++) keyAlter[FLAT_ORDER[i]] = -1;
    const items = [];
    for (const n of notes) items.push({ kind: 'note', x: n.x, n });
    for (const r of rests) items.push({ kind: 'rest', x: r.x, r });
    items.sort((a, b) => a.x - b.x);
    // Group simultaneous heads (chords) by x.
    const events = [];
    let measureAccidentals = new Map();
    let barIdx = 0, measure = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      while (barIdx < bars.length && bars[barIdx] < it.x) { barIdx++; measure++; measureAccidentals = new Map(); }
      if (it.kind === 'rest') {
        const r = it.r;
        events.push({ type: 'rest', beats: r.beats, base: r.base, wholeRest: !!r.whole, staff: staff.index, measure, x: r.x, y: r.y });
        continue;
      }
      const chord = [it.n];
      while (i + 1 < items.length && items[i + 1].kind === 'note' && Math.abs(items[i + 1].x - it.x) < 0.9 * D) chord.push(items[++i].n);
      const pitches = [];
      for (const n of chord) {
        const d = bottom + (8 - n.k);
        const letter = ((d % 7) + 7) % 7;
        let alter;
        if (n.accidental) {
          alter = n.accidental === 'sharp' ? 1 : n.accidental === 'flat' ? -1 : 0;
          measureAccidentals.set(d, alter);
        } else if (measureAccidentals.has(d)) alter = measureAccidentals.get(d);
        else alter = keyAlter[letter];
        const midi = diatonicToMidi(d, alter);
        pitches.push({ midi, name: noteName(midi), x: n.x, y: n.y, k: n.k, accidental: n.accidental || null });
      }
      const lead = chord.find(n => n.stem) || chord[0];
      let beats = lead.beats;
      const dots = Math.max(...chord.map(n => n.dots || 0));
      if (dots === 1) beats *= 1.5;
      if (dots === 2) beats *= 1.75;
      events.push({ type: 'note', pitches, midi: pitches[0].midi, name: pitches.map(p => p.name).join('+'), beats, base: lead.base, dots, staff: staff.index, measure, x: lead.x, y: lead.y, L: lead.L, R: lead.R });
    }
    return events;
  }

  function describeStaff(staff, bars) {
    return {
      index: staff.index, left: staff.left, right: staff.right,
      lines: staff.lineY.map(ys => [ys[staff.left], ys[staff.right]]),
      clef: staff.clef, key: staff.key, time: staff.timeSignature, headerEnd: staff.headerEnd, bars
    };
  }

  // ---------- a second reader's notes on this page's staves ----------

  // Another reader (homr on the user's computer) sends its notes with their
  // places on the image. It reads notes better, but it can drop a note or
  // run two bars together, and then a hand shifts by a bar. So its notes
  // are put back on the staves and barlines this page found, bar by bar.
  // A bar of it that does not add up takes the notes this page read there
  // (spelled with the other reader's clef and key). Returns null when the
  // staves found here do not fit its notes.
  // Lines up two readings of one staff in reading order (as in aligning
  // two texts): a pair costs its distance apart and how much its pitches
  // differ, a note in one reading only costs a fixed amount. The events of
  // the first reading that pair up move to their partner's place.
  function alignByPlace(a, b, D) {
    const n = a.length, m = b.length;
    if (!n || !m) return;
    const GAP = 1.2;
    const set = e => new Set(e.type === 'note' ? (e.pitches || []).map(q => q.midi % 12) : ['r']);
    const sa = a.map(set), sb = b.map(set);
    const pair = (i, j) => {
      const dx = Math.abs(a[i].x - b[j].x) / D;
      if (dx > 3.5) return Infinity;
      let common = 0;
      for (const v of sa[i]) if (sb[j].has(v)) common++;
      const union = sa[i].size + sb[j].size - common;
      return 0.25 * dx + (1 - common / Math.max(1, union));
    };
    const cost = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
    const move = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
    for (let i = 1; i <= n; i++) { cost[i][0] = i * GAP; move[i][0] = 1; }
    for (let j = 1; j <= m; j++) { cost[0][j] = j * GAP; move[0][j] = 2; }
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
      let c = cost[i - 1][j - 1] + pair(i - 1, j - 1), mv = 0;
      if (cost[i - 1][j] + GAP < c) { c = cost[i - 1][j] + GAP; mv = 1; }
      if (cost[i][j - 1] + GAP < c) { c = cost[i][j - 1] + GAP; mv = 2; }
      cost[i][j] = c; move[i][j] = mv;
    }
    for (let i = n, j = m; i > 0 && j > 0;) {
      const mv = move[i][j];
      if (mv === 0) {
        const e = a[i - 1], dx = b[j - 1].x - e.x;
        e.x += dx;
        for (const q of e.pitches || []) if (q.x != null) q.x += dx;
        i--; j--;
      } else if (mv === 1) i--; else j--;
    }
  }

  function mergeExternal(local, ext) {
    if (!local || !local.staves.length || !local.fromImage || !ext || !ext.events) return null;
    const D = local.space || 20;
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    const extHand = h => (ext.staves || []).find(s => s.hand === h);
    const piano = !!(extHand('right') && extHand('left'));
    const staves = local.staves.map(s => Object.assign({}, s));
    let systems = local.systems.map(sys => Object.assign({}, sys, { staves: sys.staves.slice() }));
    if (piano) {
      // Every system is a pair of staves; pair up any the page left single.
      if (systems.some(sys => sys.staves.length !== 2)) {
        if (staves.length % 2 || systems.some(sys => sys.staves.length > 2)) return null;
        systems = [];
        for (let i = 0; i < staves.length; i += 2) systems.push({ staves: [i, i + 1] });
      }
      for (const sys of systems) {
        sys.staves.forEach((idx, part) => {
          const st = staves[idx], hand = part === 0 ? 'right' : 'left', es = extHand(hand);
          st.hand = hand;
          if (es && CLEF_BOTTOM[es.clef] != null) st.clef = es.clef;
          if (es && es.key) st.key = es.key;
          if (es && es.time && !st.time) st.time = es.time;
        });
      }
    } else if ((ext.staves || []).length === 1) {
      const es = ext.staves[0];
      for (const st of staves) {
        if (CLEF_BOTTOM[es.clef] != null) st.clef = es.clef;
        if (es.key) st.key = es.key;
        if (es.time && !st.time) st.time = es.time;
      }
    }
    const sysOf = new Map();
    systems.forEach(sys => sys.staves.forEach(i => sysOf.set(i, sys)));
    // The barlines of a system: those of its staff with the most.
    const barsOf = idx => {
      const sys = sysOf.get(idx);
      const ids = sys ? sys.staves : [idx];
      return ids.map(i => staves[i].bars || []).reduce((a, b) => (b.length > a.length ? b : a), []);
    };
    const measureAt = (idx, x) => barsOf(idx).filter(b => b < x).length;
    const mid = (s, x) => {
      const t = (x - s.left) / Math.max(1, s.right - s.left);
      return s.lines[2][0] * (1 - t) + s.lines[2][1] * t;
    };

    // The other reader's notes, in this page's coordinates, on the nearest
    // staff of their hand.
    const H = [];
    let lost = 0, notes = 0;
    for (const e0 of ext.events) {
      if (e0.type === 'note') notes++;
      if (e0.x == null || e0.y == null) { lost++; continue; }
      const e = Object.assign({}, e0);
      const p = local.fromImage(e0.x, e0.y);
      e.x = p.x; e.y = p.y;
      e.pitches = (e0.pitches || []).map(q => {
        const c = q.x != null ? local.fromImage(q.x, q.y) : p;
        return Object.assign({}, q, { x: c.x, y: c.y });
      });
      let best = -1, bestD = Infinity;
      staves.forEach((s, i) => {
        if (e.hand && s.hand && s.hand !== e.hand) return;
        const d = Math.abs(mid(s, e.x) - e.y);
        if (d < bestD) { bestD = d; best = i; }
      });
      if (best < 0 || bestD > 9 * D) { lost++; continue; }
      // A note head far off its staff is a misreading.
      if (e.type === 'note' && e.pitches.length > 1) {
        const kept = e.pitches.filter(q => Math.abs(mid(staves[best], q.x) - q.y) < 8 * D);
        if (kept.length && kept.length < e.pitches.length) {
          e.pitches = kept;
          e.midi = kept[0].midi;
          e.name = kept.map(q => q.name).join('+');
        }
      }
      e.staff = best;
      e.extMeasure = e0.measure;
      e.extStart = e0.start;
      delete e.starts; delete e.start;
      H.push(e);
    }
    if (lost > Math.max(2, 0.03 * ext.events.length) || !notes) return null;

    // This page's own notes, spelled with the other reader's clef and key.
    const LO = [];
    const bySt = new Map();
    for (const e0 of local.events) {
      if (!staves[e0.staff]) continue;
      const e = Object.assign({}, e0, { pitches: (e0.pitches || []).map(q => Object.assign({}, q)) });
      e.measure = measureAt(e.staff, e.x);
      delete e.starts; delete e.start;
      if (!bySt.has(e.staff)) bySt.set(e.staff, []);
      bySt.get(e.staff).push(e);
      LO.push(e);
    }
    for (const [idx, list] of bySt) {
      const st = staves[idx];
      const bottom = CLEF_BOTTOM[st.clef];
      if (bottom == null) continue;
      const keyAlter = new Array(7).fill(0);
      if (st.key && st.key.type === 'sharp') for (let i = 0; i < st.key.count; i++) keyAlter[SHARP_ORDER[i]] = 1;
      if (st.key && st.key.type === 'flat') for (let i = 0; i < st.key.count; i++) keyAlter[FLAT_ORDER[i]] = -1;
      list.sort((a, b) => a.x - b.x);
      let m = -1, acc = new Map();
      for (const e of list) {
        if (e.measure !== m) { m = e.measure; acc = new Map(); }
        if (e.type !== 'note') continue;
        for (const q of e.pitches) {
          if (q.k == null) continue;
          const d = bottom + (8 - q.k);
          let alter;
          if (q.accidental) { alter = q.accidental === 'sharp' ? 1 : q.accidental === 'flat' ? -1 : 0; acc.set(d, alter); }
          else alter = acc.has(d) ? acc.get(d) : keyAlter[((d % 7) + 7) % 7];
          q.midi = diatonicToMidi(d, alter);
          q.name = noteName(q.midi);
        }
        e.midi = e.pitches[0].midi;
        e.name = e.pitches.map(q => q.name).join('+');
      }
    }

    // Its positions can be off by a note's width or more, enough to cross
    // a barline. Where its notes line up with the notes read here, they
    // take the places read here.
    for (let idx = 0; idx < staves.length; idx++) {
      const hs = H.filter(e => e.staff === idx).sort((a, b) => a.x - b.x);
      const ls = LO.filter(e => e.staff === idx).sort((a, b) => a.x - b.x);
      alignByPlace(hs, ls, D);
    }
    for (const e of H) e.measure = measureAt(e.staff, e.x);

    // Bar by bar: the other reader's notes, unless they do not add up and
    // this page's reading of the bar does (or the two together do).
    // Where its notes fall in its own bars (this keeps its voices and
    // chords); used for a bar of ours made of one whole bar of its.
    const extBarStart = new Map();
    for (const e of H) if (e.extStart != null) extBarStart.set(e.extMeasure, Math.min(extBarStart.has(e.extMeasure) ? extBarStart.get(e.extMeasure) : Infinity, e.extStart));
    const L = typicalBarLength(H);
    const groups = new Map();
    const group = key => { if (!groups.has(key)) groups.set(key, { h: [], lo: [] }); return groups.get(key); };
    for (const e of H) group(e.staff + ':' + e.measure).h.push(e);
    for (const e of LO) group(e.staff + ':' + e.measure).lo.push(e);
    const timed = l => l.length && l.every(e => e.at != null);
    const sum = l => (timed(l) ? Math.max(...l.map(e => e.at + e.beats)) : l.reduce((a, e) => a + (e.wholeRest ? L : e.beats), 0));
    for (const g of groups.values()) {
      const ms = new Set(g.h.map(e => e.extMeasure));
      if (g.h.length < 2 || ms.size !== 1) continue;
      const m = g.h[0].extMeasure;
      const whole = H.filter(e => e.extMeasure === m && e.staff === g.h[0].staff).length === g.h.length;
      if (whole && extBarStart.has(m) && g.h.every(e => e.extStart != null)) for (const e of g.h) e.at = Math.round((e.extStart - extBarStart.get(m)) * 48) / 48;
    }
    const events = [];
    let filled = 0;
    for (const g of groups.values()) {
      const { h, lo } = g;
      // A rest alone in its bar fills the bar.
      if (h.length === 1 && h[0].type === 'rest' && !near(h[0].beats, L)) h[0].beats = L;
      let pick = h;
      if (!near(sum(h), L)) {
        const extra = lo.filter(e => !h.some(f => Math.abs(f.x - e.x) < 0.8 * D));
        const both = h.concat(extra);
        if (extra.length && near(sum(both), L)) pick = both;
        else if (lo.length && near(sum(lo), L)) pick = lo;
        else if (!h.length) pick = lo;
        if (pick !== h) filled++;
      }
      for (const e of pick) {
        if (e.wholeRest) e.beats = L;
        if (pick !== h) delete e.at;
        events.push(e);
      }
    }
    const result = {
      engine: ext.engine || 'external',
      staves, systems, events,
      space: local.space, scale: local.scale,
      toImage: local.toImage, fromImage: local.fromImage,
      tempo: ext.tempo || local.tempo || null,
      warnings: (ext.warnings || []).slice(),
      filledBars: filled
    };
    computeTimeline(result);
    for (const e of events) { delete e.extMeasure; delete e.extStart; }
    result.events.sort((a, b) => (a.staff - b.staff) || (a.start - b.start) || (a.x - b.x));
    return result;
  }

  const api = { recognize, rgbaToGray, noteName, mergeExternal };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.OMR = api;
})(typeof window !== 'undefined' ? window : this);
