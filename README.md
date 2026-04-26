# PeaReal

PeaReal es una app local-first P2P construida con Electron + Autopass (stack Holepunch) para compartir momentos tipo BeReal sin depender de infraestructura central.

La idea principal es simple: cada usuario mantiene su propio nodo, los peers se sincronizan entre si, y el contenido sensible se protege en capa de aplicación con cifrado real. Esto permite una experiencia social ligera (feed, comentarios y reacciones) manteniendo control local de datos, resiliencia de red y menor dependencia de terceros.

En la práctica, PeaReal combina tres piezas:

- sincronización distribuida entre peers (sin servidor de feed).
- Gestion de grupos por invite para organizar la replica.
- Confidencialidad del contenido de fotos mediante cifrado y grants por peer.

No existe backend central para almacenar el feed ni para resolver la autorización de lectura de fotos.

## Estado actual del proyecto

- Soporte multi-grupo (crear, unirse, abrir, abandonar).
- Home de grupos en desktop y en mobile.
- Bridge mobile HTTP + WebSocket para usar la app desde el móvil.
- Feed cifrado de fotos por ronda.
- Desbloqueo automático entre peers que cumplen condición de envío.
- Comentarios por foto (solo si esa foto esta desbloqueada para ti).
- Reacciones por foto (toggle por usuario, con contadores).
- Invite enriquecido con nombre de grupo: `peareal://invite?code=...&name=...`.

## Arquitectura

1. Capa de red/replicación
- Proporcionada por Autopass/Hypercore.
- Descubrimiento de peers, replicación y consistencia del log.

2. Capa de aplicación
- lógica de grupos y sesión en `auth/autopass.js` y `main.js`.
- Cifrado, descifrado y reglas de acceso de feed en `p2p/feed.js`.
- UI desktop en `renderer/*` y UI mobile en `mobile/index.html`.

3. Bridge mobile
- `main.js` levanta servidor local (`/` y `/ws`).
- Acciones WS principales:
	- auth: `auth:create`, `auth:join`
	- rooms: `rooms:list`, `rooms:open`, `rooms:leave`, `rooms:invite`
	- feed: `feed:get`, `feed:submitImage`, `feed:comment`, `feed:react`

## Grupos e invites

- Cada grupo tiene storage aislado y metadata local.
- El creador puede definir nombre al crear grupo.
- El join respeta el nombre original cuando llega en invite enriquecido.
- El boton de copiar invite regenera invite para el grupo activo antes de copiar.
- Desde la vista de grupo también se puede copiar invite.
- Si intentas join y no completa, hay timeout con error explícito (evita carga infinita).

## Feed y UX mobile

- Home y Grupo son vistas separadas.
- En Home se listan "Tus grupos".
- En Grupo aparecen:
	- Camara/galeria y envío cifrado.
	- Feed de la ronda.
	- Reacciones por imagen.
	- Chat de comentarios por imagen (al tocar una foto descifrada se abre).

## Seguridad y cifrado (todas las encriptaciónes)

### 1) Cifrado del contenido de foto

- Algoritmo: XChaCha20-Poly1305 (AEAD).
- Implementacion: `p2p/feed.js` (`encryptContent` / `decryptContent`).
- Cada foto usa una clave simétrica aleatoria de 32 bytes (Content Key, CK).
- Se guarda en el log compartido solo el ciphertext + nonce.

### 2) Distribución de la clave de contenido

- Algoritmo: RSA OAEP SHA-256.
- Implementacion: `wrapContentKeyForPeer` / `unwrapContentKey` en `p2p/feed.js`.
- La CK se envuelve por destinatario (grant individual).
- Resultado: cada peer descifra localmente solo si tiene grant válido.

### 3) Firma e integridad criptográfica de nota

- Firma: RSA con SHA-256 sobre payload canónico.
- Implementacion: `signNote` / `verifyNoteSignature`.
- además, se usa commitment SHA-256 (`hashCommit`) con salt para verificar que el plaintext descifrado coincide con lo publicado.

### 4) Integridad de replicación de la red

- Proporcionada por Hypercore/Autopass en la capa de replicación.
- Garantiza integridad del log replicado entre peers.

### 5) Comentarios y reacciones (importante)

- Comentarios y reacciones tienen control de acceso en lógica de aplicación:
	- Solo puede comentar/reaccionar quien tiene la foto desbloqueada y ha enviado su foto en la ronda.
- Actualmente no se cifran con XChaCha como las fotos.
- Es decir: la protección actual de comentarios/reacciones es de autorización lógica, no de confidencialidad end-to-end adicional.

## Threat Model (resumen)

### Activos protegidos

