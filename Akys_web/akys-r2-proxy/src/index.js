export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Cache-Control",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // LIST
    if (request.method === "GET" && pathname === "/r2/api/datasets") {
      return await handleListDatasets(env, corsHeaders);
    }

    // METADATA BY SLUG
    if (request.method === "GET" && pathname.startsWith("/r2/api/metadata/")) {
      const raw = pathname.replace("/r2/api/metadata/", "");
      const slug = decodeURIComponent(raw);           // keep full slug with Lithuanian letters
      return await handleMetadata(env, slug, corsHeaders);
    }

    // STATIC READY OBJECTS
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      pathname.startsWith("/r2/ready/")
    ) {
      return await handleStaticReady(
        env,
        pathname,
        corsHeaders,
        request.method === "HEAD",
      );
    }

    // Everything else → 404
    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};

async function handleListDatasets(env, corsHeaders) {
  // List subdirectories directly under "ready/"
  const list = await env.DATASETS.list({
    prefix: "ready/",
    delimiter: "/",
  });

  const prefixes = list.delimitedPrefixes || [];
  const items = [];

  for (const entry of prefixes) {
    const prefix = typeof entry === "string" ? entry : entry.prefix;
    if (!prefix) continue;

    // "ready/<slug>/" → "<slug>"
    const slug = prefix.replace(/^ready\//, "").replace(/\/$/, "");

    // Load public metadata (preferred) or legacy front/rear metadata
    const [publicObj, frontObj, rearObj, screenshotsList] = await Promise.all([
      env.DATASETS.get(`ready/${slug}/dataset_public.json`),
      env.DATASETS.get(`ready/${slug}/dataset_info_front.json`),
      env.DATASETS.get(`ready/${slug}/dataset_info_rear.json`),
      env.DATASETS.list({ prefix: `ready/${slug}/screenshots/` }),
    ]);

    let front = null;
    let rear = null;
    if (publicObj) {
      front = await parsePublicInfo(publicObj);
    } else {
      if (frontObj) front = JSON.parse(await frontObj.text());
      if (rearObj) rear = JSON.parse(await rearObj.text());
    }

    if (!front && !rear) continue;

    // Take a couple of screenshots as samples
    const screenshotObjs = (screenshotsList.objects || []).slice(0, 4);
    const screenshots = screenshotObjs.map((obj) => {
      const key = obj.key; // e.g. "ready/<slug>/screenshots/file.jpg"
      const filename = key.split("/").pop();
      return `https://akys.ai/r2/ready/${encodeURIComponent(slug)}/screenshots/${encodeURIComponent(filename)}`;
    });

    // Extract simple summary fields (use front if available, otherwise rear)
    const info = front || rear || {};
    const city = info.city || {};
    const weather = info.weather || {};

    const date = info.date || null;
    const road = city.road || null;
    const cityName = city.city || null;
    const countryCode = city.country_code || null;

    // Time-of-day & weather label for filters
    const timeOfDay =
      typeof weather.is_day === "number"
        ? weather.is_day === 1
          ? "day"
          : "night"
        : info.time_of_day || null;
    const weatherSummary = weather.summary || null;

    // Duration in minutes from metadata
    const durationMinutes =
      typeof info.video_duration_s === "number"
        ? Math.round(info.video_duration_s / 60)
        : typeof info.duration_s === "number"
        ? Math.round(info.duration_s / 60)
        : 1;

    items.push({
      slug,
      date,
      road,
      city: cityName,
      countryCode,
      timeOfDay,
      weather: weatherSummary,
      durationMinutes,
      hasFront: !!front || !!frontObj,
      hasRear: !!rear || /F\+R/i.test(slug),
      screenshots,
      price_eur: info?.price_eur ?? null,
      tier: info?.tier || null,
      batch_name: info?.batch_name || null,
      batch_slug: info?.batch_slug || null,
    });
  }

  return new Response(JSON.stringify({ items }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

async function handleMetadata(env, slug, corsHeaders) {
  if (!slug || !slug.trim()) {
    return new Response("Bad request", {
      status: 400,
      headers: corsHeaders,
    });
  }

  const cleanSlug = slug.trim();

  const [publicObj, frontObj, rearObj, screenshotsList] = await Promise.all([
    env.DATASETS.get(`ready/${cleanSlug}/dataset_public.json`),
    env.DATASETS.get(`ready/${cleanSlug}/dataset_info_front.json`),
    env.DATASETS.get(`ready/${cleanSlug}/dataset_info_rear.json`),
    env.DATASETS.list({ prefix: `ready/${cleanSlug}/screenshots/` }),
  ]);

  let front = null;
  let rear = null;

  if (publicObj) {
    front = await parsePublicInfo(publicObj);
  } else {
    if (frontObj) front = JSON.parse(await frontObj.text());
    if (rearObj) rear = JSON.parse(await rearObj.text());
  }

  if (!front && !rear) {
    return new Response("Not found", {
      status: 404,
      headers: corsHeaders,
    });
  }

  const screenshots = (screenshotsList.objects || []).map((obj) => {
    const key = obj.key;
    const filename = key.split("/").pop();
    return `https://akys.ai/r2/ready/${encodeURIComponent(cleanSlug)}/screenshots/${encodeURIComponent(filename)}`;
  });

  const body = {
    slug: cleanSlug,
    infos: { front, rear },
    screenshots,
    price_eur: front?.price_eur || rear?.price_eur || null,
    tier: front?.tier || rear?.tier || null,
    batch_name: front?.batch_name || rear?.batch_name || null,
    batch_slug: front?.batch_slug || rear?.batch_slug || null,
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

async function parsePublicInfo(publicObj) {
  try {
    const raw = JSON.parse(await publicObj.text());
    const location = raw.location || {};
    const weatherRaw = raw.weather || {};
    const bboxCounts = raw.bbox_counts || {};
    const numDetections = Object.values(bboxCounts).reduce((acc, v) => {
      const n = Number(v);
      return acc + (Number.isFinite(n) ? n : 0);
    }, 0);

    const classCandidates = Array.isArray(raw.objects_present) ? raw.objects_present : [];
    const sceneTags = Array.isArray(raw.scene_tags) ? raw.scene_tags : [];
    const weatherTags = Array.isArray(weatherRaw.tags) ? weatherRaw.tags : [];
    const classes = Array.from(
      new Set(
        classCandidates
          .map((c) => c.replace(/_present$/i, "").replace(/_/g, " "))
          .concat(sceneTags)
          .concat(weatherTags),
      ),
    );

    const isDayFromTime =
      typeof raw.time_of_day === "string"
        ? ["night", "evening", "late_evening", "dawn"].includes(raw.time_of_day.toLowerCase())
          ? 0
          : 1
        : undefined;

    return {
      ...raw,
      date: raw.date || null,
      location_most_frequent_ref: raw.location_most_frequent_ref || location.road || location.city || "",
      city: {
        road: location.road || null,
        city: location.city || null,
        state: location.state || null,
        country: location.country || null,
        country_code: location.country_code || null,
      },
      weather: {
        summary: weatherRaw.summary || null,
        temp_c: weatherRaw.temp_c,
        is_day: typeof weatherRaw.is_day === "number" ? weatherRaw.is_day : isDayFromTime,
      },
      video_duration_s:
        typeof raw.video_duration_s === "number"
          ? raw.video_duration_s
          : typeof raw.duration_s === "number"
          ? raw.duration_s
          : null,
      num_detections: numDetections || null,
      classes,
      price_eur: typeof raw.price_eur === "number" ? raw.price_eur : null,
      tier: raw.tier || null,
      batch_name: raw.batch_name || null,
      batch_slug: raw.batch_slug || null,
    };
  } catch (err) {
    console.error("parsePublicInfo failed", err);
    return null;
  }
}

async function handleStaticReady(env, pathname, corsHeaders, isHead = false) {
  const rawKey = pathname.replace(/^\/r2\//, "");
  // Decode to match the raw object keys stored in R2 (slugs contain + and unicode)
  const key = decodeURIComponent(rawKey);

  if (key.endsWith(".zip")) {
    return new Response("Forbidden", { status: 403, headers: corsHeaders });
  }

  let obj = await env.DATASETS.get(key);
  // Fallback to the raw key in case objects were uploaded with encoded path segments
  if (!obj && rawKey !== key) {
    obj = await env.DATASETS.get(rawKey);
  }
  if (!obj) {
    return new Response("Not found", { status: 404, headers: corsHeaders });
  }

  const headers = {
    ...corsHeaders,
    "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
  };
  return new Response(isHead ? null : obj.body, { status: 200, headers });
}
