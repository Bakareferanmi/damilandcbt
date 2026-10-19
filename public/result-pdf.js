// Builds the student's result slip as a real PDF file, right in the browser (no library, nothing uploaded).
// Same layout as the printed slip: logo, details, score table, signature lines. One A4 page.
//
//   const bytes = buildResultPdf({ examName, slip, results, logo })   // -> Uint8Array
//   slip    = { fullName, code, className, groupNo, submittedAt, sessionName }
//   results = [{ subject, score, total }, ...]
//   logo    = { bytes: Uint8Array (a JPEG), width, height }  or null
(function () {
  const PW = 595.28, PH = 841.89, M = 40; // A4 in points, page margin

  // Helvetica character widths (units of 1/1000 em) for ASCII 32..126, used to right-align and centre text.
  const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
  const BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

  // PDF's built-in fonts understand Windows-1252. Keep what fits, drop accents from the rest (ọ -> o), else "?".
  const CP1252 = { 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97 };
  const fits = (c) => (c >= 32 && c <= 126) || (c >= 160 && c <= 255) || CP1252[c];
  function latin(str) {
    let out = '';
    for (const ch of String(str ?? '').normalize('NFC')) {
      let c = ch.codePointAt(0);
      if (!fits(c)) c = ch.normalize('NFD').codePointAt(0); // base letter without its accent
      out += fits(c) ? String.fromCharCode(CP1252[c] || c) : '?';
    }
    return out;
  }
  const bytesOf = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 255);
  const widthOf = (s, bold, size) => {
    let w = 0;
    for (const ch of s) { const c = ch.charCodeAt(0); w += c >= 32 && c <= 126 ? (bold ? BOLD : HELV)[c - 32] : 556; }
    return (w * size) / 1000;
  };
  const num = (n) => String(Math.round(n * 100) / 100);
  const esc = (s) => s.replace(/[\\()]/g, (c) => '\\' + c);
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 + '%' : '-');
  const rgb = (hex) => [1, 3, 5].map((i) => num(parseInt(hex.slice(i, i + 2), 16) / 255)).join(' ');

  function buildResultPdf({ examName, slip, results, logo }) {
    const ops = [];
    const y = (top) => PH - top; // measure from the top of the page like on screen
    const fill = (hex) => ops.push(rgb(hex) + ' rg');
    const stroke = (hex) => ops.push(rgb(hex) + ' RG');
    const rect = (x, top, w, h, mode) => ops.push(`${num(x)} ${num(y(top + h))} ${num(w)} ${num(h)} re ${mode}`);
    const line = (x1, top1, x2, top2, wd) => ops.push(`${num(wd)} w ${num(x1)} ${num(y(top1))} m ${num(x2)} ${num(y(top2))} l S`);
    // align: 'l' (x is the left edge), 'r' (x is the right edge), 'c' (x is the centre)
    function text(str, x, baseline, size, { bold = false, color = '#000000', align = 'l' } = {}) {
      const s = latin(str), w = widthOf(s, bold, size);
      const left = align === 'r' ? x - w : align === 'c' ? x - w / 2 : x;
      fill(color);
      ops.push(`BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${num(left)} ${num(y(baseline))} Td (${esc(s)}) Tj ET`);
    }
    const BLUE = '#01309F', GREY = '#555555', EDGE = '#444444';
    const right = PW - M, inner = PW - 2 * M;

    // ---- header ----
    let textLeft = M;
    if (logo) {
      ops.push(`q 56 0 0 56 ${num(M)} ${num(y(40 + 56))} cm /Im1 Do Q`);
      textLeft = M + 70;
    }
    text('Damiland CBT', textLeft, 66, 20, { bold: true, color: BLUE });
    text('Computer-Based Test', textLeft, 82, 10, { color: '#333333' });
    text(examName || '', right, 60, 11, { bold: true, align: 'r' });
    text('Session ' + (slip.sessionName || ''), right, 76, 11, { bold: true, align: 'r' });
    fill(BLUE); rect(M, 104, inner, 2.25, 'f');

    // ---- title ----
    text('EXAMINATION RESULT SLIP', PW / 2, 146, 14, { bold: true, align: 'c' });

    // ---- details ----
    const date = slip.submittedAt
      ? new Date(String(slip.submittedAt).replace(' ', 'T') + 'Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
      : '';
    const details = [['Name', slip.fullName], ['Student code', slip.code], ['Class', slip.className], ['Subject group', 'Group ' + slip.groupNo]];
    if (date) details.push(['Date of exam', date]);
    let top = 182;
    for (const [k, v] of details) {
      text(k, M, top, 10.5, { color: GREY });
      text(v, M + 120, top, 11, { bold: true });
      top += 22;
    }

    // ---- score table ----
    const sum = results.reduce((a, r) => a + r.score, 0), tot = results.reduce((a, r) => a + r.total, 0);
    const cols = [inner - 270, 90, 90, 90]; // Subject, Score, Out of, Percent
    const heads = ['Subject', 'Score', 'Out of', 'Percent'];
    const rows = results.map((r) => [r.subject, r.score, r.total, pct(r.score, r.total)]);
    const all = [{ cells: heads, kind: 'head' }, ...rows.map((cells) => ({ cells, kind: 'row' })), { cells: ['Total', sum, tot, pct(sum, tot)], kind: 'tot' }];
    const RH = 26;
    top += 8;
    stroke(EDGE);
    all.forEach((row, i) => {
      const rowTop = top + i * RH;
      if (row.kind !== 'row') { fill(row.kind === 'head' ? '#E8EEFC' : '#F4F6FC'); rect(M, rowTop, inner, RH, 'f'); }
      let x = M;
      row.cells.forEach((cell, c) => {
        ops.push('0.75 w'); stroke(EDGE); rect(x, rowTop, cols[c], RH, 'S');
        const bold = row.kind !== 'row';
        if (c === 0) text(String(cell), x + 10, rowTop + 17, 11, { bold });
        else text(String(cell), x + cols[c] - 10, rowTop + 17, 11, { bold, align: 'r' });
        x += cols[c];
      });
    });
    top += all.length * RH;

    // ---- signatures ----
    const sigTop = top + 80, half = (inner - 32) / 2;
    stroke('#000000');
    line(M, sigTop, M + half, sigTop, 0.75);
    line(M + half + 32, sigTop, right, sigTop, 0.75);
    text('Exam officer', M + half / 2, sigTop + 16, 10, { align: 'c' });
    text('Principal', M + half + 32 + half / 2, sigTop + 16, 10, { align: 'c' });

    // ---- footer ----
    const printed = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    text('Printed on ' + printed, PW / 2, PH - 36, 8.5, { color: GREY, align: 'c' });

    return assemble(ops.join('\n'), logo);
  }

  // Lays the objects out as a valid PDF 1.4 file with its cross-reference table.
  function assemble(contentOps, logo) {
    const chunks = [];
    let len = 0;
    const offsets = [];
    const push = (b) => { const u = typeof b === 'string' ? bytesOf(b) : b; chunks.push(u); len += u.length; };
    const obj = (n, dict, stream) => {
      offsets[n] = len;
      push(`${n} 0 obj\n${dict}\n`);
      if (stream) { push('stream\n'); push(stream); push('\nendstream\n'); }
      push('endobj\n');
    };
    const content = bytesOf(contentOps);
    push('%PDF-1.4\n%âãÏÓ\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >>${logo ? ' /XObject << /Im1 7 0 R >>' : ''} >> /Contents 4 0 R >>`);
    obj(4, `<< /Length ${content.length} >>`, content);
    obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    obj(6, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    if (logo) obj(7, `<< /Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${logo.bytes.length} >>`, logo.bytes);
    const count = logo ? 8 : 7;
    const xref = len;
    let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let n = 1; n < count; n++) table += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
    push(table + `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(len);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  if (typeof window !== 'undefined') window.buildResultPdf = buildResultPdf;
  if (typeof module !== 'undefined') module.exports = { buildResultPdf };
})();
