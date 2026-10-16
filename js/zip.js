// Минимальный читатель ZIP (только то, что нужно для .fb2.zip):
// центральный каталог + stored/deflate через DecompressionStream.

export function isZip(buf) {
  const b = new Uint8Array(buf);
  return b.length > 3 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07);
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Браузер не умеет распаковывать ZIP (нет DecompressionStream). Распакуйте файл .fb2.zip вручную.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return await new Response(stream).arrayBuffer();
}

function findEOCD(dv, len) {
  const max = Math.min(len, 0x10000 + 22);
  for (let i = len - 22; i >= len - max && i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

/** Список записей архива: {name, method, compSize, size, offset} */
export function zipEntries(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const eocd = findEOCD(dv, u8.length);
  if (eocd < 0) throw new Error('Повреждённый ZIP: не найден конец каталога');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const name = new TextDecoder('utf-8').decode(u8.subarray(p + 46, p + 46 + nameLen));
    out.push({ name, method, compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Извлекает один файл из архива. */
export async function zipExtract(buf, entry) {
  const dv = new DataView(buf);
  const p = entry.offset;
  if (dv.getUint32(p, true) !== 0x04034b50) throw new Error('Повреждённый ZIP: нет заголовка файла');
  const nameLen = dv.getUint16(p + 26, true);
  const extraLen = dv.getUint16(p + 28, true);
  const start = p + 30 + nameLen + extraLen;
  const data = new Uint8Array(buf, start, entry.compSize);
  if (entry.method === 0) return data.slice().buffer;
  if (entry.method === 8) return await inflateRaw(data);
  throw new Error('Неподдерживаемый способ сжатия в ZIP: ' + entry.method);
}

/** Из zip берём первый .fb2 (или самый крупный файл). */
export async function unzipFirstFb2(buf) {
  const entries = zipEntries(buf).filter((e) => !e.name.endsWith('/') && e.size > 0);
  let target = entries.find((e) => /\.fb2$/i.test(e.name));
  if (!target) target = entries.slice().sort((a, b) => b.size - a.size)[0];
  if (!target) throw new Error('В архиве нет файлов');
  return { name: target.name, data: await zipExtract(buf, target) };
}
