// main.js
const { app, BrowserWindow, ipcMain, Notification } = require('electron')
const path = require('path')
const fs = require('fs').promises
const http = require('http')
const os = require('os')
const { WebSocketServer } = require('ws')

const {
  createGroup,
  joinGroup,
  listRooms,
  openRoom,
  createRoomInvite,
  getCurrentRoom,
  leaveRoom,
  getAuthorHex,
  deriveGroupKey,
  getEncryptionKeyPair
} = require('./auth/autopass')
const { watch } = require('./p2p/peer')
const {
  submitNote,
  hasSubmitted,
  getFeedNotes,
  getRoundMeta,
  startNewRound,
  scheduleBeReal
} = require('./p2p/feed')

// Isolate Chromium profile/cache per local node to avoid cache lock collisions
// when running multiple Electron instances on Windows.
const userSlot = process.env.PEAREAL_USER || 'default'
const scopedUserData = path.join(app.getPath('appData'), 'PeaReal', userSlot)
app.setPath('userData', scopedUserData)
app.setPath('sessionData', path.join(scopedUserData, 'Session'))

// ─── State ────────────────────────────────────────────────────────────────────

let win = null
let pass = null
let groupKey = null
let authorHex = null
let activeRoom = null
let encKeyPair = null
let cancelTimer = null
let stopWatching = null
let mobileServer = null
let mobileWss = null

const MOBILE_PORT = Number(process.env.MOBILE_BRIDGE_PORT || 8787)
const MAX_IMAGE_DATA_URL_LENGTH = 8 * 1024 * 1024

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
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

app.whenReady().then(async () => {
  createWindow()
  await startMobileBridge()
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => {
  try { mobileWss?.close() } catch { }
  try { mobileServer?.close() } catch { }
})

// ─── BeReal trigger ───────────────────────────────────────────────────────────

async function onBeRealTrigger() {
  if (!pass) return
  await startNewRound(pass)
  win?.webContents.send('bereal:trigger')
  broadcastMobile({ type: 'event', event: 'bereal:trigger' })
  if (Notification.isSupported()) {
    new Notification({
      title: '🍐 PeaReal!',
      body: 'Time to share your moment!'
    }).show()
  }
}

function getLanAddresses() {
  const nets = os.networkInterfaces()
  const ips = []
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address)
    }
  }
  return ips
}

function sendMobile(ws, message) {
  if (!ws || ws.readyState !== ws.OPEN) return
  ws.send(JSON.stringify(message))
}

function broadcastMobile(message) {
  if (!mobileWss) return
  const payload = JSON.stringify(message)
  for (const client of mobileWss.clients) {
    if (client.readyState === client.OPEN) client.send(payload)
  }
}

function isImageDataUrl(value) {
  return typeof value === 'string' && /^data:image\/(png|jpeg|jpg|webp);base64,/i.test(value)
}

function parseInvitePayload(rawInviteCode) {
  const raw = String(rawInviteCode || '').trim()
  if (!raw) return { inviteCode: '', roomName: '' }

  // Supported format for sharing: peareal://invite?code=...&name=...
  if (raw.startsWith('peareal://')) {
    try {
      const parsed = new URL(raw)
      if (parsed.hostname === 'invite') {
        const inviteCode = String(parsed.searchParams.get('code') || '').trim()
        const roomName = String(parsed.searchParams.get('name') || '').trim()
        if (inviteCode) return { inviteCode, roomName }
      }
    } catch { }
  }

  return { inviteCode: raw, roomName: '' }
}

async function getStatusPayload() {
  let submitted = false
  if (pass && authorHex) {
    try { submitted = await hasSubmitted(pass, authorHex) } catch { submitted = false }
  }
  return {
    connected: Boolean(pass),
    authorHex,
    submitted,
    room: activeRoom,
    lanUrls: getLanAddresses().map(ip => `http://${ip}:${MOBILE_PORT}`),
    localUrl: `http://localhost:${MOBILE_PORT}`
  }
}

async function notifyStatusChanged() {
  broadcastMobile({ type: 'status', data: await getStatusPayload() })
}

function stopSessionWorkers() {
  if (stopWatching) {
    try { stopWatching() } catch { }
    stopWatching = null
  }
  if (cancelTimer) {
    try { cancelTimer() } catch { }
    cancelTimer = null
  }
}

function clearSessionState() {
  stopSessionWorkers()
  pass = null
  groupKey = null
  authorHex = null
  activeRoom = null
}

