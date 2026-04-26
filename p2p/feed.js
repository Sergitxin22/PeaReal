// p2p/feed.js
//
// Message encryption and unlock protocol:
//   - Each note uses a random content key (CK) with XChaCha20-Poly1305.
//   - Ciphertext is replicated to everyone.
//   - Unlock is automatic: peers that submitted exchange wrapped CK grants.

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
function unlockGrantKey(roundId, authorHex, requesterHex) { return `round:${roundId}:unlockGrant:${authorHex}:${requesterHex}` }
function commentPrefix(roundId, noteAuthorHex) { return `round:${roundId}:comment:${noteAuthorHex}:` }
function commentKey(roundId, noteAuthorHex, commentId) { return `${commentPrefix(roundId, noteAuthorHex)}${commentId}` }
function reactionPrefix(roundId, noteAuthorHex) { return `round:${roundId}:reaction:${noteAuthorHex}:` }
function reactionKey(roundId, noteAuthorHex, reactorAuthorHex) { return `${reactionPrefix(roundId, noteAuthorHex)}${reactorAuthorHex}` }

const ALLOWED_REACTIONS = new Set(['❤️', '😂', '🔥', '👍', '😮', '😢'])

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

function buildCommentId() {
  const ts = Date.now()
  const rnd = crypto.randomBytes(4).toString('hex')
  return `${ts}-${rnd}`
}

function normalizeCommentText(text) {
  const normalized = String(text || '').trim().replace(/\s+/g, ' ')
  if (!normalized) throw new Error('El comentario no puede estar vacio')
  if (normalized.length > 500) throw new Error('El comentario es demasiado largo (max 500 caracteres)')
  return normalized
}

function normalizeReactionEmoji(emoji) {
  const normalized = String(emoji || '').trim()
  if (!ALLOWED_REACTIONS.has(normalized)) {
    throw new Error('Reaccion no soportada')
  }
  return normalized
}

async function listCommentsForNote(pass, roundId, noteAuthorHex) {
  const raw = await listByPrefix(pass, commentPrefix(roundId, noteAuthorHex))
  return raw
    .map(({ value }) => value)
    .filter(v => v && typeof v === 'object' && v.author && typeof v.text === 'string')
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
}

