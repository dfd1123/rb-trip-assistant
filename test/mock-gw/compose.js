// 가짜 아마란스: 전자결재 › 결재작성(전체 양식) 목록 → 작성 창(구매의뢰서)
// 실제 작성 창 덤프(debug/recipients-popup.html)에서 본 구조: 머리 표 '작 성 부 서'(&nbsp; 로 띄어 씀), '수신및참조' 칸의 OBTAutoCompleteChips(칩 + 입력칸),
// 제목은 .docTitleBox input, 본문은 iframe(dzEditor). 조직도 자동완성은 이름과 함께 경로 말풍선((주)레인보우로보틱스>본사>…)이 같이 뜬다.
(function () {
  const $ = s => document.querySelector(s);
  window.composeRoute = hash => {
    if (!hash.startsWith('#/UB/UB/UBA0000')) return false;
    // 양식 목록: 검색어가 <em> 으로 쪼개지고 비슷한 이름이 같이 뜬다 (실제)
    $('#app').innerHTML = `<h3>결재작성</h3><input type="text" placeholder="양식 검색"><dl>
      <dt><p class="ellipsis lh22">전산기기 <em>구매의뢰서</em></p></dt><dd>전산기기</dd>
      <dt><p class="ellipsis lh22">출장신청 및 출장경비 사전품의</p></dt>
      <dt><p class="ellipsis lh22"><em>구매의뢰서</em></p></dt><dd>구매</dd></dl>`;
    document.querySelectorAll('dt p').forEach(p => p.onclick = () => window.open('/compose.html?form=' + encodeURIComponent(p.textContent.trim()), 'popup_page_2', 'width=1100,height=1000'));
    return true;
  };
})();
