const path = require('path');
const express = require('express');
const canvas = require('canvas');
const faceapi = require('@vladmandic/face-api');
require('@tensorflow/tfjs-node'); // registra el backend nativo 'tensorflow' en tfjs
const { GoogleAuth, OAuth2Client } = require('google-auth-library');
const fetch = require('node-fetch');

const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'laundry-app-asustadores';
const SECRETO = process.env.VERIFICACION_SECRETO || '';
const PORT = process.env.PORT || 3000;

// Distancia euclidiana entre descriptores faciales: face-api.js recomienda
// ~0.6 como límite superior para "misma persona". Usamos algo más estricto
// porque comparamos contra una foto de carnet (a veces de baja calidad),
// para reducir falsos positivos. Ajustar con datos reales una vez en uso.
const UMBRAL_COINCIDENCIA = 0.5;

// Para repartidor (dos documentos + selfie) se pide explícitamente un % de
// similitud mínimo, no solo una distancia "suficientemente baja".
const UMBRAL_SIMILITUD_REPARTIDOR = 70;

// Convierte la distancia euclidiana de face-api a un % de similitud legible
// (0 = nada parecido, 100 = idéntico). Es una heurística lineal simple,
// no una probabilidad calibrada — ajustar con datos reales una vez en uso.
function similitudPorcentaje(distancia) {
  return Math.max(0, Math.min(100, (1 - distancia) * 100));
}

const MODEL_DIR = path.join(__dirname, 'node_modules', '@vladmandic', 'face-api', 'model');

let modelosListos = false;
async function cargarModelos() {
  if (modelosListos) return;
  await faceapi.nets.tinyFaceDetector.loadFromDisk(MODEL_DIR);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_DIR);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_DIR);
  modelosListos = true;
  console.log('Modelos de face-api cargados.');
}

// ---- Firestore por REST, autenticado con una Service Account (bypassa las
// Security Rules porque es una identidad de servidor confiable, no un
// usuario final) ----

let cachedAuth;
async function tokenFirestore() {
  if (!cachedAuth) {
    const credsJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!credsJson) throw new Error('Falta la variable de entorno FIREBASE_SERVICE_ACCOUNT_JSON');
    const credentials = JSON.parse(credsJson);
    cachedAuth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/datastore'],
    });
  }
  const client = await cachedAuth.getClient();
  const { token } = await client.getAccessToken();
  return token;
}

function urlDoc(path) {
  return `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${path}`;
}

// Conversión entre el formato tipado de la API REST de Firestore y objetos JS planos.
function paraJS(valor) {
  if (!valor || valor.nullValue !== undefined) return null;
  if (valor.stringValue !== undefined) return valor.stringValue;
  if (valor.doubleValue !== undefined) return valor.doubleValue;
  if (valor.integerValue !== undefined) return Number(valor.integerValue);
  if (valor.booleanValue !== undefined) return valor.booleanValue;
  if (valor.arrayValue !== undefined) return (valor.arrayValue.values || []).map(paraJS);
  if (valor.mapValue !== undefined) return paraObjetoJS(valor.mapValue.fields || {});
  return null;
}
function paraObjetoJS(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields || {})) obj[k] = paraJS(v);
  return obj;
}
function paraFirestoreValor(valor) {
  if (valor === null || valor === undefined) return { nullValue: null };
  if (typeof valor === 'string') return { stringValue: valor };
  if (typeof valor === 'number') return { doubleValue: valor };
  if (typeof valor === 'boolean') return { booleanValue: valor };
  if (Array.isArray(valor)) return { arrayValue: { values: valor.map(paraFirestoreValor) } };
  if (typeof valor === 'object') return { mapValue: { fields: paraCamposFirestore(valor) } };
  return { nullValue: null };
}
function paraCamposFirestore(obj) {
  const campos = {};
  for (const [k, v] of Object.entries(obj)) campos[k] = paraFirestoreValor(v);
  return campos;
}

