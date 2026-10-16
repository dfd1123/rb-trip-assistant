'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /** 개발 중: 엔진 코드가 바뀌어 앱을 다시 켜야 할 때 알림 */
  onDevStale: fn => ipcRenderer.on('dev-stale', () => fn()),
  /** route: '/api/...', body: object → data (실패 시 throw) */
  call: async (route, body) => {
    const r = await ipcRenderer.invoke('api', route, body);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  },
  /** 끌어다 놓은 File → 실제 파일 경로 */
  pathForFile: f => webUtils.getPathForFile(f),
});
