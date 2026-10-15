'use strict';
// 빌드 전에 GEMINI_API_KEY 환경변수를 앱에 내장할 파일로 쓴다. 없으면 파일을 지워 개인 키만 쓰게 한다.
const fs = require('fs'), path = require('path');
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch (e) { /* .env 없음 */ }
const out = path.join(__dirname, '..', 'src', 'engine', 'builtin-key.json');
const key = (process.env.GEMINI_API_KEY || '').trim();
if (key) { fs.writeFileSync(out, JSON.stringify({ provider: 'gemini', key })); console.log('내장 AI 키: Gemini (팀 공용)'); }
else { try { fs.unlinkSync(out); } catch (e) { /* 없음 */ } console.log('내장 AI 키 없음 (GEMINI_API_KEY 미설정) — 각자 설정에서 입력'); }
