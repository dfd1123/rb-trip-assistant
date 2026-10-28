'use strict';
// 전자결재 팝업 본문(dzEditor iframe) 채우기.
// 라벨 셀 텍스트로 값 셀을 찾고, 체크박스는 바로 뒤 글자로 찾는다. 체크 상태는 checked 속성까지 넣는다.
// 실제 '출장신청 및 출장경비 사전품의' 양식 HTML(test/fixtures)로 검증됨.

// 페이지(iframe) 안에서 실행되는 함수. 문자열로 보내기 위해 toString() 사용.
const fillForm = (payload) => {
  const norm = s => (s || '').replace(/[\s\u200b\u00a0]/g, '');
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const doc = document;
  const cells = () => Array.from(doc.querySelectorAll('td,th'));
  const result = { filled: [], missing: [] };

  const findLabel = (labels) => {
    for (const label of [].concat(labels)) {
      const hit = cells().find(td => norm(td.textContent) === norm(label));
      if (hit) return hit;
    }
    return null;
  };

  // 라벨 오른쪽 셀, 없으면(세로 배치) 아래 행의 첫 셀
  const valueCell = (labelTd) => {
    let sib = labelTd.nextElementSibling;
    while (sib && !/^(TD|TH)$/.test(sib.tagName)) sib = sib.nextElementSibling;
    if (sib) return sib;
    const tr = labelTd.parentElement;
    const next = tr && tr.nextElementSibling;
    return next ? next.querySelector('td,th') : null;
  };

  const setText = (td, text) => {
    const lines = String(text ?? '').split(/\r?\n/);
    let p = td.querySelector('p');
    if (!p) { p = doc.createElement('p'); td.appendChild(p); }
    const span = p.querySelector('span');
    // 안내 문구 스타일(빨간 기울임 "정부과제의 경우 과제명 기입 필수")은 물려받지 않는다
    const style = ((span && span.getAttribute('style')) || 'font-size:10pt;').replace(/color:[^;]*;?|font-style:[^;]*;?/g, '') || 'font-size:10pt;';
    p.innerHTML = `<span style="${style}">${lines.map(esc).join('<br />') || '<br />'}</span>`;
    Array.from(td.querySelectorAll('p')).slice(1).forEach(x => x.remove());
  };

  // 체크박스 i 뒤에 오는 글자(다음 체크박스 전까지)
  const optionTexts = (td) => {
    const inputs = Array.from(td.querySelectorAll('input[type=checkbox]'));
    const walker = doc.createTreeWalker(td, NodeFilter.SHOW_ALL);
    const seg = inputs.map(() => '');
    let cur = -1, n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 1 && n.tagName === 'INPUT' && n.type === 'checkbox') cur = inputs.indexOf(n);
      else if (n.nodeType === 3 && cur >= 0) seg[cur] += n.textContent;
    }
    return inputs.map((el, i) => ({ el, text: norm(seg[i]) }));
  };

  const check = (td, options) => {
    const want = [].concat(options).map(norm);
    const found = [];
    for (const { el, text } of optionTexts(td)) {
      const on = want.some(w => text.startsWith(w));
      el.checked = on;
      if (on) { el.setAttribute('checked', 'checked'); found.push(text); }
      else el.removeAttribute('checked');
    }
    return found;
  };

  for (const f of payload.fields) {
    const label = findLabel(f.label);
    const td = label && valueCell(label);
    if (!td) { result.missing.push([].concat(f.label)[0]); continue; }
    if (f.check) {
      const found = check(td, f.check);
      if (found.length < [].concat(f.check).length) result.missing.push(`${[].concat(f.label)[0]}:${f.check}`);
      else result.filled.push([].concat(f.label)[0]);
    }
    if (f.replace) {
      const w = doc.createTreeWalker(td, NodeFilter.SHOW_TEXT);
      let n, done = false;
      while ((n = w.nextNode())) {
        if (n.textContent.includes(f.replace[0])) { n.textContent = n.textContent.replace(f.replace[0], () => f.replace[1]); done = true; }   // 바꿀 글자는 함수로: 넣는 글자의 '$&'·'$$' 를 특수 기호로 해석하지 않게
      }
      if (!done) result.missing.push(`${[].concat(f.label)[0]}:${f.replace[0]}`);
    }
    if (f.text !== undefined) { setText(td, f.text); result.filled.push([].concat(f.label)[0]); }
    if (f.html !== undefined) { td.innerHTML = f.html; result.filled.push([].concat(f.label)[0]); }   // 링크·이미지가 든 칸
    if (f.checkLabel) {   // 체크박스가 라벨 칸 안에 있는 경우 (예: "합계 금액( ☐VAT포함 ☐VAT미포함)")
      const found = check(label, f.checkLabel);
      if (found.length < [].concat(f.checkLabel).length) result.missing.push(`${[].concat(f.label)[0]}:${f.checkLabel}`);
    }
    if (f.input !== undefined) {   // 값 칸 안의 글자 입력칸 (예: 프로젝트명 '기타' 옆)
      const inp = td.querySelector('input[type=text]');
      if (inp) { inp.value = f.input; inp.setAttribute('value', f.input); }
      else result.missing.push(`${[].concat(f.label)[0]}:input`);
    }
  }

  if (payload.table) {
    // 헤더 행(예: 일자/장소/세부 활동...)을 찾아 아래 행부터 채운다. 모자라면 마지막 행을 복제.
    const t = payload.table;
    const head = cells().find(td => norm(td.textContent) === norm(t.header));
    if (!head) result.missing.push(`table:${t.header}`);
    else {
      const headRow = head.parentElement;
      const tbody = headRow.parentElement;
      let row = headRow.nextElementSibling;
      t.rows.forEach((vals, i) => {
        // 빈 행이 모자라면: 합계 행 앞에 바로 위 행을 복제해 끼움, 합계 행이 없으면 맨 뒤에.
        // 합계 행 = 머리 행과 칸 구조(칸 수·합친 칸)가 다른 행. 실제 보고서 일정 표는 데이터 행도 '세부 활동'이 2칸 합쳐져 있어 colspan 만으론 못 가름
        const shape = r => Array.from(r.querySelectorAll('td')).map(td => td.colSpan).join(',');
        const isSum = r => r && shape(r) !== shape(headRow);
        if (!row || isSum(row)) {
          const src = row ? row.previousElementSibling : tbody.lastElementChild;
          const clone = src.cloneNode(true);
          Array.from(clone.querySelectorAll('td')).forEach(td => setText(td, ''));
          if (row) tbody.insertBefore(clone, row); else tbody.appendChild(clone);
          row = clone;
        }
        const tds = Array.from(row.querySelectorAll('td'));
        vals.forEach((v, j) => { if (tds[j]) setText(tds[j], v); });
        row = row.nextElementSibling;
      });
      result.filled.push(`table:${t.header}(${t.rows.length})`);
    }
  }

  // 에디터가 변경을 인식하도록 이벤트 발생
  const root = doc.querySelector('[contenteditable=true]') || doc.body;
  ['input', 'keyup', 'change'].forEach(ev => root.dispatchEvent(new Event(ev, { bubbles: true })));
  return result;
};

