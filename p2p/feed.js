// p2p/feed.js
//
// Message encryption and unlock protocol:
//   - Each note uses a random content key (CK) with XChaCha20-Poly1305.
//   - Ciphertext is replicated to everyone.
//   - To reveal a note, a peer creates an unlock request to the author.
//   - Author responds with CK wrapped for that peer's public key.

const { put, get, del, listByPrefix } = require('./peer')
const sodium = require('sodium-universal')
const b4a = require('b4a')
const crypto = require('crypto')

const ALG = 'xchacha20poly1305-ietf'
const WRAP_ALG = 'rsa-oaep-sha256'

const HAS_XCHACHA =
  typeof sodium.crypto_aead_xchacha20poly1305_ietf_encrypt === 'function' &&
  typeof sodium.crypto_aead_xchacha20poly1305_ietf_decrypt === 'function'

function ensureXChaChaAvailable() {
  if (!HAS_XCHACHA) throw new Error('XChaCha20-Poly1305 is not available in this sodium build')
}

function noteKey(roundId, authorHex) { return `round:${roundId}:note:${authorHex}` }
function metaKey(roundId) { return `round:${roundId}:meta` }
function unlockReqKey(roundId, authorHex, requesterHex) { return `round:${roundId}:unlockReq:${authorHex}:${requesterHex}` }
function unlockGrantKey(roundId, authorHex, requesterHex) { return `round:${roundId}:unlockGrant:${authorHex}:${requesterHex}` }

