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

function parseAuthorHexFromNoteKey(key) {
  try {
    const parts = String(key).split(':')
    return parts[parts.length - 1] || null
  } catch {
    return null
  }
}

function hashCommit(roundId, plaintext, saltHex) {
  return crypto
    .createHash('sha256')
    .update(`noteCommit|${roundId}|${plaintext}|${saltHex}`, 'utf8')
    .digest('hex')
}

function noteSignPayload(roundId, authorHex, commitment, ts, nonceHex) {
  return `note|${roundId}|${authorHex}|${commitment}|${ts}|${nonceHex}`
}

function signNote(privateKeyPem, roundId, authorHex, commitment, ts, nonceHex) {
  const payload = noteSignPayload(roundId, authorHex, commitment, ts, nonceHex)
  return crypto.sign('sha256', Buffer.from(payload, 'utf8'), privateKeyPem).toString('base64')
}

function verifyNoteSignature(publicKeyPem, roundId, authorHex, commitment, ts, nonceHex, signatureB64) {
  try {
    const payload = noteSignPayload(roundId, authorHex, commitment, ts, nonceHex)
    return crypto.verify(
      'sha256',
      Buffer.from(payload, 'utf8'),
      publicKeyPem,
      Buffer.from(signatureB64, 'base64')
    )
  } catch {
    return false
  }
}

function unlockReqPayload(roundId, toAuthorHex, requesterHex, ts) {
  return `unlockReq|${roundId}|${toAuthorHex}|${requesterHex}|${ts}`
}

function signUnlockReq(privateKeyPem, roundId, toAuthorHex, requesterHex, ts) {
  const payload = unlockReqPayload(roundId, toAuthorHex, requesterHex, ts)
  return crypto.sign('sha256', Buffer.from(payload, 'utf8'), privateKeyPem).toString('base64')
}

function verifyUnlockReqSignature(publicKeyPem, roundId, toAuthorHex, requesterHex, ts, signatureB64) {
  try {
    const payload = unlockReqPayload(roundId, toAuthorHex, requesterHex, ts)
    return crypto.verify(
      'sha256',
      Buffer.from(payload, 'utf8'),
      publicKeyPem,
      Buffer.from(signatureB64, 'base64')
    )
  } catch {
    return false
  }
}

function parseRequesterHexFromReqKey(key) {
  try {
    const parts = String(key).split(':')
    return parts[parts.length - 1] || null
  } catch {
    return null
  }
}

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

async function submitNote(pass, noteText, _groupKey, authorHex, authorPublicKeyPem, authorPrivateKeyPem) {
  const roundId = await getOrCreateCurrentRound(pass)

  const existing = await get(pass, noteKey(roundId, authorHex))
  if (existing) {
    throw new Error('Already submitted in this round')
  }

  const contentKey = b4a.alloc(32)
  sodium.randombytes_buf(contentKey)

  const ts = Date.now()
  const nonceRaw = b4a.alloc(16)
  const saltRaw = b4a.alloc(16)
  sodium.randombytes_buf(nonceRaw)
  sodium.randombytes_buf(saltRaw)
  const noteNonceHex = b4a.toString(nonceRaw, 'hex')
  const commitSaltHex = b4a.toString(saltRaw, 'hex')
  const commitment = hashCommit(roundId, noteText, commitSaltHex)
  const signature = signNote(authorPrivateKeyPem, roundId, authorHex, commitment, ts, noteNonceHex)

  const encryptedPayload = encryptContent(noteText, contentKey)
  const selfWrappedKey = wrapContentKeyForPeer(contentKey, authorPublicKeyPem)

  await put(pass, noteKey(roundId, authorHex), {
    ...encryptedPayload,
    author: authorHex,
    authorPublicKeyPem,
    ts,
    wrapAlg: WRAP_ALG,
    commitSaltHex,
    commitment,
    noteNonceHex,
    signature,
    sigAlg: 'rsa-sha256'
  })

  await put(pass, unlockGrantKey(roundId, authorHex, authorHex), {
    from: authorHex,
    to: authorHex,
    wrappedKey: selfWrappedKey,
    wrapAlg: WRAP_ALG,
    ts
  })

  return roundId
}

