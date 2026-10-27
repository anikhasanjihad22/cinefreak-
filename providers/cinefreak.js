/* ================================================================
 *  CineFreak  ->  Nuvio provider
 *  Flow:  TMDB(meta) -> cinefreak search-api.php -> post page
 *         -> new5.cinecloud.site/f/<id>  --POST a=play-->  direct URL
 *  Promise-only (no async/await) => runs on any Nuvio runtime.
 * ================================================================ */

var CF_BASE = "https://cinefreak.net";
var UA = "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

/* নিজের ফ্রি TMDB v3 key বসান: https://www.themoviedb.org/settings/api
   নিচেরটা কমিউনিটি key — rate limit করলে বদলে ফেলুন */
var TMDB_KEY = "439c478a771f35c05022f9feabcca01c";

/* ---------------- tiny http helpers ---------------- */
function req(url, o) {
  o = o || {};
  var h = {
    "User-Agent": UA,
    "Accept": o.accept || "text/html,application/json,*/*",
    "Accept-Language": "en-US,en;q=0.9"
  };
  if (o.referer) h["Referer"] = o.referer;
  if (o.headers) for (var k in o.headers) h[k] = o.headers[k];
  var opt = { method: o.method || "GET", headers: h };
  if (o.body) opt.body = o.body;
  return fetch(url, opt).then(function (r) { return r.text(); });
}
function asJson(t) { try { return JSON.parse(t); } catch (e) { return null; } }
function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function stripTags(x) {
  return x.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&")
          .replace(/&nbsp;/g, " ").replace(/&#0?39;/g, "'")
          .replace(/\s+/g, " ").trim();
}
function first(re, s, i) { var m = re.exec(s); return m ? (m[i || 1] || "") : ""; }

/* ---------------- 1. meta from TMDB ---------------- */
function getMeta(tmdbId, mediaType) {
  var type = mediaType === "tv" ? "tv" : "movie";
  return req("https://api.themoviedb.org/3/" + type + "/" + tmdbId + "?api_key=" + TMDB_KEY)
    .then(asJson)
    .then(function (j) {
      j = j || {};
      return {
        title: j.title || j.name || j.original_title || j.original_name || "",
        year: String(j.release_date || j.first_air_date || "").slice(0, 4)
      };
    })
    .catch(function () { return { title: "", year: "" }; });
}

/* ---------------- 2. find the best matching post ---------------- */
function findPost(meta, mediaType) {
  if (!meta.title) return Promise.resolve(null);
  var want = norm(meta.title);
  return req(CF_BASE + "/search-api.php?q=" + encodeURIComponent(meta.title),
             { accept: "application/json" })
    .then(asJson)
    .then(function (j) {
      var rows = (j && j.results) || [];
      var best = null, bestScore = -99;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i], t = norm(r.t), s = 0;
        if (t.indexOf(want) !== -1) s += 10;
        if (meta.year && String(r.t).indexOf(meta.year) !== -1) s += 6;
        if (mediaType === "tv") { if (/series|season|episode|k-drama/i.test(r.t)) s += 4; }
        else { if (/full movie/i.test(r.t)) s += 2; }
        if (/full-(movie|series)-download/.test(String(r.l))) s += 2;
        s -= i * 0.1;                       // উপরের রেজাল্ট আগে
        if (s > bestScore) { bestScore = s; best = r; }
      }
      return best ? { slug: best.l, title: best.t } : null;
    })
    .catch(function () { return null; });
}

/* ---------------- 3. scrape the post page ---------------- */
function collectWatch(html) {
  var out = [], seen = {}, re = /<a\b[^>]*>/gi, m;
  while ((m = re.exec(html))) {
    var tag = m[0];
    var href = first(/href="([^"]+)"/, tag) || "";
    var cls = first(/class="([^"]+)"/, tag) || "";
    if (!/dlbtn-watch/.test(cls)) continue;
    if (href.indexOf("cinecloud.site/f/") === -1) continue;
    if (seen[href]) continue;
    seen[href] = 1;
    out.push({ href: href, ctx: stripTags(html.slice(Math.max(0, m.index - 1800), m.index)) });
  }
  return out;
}

