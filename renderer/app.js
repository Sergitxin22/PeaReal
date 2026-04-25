// renderer/app.js
; (async () => {
  const $ = id => document.getElementById(id)
  const screenAuth = $('screen-auth')
  const screenFeed = $('screen-feed')
  const btnCreate = $('btn-create')
  const btnJoin = $('btn-join')
  const inputInvite = $('input-invite')
  const authError = $('auth-error')
  const inviteBox = $('invite-box')
  const inviteCode = $('invite-code')
  const btnCopyInvite = $('btn-copy-invite')
  const btnGoFeed = $('btn-go-feed')
  const authorTag = $('author-tag')
  const stateWaiting = $('state-waiting')
  const stateSubmit = $('state-submit')
  const stateFeed = $('state-feed')
  const noteInput = $('note-input')
  const charCount = $('char-count')
  const btnSubmit = $('btn-submit')
  const submitError = $('submit-error')
  const submitLockedList = $('submit-locked-list')  // locked cards on submit screen
  const feedList = $('feed-list')
  const feedEmpty = $('feed-empty')
  const feedRoundTime = $('feed-round-time')
  const unlockRequests = $('unlock-requests')
  const unlockRequestsList = $('unlock-requests-list')
  const btnTrigger = $('btn-trigger')
  const toast = $('toast')

  let isConnected = false
  let pollInterval = null

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function showScreen(name) {
    screenAuth.classList.add('hidden')
    screenFeed.classList.add('hidden')
    $('screen-' + name)?.classList.remove('hidden')
  }

  function showFeedState(name) {
    stateWaiting.classList.add('hidden')
    stateSubmit.classList.add('hidden')
    stateFeed.classList.add('hidden')
    $('state-' + name)?.classList.remove('hidden')
  }

  function showError(el, msg) {
    el.textContent = msg
    el.classList.remove('hidden')
    setTimeout(() => el.classList.add('hidden'), 8000)
  }

  let toastTimer = null
  function showToast(msg, duration = 3000) {
    toast.textContent = msg
    toast.classList.remove('hidden')
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => toast.classList.add('hidden'), duration)
  }

  function formatTime(ms) {
    if (!ms) return ''
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  function shortId(hex) { return hex ? hex.slice(0, 8) : '???' }

  function formatDateTime(ms) {
    if (!ms) return ''
    return new Date(ms).toLocaleString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }

  function colorFromId(hex) {
    const hue = parseInt((hex || '0000').slice(0, 4), 16) % 360
    return `hsl(${hue}, 70%, 55%)`
  }

  // ── Auth ──────────────────────────────────────────────────────────────────────

  btnCreate.addEventListener('click', async () => {
    btnCreate.disabled = true
    btnCreate.textContent = 'Creating…'
    const res = await window.peareal.createGroup().catch(e => ({ ok: false, error: e.message }))
    btnCreate.disabled = false
    btnCreate.textContent = 'Create a Group'
    if (!res?.ok) { showError(authError, res?.error || 'Failed to create group'); return }
    if (!res.invite) { showError(authError, 'No invite code returned'); return }
    authorTag.textContent = `#${shortId(res.authorHex)}`
    inviteCode.textContent = res.invite
    inviteBox.classList.remove('hidden')
    isConnected = true
    showToast('Group created! Share the invite code.')
  })

  btnCopyInvite.addEventListener('click', () => {
    navigator.clipboard.writeText(inviteCode.textContent.trim())
      .then(() => showToast('Copied!'))
      .catch(() => { window.getSelection().selectAllChildren(inviteCode); showToast('Select + copy manually') })
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
    const res = await window.peareal.joinGroup(code).catch(e => ({ ok: false, error: e.message }))
    btnJoin.disabled = false
    btnJoin.textContent = 'Join Group'
    if (!res?.ok) { showError(authError, res?.error || 'Failed to join'); return }
    authorTag.textContent = `#${shortId(res.authorHex)}`
    isConnected = true
    showScreen('feed')
    startFeedPolling()
    refreshFeed()
  })

  // ── Feed ──────────────────────────────────────────────────────────────────────

  async function refreshFeed() {
    if (!isConnected) return
    const res = await window.peareal.getFeed()
    if (!res?.ok) return
    const { notes, submitted, meta } = res

    if (!meta) { showFeedState('waiting'); return }

    if (!submitted) {
      // Show submit form AND locked cards from peers who already posted
      showFeedState('submit')
      renderLockedCards(notes)
      return
    }

    // User submitted — show full feed with decrypted notes
    showFeedState('feed')
    await refreshPendingUnlockRequests()
    if (meta?.triggeredAt) feedRoundTime.textContent = `Round started at ${formatTime(meta.triggeredAt)}`
    feedList.innerHTML = ''
    if (!notes?.length) {
      feedEmpty.classList.remove('hidden')
    } else {
      feedEmpty.classList.add('hidden')
      notes.forEach(n => feedList.appendChild(renderNoteCard(n)))
    }
  }

  async function refreshPendingUnlockRequests() {
    if (!unlockRequests || !unlockRequestsList) return

    const res = await window.peareal.getPendingUnlockRequests().catch(() => ({ ok: false, requests: [] }))
    if (!res?.ok || !Array.isArray(res.requests) || res.requests.length === 0) {
      unlockRequests.classList.add('hidden')
      unlockRequestsList.innerHTML = ''
      return
    }

    unlockRequests.classList.remove('hidden')
    unlockRequestsList.innerHTML = ''

    for (const req of res.requests) {
      const row = document.createElement('div')
      row.className = 'unlock-request-item'
      row.innerHTML = `
        <div class="unlock-request-meta">
          <strong>#${shortId(req.requesterHex)}</strong>
          <span>Requested at ${escapeHtml(formatDateTime(req.requestedAt))}</span>
        </div>
        <button class="btn btn-secondary btn-sm" data-approve-request="${escapeHtml(req.requesterHex)}">Approve</button>
      `
      unlockRequestsList.appendChild(row)
    }
  }

  /**
   * Render locked preview cards on the submit screen.
   * Shows how many peers have already posted, but content is cryptographically hidden.
   */
  function renderLockedCards(notes) {
    if (!submitLockedList) return
    submitLockedList.innerHTML = ''
    const otherNotes = (notes || []).filter(n => !n.isOwn)
    if (otherNotes.length === 0) {
      submitLockedList.innerHTML = '<p class="muted" style="text-align:center;font-size:0.82rem">No one has posted yet — be first!</p>'
      return
    }
    otherNotes.forEach(note => {
      submitLockedList.appendChild(renderNoteCard(note))
    })
  }

  function renderNoteCard(note) {
    const card = document.createElement('div')
    card.className = 'note-card' + (note.hidden ? ' hidden-note' : '')
    const avatarColor = colorFromId(note.author || '0000')
    const initials = (note.author || '??').slice(0, 2).toUpperCase()
    card.innerHTML = `
      <div class="note-meta">
        <div class="note-avatar" style="background:${avatarColor}">${initials}</div>
        <span class="note-author">#${shortId(note.author)}${note.isOwn ? ' <span class="own-tag">you</span>' : ''}</span>
        <span class="note-time">${formatTime(note.ts)}</span>
      </div>
      ${note.hidden
        ? `<div class="note-locked">
             <span class="lock-icon">🔒</span>
             <span class="lock-text">Encrypted — post your moment to reveal</span>
             <div class="lock-cipher">${generateFakeCipherPreview()}</div>
           </div>`
        : `<div class="note-content">${escapeHtml(note.content)}</div>`
      }
    `
    return card
  }

  /** Generate a plausible-looking hex string for the locked card visual */
  function generateFakeCipherPreview() {
    const chars = '0123456789abcdef'
    let s = ''
    for (let i = 0; i < 48; i++) s += chars[Math.floor(Math.random() * 16)]
    return s.match(/.{1,8}/g).join(' ')
  }

  function escapeHtml(str) {
    if (!str) return ''
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  // ── Submit ────────────────────────────────────────────────────────────────────

  noteInput.addEventListener('input', () => { charCount.textContent = noteInput.value.length })

  btnSubmit.addEventListener('click', async () => {
    const text = noteInput.value.trim()
    if (!text) { showError(submitError, 'Write something first!'); return }
    btnSubmit.disabled = true
    btnSubmit.textContent = 'Submitting…'
    const res = await window.peareal.submitNote(text)
    btnSubmit.disabled = false
    btnSubmit.textContent = 'Submit & Reveal 👁'
    if (!res?.ok) { showError(submitError, res?.error || 'Submission failed'); return }
    noteInput.value = ''
    charCount.textContent = '0'
    showToast('Note submitted! 🍐 Revealing…')
    await refreshFeed()
  })

  unlockRequestsList?.addEventListener('click', async (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const requesterHex = target.getAttribute('data-approve-request')
    if (!requesterHex) return

    target.setAttribute('disabled', 'true')
    target.textContent = 'Approving…'
    const res = await window.peareal.approveUnlockRequest(requesterHex).catch(e => ({ ok: false, error: e.message }))

    if (!res?.ok) {
      showToast(`Approval failed: ${res?.error || 'unknown error'}`)
      target.removeAttribute('disabled')
      target.textContent = 'Approve'
      return
    }

    showToast(`Approved #${shortId(requesterHex)}`)
    await refreshPendingUnlockRequests()
    await refreshFeed()
  })

  // ── Dev ───────────────────────────────────────────────────────────────────────

  btnTrigger.addEventListener('click', async () => {
    await window.peareal.triggerNow()
    showToast('⚡ New round triggered!')
    await refreshFeed()
  })

  // ── Events from main ─────────────────────────────────────────────────────────

  window.peareal.onBeRealTrigger(async () => {
    showToast('🍐 PeaReal time! Share your moment!', 5000)
    if (isConnected) { showFeedState('submit'); noteInput.value = ''; charCount.textContent = '0' }
  })

  window.peareal.onFeedUpdated(async () => { if (isConnected) await refreshFeed() })

  function startFeedPolling() {
    if (pollInterval) clearInterval(pollInterval)
    pollInterval = setInterval(refreshFeed, 5000)
  }

  // ── Boot ──────────────────────────────────────────────────────────────────────

  const resumed = await window.peareal.resumeSession()
  if (resumed?.ok) {
    isConnected = true
    authorTag.textContent = `#${shortId(resumed.authorHex)}`
    showScreen('feed')
    startFeedPolling()
    await refreshFeed()
  } else {
    showScreen('auth')
  }
})()