async function firestoreGet(docPath, token) {
  const resp = await fetch(urlDoc(docPath), { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`GET ${docPath} → ${resp.status}: ${await resp.text()}`);
  const doc = await resp.json();
  return paraObjetoJS(doc.fields || {});
}

async function firestorePatch(docPath, token, camposJS, mascara) {
  const qs = mascara.map((c) => `updateMask.fieldPaths=${encodeURIComponent(c)}`).join('&');
  const resp = await fetch(`${urlDoc(docPath)}?${qs}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: paraCamposFirestore(camposJS) }),
  });
  if (!resp.ok) throw new Error(`PATCH ${docPath} → ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// Trae TODOS los documentos de una colección chica (esto es un prototipo de
// bajo volumen; para una app grande esto habría que paginarlo o indexarlo).
async function firestoreListarTodo(coleccion, token) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${coleccion}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`LIST ${coleccion} → ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return (data.documents || []).map((doc) => ({
    id: doc.name.split('/').pop(),
    datos: paraObjetoJS(doc.fields || {}),
  }));
}

// ---- Detección de duplicados (no rechaza sola, solo levanta una alerta
// para que el verificador y el superadmin la revisen a mano) ----

function distanciaMetros(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (g) => (g * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

async function buscarDuplicadosRepartidor(token, uidActual, ci, placaMoto) {
  const motivos = [];
  const todos = await firestoreListarTodo('solicitudes_repartidor', token);
  const otros = todos.filter((r) => r.id !== uidActual && r.datos.estado !== 'rechazada');

  if (ci) {
    const mismoCi = otros.filter((r) => r.datos.ci === ci);
    if (mismoCi.length) {
      motivos.push(`Ya existe otra solicitud de repartidor con el mismo CI (${ci}).`);
    }
  }
  if (placaMoto) {
    const mismaPlacaOtroCi = otros.filter((r) => r.datos.placaMoto === placaMoto && r.datos.ci !== ci);
    if (mismaPlacaOtroCi.length) {
      motivos.push(
        `Otra persona con CI distinto ya registró la misma placa de moto (${placaMoto}) — posible suplantación.`,
      );
    }
  }
  return motivos;
}

async function buscarDuplicadosLavanderia(token, uidActual, nit, lat, lng) {
  const motivos = [];
  const todos = await firestoreListarTodo('solicitudes_lavanderia', token);
  const otros = todos.filter((r) => r.id !== uidActual && r.datos.estado !== 'rechazada');

  if (nit) {
    const mismoNit = otros.filter((r) => r.datos.nit === nit);
    if (mismoNit.length) {
      motivos.push(`Ya existe otra solicitud de lavandería con el mismo NIT (${nit}).`);
    }
  }
  if (typeof lat === 'number' && typeof lng === 'number') {
    for (const r of otros) {
      if (typeof r.datos.lat !== 'number' || typeof r.datos.lng !== 'number') continue;
      const d = distanciaMetros(lat, lng, r.datos.lat, r.datos.lng);
      if (d < 40) {
        motivos.push(
          `Ya hay otra lavandería ("${r.datos.nombre || 'sin nombre'}") registrada a ${Math.round(d)}m de esta ubicación.`,
        );
        break;
      }
    }
  }
  return motivos;
}

// ---- Sesión del usuario (ID token de Firebase) ----
// La app manda su ID token y se verifica la firma con los certificados
// públicos de Google. Así no hace falta ningún secreto dentro de la app (se
// podía extraer del APK o de la web) y nadie puede pedir la verificación de
// otra persona.

const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const clienteJwt = new OAuth2Client();
let certs = { datos: null, vence: 0 };

async function uidDeIdToken(idToken) {
  if (!idToken) return null;
  try {
    if (!certs.datos || Date.now() > certs.vence) {
      const r = await fetch(CERTS_URL);
      certs = { datos: await r.json(), vence: Date.now() + 60 * 60 * 1000 };
    }
    const ticket = await clienteJwt.verifySignedJwtWithCertsAsync(
      idToken, certs.datos, PROJECT_ID, [`https://securetoken.google.com/${PROJECT_ID}`],
    );
    return ticket.getPayload().sub || null;
  } catch (_) {
    return null;
  }
}

