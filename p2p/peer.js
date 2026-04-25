// p2p/peer.js — Autopass v3 compatible
// v3 API differences from v4:
//   pass.put()  → pass.add(key, value)
//   pass.del()  → pass.remove(key)
//   pass.get()  → returns { value, file } or null
//   pass.list() → returns a stream with .toArray()

async function put (pass, key, value) {
  const payload = typeof value === 'string' ? value : JSON.stringify(value)
  await pass.add(key, payload)
}

async function get (pass, key) {
  try {
    const result = await pass.get(key)
    if (result === null || result === undefined) return null
    const raw = result.value ?? result  // v3 wraps in { value, file }
    try { return JSON.parse(raw) } catch { return raw }
  } catch {
    return null
  }
}

async function del (pass, key) {
  try { await pass.remove(key) } catch { /* ignore if key doesn't exist */ }
}

async function listByPrefix (pass, prefix) {
  const results = []
  try {
    // pass.list() in v3 returns a ReadableStream — use toArray()
    const all = await pass.list().toArray()
    for (const entry of all) {
      const key = entry.key
      if (!key.startsWith(prefix)) continue
      const raw = entry.value ?? entry
      try {
        const parsed = JSON.parse(raw)
        results.push({ key, value: parsed })
      } catch {
        results.push({ key, value: raw })
      }
    }
  } catch (e) {
    console.error('[listByPrefix] error:', e.message)
  }
  return results
}

// Autopass v3 emits 'update' on the instance when the store changes
function watch (pass, onChange) {
  pass.on('update', onChange)
  return () => pass.off('update', onChange)
}

module.exports = { put, get, del, listByPrefix, watch }