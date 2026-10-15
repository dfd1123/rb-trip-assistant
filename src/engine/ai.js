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

module.exports = { PROVIDERS, complete, draftApply, draftReport };
