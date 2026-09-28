# Verificación automática (repartidor / lavandería)

Servidor chico que compara la selfie de una persona contra la foto de su carnet y, si coincide, la aprueba automáticamente en Firestore (le pone el rol de `repartidor` o `admin`), sin que un verificador humano tenga que revisarla a mano.

No usa Firebase Cloud Functions ni el plan Blaze — corre como un Servicio Web normal en [Render](https://render.com) (gratis, sin tarjeta), y habla con Firestore por su API REST usando una llave de administrador (Service Account) que le da permiso para escribir aunque las reglas normales no lo dejarían a un usuario cualquiera. Eso es justamente lo que lo hace seguro: la decisión la toma este servidor de confianza, no el celular de quien se está postulando.

**Ya probado localmente:** el `Dockerfile` compiló y corrió bien en este entorno (Node 20, igual que usa Render), y la comparación facial funciona de verdad (mismo par de fotos → distancia 0.0000; fotos de personas distintas → distancia bien por encima del umbral).

## 1. Creá la Service Account en Firebase

1. Andá a [console.firebase.google.com/project/laundry-app-asustadores/settings/serviceaccounts/adminsdk](https://console.firebase.google.com/project/laundry-app-asustadores/settings/serviceaccounts/adminsdk)
2. Click en **"Generar nueva clave privada"** → se descarga un archivo `.json`.
3. **Guardalo en un lugar seguro y nunca lo subas a GitHub ni me lo pegues a mí en el chat** — ese archivo tiene acceso total a tu base de datos.

## 2. Subí esta carpeta a GitHub

Desde `~/lavanderia-app`, creá un repo en GitHub (podés hacerlo vos desde la web de GitHub o con `gh repo create`) y subí **solo esta carpeta** `verificacion-backend/` (o el repo completo, no importa, Render te deja elegir el "Root Directory").

## 3. Creá el Servicio Web en Render

1. En Render → **New +** → **Servicio Web**.
2. Conectá tu repo de GitHub.
3. Si subiste el repo completo (no solo esta carpeta), poné **Root Directory**: `verificacion-backend`.
4. Render va a detectar el `Dockerfile` solo y va a construir con eso (no hace falta que toques "Build Command" ni "Start Command").
5. Plan: **Free**.

## 4. Configurá las variables de entorno en Render

En la pestaña **Environment** del servicio, agregá:

| Variable | Valor |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Todo el contenido del archivo `.json` que descargaste en el paso 1, pegado tal cual (es un JSON válido de una sola vez, Render lo guarda como texto). |
| `FIREBASE_PROJECT_ID` | `laundry-app-asustadores` |
| `VERIFICACION_SECRETO` | Inventá cualquier texto largo y random (ej. generalo con `openssl rand -hex 32`). Vas a poner este mismo valor en la app Flutter. |

Guardá y esperá a que termine el deploy (puede tardar varios minutos la primera vez porque compila `canvas` desde cero).

## 5. Probalo

Una vez desplegado, Render te da una URL tipo `https://verificacion-backend-xxxx.onrender.com`. Probá:

```bash
curl https://TU-URL.onrender.com/
# {"ok":true}
```

Y ya con una solicitud real pendiente en Firestore:

```bash
curl -X POST https://TU-URL.onrender.com/verificar \
  -H "Content-Type: application/json" \
  -H "X-Verificacion-Token: EL_MISMO_SECRETO_DE_ARRIBA" \
  -d '{"tipo":"repartidor","uid":"EL_UID_DEL_USUARIO"}'
```

## Nota sobre el "sleep" del plan gratis

Render duerme el servicio después de 15 minutos sin uso, y el primer pedido después de eso tarda ~30-50 segundos en responder (se está "despertando"). Para este caso de uso (revisar una solicitud de vez en cuando) no es un problema — la app puede mostrar "estamos verificando tu solicitud, puede tardar un minuto" mientras espera la respuesta.

## Probar en tu propia máquina (opcional)

Necesitás Docker instalado:

```bash
docker build -t verificacion-backend .
docker run --rm -p 3000:3000 \
  -e FIREBASE_SERVICE_ACCOUNT_JSON="$(cat tu-llave.json)" \
  -e VERIFICACION_SECRETO=lo-que-sea \
  verificacion-backend
```

También podés probar solo la comparación facial, sin Firestore, con dos fotos tuyas:

```bash
docker build -t verificacion-backend .
docker run --rm -v "$(pwd)/fotos:/fotos" verificacion-backend node test_local.js /fotos/foto1.jpg /fotos/foto2.jpg
```
