# BeRealPeer - Documentacion tecnica

## 1. Que es este proyecto

BeRealPeer es una app de escritorio local-first y P2P construida con Electron + Autopass.
No depende de un backend central para sincronizar el feed.

El flujo principal es estilo BeReal: cada ronda abre una ventana de publicacion y solo puedes revelar contenido de otros peers cuando cumples la condicion de publicacion local.

## 2. Stack

- Electron: proceso principal, preload y renderer.
- Autopass/Corestore: estado compartido multiwriter sobre Holepunch.
- sodium-universal: cifrado de contenido con XChaCha20-Poly1305.
- crypto (Node.js): wrapping de claves por receptor con RSA-OAEP-SHA256.

## 3. Arquitectura por capas

1. Capa de red/replicacion
- La aporta Pear/Hypercore/Autopass.
- Resuelve descubrimiento de peers, replicacion y consistencia de datos compartidos.

2. Capa de confidencialidad de mensajes
- La implementa la app en `p2p/feed.js`.
- Cada nota se cifra con una content key aleatoria (CK) por mensaje.
- La CK se comparte por receptor con protocolo unlock request/grant.

## 4. Flujo general

1. App arranca en `main.js` y abre UI.
2. Se intenta reanudar sesion (`auth:resume`).
3. Si hay sesion, se inicializan:
- identidad de autor (`authorHex`),
- keypair local de cifrado (`enc-public.pem` / `enc-private.pem`),
- watcher P2P y scheduler de ronda.
4. Al iniciar ronda, se limpia la ronda anterior y se publica metadata.
5. Al publicar una nota, se cifra y se replica solo ciphertext.
6. Cuando un peer ya envio su nota, comienza el ciclo de unlock para ver notas de otros peers.

## 5. Modulos

### `main.js`

- Orquesta estado de sesion del proceso principal.
- Expone IPC de auth/feed para el renderer.
- Carga keypair local de cifrado al crear/unir/reanudar grupo.
- En `feed:submit` envia la public key local para que el autor pueda autogenerar su propio grant.
- En `feed:get` entrega public/private key local al modulo feed para procesar requests y grants.

### `auth/autopass.js`

- Gestiona create/join/resume de sesion Autopass.
- Persistencia local en `~/.peareal/<slot>`.
- Genera y persiste keypair RSA local por nodo:
- `enc-public.pem`
- `enc-private.pem`
- Devuelve el keypair con `getEncryptionKeyPair()`.

### `p2p/peer.js`

- Adaptador CRUD para Autopass v3 (`add/get/remove/list`).
- Incluye `listByPrefix` y `watch` de actualizaciones.

### `p2p/feed.js`

- Gestiona rondas y metadata.
- Cifra notas con XChaCha20-Poly1305 y CK aleatoria por mensaje.
- Implementa protocolo de desbloqueo por receptor:
- unlock request
- unlock grant
- Desencripta solo si existe grant valido para el receptor local.
- No hay fallback legacy (XOR/secretbox removido).

### `preload.js`

- Expone API segura `window.peareal` al renderer.
- Evita acceso directo de Node.js desde UI.

### `renderer/app.js`

- Controla autenticacion, submit y render del feed.
- `getFeed()` obtiene notas ocultas o reveladas segun estado local y grants.

## 6. Esquema de datos

Claves principales en la store compartida:

- `config:currentRound`
- `round:<id>:meta`
- `round:<id>:note:<authorHex>`
- `round:<id>:unlockReq:<authorHex>:<requesterHex>`
- `round:<id>:unlockGrant:<authorHex>:<requesterHex>`

Ejemplo de nota:

```json
{
  "alg": "xchacha20poly1305-ietf",
  "encrypted": "<hex>",
  "nonce": "<hex>",
  "author": "<authorHex>",
  "authorPublicKeyPem": "-----BEGIN PUBLIC KEY-----...",
  "wrapAlg": "rsa-oaep-sha256",
  "ts": 1713981000000
}
```

Ejemplo de unlock request:

```json
{
  "from": "<requesterHex>",
  "to": "<authorHex>",
  "requesterPublicKeyPem": "-----BEGIN PUBLIC KEY-----...",
  "ts": 1713981001000
}
```

Ejemplo de unlock grant:

```json
{
  "from": "<authorHex>",
  "to": "<requesterHex>",
  "wrappedKey": "<base64>",
  "wrapAlg": "rsa-oaep-sha256",
  "ts": 1713981002000
}
```

## 7. Contratos IPC

Renderer -> Main:

- `auth:create`
- `auth:join`
- `auth:resume`
- `feed:submit`
- `feed:get`
- `feed:hasSubmitted`
- `dev:triggerNow`
- `dev:scheduleIn`
- `dev:rawDump`

Main -> Renderer:

- `bereal:trigger`
- `feed:updated`

## 8. Seguridad actual

- Cifrado de contenido: XChaCha20-Poly1305 con nonce aleatorio por nota.
- Distribucion de clave de contenido: RSA-OAEP-SHA256 por receptor.
- Desencriptado local: solo con private key del receptor y grant correspondiente.
- Sin backend central para almacenar llaves o contenido en claro.

## 9. Limitaciones conocidas

- Las public keys de requesters se publican dentro de requests; no hay PKI externa.
- No hay expiracion/rotacion de grants por politica de tiempo.
- Falta suite de tests automatizados para protocolo unlock request/grant.

## 10. Ejecucion

```bash
npm install
npm start
```

En PowerShell con politica restrictiva:

```bash
npm.cmd install
npm.cmd start
```
