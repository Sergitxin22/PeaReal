// renderer/app.js
// All UI logic. Communicates with main via window.peareal (exposed by preload.js).
// No Node.js APIs here — pure DOM + the IPC bridge.

;(async () => {
  // ── Element refs ────────────────────────────────────────────────────────────

  const $ = id => document.getElementById(id)
  const screenAuth  = $('screen-auth')
  const screenFeed  = $('screen-feed')

  // Auth
  const btnCreate     = $('btn-create')
  const btnJoin       = $('btn-join')
  const inputInvite   = $('input-invite')
  const authError     = $('auth-error')
  const inviteBox     = $('invite-box')
  const inviteCode    = $('invite-code')
  const btnCopyInvite = $('btn-copy-invite')
  const btnGoFeed     = $('btn-go-feed')
  const authorTag     = $('author-tag')

  // Feed states
  const stateWaiting = $('state-waiting')
  const stateSubmit  = $('state-submit')
  const stateFeed    = $('state-feed')

  const noteInput    = $('note-input')
  const charCount    = $('char-count')
  const btnSubmit    = $('btn-submit')
  const submitError  = $('submit-error')

  const feedList     = $('feed-list')
  const feedEmpty    = $('feed-empty')
  const feedRoundTime= $('feed-round-time')
  const pendingPeers = $('pending-peers')
  const pendingList  = $('pending-list')

  const btnTrigger   = $('btn-trigger')
  const toast        = $('toast')

  // ── State ────────────────────────────────────────────────────────────────────

  let isConnected = false
  let pollInterval = null

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function showScreen (name) {
    screenAuth.classList.add('hidden')
    screenFeed.classList.add('hidden')
    if (name === 'auth') screenAuth.classList.remove('hidden')
    if (name === 'feed') screenFeed.classList.remove('hidden')
  }

  function showFeedState (name) {
    stateWaiting.classList.add('hidden')
    stateSubmit.classList.add('hidden')
    stateFeed.classList.add('hidden')
    if (name === 'waiting') stateWaiting.classList.remove('hidden')
    if (name === 'submit')  stateSubmit.classList.remove('hidden')
    if (name === 'feed')    stateFeed.classList.remove('hidden')
  }

  function showError (el, msg) {
    el.textContent = msg
    el.classList.remove('hidden')
    setTimeout(() => el.classList.add('hidden'), 5000)
  }

  let toastTimer = null
  function showToast (msg, duration = 3000) {
    toast.textContent = msg
    toast.classList.remove('hidden')
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => toast.classList.add('hidden'), duration)
  }

  function formatTime (ms) {
    if (!ms) return ''
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  function shortId (hex) {
    return hex ? hex.slice(0, 8) : '???'
  }

  function colorFromId (hex) {
    // Generate a consistent hue from the first 4 chars of the hex id
    const hue = parseInt(hex.slice(0, 4), 16) % 360
    return `hsl(${hue}, 70%, 55%)`
  }

  // ── Auth flow ─────────────────────────────────────────────────────────────────

  btnCreate.addEventListener('click', async () => {
    btnCreate.disabled = true
    btnCreate.textContent = 'Creating…'
    const res = await window.peareal.createGroup()
    btnCreate.disabled = false
    btnCreate.textContent = 'Create a Group'

    if (!res.ok) {
      showError(authError, res.error || 'Failed to create group')
      return
    }

    authorTag.textContent = `#${shortId(res.authorHex)}`
    inviteCode.textContent = res.invite
    inviteBox.classList.remove('hidden')
    isConnected = true
  })

  btnCopyInvite.addEventListener('click', () => {
    navigator.clipboard.writeText(inviteCode.textContent)
    showToast('Invite code copied!')
  })

  btnGoFeed.addEventListener('click', () => {
    showScreen('feed')
    startFeedPolling()
    refreshFeed()
  })

  btnJoin.addEventListener('click', async () => {
    const code = inputInvite.value.trim()
    if (!code) { showError(authError, 'Paste an invite code first'); return }

    btnJoin.disabled = true
    btnJoin.textContent = 'Joining…'
    const res = await window.peareal.joinGroup(code)
    btnJoin.disabled = false
    btnJoin.textContent = 'Join Group'

    if (!res.ok) {
      showError(authError, res.error || 'Failed to join group')
      return
    }

    authorTag.textContent = `#${shortId(res.authorHex)}`
    isConnected = true
    showScreen('feed')
    startFeedPolling()
    refreshFeed()
  })

  // ── Note submission ───────────────────────────────────────────────────────────

  noteInput.addEventListener('input', () => {
    charCount.textContent = noteInput.value.length
  })

  btnSubmit.addEventListener('click', async () => {
    const text = noteInput.value.trim()
    if (!text) { showError(submitError, 'Write something first!'); return }

    btnSubmit.disabled = true
    btnSubmit.textContent = 'Submitting…'
    const res = await window.peareal.submitNote(text)
    btnSubmit.disabled = false
    btnSubmit.textContent = 'Submit & Reveal 👁'

    if (!res.ok) {
      showError(submitError, res.error || 'Submission failed')
      return
    }

    noteInput.value = ''
    charCount.textContent = '0'
    showToast('Note submitted! 🍐')
    await refreshFeed()
  })

  // ── Feed rendering ────────────────────────────────────────────────────────────

  async function refreshFeed () {
    if (!isConnected) return

    const res = await window.peareal.getFeed()
    if (!res.ok) return

    const { notes, submitted, meta } = res

    if (!meta) {
      // No active round yet
      showFeedState('waiting')
      return
    }

    if (!submitted) {
      // Round active but local user hasn't submitted
      showFeedState('submit')
      return
    }

    // User has submitted — show feed
    showFeedState('feed')

    if (meta?.triggeredAt) {
      feedRoundTime.textContent = `Round started at ${formatTime(meta.triggeredAt)}`
    }

    feedList.innerHTML = ''

    if (notes.length === 0) {
      feedEmpty.classList.remove('hidden')
    } else {
      feedEmpty.classList.add('hidden')
      notes.forEach(note => {
        feedList.appendChild(renderNoteCard(note))
      })
    }
  }

  function renderNoteCard (note) {
    const card = document.createElement('div')
    card.className = 'note-card' + (note.hidden ? ' hidden-note' : '')

    const avatarColor = colorFromId(note.author || '0000')
    const initials = (note.author || '??').slice(0, 2).toUpperCase()

    card.innerHTML = `
      <div class="note-meta">
        <div class="note-avatar" style="background:${avatarColor}">${initials}</div>
        <span class="note-author">#${shortId(note.author)}</span>
        <span class="note-time">${formatTime(note.ts)}</span>
      </div>
      ${note.hidden
        ? `<div class="note-content blurred">████████████████</div>
           <div class="note-hidden-label">🔒 Submit your note to reveal this</div>`
        : `<div class="note-content">${escapeHtml(note.content)}</div>`
      }
    `
    return card
  }

  function escapeHtml (str) {
    if (!str) return ''
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  // ── Dev controls ──────────────────────────────────────────────────────────────

  btnTrigger.addEventListener('click', async () => {
    await window.peareal.triggerNow()
    showToast('⚡ New round triggered!')
    await refreshFeed()
  })

  // ── Event listeners from main process ────────────────────────────────────────

  window.peareal.onBeRealTrigger(async () => {
    showToast('🍐 PeaReal time! Share your moment!', 5000)
    if (isConnected) {
      showFeedState('submit')
      noteInput.value = ''
      charCount.textContent = '0'
    }
  })

  window.peareal.onFeedUpdated(async () => {
    if (isConnected) await refreshFeed()
  })

  // ── Polling (backup in case websocket events miss something) ─────────────────

  function startFeedPolling () {
    if (pollInterval) clearInterval(pollInterval)
    pollInterval = setInterval(refreshFeed, 5000) // refresh every 5s
  }

  // ── Boot: try to resume existing session ─────────────────────────────────────

  const resumed = await window.peareal.resumeSession()
  if (resumed.ok) {
    isConnected = true
    authorTag.textContent = `#${shortId(resumed.authorHex)}`
    showScreen('feed')
    startFeedPolling()
    await refreshFeed()
  } else {
    showScreen('auth')
  }

})()