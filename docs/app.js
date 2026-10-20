// Movie Challenges — filmographies from TMDB, progress saved per user in Supabase.

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
// Drop film lists cached by older versions of the site.
try { Object.keys(localStorage).filter(k => /^dr-films2?-/.test(k)).forEach(k => localStorage.removeItem(k)); } catch {}
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
let challenges = [], challengesErr = "";   // decade challenges; the error is set when the table is missing
const entries = new Map();     // movie_id -> {watched, note}
let suggestion = null;         // {name, person_ids, films, loading}
let searchSeq = 0, searchResults = [], lookupMsg = "";
let open = null;               // {dir, movie}

// ---------- TMDB ----------
let tmdbBusy = 0;
const tmdbQueue = [];
const tmdbSlot = () => tmdbBusy < 6 ? (tmdbBusy++, Promise.resolve()) : new Promise(r => tmdbQueue.push(r));
const tmdbFree = () => { const next = tmdbQueue.shift(); next ? next() : tmdbBusy--; };
async function tmdb(path, params = {}) {
  const u = new URL("https://api.themoviedb.org/3" + path);
  const v3 = /^[0-9a-f]{32}$/i.test(tmdbToken);
  if (v3) u.searchParams.set("api_key", tmdbToken);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const headers = v3 ? { accept: "application/json" } : { accept: "application/json", Authorization: "Bearer " + tmdbToken };
  let res;
  // TMDB rate-limits bursts (many directors loading at once), and its 429s often arrive without CORS headers,
  // so they surface as network errors. Keep few requests in flight and retry either kind.
  await tmdbSlot();
  try {
    for (let attempt = 0; ; attempt++) {
      try { res = await fetch(u, { headers }); } catch (err) { if (attempt >= 4) throw err; res = null; }
      if (res && res.status !== 429) break;
      if (res && attempt >= 4) break;
      await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
    }
  } finally { tmdbFree(); }
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
  const fresh = local.get("dr-rt", {});
  fresh[id] = m.runtime || 0;
  local.set("dr-rt", fresh);
  return fresh[id];
}

