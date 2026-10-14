// Pruebas de la prueba de vida y de la sesión. Uso (en Docker, Node 20):
//   node test_vida.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const canvas = require('canvas');
const b = require('./index.js');

const DEMO = path.join(__dirname, 'node_modules', '@vladmandic', 'face-api', 'demo');
const b64 = (f) => fs.readFileSync(path.join(DEMO, f)).toString('base64');
async function espejo(base64) {
  const img = await canvas.loadImage(Buffer.from(base64, 'base64'));
  const c = canvas.createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.translate(img.width, 0); ctx.scale(-1, 1); ctx.drawImage(img, 0, 0);
  return c.toBuffer('image/jpeg').toString('base64');
}

(async () => {
  await b.cargarModelos();
  for (const f of fs.readdirSync(DEMO).filter((x) => /^sample\d\.jpg$/.test(x))) {
    const cara = await b.analizarCara(b64(f));
    console.log(f, cara ? `giro=${cara.giro.toFixed(3)}` : 'sin cara');
  }

  const foto = b64('sample1.jpg');
  const r1 = await b.pruebaDeVida({ selfieFrenteBase64: foto, selfieIzquierdaBase64: foto, selfieDerechaBase64: foto, carnetAnversoBase64: foto });
  console.log('misma foto x3 ->', r1);
  assert.strictEqual(r1.ok, false);

  const r2 = await b.pruebaDeVida({ selfieFrenteBase64: foto, selfieIzquierdaBase64: await espejo(foto), selfieDerechaBase64: foto });
  console.log('foto + espejo ->', r2);
  assert.strictEqual(r2.ok, false);

  const r3 = await b.pruebaDeVida({ selfieFrenteBase64: foto });
  console.log('sin laterales ->', r3);
  assert.strictEqual(r3.ok, false);

  assert.strictEqual(await b.uidDeIdToken(''), null);
  assert.strictEqual(await b.uidDeIdToken('basura.no.jwt'), null);
  // JWT bien formado pero firmado por cualquiera: debe rechazarse
  const falso = ['{"alg":"RS256","kid":"x"}', '{"sub":"u1","aud":"laundry-app-asustadores","iss":"https://securetoken.google.com/laundry-app-asustadores","exp":9999999999}']
    .map((s) => Buffer.from(s).toString('base64url')).join('.') + '.firma';
  assert.strictEqual(await b.uidDeIdToken(falso), null);
  console.log('tokens inválidos rechazados');

  const srv = b.app.listen(3999);
  const pre = await fetch('http://127.0.0.1:3999/verificar', { method: 'OPTIONS' });
  assert.strictEqual(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
  const sin = await fetch('http://127.0.0.1:3999/verificar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tipo: 'repartidor', uid: 'u1' }) });
  assert.strictEqual(sin.status, 401);
  const viejo = await fetch('http://127.0.0.1:3999/verificar', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Verificacion-Token': process.env.VERIFICACION_SECRETO || 'x' }, body: JSON.stringify({ tipo: 'repartidor', uid: 'u1' }) });
  assert.strictEqual(viejo.status, 401);
  const conFalso = await fetch('http://127.0.0.1:3999/verificar', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${falso}` }, body: JSON.stringify({ tipo: 'repartidor', uid: 'u1' }) });
  assert.strictEqual(conFalso.status, 401);
  console.log('HTTP: CORS ok, sin sesión 401, secreto viejo 401, token falso 401');
  srv.close();
  console.log('TODO OK');
  process.exit(0);
})().catch((e) => { console.error('FALLÓ:', e); process.exit(1); });
