/*
 * Image handling, matched to the Android app so a photo prepared here is
 * byte-comparable with one prepared on the phone: 1024 px long edge, JPEG
 * quality 80, and a SHA-256 taken over the compressed bytes actually stored.
 */

const MAX_LONG_EDGE = 1024;
const THUMB_LONG_EDGE = 320;
const JPEG_QUALITY = 0.8;

/** Mirrors ImageScaling.targetSize on Android: never upscales. */
function targetSize(width, height, maxLongEdge = MAX_LONG_EDGE) {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) return [width, height];
  const scale = maxLongEdge / longEdge;
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

async function decode(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* fall through to the <img> path */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('This file could not be read as an image.'));
      img.src = url;
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function drawTo(source, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  // Catalogue JPEGs need a white background when the supplier's PNG is transparent.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

function toBlob(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('This image could not be compressed.'))),
      'image/jpeg',
      JPEG_QUALITY
    )
  );
}

/**
 * Compresses to the stored form and returns everything the catalogue records.
 * @returns {Promise<{blob: Blob, thumb: Blob, width: number, height: number, bytes: number, sha256: string}>}
 */
async function prepare(fileOrBlob) {
  const source = await decode(fileOrBlob);
  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  if (!width || !height) throw new Error('This file could not be read as an image.');

  const [w, h] = targetSize(width, height);
  const fullBlob = await toBlob(drawTo(source, w, h));

  const [tw, th] = targetSize(w, h, THUMB_LONG_EDGE);
  const thumbBlob = await toBlob(drawTo(source, tw, th));

  const bytes = new Uint8Array(await fullBlob.arrayBuffer());
  return {
    blob: fullBlob,
    thumb: thumbBlob,
    width: w,
    height: h,
    bytes: bytes.length,
    sha256: await sha256Hex(bytes)
  };
}

/**
 * Fetches an image the owner pasted a link to.
 *
 * Tries the browser directly first. Most image hosts do not send CORS
 * headers, so that usually fails; the fallback then goes through whichever
 * fetcher answers where this is running -- server.py's local /fetch route
 * on 127.0.0.1 (the "EE Lens Manager.bat" workflow), or the hosted
 * Cloudflare Worker's /image route anywhere else, including
 * lens.electricemporium.in. See fetchImageProxyEndpoint() in import-url.js,
 * which both this and the candidate-image preview in app.js call into.
 */
async function fetchImageUrl(url) {
  const clean = url.trim();
  if (!/^https?:\/\//i.test(clean)) {
    throw new Error('Paste a link that starts with http:// or https://');
  }

  try {
    const direct = await fetch(clean, { mode: 'cors' });
    if (direct.ok) {
      const blob = await direct.blob();
      if (blob.type.startsWith('image/')) return blob;
    }
  } catch {
    /* expected for most hosts; fall through to the proxy */
  }

  if (!isLocalHelperHost() && !CLOUD_FETCH_PROXY_URL) {
    throw new Error(`${noFetcherMessage()} Or save the image and drag it in instead.`);
  }

  try {
    const viaHelper = await fetch(fetchImageProxyEndpoint(clean), {
      headers: CLOUD_FETCH_PROXY_SECRET && !isLocalHelperHost()
        ? { 'X-Ee-Lens-Proxy-Key': CLOUD_FETCH_PROXY_SECRET }
        : undefined
    });
    if (viaHelper.ok) {
      const blob = await viaHelper.blob();
      if (blob.type.startsWith('image/')) return blob;
      throw new Error('That link did not return an image.');
    }
    throw new Error(await viaHelper.text());
  } catch (error) {
    throw new Error(
      isLocalHelperHost()
        ? `${error.message || 'That image could not be downloaded.'} ` +
          'Start the manager with "EE Lens Manager.bat" to download links, ' +
          'or save the image and drag it in instead.'
        : `${error.message || 'That image could not be downloaded.'} Save the image and drag it in instead.`
    );
  }
}

/* ---------- SHA-256 ---------- */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

/** Falls back to a plain implementation when crypto.subtle is unavailable. */
async function sha256Hex(bytes) {
  if (globalThis.crypto?.subtle) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      /* fall through */
    }
  }
  return sha256Fallback(bytes);
}

function sha256Fallback(input) {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const bitLen = input.length * 8;
  const padded = new Uint8Array((((input.length + 9) >> 6) + 1) << 6);
  padded.set(input);
  padded[input.length] = 0x80;
  new DataView(padded.buffer).setUint32(padded.length - 4, bitLen >>> 0, false);
  new DataView(padded.buffer).setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);

  const w = new Uint32Array(64);
  const view = new DataView(padded.buffer);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
}
