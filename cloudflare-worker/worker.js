/**
 * Maya's Morning Brief — Cloudflare Worker
 *
 * Läuft 24/7 kostenlos in der Cloud.
 * Speichert Push-Subscriptions in KV, sendet 5x täglich Notifications.
 *
 * Endpunkte:
 *   POST /subscribe   — Subscription registrieren
 *   GET  /status      — Status & Anzahl Subscriptions
 *
 * Cron Trigger (in wrangler.toml):
 *   00:00, 06:00, 12:00, 14:00, 16:00, 18:30 (Europe/Berlin)
 */

// VAPID Keys (generiert für maya-brief)
const VAPID_PUBLIC_KEY  = 'BJtHjlU94cINezIzs2rK9EQDdFxLYr7zhhWtCk9JR5WRUwho-VDJ8l2GTPt7VTETl123WLLubqxsVOHqUHoQb1U';
const VAPID_PRIVATE_KEY = 'qfnTEUyCnTAlg3_aoNnnUov9wqorbwPHnZYyBRbrWZc';
const VAPID_SUBJECT     = 'mailto:mail@mayaparla.com';

// Push-Nachrichten für jede Uhrzeit
const PUSH_MESSAGES = {
  0:  { title: "Maya's Morning Brief 🌙", body: "Guten Morgen! Neuer Tag, frische Inhalte. ✨" },
  6:  { title: "Maya's Morning Brief ☀️", body: "Dein Morgen-Brief ist bereit — Wetter, News & mehr!" },
  12: { title: "Maya's Morning Brief 🌤️", body: "Mittagscheck: aktuelle News & Wetter für heute." },
  14: { title: "Maya's Morning Brief ☕", body: "Zeit für eine kurze Pause — dein Brief ist aktuell." },
  16: { title: "Maya's Morning Brief 🌅", body: "Nachmittags-Update: Was heute noch wichtig ist." },
  18: { title: "Maya's Morning Brief 🌆", body: "Abendbriefing — mach dich bereit für den Abend." },
};