function scrapePost(postUrl, mediaType, season, episode) {
  return req(postUrl, { referer: CF_BASE + "/" }).then(function (html) {
    var links = collectWatch(html);
    var items = [];

    for (var i = 0; i < links.length; i++) {
      var ctx = links[i].ctx;

      var quality = first(/\b(4K|2160p|1440p|1080p|720p|576p|480p|360p)\b/i, ctx) || "HD";
      var size = first(/\b(\d+(?:\.\d+)?\s?(?:MB|GB))\b/i, ctx) || "";
      var epNum = parseInt(first(/\bEP\s*0*(\d{1,4})\b/i, ctx) || first(/\bEpisode\s*0*(\d{1,4})/i, ctx) || "0", 10);

      // লেবেল: কনটেক্সটের শেষ অংশ (যেমন "Moana (2026) [Hindi & English] SD 480p [580 MB]")
      var tail = ctx.slice(-160).replace(/^\S*\s*Download Links\s*/i, "").trim();
      if (!tail) tail = quality + (size ? " • " + size : "");
      var title = quality + (size ? " • " + size : "") + (epNum ? " • EP " + epNum : "");

      items.push({ href: links[i].href, title: title, quality: quality, ep: epNum });
    }

    /* সিরিজ হলে এপিসোড ফিল্টার */
    if (mediaType === "tv" && episode) {
      var want = parseInt(episode, 10);
      var hit = items.filter(function (x) { return x.ep === want; });
      if (hit.length) items = hit;
    }

    /* সিরিজে প্যাক-লিংক + এপিসোড লিংক মিক্স থাকলে ডুপ্লিকেট কোয়ালিটি বাদ */
    var uniq = {}, finalItems = [];
    for (var k = 0; k < items.length; k++) {
      var key = items[k].quality + "|" + items[k].ep;
      if (uniq[key]) continue;
      uniq[key] = 1;
      finalItems.push(items[k]);
    }

    return { postUrl: postUrl, items: finalItems };
  });
}

/* ---------------- 4. cinecloud -> direct url ---------------- */
function resolveCinecloud(pageUrl) {
  return req(pageUrl, { referer: CF_BASE + "/" }).then(function (html) {
    var csrf = first(/name="X-CSRF-TOKEN"\s+content="([^"]+)"/i, html);
    var body = "a=play" + (csrf ? "&X-CSRF-TOKEN=" + encodeURIComponent(csrf) : "");
    return req(pageUrl, {
      method: "POST",
      body: body,
      referer: pageUrl,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest"
      }
    });
  }).then(function (txt) {
    var j = asJson(txt);
    if (j && j.ok) {
      if (j.vlc) return j.vlc;    // ডিরেক্ট ফাইল / VLC url
      if (j.url) return j.url;    // প্লেয়ার url
    }
    return pageUrl;               // শেষ ভরসা: cinecloud পেজ
  }).catch(function () { return pageUrl; });
}

/* ---------------- 5. public entry point ---------------- */
function getStreams(tmdbId, mediaType, season, episode) {
  return getMeta(tmdbId, mediaType)
    .then(function (meta) { return findPost(meta, mediaType); })
    .then(function (post) {
      if (!post) return [];
      return scrapePost(CF_BASE + "/" + post.slug + "/", mediaType, season, episode);
    })
    .then(function (res) {
      if (!res || !res.items.length) return [];
      return Promise.all(res.items.map(function (it) {
        return resolveCinecloud(it.href).then(function (url) {
          return {
            name: "CineFreak",
            title: it.title,
            url: url,
            quality: it.quality,
            headers: { "User-Agent": UA, "Referer": CF_BASE + "/" }
          };
        });
      }));
    })
    .catch(function (e) {
      try { console.log("[CineFreak] " + e); } catch (x) {}
      return [];
    });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams: getStreams };
}
