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
const posterHtml = (f, size = "w342") => f.poster ? `<img src="${IMG + size + f.poster}" alt="${esc(f.t)} poster" loading="lazy">` : placeholder(f);

// ---------- State ----------
let sb = null, user = null;
let tmdbToken = null;
let directors = [];            // rows from Supabase plus .films (loaded from TMDB) and .error
const entries = new Map();     // movie_id -> {watched, note}
let hideWatched = local.get("dr-hide", false);
let suggestion = null;         // {name, person_ids, films, loading}
let searchSeq = 0, searchResults = [], lookupMsg = "";
let open = null;               // {dir, movie}

// ---------- TMDB ----------
async function tmdb(path, params = {}) {
  const u = new URL("https://api.themoviedb.org/3" + path);
  const v3 = /^[0-9a-f]{32}$/i.test(tmdbToken);
  if (v3) u.searchParams.set("api_key", tmdbToken);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: v3 ? { accept: "application/json" } : { accept: "application/json", Authorization: "Bearer " + tmdbToken } });
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
  const key = "dr-films-" + personIds.join("+");
  const cached = local.get(key, null);
  if (cached && !fresh && Date.now() - cached.at < 3 * 864e5) return cached.films;
  const credits = await Promise.all(personIds.map(id => tmdb(`/person/${id}/movie_credits`)));
  const byId = new Map();
  for (const c of credits) for (const m of c.crew || []) if (m.job === "Director" && !m.video) byId.set(m.id, m);
  const list = [...byId.values()];
  const runtimes = await pool(list, 8, m => runtimeOf(m.id));
  const today = new Date().toISOString().slice(0, 10);
  const films = list
    .map((m, i) => ({ m, rt: runtimes[i] }))
    .filter(({ rt }) => !(rt && rt < MIN_RUNTIME))
    .map(({ m }) => ({
      id: m.id, t: m.title, y: (m.release_date || "").slice(0, 4), date: m.release_date || "",
      poster: m.poster_path, backdrop: m.backdrop_path, votes: m.vote_count || 0,
      overview: m.overview || "", upcoming: !m.release_date || m.release_date > today,
      doc: (m.genre_ids || []).includes(99)
    }))
    .sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
  local.set(key, { at: Date.now(), films });
  return films;
}

function topFilm(films) {
  return [...films].filter(f => f.backdrop && !f.upcoming).sort((a, b) => b.votes - a.votes)[0] || null;
}

// ---------- Supabase data ----------
async function loadData() {
  const [d, e] = await Promise.all([
    sb.from("directors").select("*").order("added_at"),
    sb.from("entries").select("movie_id, watched, note")
  ]);
  if (d.error) throw d.error;
  if (e.error) throw e.error;
  const old = new Map(directors.map(x => [x.id, x]));
  directors = d.data.map(r => ({ ...r, films: old.get(r.id)?.films || null }));
  entries.clear();
  for (const r of e.data) entries.set(r.movie_id, { watched: r.watched, note: r.note });
  render();
  for (const dir of directors) if (!dir.films) fillFilms(dir);
}

async function fillFilms(dir) {
  try {
    dir.films = await loadFilms(dir.person_ids); dir.error = null;
    if (!dir.films.length) await repairDirector(dir);
  }
  catch (err) { dir.error = err.status === 401 ? "TMDB rejected the key." : "Couldn't load films. Reload to try again."; }
  render();
}