// Igual que uidDeIdToken pero con el correo: el ID token ya trae email y
// email_verified firmados por Google, así no hace falta la API key web.
async function usuarioDeIdToken(idToken) {
  const uid = await uidDeIdToken(idToken);
  if (!uid) return null;
  const p = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString());
  return { uid, email: p.email, verificado: !!p.email_verified };
}

// ---- Comparación facial ----

async function descriptorDeBase64(base64Img) {
  if (!base64Img) return null;
  const buffer = Buffer.from(base64Img, 'base64');
  const img = await canvas.loadImage(buffer);
  const deteccion = await faceapi
    .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();
  return deteccion ? deteccion.descriptor : null;
}

// Giro de la cabeza a partir de los 68 puntos: cuánto se corre la nariz
// respecto del centro de los ojos, en unidades de distancia entre ojos.
// De frente ~0; girada ~0.3 o más. Una foto plana (el carnet impreso o en
// otra pantalla) inclinada no cambia este valor: la nariz no se desplaza.
function giroDeLandmarks(puntos) {
  const media = (a, b) => {
    let x = 0, y = 0;
    for (let i = a; i <= b; i++) { x += puntos[i].x; y += puntos[i].y; }
    const n = b - a + 1;
    return { x: x / n, y: y / n };
  };
  const ojoA = media(36, 41), ojoB = media(42, 47);
  const entreOjos = Math.hypot(ojoB.x - ojoA.x, ojoB.y - ojoA.y) || 1;
  const nariz = puntos[30];
  return (nariz.x - (ojoA.x + ojoB.x) / 2) / entreOjos;
}

async function analizarCara(base64Img) {
  if (!base64Img) return null;
  const img = await canvas.loadImage(Buffer.from(base64Img, 'base64'));
  const d = await faceapi
    .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();
  return d ? { descriptor: d.descriptor, giro: giroDeLandmarks(d.landmarks.positions) } : null;
}

const GIRO_MINIMO_LATERAL = 0.18;
const MISMA_PERSONA_SELFIES = 0.6;
// Una selfie real contra la foto del carnet casi nunca baja de ~0.25; por
// debajo de esto es la misma imagen (le sacaron foto al carnet).
const DISTANCIA_COPIA = 0.12;

// Prueba de vida con las tres selfies (frente, izquierda, derecha): las
// laterales deben ser la misma persona con la cabeza girada a lados
// opuestos, y la de frente no puede ser una copia del carnet. No rechaza
// sola: si falla, la solicitud queda para revisión humana.
async function pruebaDeVida(solicitud) {
  const frente = await analizarCara(solicitud.selfieFrenteBase64);
  if (!frente) return { ok: false, motivo: 'No se detectó una cara en la selfie de frente' };
  const izq = await analizarCara(solicitud.selfieIzquierdaBase64);
  const der = await analizarCara(solicitud.selfieDerechaBase64);
  if (!izq || !der) return { ok: false, motivo: 'Faltan las selfies girando la cabeza (o no se detectó la cara)' };

  for (const [lado, cara] of [['izquierda', izq], ['derecha', der]]) {
    if (faceapi.euclideanDistance(frente.descriptor, cara.descriptor) > MISMA_PERSONA_SELFIES) {
      return { ok: false, motivo: `La selfie ${lado} no parece la misma persona que la de frente` };
    }
  }
  const giroIzq = izq.giro - frente.giro, giroDer = der.giro - frente.giro;
  if (Math.abs(giroIzq) < GIRO_MINIMO_LATERAL || Math.abs(giroDer) < GIRO_MINIMO_LATERAL
      || Math.sign(giroIzq) === Math.sign(giroDer)) {
    return { ok: false, motivo: 'Las selfies laterales no muestran la cabeza girada a ambos lados (posible foto de una foto)' };
  }

  const carnet = await analizarCara(solicitud.carnetAnversoBase64);
  if (carnet && faceapi.euclideanDistance(carnet.descriptor, frente.descriptor) < DISTANCIA_COPIA) {
    return { ok: false, motivo: 'La selfie es prácticamente idéntica a la foto del carnet' };
  }
  return { ok: true, motivo: '' };
}

