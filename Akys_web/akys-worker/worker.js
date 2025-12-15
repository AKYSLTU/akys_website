/**
 * AKYS datasets worker
 * Cloudflare Worker (JavaScript) – R2 + KV + webhooks + gated downloads
 *
 * Bindings required (wrangler.toml):
 *  - R2  : DATASETS
 *  - KV  : TOKENS_KV
 *  - ENV : STRIPE_WEBHOOK_SECRET (string)
 *  - ENV : CRYPTO_WEBHOOK_SECRET (string)  // optional, if you use a crypto provider
 *
 * Routes:
 *  GET  /api/datasets
 *  GET  /r2/<key>
 *  POST /webhook/stripe
 *  POST /webhook/crypto
 *  GET  /claim?order=... | ?session_id=...
 *  GET  /download/<token>[?i=0]
 */

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get("origin") || "*";
    const url = new URL(req.url);
    console.log("request", { method: req.method, path: url.pathname, origin });

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

  if (url.pathname === "/api/health" && req.method === "GET") {
    return json({ ok: true, name: "akys-payments" }, 200, origin);
  }

    // --- Live catalog listing ---
    if (url.pathname === "/api/datasets" && req.method === "GET") {
      return listDatasets(url, env, origin);
    }

    // --- Private R2 proxy (thumbnails / small files) ---
    if (url.pathname.startsWith("/r2/") && req.method === "GET") {
      const key = decodeURIComponent(url.pathname.slice(4)); // after /r2/
      return proxyR2(key, env, origin);
    }

    // --- Token claim after checkout success (Stripe/crypto) ---
  if (url.pathname === "/claim" && req.method === "GET") {
    return claimTokens(url, env, origin);
  }

    // --- Gated download link ---
    if (url.pathname.startsWith("/download/") && req.method === "GET") {
      const tokenId = url.pathname.split("/").pop();
      const idx = url.searchParams.get("i"); // optional index if token maps to multiple keys
      return gatedDownload(tokenId, idx, env, origin);
    }

    // --- Webhooks ---
    if (
      (url.pathname === "/webhook/stripe" || url.pathname === "/api/stripe-webhook") &&
      req.method === "POST"
    ) {
      return stripeWebhook(req, env);
    }
    if (url.pathname === "/webhook/crypto" && req.method === "POST") {
      return cryptoWebhook(req, env);
    }

    if (url.pathname === "/api/create-checkout-session" && req.method === "POST") {
      return createCheckoutSession(req, env, origin);
    }

    // Default OK
    return new Response("OK", { status: 200, headers: corsHeaders(origin) });
  }
};

// ========================= Handlers =========================

async function listDatasets(url, env, origin) {
  const out = [];
  let cursor;

  do {
    const page = await env.DATASETS.list({ prefix: "ready/", delimiter: "/", cursor });
    for (const p of page.delimitedPrefixes || []) {
      const id = p.replace(/^ready\//, "").replace(/\/$/, "");

      // dataset_info.json (optional metadata)
      let info = {};
      const infoObj = await env.DATASETS.get(`${p}dataset_info.json`);
      if (infoObj) { try { info = await infoObj.json(); } catch { /* ignore */ } }

      // optional front/rear info files (prefer explicit zip keys)
      let infoFront = {};
      let infoRear = {};
      const infoFrontObj = await env.DATASETS.get(`${p}dataset_info_front.json`);
      if (infoFrontObj) { try { infoFront = await infoFrontObj.json(); } catch { /* ignore */ } }
      const infoRearObj = await env.DATASETS.get(`${p}dataset_info_rear.json`);
      if (infoRearObj) { try { infoRear = await infoRearObj.json(); } catch { /* ignore */ } }

      const pickZipKey = (...objs) => {
        for (const o of objs) {
          if (!o || typeof o !== "object") continue;
          const val =
            o.zip_key ||
            o.zipKey ||
            o.storage_zip_key ||
            o.storageZipKey ||
            o.r2_key ||
            o.r2Key ||
            o.zip ||
            o.zipPath ||
            o.zipFile ||
            o.zipFilename ||
            o.zip_name;
          if (typeof val === "string" && val.trim()) {
            return val.trim();
          }
        }
        return null;
      };

      const zipKey =
        pickZipKey(info, infoFront, infoRear) ||
        (id ? `private/${id}.zip` : null);

      // pick thumbnail
      const preferred = [`${p}screenshots/cover.jpg`, `${p}screenshots/cover.png`, `${p}screenshots/cover.webp`];
      let thumbKey = null;
      for (const k of preferred) {
        if (await env.DATASETS.head(k)) { thumbKey = k; break; }
      }
      if (!thumbKey) {
        const shots = await env.DATASETS.list({ prefix: `${p}screenshots/` });
        const first = (shots.objects || []).find(o => /\.(jpg|jpeg|png|webp)$/i.test(o.key));
        if (first) thumbKey = first.key;
      }
      const thumb = thumbKey ? url.origin + "/r2/" + encodeURIComponent(thumbKey) : null;

      out.push({
        id,
        title: info.title || id,
        city: info.city || "",
        tags: info.tags || [],
        minutes: info.minutes ?? null,
        size: info.size ?? null,
        price: info.price ?? null,
        zip_key: zipKey,
        r2_key: zipKey,
        thumb,
        prefix: p,
        hasReadme: Boolean(await env.DATASETS.head(`${p}README.md`)),
        hasManifest: Boolean(await env.DATASETS.head(`${p}manifest.json`))
      });
    }
    cursor = page.cursor;
  } while (cursor);

  const headers = {
    ...corsHeaders(origin),
    "cache-control": "public, max-age=60, s-maxage=600, stale-while-revalidate=86400",
    "cdn-cache-control": "public, max-age=600"
  };
  return new Response(JSON.stringify(out), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...headers
    }
  });
}

