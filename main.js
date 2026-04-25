// main.js
const { app, BrowserWindow, ipcMain, Notification } = require('electron')
const path = require('path')

const { createGroup, joinGroup, openSession, getAuthorHex, deriveGroupKey } = require('./auth/autopass')
const { watch } = require('./p2p/peer')
const {
  submitNote,
  hasSubmitted,
  getFeedNotes,
  getRoundMeta,
  startNewRound,
  scheduleBeReal
} = require('./p2p/feed')

// ─── State ────────────────────────────────────────────────────────────────────

let win = null
let pass = null
let groupKey = null
let authorHex = null
let cancelTimer = null

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow () {
  win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: 'PeaReal 🍐',
    backgroundColor: '#0f0f0f'
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// ─── BeReal trigger ───────────────────────────────────────────────────────────

async function onBeRealTrigger () {
  if (!pass) return
  await startNewRound(pass)
  win?.webContents.send('bereal:trigger')
  if (Notification.isSupported()) {
    new Notification({
      title: '🍐 PeaReal!',
      body: 'Time to share your moment!'
    }).show()
  }
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('auth:create', async () => {
  try {
    const { pass: p, invite } = await createGroup()
    pass = p
    groupKey = deriveGroupKey(pass)
    authorHex = getAuthorHex(pass)
    _startWatcher()
    _startTimer()
    return { ok: true, invite, authorHex }
  } catch (e) {
    console.error('auth:create error', e)
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('auth:join', async (_e, inviteCode) => {
  try {
    pass = await joinGroup(inviteCode.trim())
    groupKey = deriveGroupKey(pass)
    authorHex = getAuthorHex(pass)
    _startWatcher()
    _startTimer()
    return { ok: true, authorHex }
  } catch (e) {
    console.error('auth:join error', e)
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('auth:resume', async () => {
  try {
    const p = await openSession()
    if (!p) return { ok: false }
    pass = p
    groupKey = deriveGroupKey(pass)
    authorHex = getAuthorHex(pass)
    _startWatcher()
    _startTimer()
    return { ok: true, authorHex }
  } catch {
    return { ok: false }
  }
})

ipcMain.handle('feed:submit', async (_e, noteText) => {
  if (!pass) return { ok: false, error: 'Not connected' }
  try {
    await submitNote(pass, noteText, groupKey, authorHex)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('feed:get', async () => {
  if (!pass) return { ok: false, notes: [] }
  try {
    const submitted = await hasSubmitted(pass, authorHex)
    const notes = await getFeedNotes(pass, submitted, groupKey)
    const meta = await getRoundMeta(pass)
    return { ok: true, notes, submitted, meta }
  } catch (e) {
    return { ok: false, notes: [], error: e.message }
  }
})

ipcMain.handle('feed:hasSubmitted', async () => {
  if (!pass) return false
  return hasSubmitted(pass, authorHex)
})

ipcMain.handle('dev:triggerNow', async () => {
  await onBeRealTrigger()
  return { ok: true }
})

ipcMain.handle('dev:scheduleIn', async (_e, seconds) => {
  if (cancelTimer) cancelTimer()
  cancelTimer = scheduleBeReal(onBeRealTrigger, seconds * 1000)
  return { ok: true }
})

// ─── Internals ────────────────────────────────────────────────────────────────

function _startWatcher () {
  watch(pass, () => {
    win?.webContents.send('feed:updated')
  })
}

function _startTimer () {
  if (cancelTimer) cancelTimer()
  // 50s in dev, random 24h in production
  const devMs = process.env.NODE_ENV === 'production' ? undefined : 50 * 1000
  cancelTimer = scheduleBeReal(onBeRealTrigger, devMs)
}

// ─── To check that encryption works correctly ───────────────────────────────────────────────────────────
ipcMain.handle('dev:rawDump', async () => {
  if (!pass) return { ok: false }
  const all = await pass.list().toArray()
  return { ok: true, entries: all }
})