async function listReactionsForNote(pass, roundId, noteAuthorHex, localAuthorHex) {
  const raw = await listByPrefix(pass, reactionPrefix(roundId, noteAuthorHex))
  const counts = {}
  let mine = null

  for (const { value } of raw) {
    if (!value || typeof value !== 'object') continue
    const reaction = String(value.reaction || '').trim()
    if (!ALLOWED_REACTIONS.has(reaction)) continue
    counts[reaction] = (counts[reaction] || 0) + 1
    if (String(value.author || '') === String(localAuthorHex || '')) {
      mine = reaction
    }
  }

  return { counts, mine }
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

async function canDecryptNote(pass, roundId, note, localAuthorHex, localPrivateKeyPem) {
  if (!note?.author) return false
  const grant = await get(pass, unlockGrantKey(roundId, note.author, localAuthorHex))
  if (!grant?.wrappedKey) return false
  const contentKey = unwrapContentKey(grant.wrappedKey, localPrivateKeyPem)
  if (!contentKey) return false
  const content = decryptContent(note.encrypted, note.nonce, contentKey)
  if (content === null) return false
  const computedCommit = hashCommit(roundId, content, note.commitSaltHex)
  return computedCommit === note.commitment
}

async function submitComment(pass, noteAuthorHex, text, localAuthorHex, localPrivateKeyPem) {
  const roundId = await getCurrentRound(pass)
  if (!roundId) throw new Error('No hay ronda activa')

  const commentText = normalizeCommentText(text)
  const targetAuthor = String(noteAuthorHex || '').trim()
  if (!targetAuthor) throw new Error('Foto no valida')

  const targetNote = await get(pass, noteKey(roundId, targetAuthor))
  if (!targetNote) throw new Error('La foto no existe en la ronda actual')

  const submitted = await hasSubmitted(pass, localAuthorHex)
  if (!submitted) throw new Error('Debes publicar tu foto antes de comentar')

  const canDecrypt = await canDecryptNote(pass, roundId, targetNote, localAuthorHex, localPrivateKeyPem)
  if (!canDecrypt) throw new Error('Solo puedes comentar fotos que tengas desbloqueadas')

  const ts = Date.now()
  const id = buildCommentId()
  const payload = {
    id,
    noteAuthor: targetAuthor,
    author: localAuthorHex,
    text: commentText,
    ts
  }

  await put(pass, commentKey(roundId, targetAuthor, id), payload)
  return payload
}

async function submitReaction(pass, noteAuthorHex, reactionEmoji, localAuthorHex, localPrivateKeyPem) {
  const roundId = await getCurrentRound(pass)
  if (!roundId) throw new Error('No hay ronda activa')

  const reaction = normalizeReactionEmoji(reactionEmoji)
  const targetAuthor = String(noteAuthorHex || '').trim()
  if (!targetAuthor) throw new Error('Foto no valida')

  const targetNote = await get(pass, noteKey(roundId, targetAuthor))
  if (!targetNote) throw new Error('La foto no existe en la ronda actual')

  const submitted = await hasSubmitted(pass, localAuthorHex)
  if (!submitted) throw new Error('Debes publicar tu foto antes de reaccionar')

  const canDecrypt = await canDecryptNote(pass, roundId, targetNote, localAuthorHex, localPrivateKeyPem)
  if (!canDecrypt) throw new Error('Solo puedes reaccionar a fotos que tengas desbloqueadas')

  const key = reactionKey(roundId, targetAuthor, localAuthorHex)
  const existing = await get(pass, key)
  const existingReaction = String(existing?.reaction || '').trim()

  if (existingReaction === reaction) {
    await del(pass, key)
    return { active: false, reaction: null }
  }

  await put(pass, key, {
    noteAuthor: targetAuthor,
    author: localAuthorHex,
    reaction,
    ts: Date.now()
  })
  return { active: true, reaction }
}

async function ensureAutoGrantForPeer(pass, roundId, localAuthorHex, targetAuthorHex, targetPublicKeyPem, localPrivateKeyPem) {
  if (targetAuthorHex === localAuthorHex) return
  if (!targetPublicKeyPem) return

  const targetNote = await get(pass, noteKey(roundId, targetAuthorHex))
  if (!targetNote) return

  const existingGrant = await get(pass, unlockGrantKey(roundId, localAuthorHex, targetAuthorHex))
  if (existingGrant?.wrappedKey) return

  const selfGrant = await get(pass, unlockGrantKey(roundId, localAuthorHex, localAuthorHex))
  if (!selfGrant?.wrappedKey) return

  const myContentKey = unwrapContentKey(selfGrant.wrappedKey, localPrivateKeyPem)
  if (!myContentKey) return

  await put(pass, unlockGrantKey(roundId, localAuthorHex, targetAuthorHex), {
    from: localAuthorHex,
    to: targetAuthorHex,
    wrappedKey: wrapContentKeyForPeer(myContentKey, targetPublicKeyPem),
    wrapAlg: WRAP_ALG,
    ts: Date.now(),
    auto: true
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

    await ensureAutoGrantForPeer(
      pass,
      roundId,
      localAuthorHex,
      note.author,
      note.authorPublicKeyPem,
      localPrivateKeyPem
    )

    const grant = await get(pass, unlockGrantKey(roundId, note.author, localAuthorHex))
    let content = null
    if (note.author === localAuthorHex && grant?.wrappedKey) {
      const contentKey = unwrapContentKey(grant.wrappedKey, localPrivateKeyPem)
      if (contentKey) content = decryptContent(note.encrypted, note.nonce, contentKey)
    } else if (grant?.wrappedKey) {
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
      results.push({
        author: note.author,
        content: null,
        ts: note.ts,
        hidden: true,
        comments: [],
        reactions: { counts: {}, mine: null }
      })
    } else {
      const comments = await listCommentsForNote(pass, roundId, note.author)
      const reactions = await listReactionsForNote(pass, roundId, note.author, localAuthorHex)
      results.push({ author: note.author, content, ts: note.ts, hidden: false, comments, reactions })
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
  submitComment,
  submitReaction,
  hasSubmitted,
  getFeedNotes,
  getRoundMeta,
  scheduleBeReal
}