const hasLabel = (label) => {
  const norm = s => (s || '').replace(/[\s\u200b\u00a0]/g, '');
  return Array.from(document.querySelectorAll('td,th')).some(td => norm(td.textContent) === norm(label));
};

const FILL_JS = fillForm.toString();
const FIND_JS = hasLabel.toString();

function applyPayload(a) {
  const t = a.transport;
  const overseas = a.scope === '해외';
  const fields = [
    ...(overseas ? [{ label: '해외', check: [a.overseas.grade] }] : [{ label: '국내', text: a.destination }]),   // 해외: 가·나 등급 체크 (국가·도시는 출장목적에)
    { label: '출장일', text: a.period },
    { label: '구분', check: [a.category] },
    ...(overseas ? [] : [{ label: '교통편', check: t.check }]),
    { label: '동행자', text: a.companions.join(', ') },
    { label: '동행목적', text: a.companion_purpose },
    { label: ['출장목적(상세기입)', '출장목적'], text: a.purpose },
  ];
  if (a.category === '연구과제' && a.project) fields.push({ label: '구분', replace: ['과제명', a.project] });
  if (t.mode === 'corporate' && t.corporate_car) fields.push({ label: '법인차량이용시', check: [t.corporate_car] });
  return { fields };
}

function reportPayload(r) {
  const fields = [
    { label: '성명', text: r.name },
    { label: '동행자', text: r.companions.join(', ') },
    { label: '출장구분', check: [r.category] },
    { label: '출장일시', text: r.period },
    { label: '출장지', text: r.destination },
    { label: '출장시방문기관', text: r.visit_org },
    { label: '출장목적', text: r.purpose },
    { label: '출장시담당업무및보고사항', text: r.report },
  ];
  if (r.project) fields.push({ label: '과제구분', text: r.project });
  const payload = { fields };
  if (r.schedule.length) payload.table = { header: '일자', rows: r.schedule.map(s => [s.date, s.place, s.detail]) };
  return payload;
}

