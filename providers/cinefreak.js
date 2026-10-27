/* ================================================================
 *  CineFreak  ->  Nuvio provider  (v1.1)
 *  TMDB(meta) -> cinefreak search -> post page -> cinecloud /f/<id>
 *  --POST a=play--> direct file URL
 * ================================================================ */

var CF_BASE = "https://cinefreak.net";
var UA = "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
var TMDB_KEY = "439c478a771f35c05022f9feabcca01c"; // নিজের key বসাতে পারেন

function req(url, o) {
  o = o || {};
  var h = { "User-Agent": UA, "Accept": o.accept || "text/html,application/json,*/*",
            "Accept-Language": "en-US,en;q=0.9" };
  if (o.referer) h["Referer"] = o.referer;
  if (o.headers) for (var k in o.headers) h[k] = o.headers[k];
  var opt = { method: o.method || "GET", headers: h };
  if (o.body) opt.body = o.body;
  return fetch(url, opt).then(function (r) { return r.text(); });
}
function asJson(t) { try { return JSON.parse(t); } catch (e) { return null; } }
function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function stripTags(x) {
  return x.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
          .replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim();
}
function first(re, s, i) { var m = re.exec(s); return m ? (m[i || 1] || "") : ""; }

/* ---------- 1. TMDB meta ---------- */
function getMeta(tmdbId, mediaType) {
  var type = mediaType === "tv" ? "tv" : "movie";
  return req("https://api.themoviedb.org/3/" + type + "/" + tmdbId + "?api_key=" + TMDB_KEY)
    .then(asJson)
    .then(function (j) {
      j = j || {};
      return { title: j.title || j.name || j.original_title || j.original_name || "",
               year: String(j.release_date || j.first_air_date || "").slice(0, 4) };
    })
    .catch(function () { return { title: "", year: "" }; });
}

/* ---------- 2. সঠিক পোস্ট খোঁজা ---------- */
function findPost(meta, mediaType) {
  if (!meta.title) return Promise.resolve(null);
  var want = norm(meta.title);
  return req(CF_BASE + "/search-api.php?q=" + encodeURIComponent(meta.title), { accept: "application/json" })
    .then(asJson)
    .then(function (j) {
      var rows = (j && j.results) || [], best = null, bestScore = -99;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i], t = norm(r.t), s = 0;
        if (t.indexOf(want) !== -1) s += 10;
        if (meta.year && String(r.t).indexOf(meta.year) !== -1) s += 6;
        if (mediaType === "tv") { if (/series|season|episode|k-drama/i.test(r.t)) s += 4; }
        else { if (/full movie/i.test(r.t)) s += 2; }
        if (/full-(movie|series)-download/.test(String(r.l))) s += 2;
        s -= i * 0.1;
        if (s > bestScore) { bestScore = s; best = r; }
      }
      return best ? { slug: best.l, title: best.t } : null;
    })
    .catch(function () { return null; });
}

/* ---------- 3. পেজ স্ক্র্যাপ ---------- */
function labelFor(html, at) {
  var slice = html.slice(Math.max(0, at - 5000), at);
  var re = /<[a-z]+[^>]*class="[^"]*(?:movie-title|ep-title|ep-card|episode-title)[^"]*"[^>]*>/gi;
  var m, last = -1;
  while ((m = re.exec(slice))) last = m.index;
  return stripTags(last === -1 ? slice.slice(-700) : slice.slice(last));
}

function pickQuality(s) {
  var m = /(2160p|4k|1440p|1080p|720p|576p|480p|360p)/i.exec(s);
  if (!m) return "HD";
  var q = m[1].toLowerCase();
  return q === "4k" ? "2160p" : q;
}

function collectWatch(html) {
  var out = [], re = /<a\b[^>]*>/gi, m;
  while ((m = re.exec(html))) {
    var tag = m[0];
    var href = first(/href="([^"]+)"/, tag) || "";
    var cls = first(/class="([^"]+)"/, tag) || "";
    if (href.indexOf("cinecloud.site/f/") === -1) continue;
    if (!/watch/i.test(cls) || /download/i.test(cls)) continue;
    out.push({ href: href, at: m.index });
  }
  return out;
}

function scrapePost(postUrl, mediaType, season, episode) {
  return req(postUrl, { referer: CF_BASE + "/" }).then(function (html) {
    var links = collectWatch(html), items = [], seen = {};

    for (var i = 0; i < links.length; i++) {
      if (seen[links[i].href]) continue;
      seen[links[i].href] = 1;

      var label = labelFor(html, links[i].at);
      var quality = pickQuality(label);
      var size = first(/\b(\d+(?:\.\d+)?\s?(?:MB|GB|TB))\b/i, label) || "";
      var codec = /hevc|x265|10bit|10-bit/i.test(label) ? "HEVC" : "";
      var epNum = parseInt(first(/\bEP\s*0*(\d{1,4})\b/i, label) ||
                           first(/\bEpisode\s*0*(\d{1,4})/i, label) || "0", 10);

      var bits = [quality];
      if (codec) bits.push(codec);
      if (size) bits.push(size);
      if (epNum) bits.push("EP " + epNum);

      items.push({ href: links[i].href, title: bits.join(" • "),
                   quality: quality, ep: epNum, key: quality + "|" + size + "|" + epNum });
    }

    if (mediaType === "tv" && episode) {
      var want = parseInt(episode, 10);
      var hit = items.filter(function (x) { return x.ep === want; });
      if (hit.length) items = hit;
    }

    var uniq = {}, finalItems = [];
    for (var k = 0; k < items.length; k++) {
      if (uniq[items[k].key]) continue;
      uniq[items[k].key] = 1;
      finalItems.push(items[k]);
    }
    try { console.log("[CineFreak] found " + finalItems.length + " links"); } catch (e) {}
    return finalItems;
  });
}

/* ---------- 4. cinecloud -> ডিরেক্ট URL ---------- */
function resolveCinecloud(pageUrl) {
  return req(pageUrl, { referer: CF_BASE + "/" }).then(function (html) {
    var csrf = first(/name="X-CSRF-TOKEN"\s+content="([^"]+)"/i, html);
    var body = "a=play" + (csrf ? "&X-CSRF-TOKEN=" + encodeURIComponent(csrf) : "");
    return req(pageUrl, {
      method: "POST", body: body, referer: pageUrl,
      headers: { "Content-Type": "application/x-www-form-urlencoded",
                 "X-Requested-With": "XMLHttpRequest" }
    });
  }).then(function (txt) {
    var j = asJson(txt);
    if (j && j.ok) {
      if (j.vlc) return j.vlc;
      if (j.url) return j.url;
    }
    return pageUrl;
  }).catch(function () { return pageUrl; });
}

/* ---------- 5. entry ---------- */
function getStreams(tmdbId, mediaType, season, episode) {
  return getMeta(tmdbId, mediaType)
    .then(function (meta) { return findPost(meta, mediaType); })
    .then(function (post) {
      if (!post) return [];
      return scrapePost(CF_BASE + "/" + post.slug + "/", mediaType, season, episode);
    })
    .then(function (items) {
      if (!items.length) return [];
      return Promise.all(items.map(function (it) {
        return resolveCinecloud(it.href).then(function (url) {
          return { name: "CineFreak", title: it.title, url: url, quality: it.quality,
                   headers: { "User-Agent": UA, "Referer": CF_BASE + "/" } };
        });
      }));
    })
    .catch(function (e) { try { console.log("[CineFreak] " + e); } catch (x) {} return []; });
}

if (typeof module !== "undefined" && module.exports) module.exports = { getStreams: getStreams };
