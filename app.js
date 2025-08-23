/***********************
 * Dune Awakening Explorer
 * app.js — FULL REPLACEMENT (tree-aware categories + safety net + logging)
 ***********************/

// --- SAFETY NET / BOOTSTRAP (runs immediately) ---
console.log('🔧 app.js loading…');

// surface any JS errors in UI + console
window.addEventListener('error', (e) => {
  const s = document.getElementById('status');
  if (s) s.textContent = `JS error: ${e.message}`;
  console.error('❌ Global error:', e.error || e.message);
});

// bootstrap categories ASAP so they show even if later code breaks
(function bootstrapCategories() {
  try {
    const sel = document.getElementById('category-select');
    if (!sel) { console.warn('category-select not in DOM yet'); return; }
    if (sel.dataset.bootstrapped === '1') return; // avoid duplicates

    const CATS = [
      "Items", "Ammo", "Consumables", "Contract Items",
      "Garments", "Resources", "Tools", "Vehicles", "Weapons"
    ];

    CATS.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat.replace(/\s+/g, '_');
      opt.textContent = cat;
      sel.appendChild(opt);
    });
    sel.dataset.bootstrapped = '1';
    console.log('✅ Categories bootstrapped:', CATS);
  } catch (err) {
    console.error('❌ bootstrapCategories failed:', err);
  }
})();

// ---------------- Config ----------------
const OPEN_THRESHOLD = { default: 0, Items: 0 }; // open suggestions immediately
const CACHE_TTL_MS   = 24 * 60 * 60 * 1000;      // 24h cache for category lists
const CACHE_VERSION  = 'v2';                      // bump to ignore old shallow caches

// --------------- DOM refs ---------------
const categorySelect = document.getElementById('category-select');
const itemSearch     = document.getElementById('item-search');
const suggestionsBox = document.getElementById('item-suggestions');
const loadItemBtn    = document.getElementById('load-item-btn');
const itemDetails    = document.getElementById('item-details');
const statusEl       = document.getElementById('status');

// --------------- State ------------------
let currentItems = [];        // [{ title, pageid }]
let activeIndex = -1;         // keyboard highlight index
let currentAbort = null;      // abort controller for in-flight category loads
let currentCategoryName = ''; // human label for threshold map

// ---------- Helpers: status + UI ----------
function setStatus(text) { if (statusEl) statusEl.textContent = text || ''; }

function resetSearchUI() {
  itemSearch.value = '';
  itemSearch.placeholder = 'Search or select an item…';
  suggestionsBox.innerHTML = '';
  suggestionsBox.classList.add('hidden');
  itemSearch.setAttribute('aria-expanded', 'false');
  activeIndex = -1;
  setStatus('');
}

function enableSearchFieldOnly() {
  itemSearch.disabled = false;
  loadItemBtn.disabled = true;
}

function enableSearchAndLoad() {
  itemSearch.disabled = false;
  loadItemBtn.disabled = false;
}

function scoreMatch(q, title) {
  const t = title.toLowerCase();
  if (t.startsWith(q)) return 0;
  const idx = t.indexOf(q);
  return idx === -1 ? 9999 : (100 + idx); // lower is better
}
function itCmp(a, b) {
  if (a._score !== b._score) return a._score - b._score;
  return a.title.localeCompare(b.title);
}
function getOpenThreshold() {
  return OPEN_THRESHOLD[currentCategoryName] ?? OPEN_THRESHOLD.default;
}

// Show all items when empty; filter when typing. Keep list scrollable.
function getMatches(query) {
  const q = query.trim().toLowerCase();

  if (!q) {
    return [...currentItems]
      .sort((a, b) => a.title.localeCompare(b.title))
      .slice(0, 1000); // dropdown scrolls; adjust if desired
  }

  return currentItems
    .map(it => ({ ...it, _score: scoreMatch(q, it.title) }))
    .filter(it => it._score < 9999)
    .sort(itCmp)
    .slice(0, 1000);
}

