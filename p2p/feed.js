// p2p/feed.js
// Manages the BeReal-style feed:
//   - Encrypting a note before storing it (XOR cipher with group key)
//   - Revealing notes only after the local user has submitted
//   - Wiping all notes when a new round starts
//
// Key schema in Autopass:
//   round:<roundId>:note:<publicKeyHex>   → { encrypted: <hex>, author: <hex>, ts: <ms> }
//   round:<roundId>:meta                  → { startedAt: <ms>, triggeredAt: <ms> }
//   config:currentRound                   → <roundId string>

const { put, get, del, listByPrefix } = require('./peer')
const b4a = require('b4a')

// ─── Encryption helpers ───────────────────────────────────────────────────────

/**
 * XOR-encrypt a plaintext string with a 32-byte key Buffer.
 * We cycle the key bytes across the plaintext.
 * Returns a hex string.
 */
function xorEncrypt (plaintext, keyBuf) {
  const plain = b4a.from(plaintext, 'utf8')
  const out = b4a.alloc(plain.length)
  for (let i = 0; i < plain.length; i++) {
    out[i] = plain[i] ^ keyBuf[i % keyBuf.length]
  }
  return b4a.toString(out, 'hex')
}

/**
 * Decrypt a hex-encoded XOR-encrypted string.
 * Returns the original plaintext string.
 */
function xorDecrypt (hexCipher, keyBuf) {
  const cipher = b4a.from(hexCipher, 'hex')
  const out = b4a.alloc(cipher.length)
  for (let i = 0; i < cipher.length; i++) {
    out[i] = cipher[i] ^ keyBuf[i % keyBuf.length]
  }
  return b4a.toString(out, 'utf8')
}

// ─── Round management ─────────────────────────────────────────────────────────

/**
 * Read the current round ID from shared state.
 * Returns null when no round exists yet.
 */
async function getCurrentRound (pass) {
  return await get(pass, 'config:currentRound')
}

async function getOrCreateCurrentRound (pass) {
  const roundId = await getCurrentRound(pass)
  if (!roundId) {
    return await startNewRound(pass)
  }
  return roundId
}

/**
 * Start a new round: wipe old notes, write new round metadata.
 * Returns the new roundId.
 */
async function startNewRound (pass) {
  const roundId = String(Date.now())

  // Wipe all notes from previous round
  const oldRound = await get(pass, 'config:currentRound')
  if (oldRound) {
    await wipeRound(pass, oldRound)
  }

  await put(pass, 'config:currentRound', roundId)
  await put(pass, `round:${roundId}:meta`, {
    startedAt: Date.now(),
    triggeredAt: Date.now()
  })

  return roundId
}

/**
 * Delete all note entries for a given round.
 */
async function wipeRound (pass, roundId) {
  const prefix = `round:${roundId}:note:`
  const entries = await listByPrefix(pass, prefix)
  for (const { key } of entries) {
    await del(pass, key)
  }
  await del(pass, `round:${roundId}:meta`)
}

// ─── Note operations ──────────────────────────────────────────────────────────

/**
 * Submit the local user's note for the current round.
 * Encrypts with the group key before storing.
 *
 * @param {Autopass} pass
 * @param {string}   noteText  — plaintext note
 * @param {Buffer}   groupKey  — 32-byte encryption key
 * @param {string}   authorHex — hex of local public key (for display)
 * @returns {string} roundId
 */
async function submitNote (pass, noteText, groupKey, authorHex) {
  const roundId = await getOrCreateCurrentRound(pass)
  const encrypted = xorEncrypt(noteText, groupKey)

  await put(pass, `round:${roundId}:note:${authorHex}`, {
    encrypted,
    author: authorHex,
    ts: Date.now()
  })

  return roundId
}

/**
 * Check if the local user has already submitted a note this round.
 */
async function hasSubmitted (pass, authorHex) {
  const roundId = await getCurrentRound(pass)
  if (!roundId) return false
  const entry = await get(pass, `round:${roundId}:note:${authorHex}`)
  return entry !== null && !entry._tombstone
}

/**
 * Fetch all notes for the current round.
 * If localUserSubmitted is false, returns entries with content = null (hidden).
 * If true, decrypts and returns all content.
 *
 * @param {Autopass} pass
 * @param {boolean}  localUserSubmitted
 * @param {Buffer}   groupKey
 * @returns {Array<{ author, content, ts, hidden }>}
 */
async function getFeedNotes (pass, localUserSubmitted, groupKey) {
  const roundId = await getCurrentRound(pass)
  if (!roundId) return []
  const prefix = `round:${roundId}:note:`
  const entries = await listByPrefix(pass, prefix)

  return entries.map(({ value }) => {
    if (!localUserSubmitted) {
      return {
        author: value.author,
        content: null,
        ts: value.ts,
        hidden: true
      }
    }
    return {
      author: value.author,
      content: xorDecrypt(value.encrypted, groupKey),
      ts: value.ts,
      hidden: false
    }
  })
}

/**
 * Get current round metadata (startedAt, triggeredAt).
 */
async function getRoundMeta (pass) {
  const roundId = await getCurrentRound(pass)
  if (!roundId) return null
  return await get(pass, `round:${roundId}:meta`)
}

// ─── BeReal timer ─────────────────────────────────────────────────────────────

/**
 * Schedule the next BeReal trigger at a random time within the next 24h window.
 * In dev/test mode you can pass shortMs to fire after N milliseconds instead.
 *
 * Calls onTrigger() when it fires, then re-schedules itself.
 *
 * @param {Function} onTrigger   — async callback
 * @param {number}   [shortMs]   — if set, use this delay instead of random 24h
 * @returns {Function} cancel — call to stop the timer
 */
function scheduleBeReal (onTrigger, shortMs) {
  let timer = null

  function schedule () {
    // Random delay: between 0 and 24 hours (in ms), or shortMs for testing
    const delay = shortMs !== undefined
      ? shortMs
      : Math.floor(Math.random() * 24 * 60 * 60 * 1000)

    const fireAt = new Date(Date.now() + delay)
    console.log(`[BeReal] Next trigger scheduled for: ${fireAt.toLocaleTimeString()} (in ${Math.round(delay / 1000)}s)`)

    timer = setTimeout(async () => {
      console.log('[BeReal] 🔔 Trigger fired!')
      await onTrigger()
      schedule() // re-schedule for next day
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
  scheduleBeReal,
  xorEncrypt,
  xorDecrypt
}