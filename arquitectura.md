# Arquitectura P2P (Pear/Holepunch)

## Que esta usando este proyecto de Pears

Este proyecto utiliza el stack Pear/Holepunch principalmente a traves de estas piezas:

1. Autopass (`autopass`)
- Es la capa principal de sincronizacion multiwriter.
- Permite crear/join de grupo con invite code.
- Replica el estado de la app sin servidor central.
- En el codigo se usa en `auth/autopass.js` y se consume desde `main.js`.

2. Corestore (`corestore`)
- Es el almacenamiento local de los datos distribuidos.
- Persiste la sesion y el estado P2P por usuario (`PEAREAL_USER`).
- Se inicializa en `auth/autopass.js`.

3. Hypercore ecosystem (`hypercore`, `hyperbee`)
- Estan en dependencias porque Autopass se apoya en este ecosistema para log/estado distribuido.
- En esta app no se manipulan directamente desde la UI, pero son base de la replicacion de datos.

4. Pear runtime (`pear`)
- Esta incluido como dependencia del proyecto.
- Conceptualmente aporta el enfoque local-first/P2P del ecosistema.
- En este repo, el flujo principal de red lo abstrae Autopass.

## Que no esta usando de Pears de forma directa

- No se implementa manualmente hole punching, NAT traversal o peer discovery a bajo nivel.
- No hay servidor central para sincronizar feed.
- No se programan primitivas raw de Hypercore en la capa de UI.

## Como encaja en la arquitectura de la app

1. `main.js`
- Orquesta la app Electron y los handlers IPC.
- Llama funciones de auth/feed para crear grupo, unir peers y obtener feed.

2. `auth/autopass.js`
- Abre Corestore local.
- Crea o une sesion Autopass.
- Gestiona identidad local y keypair de cifrado.

3. `p2p/peer.js`
- Adaptador de operaciones sobre Autopass (`put/get/del/list/watch`).

4. `p2p/feed.js`
- Logica de rondas y cifrado de contenido.
- Usa el estado replicado por Autopass para notas, unlock requests y unlock grants.

## Resumen rapido

- La base P2P real de este proyecto es `Autopass + Corestore` (ecosistema Holepunch/Pear).
- El proyecto se beneficia de sincronizacion entre peers sin backend central.
- La app agrega encima su propia logica de producto (rondas, reveal y cifrado de mensajes).

## Pitch (slide-ready)

- BeRealPeer es una app local-first construida sobre el stack Holepunch/Pear.
- Usamos Autopass para sincronizacion multiwriter entre peers sin servidor central.
- Corestore persiste localmente la sesion y el estado distribuido por usuario.
- El feed se replica P2P, pero el contenido se cifra en capa de aplicacion.
- Cada mensaje usa XChaCha20-Poly1305 con clave efimera por contenido.
- El desbloqueo se hace por protocolo request/grant entre peers.
- Solo quien cumple la condicion de publicacion y recibe grant puede descifrar.
- Resultado: privacidad de contenido + resiliencia de red + autonomia del usuario.

## Demo N1-N2-N3 (flujo paso a paso)

1. N1 crea la sala
- N1 inicializa Autopass y genera un invite code.
- N1 comparte el invite con N2 y N3.

2. N2 y N3 se unen
- Ambos nodos entran con el invite.
- Los tres peers empiezan a replicar estado sin backend central.

3. N1 publica su contenido
- N1 genera una clave efimera de contenido (CK) para ese mensaje.
- N1 cifra con XChaCha20-Poly1305.
- Se replica ciphertext (no plaintext) a N2 y N3.

4. N2 y N3 reciben datos, pero bloqueados
- Ambos tienen el mensaje cifrado.
- Todavia no pueden leerlo si no tienen grant valido para su nodo.

5. N2 cumple condicion y pide desbloqueo
- N2 publica su propio contenido en la ronda.
- N2 crea unlock request dirigido a N1.

6. N1 valida y responde
- N1 verifica que N2 ya cumplio la condicion de publicacion.
- N1 genera unlock grant para N2: envuelve la CK para la public key de N2.

7. N2 descifra localmente
- N2 usa su private key para abrir la CK.
- Con esa CK descifra el mensaje de N1 y lo ve en claro.

8. Estado de N3
- Si N3 no publica/no recibe grant, permanece bloqueado.
- Aunque replique el ciphertext, no puede abrir contenido sin su grant.

## Conclusión del flujo

- La red P2P distribuye datos y mantiene sincronizacion.
- La capa de aplicacion controla acceso real al contenido.
- Recibir datos no implica poder leerlos: solo descifra quien recibe grant valido.