function renderSuggestions(items) {
  suggestionsBox.innerHTML = '';
  if (!items.length) {
    suggestionsBox.classList.add('hidden');
    itemSearch.setAttribute('aria-expanded', 'false');
    return;
  }
  items.forEach((it, i) => {
    const div = document.createElement('div');
    div.className = 'suggestion';
    div.id = `sg-${i}`;
    div.role = 'option';
    div.textContent = it.title;
    // mousedown fires before blur → ensures click works
    div.addEventListener('mousedown', (e) => {
      e.preventDefault();
      chooseSuggestion(it);
    });
    suggestionsBox.appendChild(div);
  });
  activeIndex = -1;
  suggestionsBox.classList.remove('hidden');
  itemSearch.setAttribute('aria-expanded', 'true');
}
function hideSuggestions() {
  suggestionsBox.classList.add('hidden');
  itemSearch.setAttribute('aria-expanded', 'false');
  activeIndex = -1;
}
function highlight(index) {
  const children = [...suggestionsBox.children];
  children.forEach(c => c.classList.remove('active'));
  if (index >= 0 && index < children.length) {
    children[index].classList.add('active');
    itemSearch.setAttribute('aria-activedescendant', children[index].id);
  } else {
    itemSearch.setAttribute('aria-activedescendant', '');
  }
}
function chooseSuggestion(item) {
  itemSearch.value = item.title;
  hideSuggestions();
  loadItemByPageId(item.pageid);
}
function findExactByTitle(t) {
  const q = t.trim().toLowerCase();
  return currentItems.find(i => i.title.toLowerCase() === q) || null;
}

// -------- localStorage cache helpers --------
function cacheKeyFor(cat) { return `awakening-category:${CACHE_VERSION}:${cat}`; }
function saveCache(cat, items) {
  try {
    localStorage.setItem(cacheKeyFor(cat), JSON.stringify({ ts: Date.now(), items }));
    console.log(`💾 cached ${items.length} for ${cat}`);
  } catch {}
}
function loadCache(cat) {
  try {
    const raw = localStorage.getItem(cacheKeyFor(cat));
    if (!raw) return null;
    const blob = JSON.parse(raw);
    if (!blob || !Array.isArray(blob.items) || typeof blob.ts !== 'number') return null;
    if (Date.now() - blob.ts > CACHE_TTL_MS) return null;
    console.log(`⚡ using cache for ${cat} (${blob.items.length} items)`);
    return blob.items;
  } catch { return null; }
}

/* ============================================================
   Category tree fetcher (pages + all subcategories, BFS)
   ============================================================ */
async function fetchCategoryTree(categoryValue, signal, onProgress, maxDepth = 4) {
  // categoryValue like "Weapons" or "Contract_Items"
  const start = `Category:${categoryValue}`;

  const toVisit  = [{ title: start, depth: 0 }];
  const seenCats = new Set([start]);       // category titles we've queued
  const pages    = new Map();              // pageid -> { title, pageid }

  while (toVisit.length) {
    const { title, depth } = toVisit.shift();

    // Pull both pages and subcats for this category (incrementally with continue)
    let cmcontinue = null;
    do {
      const url = new URL('https://awakening.wiki/api.php');
      url.searchParams.set('action', 'query');
      url.searchParams.set('list', 'categorymembers');
      url.searchParams.set('cmtitle', title);
      url.searchParams.set('cmlimit', '500');        // bigger batch
      url.searchParams.set('cmtype', 'page|subcat'); // pages + subcats
      url.searchParams.set('format', 'json');
      url.searchParams.set('origin', '*');
      if (cmcontinue) url.searchParams.set('cmcontinue', cmcontinue);

      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const members = data.query?.categorymembers ?? [];

      for (const m of members) {
        if (m.title.startsWith('Category:')) {
          // traverse subcategories up to maxDepth
          if (depth < maxDepth && !seenCats.has(m.title)) {
            seenCats.add(m.title);
            toVisit.push({ title: m.title, depth: depth + 1 });
          }
        } else {
          // unique pages by pageid
          if (!pages.has(m.pageid)) pages.set(m.pageid, { title: m.title, pageid: m.pageid });
        }
      }

      cmcontinue = data.continue?.cmcontinue || null;
      if (typeof onProgress === 'function') onProgress(pages.size, seenCats.size);
    } while (cmcontinue);
  }

  return Array.from(pages.values()).sort((a, b) => a.title.localeCompare(b.title));
}

