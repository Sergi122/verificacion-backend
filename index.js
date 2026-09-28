const path = require('path');
const express = require('express');
const canvas = require('canvas');
const faceapi = require('@vladmandic/face-api');
require('@tensorflow/tfjs-node'); // registra el backend nativo 'tensorflow' en tfjs
const { GoogleAuth } = require('google-auth-library');
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

async function firestorePost(coleccion, token, camposJS) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${coleccion}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: paraCamposFirestore(camposJS) }),
  });
  if (!resp.ok) throw new Error(`POST ${coleccion} → ${resp.status}: ${await resp.text()}`);
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

async function compararCaras(carnetBase64, selfieBase64) {
  const descCarnet = await descriptorDeBase64(carnetBase64);
  if (!descCarnet) return { coincide: false, distancia: null, motivo: 'No se detectó una cara en el carnet' };

  const descSelfie = await descriptorDeBase64(selfieBase64);
  if (!descSelfie) return { coincide: false, distancia: null, motivo: 'No se detectó una cara en la selfie' };

  const distancia = faceapi.euclideanDistance(descCarnet, descSelfie);
  return { coincide: distancia <= UMBRAL_COINCIDENCIA, distancia };
}

// ---- Servidor HTTP ----

const app = express();
app.use(express.json({ limit: '5mb' }));

app.get('/', (req, res) => res.json({ ok: true }));

app.post('/verificar', async (req, res) => {
  try {
    if (SECRETO && req.headers['x-verificacion-token'] !== SECRETO) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    const { tipo, uid } = req.body || {};
    if (!uid || !['repartidor', 'lavanderia'].includes(tipo)) {
      return res.status(400).json({ error: 'Faltan datos (tipo debe ser repartidor|lavanderia, y uid)' });
    }

    await cargarModelos();
    const token = await tokenFirestore();

    const coleccion = tipo === 'repartidor' ? 'solicitudes_repartidor' : 'solicitudes_lavanderia';
    const solicitud = await firestoreGet(`${coleccion}/${uid}`, token);

    if (solicitud.estado !== 'pendiente') {
      return res.json({ aprobado: false, motivo: `La solicitud ya está en estado "${solicitud.estado}"` });
    }

    const resultado = await compararCaras(solicitud.carnetAnversoBase64, solicitud.selfieFrenteBase64);

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
    await firestorePatch(
      `${coleccion}/${uid}`,
      token,
      {
        verificacionAutomaticaDistancia: resultado.distancia,
        verificacionAutomaticaCoincide: resultado.coincide,
        posibleDuplicado: motivosDuplicado.length > 0,
        motivoDuplicado: motivosDuplicado.join(' '),
      },
      [
        'verificacionAutomaticaDistancia',
        'verificacionAutomaticaCoincide',
        'posibleDuplicado',
        'motivoDuplicado',
      ],
    );

    if (motivosDuplicado.length > 0) {
      return res.json({
        aprobado: false,
        distancia: resultado.distancia,
        motivo: `Posible duplicado, requiere revisión humana: ${motivosDuplicado.join(' ')}`,
      });
    }

    if (!resultado.coincide) {
      return res.json({
        aprobado: false,
        distancia: resultado.distancia,
        motivo: resultado.motivo || 'La cara de la selfie no coincide lo suficiente con el carnet',
      });
    }

    if (tipo === 'repartidor') {
      await firestorePatch(`usuarios/${uid}`, token, { role: 'repartidor' }, ['role']);
      await firestorePatch(`solicitudes_repartidor/${uid}`, token, { estado: 'aprobada' }, ['estado']);
    } else {
      const lavanderiaPublica = {
        nombre: solicitud.nombre,
        direccion: solicitud.direccion,
        lat: solicitud.lat,
        lng: solicitud.lng,
        servicios: solicitud.servicios || [],
        precios: solicitud.mostrarPrecios ? solicitud.precios || {} : {},
        costoEnvio: solicitud.costoEnvio || 0,
        entregaDomicilio: !!solicitud.entregaDomicilio,
        propietarioUid: uid,
        fotosBase64: solicitud.fotosBase64 || [],
        activo: true,
      };
      if (solicitud.mostrarPrecios && solicitud.precioDocena != null) {
        lavanderiaPublica.precioDocena = solicitud.precioDocena;
      }
      if (solicitud.mostrarPrecios && solicitud.precioKg != null) {
        lavanderiaPublica.precioKg = solicitud.precioKg;
      }

      const nuevoDoc = await firestorePost('lavanderias', token, lavanderiaPublica);
      const nuevoId = nuevoDoc.name.split('/').pop();
      await firestorePatch(`usuarios/${uid}`, token, { role: 'admin', lavanderiaId: nuevoId }, [
        'role',
        'lavanderiaId',
      ]);
      await firestorePatch('solicitudes_lavanderia/' + uid, token, { estado: 'aprobada' }, ['estado']);
    }

    res.json({ aprobado: true, distancia: resultado.distancia });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

app.listen(PORT, () => console.log(`Verificación automática escuchando en el puerto ${PORT}`));
