// Quick regression + ReDoS timing test: npm run test:media-text
import { parseMediaAutoText, cleanMediaText, mediaPreviewText } from '../src/lib/media-text.ts';
const cases: [string, Record<string, string>][] = [
 ['Image attached (image_xxx.jpeg) [Size: 162.6 KB | Type: image/jpeg] URL: https://app.kapso.ai/rails/a/b.jpeg', {kind:'image',filename:'image_xxx.jpeg',sizeText:'162.6 KB',mimeType:'image/jpeg',rest:''}],
 ['Document attached (H.C reumatólogo .pdf) [Size: 2.6 MB | Type: application/pdf] URL: https://app.kapso.ai/x', {kind:'document',filename:'H.C reumatólogo .pdf',sizeText:'2.6 MB',mimeType:'application/pdf',rest:''}],
 ['Mire doctor\nImage attached (foto (1).jpg) [Size: 1 MB | Type: image/jpeg] URL: https://app.kapso.ai/y', {kind:'image',filename:'foto (1).jpg',sizeText:'1 MB',mimeType:'image/jpeg',rest:'Mire doctor'}],
 ['Audio attached [Size: 25 KB | Type: audio/ogg]', {kind:'audio',sizeText:'25 KB',mimeType:'audio/ogg',rest:''}],
];
let ok = true;
for (const [t, exp] of cases) {
  const got = parseMediaAutoText(t)!; const pass = Object.entries(exp).every(([k, v]) => (got as unknown as Record<string, unknown>)[k] === v);
  ok &&= pass; console.log(pass ? 'PASS' : 'FAIL', JSON.stringify(got));
}
ok &&= parseMediaAutoText('hola normal') === null;
console.log(parseMediaAutoText('hola normal') === null ? 'PASS null' : 'FAIL null');
const cl = cleanMediaText('ver URL: https://app.kapso.ai/z aqui'); console.log(!cl.includes('kapso') ? 'PASS clean' : 'FAIL clean', JSON.stringify(cl)); ok &&= !cl.includes('kapso');
for (const [label, t] of [['4000 spaces', 'Image attached [Size:' + ' '.repeat(4000)], ['100k chars', 'Image attached (' + 'a'.repeat(100000)], ['100k brackets', 'Document attached [Size: ' + '|'.repeat(100000)], ['100k URL', 'x URL: ' + 'U'.repeat(100000)]] as const) {
  const t0 = performance.now(); for (let i = 0; i < 10; i++) { parseMediaAutoText(t); cleanMediaText(t); mediaPreviewText(t); } const ms = (performance.now() - t0) / 10;
  ok &&= ms < 5;
  console.log(ms < 5 ? 'PASS' : 'FAIL', label, ms.toFixed(3) + 'ms');
}
if (!ok) { console.error('media-text tests FAILED'); process.exit(1); }
console.log('media-text tests OK');