// ------------- Category load (tree-aware + cached) -------------
async function loadCategory(categoryValue) {
  console.log('➡️ loadCategory()', categoryValue);
  resetSearchUI();
  itemDetails.innerHTML = '';
  currentCategoryName = categoryValue.replace(/_/g, ' ');

  // Abort previous
  if (currentAbort) currentAbort.abort();
  currentAbort = new AbortController();

  // Try cache first (v2)
  const cached = loadCache(categoryValue);
  if (cached && Array.isArray(cached) && cached.length) {
    currentItems = cached;
    enableSearchAndLoad();
    setStatus(`Loaded ${cached.length} items (cached)`);
    // Refresh silently
    refreshCategoryInBackground(categoryValue, currentAbort.signal).catch(() => {});
    return;
  }

  // Fresh tree fetch
  enableSearchFieldOnly();
  currentItems = [];
  setStatus('Loading…');

  try {
    const items = await fetchCategoryTree(
      categoryValue,
      currentAbort.signal,
      (count, cats) => setStatus(`Loading… ${count} items (from ${cats} categories)`),
      4 // depth
    );
    currentItems = items;
    enableSearchAndLoad();
    saveCache(categoryValue, currentItems);
    setStatus(`Loaded ${currentItems.length} items`);
    console.log('✅ category tree load complete:', currentItems.length);
  } catch (e) {
    if (e.name === 'AbortError') {
      console.log('🛑 category load aborted (switched categories)');
      return;
    }
    console.error('❌ Error loading items:', e);
    itemSearch.disabled = false;
    itemSearch.placeholder = 'Failed to load items';
    loadItemBtn.disabled = true;
    setStatus('Load failed');
  }
}

// Background refresh (tree-aware)
async function refreshCategoryInBackground(categoryValue, signal) {
  try {
    const items = await fetchCategoryTree(categoryValue, signal, null, 4);
    saveCache(categoryValue, items);
    if (categorySelect.value === categoryValue) {
      currentItems = items;
      setStatus(`Loaded ${currentItems.length} items (refreshed)`);
      enableSearchAndLoad();
      console.log('♻️ refreshed (tree) cache for', categoryValue);
    }
  } catch (e) {
    if (e.name !== 'AbortError') console.warn('bg refresh failed:', e);
  }
}

// ------------- Events -------------
categorySelect.addEventListener('change', () => {
  const val = categorySelect.value;
  console.log('🔁 category changed →', val);
  if (!val) {
    resetSearchUI();
    itemSearch.disabled = true;
    loadItemBtn.disabled = true;
    return;
  }
  enableSearchFieldOnly();
  loadCategory(val);
});

// Always open list on focus and filter as you type
itemSearch.addEventListener('input', () => {
  renderSuggestions(getMatches(itemSearch.value));
});
itemSearch.addEventListener('focus', () => {
  renderSuggestions(getMatches(itemSearch.value));
});
itemSearch.addEventListener('blur', () => setTimeout(() => hideSuggestions(), 150));

itemSearch.addEventListener('keydown', (e) => {
  const children = [...suggestionsBox.children];
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!children.length) return;
    activeIndex = (activeIndex + 1) % children.length;
    highlight(activeIndex);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!children.length) return;
    activeIndex = (activeIndex - 1 + children.length) % children.length;
    highlight(activeIndex);
  } else if (e.key === 'Enter') {
    if (!suggestionsBox.classList.contains('hidden') && activeIndex >= 0) {
      e.preventDefault();
      const title = children[activeIndex].textContent;
      const found = findExactByTitle(title);
      if (found) chooseSuggestion(found);
    } else {
      const found = findExactByTitle(itemSearch.value);
      if (found) chooseSuggestion(found);
    }
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});