async function hasSubmitted(pass, authorHex) {
  const roundId = await getCurrentRound(pass)
  if (!roundId) return false
  return (await get(pass, noteKey(roundId, authorHex))) !== null
}

async function getPendingUnlockRequests(pass, localAuthorHex) {
  const roundId = await getCurrentRound(pass)
  if (!roundId) return []

  const myNote = await get(pass, noteKey(roundId, localAuthorHex))
  if (!myNote) return []

  const requests = await listByPrefix(pass, `round:${roundId}:unlockReq:${localAuthorHex}:`)
  const pending = []

  for (const reqEntry of requests) {
    const req = reqEntry.value
    const requesterHexFromPath = parseRequesterHexFromReqKey(reqEntry.key)
    const requesterHex = req?.from
    const requesterPub = req?.requesterPublicKeyPem
    if (!requesterHex || !requesterPub || !requesterHexFromPath) continue
    if (requesterHex !== requesterHexFromPath) continue
    if (req.to !== localAuthorHex) continue

    const signatureOk = verifyUnlockReqSignature(
      requesterPub,
      roundId,
      localAuthorHex,
      requesterHex,
      req.ts,
      req.signature
    )
    if (!signatureOk) continue

    const requesterSubmitted = await get(pass, noteKey(roundId, requesterHex))
    if (!requesterSubmitted) continue
    if (requesterSubmitted.authorPublicKeyPem !== requesterPub) continue

    const requesterNoteSigOk = verifyNoteSignature(
      requesterSubmitted.authorPublicKeyPem,
      roundId,
      requesterSubmitted.author,
      requesterSubmitted.commitment,
      requesterSubmitted.ts,
      requesterSubmitted.noteNonceHex,
      requesterSubmitted.signature
    )
    if (!requesterNoteSigOk) continue

    const grantPath = unlockGrantKey(roundId, localAuthorHex, requesterHex)
    const existingGrant = await get(pass, grantPath)
    if (existingGrant) continue

    pending.push({
      requesterHex,
      requestedAt: req.ts || Date.now()
    })
  }

  return pending.sort((a, b) => a.requestedAt - b.requestedAt)
}

async function approveUnlockRequest(pass, localAuthorHex, requesterHex, localPrivateKeyPem) {
  const roundId = await getCurrentRound(pass)
  if (!roundId) return { ok: false, error: 'No active round' }

  const myNote = await get(pass, noteKey(roundId, localAuthorHex))
  if (!myNote) return { ok: false, error: 'You have no note in this round' }

  const req = await get(pass, unlockReqKey(roundId, localAuthorHex, requesterHex))
  if (!req?.requesterPublicKeyPem) return { ok: false, error: 'No pending request for this peer' }
  if (req.to !== localAuthorHex || req.from !== requesterHex) return { ok: false, error: 'Malformed request' }

  const signatureOk = verifyUnlockReqSignature(
    req.requesterPublicKeyPem,
    roundId,
    localAuthorHex,
    requesterHex,
    req.ts,
    req.signature
  )
  if (!signatureOk) return { ok: false, error: 'Invalid request signature' }

  const requesterSubmitted = await get(pass, noteKey(roundId, requesterHex))
  if (!requesterSubmitted) return { ok: false, error: 'Requester has not submitted yet' }
  if (requesterSubmitted.authorPublicKeyPem !== req.requesterPublicKeyPem) {
    return { ok: false, error: 'Requester public key does not match submitted note' }
  }

  const requesterNoteSigOk = verifyNoteSignature(
    requesterSubmitted.authorPublicKeyPem,
    roundId,
    requesterSubmitted.author,
    requesterSubmitted.commitment,
    requesterSubmitted.ts,
    requesterSubmitted.noteNonceHex,
    requesterSubmitted.signature
  )
  if (!requesterNoteSigOk) {
    return { ok: false, error: 'Requester note signature is invalid' }
  }

  const grantPath = unlockGrantKey(roundId, localAuthorHex, requesterHex)
  const existingGrant = await get(pass, grantPath)
  if (existingGrant) return { ok: true, alreadyApproved: true }

  const selfGrant = await get(pass, unlockGrantKey(roundId, localAuthorHex, localAuthorHex))
  if (!selfGrant?.wrappedKey) return { ok: false, error: 'Missing local self grant' }

  const myContentKey = unwrapContentKey(selfGrant.wrappedKey, localPrivateKeyPem)
  if (!myContentKey) return { ok: false, error: 'Failed to recover content key' }

  await put(pass, grantPath, {
    from: localAuthorHex,
    to: requesterHex,
    wrappedKey: wrapContentKeyForPeer(myContentKey, req.requesterPublicKeyPem),
    wrapAlg: WRAP_ALG,
    ts: Date.now()
  })

  return { ok: true, approved: true }
}

