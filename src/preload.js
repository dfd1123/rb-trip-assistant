'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /** 개발 중: 엔진 코드가 바뀌어 앱을 다시 켜야 할 때 알림 */
  onDevStale: fn => ipcRenderer.on('dev-stale', () => fn()),
  /** 지출 품의 매달 알림을 눌렀을 때: 그 알림(id)의 품의를 다시 쓰기 */
  onPuiRemind: fn => ipcRenderer.on('pui-remind', (_e, id) => fn(id)),
  /** route: '/api/...', body: object → data (실패 시 throw) */
  call: async (route, body) => {
    const r = await ipcRenderer.invoke('api', route, body);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  },
  /** 끌어다 놓은 File → 실제 파일 경로 */
  pathForFile: f => webUtils.getPathForFile(f),
});