async function proxyR2(key, env, origin) {
  const obj = await env.DATASETS.get(key);
  if (!obj) return new Response("Not found", { status: 404, headers: corsHeaders(origin) });

  const h = new Headers();
  h.set("content-type", guessType(key));
  if (/\.(jpg|jpeg|png|webp)$/i.test(key)) {
    h.set("cache-control", "public, max-age=3600");
  }
  const merged = new Headers({ ...corsHeaders(origin) });
  for (const [k, v] of h.entries()) merged.set(k, v);
  return new Response(obj.body, { headers: merged });
}

async function claimTokens(url, env, origin) {
  const sessionId = url.searchParams.get("session_id");
  const order = url.searchParams.get("order");
  if (!sessionId && !order) return json({ error: "Missing order or session_id" }, 400, origin);

  const tokens = [];

  if (sessionId) {
    const sessionKey = `session:${sessionId}`;
    const sessionTokens = await env.TOKENS_KV.get(sessionKey, { type: "json" });
    if (Array.isArray(sessionTokens)) {
      tokens.push(...sessionTokens);
    }
  }

  if (tokens.length === 0 && order) {
    const idxKey = `ord_${order}`;
    const index = await env.TOKENS_KV.get(idxKey, { type: "json" });
    if (Array.isArray(index)) {
      for (const tkId of index) {
        const tokenObj = await env.TOKENS_KV.get(tkId, { type: "json" });
        if (!tokenObj) continue;
        const left = (tokenObj.maxDownloads ?? 1) - (tokenObj.downloads ?? 0);
        tokens.push({
          token: tkId,
          r2_key: tokenObj.keys?.[0] || "",
          title: tokenObj.title || "",
          downloadsLeft: Math.max(left, 0),
          url: url.origin + "/download/" + tkId
        });
      }
    }
  }

  return json({ tokens }, 200, origin);
}

async function gatedDownload(tokenId, i, env, origin) {
  const token = await env.TOKENS_KV.get(tokenId, { type: "json" });
  if (!token) return new Response("Link expired or invalid", { status: 410, headers: corsHeaders(origin) });

  // pick key (single-file tokens recommended; otherwise ?i=)
  const idx = Number.isInteger(Number(i)) ? Number(i) : 0;
  const key = token.keys?.[idx];
  if (!key) return new Response("Invalid file index", { status: 400, headers: corsHeaders(origin) });

  // enforce usage
  const used = token.downloads ?? 0;
  const max = token.maxDownloads ?? 1;
  if (used >= max) return new Response("Download limit reached", { status: 410, headers: corsHeaders(origin) });

  const obj = await env.DATASETS.get(key);
  if (!obj) return new Response("File not found", { status: 404, headers: corsHeaders(origin) });

  // bump counter (best-effort)
  token.downloads = used + 1;
  await env.TOKENS_KV.put(tokenId, JSON.stringify(token), { expirationTtl: token.ttl ?? 86400 });

  const filename = basename(key);
  const h = new Headers();
  h.set("content-type", guessType(key));
  h.set("content-disposition", `attachment; filename="${filename}"`);
  const merged = new Headers({ ...corsHeaders(origin) });
  for (const [k, v] of h.entries()) merged.set(k, v);
  return new Response(obj.body, { headers: merged });
}