function encryptContent(plaintext, contentKey) {
  ensureXChaChaAvailable()
  const msg = b4a.from(plaintext, 'utf8')
  const nonce = b4a.alloc(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  sodium.randombytes_buf(nonce)

  const ciphertext = b4a.alloc(msg.length + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES)
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(ciphertext, msg, null, null, nonce, contentKey)

  return {
    alg: ALG,
    encrypted: b4a.toString(ciphertext, 'hex'),
    nonce: b4a.toString(nonce, 'hex')
  }
}

function decryptContent(encryptedHex, nonceHex, contentKey) {
  try {
    ensureXChaChaAvailable()
    const ciphertext = b4a.from(encryptedHex, 'hex')
    const nonce = b4a.from(nonceHex, 'hex')
    const plaintext = b4a.alloc(ciphertext.length - sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES)
    const ok = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(plaintext, null, ciphertext, null, nonce, contentKey)
    if (!ok) return null
    return b4a.toString(plaintext, 'utf8')
  } catch {
    return null
  }
}

function wrapContentKeyForPeer(contentKey, peerPublicKeyPem) {
  const wrapped = crypto.publicEncrypt(
    {
      key: peerPublicKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    contentKey
  )
  return wrapped.toString('base64')
}

function unwrapContentKey(wrappedKeyB64, localPrivateKeyPem) {
  try {
    return crypto.privateDecrypt(
      {
        key: localPrivateKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
      },
      Buffer.from(wrappedKeyB64, 'base64')
    )
  } catch {
    return null
  }
}

async function getCurrentRound(pass) {
  return await get(pass, 'config:currentRound')
}

async function getOrCreateCurrentRound(pass) {
  const roundId = await getCurrentRound(pass)
  if (!roundId) return await startNewRound(pass)
  return roundId
}

async function startNewRound(pass) {
  const roundId = String(Date.now())
  const oldRound = await get(pass, 'config:currentRound')
  if (oldRound) await wipeRound(pass, oldRound)
  await put(pass, 'config:currentRound', roundId)
  await put(pass, metaKey(roundId), {
    startedAt: Date.now(),
    triggeredAt: Date.now()
  })
  return roundId
}

async function wipeRound(pass, roundId) {
  for (const { key } of await listByPrefix(pass, `round:${roundId}:`)) {
    await del(pass, key)
  }
}

async function submitNote(pass, noteText, _groupKey, authorHex, authorPublicKeyPem) {
  const roundId = await getOrCreateCurrentRound(pass)

  const contentKey = b4a.alloc(32)
  sodium.randombytes_buf(contentKey)

  const encryptedPayload = encryptContent(noteText, contentKey)
  const selfWrappedKey = wrapContentKeyForPeer(contentKey, authorPublicKeyPem)

  await put(pass, noteKey(roundId, authorHex), {
    ...encryptedPayload,
    author: authorHex,
    authorPublicKeyPem,
    ts: Date.now(),
    wrapAlg: WRAP_ALG
  })

  await put(pass, unlockGrantKey(roundId, authorHex, authorHex), {
    from: authorHex,
    to: authorHex,
    wrappedKey: selfWrappedKey,
    wrapAlg: WRAP_ALG,
    ts: Date.now()
  })

  const pendingReqs = await listByPrefix(pass, `round:${roundId}:unlockReq:${authorHex}:`)
  for (const req of pendingReqs) {
    const requesterHex = req.value?.from
    const requesterPub = req.value?.requesterPublicKeyPem
    if (!requesterHex || !requesterPub) continue
    const requesterSubmitted = await get(pass, noteKey(roundId, requesterHex))
    if (!requesterSubmitted) continue
    const grantPath = unlockGrantKey(roundId, authorHex, requesterHex)
    const existingGrant = await get(pass, grantPath)
    if (existingGrant) continue
    await put(pass, grantPath, {
      from: authorHex,
      to: requesterHex,
      wrappedKey: wrapContentKeyForPeer(contentKey, requesterPub),
      wrapAlg: WRAP_ALG,
      ts: Date.now()
    })
  }

  return roundId
}

async function hasSubmitted(pass, authorHex) {
  const roundId = await getCurrentRound(pass)
  if (!roundId) return false
  return (await get(pass, noteKey(roundId, authorHex))) !== null
}

async function processIncomingUnlockRequests(pass, roundId, localAuthorHex, localPrivateKeyPem) {
  const myNote = await get(pass, noteKey(roundId, localAuthorHex))
  if (!myNote) return

  const selfGrant = await get(pass, unlockGrantKey(roundId, localAuthorHex, localAuthorHex))
  if (!selfGrant?.wrappedKey) return
  const myContentKey = unwrapContentKey(selfGrant.wrappedKey, localPrivateKeyPem)
  if (!myContentKey) return

  const requests = await listByPrefix(pass, `round:${roundId}:unlockReq:${localAuthorHex}:`)
  for (const reqEntry of requests) {
    const req = reqEntry.value
    const requesterHex = req?.from
    const requesterPub = req?.requesterPublicKeyPem
    if (!requesterHex || !requesterPub) continue

    const requesterSubmitted = await get(pass, noteKey(roundId, requesterHex))
    if (!requesterSubmitted) continue

    const grantPath = unlockGrantKey(roundId, localAuthorHex, requesterHex)
    const existingGrant = await get(pass, grantPath)
    if (existingGrant) continue

    await put(pass, grantPath, {
      from: localAuthorHex,
      to: requesterHex,
      wrappedKey: wrapContentKeyForPeer(myContentKey, requesterPub),
      wrapAlg: WRAP_ALG,
      ts: Date.now()
    })
  }
}

async function ensureUnlockRequestForAuthor(pass, roundId, localAuthorHex, targetAuthorHex, localPublicKeyPem) {
  if (targetAuthorHex === localAuthorHex) return

  const reqPath = unlockReqKey(roundId, targetAuthorHex, localAuthorHex)
  const existingReq = await get(pass, reqPath)
  if (existingReq) return

  await put(pass, reqPath, {
    from: localAuthorHex,
    to: targetAuthorHex,
    requesterPublicKeyPem: localPublicKeyPem,
    ts: Date.now()
  })
}

async function getFeedNotes(pass, localUserSubmitted, _groupKey, localAuthorHex, localPublicKeyPem, localPrivateKeyPem) {
  const roundId = await getCurrentRound(pass)
  if (!roundId) return []

  const notes = await listByPrefix(pass, `round:${roundId}:note:`)

  if (!localUserSubmitted) {
    return notes.map(({ value }) => ({
      author: value.author,
      content: null,
      ts: value.ts,
      hidden: true
    }))
  }

  await processIncomingUnlockRequests(pass, roundId, localAuthorHex, localPrivateKeyPem)

  const results = []
  for (const { value: note } of notes) {
    if (!note?.author) continue

    await ensureUnlockRequestForAuthor(pass, roundId, localAuthorHex, note.author, localPublicKeyPem)

    const grant = await get(pass, unlockGrantKey(roundId, note.author, localAuthorHex))
    let content = null
    if (grant?.wrappedKey) {
      const contentKey = unwrapContentKey(grant.wrappedKey, localPrivateKeyPem)
      if (contentKey) content = decryptContent(note.encrypted, note.nonce, contentKey)
    }

    if (content === null) {
      results.push({ author: note.author, content: null, ts: note.ts, hidden: true })
    } else {
      results.push({ author: note.author, content, ts: note.ts, hidden: false })
    }
  }

  return results
}

async function getRoundMeta(pass) {
  const roundId = await getCurrentRound(pass)
  if (!roundId) return null
  return await get(pass, metaKey(roundId))
}

function scheduleBeReal(onTrigger, shortMs) {
  let timer = null
  function msUntilNextTrigger() {
    const now = new Date()
    const hour = 9 + Math.floor(Math.random() * 13)
    const minute = Math.floor(Math.random() * 60)
    const trigger = new Date(now)
    trigger.setHours(hour, minute, 0, 0)
    if (trigger <= now) trigger.setDate(trigger.getDate() + 1)
    return trigger.getTime() - now.getTime()
  }
  function schedule() {
    const delay = shortMs !== undefined ? shortMs : msUntilNextTrigger()
    const fireAt = new Date(Date.now() + delay)
    console.log(`[BeReal] Next trigger: ${fireAt.toLocaleString()} (in ${Math.round(delay / 1000)}s)`)
    timer = setTimeout(async () => {
      console.log('[BeReal] Triggered!')
      await onTrigger()
      schedule()
    }, delay)
  }
  schedule()
  return () => { if (timer) clearTimeout(timer) }
}

module.exports = {
  getCurrentRound,
  startNewRound,
  submitNote,
  hasSubmitted,
  getFeedNotes,
  getRoundMeta,
  scheduleBeReal
}