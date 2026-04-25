// p2p/feed.js
//
// Encryption: libsodium secretbox (XSalsa20-Poly1305) via sodium-universal
//   - Authenticated encryption: if the key is wrong or data is tampered, decrypt returns null
//   - Each user encrypts with their own 32-byte key derived from their writerKey
//   - On submit, they publish their key to the shared store
//   - Peers can only decrypt once the key is published (i.e. after submit)
//
// Key schema:
//   round:<id>:note:<authorHex>  → { encrypted: <hex>, nonce: <hex>, author, ts }
//   round:<id>:key:<authorHex>   → { key: <hex>, author }
//   round:<id>:meta              → { startedAt, triggeredAt }
//   config:currentRound          → <roundId string>

const { put, get, del, listByPrefix } = require('./peer')
const sodium = require('sodium-universal')
const b4a = require('b4a')

// ─── Encryption (libsodium secretbox = XSalsa20-Poly1305) ────────────────────

/**
 * Encrypt plaintext with a 32-byte key.
 * Generates a random 24-byte nonce per message.
 * Returns { encrypted: hex, nonce: hex }
 */
function encrypt (plaintext, keyBuf) {
  const msg = b4a.from(plaintext, 'utf8')
  const nonce = b4a.alloc(sodium.crypto_secretbox_NONCEBYTES)
  sodium.randombytes_buf(nonce)

  const ciphertext = b4a.alloc(msg.length + sodium.crypto_secretbox_MACBYTES)
  sodium.crypto_secretbox_easy(ciphertext, msg, nonce, keyBuf)

  return {
    encrypted: b4a.toString(ciphertext, 'hex'),
    nonce: b4a.toString(nonce, 'hex')
  }
}

/**
 * Decrypt. Returns plaintext string, or null if key is wrong / data tampered.
 * The Poly1305 MAC means any wrong key produces null — not garbage output.
 */
function decrypt (encryptedHex, nonceHex, keyBuf) {
  try {
    const ciphertext = b4a.from(encryptedHex, 'hex')
    const nonce = b4a.from(nonceHex, 'hex')
    const plaintext = b4a.alloc(ciphertext.length - sodium.crypto_secretbox_MACBYTES)
    const ok = sodium.crypto_secretbox_open_easy(plaintext, ciphertext, nonce, keyBuf)
    if (!ok) return null
    return b4a.toString(plaintext, 'utf8')
  } catch {
    return null
  }
}

// ─── Round management ─────────────────────────────────────────────────────────

async function getCurrentRound (pass) {
  return await get(pass, 'config:currentRound')
}

async function getOrCreateCurrentRound (pass) {
  const roundId = await getCurrentRound(pass)
  if (!roundId) return await startNewRound(pass)
  return roundId
}

async function startNewRound (pass) {
  const roundId = String(Date.now())
  const oldRound = await get(pass, 'config:currentRound')
  if (oldRound) await wipeRound(pass, oldRound)
  await put(pass, 'config:currentRound', roundId)
  await put(pass, `round:${roundId}:meta`, {
    startedAt: Date.now(),
    triggeredAt: Date.now()
  })
  return roundId
}

async function wipeRound (pass, roundId) {
  for (const { key } of await listByPrefix(pass, `round:${roundId}:`)) {
    await del(pass, key)
  }
}

// ─── Note operations ──────────────────────────────────────────────────────────

async function submitNote (pass, noteText, personalKey, authorHex) {
  const roundId = await getOrCreateCurrentRound(pass)
  const { encrypted, nonce } = encrypt(noteText, personalKey)

  await put(pass, `round:${roundId}:note:${authorHex}`, {
    encrypted, nonce, author: authorHex, ts: Date.now()
  })

  // Publishing the key is the atomic "unlock" action
  await put(pass, `round:${roundId}:key:${authorHex}`, {
    key: b4a.toString(personalKey, 'hex'),
    author: authorHex
  })

  return roundId
}

async function hasSubmitted (pass, authorHex) {
  const roundId = await getCurrentRound(pass)
  if (!roundId) return false
  return (await get(pass, `round:${roundId}:key:${authorHex}`)) !== null
}

/**
 * Fetch all notes. For each note:
 *   - If author's key exists in store → decrypt (secretbox)
 *   - If not → hidden: true (no key = mathematically unreadable)
 *
 * Used for BOTH the submit screen (shows locked cards) and the feed screen.
 */
async function getFeedNotes (pass, localAuthorHex) {
  const roundId = await getCurrentRound(pass)
  if (!roundId) return []

  const noteEntries = await listByPrefix(pass, `round:${roundId}:note:`)
  const results = []

  for (const { value: note } of noteEntries) {
    const keyEntry = await get(pass, `round:${roundId}:key:${note.author}`)

    if (!keyEntry) {
      results.push({ author: note.author, content: null, ts: note.ts, hidden: true, isOwn: note.author === localAuthorHex })
      continue
    }

    const keyBuf = b4a.from(keyEntry.key, 'hex')
    const content = decrypt(note.encrypted, note.nonce, keyBuf)
    results.push({ author: note.author, content: content ?? '[decryption failed]', ts: note.ts, hidden: false, isOwn: note.author === localAuthorHex })
  }

  return results
}

async function getRoundMeta (pass) {
  const roundId = await getCurrentRound(pass)
  if (!roundId) return null
  return await get(pass, `round:${roundId}:meta`)
}

function scheduleBeReal (onTrigger) {
  let timer = null
  function msUntilNextTrigger () {
    const now = new Date()
    const hour = 9 + Math.floor(Math.random() * 13)
    const minute = Math.floor(Math.random() * 60)
    const trigger = new Date(now)
    trigger.setHours(hour, minute, 0, 0)
    if (trigger <= now) trigger.setDate(trigger.getDate() + 1)
    return trigger.getTime() - now.getTime()
  }
  function schedule () {
    const delay = msUntilNextTrigger()
    const fireAt = new Date(Date.now() + delay)
    console.log(`[BeReal] Next trigger: ${fireAt.toLocaleString()} (in ${Math.round(delay / 1000 / 60)}min)`)
    timer = setTimeout(async () => {
      console.log('[BeReal] 🔔 Triggered!')
      await onTrigger()
      schedule()
    }, delay)
  }
  schedule()
  return () => { if (timer) clearTimeout(timer) }
}

module.exports = { getCurrentRound, startNewRound, submitNote, hasSubmitted, getFeedNotes, getRoundMeta, scheduleBeReal }