// A director's films: everything they're credited as Director on, minus shorts and video releases.
async function loadFilms(personIds, { fresh = false } = {}) {
  const key = "dr-films3-" + personIds.join("+");
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
  const [d, e, c] = await Promise.all([
    sb.from("directors").select("*").order("added_at"),
    sb.from("entries").select("*"),
    sb.from("challenges").select("*").order("created_at")
  ]);
  if (d.error) throw d.error;
  if (e.error) throw e.error;
  // The challenges table came later; without it everything else still works.
  challenges = c.error ? [] : c.data.map(r => ({ ...r, picks: r.picks || {} }));
  challengesErr = c.error ? c.error.message : "";
  const old = new Map(directors.map(x => [x.id, x]));
  // Cards you've arranged come first in your order; the rest follow by when they were added.
  directors = d.data.map(r => ({ ...r, films: old.get(r.id)?.films || null }))
    .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
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
  announceNew(before);
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

// Swap a director with its neighbour (delta -1 = left, 1 = right) and save the new order.
async function moveDirector(id, delta) {
  const i = directors.findIndex(d => d.id === id), j = i + delta;
  if (i < 0 || j < 0 || j >= directors.length) return;
  [directors[i], directors[j]] = [directors[j], directors[i]];
  const changed = directors.filter((d, k) => d.position !== k);
  changed.forEach(d => { d.position = directors.indexOf(d); });
  render();
  const btn = document.querySelector(`[data-move="${id}|${delta}"]`);
  (btn && !btn.disabled ? btn : document.querySelector(`[data-move^="${id}|"]:not(:disabled)`))?.focus();
  $("cards").children[j]?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  const results = await Promise.all(changed.map(d => sb.from("directors").update({ position: d.position }).eq("id", d.id)));
  const error = results.find(r => r.error)?.error;
  if (error) notify(/position/.test(error.message)
    ? "Couldn't save the order: run supabase/setup.sql in Supabase to add the position column."
    : "Couldn't save the order. " + error.message);
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
function completedIds() {
  return new Set([...directors.filter(d => progressOf(d).done).map(d => d.id),
                  ...challenges.filter(c => challengeProgress(c).done).map(c => "c:" + c.id)]);
}
// Celebrate anything completed since `before`; a finished director then gets a tier list.
function announceNew(before) {
  const id = [...completedIds()].find(x => !before.has(x));
  const fresh = id && sourceById(id);
  if (!fresh) return;
  celebrate(fresh);
  if (!fresh.kind) setTimeout(() => { if (!tier && view === "runs") { closeSheet(); openTier(fresh.id, true); } }, 1600);
}

let view = "home";        // "home", "runs" (director cards), "decades" or "stats"
let statsTab = "trophies";  // "trophies", "numbers" or "calendar"
let appOn = false;        // signed in with the app showing (not a sign-in or setup screen)
let startAtEnd = true;
const VIEW_TITLES = { runs: "Director Runs", decades: "Decade Challenges", stats: "My stats" };
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function shelf() {
  const won = completedIds().size;
  $("statsBtn").hidden = !appOn;
  $("statsBtn").classList.toggle("on", view === "stats");
  $("trophyCount").textContent = won;
  $("statsBtn").setAttribute("aria-label", `My stats, ${plural(won, "trophy", "trophies")}`);
  if (!appOn) return;
  if (view === "home") renderHome();
  if (view === "decades") renderDecades();
  if (view === "stats") renderStats();
}

function applyView() {
  const off = v => !appOn || view !== v;
  $("homeView").hidden = off("home");
  $("addPanel").hidden = off("runs"); $("rowwrap").hidden = off("runs");
  $("decView").hidden = off("decades"); $("decWrap").hidden = off("decades");
  $("statsView").hidden = off("stats");
  $("crumb").hidden = !appOn || view === "home";
  $("crumb").innerHTML = `<button class="linkbtn back" type="button" data-go="home">‹ All challenges</button><h2>${VIEW_TITLES[view] || ""}</h2>`;
  document.title = VIEW_TITLES[view] ? `${VIEW_TITLES[view]} · Movie Challenges` : "Movie Challenges";
}

// Each view has its own address (#runs, #decades, #stats/calendar…), so the back button and bookmarks work.
const viewHash = () => view === "home" ? "" : "#" + view + (view === "stats" ? "/" + statsTab : "");
function viewFromHash() {
  const [v, t] = location.hash.slice(1).split("/");
  if (["trophies", "numbers", "calendar"].includes(t)) statsTab = t;
  return VIEW_TITLES[v] ? v : "home";
}
function setView(v, { push = true } = {}) {
  view = VIEW_TITLES[v] ? v : "home";
  if (push && location.hash !== viewHash()) history.pushState(null, "", viewHash() || location.pathname + location.search);
  applyView();
  shelf();
  if (view === "runs") updateNav();
  if (view === "stats" && statsTab === "calendar") scrollCalendar();
  window.scrollTo({ top: 0 });
}
function setStatsTab(t) {
  statsTab = t;
  history.replaceState(null, "", viewHash());
  renderStats();
  if (t === "calendar") scrollCalendar();
}
const scrollCalendar = () => { const w = document.querySelector(".cal-scroll"); if (w) w.scrollLeft = w.scrollWidth; };

// ---------- Home ----------
function renderHome() {
  const runs = directors.map(progressOf);
  const seen = runs.reduce((a, p) => a + p.watched, 0), total = runs.reduce((a, p) => a + p.released.length, 0);
  const decs = challenges.map(challengeProgress);
  const decDone = decs.filter(p => p.done).length;
  const runBg = topFilm(directors.flatMap(d => d.films || []));
  let decBg = topFilm(challenges.flatMap(challengeFilms));
  if (!decBg) {
    const cached = local.get("dr-dec-1960", null);
    decBg = cached && topFilm(cached.films);
    if (!cached) decadePool(1960).then(() => { if (view === "home") renderHome(); }).catch(() => {});
  }
  const card = (go, n, title, desc, stats, bg) => `<button class="hcard" type="button" data-go="${go}">
      <span class="hbg">${bg ? `<img src="${IMG}w1280${bg.backdrop}" alt="">` : ""}</span>
      <span class="hbody"><span class="eyebrow">Challenge ${n}</span><strong>${title}</strong>
        <span class="hdesc">${desc}</span><span class="hstats">${stats}</span></span></button>`;
  $("homeView").innerHTML = `<div class="home-grid">
    ${card("runs", "01", "Director Runs", "Watch every film a director has made.",
      directors.length ? `${plural(directors.length, "director")} · ${seen} / ${total} films · ${plural(directors.filter(d => progressOf(d).done).length, "trophy", "trophies")}` : "Start your first run",
      runBg)}
    ${card("decades", "02", "Decade Challenges", "Pick a span of decades and watch one film from each.",
      challenges.length ? `${plural(challenges.length, "challenge")} · ${decs.reduce((a, p) => a + p.watched, 0)} / ${decs.reduce((a, p) => a + p.slots.length, 0)} films · ${plural(decDone, "trophy", "trophies")}` : "Start your first challenge",
      decBg)}
  </div>`;
}

// ---------- My stats ----------
function renderStats() {
  document.querySelectorAll("[data-stab]").forEach(b => {
    const on = b.dataset.stab === statsTab;
    b.classList.toggle("on", on); b.setAttribute("aria-selected", on);
  });
  $("trophyView").hidden = statsTab !== "trophies"; $("numbersView").hidden = statsTab !== "numbers"; $("calView").hidden = statsTab !== "calendar";
  if (statsTab === "trophies") renderTrophies();
  if (statsTab === "numbers") renderNumbers();
  if (statsTab === "calendar") renderCalendar();
}

// Favourite, completion date and best still for a finished set of films.
function setSummary(films) {
  const rated = films.map(f => entries.get(f.id)?.rating || 0).filter(Boolean);
  return {
    top: topFilm(films),
    avg: rated.length ? rated.reduce((a, b) => a + b, 0) / rated.length : 0,
    fav: films.map(f => ({ f, r: entries.get(f.id)?.rating || 0 })).filter(x => x.r).sort((a, b) => b.r - a.r || b.f.votes - a.f.votes)[0],
    at: films.map(f => entries.get(f.id)?.at || "").sort().pop()
  };
}

function renderTrophies() {
  const fmt = iso => iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "";
  const won = directors.filter(d => progressOf(d).done);
  const wonDec = challenges.filter(c => challengeProgress(c).done);
  if (won.length) loadPhotos(won.flatMap(d => d.person_ids)).then(changed => { if (changed && view === "stats" && statsTab === "trophies") renderTrophies(); }).catch(() => {});
  const body = (s, extra) => `
      <div class="tbody">
        <h3>${esc(s.title)}</h3>
        <div class="tmeta">${s.count}${s.at ? ` · completed ${fmt(s.at)}` : ""}</div>
        ${s.avg ? `<div class="tavg">${starsHtml(Math.round(s.avg))}<span>${s.avg.toFixed(1)} average</span></div>` : ""}
        ${s.fav ? `<div class="tfav"><span>Favourite</span>${esc(s.fav.f.t)} <small>${s.fav.f.y}</small></div>` : ""}
        ${extra}
      </div>`;
  const banner = top => `<div class="tbanner">${top ? `<img src="${IMG}w780${top.backdrop}" alt="">` : ""}</div>`;
  const dirCards = won.map(d => {
    const { released } = progressOf(d), s = setSummary(released);
    return `<article class="tcard">${banner(s.top)}
      <div class="medal${d.person_ids.length > 1 ? " duo" : ""}">${d.person_ids.map(id => photos[id]
        ? `<img src="${IMG}w185${photos[id]}" alt="">` : `<span class="ini">${esc(initials(d.name))}</span>`).join("")}
        <span class="medal-badge">${TROPHY}</span></div>
      ${body({ ...s, title: d.name, count: plural(released.length, "film") }, `${miniTiers(d)}
        <button class="btn tier-open" type="button" data-tieropen="${d.id}">${hasTiers(d) ? "Edit tier list" : "Make a tier list"}</button>`)}
    </article>`;
  }).join("");
  const decCards = wonDec.map(c => {
    const films = challengeFilms(c), s = setSummary(films);
    return `<article class="tcard">${banner(s.top)}
      <div class="medal"><span class="ini dec">${shortDec(c.start_decade)}<i>to</i>${shortDec(c.end_decade)}</span>
        <span class="medal-badge">${TROPHY}</span></div>
      ${body({ ...s, title: challengeTitle(c), count: plural(films.length, "decade") }, `<div class="dec-films">${decadesOf(c).map(d => {
        const f = c.picks[d];
        return `<span class="mini" title="${decadeLabel(d)}: ${esc(f.t)} (${f.y})">${posterHtml(f, "w92")}</span>`;
      }).join("")}</div>`)}
    </article>`;
  }).join("");
  // Nothing won yet in a section: point at the closest one instead.
  const closestDir = directors.map(d => ({ d, ...progressOf(d) })).filter(x => x.d.films && x.released.length)
    .sort((a, b) => (a.released.length - a.watched) - (b.released.length - b.watched))[0];
  const closestDec = challenges.map(c => ({ c, ...challengeProgress(c) }))
    .sort((a, b) => (a.slots.length - a.watched) - (b.slots.length - b.watched))[0];
  const section = (title, cards, n, emptyMsg) => `<section class="tsec"><h2 class="tv-title">${title}<small>${n}</small></h2>
    ${cards ? `<div class="trophies">${cards}</div>` : `<div class="empty"><strong>No trophies yet</strong>${emptyMsg}</div>`}</section>`;
  $("trophyView").innerHTML =
    section("Director Runs", dirCards, won.length, `Watch every film by a director to win one.${closestDir
      ? `<br>Closest: ${esc(closestDir.d.name)}, ${closestDir.released.length - closestDir.watched} to go.` : ""}`) +
    section("Decade Challenges", decCards, wonDec.length, `Watch one film from every decade in a challenge to win one.${closestDec
      ? `<br>Closest: ${esc(challengeTitle(closestDec.c))}, ${closestDec.slots.length - closestDec.watched} to go.` : ""}`);
}

const rtTried = new Set();
// Totals plus two small bar lists: your ratings and the decades your films come from.
function renderNumbers() {
  const all = watchedFilms();
  const rt = local.get("dr-rt", {}), md = local.get("dr-md", {});
  // Look up runtimes we don't have yet, once per visit (a failed lookup isn't retried in a loop).
  const missing = all.filter(x => !(x.f.id in rt) && !md[x.f.id]?.rt && !rtTried.has(x.f.id)).map(x => x.f.id);
  missing.forEach(id => rtTried.add(id));
  if (missing.length) pool(missing, 4, runtimeOf).then(() => { if (view === "stats" && statsTab === "numbers") renderNumbers(); });
  let mins = 0, timed = 0;
  for (const x of all) { const m = rt[x.f.id] || md[x.f.id]?.rt || 0; if (m) { mins += m; timed++; } }
  const rated = all.map(x => entries.get(x.f.id)?.rating || 0).filter(Boolean);
  const avg = rated.length ? rated.reduce((a, b) => a + b, 0) / rated.length : 0;
  const byDec = new Map();
  for (const x of all) { const d = decadeOf(+x.f.y); if (d) byDec.set(d, (byDec.get(d) || 0) + 1); }
  const decs = DECADES.filter(d => d >= Math.min(...byDec.keys()) && d <= Math.max(...byDec.keys()));
  const most = directors.map(d => ({ d, n: progressOf(d).watched })).sort((a, b) => b.n - a.n)[0];
  const bars = (rows, label) => {
    const max = Math.max(1, ...rows.map(r => r[1]));
    return rows.map(([k, n]) => `<div class="bar-row" title="${esc(k)}: ${plural(n, "film")}">
      <span class="bar-label">${esc(k)}</span>
      <span class="bar-track">${n ? `<span class="bar" style="width:${(n / max * 100).toFixed(1)}%"></span>` : ""}</span>
      <span class="bar-val">${n}</span></div>`).join("") || `<p class="hint">${label}</p>`;
  };
  const tile = (big, label, sub = "") => `<div class="tile"><b>${big}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ""}</div>`;
  $("numbersView").innerHTML = `
    <div class="tiles">
      ${tile(all.length, "films watched")}
      ${tile(Math.round(mins / 60), "hours watched", timed < all.length ? `counting ${timed} of ${all.length} films` : "")}
      ${tile(avg ? "★ " + avg.toFixed(1) : "–", "average rating", rated.length ? `over ${plural(rated.length, "rated film")}` : "")}
      ${tile(completedIds().size, "trophies won")}
      ${most?.n ? tile(most.n, esc(most.d.name), "your most watched director") : ""}
    </div>
    <div class="charts">
      <div class="chart"><h3>Your ratings</h3>${rated.length ? bars([5, 4, 3, 2, 1].map(n => ["★".repeat(n), rated.filter(r => r === n).length]), "")
        : `<p class="hint">Rate films in their details to see your spread here.</p>`}</div>
      <div class="chart"><h3>Films by decade</h3>${bars(decs.map(d => [decadeLabel(d), byDec.get(d) || 0]), "Watched films show up here by decade.")}</div>
    </div>`;
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
  const films = d.kind ? challengeFilms(d.c) : progressOf(d).released, { avg } = setSummary(films);
  const t = $("toast");
  t.dataset.kind = "trophy";
  t.innerHTML = `<span class="toast-icon">${TROPHY}</span><span><b>Trophy unlocked</b>${esc(d.name)} · all ${films.length} films${avg ? ` · avg ★ ${avg.toFixed(1)}` : ""}</span>`;
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
  // The first time the cards appear, start at the end of the row so the last director is in view.
  const scroll = startAtEnd ? Infinity : cards.scrollLeft;
  startAtEnd = false;
  cards.innerHTML = directors.map((d, idx) => {
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
        <span class="foot-left">
          ${directors.length > 1 ? `<span class="move">
            <button class="move-btn" type="button" data-move="${d.id}|-1" ${idx === 0 ? "disabled" : ""} aria-label="Move ${esc(d.name)} left">‹</button>
            <button class="move-btn" type="button" data-move="${d.id}|1" ${idx === directors.length - 1 ? "disabled" : ""} aria-label="Move ${esc(d.name)} right">›</button></span>` : ""}
          ${removed ? `<button class="linkbtn" type="button" data-showremoved="${d.id}">${showRemoved.has(d.id) ? "Hide" : "Show"} ${removed} removed</button>` : ""}
        </span>
        <button class="linkbtn" type="button" data-remove="${d.id}">Remove director</button></div>
    </article>`;
  }).join("");
  cards.scrollLeft = Math.min(scroll, cards.scrollWidth);
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
  const d = sourceById(dirId);
  const f = d?.films?.find(x => x.id === movieId);
  return f ? { d, f } : null;
}
// The films the sheet steps through: what the director's card is showing.
function sheetList(d) {
  if (d.kind) return d.films;
  const all = d.films || [];
  return showRemoved.has(d.id) ? all : all.filter(f => !isHidden(f));
}
function openSheet(dirId, movieId, focusId = "sheetDone") {
  const hit = findFilm(dirId, movieId);
  if (!hit) return;
  open = { dir: dirId, movie: movieId };
  const { d, f } = hit, e = entries.get(f.id) || {};
  const list = sheetList(d), i = list.findIndex(x => x.id === f.id);
  // "Removed" only applies to director lists; a challenge pick can be swapped instead.
  const hid = !d.kind && e.hidden;
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
      ${hid ? `<p class="hint take">Removed from this list, so it doesn't count toward progress.</p>` : `
      <section class="take" aria-label="Your take">
        <div class="take-row">
          <div class="rate" role="group" aria-label="Your rating">${[1, 2, 3, 4, 5].map(n =>
            `<button type="button" data-rate="${n}" aria-label="${n} star${n > 1 ? "s" : ""}">★</button>`).join("")}</div>
          <label class="watched-on" id="watchedOnWrap" hidden>Watched <input type="date" id="watchedOn" max="${today()}"></label>
        </div>
        <textarea id="noteInput" maxlength="500" placeholder="Your note: a short thought on it" aria-label="Your note">${esc(e.note || "")}</textarea>
      </section>`}
      <div class="sheet-foot">
        ${d.kind ? `<button class="linkbtn" type="button" id="sheetSwap">Swap film</button>`
          : `<button class="linkbtn" type="button" id="sheetHide">${hid ? "Put back in the list" : "Remove from list"}</button>`}
        <span class="foot-right">${hid ? "" : `<button class="btn watch-toggle" type="button" id="sheetTick"></button>`}
        <button class="btn primary" type="button" id="sheetDone">Done</button></span>
      </div>
    </div></div>`;
  $("sheetBack").hidden = false;
  lockScroll();
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
  const d = sourceById(open.dir), list = d ? sheetList(d) : [];
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
  lockScroll();
}
// Keep the page behind an open film sheet or tier list from scrolling.
function lockScroll() {
  document.documentElement.classList.toggle("modal-open", !$("sheetBack").hidden || !$("tierBack").hidden || !$("slotBack").hidden);
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
  lockScroll();
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
  lockScroll();
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
  for (const c of challenges) {
    const src = challengeSource(c);
    for (const f of src.films) { const e = entries.get(f.id); if (e?.watched && !seen.has(f.id)) seen.set(f.id, { f, d: src, on: e.on || "" }); }
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

// ---------- Decade challenges ----------
// One film from each decade in a span; 1910 stands for everything before 1920.
const DECADES = Array.from({ length: 12 }, (_, i) => 1910 + i * 10);
const MIN_DECADES = 4;
const decadeLabel = d => d === 1910 ? "Pre-1920s" : d + "s";
const shortDec = d => d === 1910 ? "<1920" : "’" + String(d).slice(2) + "s";
const decadeOf = y => y ? Math.max(1910, Math.floor(y / 10) * 10) : null;
const decadesOf = c => DECADES.filter(d => d >= c.start_decade && d <= c.end_decade);
const challengeTitle = c => `${decadeLabel(c.start_decade)} – ${decadeLabel(c.end_decade)}`;
const challengeFilms = c => decadesOf(c).map(d => c.picks[d]).filter(Boolean);
const challengeSource = c => ({ id: "c:" + c.id, kind: "decades", c, name: challengeTitle(c), films: challengeFilms(c) });
function sourceById(id) {
  if (!String(id).startsWith("c:")) return directors.find(x => x.id === id);
  const c = challenges.find(x => "c:" + x.id === id);
  return c && challengeSource(c);
}
function challengeProgress(c) {
  const slots = decadesOf(c), films = challengeFilms(c);
  const watched = films.filter(f => entries.get(f.id)?.watched).length;
  return { slots, films, watched, done: films.length === slots.length && watched === slots.length };
}
const snap = m => ({ id: m.id, t: m.title, y: (m.release_date || "").slice(0, 4), date: m.release_date || "",
  poster: m.poster_path || "", backdrop: m.backdrop_path || "", votes: m.vote_count || 0, overview: m.overview || "" });

// The best-known feature films of a decade, for random picks and the picker's suggestions; cached a week.
async function decadePool(d) {
  const key = "dr-dec-" + d, hit = local.get(key, null);
  if (hit && Date.now() - hit.at < 7 * 864e5) return hit.films;
  const params = { sort_by: "vote_count.desc", "with_runtime.gte": 60, "vote_count.gte": d < 1930 ? 40 : 200,
    "primary_release_date.lte": d === 2020 ? today() : `${d + 9}-12-31`, include_adult: false };
  if (d !== 1910) params["primary_release_date.gte"] = `${d}-01-01`;
  const pages = await Promise.all([1, 2, 3].map(page => tmdb("/discover/movie", { ...params, page }).catch(() => ({ results: [] }))));
  const byId = new Map();
  for (const m of pages.flatMap(p => p.results || [])) if (m.poster_path && !byId.has(m.id)) byId.set(m.id, snap(m));
  const films = [...byId.values()];
  if (films.length) local.set(key, { at: Date.now(), films });
  return films;
}

// A random well-known film from the decade you haven't seen, and that isn't already in this challenge.
async function randomPick(c, d) {
  const used = new Set(challengeFilms(c).map(f => f.id));
  const options = (await decadePool(d)).filter(f => !used.has(f.id));
  const unseen = options.filter(f => !entries.get(f.id)?.watched);
  const list = unseen.length ? unseen : options;
  return list[Math.floor(Math.random() * list.length)] || null;
}

async function savePicks(c, picks) {
  const prev = c.picks, before = completedIds();
  c.picks = picks;
  render();
  announceNew(before);
  const { error } = await sb.from("challenges").update({ picks }).eq("id", c.id);
  if (error) { c.picks = prev; render(); notify("Couldn't save that pick. " + error.message); }
}
function setPick(c, d, film) {
  const picks = { ...c.picks };
  if (film) picks[d] = film; else delete picks[d];
  return savePicks(c, picks);
}
async function fillRandom(c) {
  const picks = { ...c.picks };
  for (const d of decadesOf(c)) if (!picks[d]) {
    const f = await randomPick({ ...c, picks }, d).catch(() => null);
    if (f) picks[d] = f;
  }
  return savePicks(c, picks);
}

let decFrom = 1950, decTo = 2020;
const decSpan = () => DECADES.filter(d => d >= decFrom && d <= decTo).length;
async function createChallenge() {
  if (decSpan() < MIN_DECADES) return;
  const { data, error } = await sb.from("challenges").insert({ kind: "decades", start_decade: decFrom, end_decade: decTo, picks: {} }).select().single();
  if (error) return notify("Couldn't start the challenge. " + error.message);
  challenges.push({ ...data, picks: data.picks || {} });
  render();
  requestAnimationFrame(() => { const r = $("decCards"); r.scrollTo({ left: r.scrollWidth, behavior: "smooth" }); });
}
async function removeChallenge(id) {
  const { error } = await sb.from("challenges").delete().eq("id", id);
  if (error) return notify("Couldn't remove the challenge. " + error.message);
  challenges = challenges.filter(c => c.id !== id);
  render();
}

function updateDecForm() {
  const n = decSpan(), btn = $("decCreate");
  if (!btn) return;
  btn.disabled = n < MIN_DECADES;
  $("decHint").textContent = decTo < decFrom ? "The end decade has to come after the start."
    : n < MIN_DECADES ? `That's ${plural(n, "decade")}. A challenge spans at least ${MIN_DECADES}.`
    : `${n} decades, one film from each.`;
}

function renderDecades() {
  if (challengesErr) {
    $("decNew").innerHTML = `<section class="panel setup"><h2>One more step</h2>
      <p>Decade challenges need a new table. In Supabase, open <b>SQL Editor</b>, run <code>supabase/setup.sql</code> again (it's safe to re-run), then reload.</p>
      <p class="hint">${esc(challengesErr)}</p></section>`;
    $("decCards").innerHTML = "";
    return;
  }
  // Leave the form alone while you're using it.
  if (!$("decNew").contains(document.activeElement) || !$("decCreate")) {
    const opts = sel => DECADES.map(d => `<option value="${d}"${d === sel ? " selected" : ""}>${decadeLabel(d)}</option>`).join("");
    $("decNew").innerHTML = `<div class="dec-new">
      <span class="recs-label">New challenge</span>
      <div class="add-row">
        <label>From <select class="field" id="decFrom">${opts(decFrom)}</select></label>
        <label>to <select class="field" id="decTo">${opts(decTo)}</select></label>
        <button class="btn primary" type="button" id="decCreate">Start challenge</button>
      </div>
      <p class="hint" id="decHint"></p></div>`;
    updateDecForm();
  }
  const row = $("decCards"), scroll = row.scrollLeft;
  row.innerHTML = challenges.length ? challenges.map(c => {
    const { slots, films, watched, done } = challengeProgress(c);
    const top = topFilm(films), avg = setSummary(films.filter(f => entries.get(f.id)?.watched)).avg;
    const empty = slots.length - films.length;
    const tiles = slots.map(d => {
      const f = c.picks[d];
      if (!f) return `<div class="poster"><button class="art slot" type="button" data-slot="${c.id}|${d}" aria-label="Pick a film from the ${decadeLabel(d)}">
          <span class="slot-dec">${decadeLabel(d)}</span><span class="slot-plus" aria-hidden="true">+</span><span class="slot-hint">Pick a film</span></button></div>`;
      const w = !!entries.get(f.id)?.watched;
      return `<div class="poster${w ? " watched" : ""}">
        <button class="art" type="button" data-open="c:${c.id}|${f.id}" aria-label="${decadeLabel(d)}: ${esc(f.t)} (${f.y})">
          <span class="hover-title" aria-hidden="true">${esc(f.t)} (${f.y})</span>
          ${posterHtml(f)}<span class="flag">${decadeLabel(d)}</span>
        </button>
        <button class="tick" type="button" data-tick="${f.id}" aria-pressed="${w}" aria-label="${w ? "Mark as not watched" : "Mark as watched"}: ${esc(f.t)}">✓</button>
      </div>`;
    }).join("");
    return `<article class="card${done ? " done" : ""}">
      <div class="banner">${top ? `<img src="${IMG}w780${top.backdrop}" alt="Still from ${esc(top.t)}">` : `<div class="initials">${shortDec(c.start_decade)}</div>`}
        <div class="cap"><h2>${esc(challengeTitle(c))}</h2><div class="count"><b>${watched}</b> / ${slots.length}</div></div>
        ${done ? `<span class="badge" title="Every decade watched">${TROPHY}${avg ? `★ ${avg.toFixed(1)}` : "Complete"}</span>` : ""}
      </div>
      <div class="strip" role="progressbar" aria-valuemin="0" aria-valuemax="${slots.length}" aria-valuenow="${watched}" aria-label="${esc(challengeTitle(c))} progress">
        <div class="frames">${slots.map(d => `<span class="frame${c.picks[d] && entries.get(c.picks[d].id)?.watched ? " on" : ""}" title="${decadeLabel(d)}"></span>`).join("")}</div>
      </div>
      <div class="posters">${tiles}</div>
      <div class="card-foot">
        <span class="foot-left">${empty ? `<button class="linkbtn accent" type="button" data-fillrandom="${c.id}">Fill ${empty === 1 ? "the empty slot" : `${empty} empty slots`} at random</button>` : ""}</span>
        <button class="linkbtn" type="button" data-removechal="${c.id}">Remove challenge</button></div>
    </article>`;
  }).join("") : `<div class="empty"><strong>No challenges yet</strong>Choose a span of decades above to start one.</div>`;
  row.scrollLeft = scroll;
}

// Picker for one decade slot: popular films from that decade, a search, or a random pick.
let slot = null;   // {cid, d, q, results, pool, seq}
let slotTimer = null;
async function openSlot(cid, d) {
  const c = challenges.find(x => x.id === cid);
  if (!c) return;
  slot = { cid, d, q: "", results: null, pool: null, seq: 0 };
  renderSlot();
  $("slotBack").hidden = false;
  lockScroll();
  (matchMedia("(pointer: fine)").matches ? $("slotSearch") : $("slotClose")).focus();
  let list = [];
  try { list = await decadePool(d); } catch {}
  if (slot?.cid === cid && slot.d === d) { slot.pool = list; renderSlotGrid(); }
}
function renderSlot() {
  const c = challenges.find(x => x.id === slot.cid), cur = c.picks[slot.d];
  $("slotBack").innerHTML = `<div class="sheet slot-sheet" role="dialog" aria-modal="true" aria-labelledby="slotTitle">
    <div class="slot-top">
      <div><span class="eyebrow">${esc(challengeTitle(c))}</span><h3 id="slotTitle">Pick a film from the ${decadeLabel(slot.d)}</h3></div>
      <button class="btn primary" type="button" id="slotClose">Close</button>
    </div>
    <div class="add-row">
      <input class="field" id="slotSearch" type="search" placeholder="Search the ${decadeLabel(slot.d)}" autocomplete="off" aria-label="Search films from the ${decadeLabel(slot.d)}">
      <button class="btn" type="button" id="slotRandom">Random pick</button>
    </div>
    ${cur ? `<p class="hint">Current pick: ${esc(cur.t)} (${cur.y}) · <button class="linkbtn accent" type="button" id="slotClear">Empty this slot</button></p>` : ""}
    <span class="recs-label" id="slotLabel"></span>
    <div class="picker-grid" id="slotGrid"></div>
  </div>`;
  renderSlotGrid();
}
function renderSlotGrid() {
  const c = challenges.find(x => x.id === slot.cid), cur = c.picks[slot.d];
  const used = new Set(challengeFilms(c).map(f => f.id));
  const searching = slot.q.length >= 2, list = searching ? slot.results : slot.pool;
  $("slotLabel").textContent = searching ? "Search results" : `Well known from the ${decadeLabel(slot.d)}`;
  $("slotGrid").innerHTML = !list ? `<p class="hint">${searching ? "Searching…" : "Loading films…"}</p>`
    : !list.length ? `<p class="hint">${searching ? `No films from the ${decadeLabel(slot.d)} match “${esc(slot.q)}”.` : "TMDB didn't return any films."}</p>`
    : list.map(f => {
      const taken = used.has(f.id) && cur?.id !== f.id, seen = entries.get(f.id)?.watched;
      return `<button class="pick${cur?.id === f.id ? " on" : ""}" type="button" data-slotpick="${f.id}" ${taken ? "disabled" : ""} title="${esc(f.t)} (${f.y})">
        ${f.poster ? `<img src="${IMG}w185${f.poster}" alt="" loading="lazy">` : placeholder(f)}
        ${taken ? `<span>In use</span>` : seen ? `<span>Seen</span>` : ""}<em class="pick-cap">${esc(f.t)} <small>${f.y}</small></em></button>`;
    }).join("");
}
function onSlotSearch() {
  const q = $("slotSearch").value.trim(), d = slot.d, seq = ++slot.seq;
  slot.q = q; slot.results = null;
  clearTimeout(slotTimer);
  renderSlotGrid();
  if (q.length < 2) return;
  slotTimer = setTimeout(async () => {
    let list = [];
    try {
      const pages = await Promise.all([1, 2].map(page => tmdb("/search/movie", { query: q, page })));
      const byId = new Map();
      for (const m of pages.flatMap(p => p.results || []))
        if (decadeOf(+(m.release_date || "").slice(0, 4)) === d && m.release_date <= today() && !byId.has(m.id)) byId.set(m.id, snap(m));
      list = [...byId.values()].sort((a, b) => b.votes - a.votes);
    } catch {}
    if (slot?.seq !== seq) return;
    slot.results = list;
    renderSlotGrid();
  }, 300);
}
async function chooseSlot(film) {
  const c = challenges.find(x => x.id === slot.cid), d = slot.d;
  closeSlot();
  if (film) await setPick(c, d, film);
}
function closeSlot() {
  if (!slot) return;
  slot = null;
  clearTimeout(slotTimer);
  $("slotBack").hidden = true; $("slotBack").innerHTML = "";
  lockScroll();
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
  for (const x of watchedFilms().filter(x => !x.d.kind).sort((a, b) => rating(b) - rating(a) || b.f.votes - a.f.votes)) {
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
  appOn = !html;
  $("footer").hidden = !appOn && !user;
  applyView();
  shelf();
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
  if (e.target.id === "slotBack") return closeSlot();
  if (e.target.closest?.("#toast")) { $("toast").hidden = true; if ($("toast").dataset.kind === "trophy") { statsTab = "trophies"; closeSheet(); setView("stats"); } return; }
  if (e.target.closest?.("#homeLink")) { e.preventDefault(); return setView("home"); }
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
  if (t.dataset.go) return setView(t.dataset.go);
  if (t.id === "statsBtn") return setView("stats");
  if (t.dataset.stab) return setStatsTab(t.dataset.stab);
  if (t.id === "decCreate") return createChallenge();
  if (t.dataset.slot) { const [cid, d] = t.dataset.slot.split("|"); return openSlot(cid, +d); }
  if (t.dataset.fillrandom) { const c = challenges.find(x => x.id === t.dataset.fillrandom); t.disabled = true; t.textContent = "Picking…"; return c && fillRandom(c); }
  if (t.id === "slotClose") return closeSlot();
  if (t.id === "slotClear") return setPick(challenges.find(x => x.id === slot.cid), slot.d, null).then(closeSlot);
  if (t.id === "slotRandom" && slot) {
    const c = challenges.find(x => x.id === slot.cid), d = slot.d;
    t.disabled = true; t.textContent = "Picking…";
    return randomPick(c, d).then(f => slot?.cid === c.id && slot.d === d && (f ? chooseSlot(f) : (t.textContent = "Nothing left to pick"))).catch(() => { t.textContent = "Couldn't reach TMDB"; });
  }
  if (t.dataset.slotpick && slot) { const id = +t.dataset.slotpick; return chooseSlot([...(slot.results || []), ...(slot.pool || [])].find(f => f.id === id)); }
  if (t.id === "sheetSwap" && open) {
    const src = sourceById(open.dir), d = decadesOf(src.c).find(x => src.c.picks[x]?.id === open.movie);
    closeSheet();
    return openSlot(src.c.id, d);
  }
  if (t.dataset.removechal) {
    if (t.classList.contains("armed")) return removeChallenge(t.dataset.removechal);
    t.classList.add("armed"); t.textContent = "Tap again to remove this challenge";
    return setTimeout(() => { if (t.isConnected) { t.classList.remove("armed"); t.textContent = "Remove challenge"; } }, 4000);
  }
  if (t.dataset.tieropen) return openTier(t.dataset.tieropen);
  if (t.dataset.calyear) { calYear = +t.dataset.calyear; calDay = null; return renderCalendar(); }
  if (t.dataset.day) { calDay = calDay === t.dataset.day ? null : t.dataset.day; return renderCalendar(); }
  if (t.id === "undatedToggle") { showUndated = !showUndated; return renderCalendar(); }
  if (t.dataset.rec) { const p = recs.find(x => x.id === +t.dataset.rec); return p && addDirector(p.name, [p.id]); }
  // Rating a film marks it watched; tapping the current rating clears it.
  if (t.dataset.rate && open) { const n = +t.dataset.rate, cur = entries.get(open.movie)?.rating || 0;
    return saveEntry(open.movie, n === cur ? { rating: 0 } : { rating: n, watched: true }); }
  if (t.id === "sheetHide" && open) { const id = open.movie, hide = !entries.get(id)?.hidden; closeSheet(); return saveEntry(id, { hidden: hide }); }
  if (t.dataset.move) { const [id, delta] = t.dataset.move.split("|"); return moveDirector(id, +delta); }
  if (t.dataset.showremoved) { const id = t.dataset.showremoved; showRemoved.has(id) ? showRemoved.delete(id) : showRemoved.add(id); return render(); }
  if (t.id === "signOutBtn") return sb.auth.signOut().then(() => location.reload());
  if (t.dataset.remove) {
    if (t.classList.contains("armed")) return removeDirector(t.dataset.remove);
    t.classList.add("armed"); t.textContent = "Tap again to remove this director";
    setTimeout(() => { if (t.isConnected) { t.classList.remove("armed"); t.textContent = "Remove director"; } }, 4000);
  }
});
document.addEventListener("change", e => {
  if (e.target.id === "decFrom" || e.target.id === "decTo") { decFrom = +$("decFrom").value; decTo = +$("decTo").value; return updateDecForm(); }
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
  if (slot) { if (e.key === "Escape") closeSlot(); return; }
  if (!open) { if (e.key === "Escape" && view !== "home" && !e.target.closest?.("input, select, textarea")) setView("home"); return; }
  if (e.key === "Escape") { if ($("picker")) { $("picker").remove(); $("sheetPoster")?.focus(); } else closeSheet(); return; }
  if ($("picker")) return;
  if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.target.id !== "noteInput") { e.preventDefault(); stepSheet(e.key === "ArrowRight" ? 1 : -1); }
  if (e.key === "Enter" && e.target.id === "noteInput" && !e.shiftKey) { e.preventDefault(); closeSheet(); }
});
$("search").addEventListener("input", onSearch);
document.addEventListener("input", e => { if (e.target.id === "slotSearch" && slot) onSlotSearch(); });
addEventListener("popstate", () => { closeSheet(); closeSlot(); closeTier(); setView(viewFromHash(), { push: false }); });
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
// Drag a card row sideways with the mouse (touch screens already swipe natively).
function dragScroll(row) {
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
dragScroll($("cards"));
dragScroll($("decCards"));
addEventListener("resize", updateNav);
// Pick up changes made on another device when you come back to this tab.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && user && tmdbToken && !open && !tier && !slot) loadData().catch(() => {}); });

// ---------- Boot ----------
(async () => {
  const cfg = window.DR_CONFIG || {};
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) return screenConfig();
  sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  view = viewFromHash();
  const { data } = await sb.auth.getSession();
  user = data.session?.user || null;
  sb.auth.onAuthStateChange((_event, session) => {
    const was = user?.id;
    user = session?.user || null;
    if (user && user.id !== was) start();
  });
  if (user) start(); else screenSignIn();
})();
