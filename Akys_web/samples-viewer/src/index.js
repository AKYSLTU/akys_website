// src/index.js

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const bucket = env.SAMPLES;
    if (!bucket) {
      return json({ error: "R2 binding SAMPLES missing" }, 500);
    }

    const path = url.pathname;

    if (path.endsWith("/")) {
      const prefix = path === "/" ? "" : decodeURIComponent(path.slice(1));
      return renderIndex(bucket, prefix);
    }

    const key = decodeURIComponent(path.slice(1));
    return streamObject(bucket, key);
  },
};

// ---------- Helpers ----------

async function streamObject(bucket, key) {
  const obj = await bucket.get(key);
  if (!obj) {
    return json({ error: "Not found" }, 404);
  }

  const ext = key.split(".").pop().toLowerCase();
  const typeMap = {
    json: "application/json; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    mp4: "video/mp4",
    webm: "video/webm",
    avi: "video/x-msvideo",
    mov: "video/quicktime",
    zip: "application/zip",
  };

  const headers = new Headers();
  headers.set("Content-Type", typeMap[ext] || "application/octet-stream");
  if (ext === "html" || ext === "htm") {
    headers.set("Cache-Control", "public, max-age=300");
  } else {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }

  return new Response(obj.body, { headers });
}

async function listImmediate(bucket, prefix) {
  let cursor;
  const folders = new Set();
  const files = [];

  do {
    const page = await bucket.list({ prefix, delimiter: "/", cursor });
    for (const dir of page.delimitedPrefixes || []) {
      folders.add(dir);
    }
    for (const obj of page.objects || []) {
      files.push(obj);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return {
    folders: Array.from(folders).sort((a, b) => a.localeCompare(b)),
    files: files.sort((a, b) => a.key.localeCompare(b.key)),
  };
}

async function renderIndex(bucket, prefix) {
  const { folders, files } = await listImmediate(bucket, prefix);

  const rows = [];

  if (prefix) {
    const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    const lastSlash = trimmed.lastIndexOf("/");
    const parentPrefix = lastSlash === -1 ? "" : trimmed.slice(0, lastSlash + 1);
    const parentHref = encodePath(parentPrefix);
    rows.push(`
      <tr class="row-parent">
        <td class="cell-name">
          <span class="badge badge-dir">UP</span>
          <a class="link" href="${parentHref}">..</a>
        </td>
        <td class="cell-size">—</td>
        <td class="cell-date">—</td>
        <td class="cell-actions"></td>
      </tr>
    `);
  }

  for (const dirKey of folders) {
    const name = dirKey.slice(prefix.length);
    const href = encodePath(dirKey);
    rows.push(`
      <tr class="row-dir">
        <td class="cell-name">
          <span class="badge badge-dir">DIR</span>
          <a class="link" href="${href}">${escapeHtml(name)}</a>
        </td>
        <td class="cell-size">—</td>
        <td class="cell-date">—</td>
        <td class="cell-actions"><a class="btn ghost" href="${href}">Open</a></td>
      </tr>
    `);
  }

  for (const f of files) {
    if (f.key === prefix) continue;
    const name = f.key.slice(prefix.length);
    const href = encodePath(f.key);
    const sizeStr = formatBytes(f.size);
    const dateStr = formatDate(f.uploaded);
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    const typeBadge = badgeForExt(ext);

    rows.push(`
      <tr class="row-file">
        <td class="cell-name">
          ${typeBadge}
          <a class="link" href="${href}" target="_blank" rel="noopener noreferrer">${escapeHtml(name)}</a>
        </td>
        <td class="cell-size">${sizeStr}</td>
        <td class="cell-date">${dateStr}</td>
        <td class="cell-actions">
          <a class="btn ghost" href="${href}" target="_blank" rel="noopener noreferrer">View</a>
          <a class="btn" href="${href}" download>Download</a>
        </td>
      </tr>
    `);
  }

  const bodyHtml =
    rows.join("\n") ||
    `<tr><td colspan="4" class="empty">Nothing here yet.</td></tr>`;

  const titlePrefix = prefix || "/";
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>AKYS Samples — ${escapeHtml(titlePrefix)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 32px 16px 48px;
      font-family: "Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(120% 120% at 20% 20%, rgba(255,106,47,0.12), transparent), radial-gradient(100% 90% at 75% 0%, rgba(59,167,255,0.18), transparent), linear-gradient(140deg, #0b1224 0%, #060910 45%, #05070d 100%);
      color: #f7f9ff;
      min-height: 100vh;
    }
    a { color: inherit; text-decoration: none; }
    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 18px;
      flex-wrap: wrap;
      margin-bottom: 20px;
    }
    .header-main {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 240px;
      flex: 1 1 360px;
    }
    .header-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      flex: 0 1 auto;
    }
    .market-link {
      font-size: 13px;
      color: #b9c4e2;
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid transparent;
      transition: color 160ms ease, border-color 160ms ease, background 160ms ease;
    }
    .market-link:hover {
      color: #f7f9ff;
      border-color: rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.06);
    }
    .logo {
      width: 120px;
      height: auto;
      filter: drop-shadow(0 8px 30px rgba(255,106,47,0.35));
    }
    .title { margin: 0; font-size: 22px; font-weight: 800; }
    .subtitle { margin: 2px 0 0; color: #b9c4e2; font-size: 14px; }
    .path-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 10px;
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(255,255,255,0.06);
      color: #dfe8ff;
      font-size: 13px;
    }
    .table-wrap {
      overflow-x: auto;
      border-radius: 16px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(8,12,22,0.75);
      box-shadow: 0 20px 60px rgba(0,0,0,0.45);
    }
    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      min-width: 720px;
    }
    thead th {
      position: sticky;
      top: 0;
      text-align: left;
      padding: 14px 16px;
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #c9d4ee;
      background: rgba(11,16,30,0.9);
      backdrop-filter: blur(6px);
      border-bottom: 1px solid rgba(255,255,255,0.08);
      z-index: 2;
    }
    tbody td {
      padding: 14px 16px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      vertical-align: top;
      font-size: 14px;
      color: #e9efff;
    }
    tbody tr:hover {
      background: rgba(255,255,255,0.04);
    }
    tbody tr:last-child td {
      border-bottom: none;
    }
    .cell-name {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 280px;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .cell-size,
    .cell-date {
      white-space: nowrap;
      color: #c2ccdf;
      font-variant-numeric: tabular-nums;
    }
    .cell-actions {
      text-align: right;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      flex-wrap: wrap;
      white-space: nowrap;
    }
    .cell-actions .btn {
      min-width: 88px;
    }
    .link {
      color: inherit;
      text-decoration: none;
    }
    .btn {
      padding: 8px 12px;
      border-radius: 12px;
      background: linear-gradient(120deg, #ff9a5f, #ff6a2f);
      color: #0b0d16;
      font-weight: 700;
      border: none;
      text-align: center;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .btn.ghost {
      background: rgba(255,255,255,0.08);
      color: #f7f9ff;
      border: 1px solid rgba(255,255,255,0.1);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 11px;
      letter-spacing: 0.05em;
      font-weight: 800;
      width: fit-content;
    }
    .badge-dir { background: rgba(255,106,47,0.18); color: #ffb18a; }
    .badge-file { background: rgba(123,211,255,0.14); color: #aee4ff; }
    .badge-video { background: rgba(255,165,0,0.18); color: #ffd28a; }
    .badge-img { background: rgba(144,238,144,0.18); color: #c5ffcc; }
    .badge-doc { background: rgba(186,150,255,0.18); color: #e5d3ff; }
    .empty {
      text-align: center;
      color: #c3cce6;
    }
    .empty-title { margin: 0; font-size: 16px; font-weight: 700; color: #f7f9ff; }
    .empty-sub { margin: 4px 0 0; font-size: 13px; color: #b7c3d7; }
    @media (max-width: 720px) {
      body { padding: 24px 12px 40px; }
      .logo { width: 96px; }
      .title { font-size: 20px; }
      .subtitle { font-size: 13px; }
      table { min-width: 620px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-main">
      <a href="/" class="logo-link">
        <img class="logo" src="/AKYS_logo_transparent.png" alt="AKYS logo" />
      </a>
      <div>
        <h1 class="title">AKYS Samples</h1>
        <p class="subtitle">Fast preview & download of sample assets.</p>
        <div class="path-pill">Folder: ${escapeHtml(titlePrefix)}</div>
      </div>
    </div>
    <div class="header-actions">
      <a class="market-link" href="https://marketplace.akys.ai/samples">Back to Marketplace</a>
    </div>
  </header>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Size</th>
          <th>Modified</th>
          <th style="text-align:right;">Action</th>
        </tr>
      </thead>
      <tbody>
        ${bodyHtml}
      </tbody>
    </table>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatDate(date) {
  if (!date) return "—";
  try {
    return new Date(date).toISOString().slice(0, 10);
  } catch {
    return "—";
  }
}

function badgeForExt(ext) {
  if (!ext) return `<span class="badge badge-file">FILE</span>`;
  if (["mp4", "webm", "mov", "avi"].includes(ext)) return `<span class="badge badge-video">${ext.toUpperCase()}</span>`;
  if (["png", "jpg", "jpeg", "webp"].includes(ext)) return `<span class="badge badge-img">${ext.toUpperCase()}</span>`;
  if (["md", "txt", "csv", "json", "pdf"].includes(ext)) return `<span class="badge badge-doc">${ext.toUpperCase()}</span>`;
  return `<span class="badge badge-file">${ext.toUpperCase()}</span>`;
}

function encodePath(p) {
  if (!p) return "/";
  const trailing = p.endsWith("/") ? "/" : "";
  const encoded = p
    .split("/")
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return "/" + encoded + trailing;
}

function escapeHtml(str) {
  return (str || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c] || c));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
