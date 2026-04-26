// renderer/app.js
; (async () => {
  const $ = id => document.getElementById(id)

  const screenHome = $('screen-home')
  const screenFeed = $('screen-feed')

  const roomsList = $('rooms-list')
  const roomsEmpty = $('rooms-empty')
  const inputRoomName = $('input-room-name')
  const inputInvite = $('input-invite')
  const inputJoinRoomName = $('input-join-room-name')
  const btnRoomCreate = $('btn-room-create')
  const btnRoomJoin = $('btn-room-join')
  const homeError = $('home-error')
  const inviteBox = $('invite-box')
  const inviteCode = $('invite-code')
  const btnCopyInvite = $('btn-copy-invite')

  const roomTag = $('room-tag')
  const authorTag = $('author-tag')
  const btnHome = $('btn-home')
  const btnLeaveRoom = $('btn-leave-room')

  const stateWaiting = $('state-waiting')
  const stateSubmit = $('state-submit')
  const stateFeed = $('state-feed')

  const photoInput = $('photo-input')
  const photoPreview = $('photo-preview')
  const btnPickPhoto = $('btn-pick-photo')
  const btnSubmit = $('btn-submit')
  const submitError = $('submit-error')
  const submitLockedList = $('submit-locked-list')

  const feedList = $('feed-list')
  const feedEmpty = $('feed-empty')
  const feedRoundTime = $('feed-round-time')

  const btnTrigger = $('btn-trigger')
  const toast = $('toast')

  let isConnected = false
  let pollInterval = null
  let selectedPhotoDataUrl = null
  let currentRoom = null

  function showScreen(name) {
    screenHome.classList.add('hidden')
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

  function colorFromId(hex) {
    const hue = parseInt((hex || '0000').slice(0, 4), 16) % 360
    return `hsl(${hue}, 70%, 55%)`
  }

  function escapeHtml(str) {
    if (!str) return ''
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  function setCurrentRoom(room) {
    currentRoom = room || null
    roomTag.textContent = currentRoom?.name ? `Sala: ${currentRoom.name}` : ''
  }

  function resetComposer() {
    selectedPhotoDataUrl = null
    if (photoInput) photoInput.value = ''
    if (photoPreview) {
      photoPreview.src = ''
      photoPreview.classList.add('hidden')
    }
  }

  function startFeedPolling() {
    if (pollInterval) clearInterval(pollInterval)
    pollInterval = setInterval(refreshFeed, 5000)
  }

  function stopFeedPolling() {
    if (pollInterval) clearInterval(pollInterval)
    pollInterval = null
  }

  async function loadRooms() {
    const res = await window.peareal.listRooms().catch(e => ({ ok: false, error: e.message, rooms: [] }))
    if (!res?.ok) {
      showError(homeError, res?.error || 'No se pudieron cargar las salas')
      return
    }

    const rooms = Array.isArray(res.rooms) ? res.rooms : []
    const currentId = res.current?.id || null
    roomsList.innerHTML = ''

    if (rooms.length === 0) {
      roomsEmpty.classList.remove('hidden')
      return
    }
    roomsEmpty.classList.add('hidden')

    for (const room of rooms) {
      const row = document.createElement('div')
      row.className = 'room-item'
      row.innerHTML = `
        <div class="room-meta">
          <div class="room-name">${escapeHtml(room.name || 'Sala')}</div>
          <div class="room-sub">${currentId === room.id ? 'Activa' : 'Guardada'} · #${escapeHtml(String(room.id || '').slice(0, 8))}</div>
        </div>
        <div class="room-actions">
          <button class="btn btn-secondary btn-sm" data-open-room="${escapeHtml(room.id)}">Entrar</button>
          <button class="btn btn-ghost btn-sm" data-leave-room="${escapeHtml(room.id)}">Salir</button>
        </div>
      `
      roomsList.appendChild(row)
    }
  }

  async function enterRoom(roomId) {
    const res = await window.peareal.openRoom(roomId).catch(e => ({ ok: false, error: e.message }))
    if (!res?.ok) {
      showError(homeError, res?.error || 'No se pudo abrir la sala')
      return
    }

    isConnected = true
    setCurrentRoom(res.room)
    authorTag.textContent = `#${shortId(res.authorHex)}`
    showScreen('feed')
    startFeedPolling()
    await refreshFeed()
    await loadRooms()
  }

  async function leaveRoomById(roomId, returnHome = false) {
    const res = await window.peareal.leaveRoom(roomId).catch(e => ({ ok: false, error: e.message }))
    if (!res?.ok) {
      showToast(res?.error || 'No se pudo salir de la sala')
      return
    }

    if (currentRoom?.id === roomId) {
      isConnected = false
      setCurrentRoom(null)
      authorTag.textContent = ''
      stopFeedPolling()
      resetComposer()
      showFeedState('waiting')
    }

    await loadRooms()
    if (returnHome) showScreen('home')
    showToast('Saliste de la sala')
  }

  btnRoomCreate.addEventListener('click', async () => {
    btnRoomCreate.disabled = true
    btnRoomCreate.textContent = 'Creando...'
    const res = await window.peareal.createRoom(inputRoomName.value.trim()).catch(e => ({ ok: false, error: e.message }))
    btnRoomCreate.disabled = false
    btnRoomCreate.textContent = 'Crear sala nueva'

    if (!res?.ok) {
      showError(homeError, res?.error || 'No se pudo crear la sala')
      return
    }

    inputRoomName.value = ''
    inviteCode.textContent = res.invite || ''
    inviteBox.classList.remove('hidden')
    showToast('Sala creada')

    isConnected = true
    setCurrentRoom(res.room)
    authorTag.textContent = `#${shortId(res.authorHex)}`
    showScreen('feed')
    startFeedPolling()
    await refreshFeed()
    await loadRooms()
  })

  btnRoomJoin.addEventListener('click', async () => {
    const invite = inputInvite.value.trim()
    if (!invite) {
      showError(homeError, 'Pega un invite code primero')
      return
    }

    btnRoomJoin.disabled = true
    btnRoomJoin.textContent = 'Uniendo...'
    const res = await window.peareal.joinRoom(invite, inputJoinRoomName.value.trim()).catch(e => ({ ok: false, error: e.message }))
    btnRoomJoin.disabled = false
    btnRoomJoin.textContent = 'Unirme a sala'

    if (!res?.ok) {
      showError(homeError, res?.error || 'No se pudo unir a la sala')
      return
    }

    inputInvite.value = ''
    inputJoinRoomName.value = ''
    inviteBox.classList.add('hidden')
    showToast('Unido a la sala')

    isConnected = true
    setCurrentRoom(res.room)
    authorTag.textContent = `#${shortId(res.authorHex)}`
    showScreen('feed')
    startFeedPolling()
    await refreshFeed()
    await loadRooms()
  })

  btnCopyInvite.addEventListener('click', () => {
    navigator.clipboard.writeText(inviteCode.textContent.trim())
      .then(() => showToast('Invite copiado'))
      .catch(() => {
        window.getSelection().selectAllChildren(inviteCode)
        showToast('Selecciona y copia manualmente')
      })
  })

  roomsList.addEventListener('click', async (event) => {
    const rawTarget = event.target
    if (!(rawTarget instanceof HTMLElement)) return

    const openBtn = rawTarget.closest('[data-open-room]')
    const leaveBtn = rawTarget.closest('[data-leave-room]')

    const openId = openBtn instanceof HTMLElement ? openBtn.getAttribute('data-open-room') : null
    if (openId) {
      await enterRoom(openId)
      return
    }

    const leaveId = leaveBtn instanceof HTMLElement ? leaveBtn.getAttribute('data-leave-room') : null
    if (leaveId) {
      await leaveRoomById(leaveId, currentRoom?.id === leaveId)
    }
  })

  btnHome.addEventListener('click', async () => {
    showScreen('home')
    stopFeedPolling()
    await loadRooms()
  })

  btnLeaveRoom.addEventListener('click', async () => {
    if (!currentRoom?.id) return
    await leaveRoomById(currentRoom.id, true)
  })

  async function refreshFeed() {
    if (!isConnected) return
    const res = await window.peareal.getFeed().catch(() => null)
    if (!res?.ok) return
    const { notes, submitted, meta } = res

    if (!meta) {
      showFeedState('waiting')
      return
    }

    if (!submitted) {
      showFeedState('submit')
      renderLockedCards(notes)
      return
    }

    showFeedState('feed')
    if (meta?.triggeredAt) feedRoundTime.textContent = `Round started at ${formatTime(meta.triggeredAt)}`
    feedList.innerHTML = ''
    if (!notes?.length) {
      feedEmpty.classList.remove('hidden')
    } else {
      feedEmpty.classList.add('hidden')
      notes.forEach(n => feedList.appendChild(renderNoteCard(n)))
    }
  }

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
             <span class="lock-text">Encrypted — waiting for automatic peer key sync</span>
             <div class="lock-cipher">${generateFakeCipherPreview()}</div>
           </div>`
        : renderRevealedContent(note.content)
      }
    `
    return card
  }

  function renderRevealedContent(content) {
    if (typeof content === 'string' && /^data:image\/(png|jpeg|jpg|webp);base64,/i.test(content)) {
      return `<img class="note-image" src="${content}" alt="Shared moment" />`
    }
    return `<div class="note-content">${escapeHtml(content)}</div>`
  }

  function generateFakeCipherPreview() {
    const chars = '0123456789abcdef'
    let s = ''
    for (let i = 0; i < 48; i++) s += chars[Math.floor(Math.random() * 16)]
    return s.match(/.{1,8}/g).join(' ')
  }

  btnPickPhoto?.addEventListener('click', () => {
    photoInput?.click()
  })

  photoInput?.addEventListener('change', () => {
    const file = photoInput.files?.[0]
    if (!file) return
    if (!/^image\//.test(file.type)) {
      showError(submitError, 'Select a valid image')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      selectedPhotoDataUrl = String(reader.result || '')
      if (photoPreview && selectedPhotoDataUrl) {
        photoPreview.src = selectedPhotoDataUrl
        photoPreview.classList.remove('hidden')
      }
    }
    reader.readAsDataURL(file)
  })

  btnSubmit.addEventListener('click', async () => {
    if (!selectedPhotoDataUrl) {
      showError(submitError, 'Take/select a photo first')
      return
    }
    btnSubmit.disabled = true
    btnSubmit.textContent = 'Submitting...'
    const res = await window.peareal.submitNote(selectedPhotoDataUrl)
    btnSubmit.disabled = false
    btnSubmit.textContent = 'Submit Photo & Reveal 👁'
    if (!res?.ok) {
      showError(submitError, res?.error || 'Submission failed')
      return
    }
    resetComposer()
    showToast('Photo submitted!')
    await refreshFeed()
  })

  btnTrigger.addEventListener('click', async () => {
    await window.peareal.triggerNow()
    showToast('⚡ New round triggered!')
    await refreshFeed()
  })

  window.peareal.onBeRealTrigger(async () => {
    showToast('🍐 PeaReal time! Share your moment!', 5000)
    if (isConnected) {
      showFeedState('submit')
      resetComposer()
    }
  })

  window.peareal.onFeedUpdated(async () => {
    if (isConnected) await refreshFeed()
  })

  showScreen('home')
  await loadRooms()

  const current = await window.peareal.getCurrentRoom().catch(() => ({ ok: false, room: null }))
  if (current?.ok && current.room?.id) {
    setCurrentRoom(current.room)
  }
})()
