'use strict';
// 출장지 찾기: 네이버 지역 검색 (NAVER API HUB, 네이버 클라우드 플랫폼). 이름으로 찾은 장소의 정식 이름·도로명 주소·좌표를 준다.
// 좌표를 네이버 지도 길찾기 주소에 바로 넣으면 지도 창에서 글자를 치고 자동완성을 고르는 단계가 없어진다 (그 단계가 제일 자주 틀렸음).
// 번지 주소("세종특별자치시 집현동 1095")나 등록 안 된 회사는 결과가 없다 → 그때는 지도 창에서 글자로 찾는 예전 방식.

const API = 'https://naverapihub.apigw.ntruss.com/search/v1/local';
const strip = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();

/** @returns {Promise<Array<{name, address, lng, lat, category}>>} 없으면 []. 키가 없으면 null (기능 꺼짐) */
// 지역 이름을 앞에 붙이면("일산 킨텍스", "부산 벡스코") 네이버가 그 이름이 든 식당만 5개 준다 (실제 확인 2026-10-22) → 앞 낱말을 뺀 이름으로도 찾아 합치고,
// 식당·카페·은행·주차장 같은 곳은 뒤로 (찾는 말에 그런 낱말이 있으면 그대로)
const NOISE = /음식점|한식|중식|일식|양식|분식|육류|고기|해물|카페|디저트|술집|주점|베이커리|은행|ATM|주차장|도로시설|방면정보|어린이집|편의점|미용|약국|부동산|웨딩|충전소|가구/;
const VENUE = /컨벤션|전시|기업|공장|제조|연구|사업장|대학|병원|공공|관공서|빌딩|산업|센터/;   // 출장지다운 곳은 조금 앞으로
function rankPlaces(query, list) {
  const n = s => String(s || '').replace(/\s/g, '').toLowerCase();
  const words = String(query || '').trim().split(/\s+/), core = n(words.length > 1 ? words.slice(1).join('') : words[0]), q = n(query);
  const wantNoise = NOISE.test(query) || /맛집|식당|밥집|커피|술/.test(query);   // 식당을 찾는 거면 순서를 바꾸지 않음
  const score = p => (n(p.name) === q || n(p.name) === core ? 0 : n(p.name).includes(core) ? 1 : 2) + (wantNoise ? 0 : (NOISE.test(p.category) ? 10 : 0) - (VENUE.test(p.category) ? 1.5 : 0));
  return list.map((p, i) => ({ p, i, s: score(p) })).sort((a, b) => a.s - b.s || a.i - b.i).map(x => x.p);
}
async function searchPlaces(query, { keys, fetch: f = fetch } = {}) {
  if (!keys || !keys.id || !keys.secret) return null;
  const q = String(query || '').trim();
  if (!q) return [];
  const words = q.split(/\s+/);
  const lists = [await searchOnce(q, keys, f)];
  if (words.length > 1) lists.push(await searchOnce(words.slice(1).join(' '), keys, f).catch(() => []));   // 앞 낱말(지역) 뺀 이름
  const seen = new Set(), all = [];
  for (const p of lists.flat()) { const k = `${p.name}|${p.address}`; if (!seen.has(k)) { seen.add(k); all.push(p); } }
  return rankPlaces(q, all).slice(0, 8);
}
async function searchOnce(q, keys, f) {
  const res = await f(`${API}?${new URLSearchParams({ query: q, display: '5' })}`, { headers: { 'X-NCP-APIGW-API-KEY-ID': keys.id, 'X-NCP-APIGW-API-KEY': keys.secret } });
  if (res.status === 401 || res.status === 403) throw new Error('네이버 지역 검색 키가 올바르지 않아요. 관리자에게 알려 주세요 (.env NAVER_CLIENT_ID / NAVER_CLIENT_SECRET).');
  if (res.status === 429) throw new Error('네이버 지역 검색 호출이 너무 잦아요. 잠시 뒤 다시 해 주세요.');
  if (!res.ok) throw new Error(`네이버 지역 검색 실패 (HTTP ${res.status})`);
  const d = await res.json();
  return (d.items || []).map(i => ({ name: strip(i.title), address: strip(i.roadAddress || i.address), category: strip(i.category), lng: Number(i.mapx) / 1e7, lat: Number(i.mapy) / 1e7 }))   // mapx/mapy = 경도·위도 × 10^7
    .filter(p => p.name && p.lng > 120 && p.lat > 30);
}

module.exports = { searchPlaces, rankPlaces };
