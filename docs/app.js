// Director Runs — filmographies from TMDB, progress saved per user in Supabase.

const IMG = "https://image.tmdb.org/t/p/";
const MIN_RUNTIME = 40;   // minutes; anything shorter with a known runtime counts as a short
// Names "Pick one at random" draws from. Each is looked up on TMDB when picked.
const POOL = [
  "Stanley Kubrick", "Quentin Tarantino", "David Fincher", "Christopher Nolan", "Denis Villeneuve", "Wes Anderson",
  "Martin Scorsese", "Akira Kurosawa", "Hayao Miyazaki", "Isao Takahata", "Mamoru Hosoda", "Makoto Shinkai",
  "David Lynch", "Andrei Tarkovsky", "Bong Joon Ho", "Park Chan-wook", "Wong Kar-wai", "Hirokazu Kore-eda",
  "Sofia Coppola", "Greta Gerwig", "Yorgos Lanthimos", "Steven Spielberg", "Jordan Peele", "Ari Aster",
  "Robert Eggers", "Céline Sciamma", "Jim Jarmusch", "Richard Linklater", "Edgar Wright", "Guillermo del Toro",
  "Alfonso Cuarón", "Sergio Leone", "Michael Mann", "Terrence Malick", "Darren Aronofsky", "Spike Jonze",
  "Charlie Kaufman", "Lynne Ramsay", "Alfred Hitchcock", "Ingmar Bergman", "Federico Fellini", "Agnès Varda",
  "Jean-Luc Godard", "François Truffaut", "Yasujirō Ozu", "Krzysztof Kieślowski", "Michael Haneke", "Lars von Trier",
  "Pedro Almodóvar", "Alejandro González Iñárritu", "Ridley Scott", "James Cameron", "Billy Wilder", "Spike Lee",
  "Kathryn Bigelow", "Jane Campion", "Claire Denis", "Chantal Akerman", "Abbas Kiarostami", "Edward Yang",
  "Hou Hsiao-hsien", "Jia Zhangke", "Takeshi Kitano", "Kiyoshi Kurosawa", "Hong Sang-soo", "Lee Chang-dong",
  "Nuri Bilge Ceylan", "Asghar Farhadi", "Paolo Sorrentino", "Luca Guadagnino", "Joachim Trier", "Aki Kaurismäki",
  "Roy Andersson", "Werner Herzog", "Wim Wenders", "Rainer Werner Fassbinder", "John Carpenter", "Brian De Palma",
  "Francis Ford Coppola", "Sidney Lumet", "Robert Altman", "Hal Ashby", "Barry Jenkins", "Kelly Reichardt",
  "Noah Baumbach", "Safdie brothers", "Mamoru Oshii", "Masaaki Yuasa", "Céline Song", "Sean Baker", "Chloé Zhao"
];

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const local = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const initials = name => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase();
const hue = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
const placeholder = f => `<div class="ph" style="background:linear-gradient(160deg,hsl(${hue(f.t)} 30% 22%),hsl(${(hue(f.t) + 40) % 360} 25% 10%))">${esc(f.t)}<small>${f.y || "TBA"}</small></div>`;
const posterOf = f => entries.get(f.id)?.poster || f.poster;
const today = () => new Date().toLocaleDateString("sv");   // local YYYY-MM-DD
const posterHtml = (f, size = "w342") => posterOf(f) ? `<img src="${IMG + size + posterOf(f)}" alt="${esc(f.t)} poster" loading="lazy">` : placeholder(f);

// ---------- State ----------
let sb = null, user = null;
let tmdbToken = null;
let directors = [];            // rows from Supabase plus .films (loaded from TMDB) and .error
const entries = new Map();     // movie_id -> {watched, note}
let suggestion = null;         // {name, person_ids, films, loading}
let searchSeq = 0, searchResults = [], lookupMsg = "";
let open = null;               // {dir, movie}

// ---------- TMDB ----------
async function tmdb(path, params = {}) {
  const u = new URL("https://api.themoviedb.org/3" + path);
  const v3 = /^[0-9a-f]{32}$/i.test(tmdbToken);
  if (v3) u.searchParams.set("api_key", tmdbToken);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const headers = v3 ? { accept: "application/json" } : { accept: "application/json", Authorization: "Bearer " + tmdbToken };
  let res;
  // TMDB rate-limits bursts (many directors loading at once); wait and try again rather than give up.
  for (let attempt = 0; ; attempt++) {
    res = await fetch(u, { headers });
    if (res.status !== 429 || attempt >= 4) break;
    await new Promise(r => setTimeout(r, (Number(res.headers.get("retry-after")) || 1) * 1000 * (attempt + 1)));
  }
  if (!res.ok) { const e = new Error("TMDB " + res.status); e.status = res.status; throw e; }
  return res.json();
}

// Run async jobs with a small concurrency limit.
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = null; } }
  }));
  return out;
}

async function runtimeOf(id) {
  const cache = local.get("dr-rt", {});
  if (id in cache) return cache[id];
  const m = await tmdb("/movie/" + id);
  cache[id] = m.runtime || 0;
  local.set("dr-rt", cache);
  return cache[id];
}

// A director's films: everything they're credited as Director on, minus shorts and video releases.
async function loadFilms(personIds, { fresh = false } = {}) {
  const key = "dr-films2-" + personIds.join("+");
  const cached = local.get(key, null);
  if (cached && !fresh && Date.now() - cached.at < 3 * 864e5) return cached.films.filter(f => !f.upcoming);
  const credits = await Promise.all(personIds.map(id => tmdb(`/person/${id}/movie_credits`)));
  const byId = new Map();
  for (const c of credits) for (const m of c.crew || []) if (m.job === "Director" && !m.video) byId.set(m.id, m);
  const list = [...byId.values()];
  const runtimes = await pool(list, 8, m => runtimeOf(m.id));
  const today = new Date().toISOString().slice(0, 10);
  const films = list
    .map((m, i) => ({ m, rt: runtimes[i] }))
    // Shorts: a known runtime under the limit, or no runtime on TMDB and next to no votes (how most shorts look there).
    .filter(({ m, rt }) => !(rt && rt < MIN_RUNTIME) && !(rt === 0 && (m.vote_count || 0) < 10))
    .map(({ m }) => ({
      id: m.id, t: m.title, y: (m.release_date || "").slice(0, 4), date: m.release_date || "",
      poster: m.poster_path, backdrop: m.backdrop_path, votes: m.vote_count || 0,
      overview: m.overview || "", upcoming: !m.release_date || m.release_date > today,
      doc: (m.genre_ids || []).includes(99)
    }))
    .sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
  // If some runtimes couldn't be fetched, shorts may have slipped through: cache briefly so it's retried soon.
  local.set(key, { at: runtimes.includes(null) ? Date.now() - 3 * 864e5 + 600e3 : Date.now(), films });
  return films.filter(f => !f.upcoming);
}

// IMDb id, TMDB score and runtime for the film sheet; refreshed weekly.
async function detailsOf(id) {
  const cache = local.get("dr-md", {});
  const hit = cache[id];
  if (hit && Date.now() - hit.at < 7 * 864e5) return hit;
  const m = await tmdb("/movie/" + id, { append_to_response: "external_ids" });
  const out = { at: Date.now(), imdb: m.imdb_id || m.external_ids?.imdb_id || "", va: m.vote_average || 0, vc: m.vote_count || 0, rt: m.runtime || 0 };
  cache[id] = out;
  local.set("dr-md", cache);
  return out;
}