async function initSession(p, room) {
  stopSessionWorkers()
  pass = p
  activeRoom = room || null
  groupKey = deriveGroupKey(pass)
  authorHex = getAuthorHex(pass)
  encKeyPair = await getEncryptionKeyPair()
  _startWatcher()
  _startTimer()
  await notifyStatusChanged()
}

async function handleRoomCreate(name) {
  const { pass: p, invite, room } = await createGroup({ name })
  await initSession(p, room)
  return { ok: true, invite, authorHex, room }
}

async function handleRoomJoin(inviteCode, name) {
  const { pass: p, room } = await joinGroup(inviteCode.trim(), { name })
  await initSession(p, room)
  return { ok: true, authorHex, room }
}

async function handleRoomOpen(roomId) {
  const active = await openRoom(roomId)
  if (!active?.pass || !active?.room) return { ok: false, error: 'Room not found' }
  await initSession(active.pass, active.room)
  return { ok: true, authorHex, room: active.room }
}

async function handleRoomLeave(roomId) {
  const targetRoomId = roomId || activeRoom?.id
  if (!targetRoomId) return { ok: false, error: 'No room selected' }
  await leaveRoom(targetRoomId)
  if (activeRoom?.id === targetRoomId) {
    clearSessionState()
    await notifyStatusChanged()
  }
  return { ok: true }
}

async function handleRoomInvite(roomId) {
  const targetRoomId = roomId || activeRoom?.id
  if (!targetRoomId) return { ok: false, error: 'No room selected' }
  const result = await createRoomInvite(targetRoomId)
  if (activeRoom?.id === targetRoomId && result?.room) {
    activeRoom = result.room
  }
  await notifyStatusChanged()
  return { ok: true, invite: result.invite, room: result.room }
}

async function handleAuthCreate(name) {
  return handleRoomCreate(name)
}

async function handleAuthJoin(inviteCode, name) {
  const parsed = parseInvitePayload(inviteCode)
  const finalInviteCode = parsed.inviteCode
  const finalName = String(name || '').trim() || parsed.roomName
  return handleRoomJoin(finalInviteCode, finalName)
}

async function handleAuthResume() {
  const room = await getCurrentRoom()
  if (!room?.id) return { ok: false }
  return handleRoomOpen(room.id)
}

async function handleFeedSubmit(noteText) {
  if (!pass) return { ok: false, error: 'Not connected' }
  if (!isImageDataUrl(noteText)) {
    return { ok: false, error: 'Only image uploads are supported now' }
  }
  if (!encKeyPair?.publicKey || !encKeyPair?.privateKey) {
    return { ok: false, error: 'Missing local encryption keys' }
  }
  await submitNote(pass, noteText, groupKey, authorHex, encKeyPair.publicKey, encKeyPair.privateKey)
  await notifyStatusChanged()
  return { ok: true }
}

async function handleFeedGet() {
  if (!pass) return { ok: false, notes: [] }
  const submitted = await hasSubmitted(pass, authorHex)
  if (!encKeyPair?.publicKey || !encKeyPair?.privateKey) {
    return { ok: false, notes: [], error: 'Missing local encryption keys' }
  }
  const notes = await getFeedNotes(
    pass,
    submitted,
    groupKey,
    authorHex,
    encKeyPair.publicKey,
    encKeyPair.privateKey
  )
  const meta = await getRoundMeta(pass)
  return { ok: true, notes, submitted, meta }
}

