'use strict';
// 워드(.docx)·엑셀(.xlsx) 발주서에서 글자만 뽑는다 (AI 는 PDF·이미지만 직접 읽으므로). 둘 다 zip 안의 XML 이라 압축만 풀면 된다.
// ponytail: zip 은 로컬 파일 헤더를 차례로 읽는 최소 구현 (저장/deflate 만). 암호·분할 zip 은 안 됨 — 사무용 문서엔 없음.

const fs = require('fs');
const zlib = require('zlib');

function zipEntries(file) {
  const buf = fs.readFileSync(file), out = new Map();
  let p = 0;
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8), flags = buf.readUInt16LE(p + 6);
    let csize = buf.readUInt32LE(p + 18), usize = buf.readUInt32LE(p + 22);
    const nlen = buf.readUInt16LE(p + 26), xlen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 30, p + 30 + nlen);
    let start = p + 30 + nlen + xlen;
    if (flags & 8) {   // 크기가 뒤(data descriptor)에 있는 경우: 중앙 디렉터리에서 찾는다
      const cd = centralSizes(buf).get(name); if (!cd) break; csize = cd.csize; usize = cd.usize;
    }
    const raw = buf.subarray(start, start + csize);
    out.set(name, method === 8 ? zlib.inflateRawSync(raw) : raw);
    p = start + csize + ((flags & 8) ? 16 : 0);
    if (flags & 8 && buf.readUInt32LE(p - 16) !== 0x08074b50) p -= 4;   // 서술자 서명 없는 변종
  }
  return out;
}
function centralSizes(buf) {
  const m = new Map();
  let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) return m;
  let p = buf.readUInt32LE(e + 16);
  while (p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50) {
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24), n = buf.readUInt16LE(p + 28), x = buf.readUInt16LE(p + 30), c = buf.readUInt16LE(p + 32);
    m.set(buf.toString('utf8', p + 46, p + 46 + n), { csize, usize });
    p += 46 + n + x + c;
  }
  return m;
}

const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d)).replace(/&amp;/g, '&');
// 변경 추적으로 지운 글자(w:del)·필드 코드(w:instrText)는 빼고, 줄바꿈(w:br)은 살림
const xmlText = (xml, cellBreak) => unesc(String(xml).replace(/<w:del\b[^>]*\/>|<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, '').replace(/<w:instrText\b[^>]*\/>|<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, '').replace(/<w:br\s*\/>/g, '\n').replace(/(<\/w:p>\s*)+<\/w:tc>/g, cellBreak).replace(/<\/w:tr>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '')).replace(/\t+\n/g, '\n');

/** .docx / .xlsx → 글자. 표는 칸을 탭으로, 줄은 줄바꿈으로 */
function officeText(file) {
  const ext = String(file).toLowerCase().split('.').pop();
  if (ext !== 'docx' && ext !== 'xlsx') throw new Error('워드(.docx)·엑셀(.xlsx) 만 읽을 수 있어요. 옛 형식(.doc/.xls)은 저장할 때 새 형식으로 바꿔 주세요.');
  const z = zipEntries(file);
  if (ext === 'docx') {
    const doc = z.get('word/document.xml'); if (!doc) throw new Error('워드 문서 본문을 찾지 못했어요');
    return xmlText(doc.toString('utf8'), '\t').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  if (ext === 'xlsx') {
    const ss = []; const sx = z.get('xl/sharedStrings.xml');
    if (sx) for (const m of sx.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)) ss.push(unesc(m[1].replace(/<[^>]+>/g, '')));
    const sheets = [...z.keys()].filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort();
    const lines = [];
    for (const k of sheets) {
      for (const row of z.get(k).toString('utf8').matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells = [];
        // 빈 칸은 <c r="B2" s="3"/> 로 닫힘 — 이걸 못 보면 다음 칸 내용을 삼켜 열이 밀림. 칸 위치는 r="B2" 의 열 글자로 (빈 칸을 건너뛴 줄도 열이 맞게)
        const colOf = r => { const m = /^([A-Z]+)/.exec(r || ''); return m ? [...m[1]].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1 : cells.length; };
        for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const body = c[2] || '', t = /\bt="([^"]+)"/.exec(c[1]), v = /<v>([\s\S]*?)<\/v>/.exec(body), is = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body);
          const col = colOf((/\br="([^"]+)"/.exec(c[1]) || [])[1]);
          while (cells.length < col) cells.push('');
          cells[col] = t && t[1] === 's' && v ? (ss[Number(v[1])] || '') : t && t[1] === 'inlineStr' && is ? unesc(is[1]) : v ? unesc(v[1]) : '';
        }
        if (cells.some(Boolean)) lines.push(cells.join('\t').replace(/\t+$/, ''));
      }
      lines.push('');
    }
    return lines.join('\n').trim();
  }
  return '';
}

module.exports = { officeText, zipEntries };
