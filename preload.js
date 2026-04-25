// preload.js
// Exposes a safe, narrow API to the renderer via contextBridge.
// The renderer can only call these — it cannot access Node.js directly.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('peareal', {
  // ── Auth ──
  createGroup: () => ipcRenderer.invoke('auth:create'),
  joinGroup: (inviteCode) => ipcRenderer.invoke('auth:join', inviteCode),
  resumeSession: () => ipcRenderer.invoke('auth:resume'),

  // ── Feed ──
  submitNote: (text) => ipcRenderer.invoke('feed:submit', text),
  getFeed: () => ipcRenderer.invoke('feed:get'),
  hasSubmitted: () => ipcRenderer.invoke('feed:hasSubmitted'),

  // ── Dev/test helpers ──
  triggerNow: () => ipcRenderer.invoke('dev:triggerNow'),
  scheduleIn: (seconds) => ipcRenderer.invoke('dev:scheduleIn', seconds),

  // ── Events from main → renderer ──
  onBeRealTrigger: (cb) => ipcRenderer.on('bereal:trigger', cb),
  onFeedUpdated: (cb) => ipcRenderer.on('feed:updated', cb),

  // Remove listeners (cleanup)
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
})