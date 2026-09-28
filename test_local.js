// Prueba local: compara dos fotos de cara que vos le pases.
// Uso: node test_local.js foto_carnet.jpg foto_selfie.jpg
const path = require('path');
const canvas = require('canvas');
const faceapi = require('@vladmandic/face-api');
require('@tensorflow/tfjs-node');

const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

const MODEL_DIR = path.join(__dirname, 'node_modules', '@vladmandic', 'face-api', 'model');

async function descriptorDeArchivo(rutaArchivo) {
  const img = await canvas.loadImage(rutaArchivo);
  const d = await faceapi
    .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();
  return d ? d.descriptor : null;
}

(async () => {
  const [rutaA, rutaB] = process.argv.slice(2);
  if (!rutaA || !rutaB) {
    console.error('Uso: node test_local.js <foto1.jpg> <foto2.jpg>');
    process.exit(1);
  }

  await faceapi.nets.tinyFaceDetector.loadFromDisk(MODEL_DIR);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_DIR);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_DIR);
  console.log('Modelos cargados.');

  const descA = await descriptorDeArchivo(rutaA);
  const descB = await descriptorDeArchivo(rutaB);

  if (!descA) return console.log(`No se detectó cara en ${rutaA}`);
  if (!descB) return console.log(`No se detectó cara en ${rutaB}`);

  const distancia = faceapi.euclideanDistance(descA, descB);
  console.log(`Distancia: ${distancia.toFixed(4)} → ${distancia <= 0.5 ? 'COINCIDE' : 'no coincide'}`);
})().catch((e) => {
  console.error('ERROR:', e);
  process.exit(1);
});