// Director photos for the trophy room (person id -> TMDB profile path).
const photos = local.get("dr-pp", {});
async function loadPhotos(ids) {
  const missing = ids.filter(id => !(id in photos));
  if (!missing.length) return false;
  await pool(missing, 4, async id => { photos[id] = (await tmdb("/person/" + id)).profile_path || ""; });
  local.set("dr-pp", photos);
  return true;
}

function topFilm(films) {
  return [...films].filter(f => f.backdrop && !f.upcoming).sort((a, b) => b.votes - a.votes)[0] || null;
}

// ---------- Supabase data ----------
async function loadData() {
  const [d, e] = await Promise.all([
    sb.from("directors").select("*").order("added_at"),
    sb.from("entries").select("*")
  ]);
  if (d.error) throw d.error;
  if (e.error) throw e.error;
  const old = new Map(directors.map(x => [x.id, x]));
  directors = d.data.map(r => ({ ...r, films: old.get(r.id)?.films || null }));
  entries.clear();
  for (const r of e.data) entries.set(r.movie_id, { watched: r.watched, note: r.note, hidden: !!r.hidden, rating: r.rating || 0, poster: r.poster || "", on: r.watched_on || "", at: r.updated_at });
  render();
  for (const dir of directors) if (!dir.films) fillFilms(dir);
  scheduleRecs();
}

async function fillFilms(dir) {
  try {
    dir.films = await loadFilms(dir.person_ids); dir.error = null;
    if (!dir.films.length) await repairDirector(dir);
  }
  catch (err) { dir.error = err.status === 401 ? "TMDB rejected the key." : "Couldn't load films. Reload to try again."; }
  render();
  scheduleRecs();
}

async function saveEntry(movieId, patch) {
  const cur = entries.get(movieId) || { watched: false, note: "", hidden: false, rating: 0 };
  const next = { ...cur, ...patch, at: new Date().toISOString() };
  // Ticking a film dates it today; unticking clears the date. Dates can be changed in the film sheet.
  if ("watched" in patch && patch.watched !== !!cur.watched) next.on = patch.watched ? today() : "";
  const before = completedIds();
  entries.set(movieId, next);
  render();
  const fresh = directors.find(d => completedIds().has(d.id) && !before.has(d.id));
  if (fresh) {
    celebrate(fresh);
    setTimeout(() => { if (!tier && view === "runs") { closeSheet(); openTier(fresh.id, true); } }, 1600);
  }
  if ("watched" in patch || "rating" in patch || "hidden" in patch) scheduleRecs();
  const row = { user_id: user.id, movie_id: movieId, watched: next.watched, note: next.note, updated_at: new Date().toISOString() };
  if ("hidden" in patch || next.hidden) row.hidden = next.hidden;
  if ("rating" in patch || next.rating) row.rating = next.rating || null;   // only sent when used, so older databases keep working
  if ("poster" in patch || next.poster) row.poster = next.poster || null;
  if (next.on || cur.on) row.watched_on = next.on || null;
  let { error } = await sb.from("entries").upsert(row);
  // Before the watched_on column exists, save everything else rather than failing the whole change.
  if (error && /watched_on/.test(error.message)) { delete row.watched_on; ({ error } = await sb.from("entries").upsert(row)); }
  if (error) { entries.set(movieId, cur); render(); if (open?.movie === movieId) renderSheetState(); notify("Couldn't save that change. " + error.message); }
}

async function addDirector(name, personIds) {
  if (directors.some(d => d.name.toLowerCase() === name.toLowerCase())) { lookupMsg = name + " is already on your list."; return renderAdd(); }
  suggestion = null; lookupMsg = ""; $("search").value = ""; searchResults = [];
  renderAdd();
  const { data, error } = await sb.from("directors").insert({ name, person_ids: personIds }).select().single();
  if (error) { lookupMsg = "!Couldn't add " + name + ". " + error.message; return renderAdd(); }
  const dir = { ...data, films: null };
  directors.push(dir);
  render();
  requestAnimationFrame(() => { const c = $("cards"); c.scrollTo({ left: c.scrollWidth, behavior: "smooth" }); });
  fillFilms(dir);
}

async function removeDirector(id) {
  const { error } = await sb.from("directors").delete().eq("id", id);
  if (!error) { directors = directors.filter(d => d.id !== id); render(); }
}

// First run: bring over the three directors from the old page, with Perfect Blue watched.
async function seedIfNeeded(settings) {
  if (settings.seeded) return;
  await sb.from("settings").update({ seeded: true }).eq("user_id", user.id);
  if (directors.length) return;
  const people = await Promise.all(["Paul Thomas Anderson", "Joel Coen", "Ethan Coen", "Satoshi Kon"].map(findDirector));
  const rows = [];
  if (people[0]) rows.push({ name: "Paul Thomas Anderson", person_ids: [people[0].id] });
  if (people[1] && people[2]) rows.push({ name: "Coen Brothers", person_ids: [people[1].id, people[2].id] });
  if (people[3]) rows.push({ name: "Satoshi Kon", person_ids: [people[3].id] });
  for (const r of rows) await sb.from("directors").insert(r);
  if (people[3]) {
    const pb = (await loadFilms([people[3].id])).find(f => f.t === "Perfect Blue");
    if (pb) await sb.from("entries").upsert({ user_id: user.id, movie_id: pb.id, watched: true, note: "" });
  }
}

// Prefer an exact name match who works as a director; TMDB's search is fuzzy and
// can rank a namesake (or a near-empty duplicate profile) above the real person.
const normName = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
async function findDirector(name) {
  const r = await tmdb("/search/person", { query: name });
  const hits = r.results || [];
  const exact = hits.filter(p => normName(p.name) === normName(name));
  const directing = p => p.known_for_department === "Directing";
  return exact.find(directing) || exact[0] || hits.find(directing) || hits[0] || null;
}

// A single-person director that loads no films was probably matched to the wrong TMDB profile:
// look the name up again and keep the new match if it actually has films.
async function repairDirector(dir) {
  if (dir.person_ids.length !== 1) return;
  const r = await tmdb("/search/person", { query: dir.name });
  const exact = (r.results || []).filter(p => normName(p.name) === normName(dir.name) && p.id !== dir.person_ids[0]);
  for (const p of exact) {
    const films = await loadFilms([p.id]);
    if (!films.length) continue;
    const { error } = await sb.from("directors").update({ person_ids: [p.id] }).eq("id", dir.id);
    if (!error) { dir.person_ids = [p.id]; dir.films = films; }
    return;
  }
}

// ---------- Rendering ----------
const isHidden = f => !!entries.get(f.id)?.hidden;
const showRemoved = new Set();   // director ids whose removed films are shown

const TROPHY = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 2h10v2h4v3a5 5 0 0 1-4.6 5A6 6 0 0 1 13 15.9V18h3a2 2 0 0 1 2 2v2H6v-2a2 2 0 0 1 2-2h3v-2.1A6 6 0 0 1 7.6 12 5 5 0 0 1 3 7V4h4V2Zm0 4H5v1a3 3 0 0 0 2 2.8V6Zm10 0v3.8A3 3 0 0 0 19 7V6h-2Z"/></svg>`;

function progressOf(d) {
  const released = (d.films || []).filter(f => !isHidden(f));
  const watched = released.filter(f => entries.get(f.id)?.watched);
  const rated = watched.map(f => entries.get(f.id).rating).filter(Boolean);
  return { released, watched: watched.length, done: !!d.films && released.length > 0 && watched.length === released.length,
           avg: rated.length ? rated.reduce((a, b) => a + b, 0) / rated.length : 0 };
}
function completedIds() { return new Set(directors.filter(d => progressOf(d).done).map(d => d.id)); }

let view = "runs";   // "runs" (director cards), "calendar" or "trophies"