- Confidencialidad del contenido de las fotos en la ronda.
- Integridad de notas replicadas (firmas + commitments + log replicado).
- Aislamiento local de datos por grupo/usuario.

### Adversarios considerados

- Peer sin grant válido intentando leer fotos de otros peers.
- Peer intentando manipular o falsificar contenido de nota.
- Nodo que recibe datos replicados pero no cumple condición de desbloqueo.

### Qué sí protege hoy

- Las fotos se replican cifradas y solo se descifran con grants válidos.
- Las notas firmadas y su commitment detectan alteraciones de contenido.
- Reacciones y comentarios requieren autorización lógica (foto desbloqueada + envío en ronda).

### Qué no protege hoy

- Confidencialidad criptográfica de comentarios/reacciones (no están cifrados como fotos).
- Seguridad del endpoint local mobile ante un dispositivo host comprometido.
- Metadata de tráfico y tiempos de publicación/actividad (quien publica y cuando).

### Supuestos de seguridad

- El dispositivo local protege sus claves privadas y su almacenamiento.
- El runtime de Electron y dependencias no están comprometidos.
- Los peers siguen el protocolo y no tienen acceso físico no autorizado al host de otro peer.

## Modelo de desbloqueo actual

- El desbloqueo entre peers se realiza de forma automática con grants cuando se cumplen condiciones de la ronda.
- Si no tienes permiso, la foto se muestra bloqueada.

## Claves de datos en Autopass

- `config:currentRound`
- `round:<id>:meta`
- `round:<id>:note:<authorHex>`
- `round:<id>:unlockGrant:<authorHex>:<requesterHex>`
- `round:<id>:comment:<noteAuthorHex>:<commentId>`
- `round:<id>:reaction:<noteAuthorHex>:<reactorAuthorHex>`

## Flujo técnico general

1. La app arranca en `main.js` y levanta UI desktop + bridge mobile.
2. El usuario crea o se une a un grupo (vía invite).
3. Se inicializa sesión activa (autor, claves locales, watchers, scheduler de ronda).
4. En cada ronda, las fotos se publican cifradas y se replican entre peers.
5. Solo peers autorizados y con condiciones cumplidas descifran localmente.
6. Sobre fotos desbloqueadas, se habilitan comentarios y reacciones.

## Módulos principales

### `main.js`

- Orquesta estado de sesión y presencia.
- Expone IPC desktop y acciones WebSocket mobile.
- Gestiona auth, grupos, feed, comentarios y reacciones.

### `auth/autopass.js`

- Create/join/open/leave/list de grupos.
- Persistencia local de metadata de grupos.
- Generación de invites y selección de grupo activo.

### `p2p/peer.js`

- Adaptador de operaciones sobre Autopass (`put/get/del/list/watch`).

### `p2p/feed.js`

- Rondas, cifrado/descifrado de fotos y validaciones.
- Grants de desbloqueo automáticos.
- Persistencia de comentarios y reacciones por foto.

### `preload.js`

- Expone API segura (`window.peareal`) al frontend.

### `renderer/*` y `mobile/index.html`

- Home de grupos, feed, publicación de foto.
- Interacciones sociales (reacciones + chat por foto).

## Contratos de integración

### IPC desktop (renderer -> main)

- `auth:create`, `auth:join`
- `rooms:list`, `rooms:create`, `rooms:join`, `rooms:open`, `rooms:leave`, `rooms:getCurrent`, `rooms:invite`
- `feed:submit`, `feed:get`, `feed:comment`, `feed:react`, `feed:hasSubmitted`

### Eventos (main -> renderer)

- `bereal:trigger`
- `feed:updated`

### WebSocket mobile

- `status:get`
- `auth:create`, `auth:join`
- `rooms:list`, `rooms:open`, `rooms:leave`, `rooms:invite`
- `feed:submitImage`, `feed:get`, `feed:comment`, `feed:react`

## Limitaciones actuales

- Comentarios y reacciones no usan cifrado de contenido como las fotos.
- No hay PKI externa para identidad social de claves públicas.
- No hay política avanzada de expiración/revocación de grants.

## Desarrollo

- En desarrollo, el trigger de ronda esta configurado a 120 segundos.
- En producción, el trigger usa ventana diaria aleatoria.

## Ejecutar

```bash
npm install
npm start
```

Si PowerShell tiene política restrictiva:

```bash
npm.cmd install
npm.cmd start
```

## Cluster local (multiple peers)

Abre varias ventanas Electron (una por peer local):

```bash
npm.cmd run cluster:local
```

El script pide cantidad de peers y crea usuarios aislados (`user1`, `user2`, ...).

## Licencia

Este proyecto está licenciado bajo **GNU Affero General Public License v3.0 (AGPL-3.0)**.

Consulta el texto completo en [LICENSE](LICENSE).

