'use strict';
// 빌드 전에 팀 공용 키 환경변수를 앱에 내장할 파일로 쓴다 (GEMINI_API_KEY: AI, OPEN_API_KEY: 한국수출입은행 환율, NAVER_CLIENT_ID/SECRET: 네이버 지역 검색). 다 없으면 파일을 지운다.
const fs = require('fs'), path = require('path');
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch (e) { /* .env 없음 */ }
const out = path.join(__dirname, '..', 'src', 'engine', 'builtin-key.json');
const key = (process.env.GEMINI_API_KEY || '').trim(), fxKey = (process.env.OPEN_API_KEY || '').trim(), naverId = (process.env.NAVER_CLIENT_ID || '').trim(), naverSecret = (process.env.NAVER_CLIENT_SECRET || '').trim(),
  slackToken = (process.env.SLACK_BOT_TOKEN || '').trim(), slackChannel = (process.env.SLACK_CHANNEL || '').trim();
if (key || fxKey || naverId || slackToken) { fs.writeFileSync(out, JSON.stringify({ provider: 'gemini', key, fxKey, naverId, naverSecret, slackToken, slackChannel })); console.log(`내장 키: ${[key && 'Gemini (팀 공용 AI)', fxKey && '수출입은행 환율', naverId && '네이버 지역 검색', slackToken && '슬랙 오류 기록'].filter(Boolean).join(', ')}`); }
else { try { fs.unlinkSync(out); } catch (e) { /* 없음 */ } console.log('내장 키 없음 (GEMINI_API_KEY·OPEN_API_KEY 미설정) — AI 는 각자 설정에서 입력'); }
