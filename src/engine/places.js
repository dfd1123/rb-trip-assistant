'use strict';
// 출장지 찾기: 네이버 지역 검색 (NAVER API HUB, 네이버 클라우드 플랫폼). 이름으로 찾은 장소의 정식 이름·도로명 주소·좌표를 준다.
// 좌표를 네이버 지도 길찾기 주소에 바로 넣으면 지도 창에서 글자를 치고 자동완성을 고르는 단계가 없어진다 (그 단계가 제일 자주 틀렸음).
// 번지 주소("세종특별자치시 집현동 1095")나 등록 안 된 회사는 결과가 없다 → 그때는 지도 창에서 글자로 찾는 예전 방식.

const API = 'https://naverapihub.apigw.ntruss.com/search/v1/local';
const strip = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();

/** @returns {Promise<Array<{name, address, lng, lat, category}>>} 없으면 []. 키가 없으면 null (기능 꺼짐) */
async function searchPlaces(query, { keys, fetch: f = fetch } = {}) {
  if (!keys || !keys.id || !keys.secret) return null;
  const q = String(query || '').trim();
  if (!q) return [];
  const res = await f(`${API}?${new URLSearchParams({ query: q, display: '5' })}`, { headers: { 'X-NCP-APIGW-API-KEY-ID': keys.id, 'X-NCP-APIGW-API-KEY': keys.secret } });
  if (res.status === 401 || res.status === 403) throw new Error('네이버 지역 검색 키가 올바르지 않아요. 관리자에게 알려 주세요 (.env NAVER_CLIENT_ID / NAVER_CLIENT_SECRET).');
  if (res.status === 429) throw new Error('네이버 지역 검색 호출이 너무 잦아요. 잠시 뒤 다시 해 주세요.');
  if (!res.ok) throw new Error(`네이버 지역 검색 실패 (HTTP ${res.status})`);
  const d = await res.json();
  return (d.items || []).map(i => ({ name: strip(i.title), address: strip(i.roadAddress || i.address), category: strip(i.category), lng: Number(i.mapx) / 1e7, lat: Number(i.mapy) / 1e7 }))   // mapx/mapy = 경도·위도 × 10^7
    .filter(p => p.name && p.lng > 120 && p.lat > 30);
}

module.exports = { searchPlaces };