function shelf() {
  const won = directors.filter(d => progressOf(d).done);
  $("views").hidden = !directors.length;
  $("trophyCount").textContent = won.length;
  document.querySelectorAll("#views [data-view]").forEach(b => {
    b.classList.toggle("on", b.dataset.view === view);
    b.setAttribute("aria-pressed", b.dataset.view === view);
  });
  if (view === "trophies") renderTrophies(won);
  if (view === "calendar") renderCalendar();
}

function renderTrophies(won) {
  const fmt = iso => iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "";
  if (!won.length) {
    const next = directors.map(d => ({ d, ...progressOf(d) })).filter(x => x.d.films && x.released.length)
      .sort((a, b) => (a.released.length - a.watched) - (b.released.length - b.watched))[0];
    $("trophyView").innerHTML = `<div class="empty"><strong>No trophies yet</strong>Watch every film by a director to win one.${
      next ? `<br>Closest: ${esc(next.d.name)}, ${next.released.length - next.watched} to go.` : ""}</div>`;
    return;
  }
  loadPhotos(won.flatMap(d => d.person_ids)).then(changed => { if (changed && view === "trophies") shelf(); }).catch(() => {});
  $("trophyView").innerHTML = `<h2 class="tv-title">Trophy room</h2><div class="trophies">${won.map(d => {
    const { released, avg } = progressOf(d);
    const top = topFilm(released);
    const fav = released.map(f => ({ f, r: entries.get(f.id)?.rating || 0 })).filter(x => x.r).sort((a, b) => b.r - a.r || b.f.votes - a.f.votes)[0];
    const at = released.map(f => entries.get(f.id)?.at || "").sort().pop();
    return `<article class="tcard">
      <div class="tbanner">${top ? `<img src="${IMG}w780${top.backdrop}" alt="">` : ""}</div>
      <div class="medal${d.person_ids.length > 1 ? " duo" : ""}">${d.person_ids.map(id => photos[id]
        ? `<img src="${IMG}w185${photos[id]}" alt="">` : `<span class="ini">${esc(initials(d.name))}</span>`).join("")}
        <span class="medal-badge">${TROPHY}</span></div>
      <div class="tbody">
        <h3>${esc(d.name)}</h3>
        <div class="tmeta">${released.length} films${at ? ` · completed ${fmt(at)}` : ""}</div>
        ${avg ? `<div class="tavg">${starsHtml(Math.round(avg))}<span>${avg.toFixed(1)} average</span></div>` : ""}
        ${fav ? `<div class="tfav"><span>Favourite</span>${esc(fav.f.t)} <small>${fav.f.y}</small></div>` : ""}
        ${miniTiers(d)}
        <button class="btn tier-open" type="button" data-tieropen="${d.id}">${hasTiers(d) ? "Edit tier list" : "Make a tier list"}</button>
      </div>
    </article>`;
  }).join("")}</div>`;
}

function setView(v) {
  view = v;
  $("addPanel").hidden = v !== "runs"; $("rowwrap").hidden = v !== "runs";
  $("trophyView").hidden = v !== "trophies"; $("calView").hidden = v !== "calendar";
  shelf();
  if (v === "runs") updateNav();
  if (v === "calendar") { const w = document.querySelector(".cal-scroll"); if (w) w.scrollLeft = w.scrollWidth; }
  window.scrollTo({ top: 0 });
}