async function stripeWebhook(req, env) {
  const origin = "*";
  // raw body for signature verification
  const bodyBuf = await req.arrayBuffer();
  const sig = req.headers.get("stripe-signature");
  if (!sig || !env.STRIPE_WEBHOOK_SECRET) {
    return new Response("Missing signature or secret", { status: 400, headers: corsHeaders(origin) });
  }
  // Verify per Stripe spec: signed_payload = t + '.' + raw_body
  const { valid, payload } = await verifyStripeSignature(sig, bodyBuf, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return new Response("Invalid signature", { status: 400, headers: corsHeaders(origin) });

  const evt = JSON.parse(payload);
  if (evt.type === "checkout.session.completed") {
    const session = evt.data.object;
    const orderId = session.metadata?.order_id;
    if (orderId) {
      try {
        const orderRow = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
        if (orderRow) {
          let parsed = [];
          try { parsed = JSON.parse(orderRow.items_json || "[]"); } catch { parsed = []; }
          const keys = [];
          for (const it of parsed) {
            const k = it?.r2_key;
            const qty = Math.min(99, Math.max(1, Number(it?.qty) || 1));
            if (k) {
              for (let i = 0; i < qty; i++) keys.push(k);
            }
          }
          if (keys.length > 0) {
            const tokenId = `tk_${cryptoRandom(24)}`;
            const tokenData = {
              keys,
              ttl: 72 * 3600,
              maxDownloads: 3,
              downloads: 0,
              orderId: orderId,
              buyerEmail: session.customer_details?.email || session.customer_email || ""
            };
            await env.TOKENS_KV.put(tokenId, JSON.stringify(tokenData), { expirationTtl: tokenData.ttl });
            await env.DB.prepare("UPDATE orders SET status = ? WHERE id = ?").bind("paid", orderId).run();
            const idxKey = `ord_${session.id}`;
            const existing = await env.TOKENS_KV.get(idxKey, { type: "json" }) || [];
            existing.push(tokenId);
            await env.TOKENS_KV.put(idxKey, JSON.stringify(existing), { expirationTtl: tokenData.ttl });
            return new Response("ok", { status: 200, headers: corsHeaders(origin) });
          }
        }
      } catch (err) {
        // fall through to legacy handling
      }
    }

    let keys = [];
    const itemsJson = session.metadata?.items_json;
    if (itemsJson) {
      try {
        const parsed = JSON.parse(itemsJson);
        for (const it of parsed) {
          const key = it?.storage_zip_key || it?.r2_key;
          const qty = Math.min(99, Math.max(1, Number(it?.qty) || 1));
          if (key) {
            for (let i = 0; i < qty; i++) keys.push(key);
          }
        }
      } catch (err) {
        console.error("items_json parse failed", err);
      }
    }
    const metaKeys = session.metadata?.r2_keys || session.metadata?.keys;
    if (metaKeys) {
      keys = keys.concat(metaKeys.split("|").map(s => s.trim()).filter(Boolean));
    }
    if (keys.length === 0 && session.metadata?.r2_key) {
      const key = session.metadata.r2_key.trim();
      if (key) keys = [key];
    }
    if (keys.length === 0) {
      let key = session.metadata?.r2_key?.trim();
      if (!key) {
        const bundleId = session.metadata?.bundle_id?.trim();
        const datasetId = session.metadata?.dataset_id?.trim();
        if (bundleId) {
          key = `private/bundles/${bundleId}.zip`;
        } else if (datasetId) {
          key = `private/${datasetId}.zip`;
        }
      }
      if (!key) {
        return new Response("Missing metadata (keys/r2_key/dataset_id/bundle_id)", { status: 400, headers: corsHeaders(origin) });
      }
      keys = [key];
    }

    const tokens = [];
    for (const key of keys) {
      const tokenId = `tk_${cryptoRandom(24)}`;
      const tokenData = {
        keys: [key],
        ttl: 72 * 3600,          // 72h validity
        maxDownloads: 3,
        downloads: 0,
        orderId: session.id,
        title: "",
        buyerEmail: session.customer_details?.email || session.customer_email || ""
      };
      await env.TOKENS_KV.put(tokenId, JSON.stringify(tokenData), { expirationTtl: tokenData.ttl });
      tokens.push({
        token: tokenId,
        r2_key: key,
        title: tokenData.title,
        downloadsLeft: tokenData.maxDownloads,
        url: `${session.metadata?.base_url || ""}/download/${tokenId}`
      });
    }

    // Index by order for /claim
    const idxKey = `ord_${session.id}`;
    const existing = await env.TOKENS_KV.get(idxKey, { type: "json" }) || [];
    existing.push(...tokens.map(t => t.token));
    await env.TOKENS_KV.put(idxKey, JSON.stringify(existing), { expirationTtl: 72 * 3600 });

    // Store session namespace for direct lookup
    await env.TOKENS_KV.put(`session:${session.id}`, JSON.stringify(tokens), { expirationTtl: 72 * 3600 });
  }

  return new Response("ok", { status: 200, headers: corsHeaders(origin) });
}

async function cryptoWebhook(req, env) {
  const origin = "*";
  // Adjust to your crypto provider (0xProcessing, etc.)
  const body = await req.text();
  const sig = req.headers.get("x-akys-crypto-signature");
  if (!env.CRYPTO_WEBHOOK_SECRET) return new Response("Secret missing", { status: 400, headers: corsHeaders(origin) });

  // Simple HMAC-SHA256 verification
  const valid = await verifyHmac(body, env.CRYPTO_WEBHOOK_SECRET, sig);
  if (!valid) return new Response("Invalid signature", { status: 400, headers: corsHeaders(origin) });

  const evt = JSON.parse(body);
  if (evt.type === "payment.confirmed") {
    const orderId = evt.data.order_id;
    const email = evt.data.buyer?.email || "";
    const prefixes = (evt.data.metadata?.prefixes || "")
      .split(",").map(s => s.trim()).filter(Boolean);

    const keys = prefixes.map(p => `${ensureTrailingSlash(p)}bundle.zip`);

    const tokenId = `tk_${cryptoRandom(24)}`;
    const tokenData = {
      keys,
      ttl: 72 * 3600,
      maxDownloads: 3,
      downloads: 0,
      orderId,
      buyerEmail: email
    };
    await env.TOKENS_KV.put(tokenId, JSON.stringify(tokenData), { expirationTtl: tokenData.ttl });

    const idxKey = `ord_${orderId}`;
    const existing = await env.TOKENS_KV.get(idxKey, { type: "json" }) || [];
    existing.push(tokenId);
    await env.TOKENS_KV.put(idxKey, JSON.stringify(existing), { expirationTtl: tokenData.ttl });
  }

  return new Response("ok", { status: 200 });
}

// ========================= Helpers =========================

async function createCheckoutSession(req, env, origin) {
  let body;
  try {
    body = await req.json();
  } catch (err) {
    console.error("create-checkout parse error", err);
    return json({ error: "Invalid JSON body" }, 400, origin);
  }
  const email = (body.email || "").trim();
  const success_url = (body.success_url || "").trim();
  const cancel_url = (body.cancel_url || "").trim();
  const itemsInput = Array.isArray(body.items) ? body.items : [];

  if (!success_url || !cancel_url || itemsInput.length === 0) {
    console.error("create-checkout validation failed", { success_url, cancel_url, items: itemsInput.length });
    return json({ error: "Invalid payload" }, 400, origin);
  }

  const items = [];
  const missing = [];
  let totalQty = 0;

  for (const raw of itemsInput) {
    const title = (raw?.title || "AKYS Dataset").trim();
    const datasetId = (raw?.dataset_id || "").trim();
    let storageKey = (raw?.zip_key || raw?.storage_zip_key || raw?.r2_key || "").trim();
    const priceEur = Number(raw?.price_eur ?? raw?.unit_price_eur) || 0;
    const qty = Math.min(99, Math.max(1, Number(raw?.quantity ?? raw?.qty) || 1));
    if (!storageKey && datasetId) {
      storageKey = `private/${datasetId}.zip`;
      console.warn("zip_key missing; falling back to dataset_id-derived key", { datasetId, storageKey });
    }
    if (storageKey && (!storageKey.startsWith("private/") || !storageKey.endsWith(".zip"))) {
      console.error("zip_key invalid format", { datasetId, storageKey });
      return json({ error: "Invalid zip_key format. Expect private/<file>.zip" }, 400, origin);
    }
    if (!storageKey || priceEur <= 0) {
      console.error("create-checkout invalid item", { title, datasetId, storageKey, priceEur, qty });
      return json({ error: "Invalid item data (zip_key and price required)" }, 400, origin);
    }
    items.push({
      title,
      dataset_id: datasetId,
      storage_zip_key: storageKey,
      unit_amount_cents: Math.round(priceEur * 100),
      qty
    });
    totalQty += qty;
  }

  for (const it of items) {
    const head = await env.DATASETS.head(it.storage_zip_key);
    if (!head) missing.push({ dataset_id: it.dataset_id, key: it.storage_zip_key });
  }
  if (missing.length > 0) {
    console.error("create-checkout missing datasets", missing);
    return json(
      { error: "Dataset not found", missing, hint: "Check storage_zip_key in dataset config" },
      404,
      origin
    );
  }

  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", success_url);
  params.set("cancel_url", cancel_url);
  params.set("metadata[purchase_count_minutes]", String(totalQty));
  params.set("metadata[items_json]", JSON.stringify(items.map(i => ({
    title: i.title,
    storage_zip_key: i.storage_zip_key,
    qty: i.qty
  }))));
  if (email) params.set("customer_email", email);

  items.forEach((it, idx) => {
    params.set(`line_items[${idx}][price_data][currency]`, "eur");
    params.set(`line_items[${idx}][price_data][product_data][name]`, it.title || "AKYS Dataset");
    params.set(`line_items[${idx}][price_data][unit_amount]`, String(it.unit_amount_cents));
    params.set(`line_items[${idx}][quantity]`, String(it.qty));
    if (it.dataset_id) {
      params.set(`line_items[${idx}][price_data][product_data][metadata][dataset_id]`, it.dataset_id);
    }
  });

  const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params
  });

  const session = await stripeRes.json();

  if (!session.url) {
    console.error("stripe session create failed", session);
    return json({ error: "Stripe session failed", details: session }, 500, origin);
  }

  return json({
    url: session.url,
    session_id: session.id
  }, 200, origin);
}