loadItemBtn.addEventListener('click', () => {
  const found = findExactByTitle(itemSearch.value);
  if (found) loadItemByPageId(found.pageid);
});

// ------------- Load + render item page -------------
async function loadItemByPageId(pageId) {
  itemDetails.innerHTML = '';

  try {
    // Metadata
    const metaRes = await fetch(
      `https://awakening.wiki/api.php?action=query&pageids=${pageId}&prop=info&inprop=url&format=json&origin=*`
    );
    if (!metaRes.ok) throw new Error(`HTTP ${metaRes.status}`);
    const meta = await resJSON(metaRes);
    const page = meta.query.pages[pageId];
    const pageTitle = page.title;
    const pageTitleSlug = pageTitle.replace(/ /g, '_');

    // Page HTML (CORS proxy)
    const htmlRes = await fetch(`https://corsproxy.io/?https://awakening.wiki/${pageTitleSlug}`);
    if (!htmlRes.ok) throw new Error(`HTTP ${htmlRes.status}`);
    const htmlText = await htmlRes.text();

    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');

    // Layout
    const layout = document.createElement('div');
    layout.className = 'item-layout';

    const header = document.createElement('div');
    header.className = 'item-header';
    header.innerHTML = `
      <h2>${pageTitle}</h2>
      <div class="muted">Source: <a href="${page.fullurl}" target="_blank" rel="noopener">View on Wiki ↗</a></div>
    `;
    layout.appendChild(header);

    const sidebar = extractInfobox(doc, pageTitle);
    layout.appendChild(sidebar);

    const main = document.createElement('div');
    const obtainment = extractSection(doc, 'Obtainment');
    const media      = extractSection(doc, 'Media');
    const crafting   = extractSection(doc, 'Crafting');
    const itemData   = extractSection(doc, 'Item Data');

    [['Obtainment', obtainment], ['Media', media], ['Crafting', crafting], ['Item Data', itemData]]
      .forEach(([title, node]) => {
        const p = makePanel(title, node);
        if (p) main.appendChild(p);
      });

    if (!main.childNodes.length) {
      const generic = doc.querySelector('#mw-content-text')?.cloneNode(true);
      main.appendChild(makePanel('Details', generic || document.createTextNode('No details available.')));
    }

    layout.insertBefore(main, sidebar);
    itemDetails.innerHTML = '';
    itemDetails.appendChild(layout);

  } catch (e) {
    console.error('❌ Error loading item:', e);
    itemDetails.textContent = 'Failed to load full details.';
  }
}

// ---------- Utilities ----------
async function resJSON(res) {
  const t = await res.text();
  try { return JSON.parse(t); } catch { throw new Error('Invalid JSON'); }
}

// make relative wiki links/images absolute so they work in our app
function absolutizeUrls(root, base = 'https://awakening.wiki') {
  const fix = (url) => {
    if (!url) return url;
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) return url;
    if (url.startsWith('//')) return 'https:' + url;   // protocol-relative
    if (url.startsWith('/'))  return base + url;       // site-absolute
    return url;                                        // relative (rare in infobox)
  };
  root.querySelectorAll('img[src]').forEach(img => img.src = fix(img.getAttribute('src')));
  root.querySelectorAll('a[href]').forEach(a => a.href = fix(a.getAttribute('href')));
}

// --- Infobox & sections ---
function extractSection(doc, headingText) {
  const headings = [...doc.querySelectorAll('#mw-content-text h2')];
  const h = headings.find(h2 =>
    h2.textContent.trim().toLowerCase().startsWith(headingText.toLowerCase())
  );
  if (!h) return null;

  const frag = document.createDocumentFragment();
  let n = h.nextElementSibling;
  while (n && n.tagName !== 'H2') {
    if (!n.classList?.contains('mw-editsection')) {
      frag.appendChild(n.cloneNode(true));
    }
    n = n.nextElementSibling;
  }
  return frag.childNodes.length ? frag : null;
}