let toastTimer = null;
function notify(msg) {
  const t = $("toast");
  t.dataset.kind = "note";
  t.innerHTML = `<span>${esc(msg)}</span>`;
  t.hidden = false; t.classList.remove("show"); void t.offsetWidth; t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
}
function celebrate(d) {
  const { released, avg } = progressOf(d);
  const t = $("toast");
  t.dataset.kind = "trophy";
  t.innerHTML = `<span class="toast-icon">${TROPHY}</span><span><b>Trophy unlocked</b>${esc(d.name)} · all ${released.length} films${avg ? ` · avg ★ ${avg.toFixed(1)}` : ""}</span>`;
  t.hidden = false; t.classList.remove("show"); void t.offsetWidth; t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

const starsHtml = (n, cls = "") => n ? `<span class="stars ${cls}" aria-label="Rated ${n} of 5">${"★".repeat(n)}<i>${"★".repeat(5 - n)}</i></span>` : "";

function render() {
  shelf();
  const cards = $("cards");
  if (!directors.length) {
    cards.innerHTML = `<div class="empty"><strong>No directors yet</strong>Search above or pick one at random to start your first run.</div>`;
    return updateNav();
  }
  const scroll = cards.scrollLeft;
  cards.innerHTML = directors.map(d => {
    const all = d.films || [];
    const { released, watched, done, avg } = progressOf(d);
    const removed = all.length - released.length;
    const films = showRemoved.has(d.id) ? all : released;
    const top = topFilm(released);
    const banner = top
      ? `<img src="${IMG}w780${top.backdrop}" alt="Still from ${esc(top.t)}">`
      : `<div class="initials">${esc(initials(d.name))}</div>`;
    let body;
    if (d.error) body = `<p class="skeleton err">${esc(d.error)}</p>`;
    else if (!d.films) body = `<p class="skeleton">Loading films…</p>`;
    else body = `<div class="posters">${films.map(f => {
      const e = entries.get(f.id) || {}, w = !!e.watched, h = !!e.hidden;
      return `<div class="poster${w ? " watched" : ""}${h ? " removed" : ""}">
        <button class="art" type="button" data-open="${d.id}|${f.id}" aria-label="${esc(f.t)} (${f.y})">
          <span class="hover-title" aria-hidden="true">${esc(f.t)} (${f.y})</span>
          ${posterHtml(f)}
          ${h ? `<span class="flag">Removed</span>` : e.note ? `<span class="flag">Note</span>` : f.doc ? `<span class="flag">Doc</span>` : ""}
          ${h ? "" : starsHtml(e.rating, "on-poster")}
        </button>
        ${h ? "" : `<button class="tick" type="button" data-tick="${f.id}" aria-pressed="${w}" aria-label="${w ? "Mark as not watched" : "Mark as watched"}: ${esc(f.t)}">✓</button>`}
      </div>`;
    }).join("") || `<p class="hint" style="grid-column:1/-1">All watched. Nice run.</p>`}</div>`;
    return `<article class="card${done ? " done" : ""}">
      <div class="banner">${banner}
        <div class="cap"><h2>${esc(d.name)}</h2>
          <div class="count"><b>${watched}</b> / ${released.length}</div></div>
        ${done ? `<span class="badge" title="Every film watched">${TROPHY}${avg ? `★ ${avg.toFixed(1)}` : "Complete"}</span>` : ""}
      </div>
      <div class="strip" role="progressbar" aria-valuemin="0" aria-valuemax="${released.length}" aria-valuenow="${watched}" aria-label="${esc(d.name)} progress">
        <div class="frames">${released.map(f => `<span class="frame${entries.get(f.id)?.watched ? " on" : ""}" title="${esc(f.t)} (${f.y})"></span>`).join("")}</div>
      </div>
      ${body}
      <div class="card-foot">
        ${removed ? `<button class="linkbtn" type="button" data-showremoved="${d.id}">${showRemoved.has(d.id) ? "Hide" : "Show"} ${removed} removed</button>` : "<span></span>"}
        <button class="linkbtn" type="button" data-remove="${d.id}">Remove director</button></div>
    </article>`;
  }).join("");
  cards.scrollLeft = scroll;
  updateNav();
  if (open) renderSheetState();
}

function updateNav() {
  const c = $("cards");
  $("prevBtn").hidden = c.scrollLeft <= 4;
  $("nextBtn").hidden = c.scrollLeft + c.clientWidth >= c.scrollWidth - 4;
}

function renderAdd() {
  const q = $("search").value.trim();
  let html = searchResults.map((p, i) => `<button class="result" type="button" data-pick="${i}">
      <span class="avatar">${p.profile ? `<img src="${IMG}w185${p.profile}" alt="">` : esc(initials(p.name))}</span>
      <span>${esc(p.name)}<span class="meta">${esc(p.meta)}</span></span></button>`).join("");
  if (q.length >= 2 && !searchResults.length && !lookupMsg) html = `<p class="hint">Searching…</p>`;
  if (lookupMsg) html += `<p class="hint ${lookupMsg.startsWith("!") ? "err" : ""}">${esc(lookupMsg.replace(/^!/, ""))}</p>`;
  $("results").innerHTML = q || lookupMsg ? html : "";
  const s = suggestion;
  if (!s) { $("suggest").innerHTML = ""; return; }
  const released = s.films || [];
  const top = s.films && topFilm(s.films);
  $("suggest").innerHTML = `<div class="suggest">
    <div class="pic">${top ? `<img src="${IMG}w300${top.backdrop}" alt="">` : ""}</div>
    <div class="info">
      <span class="hint">Tonight's pick</span>
      <strong>${esc(s.name)}</strong>
      <span class="hint">${s.loading ? "Loading filmography…" : released.length ? `${released.length} films, ${released[0].y}–${released[released.length - 1].y}${top ? ` · best known for ${esc(top.t)}` : ""}` : "No films found"}</span>
      <div class="add-row">
        <button class="btn primary" type="button" id="addSuggestBtn" ${s.loading || !released.length ? "disabled" : ""}>Add</button>
        <button class="btn" type="button" id="againBtn">Another</button>
        <button class="btn" type="button" id="dismissBtn">Close</button>
      </div>
    </div></div>`;
}

let searchTimer = null;
function onSearch() {
  lookupMsg = ""; searchResults = [];
  clearTimeout(searchTimer);
  const q = $("search").value.trim();
  renderAdd();
  if (q.length < 2) return;
  const seq = ++searchSeq;
  searchTimer = setTimeout(async () => {
    try {
      const r = await tmdb("/search/person", { query: q });
      if (seq !== searchSeq) return;
      const people = (r.results || [])
        .filter(p => p.known_for_department === "Directing" || p.known_for_department === "Writing")
        .slice(0, 8)
        .map(p => ({ name: p.name, ids: [p.id], profile: p.profile_path, meta: (p.known_for || []).map(k => k.title || k.name).filter(Boolean).slice(0, 2).join(", ") || p.known_for_department }));
      if (/coen/i.test(q)) {
        const [j, e] = await Promise.all([findDirector("Joel Coen"), findDirector("Ethan Coen")]);
        if (j && e) people.unshift({ name: "Coen Brothers", ids: [j.id, e.id], profile: j.profile_path, meta: "Joel & Ethan, combined" });
      }
      searchResults = people;
      if (!people.length) lookupMsg = "No directors found for “" + q + "”.";
    } catch (err) { lookupMsg = "!Search failed. " + (err.status === 401 ? "TMDB rejected the key." : "Check your connection."); }
    if (seq === searchSeq) renderAdd();
  }, 300);
}

async function pickRandom() {
  const have = new Set(directors.map(d => d.name.toLowerCase()));
  const options = POOL.filter(n => !have.has(n.toLowerCase()) && n !== suggestion?.name);
  if (!options.length) { lookupMsg = "You've added everyone in the random pool. Search for anyone else."; return renderAdd(); }
  const name = options[Math.floor(Math.random() * options.length)];
  suggestion = { name, person_ids: null, films: null, loading: true };
  renderAdd();
  const mine = suggestion;
  try {
    let ids;
    if (name === "Safdie brothers") {
      const [a, b] = await Promise.all([findDirector("Josh Safdie"), findDirector("Benny Safdie")]);
      ids = [a?.id, b?.id].filter(Boolean);
    } else ids = [(await findDirector(name))?.id].filter(Boolean);
    mine.person_ids = ids;
    mine.films = ids.length ? await loadFilms(ids) : [];
  } catch { mine.films = []; }
  mine.loading = false;
  if (suggestion === mine) renderAdd();
}

// ---------- Film sheet ----------
function findFilm(dirId, movieId) {
  const d = directors.find(x => x.id === dirId);
  const f = d?.films?.find(x => x.id === movieId);
  return f ? { d, f } : null;
}
// The films the sheet steps through: what the director's card is showing.
function sheetList(d) {
  const all = d.films || [];
  return showRemoved.has(d.id) ? all : all.filter(f => !isHidden(f));
}
function openSheet(dirId, movieId, focusId = "sheetDone") {
  const hit = findFilm(dirId, movieId);
  if (!hit) return;
  open = { dir: dirId, movie: movieId };
  const { d, f } = hit, e = entries.get(f.id) || {};
  const list = sheetList(d), i = list.findIndex(x => x.id === f.id);
  $("sheetBack").innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
    <div class="sheet-top">
      <span class="eyebrow">${esc(d.name)}${i >= 0 ? ` · ${i + 1} of ${list.length}` : ""}</span>
      ${list.length > 1 && i >= 0 ? `<span class="sheet-nav">
        <button class="nav-btn" type="button" id="sheetPrev" aria-label="Previous film">‹</button>
        <button class="nav-btn" type="button" id="sheetNext" aria-label="Next film">›</button></span>` : ""}
    </div>
    <div class="poster-col">
      <button class="big" type="button" id="sheetPoster" aria-label="Choose a different poster">${posterHtml(f, "w500")}<span class="big-hint">Change poster</span></button>
      <div class="links" id="sheetLinks">${lbLink(f.id)}</div>
    </div>
    <div class="body">
      <div class="head">
        <h3 id="sheetTitle">${esc(f.t)}</h3>
        <div class="film-meta"><span>${f.y}</span><span id="sheetRuntime"></span></div>
      </div>
      ${f.overview ? `<p class="overview">${esc(f.overview)}</p>` : ""}
      <div class="spacer"></div>
      ${e.hidden ? `<p class="hint take">Removed from this list, so it doesn't count toward progress.</p>` : `
      <section class="take" aria-label="Your take">
        <div class="take-row">
          <div class="rate" role="group" aria-label="Your rating">${[1, 2, 3, 4, 5].map(n =>
            `<button type="button" data-rate="${n}" aria-label="${n} star${n > 1 ? "s" : ""}">★</button>`).join("")}</div>
          <label class="watched-on" id="watchedOnWrap" hidden>Watched <input type="date" id="watchedOn" max="${today()}"></label>
        </div>
        <textarea id="noteInput" maxlength="500" placeholder="Your note: a short thought on it" aria-label="Your note">${esc(e.note || "")}</textarea>
      </section>`}
      <div class="sheet-foot">
        <button class="linkbtn" type="button" id="sheetHide">${e.hidden ? "Put back in the list" : "Remove from list"}</button>
        <span class="foot-right">${e.hidden ? "" : `<button class="btn watch-toggle" type="button" id="sheetTick"></button>`}
        <button class="btn primary" type="button" id="sheetDone">Done</button></span>
      </div>
    </div></div>`;
  $("sheetBack").hidden = false;
  renderSheetState();
  ($(focusId) || $("sheetDone")).focus();
  fillSheetMeta(f);
}
const ICON_IMDB = `<svg viewBox="0 0 64 32" aria-hidden="true"><rect width="64" height="32" rx="5" fill="#f5c518"/><text x="32" y="23" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="18" fill="#000">IMDb</text></svg>`;
const ICON_LB = `<svg viewBox="0 0 64 32" aria-hidden="true"><rect width="64" height="32" rx="5" fill="#202830"/><circle cx="19" cy="16" r="9" fill="#ff8000"/><circle cx="32" cy="16" r="9" fill="#00e054" fill-opacity=".9"/><circle cx="45" cy="16" r="9" fill="#40bcf4" fill-opacity=".9"/></svg>`;
const lbLink = id => `<a class="site-icon" href="https://letterboxd.com/tmdb/${id}/" target="_blank" rel="noopener" title="Letterboxd" aria-label="Open on Letterboxd">${ICON_LB}</a>`;
async function fillSheetMeta(f) {
  let m;
  try { m = await detailsOf(f.id); } catch { return; }
  if (open?.movie !== f.id) return;
  const rt = m.rt ? `${Math.floor(m.rt / 60) ? Math.floor(m.rt / 60) + "h " : ""}${m.rt % 60}m` : "";
  $("sheetRuntime").textContent = rt;
  $("sheetLinks").innerHTML = (m.imdb ? `<a class="site-icon" href="https://www.imdb.com/title/${m.imdb}/" target="_blank" rel="noopener" title="IMDb" aria-label="Open on IMDb">${ICON_IMDB}</a>` : "") + lbLink(f.id);
}

// Poster picker: every poster TMDB has for the film, most liked first.
async function openPicker() {
  if (!open) return;
  const movie = open.movie, sheet = document.querySelector(".sheet");
  const el = document.createElement("div");
  el.className = "picker"; el.id = "picker";
  el.innerHTML = `<div class="picker-top"><strong>Choose a poster</strong>
    <span><button class="btn" type="button" id="pickerReset">Use default</button>
    <button class="btn primary" type="button" id="pickerClose">Close</button></span></div>
    <div class="picker-grid"><p class="hint">Loading posters…</p></div>`;
  sheet.append(el);
  $("pickerClose").focus();
  let list = [];
  try { list = (await tmdb(`/movie/${movie}/images`, { include_image_language: "en" })).posters || []; } catch {}
  if (open?.movie !== movie || !el.isConnected) return;
  list.sort((a, b) => (b.vote_count - a.vote_count) || (b.vote_average - a.vote_average));
  const cur = posterOf(findFilm(open.dir, movie).f);
  el.querySelector(".picker-grid").innerHTML = list.length ? list.map(p =>
    `<button class="pick${p.file_path === cur ? " on" : ""}" type="button" data-poster="${esc(p.file_path)}" aria-label="Poster${p.iso_639_1 ? ", " + p.iso_639_1 : ""}">
      <img src="${IMG}w185${p.file_path}" alt="" loading="lazy">${p.iso_639_1 ? `<span>${esc(p.iso_639_1)}</span>` : ""}</button>`).join("")
    : `<p class="hint">TMDB has no other posters for this film.</p>`;
}
function choosePoster(path) {
  if (!open) return;
  const { dir, movie } = open;
  saveSheetNote();
  saveEntry(movie, { poster: path });
  openSheet(dir, movie);
}
function stepSheet(delta, focusId) {
  if (!open || $("picker")) return;
  const d = directors.find(x => x.id === open.dir), list = d ? sheetList(d) : [];
  const i = list.findIndex(x => x.id === open.movie);
  if (i < 0 || list.length < 2) return;
  saveSheetNote();
  openSheet(d.id, list[(i + delta + list.length) % list.length].id, focusId);
}
function saveSheetNote() {
  const ta = $("noteInput");
  if (!ta || !open) return;
  const val = ta.value.trim().slice(0, 500);
  if ((entries.get(open.movie)?.note || "") !== val) saveEntry(open.movie, { note: val });
}
function renderSheetState() {
  const b = $("sheetTick");
  if (!open) return;
  const e = entries.get(open.movie) || {};
  if (b) { b.textContent = e.watched ? "✓ Watched" : "Mark as watched"; b.setAttribute("aria-pressed", !!e.watched); }
  document.querySelectorAll(".rate button").forEach(x => x.classList.toggle("on", +x.dataset.rate <= (e.rating || 0)));
  const wo = $("watchedOn");
  if (wo) { $("watchedOnWrap").hidden = !e.watched; if (document.activeElement !== wo) wo.value = e.on || ""; }
}
function closeSheet() {
  if (!open) return;
  saveSheetNote();
  open = null;
  $("sheetBack").hidden = true; $("sheetBack").innerHTML = "";
}

// ---------- Tier lists ----------
const TIERS = ["S", "A", "B", "C", "D"];
let tier = null;       // {dir, draft: {S, A, B, C, D, U: [movie ids]}, sel, fresh}
let tierTimer = null;
const hasTiers = d => !!d.tiers && TIERS.some(t => d.tiers[t]?.length);

function miniTiers(d) {
  if (!hasTiers(d)) return "";
  const byId = new Map((d.films || []).map(f => [f.id, f]));
  return `<div class="mini-tiers">${TIERS.filter(t => d.tiers[t]?.some(id => byId.has(id))).map(t =>
    `<div class="mini-row"><span class="tier-label t-${t}">${t}</span><div>${d.tiers[t].filter(id => byId.has(id)).map(id => {
      const f = byId.get(id);
      return `<span class="mini" title="${esc(f.t)} (${f.y})">${posterHtml(f, "w92")}</span>`;
    }).join("")}</div></div>`).join("")}</div>`;
}

function openTier(dirId, fresh = false) {
  const d = directors.find(x => x.id === dirId);
  if (!d?.films) return;
  const films = progressOf(d).released, ids = new Set(films.map(f => f.id));
  const draft = { S: [], A: [], B: [], C: [], D: [], U: [] }, placed = new Set();
  const saved = hasTiers(d) ? d.tiers : null;
  if (saved) for (const t of TIERS) for (const id of saved[t] || []) if (ids.has(id) && !placed.has(id)) { draft[t].push(id); placed.add(id); }
  // A first tier list starts from your star ratings: 5 stars in S down to 1 star in D.
  for (const f of films) if (!placed.has(f.id)) {
    const r = entries.get(f.id)?.rating || 0;
    (saved || !r ? draft.U : draft[TIERS[5 - r]]).push(f.id);
  }
  tier = { dir: dirId, draft, sel: null, fresh };
  renderTier();
  $("tierBack").hidden = false;
  $("tierDone").focus();
}

function renderTier() {
  const d = directors.find(x => x.id === tier.dir), byId = new Map(d.films.map(f => [f.id, f]));
  const chip = id => { const f = byId.get(id); return f ? `<button class="tchip${tier.sel === id ? " sel" : ""}" type="button" draggable="true"
    data-tierfilm="${id}" title="${esc(f.t)} (${f.y})" aria-label="${esc(f.t)} (${f.y})">${posterHtml(f, "w185")}</button>` : ""; };
  const row = (t, label) => `<div class="tier-row${t === "U" ? " unranked" : ""}" data-tier="${t}">
    <span class="tier-label t-${t}">${label}</span>
    <div class="tier-zone">${tier.draft[t].map(chip).join("") || (t === "U" ? `<span class="hint">All ranked.</span>` : "")}</div></div>`;
  $("tierBack").innerHTML = `<div class="tier-sheet" role="dialog" aria-modal="true" aria-labelledby="tierTitle">
    <div class="tier-top">
      <div><span class="eyebrow">${tier.fresh ? "Trophy unlocked · " : ""}Tier list</span><h3 id="tierTitle">Rank ${esc(d.name)}</h3></div>
      <button class="btn primary" type="button" id="tierDone">Done</button>
    </div>
    <p class="hint">${tier.sel != null ? "Now tap a row to move it there, or tap another poster to put it in front of that one."
      : "Tap a poster, then tap a row to move it. On a computer you can also drag."}</p>
    <div class="tiers">${TIERS.map(t => row(t, t)).join("")}</div>
    ${row("U", "?")}
  </div>`;
}

function moveTier(id, t, beforeId = null) {
  for (const k in tier.draft) tier.draft[k] = tier.draft[k].filter(x => x !== id);
  const arr = tier.draft[t], i = beforeId != null ? arr.indexOf(beforeId) : -1;
  i >= 0 ? arr.splice(i, 0, id) : arr.push(id);
  tier.sel = null;
  renderTier();
  clearTimeout(tierTimer);
  tierTimer = setTimeout(saveTier, 600);
}

async function saveTier() {
  clearTimeout(tierTimer);
  if (!tier) return;
  const d = directors.find(x => x.id === tier.dir);
  const { U, ...ranked } = tier.draft;
  d.tiers = JSON.parse(JSON.stringify(ranked));
  const { error } = await sb.from("directors").update({ tiers: d.tiers }).eq("id", d.id);
  if (error) notify("Couldn't save the tier list. " + error.message);
}

function closeTier() {
  if (!tier) return;
  saveTier();
  tier = null;
  $("tierBack").hidden = true; $("tierBack").innerHTML = "";
  shelf();
}

function onTierClick(e) {
  if (e.target.id === "tierBack") { closeTier(); return true; }
  const chipEl = e.target.closest("[data-tierfilm]"), rowEl = e.target.closest(".tier-row");
  if (e.target.closest("#tierDone")) { closeTier(); return true; }
  if (chipEl) {
    const id = +chipEl.dataset.tierfilm;
    if (tier.sel === id) tier.sel = null;
    else if (tier.sel != null) return moveTier(tier.sel, rowEl.dataset.tier, id), true;
    else tier.sel = id;
    renderTier();
    return true;
  }
  if (rowEl && tier.sel != null) { moveTier(tier.sel, rowEl.dataset.tier); return true; }
  return false;
}

// ---------- Watch calendar ----------
let calYear = new Date().getFullYear(), calDay = null, showUndated = false;

function watchedFilms() {
  const seen = new Map();
  for (const d of directors) for (const f of d.films || []) {
    const e = entries.get(f.id);
    if (e?.watched && !e.hidden && !seen.has(f.id)) seen.set(f.id, { f, d, on: e.on || "" });
  }
  return [...seen.values()];
}

function renderCalendar() {
  const all = watchedFilms(), byDay = new Map();
  for (const x of all) if (x.on) { if (!byDay.has(x.on)) byDay.set(x.on, []); byDay.get(x.on).push(x); }
  const undated = all.filter(x => !x.on).sort((a, b) => a.d.name.localeCompare(b.d.name) || a.f.date.localeCompare(b.f.date));
  const years = [...new Set([new Date().getFullYear(), ...[...byDay.keys()].map(k => +k.slice(0, 4))])].sort();
  if (!years.includes(calYear)) calYear = years[years.length - 1];

  // Columns are weeks starting on Monday, rows are days, like GitHub's contribution graph.
  const jan1 = new Date(calYear, 0, 1), lead = (jan1.getDay() + 6) % 7;
  const daysInYear = (new Date(calYear + 1, 0, 1) - jan1) / 864e5 | 0;
  const cols = Math.ceil((lead + daysInYear) / 7);
  const fmtDay = dt => dt.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  let cells = "", months = "", inYear = 0, activeDays = 0;
  const perMonth = new Array(12).fill(0);
  for (let i = 0; i < cols * 7; i++) {
    const dt = new Date(calYear, 0, 1 - lead + i), k = dt.toLocaleDateString("sv");
    if (dt.getFullYear() !== calYear) { cells += `<span class="day out"></span>`; continue; }
    if (dt.getDate() === 1) months += `<span style="grid-column:${Math.floor(i / 7) + 1}">${dt.toLocaleDateString(undefined, { month: "short" })}</span>`;
    const list = byDay.get(k) || [];
    inYear += list.length; perMonth[dt.getMonth()] += list.length; if (list.length) activeDays++;
    const title = `${fmtDay(dt)}${list.length ? ": " + list.map(x => x.f.t).join(", ") : ""}`;
    cells += list.length
      ? `<button class="day l${Math.min(list.length, 3)}${calDay === k ? " sel" : ""}${k === today() ? " now" : ""}" type="button" data-day="${k}" title="${esc(title)}" aria-label="${esc(title)}"></button>`
      : `<span class="day${k === today() ? " now" : ""}" title="${esc(title)}"></span>`;
  }
  // Longest run of consecutive days with at least one film, within the year.
  let streak = 0, best = 0;
  for (let i = 0; i < daysInYear; i++) {
    const k = new Date(calYear, 0, 1 + i).toLocaleDateString("sv");
    streak = byDay.has(k) ? streak + 1 : 0; best = Math.max(best, streak);
  }
  const busiest = perMonth.indexOf(Math.max(...perMonth));
  const dayList = calDay && byDay.get(calDay);

  $("calView").innerHTML = `
    <div class="cal-head"><h2 class="tv-title">Watch calendar</h2>
      ${years.length > 1 ? `<div class="cal-years">${years.map(y => `<button type="button" class="${y === calYear ? "on" : ""}" data-calyear="${y}">${y}</button>`).join("")}</div>` : ""}</div>
    <div class="cal-stats">
      <div><b>${inYear}</b>films in ${calYear}</div>
      <div><b>${activeDays}</b>movie days</div>
      <div><b>${best}</b>day best streak</div>
      ${inYear ? `<div><b>${new Date(calYear, busiest, 1).toLocaleDateString(undefined, { month: "short" })}</b>busiest month</div>` : ""}
    </div>
    <div class="cal-scroll"><div class="cal" style="--cols:${cols}">
      <div class="cal-months">${months}</div>
      <div class="cal-grid">${cells}</div>
    </div></div>
    <div class="cal-legend">Less <span class="day"></span><span class="day l1"></span><span class="day l2"></span><span class="day l3"></span> More</div>
    ${dayList ? `<div class="cal-day"><h3>${fmtDay(new Date(calDay + "T12:00"))}</h3><div class="cal-films">${dayList.map(x => `
      <button class="cal-film" type="button" data-open="${x.d.id}|${x.f.id}"><span class="cf-poster">${posterHtml(x.f, "w185")}</span>
        <span><b>${esc(x.f.t)}</b><small>${esc(x.d.name)} · ${x.f.y}</small></span></button>`).join("")}</div></div>` : ""}
    ${undated.length ? `<div class="undated">
      <button class="linkbtn" type="button" id="undatedToggle">${showUndated ? "Hide" : "Add dates to"} ${undated.length} watched film${undated.length > 1 ? "s" : ""} without a date</button>
      ${showUndated ? `<div class="undated-list">${undated.map(x => `<div class="ud-row">
        <span class="cf-poster">${posterHtml(x.f, "w92")}</span>
        <span class="ud-title"><b>${esc(x.f.t)}</b><small>${esc(x.d.name)} · ${x.f.y}</small></span>
        <input type="date" class="field" data-datefor="${x.f.id}" max="${today()}" aria-label="Watch date for ${esc(x.f.t)}"></div>`).join("")}</div>` : ""}
    </div>` : ""}`;
}

// ---------- Suggested directors ----------
let recs = [], recsTimer = null;
function scheduleRecs() { clearTimeout(recsTimer); recsTimer = setTimeout(() => loadRecs().catch(() => {}), 2500); }

// Directors of the films TMDB recommends for your best-rated watched films, minus anyone already on your list.
async function loadRecs() {
  if (directors.some(d => !d.films && !d.error)) return scheduleRecs();
  const rating = x => entries.get(x.f.id)?.rating || 3;
  // Up to three favourites from each director, so one director doesn't drown out the rest.
  const perDir = new Map();
  for (const x of watchedFilms().sort((a, b) => rating(b) - rating(a) || b.f.votes - a.f.votes)) {
    const l = perDir.get(x.d.id) || []; if (l.length < 3) l.push(x); perDir.set(x.d.id, l);
  }
  const seeds = [...perDir.values()].flat().sort((a, b) => rating(b) - rating(a) || b.f.votes - a.f.votes).slice(0, 12);
  const have = new Set(directors.flatMap(d => d.person_ids));
  if (!seeds.length) { recs = []; return renderRecs(); }
  const key = seeds.map(x => x.f.id + ":" + rating(x)).join(",") + "|" + [...have].sort().join(",");
  const cached = local.get("dr-recs", null);
  if (cached?.key === key && Date.now() - cached.at < 864e5) { recs = cached.list; return renderRecs(); }
  const known = new Set(directors.flatMap(d => (d.films || []).map(f => f.id)));
  const movies = new Map();
  await pool(seeds, 4, async s => {
    const r = await tmdb(`/movie/${s.f.id}/recommendations`);
    (r.results || []).forEach((m, i) => {
      // Skip obscure titles: TMDB's recommendations get noisy below a few hundred votes.
      if (known.has(m.id) || (m.vote_count || 0) < 800 || (m.vote_average || 0) < 7) return;
      const x = movies.get(m.id) || { id: m.id, score: 0, because: new Map() };
      const w = rating(s) * (1 - i / 40) * Math.log10(m.vote_count) * (m.vote_average - 6.5);
      x.score += w; x.because.set(s.f.t, (x.because.get(s.f.t) || 0) + w);
      movies.set(m.id, x);
    });
  });
  const people = new Map();
  await pool([...movies.values()].sort((a, b) => b.score - a.score).slice(0, 30), 5, async m => {
    const c = await tmdb(`/movie/${m.id}/credits`);
    for (const p of (c.crew || []).filter(p => p.job === "Director" && p.known_for_department === "Directing")) {
      if (have.has(p.id)) continue;
      const x = people.get(p.id) || { id: p.id, name: p.name, profile: p.profile_path || "", score: 0, hits: 0, because: new Map() };
      x.score += m.score; x.hits++;
      for (const [t, w] of m.because) x.because.set(t, (x.because.get(t) || 0) + w);
      people.set(p.id, x);
    }
  });
  // Directors behind several of the recommended films rank first.
  recs = [...people.values()].sort((a, b) => b.hits - a.hits || b.score - a.score).slice(0, 6).map(p => ({
    id: p.id, name: p.name, profile: p.profile,
    because: [...p.because].sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => x[0])
  }));
  local.set("dr-recs", { key, at: Date.now(), list: recs });
  renderRecs();
}

function renderRecs() {
  const list = recs.filter(p => !directors.some(d => d.person_ids.includes(p.id)));
  $("recs").innerHTML = list.length ? `<span class="recs-label">Suggested for you</span><div class="results">${list.map(p => `
    <button class="result" type="button" data-rec="${p.id}">
      <span class="avatar">${p.profile ? `<img src="${IMG}w185${p.profile}" alt="">` : esc(initials(p.name))}</span>
      <span>${esc(p.name)}<span class="meta">Because you liked ${esc(p.because.join(" & "))}</span></span></button>`).join("")}</div>` : "";
}

// ---------- Screens ----------
function showScreen(html) {
  $("screen").innerHTML = html;
  const app = !html;
  $("addPanel").hidden = !app || view !== "runs"; $("rowwrap").hidden = !app || view !== "runs";
  $("trophyView").hidden = !app || view !== "trophies"; $("calView").hidden = !app || view !== "calendar";
  $("footer").hidden = !app && !user;
  if (!app) $("views").hidden = true;
}

function screenConfig() {
  showScreen(`<section class="panel"><h2>Almost there</h2>
    <p>This copy of the site isn't connected to a database yet. Add your Supabase project URL and anon key to <code>config.js</code>.</p></section>`);
}

function screenSignIn(msg = "") {
  showScreen(`<form class="panel" id="signInForm"><h2>Sign in</h2>
    <p>Enter your email and we'll send you a sign-in link. Each device stays signed in afterwards.</p>
    <input class="field" id="email" type="email" required autocomplete="email" placeholder="you@example.com">
    <button class="btn primary" type="submit">Send sign-in link</button>
    ${msg ? `<p class="${msg.startsWith("!") ? "err" : ""}">${esc(msg.replace(/^!/, ""))}</p>` : ""}</form>`);
  $("signInForm").addEventListener("submit", async e => {
    e.preventDefault();
    const email = $("email").value.trim();
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    screenSignIn(error ? "!" + error.message : "Check " + email + " for the link. Open it on this device.");
  });
}

function screenToken(msg = "") {
  showScreen(`<form class="panel" id="tokenForm"><h2>Connect TMDB</h2>
    <ol><li>Sign in at <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">themoviedb.org → Settings → API</a>.</li>
    <li>Copy the <b>API Read Access Token</b> (the long one) or the API Key.</li><li>Paste it here. It's saved to your account, so you only do this once.</li></ol>
    <input class="field" id="token" required autocomplete="off" placeholder="eyJhbGciOi…">
    <button class="btn primary" type="submit">Save</button>
    ${msg ? `<p class="err">${esc(msg)}</p>` : ""}</form>`);
  $("tokenForm").addEventListener("submit", async e => {
    e.preventDefault();
    tmdbToken = $("token").value.trim();
    try { await tmdb("/configuration"); }
    catch { tmdbToken = null; return screenToken("TMDB didn't accept that token. Check you copied all of it."); }
    const { error } = await sb.from("settings").upsert({ user_id: user.id, tmdb_token: tmdbToken });
    if (error) return screenToken("Couldn't save it: " + error.message);
    start();
  });
}

async function start() {
  const { data: settings, error } = await sb.from("settings").select("*").eq("user_id", user.id).maybeSingle();
  if (error) return showScreen(`<section class="panel"><h2>Database not set up</h2><p>Run <code>supabase/setup.sql</code> in the Supabase SQL editor, then reload. (${esc(error.message)})</p></section>`);
  if (!settings?.tmdb_token) return screenToken();
  tmdbToken = settings.tmdb_token;
  showScreen("");
  $("cards").innerHTML = `<div class="empty"><strong>Loading your directors…</strong>Fetching your list.</div>`;
  try { await loadData(); await seedIfNeeded(settings); await loadData(); }
  catch (err) { $("cards").innerHTML = `<div class="empty"><strong>Couldn't load your list</strong>${esc(err.message || "")}</div>`; }
}

// ---------- Events ----------
document.addEventListener("click", e => {
  if (tier && onTierClick(e)) return;
  if (e.target.id === "sheetBack") return closeSheet();
  if (e.target.closest?.("#toast")) { $("toast").hidden = true; return $("toast").dataset.kind === "trophy" && setView("trophies"); }
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.pick) { const p = searchResults[+t.dataset.pick]; return p && addDirector(p.name, p.ids); }
  if (t.id === "randomBtn" || t.id === "againBtn") return pickRandom();
  if (t.id === "dismissBtn") { suggestion = null; return renderAdd(); }
  if (t.id === "addSuggestBtn" && suggestion?.person_ids?.length) { const s = suggestion; return addDirector(s.name, s.person_ids); }
  if (t.id === "prevBtn" || t.id === "nextBtn") { const c = $("cards"); return c.scrollBy({ left: (t.id === "nextBtn" ? 1 : -1) * c.clientWidth * 0.8, behavior: "smooth" }); }
  if (t.dataset.open) { const [dir, movie] = t.dataset.open.split("|"); return openSheet(dir, +movie); }
  if (t.dataset.tick) { const id = +t.dataset.tick; return saveEntry(id, { watched: !entries.get(id)?.watched }); }
  if (t.id === "sheetTick" && open) return saveEntry(open.movie, { watched: !entries.get(open.movie)?.watched });
  if (t.id === "sheetDone") return closeSheet();
  if (t.id === "sheetPoster") return openPicker();
  if (t.id === "pickerClose") return $("picker")?.remove(), $("sheetPoster")?.focus();
  if (t.id === "pickerReset") return choosePoster("");
  if (t.dataset.poster) return choosePoster(t.dataset.poster);
  if (t.id === "sheetPrev" || t.id === "sheetNext") return stepSheet(t.id === "sheetNext" ? 1 : -1, t.id);
  if (t.dataset.view) return setView(t.dataset.view);
  if (t.dataset.tieropen) return openTier(t.dataset.tieropen);
  if (t.dataset.calyear) { calYear = +t.dataset.calyear; calDay = null; return renderCalendar(); }
  if (t.dataset.day) { calDay = calDay === t.dataset.day ? null : t.dataset.day; return renderCalendar(); }
  if (t.id === "undatedToggle") { showUndated = !showUndated; return renderCalendar(); }
  if (t.dataset.rec) { const p = recs.find(x => x.id === +t.dataset.rec); return p && addDirector(p.name, [p.id]); }
  // Rating a film marks it watched; tapping the current rating clears it.
  if (t.dataset.rate && open) { const n = +t.dataset.rate, cur = entries.get(open.movie)?.rating || 0;
    return saveEntry(open.movie, n === cur ? { rating: 0 } : { rating: n, watched: true }); }
  if (t.id === "sheetHide" && open) { const id = open.movie, hide = !entries.get(id)?.hidden; closeSheet(); return saveEntry(id, { hidden: hide }); }
  if (t.dataset.showremoved) { const id = t.dataset.showremoved; showRemoved.has(id) ? showRemoved.delete(id) : showRemoved.add(id); return render(); }
  if (t.id === "signOutBtn") return sb.auth.signOut().then(() => location.reload());
  if (t.dataset.remove) {
    if (t.classList.contains("armed")) return removeDirector(t.dataset.remove);
    t.classList.add("armed"); t.textContent = "Tap again to remove this director";
    setTimeout(() => { if (t.isConnected) { t.classList.remove("armed"); t.textContent = "Remove director"; } }, 4000);
  }
});
document.addEventListener("change", e => {
  if (e.target.id === "watchedOn" && open) return saveEntry(open.movie, { on: e.target.value });
  if (e.target.dataset.datefor && e.target.value) saveEntry(+e.target.dataset.datefor, { on: e.target.value });
});
// Dragging posters between tier rows (mouse); on touch screens it's tap-to-move.
document.addEventListener("dragstart", e => {
  const c = e.target.closest?.("[data-tierfilm]");
  if (c) { e.dataTransfer.setData("text/plain", c.dataset.tierfilm); e.dataTransfer.effectAllowed = "move"; }
});
document.addEventListener("dragover", e => { if (tier && e.target.closest?.(".tier-row")) e.preventDefault(); });
document.addEventListener("drop", e => {
  const row = tier && e.target.closest?.(".tier-row");
  if (!row) return;
  e.preventDefault();
  const id = +e.dataTransfer.getData("text/plain"), before = e.target.closest("[data-tierfilm]");
  if (id) moveTier(id, row.dataset.tier, before && +before.dataset.tierfilm !== id ? +before.dataset.tierfilm : null);
});
document.addEventListener("keydown", e => {
  if (tier) { if (e.key === "Escape") closeTier(); return; }
  if (!open) { if (e.key === "Escape" && view !== "runs") setView("runs"); return; }
  if (e.key === "Escape") { if ($("picker")) { $("picker").remove(); $("sheetPoster")?.focus(); } else closeSheet(); return; }
  if ($("picker")) return;
  if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.target.id !== "noteInput") { e.preventDefault(); stepSheet(e.key === "ArrowRight" ? 1 : -1); }
  if (e.key === "Enter" && e.target.id === "noteInput" && !e.shiftKey) { e.preventDefault(); closeSheet(); }
});
$("search").addEventListener("input", onSearch);
// Swipe sideways on the film sheet to step through the director's films.
let swipe = null;
$("sheetBack").addEventListener("touchstart", e => { swipe = e.target.closest("textarea") ? null : { x: e.touches[0].clientX, y: e.touches[0].clientY }; }, { passive: true });
$("sheetBack").addEventListener("touchend", e => {
  if (!swipe) return;
  const dx = e.changedTouches[0].clientX - swipe.x, dy = e.changedTouches[0].clientY - swipe.y;
  swipe = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) stepSheet(dx < 0 ? 1 : -1);
}, { passive: true });
$("cards").addEventListener("scroll", updateNav, { passive: true });
// Drag the director row sideways with the mouse (touch screens already swipe natively).
{
  const row = $("cards");
  let drag = null, glide = 0;
  row.addEventListener("pointerdown", e => {
    if (e.pointerType !== "mouse" || e.button !== 0 || e.target.closest("input, textarea")) return;
    cancelAnimationFrame(glide);
    drag = { x: e.clientX, left: row.scrollLeft, moved: false, v: 0, lx: e.clientX, lt: performance.now() };
  });
  addEventListener("pointermove", e => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 6) return;
    if (!drag.moved) { drag.moved = true; row.classList.add("dragging"); }
    row.scrollLeft = drag.left - dx;
    // keep a smoothed velocity so letting go carries the row on a little
    const now = performance.now(), dt = Math.max(1, now - drag.lt);
    drag.v = 0.8 * ((drag.lx - e.clientX) / dt) + 0.2 * drag.v;
    drag.lx = e.clientX; drag.lt = now;
  });
  addEventListener("pointerup", () => {
    if (!drag) return;
    const { moved, lt } = drag;
    let v = performance.now() - lt > 80 ? 0 : drag.v;   // paused before letting go: no glide
    drag = null;
    row.classList.remove("dragging");
    // A drag shouldn't also count as a click on whatever poster it started on.
    if (!moved) return;
    let last = performance.now();
    const step = now => {
      row.scrollLeft += v * (now - last);
      v *= Math.pow(0.95, (now - last) / 16);
      last = now;
      if (Math.abs(v) > 0.02) glide = requestAnimationFrame(step);
    };
    glide = requestAnimationFrame(step);
    const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); };
    addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => removeEventListener("click", swallow, { capture: true }), 0);
  });
  row.addEventListener("dragstart", e => e.preventDefault());
}
addEventListener("resize", updateNav);
// Pick up changes made on another device when you come back to this tab.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && user && tmdbToken && !open && !tier) loadData().catch(() => {}); });

// ---------- Boot ----------
(async () => {
  const cfg = window.DR_CONFIG || {};
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) return screenConfig();
  sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const { data } = await sb.auth.getSession();
  user = data.session?.user || null;
  sb.auth.onAuthStateChange((_event, session) => {
    const was = user?.id;
    user = session?.user || null;
    if (user && user.id !== was) start();
  });
  if (user) start(); else screenSignIn();
})();
