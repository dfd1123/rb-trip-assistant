'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /** route: '/api/...', body: object → data (실패 시 throw) */
  call: async (route, body) => {
    const r = await ipcRenderer.invoke('api', route, body);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  },
});
