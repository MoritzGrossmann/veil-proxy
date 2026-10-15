// Erzeugt die PNG-Icons aus dem Veil-Logo: node scripts/generate-icons.mjs
import { mkdirSync } from 'node:fs';
import sharp from 'sharp';

const out = new URL('../public/icons/', import.meta.url);
mkdirSync(out, { recursive: true });

const MARK = `
  <defs>
    <linearGradient id="g" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="#C4B5FD"/><stop offset="1" stop-color="#6D28D9"/>
    </linearGradient>
    <clipPath id="v"><path d="M10 14 H34 L48 52 L62 14 H86 L58 84 H38 Z"/></clipPath>
  </defs>
  <path d="M10 14 H34 L48 52 L62 14 H86 L58 84 H38 Z" fill="url(#g)"/>
  <g clip-path="url(#v)"><path d="M0 46 C26 36 50 64 96 50 L96 72 C54 86 28 58 0 68 Z" fill="#0B0A12" fill-opacity="0.5"/></g>`;

// Logo (96er Raster) mittig auf dunklem Grund. scale = Anteil der Logo-Breite an der Kachel.
function tile({ scale, radius }) {
  const k = scale * 100 / 96;
  const t = (100 - 96 * k) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="${radius}" fill="#0B0A12"/>
  <g transform="translate(${t} ${t}) scale(${k})">${MARK}</g></svg>`;
}

const any = tile({ scale: 0.72, radius: 22 });
const maskable = tile({ scale: 0.56, radius: 0 }); // Inhalt innerhalb der 80-%-Safe-Zone

const targets = [
  ...[16, 32, 48, 72, 96, 128, 144, 152, 167, 180, 192, 256, 384, 512].map((n) => [`icon-${n}.png`, n, any]),
  ...[192, 512].map((n) => [`maskable-${n}.png`, n, maskable]),
  ['apple-touch-icon.png', 180, tile({ scale: 0.72, radius: 0 })], // iOS rundet selbst ab
];

for (const [name, size, svg] of targets) {
  await sharp(Buffer.from(svg), { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toFile(new URL(name, out).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  console.log(name);
}
