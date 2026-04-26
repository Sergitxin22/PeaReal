// auth/autopass.js
const Autopass = require('autopass')
const Corestore = require('corestore')
const path = require('path')
const os = require('os')
const fs = require('fs').promises
const b4a = require('b4a')
const { generateKeyPairSync, randomUUID } = require('crypto')

let _pass = null
let _store = null
let _activeRoomId = null

function storagePath() {
  const userSlot = process.env.PEAREAL_USER || 'default'
  return path.join(os.homedir(), '.peareal', userSlot)
}

function roomsRootPath() {
  return path.join(storagePath(), 'rooms')
}

function roomsDbPath() {
  return path.join(storagePath(), 'rooms.json')
}

function currentRoomPath() {
  return path.join(storagePath(), 'current-room.json')
}

function roomStorePath(roomId) {
  return path.join(roomsRootPath(), roomId)
}

function encPublicKeyPath() {
  return path.join(storagePath(), 'enc-public.pem')
}

function encPrivateKeyPath() {
  return path.join(storagePath(), 'enc-private.pem')
}

async function ensureRootDirs() {
  const p = storagePath()
  await fs.mkdir(p, { recursive: true })
  await fs.mkdir(roomsRootPath(), { recursive: true })
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

async function writeJson(filePath, value) {
  await ensureRootDirs()
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8')
}

async function getRooms() {
  const rooms = await readJson(roomsDbPath(), [])
  return Array.isArray(rooms) ? rooms : []
}

async function saveRooms(rooms) {
  await writeJson(roomsDbPath(), rooms)
}

async function setCurrentRoomId(roomId) {
  if (!roomId) {
    try { await fs.unlink(currentRoomPath()) } catch { }
    return
  }
  await writeJson(currentRoomPath(), { roomId, updatedAt: Date.now() })
}

async function getCurrentRoomId() {
  const current = await readJson(currentRoomPath(), null)
  return current?.roomId || null
}

function normalizeRoomName(name, fallbackPrefix) {
  const n = String(name || '').trim()
  if (n) return n
  const d = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${fallbackPrefix} ${hh}:${mm}`
}

async function closeActiveStore() {
  if (_store && typeof _store.close === 'function') {
    try { await _store.close() } catch { }
  }
  _store = null
  _pass = null
  _activeRoomId = null
}

async function openStoreForRoom(roomId) {
  if (_store && _activeRoomId === roomId) return _store
  await closeActiveStore()
  const p = roomStorePath(roomId)
  await fs.mkdir(p, { recursive: true })
  const store = new Corestore(p)
  await store.ready()
  _store = store
  _activeRoomId = roomId
  return store
}

async function upsertRoom(room) {
  const rooms = await getRooms()
  const idx = rooms.findIndex(r => r.id === room.id)
  if (idx === -1) rooms.push(room)
  else rooms[idx] = room
  await saveRooms(rooms)
}

async function getRoomById(roomId) {
  const rooms = await getRooms()
  return rooms.find(r => r.id === roomId) || null
}

async function activateRoom(roomId) {
  const room = await getRoomById(roomId)
  if (!room) return null
  const store = await openStoreForRoom(roomId)
  const pass = new Autopass(store)
  await pass.ready()
  if (!pass.key) return null
  _pass = pass

  room.lastOpenedAt = Date.now()
  await upsertRoom(room)
  await setCurrentRoomId(roomId)

  return { pass, room }
}

async function createGroup(options = {}) {
  await ensureRootDirs()
  const roomId = randomUUID()
  const roomName = normalizeRoomName(options.name, 'Sala')
  const store = await openStoreForRoom(roomId)
  const pass = new Autopass(store)
  await pass.ready()
  _pass = pass
  const invite = await pass.createInvite()

  const now = Date.now()
  const room = {
    id: roomId,
    name: roomName,
    inviteCode: invite,
    createdAt: now,
    lastOpenedAt: now
  }
  await upsertRoom(room)
  await setCurrentRoomId(roomId)

  return { pass, invite, room }
}

async function joinGroup(inviteCode, options = {}) {
  await ensureRootDirs()
  const roomId = randomUUID()
  const roomName = normalizeRoomName(options.name, 'Sala importada')
  const store = await openStoreForRoom(roomId)
  const pairer = Autopass.pair(store, inviteCode.trim())
  await pairer.ready()
  const pass = await pairer.finished()
  await pass.ready()
  _pass = pass

  const now = Date.now()
  const room = {
    id: roomId,
    name: roomName,
    inviteCode: inviteCode.trim(),
    createdAt: now,
    lastOpenedAt: now
  }
  await upsertRoom(room)
  await setCurrentRoomId(roomId)

  return { pass, room }
}

async function openSession() {
  await ensureRootDirs()
  const roomId = await getCurrentRoomId()
  if (!roomId) return null
  try {
    const active = await activateRoom(roomId)
    return active ? active.pass : null
  } catch {
    return null
  }
}

async function listRooms() {
  const rooms = await getRooms()
  return rooms
    .slice()
    .sort((a, b) => (b.lastOpenedAt || b.createdAt || 0) - (a.lastOpenedAt || a.createdAt || 0))
}

async function openRoom(roomId) {
  return activateRoom(roomId)
}

async function getCurrentRoom() {
  const roomId = await getCurrentRoomId()
  if (!roomId) return null
  return getRoomById(roomId)
}

async function leaveRoom(roomId) {
  const rooms = await getRooms()
  const nextRooms = rooms.filter(r => r.id !== roomId)
  await saveRooms(nextRooms)

  try {
    await fs.rm(roomStorePath(roomId), { recursive: true, force: true })
  } catch { }

  const currentRoomId = await getCurrentRoomId()
  if (currentRoomId === roomId) {
    await setCurrentRoomId(null)
    await closeActiveStore()
  }

  return { ok: true }
}

function getPass() { return _pass }

function getAuthorHex(pass) {
  try {
    const key = pass.writerKey || pass.key
    return b4a.toString(key, 'hex').slice(0, 16)
  } catch { return 'unknown' }
}

function deriveGroupKey(pass) {
  const crypto = require('hypercore-crypto')
  // encryptionKey is the shared secret negotiated during pairing —
  // it is IDENTICAL on every peer, so all members encrypt/decrypt with the same key.
  // pass.key (the Autobase key) is also shared and works as a fallback.
  const sharedKey = pass.encryptionKey || pass.key
  return crypto.hash(sharedKey)
}

async function getEncryptionKeyPair() {
  const p = storagePath()
  await fs.mkdir(p, { recursive: true })

  try {
    const [publicKey, privateKey] = await Promise.all([
      fs.readFile(encPublicKeyPath(), 'utf8'),
      fs.readFile(encPrivateKeyPath(), 'utf8')
    ])
    return { publicKey, privateKey }
  } catch {
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    })
    await Promise.all([
      fs.writeFile(encPublicKeyPath(), pair.publicKey, 'utf8'),
      fs.writeFile(encPrivateKeyPath(), pair.privateKey, 'utf8')
    ])
    return { publicKey: pair.publicKey, privateKey: pair.privateKey }
  }
}

module.exports = {
  createGroup,
  joinGroup,
  openSession,
  listRooms,
  openRoom,
  getCurrentRoom,
  leaveRoom,
  getPass,
  getAuthorHex,
  deriveGroupKey,
  getEncryptionKeyPair
}