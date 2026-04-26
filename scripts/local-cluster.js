const readline = require('readline/promises')
const { spawn } = require('child_process')
const path = require('path')

const PROJECT_ROOT = process.cwd()
const ELECTRON_BIN = require('electron')
const BASE_MOBILE_PORT = Number(process.env.MOBILE_BRIDGE_PORT_BASE || 8787)

async function askCount() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    try {
        while (true) {
            const raw = (await rl.question('Cuantos nodos quieres levantar localmente? ')).trim()
            const value = Number(raw)
            if (Number.isInteger(value) && value > 0 && value <= 30) return value
            console.log('Ingresa un numero entero entre 1 y 30.')
        }
    } finally {
        rl.close()
    }
}

function spawnPeer(index) {
    const name = `peer${index}`
    const mobilePort = BASE_MOBILE_PORT + (index - 1)
    const env = {
        ...process.env,
        PEAREAL_USER: `user${index}`,
        MOBILE_BRIDGE_PORT: String(mobilePort)
    }

    const child = spawn(ELECTRON_BIN, ['.'], {
        cwd: PROJECT_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false
    })

    child.stdout.on('data', chunk => process.stdout.write(`[${name}] ${chunk.toString()}`))
    child.stderr.on('data', chunk => process.stderr.write(`[${name}] ${chunk.toString()}`))
    child.on('exit', code => console.log(`[${name}] exited (${code})`))

    console.log(`[${name}] mobile bridge -> http://localhost:${mobilePort}`)

    return child
}

async function main() {
    const count = await askCount()

    console.log(`\nLevantando ${count} UI(s) de Electron con usuarios aislados...\n`)
    console.log('Cada ventana usa PEAREAL_USER distinto (user1, user2, ...).')
    console.log('Crea grupo en peer1 y pega el invite en los demas peers para unirlos.\n')
    console.log(`Puertos moviles: base ${BASE_MOBILE_PORT}, uno por peer (ej: peer1=${BASE_MOBILE_PORT}, peer2=${BASE_MOBILE_PORT + 1}).\n`)

    const peers = []
    for (let i = 1; i <= count; i++) {
        peers.push(spawnPeer(i))
    }

    console.log('\nCluster UI activo. Presiona Ctrl+C para cerrar todas las instancias.\n')

    let isShuttingDown = false
    const shutdown = () => {
        if (isShuttingDown) return
        isShuttingDown = true
        console.log('\nCerrando nodos...')
        for (const p of peers) {
            if (!p.killed) p.kill('SIGTERM')
        }
        setTimeout(() => process.exit(0), 500)
    }

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)

    // Keep parent process alive while child Electron windows are running.
    await new Promise(() => { })
}

main().catch(err => {
    console.error('Error levantando cluster UI local:', err.message)
    process.exit(1)
})