async function startMobileBridge() {
  const mobilePath = path.join(__dirname, 'mobile', 'index.html')

  mobileServer = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

      if (req.method === 'GET' && reqUrl.pathname === '/') {
        const html = await fs.readFile(mobilePath, 'utf8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
        return
      }

      if (req.method === 'GET' && reqUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      res.writeHead(404)
      res.end('Not found')
    } catch {
      res.writeHead(500)
      res.end('Server error')
    }
  })

  mobileWss = new WebSocketServer({ server: mobileServer, path: '/ws' })

  mobileWss.on('connection', async (ws) => {
    sendMobile(ws, { type: 'status', data: await getStatusPayload() })

    ws.on('message', async (raw) => {
      let msg
      try { msg = JSON.parse(String(raw)) } catch { return }
      const id = msg?.id || null
      const action = msg?.action
      const payload = msg?.payload || {}

      try {
        if (action === 'status:get') {
          sendMobile(ws, { type: 'response', id, ok: true, data: await getStatusPayload() })
          return
        }

        if (action === 'auth:create') {
          sendMobile(ws, { type: 'response', id, ...(await handleAuthCreate(payload.roomName || '')) })
          return
        }

        if (action === 'auth:join') {
          sendMobile(ws, {
            type: 'response',
            id,
            ...(await handleAuthJoin(payload.inviteCode || '', payload.roomName || ''))
          })
          return
        }

        if (action === 'rooms:list') {
          const rooms = await listRooms()
          const current = await getCurrentRoom()
          sendMobile(ws, { type: 'response', id, ok: true, rooms, current })
          return
        }

        if (action === 'rooms:open') {
          sendMobile(ws, { type: 'response', id, ...(await handleRoomOpen(payload.roomId || '')) })
          return
        }

        if (action === 'rooms:leave') {
          sendMobile(ws, { type: 'response', id, ...(await handleRoomLeave(payload.roomId || null)) })
          return
        }

        if (action === 'rooms:invite') {
          sendMobile(ws, { type: 'response', id, ...(await handleRoomInvite(payload.roomId || null)) })
          return
        }

        if (action === 'feed:submitImage') {
          if (!pass) {
            sendMobile(ws, { type: 'response', id, ok: false, error: 'Join or create a group first' })
            return
          }

          const imageDataUrl = payload.imageDataUrl
          if (!isImageDataUrl(imageDataUrl)) {
            sendMobile(ws, { type: 'response', id, ok: false, error: 'Invalid image format' })
            return
          }
          if (imageDataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
            sendMobile(ws, { type: 'response', id, ok: false, error: 'Image too large' })
            return
          }

          const result = await handleFeedSubmit(imageDataUrl)
          sendMobile(ws, { type: 'response', id, ...result })
          return
        }

        if (action === 'feed:get') {
          sendMobile(ws, { type: 'response', id, ...(await handleFeedGet()) })
          return
        }

        sendMobile(ws, { type: 'response', id, ok: false, error: 'Unknown action' })
      } catch (e) {
        sendMobile(ws, { type: 'response', id, ok: false, error: e.message })
      }
    })
  })

  await new Promise((resolve, reject) => {
    mobileServer.once('error', reject)
    mobileServer.listen(MOBILE_PORT, '0.0.0.0', () => resolve())
  })

  const lan = getLanAddresses()
  console.log(`[Mobile] Frontend available on: http://localhost:${MOBILE_PORT}`)
  for (const ip of lan) console.log(`[Mobile] Frontend available on: http://${ip}:${MOBILE_PORT}`)
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('auth:create', async (_e, name) => {
  try {
    return await handleAuthCreate(name)
  } catch (e) {
    console.error('auth:create error', e)
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('auth:join', async (_e, inviteCode) => {
  try {
    return await handleAuthJoin(inviteCode, '')
  } catch (e) {
    console.error('auth:join error', e)
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('rooms:list', async () => {
  try {
    const rooms = await listRooms()
    const current = await getCurrentRoom()
    return { ok: true, rooms, current }
  } catch (e) {
    return { ok: false, rooms: [], error: e.message }
  }
})

ipcMain.handle('rooms:create', async (_e, name) => {
  try {
    return await handleRoomCreate(name)
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('rooms:join', async (_e, inviteCode, name) => {
  try {
    return await handleRoomJoin(inviteCode, name)
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('rooms:open', async (_e, roomId) => {
  try {
    return await handleRoomOpen(roomId)
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('rooms:leave', async (_e, roomId) => {
  try {
    return await handleRoomLeave(roomId)
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('rooms:invite', async (_e, roomId) => {
  try {
    return await handleRoomInvite(roomId)
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('rooms:getCurrent', async () => {
  try {
    return { ok: true, room: await getCurrentRoom() }
  } catch (e) {
    return { ok: false, room: null, error: e.message }
  }
})

ipcMain.handle('feed:submit', async (_e, noteText) => {
  try {
    return await handleFeedSubmit(noteText)
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('feed:get', async () => {
  try {
    return await handleFeedGet()
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

function _startWatcher() {
  if (stopWatching) {
    try { stopWatching() } catch { }
    stopWatching = null
  }
  stopWatching = watch(pass, () => {
    win?.webContents.send('feed:updated')
    broadcastMobile({ type: 'event', event: 'feed:updated' })
    notifyStatusChanged().catch(() => { })
  })
}

function _startTimer() {
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