/** 구매의뢰서 본문 (실제 양식 HTML: test/fixtures/purchase_body.html) */
function purchasePayload(p, { shotDataUrl = '' } = {}) {
  const won = n => Math.round(Number(n) || 0).toLocaleString('ko-KR');
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const dues = [...new Set(p.items.map(i => i.due).filter(Boolean))];
  // 제품 페이지로 올리는 경우: 사유 칸에 링크 + 페이지 캡처 + 글 (캡처 파일은 첨부로도)
  const reasonField = p.link
    ? { label: '구매 상세 사유', html: `<p><span style="font-size:10pt;"><a href="${esc(p.link.url)}" target="_blank">${esc(p.link.title || p.link.url)}</a></span></p>${shotDataUrl ? `<p style="margin:6px 0;"><img src="${shotDataUrl}" style="max-width:100%;display:block;" alt="제품 페이지" /></p><p><br /></p>` : ''}<p style="margin-top:8px;"><span style="font-size:10pt;">${esc(p.reason).replace(/\r?\n/g, '<br />')}</span></p>` }
    : { label: '구매 상세 사유', text: p.reason };
  const fields = [
    { label: '합계금액(VAT포함VAT미포함)', text: `${won(p.total)}원`, checkLabel: [p.vat_included ? 'VAT포함' : 'VAT미포함'] },
    { label: '구매목적', check: [p.purpose], ...(p.purpose === '기타' ? { replace: ['__________________', p.purpose_etc] } : {}) },
    { label: '프로젝트명', check: [p.project], ...(p.project === '기타' ? { input: p.project_etc } : {}) },
    reasonField,
    { label: '긴급도', check: [p.urgency] },
    { label: '납기 요청일자', text: dues.length <= 1 ? (dues[0] || '') : p.items.filter(i => i.due).map(i => `${i.name}: ${i.due}`).join('\n') },
    { label: '대체 가능 여부', check: [p.substitutable ? '대체 가능' : '대체 불가'] },
    { label: '담당자', text: [p.vendor.name, p.vendor.contact].filter((x, i, a) => x && a.indexOf(x) === i).join(' / ') },   // 거래처명 / 담당자명 (하나만 있으면 그것만)
    { label: '연락처', text: p.vendor.phone },
    { label: '이메일', text: p.vendor.email },
  ];
  // 구매 요청 내역: 거래처 · 품번(목록 순서 1,2,3) · 품명(규격·모델은 괄호로) · 단위 · 발주수량 · 단가 · 공급가액 · 비고(납기 요청일자)
  const table = { header: '거래처', rows: p.items.map((i, n) => [p.vendor.name, String(n + 1), i.part_no && !i.name.includes(i.part_no) ? `${i.name} (${i.part_no})` : i.name, i.unit, String(i.qty), won(i.unit_price), won(i.amount), [i.due && `납기 ${i.due}`, i.note].filter(Boolean).join(' / ')]) };   // 비고 = 납기 요청일 + 비고
  return { fields, table };
}

module.exports = { FILL_JS, FIND_JS, applyPayload, reportPayload, purchasePayload };
