const assert = require('assert');
const c = require('./codigo_correo');
const express = require('express');

// 1) lógica pura
const uid = 'u1', pepper = 'p', cod = c.generarCodigo();
assert(/^\d{6}$/.test(cod));
const reg = { hash: c.hashCodigo(uid, cod, pepper), venceEn: Date.now() + 1000, intentos: 0 };
assert.strictEqual(c.evaluarIntento(reg, uid, cod, pepper).ok, true);
assert.strictEqual(c.evaluarIntento(reg, uid, '000000' === cod ? '111111' : '000000', pepper).motivo, 'incorrecto');
assert.strictEqual(c.evaluarIntento({ ...reg, venceEn: 1 }, uid, cod, pepper).motivo, 'vencido');
assert.strictEqual(c.evaluarIntento({ ...reg, intentos: 5 }, uid, cod, pepper).motivo, 'demasiados_intentos');
assert.strictEqual(c.evaluarIntento(null, uid, cod, pepper).motivo, 'sin_codigo');
assert.strictEqual(c.evaluarIntento(reg, 'otro', cod, pepper).ok, false); // el código no sirve para otro usuario

// 1b) transporte Brevo (HTTP, sin SMTP)
assert.deepStrictEqual(c.parsearRemitente('Lavanderías <a@b.c>'), { name: 'Lavanderías', email: 'a@b.c' });
assert.deepStrictEqual(c.parsearRemitente('a@b.c'), { email: 'a@b.c' });
assert.strictEqual(c.crearTransporte({}), null);

// 2) endpoints con dependencias simuladas
(async () => {
  const bd = {}; const enviados = []; let verificado = false;
  const app = express(); app.use(express.json());
  const fakeFetch = async (url, opt) => {
    if (url.includes('accounts:lookup')) return { ok: true, json: async () => ({ users: [{ localId: uid, email: 'a@b.c', emailVerified: verificado }] }) };
    if (url.includes('accounts:update')) { verificado = true; return { ok: true }; }
    throw new Error('url inesperada ' + url);
  };
  c.registrar({
    app, fetch: fakeFetch, tokenServicio: async () => 't',
    firestoreGet: async (p) => { if (!bd[p]) throw new Error('404'); return bd[p]; },
    firestorePatch: async (p, t, campos) => { bd[p] = { ...(bd[p] || {}), ...campos }; },
    apiKey: 'k', pepper, remitente: 'x@y', projectId: 'p',
    transporte: { sendMail: async (m) => enviados.push(m) },
  });
  const srv = app.listen(0);
  const base = `http://localhost:${srv.address().port}`;
  const post = (r, b) => require('node-fetch')(base + r, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

  let r = await post('/codigo/enviar', { idToken: 'x' }); assert.strictEqual(r.status, 200);
  assert.strictEqual(enviados.length, 1);
  const codigo = enviados[0].subject.slice(0, 6);
  r = await post('/codigo/enviar', { idToken: 'x' }); assert.strictEqual(r.status, 429); // cooldown
  r = await post('/codigo/verificar', { idToken: 'x', codigo: codigo === '999999' ? '111111' : '999999' });
  assert.strictEqual(r.status, 400); assert.strictEqual((await r.json()).restantes, 4);
  r = await post('/codigo/verificar', { idToken: 'x', codigo: 'abc' }); assert.strictEqual(r.status, 400);
  assert.strictEqual(verificado, false);
  r = await post('/codigo/verificar', { idToken: 'x', codigo }); assert.strictEqual(r.status, 200);
  assert.strictEqual(verificado, true);
  srv.close();

  let llamada;
  const brevo = c.crearTransporte({ BREVO_API_KEY: 'k1' }, async (url, opt) => { llamada = { url, opt }; return { ok: true }; });
  await brevo.sendMail({ from: 'L <a@b.c>', to: 'z@y.x', subject: 's', text: 't', html: 'h' });
  assert.strictEqual(llamada.url, 'https://api.brevo.com/v3/smtp/email');
  assert.strictEqual(llamada.opt.headers['api-key'], 'k1');
  assert.deepStrictEqual(JSON.parse(llamada.opt.body).to, [{ email: 'z@y.x' }]);
  const malo = c.crearTransporte({ BREVO_API_KEY: 'k' }, async () => ({ ok: false, status: 401, text: async () => 'no' }));
  await assert.rejects(malo.sendMail({ from: 'a@b.c', to: 'z@y.x' }), /brevo 401/);
  console.log('codigo_correo: todas las pruebas pasaron');
})().catch((e) => { console.error(e); process.exit(1); });
