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
        if (n.textContent.includes(f.replace[0])) { n.textContent = n.textContent.replace(f.replace[0], f.replace[1]); done = true; }
      }
      if (!done) result.missing.push(`${[].concat(f.label)[0]}:${f.replace[0]}`);
    }
    if (f.text !== undefined) { setText(td, f.text); result.filled.push([].concat(f.label)[0]); }
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
        if (!row) {
          const last = tbody.lastElementChild;
          row = last.cloneNode(true);
          Array.from(row.querySelectorAll('td')).forEach(td => setText(td, ''));
          tbody.appendChild(row);
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

module.exports = { FILL_JS, FIND_JS, applyPayload, reportPayload };
