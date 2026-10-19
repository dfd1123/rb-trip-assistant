'use strict';
// 개인 API 키로 문장 작성 (Claude / OpenAI / Gemini). 키가 없거나 실패하면 호출한 쪽이 템플릿으로 대체한다.
// 금액은 AI 에게 맡기지 않는다 — 항상 규정(quick.computeExpenses)으로 계산.

const R = require('./rules');

const PROVIDERS = {
  anthropic: { label: 'Claude', model: 'claude-haiku-5-5' },
  openai: { label: 'OpenAI', model: 'gpt-4o-mini' },
  gemini: { label: 'Gemini', model: 'gemini-3.5-flash-lite', fallback: ['gemini-flash-lite-latest'] },   // 3.8-flash 는 무료 티어에서 503 잦음, 3.5-flash 는 생각이 길어 45초 초과
};

async function post(url, headers, body, timeoutMs = 45000) {
  // 503(혼잡)·429(한도)·529 는 잠깐 뒤 다시 (최대 3회: 2초, 5초 간격)
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
      const json = await res.json().catch(() => ({}));
      if (res.ok) return json;
      if ([429, 503, 529].includes(res.status) && attempt < 2) { await new Promise(r => setTimeout(r, [2000, 5000][attempt])); continue; }
      const msg = (json.error && (json.error.message || json.error.type)) || res.statusText;
      throw new Error(`AI 호출 실패 (${res.status}): ${msg}${res.status === 404 ? ' — 설정에서 모델 이름을 확인해 주세요.' : ''}`);
    } finally { clearTimeout(t); }
  }
}