// ── CORS Headers ──────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Main fetch handler ────────────────────────────────────────────────
export default {
  // HTTP requests
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // POST /subscribe — Push-Subscription speichern
    if (request.method === 'POST' && url.pathname === '/subscribe') {
      try {
        const sub = await request.json();
        if (!sub?.endpoint) return new Response('Invalid subscription', { status: 400, headers: CORS });

        // Key = hash of endpoint für Eindeutigkeit
        const key = await hashEndpoint(sub.endpoint);
        await env.SUBSCRIPTIONS.put(key, JSON.stringify({
          subscription: sub,
          createdAt: new Date().toISOString(),
          userAgent: request.headers.get('User-Agent') || ''
        }));

        console.log('New subscription registered:', key);
        return new Response(JSON.stringify({ ok: true, key }), {
          headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      } catch(e) {
        return new Response('Error: ' + e.message, { status: 500, headers: CORS });
      }
    }

    // GET /status
    if (request.method === 'GET' && url.pathname === '/status') {
      const list = await env.SUBSCRIPTIONS.list();
      return new Response(JSON.stringify({
        ok: true,
        subscriptions: list.keys.length,
        nextRun: getNextRunTime(),
      }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    // POST /test — manuelle Test-Notification (für Setup)
    if (request.method === 'POST' && url.pathname === '/test') {
      const count = await sendPushToAll(env, {
        title: "✅ Push funktioniert!",
        body: "Maya's Morning Brief ist verbunden. Du bekommst ab jetzt täglich Notifications!",
        tag: 'test'
      });
      return new Response(JSON.stringify({ ok: true, sent: count }), {
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    return new Response('Maya Brief Push Server 🌅', { headers: CORS });
  },

  // Cron Trigger — läuft zu den festgelegten Zeiten
  async scheduled(event, env, ctx) {
    const now = new Date(event.scheduledTime);
    // Konvertiere zu Berlin-Zeit (UTC+1/+2)
    const berlinHour = getBerlinHour(now);
    const berlinMin  = now.getUTCMinutes();

    console.log(`Cron fired at Berlin time: ${berlinHour}:${String(berlinMin).padStart(2,'0')}`);

    // Nachricht für diese Uhrzeit bestimmen
    let msg = PUSH_MESSAGES[berlinHour] || {
      title: "Maya's Morning Brief 🌅",
      body: "Dein Brief wurde aktualisiert!"
    };

    // Für 18:30 prüfen
    if (berlinHour === 18 && berlinMin >= 25) {
      msg = PUSH_MESSAGES[18];
    }

    const count = await sendPushToAll(env, { ...msg, tag: `brief-${berlinHour}` });
    console.log(`Sent ${count} push notifications`);
  }
};

// ── Push senden an alle gespeicherten Subscriptions ───────────────────
async function sendPushToAll(env, message) {
  const list = await env.SUBSCRIPTIONS.list();
  let count = 0;
  const failed = [];

  for (const key of list.keys) {
    const raw = await env.SUBSCRIPTIONS.get(key.name);
    if (!raw) continue;
    try {
      const { subscription } = JSON.parse(raw);
      const ok = await sendPush(subscription, message);
      if (ok) count++;
      else failed.push(key.name);
    } catch(e) {
      console.error('Failed to send to', key.name, e.message);
      failed.push(key.name);
    }
  }

  // Cleanup failed subscriptions (410 Gone = unsubscribed)
  for (const k of failed) {
    await env.SUBSCRIPTIONS.delete(k);
  }

  return count;
}

// ── Web Push senden (VAPID, RFC 8292) ────────────────────────────────
async function sendPush(subscription, payload) {
  const { endpoint, keys } = subscription;
  const { p256dh, auth } = keys;

  const expiration = Math.floor(Date.now() / 1000) + 43200; // 12h
  const vapidHeader = await buildVapidHeader(endpoint, expiration);

  const body = JSON.stringify({
    title: payload.title || "Maya's Morning Brief",
    body:  payload.body  || 'Neues Update verfügbar',
    tag:   payload.tag   || 'brief',
    url:   'https://parlative.github.io/maysbrief/'
  });

  // Encrypt payload
  const encrypted = await encryptPayload(body, p256dh, auth);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': vapidHeader,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
    },
    body: encrypted
  });

  if (response.status === 410 || response.status === 404) {
    console.log('Subscription expired:', endpoint.slice(-20));
    return false; // mark for deletion
  }

  return response.ok;
}

// ── VAPID JWT bauen ───────────────────────────────────────────────────
async function buildVapidHeader(endpoint, expiration) {
  const audience = new URL(endpoint).origin;

  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = { aud: audience, exp: expiration, sub: VAPID_SUBJECT };

  const toSign = [
    btoa(JSON.stringify(header)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'),
    btoa(JSON.stringify(claims)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'),
  ].join('.');

  const privKeyBytes = base64UrlDecode(VAPID_PRIVATE_KEY);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', privKeyBytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    new TextEncoder().encode(toSign)
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');

  const jwt = toSign + '.' + sigB64;
  const pubKey = VAPID_PUBLIC_KEY;

  return `vapid t=${jwt}, k=${pubKey}`;
}

// ── Payload Encryption (RFC 8188 / aes128gcm) ────────────────────────
async function encryptPayload(plaintext, p256dhB64, authB64) {
  const receiverPubKey = base64UrlDecode(p256dhB64);
  const authSecret     = base64UrlDecode(authB64);

  // Generate sender EC key pair
  const senderKey = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
  );

  const senderPubBytes = await crypto.subtle.exportKey('raw', senderKey.publicKey);

  // Import receiver key
  const receiverKey = await crypto.subtle.importKey(
    'raw', receiverPubKey,
    { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );

  // ECDH shared secret
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: receiverKey }, senderKey.privateKey, 256
  );

  // HKDF to derive content encryption key & nonce
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const ikm = await hkdf(authSecret, sharedBits, buildInfo('auth', new Uint8Array(0), new Uint8Array(0)), 32);
  const contentKey = await hkdf(salt, ikm, buildInfo('aesgcm128', new Uint8Array(senderPubBytes), receiverPubKey), 16);
  const nonce      = await hkdf(salt, ikm, buildInfo('nonce', new Uint8Array(senderPubBytes), receiverPubKey), 12);

  const key = await crypto.subtle.importKey('raw', contentKey, { name: 'AES-GCM' }, false, ['encrypt']);

  const encoded = new TextEncoder().encode(plaintext);
  // Padding: 2 bytes length + content + padding
  const padded = new Uint8Array(2 + encoded.length);
  padded[0] = 0; padded[1] = 0;
  padded.set(encoded, 2);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, padded
  );

  // aes128gcm content encoding header: salt(16) + rs(4) + keyid_len(1) + keyid
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);

  const keyId = new Uint8Array(senderPubBytes);
  const header = new Uint8Array(16 + 4 + 1 + keyId.length);
  header.set(salt, 0);
  header.set(rs, 16);
  header[20] = keyId.length;
  header.set(keyId, 21);

  const result = new Uint8Array(header.length + ciphertext.byteLength);
  result.set(header, 0);
  result.set(new Uint8Array(ciphertext), header.length);
  return result;
}

async function hkdf(salt, ikm, info, length) {
  const saltKey = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prk = await crypto.subtle.sign('HMAC', saltKey, ikm);
  const infoKey = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const t = new Uint8Array(info.length + 1);
  t.set(info); t[info.length] = 1;
  const okm = await crypto.subtle.sign('HMAC', infoKey, t);
  return new Uint8Array(okm).slice(0, length);
}

function buildInfo(type, senderPub, receiverPub) {
  const typeBytes = new TextEncoder().encode('Content-Encoding: ' + type + '\0');
  const info = new Uint8Array(typeBytes.length + 1 + 2 + senderPub.length + 2 + receiverPub.length);
  let offset = 0;
  info.set(typeBytes, offset); offset += typeBytes.length;
  info[offset++] = 0x41; // 'A' for P-256
  new DataView(info.buffer).setUint16(offset, senderPub.length, false); offset += 2;
  info.set(senderPub, offset); offset += senderPub.length;
  new DataView(info.buffer).setUint16(offset, receiverPub.length, false); offset += 2;
  info.set(receiverPub, offset);
  return info;
}

// ── Utilities ─────────────────────────────────────────────────────────
function base64UrlDecode(str) {
  const padding = '='.repeat((4 - str.length % 4) % 4);
  const b64 = (str + padding).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

async function hashEndpoint(endpoint) {
  const data = new TextEncoder().encode(endpoint);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,'0')).join('').slice(0, 32);
}

function getBerlinHour(utcDate) {
  // Berlin ist UTC+1 (Winter) / UTC+2 (Sommer)
  const month = utcDate.getUTCMonth() + 1;
  const isSummer = month >= 3 && month <= 10;
  return (utcDate.getUTCHours() + (isSummer ? 2 : 1)) % 24;
}

function getNextRunTime() {
  const times = [[0,0],[6,0],[12,0],[14,0],[16,0],[18,30]];
  const now = new Date();
  const cur = now.getHours()*60 + now.getMinutes();
  for (const [h,m] of times) {
    if (h*60+m > cur) return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')} Uhr`;
  }
  return '00:00 Uhr (nächster Tag)';
}