function corsHeaders(origin) {
  const allowedOrigins = ["https://marketplace.akys.ai", "http://localhost:3000", "http://127.0.0.1:3000"];
  const allowed = origin && allowedOrigins.includes(origin) ? origin : "https://marketplace.akys.ai";
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400"
  };
}

function json(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(origin ? corsHeaders(origin) : { "access-control-allow-origin": "*" })
    }
  });
}

function discountRate(count) {
  if (count >= 1000) return 0.20;
  if (count >= 300) return 0.18;
  if (count >= 100) return 0.15;
  if (count >= 30) return 0.10;
  if (count >= 10) return 0.05;
  return 0;
}

function basename(k) { return k.split("/").pop(); }
function ensureTrailingSlash(s) { return s.endsWith("/") ? s : s + "/"; }

function guessType(k) {
  const L = k.toLowerCase();
  if (L.endsWith(".zip")) return "application/zip";
  if (L.endsWith(".mp4")) return "video/mp4";
  if (L.endsWith(".json")) return "application/json";
  if (L.endsWith(".md") || L.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (L.endsWith(".jpeg") || L.endsWith(".jpg")) return "image/jpeg";
  if (L.endsWith(".png")) return "image/png";
  if (L.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

function cryptoRandom(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  // base36-ish
  return Array.from(a).map(b => b.toString(36).padStart(2, "0")).join("").slice(0, n);
}

// Stripe signature verification (per docs)
async function verifyStripeSignature(header, bodyBuf, secret) {
  // header like: t=1690000000,v1=hexsig,...
  const m = /t=(\d+),.*v1=([a-f0-9]+)/i.exec(header || "");
  if (!m) return { valid: false, payload: "" };
  const ts = m[1];
  const sig = m[2];
  const encoder = new TextEncoder();
  const signedPayload = `${ts}.` + new TextDecoder().decode(bodyBuf);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));
  const macHex = buf2hex(mac);
  const valid = timingSafeEqual(macHex, sig);
  return { valid, payload: signedPayload.split(".").slice(1).join(".") };
}

async function verifyHmac(payload, secret, provided) {
  if (!provided) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const macHex = buf2hex(mac);
  return timingSafeEqual(macHex, provided);
}

function buf2hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
