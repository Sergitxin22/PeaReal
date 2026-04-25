# EXPLICATION - Deep Dive de las dos encriptaciones

Este documento explica en profundidad las dos capas de encriptacion del proyecto y el flujo exacto de desbloqueo con nodos N1, N2 y N3.

## 1) Las dos encriptaciones: que son y para que sirven

En la app conviven dos capas de proteccion distintas:

1. Encriptacion/proteccion de la capa de red P2P
- La aporta el stack Pear/Hypercore/Autopass.
- Objetivo: replicacion segura y robusta entre peers.
- Beneficio principal: resiliencia y transporte entre nodos sin backend central.

2. Encriptacion del contenido del mensaje (application-level)
- La implementa `p2p/feed.js`.
- Objetivo: que el texto/foto no se pueda leer solo por estar replicado.
- Beneficio principal: privacidad funcional del payload.

Idea clave: la capa de red protege el canal y la replicacion; la capa de contenido protege el dato de negocio.

## 2) Algoritmos usados en la capa de contenido

### 2.1 Cifrado del mensaje

- Algoritmo: XChaCha20-Poly1305 (`xchacha20poly1305-ietf`).
- Libreria: `sodium-universal`.
- Clave: Content Key (CK) aleatoria de 32 bytes por mensaje.
- Nonce: 24 bytes aleatorio por mensaje.

Propiedades:
- Confidencialidad: sin CK no se puede recuperar el plaintext.
- Integridad/autenticidad criptografica del ciphertext: si se altera, falla el decrypt.

### 2.2 Entrega de CK por receptor

- Algoritmo: RSA-OAEP-SHA256 (wrapping de clave).
- Implementacion: `crypto.publicEncrypt` / `crypto.privateDecrypt` de Node.js.
- Cada nodo tiene su propio keypair RSA persistente:
- `enc-public.pem`
- `enc-private.pem`

Propiedades:
- El autor puede envolver la CK para un receptor especifico.
- Solo la private key del receptor abre ese wrapped key.

## 3) Modelo de datos del protocolo unlock

En cada ronda existen estas entradas:

- Nota cifrada del autor:
- `round:<id>:note:<authorHex>`

- Peticion de desbloqueo de un receptor hacia un autor:
- `round:<id>:unlockReq:<authorHex>:<requesterHex>`

- Respuesta del autor con CK envuelta para ese receptor:
- `round:<id>:unlockGrant:<authorHex>:<requesterHex>`

Ademas:
- `config:currentRound`
- `round:<id>:meta`

## 4) Flujo detallado N1, N2, N3

Escenario:
- N1 publica primero.
- N2 y N3 reciben el contenido cifrado.
- N2 publica despues y solicita desbloqueo a N1.

### Paso A - N1 publica

1. N1 genera CK aleatoria (32 bytes).
2. N1 cifra su mensaje con XChaCha20-Poly1305 y nonce aleatorio.
3. N1 publica `note:N1` con `encrypted`, `nonce`, `alg`.
4. N1 crea su self-grant `unlockGrant:N1:N1` para poder abrir su propio contenido localmente.

Resultado:
- N2 y N3 replican el ciphertext.
- Nadie (excepto N1) tiene aun grant para abrir CK de N1.

### Paso B - N2 aun no publica

1. N2 ejecuta `getFeed()`.
2. Como `localUserSubmitted=false`, el feed devuelve tarjetas ocultas.
3. No intenta decrypt de notas de otros.

Resultado:
- N2 ve que hay contenido, pero no plaintext.

### Paso C - N2 publica su propio contenido

1. N2 hace `submitNote`.
2. Pasa a estado `localUserSubmitted=true`.
3. En el siguiente `getFeed()`, N2 empieza a crear unlock requests para autores de notas que ve:
- request a N1: `unlockReq:N1:N2`.

### Paso D - N1 procesa request de N2

1. N1 en su ciclo de `getFeed()` procesa requests dirigidas a N1.
2. Verifica condicion de producto: N2 ya publico en la ronda (existe `note:N2`).
3. N1 recupera su CK desde su self-grant (`unlockGrant:N1:N1`) y su private key.
4. N1 envuelve CK con la public key de N2.
5. N1 publica `unlockGrant:N1:N2`.

### Paso E - N2 descifra

1. N2 recibe `unlockGrant:N1:N2`.
2. Desenvuelve CK con su private key local.
3. Descifra `note:N1` con CK + nonce.
4. Muestra plaintext de N1.

### Paso F - N3 sigue bloqueado

- Mientras N3 no publique y no obtenga `unlockGrant:N1:N3`, no puede abrir mensaje de N1.

## 5) Por que no basta pedir la public key del autor

Una duda comun es: "si N2 le pide la public key a N1, puede descifrar?"

Respuesta corta: no.

- La public key del autor no sirve para abrir directamente el ciphertext del mensaje.
- El ciphertext del mensaje fue creado con CK simetrica (XChaCha20).
- Lo que necesita N2 es la CK de ese mensaje, envuelta especificamente para N2.

Por eso existe unlock request/grant.

## 6) Como se ve una lectura exitosa vs fallida

Lectura exitosa:
1. Existe grant para par (autor, receptor).
2. Wrapped key se abre con private key del receptor.
3. Decrypt XChaCha20-Poly1305 valida tag y devuelve plaintext.

Lectura fallida:
1. No existe grant.
2. O wrapped key no abre con esa private key.
3. O decrypt de contenido falla (tag invalido).

En cualquiera de esos casos, la UI queda en estado `hidden` para esa nota.

## 7) Que protege y que no protege

Protege:
- El mensaje no se revela por simple replicacion.
- El autor decide a quien concede acceso (grant por receptor).
- El desencriptado final ocurre localmente en el receptor.

No protege (aun):
- PKI fuerte para enlazar identidad social con public key (no hay CA externa).
- Politicas avanzadas de expiracion/revocacion de grants.

## 8) Resumen ejecutivo para demo/jurado

- P2P layer: sincroniza sin servidor central.
- Message layer: cifra contenido por mensaje con CK efimera.
- Unlock protocol: request/grant peer-to-peer.
- Outcome: N2 y N3 reciben datos cifrados, pero solo descifra quien cumple condicion y recibe grant del autor.