function makePanel(title, contentNode) {
  if (!contentNode) return null;
  const wrap = document.createElement('section');
  wrap.className = 'panel';
  const h = document.createElement('h3');
  h.textContent = title;
  wrap.appendChild(h);
  wrap.appendChild(contentNode);
  return wrap;
}

// full infobox clone with URL fixups + duplicate title cleanup
function extractInfobox(doc, pageTitle) {
  // Try common infobox containers used by the site
  const found = doc.querySelector('.infobox, .portable-infobox, .infobox-wrapper, aside.infobox');
  const box = document.createElement('aside');
  box.className = 'infobox';

  const title = document.createElement('div');
  title.className = 'infobox-title';
  title.textContent = pageTitle;
  box.appendChild(title);

  if (found) {
    const cloned = found.cloneNode(true);

    // Strip duplicate titles inside the infobox
    const titleLikeSelectors = ['.pi-title', '.infobox-title', '.infobox-header', 'h1','h2','h3', '.mw-headline'];
    cloned.querySelectorAll(titleLikeSelectors.join(',')).forEach(node => {
      const text = (node.textContent || '').trim().toLowerCase();
      const want = (pageTitle || '').trim().toLowerCase();
      if (!text || text === want) node.remove();
    });
    cloned.querySelectorAll('caption').forEach(node => {
      const text = (node.textContent || '').trim().toLowerCase();
      const want = (pageTitle || '').trim().toLowerCase();
      if (text === want) node.remove();
    });

    // Remove edit chevrons/anchors if present
    cloned.querySelectorAll('.mw-editsection, .mw-editsection-visualeditor').forEach(n => n.remove());

    // Ensure images/links work outside the wiki
    absolutizeUrls(cloned);

    box.appendChild(cloned);
    return box;
  }

  // Fallback: simple table if no recognizable infobox
  const kvTable = doc.querySelector('#mw-content-text table');
  if (kvTable) {
    const simple = kvTable.cloneNode(true);
    absolutizeUrls(simple);
    box.appendChild(simple);
    return box;
  }

  // Final fallback: any image
  const anyImg = doc.querySelector('#mw-content-text img');
  if (anyImg) {
    const im = document.createElement('img');
    im.className = 'infobox-img';
    im.src = anyImg.src;
    im.alt = pageTitle;
    box.appendChild(im);
  }

  return box;
}

// --- MAIN INIT (hardened) ---
(function init() {
  try {
    console.log('✅ init running');

    const sel = document.getElementById('category-select');
    const search = document.getElementById('item-search');
    const btn = document.getElementById('load-item-btn');
    const suggestions = document.getElementById('item-suggestions');
    const details = document.getElementById('item-details');

    if (!sel || !search || !btn || !suggestions || !details) {
      throw new Error('One or more required DOM elements not found');
    }

    // If bootstrap ran first, the select already has options — that’s fine.
    if (sel.dataset.bootstrapped !== '1') {
      const CATEGORIES = [
        "Items", "Ammo", "Consumables", "Contract Items",
        "Garments", "Resources", "Tools", "Vehicles", "Weapons"
      ];
      CATEGORIES.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat.replace(/\s+/g, '_');
        opt.textContent = cat;
        sel.appendChild(opt);
      });
      sel.dataset.bootstrapped = '1';
      console.log('✅ Categories appended by init');
    }

    // If a category is preselected, enable search & load it
    if (sel.value) {
      console.log('ℹ️ Preselected category:', sel.value);
      enableSearchFieldOnly();
      loadCategory(sel.value);
    }
  } catch (e) {
    const s = document.getElementById('status');
    if (s) s.textContent = `Init failed: ${e.message}`;
    console.error('❌ init failed:', e);
  }
})();
