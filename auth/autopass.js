// auth/autopass.js
const Autopass = require('autopass')
const Corestore = require('corestore')
const path = require('path')
const os = require('os')
const fs = require('fs').promises
const b4a = require('b4a')
const { generateKeyPairSync } = require('crypto')

let _pass = null
let _store = null
let _storePromise = null

function storagePath() {
  const userSlot = process.env.PEAREAL_USER || 'default'
  return path.join(os.homedir(), '.peareal', userSlot)
}

function sessionMarkerPath() {
  return path.join(storagePath(), '.session')
}

function encPublicKeyPath() {
  return path.join(storagePath(), 'enc-public.pem')
}

function encPrivateKeyPath() {
  return path.join(storagePath(), 'enc-private.pem')
}

async function saveSessionMarker() {
  const p = storagePath()
  await fs.mkdir(p, { recursive: true })
  await fs.writeFile(sessionMarkerPath(), String(Date.now()))
}

async function hasSessionMarker() {
  try { await fs.access(sessionMarkerPath()); return true }
  catch { return false }
}

async function makeStore() {
  if (_store) return _store
  if (!_storePromise) {
    _storePromise = (async () => {
      const p = storagePath()
      await fs.mkdir(p, { recursive: true })
      const store = new Corestore(p)
      await store.ready()
      _store = store
      return store
    })()
  }
  return _storePromise
}

async function createGroup() {
  const store = await makeStore()
  const pass = new Autopass(store)
  await pass.ready()
  _pass = pass
  const invite = await pass.createInvite()
  await saveSessionMarker()
  return { pass, invite }
}

async function joinGroup(inviteCode) {
  const store = await makeStore()
  const pairer = Autopass.pair(store, inviteCode.trim())
  await pairer.ready()
  const pass = await pairer.finished()
  await pass.ready()
  _pass = pass
  await saveSessionMarker()
  return pass
}

async function openSession() {
  if (!(await hasSessionMarker())) return null
  try {
    const store = await makeStore()
    const pass = new Autopass(store)
    await pass.ready()
    if (!pass.key) return null
    _pass = pass
    return pass
  } catch {
    return null
  }
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
  getPass,
  getAuthorHex,
  deriveGroupKey,
  getEncryptionKeyPair
}