async function ensureUnlockRequestForAuthor(pass, roundId, localAuthorHex, targetAuthorHex, localPublicKeyPem, localPrivateKeyPem) {
  if (targetAuthorHex === localAuthorHex) return

  const reqPath = unlockReqKey(roundId, targetAuthorHex, localAuthorHex)
  const existingReq = await get(pass, reqPath)
  if (existingReq) return

  const ts = Date.now()
  const signature = signUnlockReq(localPrivateKeyPem, roundId, targetAuthorHex, localAuthorHex, ts)

  await put(pass, reqPath, {
    from: localAuthorHex,
    to: targetAuthorHex,
    requesterPublicKeyPem: localPublicKeyPem,
    ts,
    signature,
    sigAlg: 'rsa-sha256'
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

  const results = []
  for (const { key, value: note } of notes) {
    if (!note?.author) continue

    const authorFromPath = parseAuthorHexFromNoteKey(key)
    if (!authorFromPath || authorFromPath !== note.author) {
      results.push({ author: note.author || 'unknown', content: null, ts: note.ts, hidden: true })
      continue
    }

    const noteSigOk = verifyNoteSignature(
      note.authorPublicKeyPem,
      roundId,
      note.author,
      note.commitment,
      note.ts,
      note.noteNonceHex,
      note.signature
    )
    if (!noteSigOk) {
      results.push({ author: note.author, content: null, ts: note.ts, hidden: true })
      continue
    }

    await ensureUnlockRequestForAuthor(pass, roundId, localAuthorHex, note.author, localPublicKeyPem, localPrivateKeyPem)

    const grant = await get(pass, unlockGrantKey(roundId, note.author, localAuthorHex))
    const mutualGrant = await get(pass, unlockGrantKey(roundId, localAuthorHex, note.author))
    let content = null
    if (note.author === localAuthorHex && grant?.wrappedKey) {
      const contentKey = unwrapContentKey(grant.wrappedKey, localPrivateKeyPem)
      if (contentKey) content = decryptContent(note.encrypted, note.nonce, contentKey)
    } else if (grant?.wrappedKey && mutualGrant?.wrappedKey) {
      const contentKey = unwrapContentKey(grant.wrappedKey, localPrivateKeyPem)
      if (contentKey) content = decryptContent(note.encrypted, note.nonce, contentKey)
    }

    if (content !== null) {
      const computedCommit = hashCommit(roundId, content, note.commitSaltHex)
      if (computedCommit !== note.commitment) {
        content = null
      }
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
  getPendingUnlockRequests,
  approveUnlockRequest,
  getRoundMeta,
  scheduleBeReal
}