// Verificación de correo con código de 6 dígitos (alternativa al enlace de Firebase).
// Flujo: /codigo/enviar (con el ID token del usuario) manda el código por SMTP;
// /codigo/verificar lo comprueba y marca emailVerified=true en Firebase Auth.
// El código nunca se guarda en claro: solo su hash, con vencimiento e intentos máximos.
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const VENCE_MS = 10 * 60 * 1000;
const REENVIO_MS = 45 * 1000;
const MAX_INTENTOS = 5;

function generarCodigo() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
function hashCodigo(uid, codigo, pepper) {
  return crypto.createHash('sha256').update(`${uid}:${codigo}:${pepper}`).digest('hex');
}

/** Evalúa un intento contra el registro guardado. Pura: facilita probarla. */
function evaluarIntento(reg, uid, codigo, pepper, ahora = Date.now()) {
  if (!reg || !reg.hash) return { ok: false, motivo: 'sin_codigo' };
  if (ahora > reg.venceEn) return { ok: false, motivo: 'vencido' };
  if ((reg.intentos || 0) >= MAX_INTENTOS) return { ok: false, motivo: 'demasiados_intentos' };
  const esperado = Buffer.from(reg.hash, 'hex');
  const recibido = Buffer.from(hashCodigo(uid, String(codigo), pepper), 'hex');
  if (esperado.length === recibido.length && crypto.timingSafeEqual(esperado, recibido)) return { ok: true };
  return { ok: false, motivo: 'incorrecto' };
}

// "Nombre <correo@x>" o "correo@x" → { name, email } (formato de la API de Brevo).
function parsearRemitente(texto) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(texto || '');
  return m ? { name: m[1] || undefined, email: m[2] } : { email: (texto || '').trim() };
}

/**
 * Brevo por HTTPS si hay BREVO_API_KEY (Render gratis bloquea los puertos SMTP
 * 25/465/587 desde sept-2025); si no, SMTP clásico. Ambos exponen sendMail().
 */
function crearTransporte(env, fetchImpl = globalThis.fetch) {
  if (env.BREVO_API_KEY) {
    return {
      async sendMail({ from, to, subject, text, html }) {
        const r = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ sender: parsearRemitente(from), to: [{ email: to }], subject, textContent: text, htmlContent: html }),
        });
        if (!r.ok) throw new Error(`brevo ${r.status} ${await r.text()}`);
      },
    };
  }
  if (!env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    secure: Number(env.SMTP_PORT) === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
}

function correoHtml(codigo) {
  return `<div style="font-family:system-ui,sans-serif;max-width:420px;margin:auto;padding:28px;border-radius:18px;background:#0b1a30;color:#f3faff">
  <h2 style="margin:0 0 6px">Tu código de verificación</h2>
  <p style="color:#a9c4e4;margin:0 0 18px">Ingrésalo en la app para confirmar tu correo.</p>
  <div style="font-size:34px;font-weight:800;letter-spacing:10px;text-align:center;padding:16px;border-radius:14px;background:#12335c">${codigo}</div>
  <p style="color:#a9c4e4;font-size:13px;margin-top:18px">Vence en 10 minutos. Si no fuiste tú, ignora este correo.</p></div>`;
}

/**
 * deps: { app, fetch, tokenServicio(scopes), firestoreGet, firestorePatch, usuarioDeIdToken?, apiKey, pepper, transporte, remitente, projectId }
 * Se inyectan para poder probar sin red.
 */
function registrar(deps) {
  const { app, fetch, tokenServicio, firestoreGet, firestorePatch, apiKey, pepper, transporte, remitente, projectId } = deps;

  // Si index.js pasa su verificador de firma lo usamos; si no, accounts:lookup con la API key.
  const usuarioDeIdToken = deps.usuarioDeIdToken || usuarioPorLookup;

  async function usuarioPorLookup(idToken) {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    if (!r.ok) return null;
    const u = ((await r.json()).users || [])[0];
    return u ? { uid: u.localId, email: u.email, verificado: !!u.emailVerified } : null;
  }

  async function leer(uid, token) {
    try { return await firestoreGet(`codigos_verificacion/${uid}`, token); } catch (_) { return null; }
  }

  app.post('/codigo/enviar', async (req, res) => {
    try {
      if (!transporte) return res.status(503).json({ error: 'smtp_no_configurado' });
      const user = await usuarioDeIdToken((req.body || {}).idToken);
      if (!user || !user.email) return res.status(401).json({ error: 'sesion_invalida' });
      if (user.verificado) return res.json({ ok: true, yaVerificado: true });

      const token = await tokenServicio(['https://www.googleapis.com/auth/datastore']);
      const previo = await leer(user.uid, token);
      const ahora = Date.now();
      if (previo && previo.enviadoEn && ahora - previo.enviadoEn < REENVIO_MS) {
        return res.status(429).json({ error: 'espera', segundos: Math.ceil((REENVIO_MS - (ahora - previo.enviadoEn)) / 1000) });
      }
      const codigo = generarCodigo();
      await firestorePatch(`codigos_verificacion/${user.uid}`, token,
        { hash: hashCodigo(user.uid, codigo, pepper), venceEn: ahora + VENCE_MS, enviadoEn: ahora, intentos: 0 },
        ['hash', 'venceEn', 'enviadoEn', 'intentos']);
      await transporte.sendMail({
        from: remitente, to: user.email,
        subject: `${codigo} es tu código de verificación`,
        text: `Tu código de verificación es ${codigo}. Vence en 10 minutos.`,
        html: correoHtml(codigo),
      });
      res.json({ ok: true });
    } catch (e) {
      console.error('codigo/enviar', e.message);
      res.status(500).json({ error: 'fallo_envio' });
    }
  });

  app.post('/codigo/verificar', async (req, res) => {
    try {
      const { idToken, codigo } = req.body || {};
      if (!/^\d{6}$/.test(String(codigo || ''))) return res.status(400).json({ error: 'formato' });
      const user = await usuarioDeIdToken(idToken);
      if (!user) return res.status(401).json({ error: 'sesion_invalida' });
      if (user.verificado) return res.json({ ok: true });

      const token = await tokenServicio(['https://www.googleapis.com/auth/datastore']);
      const reg = await leer(user.uid, token);
      const r = evaluarIntento(reg, user.uid, codigo, pepper);
      if (!r.ok) {
        if (r.motivo === 'incorrecto') {
          await firestorePatch(`codigos_verificacion/${user.uid}`, token, { intentos: (reg.intentos || 0) + 1 }, ['intentos']);
          return res.status(400).json({ error: 'incorrecto', restantes: Math.max(0, MAX_INTENTOS - (reg.intentos || 0) - 1) });
        }
        return res.status(400).json({ error: r.motivo });
      }
      const tAuth = await tokenServicio(['https://www.googleapis.com/auth/cloud-platform']);
      const u = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tAuth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ localId: user.uid, emailVerified: true }),
      });
      if (!u.ok) throw new Error(`accounts:update ${u.status} ${await u.text()}`);
      await firestorePatch(`codigos_verificacion/${user.uid}`, token, { hash: '', venceEn: 0 }, ['hash', 'venceEn']);
      res.json({ ok: true });
    } catch (e) {
      console.error('codigo/verificar', e.message);
      res.status(500).json({ error: 'fallo_verificacion' });
    }
  });
}

module.exports = { registrar, generarCodigo, hashCodigo, evaluarIntento, crearTransporte, parsearRemitente, MAX_INTENTOS };
