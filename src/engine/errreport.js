'use strict';
// 실패·막힘 기록을 개발자 슬랙 채널로 보낸다 (팀 공용 봇 토큰 SLACK_BOT_TOKEN, 채널 ID SLACK_CHANNEL — 빌드 때 앱에 내장).
// 글(요약)은 채널 메시지로, 작업 기록·화면 캡처·화면 HTML 은 그 메시지의 스레드 파일로. 보내기 실패는 조용히 넘긴다 (작업 흐름을 막지 않음).

const API = 'https://slack.com/api/';
// 비밀번호 칸 값은 지움. 속성 순서(value 가 type 보다 앞)·따옴표 모양과 상관없이
const scrubHtml = h => String(h || '').replace(/<input\b[^>]*>/gi, t => /\stype=["']?password\b/i.test(t) ? t.replace(/\svalue=("[^"]*"|'[^']*'|[^\s>]+)/gi, ' value="***"') : t);

async function call(f, token, method, body, form = false) {
  const res = await f(API + method, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8' },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) });
  const j = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!j.ok) throw new Error(`slack ${method}: ${j.error}`);
  return j;
}

/** text: 채널 메시지, files: [{ name, data: Buffer|string }] → 스레드에 파일로 */
async function sendReport({ token, channel, fetch: f = fetch, text, files = [] }) {
  if (!token || !channel) return { skipped: true };
  const msg = await call(f, token, 'chat.postMessage', { channel, text: text.slice(0, 3900), unfurl_links: false });
  const up = [];
  for (const file of files) {
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    if (!data.length) continue;
    try {
      const u = await call(f, token, 'files.getUploadURLExternal', { filename: file.name, length: String(data.length) }, true);
      const put = await f(u.upload_url, { method: 'POST', body: data });
      if (!put.ok) throw new Error(`upload HTTP ${put.status}`);
      up.push({ id: u.file_id, title: file.name });
    } catch (e) { /* 파일 하나 실패는 건너뜀 */ }
  }
  if (up.length) await call(f, token, 'files.completeUploadExternal', { files: up, channel_id: msg.channel, thread_ts: msg.ts });
  return { ts: msg.ts, files: up.length };
}

module.exports = { sendReport, scrubHtml };