async function saveEntry(movieId, patch) {
  const cur = entries.get(movieId) || { watched: false, note: "" };
  const next = { ...cur, ...patch };
  entries.set(movieId, next);
  render();
  const { error } = await sb.from("entries").upsert({ user_id: user.id, movie_id: movieId, watched: next.watched, note: next.note, updated_at: new Date().toISOString() });
  if (error) { entries.set(movieId, cur); render(); }
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
function stats() {
  let all = 0, seen = 0;
  const counted = new Set();
  for (const d of directors) for (const f of d.films || []) {
    if (f.upcoming || counted.has(f.id)) continue;
    counted.add(f.id); all++;
    if (entries.get(f.id)?.watched) seen++;
  }
  $("stats").hidden = !directors.length;
  $("stats").innerHTML = `<div><b>${directors.length}</b>directors</div><div><b>${seen}</b>watched</div><div><b>${all - seen}</b>to go</div>`;
}

function render() {
  stats();
  const cards = $("cards");
  if (!directors.length) {
    cards.innerHTML = `<div class="empty"><strong>No directors yet</strong>Search above or pick one at random to start your first run.</div>`;
    return updateNav();
  }
  const scroll = cards.scrollLeft;
  cards.innerHTML = directors.map(d => {
    const films = d.films || [];
    const released = films.filter(f => !f.upcoming);
    const watched = released.filter(f => entries.get(f.id)?.watched).length;
    const done = released.length > 0 && watched === released.length;
    const top = topFilm(films);
    const banner = top
      ? `<img src="${IMG}w780${top.backdrop}" alt="Still from ${esc(top.t)}">`
      : `<div class="initials">${esc(initials(d.name))}</div>`;
    let body;
    if (d.error) body = `<p class="skeleton err">${esc(d.error)}</p>`;
    else if (!d.films) body = `<p class="skeleton">Loading films…</p>`;
    else body = `<div class="posters">${films.map(f => {
      const e = entries.get(f.id) || {}, w = !!e.watched;
      if (hideWatched && w) return "";
      return `<div class="poster${w ? " watched" : ""}${f.upcoming ? " upcoming" : ""}">
        <button class="art" type="button" data-open="${d.id}|${f.id}" aria-label="${esc(f.t)} (${f.y || "upcoming"})">
          ${posterHtml(f)}
          ${f.upcoming ? `<span class="flag">Upcoming</span>` : e.note ? `<span class="flag">Note</span>` : f.doc ? `<span class="flag">Doc</span>` : ""}
        </button>
        ${f.upcoming ? "" : `<button class="tick" type="button" data-tick="${f.id}" aria-pressed="${w}" aria-label="${w ? "Mark as not watched" : "Mark as watched"}: ${esc(f.t)}">✓</button>`}
        <div class="lbl">${esc(f.t)} <span>${f.y || "TBA"}</span></div>
      </div>`;
    }).join("") || `<p class="hint" style="grid-column:1/-1">All watched. Nice run.</p>`}</div>`;
    return `<article class="card">
      <div class="banner">${banner}
        <div class="cap"><h2>${esc(d.name)}</h2>
          <div class="count"><b>${watched}</b> / ${released.length}${done ? '<br><span class="complete">Complete</span>' : ""}</div></div>
      </div>
      <div class="strip" role="progressbar" aria-valuemin="0" aria-valuemax="${released.length}" aria-valuenow="${watched}" aria-label="${esc(d.name)} progress">
        <div class="frames">${released.map(f => `<span class="frame${entries.get(f.id)?.watched ? " on" : ""}" title="${esc(f.t)} (${f.y})"></span>`).join("")}</div>
      </div>
      ${body}
      <div class="card-foot"><button class="linkbtn" type="button" data-remove="${d.id}">Remove director</button></div>
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
  const released = (s.films || []).filter(f => !f.upcoming);
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
function openSheet(dirId, movieId) {
  const hit = findFilm(dirId, movieId);
  if (!hit) return;
  open = { dir: dirId, movie: movieId };
  const { d, f } = hit, e = entries.get(f.id) || {};
  $("sheetBack").innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
    <div class="big">${posterHtml(f, "w500")}</div>
    <div class="body">
      <span class="eyebrow">${esc(d.name)} · ${f.y || "Upcoming"}</span>
      <h3 id="sheetTitle">${esc(f.t)}</h3>
      ${f.overview ? `<p class="overview">${esc(f.overview)}</p>` : ""}
      ${f.upcoming ? `<p class="hint">Not released yet.</p>` : `
      <label class="small" for="noteInput">Your note</label>
      <textarea id="noteInput" maxlength="500" placeholder="A short thought on it">${esc(e.note || "")}</textarea>`}
      <div class="actions">
        ${f.upcoming ? "<span></span>" : `<button class="btn" type="button" id="sheetTick"></button>`}
        <button class="btn primary" type="button" id="sheetDone">Done</button>
      </div>
    </div></div>`;
  $("sheetBack").hidden = false;
  renderSheetState();
  $("sheetDone").focus();
}
function renderSheetState() {
  const b = $("sheetTick");
  if (b && open) b.textContent = entries.get(open.movie)?.watched ? "✓ Watched" : "Mark as watched";
}
function closeSheet() {
  if (!open) return;
  const ta = $("noteInput"), movie = open.movie;
  const val = ta ? ta.value.trim().slice(0, 500) : null;
  open = null;
  $("sheetBack").hidden = true; $("sheetBack").innerHTML = "";
  if (val !== null && (entries.get(movie)?.note || "") !== val) saveEntry(movie, { note: val });
}

// ---------- Screens ----------
function showScreen(html) {
  $("screen").innerHTML = html;
  const app = !html;
  $("addPanel").hidden = !app; $("rowwrap").hidden = !app; $("footer").hidden = !app && !user;
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
  if (e.target.id === "sheetBack") return closeSheet();
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
  if (t.id === "signOutBtn") return sb.auth.signOut().then(() => location.reload());
  if (t.dataset.remove) {
    if (t.classList.contains("armed")) return removeDirector(t.dataset.remove);
    t.classList.add("armed"); t.textContent = "Tap again to remove this director";
    setTimeout(() => { if (t.isConnected) { t.classList.remove("armed"); t.textContent = "Remove director"; } }, 4000);
  }
});
document.addEventListener("keydown", e => {
  if (!open) return;
  if (e.key === "Escape") closeSheet();
  if (e.key === "Enter" && e.target.id === "noteInput" && !e.shiftKey) { e.preventDefault(); closeSheet(); }
});
$("hideWatched").checked = hideWatched;
$("hideWatched").addEventListener("change", e => { hideWatched = e.target.checked; local.set("dr-hide", hideWatched); render(); });
$("search").addEventListener("input", onSearch);
$("cards").addEventListener("scroll", updateNav, { passive: true });
addEventListener("resize", updateNav);
// Pick up changes made on another device when you come back to this tab.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && user && tmdbToken && !open) loadData().catch(() => {}); });

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