async function compararCaras(carnetBase64, selfieBase64) {
  const descCarnet = await descriptorDeBase64(carnetBase64);
  if (!descCarnet) return { coincide: false, distancia: null, motivo: 'No se detectó una cara en el carnet' };

  const descSelfie = await descriptorDeBase64(selfieBase64);
  if (!descSelfie) return { coincide: false, distancia: null, motivo: 'No se detectó una cara en la selfie' };

  const distancia = faceapi.euclideanDistance(descCarnet, descSelfie);
  return { coincide: distancia <= UMBRAL_COINCIDENCIA, distancia };
}

// Compara dos fotos cualquiera (documento vs. documento, o documento vs.
// selfie) y devuelve tanto la distancia cruda como un % de similitud.
async function compararDosCaras(base64A, base64B, etiquetaA, etiquetaB) {
  const descA = await descriptorDeBase64(base64A);
  if (!descA) return { ok: false, motivo: `No se detectó una cara en ${etiquetaA}` };

  const descB = await descriptorDeBase64(base64B);
  if (!descB) return { ok: false, motivo: `No se detectó una cara en ${etiquetaB}` };

  const distancia = faceapi.euclideanDistance(descA, descB);
  return { ok: true, distancia, similitud: similitudPorcentaje(distancia) };
}

// Verificación de repartidor: la selfie (sin casco ni lentes) debe coincidir
// con el carnet Y con la licencia de conducir (>70% de similitud cada una).
// Si el carnet y la licencia no parecen ser de la misma persona, es una
// discrepancia entre documentos y tampoco se aprueba automático.
async function verificarRepartidor(solicitud) {
  const selfieVsCarnet = await compararDosCaras(
    solicitud.carnetAnversoBase64, solicitud.selfieFrenteBase64, 'el carnet', 'la selfie',
  );
  if (!selfieVsCarnet.ok) return { aprobado: false, motivo: selfieVsCarnet.motivo };

  const selfieVsLicencia = await compararDosCaras(
    solicitud.licenciaConducirBase64, solicitud.selfieFrenteBase64, 'la licencia de conducir', 'la selfie',
  );
  if (!selfieVsLicencia.ok) return { aprobado: false, motivo: selfieVsLicencia.motivo };

  const carnetVsLicencia = await compararDosCaras(
    solicitud.carnetAnversoBase64, solicitud.licenciaConducirBase64, 'el carnet', 'la licencia de conducir',
  );
  if (!carnetVsLicencia.ok) return { aprobado: false, motivo: carnetVsLicencia.motivo };

  const discrepancia = carnetVsLicencia.similitud < UMBRAL_SIMILITUD_REPARTIDOR;
  const peorSimilitud = Math.min(selfieVsCarnet.similitud, selfieVsLicencia.similitud);
  const peorDistancia = Math.max(selfieVsCarnet.distancia, selfieVsLicencia.distancia);
  const coincideSelfie = peorSimilitud >= UMBRAL_SIMILITUD_REPARTIDOR;

  return {
    aprobado: coincideSelfie && !discrepancia,
    distancia: peorDistancia,
    similitud: peorSimilitud,
    discrepancia,
    motivoDiscrepancia: discrepancia
      ? `El carnet y la licencia de conducir no parecen ser de la misma persona `
        + `(similitud ${carnetVsLicencia.similitud.toFixed(0)}%).`
      : '',
    motivo: discrepancia
      ? 'Discrepancia entre el carnet y la licencia de conducir, requiere revisión humana'
      : (!coincideSelfie
        ? `La selfie no coincide lo suficiente con el carnet y/o la licencia `
          + `(similitud mínima ${peorSimilitud.toFixed(0)}%, se pide al menos ${UMBRAL_SIMILITUD_REPARTIDOR}%)`
        : ''),
  };
}

