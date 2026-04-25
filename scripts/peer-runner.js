const fs = require('fs').promises
const path = require('path')

const { createGroup, joinGroup, getAuthorHex } = require('../auth/autopass')
const { watch } = require('../p2p/peer')

const role = process.env.PEER_ROLE || 'peer'
const sharedDir = process.env.SHARED_DIR || '/shared'
const invitePath = path.join(sharedDir, 'invite.txt')
const nodeName = process.env.PEAREAL_USER || 'peer'

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForInvite() {
    while (true) {
        try {
            const code = (await fs.readFile(invitePath, 'utf8')).trim()
            if (code) return code
        } catch {
            // Wait until host writes invite.
        }
        await sleep(1000)
    }
}

async function boot() {
    await fs.mkdir(sharedDir, { recursive: true })

    let pass
    if (role === 'host') {
        const created = await createGroup()
        pass = created.pass
        await fs.writeFile(invitePath, created.invite, 'utf8')
        console.log(`[${nodeName}] host ready`)
        console.log(`[${nodeName}] invite saved to ${invitePath}`)
    } else {
        console.log(`[${nodeName}] waiting invite...`)
        const invite = await waitForInvite()
        pass = await joinGroup(invite)
        console.log(`[${nodeName}] joined group`)
    }

    console.log(`[${nodeName}] author=${getAuthorHex(pass)}`)

    watch(pass, () => {
        console.log(`[${nodeName}] update received`)
    })

    // Keep the node alive for replication.
    setInterval(() => {
        console.log(`[${nodeName}] heartbeat ${new Date().toISOString()}`)
    }, 30000)
}

boot().catch(err => {
    console.error(`[${nodeName}] fatal`, err)
    process.exit(1)
})