/** @returns {Promise<string>} 모델 답변 텍스트 */
async function complete({ provider, model, key }, prompt) {
  const p = PROVIDERS[provider];
  if (!p || !key) throw new Error('AI 키가 설정되지 않았습니다.');
  model = model || p.model;
  if (provider === 'anthropic') {
    const j = await post('https://api.anthropic.com/v1/messages',
      { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      { model, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] });
    return (j.content || []).map(c => c.text || '').join('');
  }
  if (provider === 'openai') {
    const j = await post('https://api.openai.com/v1/chat/completions', { authorization: `Bearer ${key}` },
      { model, messages: [{ role: 'user', content: prompt }] });
    return j.choices[0].message.content;
  }
  // 혼잡(503)·시간 초과면 가벼운 모델로 한 번 더
  const models = [model, ...(p.fallback || []).filter(m => m !== model)];
  let last;
  for (const m of models) {
    try {
      const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`,
        { 'x-goog-api-key': key }, { contents: [{ parts: [{ text: prompt }] }] });
      return j.candidates[0].content.parts.map(x => x.text || '').join('');
    } catch (e) { last = e; if (!/\(503\)|\(429\)|aborted/.test(e.message)) throw e; }
  }
  throw last;
}

/** 파일(이미지·PDF)과 함께 묻기. files: [{ mime, data(base64) }] — Gemini·Claude 는 이미지·PDF, OpenAI 는 이미지만 */
async function completeWithFiles({ provider, model, key }, prompt, files) {
  const p = PROVIDERS[provider];
  if (!p || !key) throw new Error('AI 키가 설정되지 않았습니다.');
  model = model || p.model;
  if (provider === 'anthropic') {
    const blocks = files.map(f => f.mime === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: f.mime, data: f.data } }
      : { type: 'image', source: { type: 'base64', media_type: f.mime, data: f.data } });
    const j = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      { model, max_tokens: 2000, messages: [{ role: 'user', content: [...blocks, { type: 'text', text: prompt }] }] }, 90000);
    return (j.content || []).map(c => c.text || '').join('');
  }
  if (provider === 'openai') {
    if (files.some(f => f.mime === 'application/pdf')) throw new Error('OpenAI 로는 PDF 영수증을 읽지 못해요. 설정에서 Gemini 를 써 주세요.');
    const j = await post('https://api.openai.com/v1/chat/completions', { authorization: `Bearer ${key}` },
      { model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...files.map(f => ({ type: 'image_url', image_url: { url: `data:${f.mime};base64,${f.data}` } }))] }] }, 90000);
    return j.choices[0].message.content;
  }
  const models = [model, ...(p.fallback || []).filter(m => m !== model)];
  let last;
  for (const m of models) {
    try {
      const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, { 'x-goog-api-key': key },
        { contents: [{ parts: [...files.map(f => ({ inline_data: { mime_type: f.mime, data: f.data } })), { text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } }, 90000);
      return j.candidates[0].content.parts.map(x => x.text || '').join('');
    } catch (e) { last = e; if (!/\(503\)|\(429\)|aborted/.test(e.message)) throw e; }
  }
  throw last;
}

/** 영수증·증빙 한 장(파일 하나)을 읽어 경비로 분류. 파일 하나에 영수증이 여러 장이면 여러 개.
 *  items: { key: '예산과목 이름' } → [{ item, amount, date, vendor, memo }] (영수증이 아니면 []) */
async function readReceipt(ai, file, items, period = '', rates = {}) {
  const list = Object.entries(items).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  const prompt = `이 파일은 회사 국내·해외 출장 정산에 붙일 영수증이나 증빙이야. 결제 내역을 읽어서 JSON 배열로만 답해.
각 항목: {"item": 예산과목 키, "amount": 결제 금액(원, 숫자만), "date": "YYYY-MM-DD" 또는 "", "vendor": 가게·회사 이름, "people": 식대면 몇 명이 먹었는지 (숫자), 아니면 0, "memo": 무엇에 쓴 돈인지 10자 안팎. 식대는 인원과 끼니로 (예: "1인 조식", "2인 석식"), 숙박은 "숙박 1박", 교통은 "KTX 서울-부산" 식}
예산과목 키 (이 중 하나만):
${list}
규칙:
- 숙박(호텔·모텔·숙소) → domestic_lodging, 음식점·카페·편의점 식사 → meal, 주유·통행료·택시·버스·기차·KTX·주차 → domestic_transport. 해외면 overseas_* 나 airfare.
- 금액은 실제 결제한 총액(부가세 포함). 통화가 원이 아니면 원으로 바꾸지 말고 그 숫자를 넣고 memo 에 통화를 적어.
- 식대 인원(people): 영수증에 인원·메뉴 수량이 보이면 그걸로, 안 보이면 금액으로 짐작해 (회사 식대 기준 1인 한 끼: 조식 ${rates.breakfast || 8000}원·중식 ${rates.lunch || 15000}원·석식 ${rates.dinner || 15000}원). memo 의 "N인"도 같은 수로.
- 한 파일에 영수증이 여러 장이면 각각 따로. 영수증·결제 내역이 아니면 [].
${period ? `- 출장 기간: ${period}` : ''}`;
  const text = await completeWithFiles(ai, prompt, [file]);
  const m = /\[[\s\S]*\]/.exec(text);
  let arr = []; try { arr = JSON.parse(m ? m[0] : text); } catch (e) { throw new Error('AI 답을 읽지 못했어요'); }
  if (!Array.isArray(arr)) arr = [arr];
  return arr.map(r => ({ item: items[r.item] ? r.item : '', amount: Math.round(Number(String(r.amount ?? '').replace(/[^\d.]/g, '')) || 0),
    date: String(r.date || ''), vendor: String(r.vendor || '').slice(0, 40), memo: String(r.memo || '').slice(0, 40), people: Math.max(0, Math.round(Number(r.people) || 0)) })).filter(r => r.amount > 0 || r.item);
}

/** 발주서(PDF·이미지 파일, 또는 워드·엑셀에서 뽑은 글자) → 거래처·품목·금액. 못 읽는 값은 빈 글자/0 */
async function readPurchaseOrder(ai, file, text = '') {
  const prompt = `이 파일은 우리 회사(레인보우로보틱스)가 받은 견적서나 거래처에 보낸 발주서야. 내용을 읽어 JSON 하나로만 답해:
{"vendor": {"name": 공급 업체 회사 이름, "address": 주소, "contact": 공급 업체 담당자 이름, "phone": 담당자 전화번호 또는 "", "email": 담당자 이메일 또는 ""},
 "order_date": "YYYY-MM-DD" 또는 "",
 "items": [{"name": 사람이 알아볼 품목 이름 (예: "PCB 제작", "모션 컨트롤러"). 모델명·파일명 같은 긴 코드는 넣지 말고 무엇인지로,
   "part_no": 모델명·규격 (예: "261012_JMD40DRV8350RH_V4.0.0_GERBER, FR-4 4층 1.6T 금도금", "Ez-ML-PE-RSA"). 없으면 "",
   "unit": 수량 단위 — EA·PCS·SET·M 같은 단위만 (없으면 "EA"). "Sample"·"Lot" 같은 건 단위가 아님,
   "qty": 수량(숫자), "unit_price": 1개 단가(원, 숫자). 단가 칸이 숫자가 아니면(Sample·Lot 등) 금액 ÷ 수량,
   "amount": 공급가액(원, 숫자), "urgency": "긴급" 또는 "일반" 또는 ""}],
 "supply": 공급가액 합계(원, 숫자), "vat": 부가세(원, 숫자, 없으면 0), "total": 합계(원, 숫자),
 "summary": 구매 결재자가 알아야 할 중요 정보 3~8줄 배열. 한 줄에 하나씩 짧게 "항목: 내용" 꼴 (예: "모델명: 261012_JMD40DRV8350RH_V4.0.0_GERBER", "사양: FR-4 4층 1.6T, 동박 내층 1oz/외층 2oz, PSR 노랑·SILK 검정, 금도금", "수량: 50 PCS (샘플)", "금액: 1,460,000원 (부가세 별도)", "발송 예정: 10/19", "결제 조건: 익월말 현금결제", "견적 유효기간: 작성일로부터 7일"). 문서에 없는 건 쓰지 마}
규칙: 공급 업체(공급자·판매자) 정보를 vendor 에 넣어. 레인보우로보틱스 쪽(수신자) 담당자는 넣지 마. 숫자는 쉼표·통화 기호 없이. 모르면 "" 또는 0.
"부가세 별도"면 vat 는 0 이고 total 은 공급가액 합계.`;
  const out = file ? await completeWithFiles(ai, prompt, [file]) : await complete(ai, `${prompt}\n\n--- 발주서 내용 (표는 탭으로 구분) ---\n${text}`);
  const m = /\{[\s\S]*\}/.exec(out);
  let j; try { j = JSON.parse(m ? m[0] : out); } catch (e) { throw new Error('AI 가 발주서를 읽지 못했어요'); }
  const num = v => Math.round(Number(String(v ?? '').replace(/[^\d.-]/g, '')) || 0), str = (v, n = 80) => String(v || '').trim().slice(0, n);
  const v = j.vendor || {};
  return { vendor: { name: str(v.name), address: str(v.address, 120), contact: str(v.contact, 40), phone: str(v.phone, 40), email: str(v.email) }, order_date: str(j.order_date, 10),
    items: (Array.isArray(j.items) ? j.items : []).map(i => ({ name: str(i.name), part_no: str(i.part_no), unit: str(i.unit, 10) || 'EA', qty: num(i.qty) || 1, unit_price: num(i.unit_price), amount: num(i.amount), due: '', urgency: /긴급/.test(String(i.urgency || '')) ? '긴급' : '' })).filter(i => i.name),
    supply: num(j.supply), vat: num(j.vat), total: num(j.total), summary: (Array.isArray(j.summary) ? j.summary : []).map(x => str(x, 160)).filter(Boolean).slice(0, 10) };
}

/** 제품 페이지(캡처 이미지 + 글자) → 품목·가격·판매처. 못 읽는 값은 빈 글자/0 */
async function readProductPage(ai, { url, title, text, shot }) {
  const prompt = `이 이미지는 온라인 쇼핑몰·부품 판매 사이트의 제품 페이지 캡처이고, 아래는 그 페이지 글자야. 회사 구매의뢰서에 쓸 정보를 JSON 하나로만 답해:
{"name": 제품명 (옵션 포함해 사람이 알아볼 이름), "part_no": 모델명·규격·옵션 (없으면 ""), "unit": 단위 (없으면 "EA"), "unit_price": 1개 가격(원, 숫자, 옵션 추가금 포함), "qty": 페이지에 수량이 보이면 그 수, 아니면 1,
 "price_vat": unit_price 가 부가세 포함 가격이면 "포함", 'VAT 별도' 가격이면 "별도", 모르면 "" (부가세 포함·별도 가격이 둘 다 보이면 별도 가격을 unit_price 로),
 "vendor": {"name": 판매 회사(상호) 이름, "phone": 고객센터·대표 전화 또는 "", "email": 이메일 또는 ""},
 "note": 구매 시 주의할 점·옵션 선택 등 메모 (없으면 ""),
 "summary": 구매 결재자가 알아야 할 중요 정보 3~6줄 배열, "항목: 내용" 꼴 (예: "제품명: …", "옵션: 1.0M", "판매가: 4,000원 (부가세 포함)", "제조사: …", "배송비: 주문 시 결제"). 페이지에 없는 건 쓰지 마}
규칙: 숫자는 쉼표·통화 기호 없이. 상호·전화·이메일은 보통 페이지 아래쪽 사업자 정보에 있어. 모르면 "" 또는 0.
페이지 주소: ${url}
페이지 제목: ${title}
--- 페이지 글자 ---
${String(text || '').slice(0, 12000)}`;
  const out = shot ? await completeWithFiles(ai, prompt, [shot]) : await complete(ai, prompt);
  const m = /\{[\s\S]*\}/.exec(out);
  let j; try { j = JSON.parse(m ? m[0] : out); } catch (e) { throw new Error('AI 가 제품 페이지를 읽지 못했어요'); }
  const num = v => Math.round(Number(String(v ?? '').replace(/[^\d.-]/g, '')) || 0), str = (v, n = 80) => String(v || '').trim().slice(0, n);
  const v = j.vendor || {};
  return { price_vat: /별도/.test(String(j.price_vat || '')) ? 'excl' : 'incl', name: str(j.name, 120), part_no: str(j.part_no), unit: str(j.unit, 10) || 'EA', unit_price: num(j.unit_price), qty: num(j.qty) || 1, note: str(j.note, 200),
    vendor: { name: str(v.name), phone: str(v.phone, 40), email: str(v.email) }, summary: (Array.isArray(j.summary) ? j.summary : []).map(x => str(x, 160)).filter(Boolean).slice(0, 10) };
}

/** 메모 + 발주 내용 → 결재 제목용 짧은 설명, '구매 상세 사유', 그리고 (안 골랐으면) 구매목적·프로젝트명 추천 */
async function draftPurchase(ai, { memo, purpose, project, vendor, items }) {
  const prompt = `회사 전자결재 '구매의뢰서'에 쓸 글을 써 줘. JSON 하나로만 답해:
{"desc": 결재 제목에 들어갈 짧은 설명 — 메모 한 줄을 바탕으로 15~25자 (예: "협동로봇 주변기기용 글로벌 셔터 카메라", "양팔로봇용 무선 LAN 안테나 연장선"). 제품 모델명·영문 코드·수량·프로젝트 이름은 넣지 마 (제목 앞에 [구매의뢰서 - 프로젝트]가 따로 붙음),
 "reason": 구매 상세 사유 2~4문장 (무엇을, 어디에, 왜 사는지. 존댓말 평서문, 과장 없이). 사양·금액 같은 제품 상세는 아래에 따로 붙으니 넣지 마}
구매목적: ${purpose || ''}
프로젝트: ${project || ''}
거래처: ${vendor || ''}
품목: ${(items || []).map(i => `${i.name}${i.part_no ? ` (${i.part_no})` : ''} ${i.qty}${i.unit || 'EA'}`).join(', ')}
메모: ${memo || ''}`;
  const text = await complete(ai, prompt);
  const m = /\{[\s\S]*\}/.exec(text);
  let j = {}; try { j = JSON.parse(m ? m[0] : text); } catch (e) { return { desc: '', reason: String(text || '').trim().slice(0, 600) }; }
  let desc = String(j.desc || '').trim().replace(/\s*(구매\s*요청|구매|요청)(의\s*건)?\s*$/, '');
  for (const t of [project].filter(Boolean)) desc = desc.replace(new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(프로젝트|과제)?(용|의)?\\s*`), '');   // 앞에 프로젝트 이름이 오면 뺌
  desc = desc.slice(0, 40);   // 제목이 '… 구매 요청의 건'으로 끝나니 설명엔 '구매' 빼기
  return { desc, reason: String(j.reason || '').trim().slice(0, 1200) };   // 구매목적·프로젝트명은 사람이 고름
}

const WEEK = '일월화수목금토';
function todayLine(today = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())} (${WEEK[today.getDay()]}요일)`;
}

/** 한 줄 메모 → 신청서 YAML (금액 제외) */
async function draftApply(ai, memo, { places = [], today = new Date() } = {}) {
  const known = places.length ? `\n자주 가는 곳(이름을 그대로 써): ${places.map(p => p.name).join(' / ')}` : '';
  const prompt = R.applyPrompt(todayLine(today)).replace('- 금액을 모르면 그 줄은 빼. 지어내지 마.', '- expenses 는 쓰지 마 (앱이 회사 규정으로 계산함).') + known + '\n' + memo;
  return R.extractYaml(await complete(ai, prompt));
}

/** 보고서 초안 + 메모 → 보고서 YAML */
async function draftReport(ai, draft, memo) {
  const { expenses, attachments, trip_id, ...rest } = draft;
  return R.extractYaml(await complete(ai, R.reportPrompt(rest) + memo));
}

module.exports = { PROVIDERS, complete, completeWithFiles, readReceipt, readPurchaseOrder, readProductPage, draftPurchase, draftApply, draftReport };