// ---- Servidor HTTP ----

const app = express();
app.use(express.json({ limit: '5mb' }));

app.get('/', (req, res) => res.json({ ok: true }));

// La app web llama a /verificar desde el navegador: sin CORS fallaba siempre.
app.use('/verificar', (req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// CORS solo para los endpoints de código (la app web los llama desde el navegador).
app.use('/codigo', (req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
const codigoCorreo = require('./codigo_correo');
codigoCorreo.registrar({
  app,
  fetch,
  tokenServicio: async (scopes) => {
    const credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
    const cliente = await new GoogleAuth({ credentials, scopes }).getClient();
    return (await cliente.getAccessToken()).token;
  },
  firestoreGet,
  firestorePatch,
  usuarioDeIdToken: process.env.FIREBASE_WEB_API_KEY ? undefined : usuarioDeIdToken,
  apiKey: process.env.FIREBASE_WEB_API_KEY || '',
  pepper: process.env.CODIGO_PEPPER || SECRETO || 'pepper',
  transporte: codigoCorreo.crearTransporte(process.env, fetch),
  remitente: process.env.CORREO_REMITENTE || process.env.SMTP_FROM || process.env.SMTP_USER || '',
  projectId: PROJECT_ID,
});

app.post('/verificar', async (req, res) => {
  try {
    const { tipo, uid } = req.body || {};
    // Solo el propio postulante, con su sesión. (El secreto compartido de
    // antes iba dentro de la app y quedó expuesto: ya no da acceso.)
    const idToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const uidSesion = await uidDeIdToken(idToken);
    if (!uidSesion || uidSesion !== uid) return res.status(401).json({ error: 'No autorizado' });

    if (!uid || !['repartidor', 'lavanderia', 'empleado'].includes(tipo)) {
      return res.status(400).json({ error: 'Faltan datos (tipo debe ser repartidor|lavanderia|empleado, y uid)' });
    }

    await cargarModelos();
    const token = await tokenFirestore();

    const coleccion = {
      repartidor: 'solicitudes_repartidor',
      lavanderia: 'solicitudes_lavanderia',
      empleado: 'solicitudes_empleado',
    }[tipo];
    const solicitud = await firestoreGet(`${coleccion}/${uid}`, token);

    if (solicitud.estado !== 'pendiente') {
      return res.json({ aprobado: false, motivo: `La solicitud ya está en estado "${solicitud.estado}"` });
    }

    // El empleado es un caso aparte: la decisión de contratarlo es siempre
    // del admin de esa lavandería en particular (un match de cara no implica
    // que quiera contratar a esa persona), así que esto NUNCA aprueba solo
    // ni cambia el estado — solo deja la comparación como referencia.
    if (tipo === 'empleado') {
      const resultado = await compararCaras(solicitud.carnetAnversoBase64, solicitud.selfieFrenteBase64);
      const vidaEmpleado = await pruebaDeVida(solicitud);
      await firestorePatch(
        `${coleccion}/${uid}`,
        token,
        {
          verificacionAutomaticaDistancia: resultado.distancia,
          verificacionAutomaticaCoincide: resultado.coincide,
          pruebaVidaOk: vidaEmpleado.ok,
          motivoPruebaVida: vidaEmpleado.motivo,
        },
        ['verificacionAutomaticaDistancia', 'verificacionAutomaticaCoincide', 'pruebaVidaOk', 'motivoPruebaVida'],
      );
      return res.json({
        aprobado: false,
        distancia: resultado.distancia,
        motivo: 'Verificación de referencia guardada; el admin de la lavandería decide la contratación.',
      });
    }

    const resultado = tipo === 'repartidor'
      ? await verificarRepartidor(solicitud)
      : await compararCaras(solicitud.carnetAnversoBase64, solicitud.selfieFrenteBase64);
    // Normalizamos el nombre del campo "coincide" entre las dos formas de resultado.
    const coincideSelfie = tipo === 'repartidor' ? resultado.aprobado : resultado.coincide;
    const vida = await pruebaDeVida(solicitud);

    // Duplicados: nunca bloquean solos (podría ser una coincidencia real),
    // pero si aparece alguno, no se aprueba automático — queda para que un
    // humano (verificador o superadmin) lo revise a propósito.
    let motivosDuplicado = [];
    try {
      motivosDuplicado =
        tipo === 'repartidor'
          ? await buscarDuplicadosRepartidor(token, uid, solicitud.ci, solicitud.placaMoto)
          : await buscarDuplicadosLavanderia(token, uid, solicitud.nit, solicitud.lat, solicitud.lng);
    } catch (e) {
      console.error('No se pudo chequear duplicados (se continúa sin bloquear por esto):', e);
    }

    // Guardamos el resultado siempre (aprobemos o no) para que el verificador
    // humano lo vea como referencia si termina revisando el caso a mano.
    const camposGuardar = {
      verificacionAutomaticaDistancia: resultado.distancia,
      verificacionAutomaticaCoincide: coincideSelfie,
      posibleDuplicado: motivosDuplicado.length > 0,
      motivoDuplicado: motivosDuplicado.join(' '),
      pruebaVidaOk: vida.ok,
      motivoPruebaVida: vida.motivo,
    };
    const mascaraGuardar = [
      'verificacionAutomaticaDistancia',
      'verificacionAutomaticaCoincide',
      'posibleDuplicado',
      'motivoDuplicado',
      'pruebaVidaOk',
      'motivoPruebaVida',
    ];
    if (tipo === 'repartidor') {
      camposGuardar.discrepanciaDocumentos = !!resultado.discrepancia;
      camposGuardar.motivoDiscrepancia = resultado.motivoDiscrepancia || '';
      mascaraGuardar.push('discrepanciaDocumentos', 'motivoDiscrepancia');
    }
    await firestorePatch(`${coleccion}/${uid}`, token, camposGuardar, mascaraGuardar);

    if (motivosDuplicado.length > 0) {
      return res.json({
        aprobado: false,
        distancia: resultado.distancia,
        motivo: `Posible duplicado, requiere revisión humana: ${motivosDuplicado.join(' ')}`,
      });
    }

    if (tipo === 'repartidor' && resultado.discrepancia) {
      return res.json({ aprobado: false, distancia: resultado.distancia, motivo: resultado.motivo });
    }

    if (!vida.ok) {
      return res.json({ aprobado: false, distancia: resultado.distancia, motivo: `Requiere revisión humana: ${vida.motivo}` });
    }

    if (!coincideSelfie) {
      return res.json({
        aprobado: false,
        distancia: resultado.distancia,
        motivo: resultado.motivo || 'La cara de la selfie no coincide lo suficiente con el carnet',
      });
    }

    if (tipo === 'repartidor') {
      // El repartidor es de una sola etapa: la cara coincide -> aprobado.
      await firestorePatch(`usuarios/${uid}`, token, { role: 'repartidor' }, ['role']);
      await firestorePatch(`solicitudes_repartidor/${uid}`, token, { estado: 'aprobada' }, ['estado']);
    } else {
      // La lavandería es de dos etapas: esto solo confirma la identidad del
      // dueño (igual que haría un verificador humano). La creación del local
      // público y la promoción a admin las hace el superadmin como segunda
      // etapa, después de revisar el local en sí (ubicación, NIT, fotos).
      await firestorePatch('solicitudes_lavanderia/' + uid, token, { estado: 'identidadConfirmada' }, [
        'estado',
      ]);
    }

    res.json({ aprobado: true, distancia: resultado.distancia });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Verificación automática escuchando en el puerto ${PORT}`));
}

// Para las pruebas (test_vida.js) sin levantar el servidor.
module.exports = { app, cargarModelos, analizarCara, pruebaDeVida, uidDeIdToken, giroDeLandmarks };
