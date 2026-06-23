/* =============================================================================
 * Palimpsest v0.3.0  —  standalone gamebook shell for SillyTavern
 * -----------------------------------------------------------------------------
 * v0.3.0 — THE NODE LIFT
 *   - Story content moved OUT of code into ./story.json. Edit the story without
 *     touching index.js. Loaded via import.meta.url so the path is correct no
 *     matter where the folder is installed; cache-busted so a fresh edit shows
 *     up on reload instead of being served stale.
 *   - Malformed/edited JSON no longer dies silent: validateStory() reports what
 *     is wrong in a toast, and a built-in FALLBACK_STORY keeps the shell alive.
 *   - FULL EFFECTS VOCABULARY locked NOW (before emergent/dice arrive) so every
 *     future producer just pours into one socket — applyEffects():
 *         vars:{name:delta}  give:[id]  take:[id]
 *         setFlag:[f]  clearFlag:[f]  addStatus:[id]  removeStatus:[id]
 *     REQUIRES vocabulary (the gate): { item } | { flag } | { status } | { var:[name,op,val] }
 *   - statuses are a data row in story.json ({label, boosts:{var:+/-N}}); one
 *     statusModifier() sums them. That's the hook the resolve/dice seam will
 *     read later — built once, here, as a field + a function. No status engine.
 *
 * Carried intact from v0.2.2: inline-pinned takeover overlay (immune to theme
 * transforms), 100vw/100vh, three entry points, receipts, per-chat state.
 * ========================================================================== */

const NS = "palimpsest";
const Z  = 31000;
let DEBUG = true;            // <- set false once happy; gates diagnostic toasts
const VER = '0.9.2';

function getCtx() {
    try { return SillyTavern.getContext(); }
    catch (e) { return window.SillyTavern?.getContext?.() || null; }
}
function dbg(msg) { if (DEBUG) try { toastr.info(msg, 'Palimpsest'); } catch (e) {} }
function err(msg) { try { toastr.error(msg, 'Palimpsest', { timeOut: 9000 }); } catch (e) {} }
function warn(msg){ try { toastr.warning(msg, 'Palimpsest', { timeOut: 9000 }); } catch (e) {} }

/* ----------------------------------------------------------------------------
 * STORY (data) — loaded from story.json, never hardcoded.
 * -------------------------------------------------------------------------- */
let STORY = null;

const FALLBACK_STORY = {
    title: 'Fallback', start: 'start',
    initial: { vars: {}, inventory: [], flags: {}, statuses: [] },
    items: {}, statuses: {},
    nodes: { start: { id: 'start', mode: 'authored', location: 'story.json failed to load',
        prose: 'The shell is running, but the story file could not be read or parsed. Check the toast for the reason, fix story.json, and use Settings → Reload story.json.',
        image: null, choices: [] } },
};

async function loadStory() {
    try {
        const url = new URL('./story.json', import.meta.url);
        url.searchParams.set('t', Date.now());          // cache-bust every load
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching story.json');
        const data = JSON.parse(await res.text());      // throws on malformed JSON
        if (!data || typeof data !== 'object' || !data.nodes || !data.nodes[data.start]) {
            throw new Error('missing "nodes" or "start" does not point to a real node');
        }
        const issues = validateStory(data);             // soft issues -> warn, still load
        STORY = data;
        if (issues.length) warn('story.json loaded with ' + issues.length + ' issue(s): ' + issues.slice(0, 3).join(' | '));
        return true;
    } catch (e) {
        STORY = FALLBACK_STORY;
        err('story.json problem: ' + (e?.message || e) + ' — using fallback.');
        return false;
    }
}

/* Light validation: catches the edits that would silently break navigation. */
function validateStory(s) {
    const issues = [];
    const items = s.items || {}, statuses = s.statuses || {}, nodes = s.nodes || {};
    for (const [nid, node] of Object.entries(nodes)) {
        if (typeof node.prose !== 'string') issues.push(nid + ': no prose');
        if (!Array.isArray(node.choices))   { issues.push(nid + ': no choices array'); continue; }
        node.choices.forEach((ch, i) => {
            const where = nid + ' choice ' + (i + 1);
            if (ch.goto && !nodes[ch.goto]) issues.push(where + ': goto "' + ch.goto + '" is not a node');
            const r = ch.requires || {};
            if (r.item && !items[r.item])           issues.push(where + ': requires unknown item "' + r.item + '"');
            if (r.status && !statuses[r.status])    issues.push(where + ': requires unknown status "' + r.status + '"');
            const fx = ch.effects || {};
            (fx.give || []).concat(fx.take || []).forEach(id => { if (!items[id]) issues.push(where + ': effect item "' + id + '" not in items'); });
            (fx.addStatus || []).concat(fx.removeStatus || []).forEach(id => { if (!statuses[id]) issues.push(where + ': effect status "' + id + '" not in statuses'); });
        });
    }
    return issues;
}

/* convenience accessors */
const nodeById  = id => (STORY?.nodes || {})[id];
const itemName  = id => (STORY?.items || {})[id] || id;
const statusDef = id => (STORY?.statuses || {})[id] || { label: id, boosts: {} };

/* ----------------------------------------------------------------------------
 * STATE (per-chat) — derived from STORY.initial, mirrored to chat_metadata.
 * -------------------------------------------------------------------------- */
const FRESH = () => JSON.parse(JSON.stringify({
    current:   STORY?.start || 'start',
    vars:      STORY?.initial?.vars || {},
    flags:     STORY?.initial?.flags || {},
    inventory: STORY?.initial?.inventory || [],
    statuses:  STORY?.initial?.statuses || [],
    history:   [],
    tellingNodes: {},   // generated nodes (with variants) snapshotted for reload survival
}));
let state = FRESH();
let suppressChatChanged = false;   // ignore the CHAT_CHANGED we trigger ourselves

/* A stable per-chat key (survives reloads of the SAME chat). */
function chatKey() {
    const c = getCtx();
    try { if (typeof c?.getCurrentChatId === 'function') { const id = c.getCurrentChatId(); if (id) return 'c:' + id; } } catch (e) {}
    return 'c:' + (c?.chatId || c?.characterId || c?.groupId || 'default');
}
/* extensionSettings persists reliably via saveSettingsDebounced (every working
   extension uses this) — unlike saveMetadata, which my build doesn't expose. */
function settingsBag() {
    const c = getCtx(); if (!c) return null;
    const es = c.extensionSettings || c.extension_settings;
    if (!es) return null;
    es[NS] = es[NS] || {};
    return es[NS];
}

function loadState() {
    const c = getCtx();
    const bag = settingsBag();
    const saved = (bag && bag[chatKey()]) || c?.chat_metadata?.[NS] || null;   // primary, then legacy fallback
    state = saved ? Object.assign(FRESH(), saved) : FRESH();
    // Re-hydrate the telling's generated pages — STORY was rebuilt from story.json on reload.
    if (state.tellingNodes && STORY?.nodes) Object.assign(STORY.nodes, state.tellingNodes);
    if (!nodeById(state.current)) state.current = STORY?.start || 'start';   // story changed under us
}
function persist() {
    const c = getCtx(); if (!c) return;
    // Snapshot the emergent nodes this telling references so they survive reload.
    state.tellingNodes = {};
    new Set([...(state.history || []), state.current]).forEach(id => {
        const n = STORY?.nodes?.[id];
        if (n && n.variants) state.tellingNodes[id] = n;
    });
    const bag = settingsBag();
    if (bag) { bag[chatKey()] = state; if (typeof c.saveSettingsDebounced === 'function') c.saveSettingsDebounced(); }
    try { c.chat_metadata = c.chat_metadata || {}; c.chat_metadata[NS] = state; } catch (e) {}   // secondary mirror
}

async function commitReceipt(node, choiceLabel) {
    const c = getCtx(); if (!c?.chat) return;
    const v = activeView(node);
    const tail = choiceLabel ? `\n\n→ *${choiceLabel}*` : '';
    const msg = { name: c.name2 || 'Story', is_user: false,
        mes: `〔${v.location}〕\n\n${v.prose}${tail}`,
        send_date: Date.now(), extra: { [NS]: true, palimpsestPage: node.id } };
    c.chat.push(msg);
    try { await c.saveChat?.(); } catch (e) {}
    try { c.addOneMessage?.(msg); } catch (e) {}
}

/* ----------------------------------------------------------------------------
 * THE WAIST — one consumer. Authored effects and (later) emergent/extracted
 * effects flow through THIS, never a parallel path. JS owns all the math.
 * -------------------------------------------------------------------------- */
function applyEffects(fx) {
    if (!fx) return;
    if (fx.vars) for (const [k, d] of Object.entries(fx.vars)) {
        const next = (state.vars[k] ?? 0) + d, cap = state.vars[k + 'Max'];
        state.vars[k] = Math.max(0, cap != null ? Math.min(next, cap) : next);
    }
    if (fx.give) for (const id of fx.give) if (!state.inventory.includes(id)) state.inventory.push(id);
    if (fx.take) for (const id of fx.take) state.inventory = state.inventory.filter(x => x !== id);
    if (fx.setFlag)   for (const f of fx.setFlag)   state.flags[f] = true;
    if (fx.clearFlag) for (const f of fx.clearFlag) state.flags[f] = false;
    if (fx.addStatus) for (const id of fx.addStatus) if (!state.statuses.includes(id)) state.statuses.push(id);
    if (fx.removeStatus) for (const id of fx.removeStatus) state.statuses = state.statuses.filter(x => x !== id);
}

/* Sum status boosts for one var. The resolve/dice seam will read this later. */
function statusModifier(varName) {
    return (state.statuses || []).reduce((m, id) => m + ((statusDef(id).boosts || {})[varName] || 0), 0);
}

/* The gate. Returns true, or a human reason string if locked. */
function lockReason(choice) {
    const r = choice.requires; if (!r) return true;
    if (r.item && !state.inventory.includes(r.item)) return 'Requires: ' + itemName(r.item);
    if (r.flag && !state.flags[r.flag])              return 'Requires: ' + r.flag;
    if (r.status && !state.statuses.includes(r.status)) return 'Requires: ' + statusDef(r.status).label;
    if (Array.isArray(r.var)) {
        const [name, op, val] = r.var, cur = state.vars[name] ?? 0;
        const ok = op === '>=' ? cur >= val : op === '<=' ? cur <= val : op === '>' ? cur > val
                 : op === '<' ? cur < val : op === '==' ? cur === val : true;
        if (!ok) return 'Requires: ' + name + ' ' + op + ' ' + val;
    }
    return true;
}

/* ----------------------------------------------------------------------------
 * NAVIGATION
 * -------------------------------------------------------------------------- */
async function goTo(nodeId, choice) {
    const node = nodeById(nodeId);
    if (!node) { err('No node: ' + nodeId); return; }
    if (choice?.effects) applyEffects(choice.effects);
    state.current = nodeId; state.history.push(nodeId);
    persist();
    await commitReceipt(node, choice?.label);
    render();
}
/* ----------------------------------------------------------------------------
 * EMERGENT ENGINE — the fix for teleport-vomit.
 *
 * Why the old improvise() vomited: it called generateQuietPrompt, which
 * assembles the FULL chat pipeline — the card's first message, the whole
 * history, every Codex/Chronicler injection. The model got three "where are
 * we" premises at once and tried to reconcile them.
 *
 * The fix is BOUNDED CONTEXT (spoiler-gate): rawGen() uses generateRaw, which
 * runs a self-contained prompt with NO chat history. We hand the model only
 * what THIS beat needs — persona, optional lore seeds, and (for continuation)
 * the single previous beat. The shell owns the premise; nothing competes.
 * -------------------------------------------------------------------------- */

/* Bounded generation. generateRaw = no history; quietPrompt = fallback only. */
/* Config (global, not per-chat): which profile to generate against + budget. */
function getProfileId()   { return settingsBag()?.profileId || ''; }
function getTokenBudget() { return settingsBag()?.tokenBudget || 2000; }
function listProfiles() {
    const c = getCtx();
    const cm = (c?.extensionSettings || c?.extension_settings)?.connectionManager;
    return (cm && Array.isArray(cm.profiles)) ? cm.profiles : [];
}

/* Bounded generation. Preferred path: an independent connection against a
   chosen profile, so Palimpsest uses ITS OWN clean preset instead of inheriting
   whatever bias your main chat preset carries. Falls back to the chat
   connection when no profile is set (so it works out of the box). */
async function rawGen(prompt) {
    const c = getCtx();
    const pid = getProfileId();
    if (pid && c?.ConnectionManagerRequestService?.sendRequest) {
        try {
            const res = await c.ConnectionManagerRequestService.sendRequest(
                pid,
                [{ role: 'user', content: prompt }],
                getTokenBudget(),
                { extractData: true, includePreset: true, includeInstruct: false },
                {}
            );
            const text = (res && typeof res === 'object') ? (res.content ?? res.text) : res;
            if (text) return text;
            throw new Error('empty response');
        } catch (e) { err('Profile call failed — using chat connection. ' + (e?.message || e)); }
    }
    if (typeof c?.generateRaw === 'function')         return await c.generateRaw(prompt, null, false, false);
    if (typeof c?.generateQuietPrompt === 'function') return await c.generateQuietPrompt({ quietPrompt: prompt });
    throw new Error('no generation function on this ST');
}

/* Run ST macros so a literal {{user}}/{{char}} in lore becomes the real name. */
function sub(text) { const c = getCtx(); try { return c?.substituteParams ? c.substituteParams(String(text)) : String(text); } catch (e) { return String(text); } }

/* Which card fields Palimpsest feeds the model. Sensible defaults carry novices;
   toggles serve customizers. First Message defaults OFF — including it replays
   the card's scripted opening (the old "teleport-vomit" premise collision). */
const FIELD_DEFS = [
    ['description', 'Description',   true],
    ['personality', 'Personality',   true],
    ['scenario',    'Scenario',      true],
    ['first_mes',   'First Message', false],
    ['persona',     'Your Persona',  true],
];
const FIELD_CAP = 1200;   // per-field char cap: generous (1-2k cards come through) but bounds a mega-card

function getFields() {
    const saved = settingsBag()?.fields || {};
    const out = {};
    FIELD_DEFS.forEach(([k, , def]) => { out[k] = (k in saved) ? !!saved[k] : def; });
    return out;
}
function setField(k, v) {
    const b = settingsBag(); if (!b) return;
    b.fields = b.fields || {};
    b.fields[k] = v;
    getCtx()?.saveSettingsDebounced?.();
}
function charField(k) {
    const c = getCtx();
    const ch = c?.characters?.[c?.characterId];
    if (!ch) return '';
    const v = ch[k] ?? ch.data?.[k] ?? '';
    return sub(String(v)).trim().slice(0, FIELD_CAP);
}

/* Who "you" are. */
function personaBlock() {
    const c = getCtx();
    const you = c?.name1 || 'the reader';
    let desc = '';
    if (getFields().persona) desc = sub(c?.power_user?.persona_description || c?.powerUserSettings?.persona_description || '').trim().slice(0, FIELD_CAP);
    return 'THE READER (second person, "you" = this person): ' + you + (desc ? ' — ' + desc : '');
}

/* Who/what the telling concerns — assembled from the toggled card fields.
   Card content decides focus: rich character card -> orbits them; world card ->
   the races/customs/scenario carry it. */
function subjectBlock() {
    const c = getCtx();
    const name = c?.name2;
    if (!name) return '';
    const f = getFields();
    const parts = [];
    if (f.description) { const v = charField('description'); if (v) parts.push(v); }
    if (f.personality) { const v = charField('personality'); if (v) parts.push('Personality: ' + v); }
    if (f.scenario)    { const v = charField('scenario');    if (v) parts.push('Scenario: ' + v); }
    if (f.first_mes)   { const v = charField('first_mes');   if (v) parts.push('Canonical scenario / first message:\n' + v); }
    const body = parts.length ? '\n' + parts.join('\n') : '';
    return 'THE TELLING CONCERNS: ' + name + body
        + '\n(This is the established world: treat its races, customs, and details as TRUE — never contradict them, and when one of them appears, render it specifically rather than a vague substitute. '
        + 'But this is a PALETTE to draw on as the scene naturally calls for it, NOT a checklist — not every race or element needs to appear, and an ordinary, quiet moment true to the world is welcome. '
        + 'Build around ' + name + ' where it fits; do not introduce a new named character to stand in for them.)';
}

/* Optional Lexicon seeds — Spark's pattern, now framed as belonging to the subject. */
async function loreSeedBlock() {
    try {
        if (!window.LexiconAPI?.isActive?.()) return '';
        const hints = await window.LexiconAPI.getHintableEntries();
        if (!hints?.length) return '';
        const lines = hints.slice(0, 3).map(h => h.hintText
            ? '- ' + sub(h.title) + ': ' + sub(h.hintText)
            : '- something about "' + sub(h.title) + '" lingers').join('\n');
        return '\nWORLD SEEDS (these belong to the telling above; weave 1-2 in as atmosphere — hint, do not explain):\n' + lines + '\n';
    } catch (e) { return ''; }
}

/* Parse the model's fenced JSON page defensively. */
function parsePage(raw) {
    const data = JSON.parse(String(raw).replace(/```json|```/g, '').trim());
    if (!data.prose || !Array.isArray(data.choices)) throw new Error('shape');
    return data;
}
/* A "view" = one {location, prose, choices}. Emergent nodes hold an ARRAY of
   them (variants) + an active index, so reroll appends and you can swipe back. */
function viewFrom(data) {
    return { location: data.location || 'Untitled', prose: data.prose,
        choices: data.choices.slice(0, 3).map(ch => ({ label: ch.label, emergent: true })) };
}
function activeView(node) {
    if (node && node.variants && node.variants.length) return node.variants[node.active || 0];
    return node;   // authored node carries location/prose/choices directly
}
function isRerollable(node) { return !!(node && node.variants); }
function makeEmergentNode(view, gen) {
    const id = 'emergent_' + Date.now() + '_' + ((Math.random() * 1e4) | 0);
    STORY.nodes[id] = { id, mode: 'emergent', image: null, variants: [view], active: 0, gen };
    return id;
}
function addVariant(node, view) { node.variants.push(view); node.active = node.variants.length - 1; }

/* Shared craft direction — richer prose, real dialogue, withheld mystery.
   (Length will become a Settings dial later; this is the new default.) */
const CRAFT =
    '\nWrite a rich paragraph or two — favor voice, atmosphere, and interiority over stage-direction. ' +
    'Let characters SPEAK where natural; show, don\'t tell; never mute pantomime. ' +
    'TONE COMES FROM THE WORLD, not a default mood: honor the established setting and genre above all, ' +
    'and let it dictate whether the scene is bright, eerie, tender, or grim. ' +
    'Do NOT import tropes that do not belong to this world (e.g. no clergy, churches, or human villages ' +
    'unless the world actually calls for them); if it is the Fae realm, it must read unmistakably Fae. ' +
    'Then offer 2-3 distinct choices. Reply ONLY with fenced JSON:\n' +
    '```json\n{ "location": "...", "prose": "...", "choices": [ { "label": "..." } ] }\n```';

async function genOpeningView() {
    const seeds = await loreSeedBlock();
    const faithful = getFields().first_mes;   // user showed the first message -> they want it honored
    const lead = faithful
        ? 'You are the narrator of a second-person interactive gamebook. OPEN this telling FROM the card\'s established scenario and canonical opening shown below — honor that setup as the starting situation and STAY FAITHFUL to it; do not derail into a different scene or premise. Render it in second person ("you") and carry it forward naturally into the first beat.'
        : 'You are the narrator of a second-person interactive gamebook. Begin a NEW telling — invent a fresh opening SITUATION (not the character\'s canonical intro). Place the reader in a concrete moment true to the world. AVOID the generic "wake up wounded/amnesiac in a strange stone room" opening unless the world specifically calls for it.';
    const prompt = lead + '\n\n' + personaBlock() + '\n' + subjectBlock() + '\n' + seeds + CRAFT;
    return viewFrom(parsePage(await rawGen(prompt)));
}
async function genContinuationView(seedLabel, prevProse) {
    const seeds = await loreSeedBlock();
    const prompt =
        'You are the narrator of a second-person interactive gamebook. Continue the story.\n\n' +
        'PREVIOUS BEAT:\n' + (prevProse || '(none)') + '\n\n' +
        'THE READER CHOSE: "' + seedLabel + '"\n' + personaBlock() + '\n' + seeds + CRAFT;
    return viewFrom(parsePage(await rawGen(prompt)));
}

/* New telling: the new opening ERASES the old telling (this is the palimpsest).
   We wipe the chat to a single opening slot — fixes reroll stacking old beats. */
async function resetChatToOpening(node) {
    const c = getCtx(); if (!c?.chat) return;
    const v = activeView(node);
    const msg = { name: c.name2 || 'Story', is_user: false,
        mes: '〔' + v.location + '〕\n\n' + v.prose,
        send_date: Date.now(), extra: { [NS]: true, palimpsestPage: node.id, palimpsestOpening: true } };
    c.chat.splice(0, c.chat.length, msg);
    try { await c.saveChat?.(); } catch (e) {}
    try { c.reloadCurrentChat?.(); } catch (e) {}
}

/* Mirror the CURRENT beat's active variant into its chat receipt (the last
   message). Used by swipe + reroll so the canonical log matches what you see. */
async function updateCurrentReceipt() {
    const c = getCtx(); if (!c?.chat?.length) return;
    const v = activeView(nodeById(state.current));
    const last = c.chat.length - 1;
    if (c.chat[last]?.extra?.[NS] && v) {
        c.chat[last].mes = '〔' + v.location + '〕\n\n' + v.prose;
        try { await c.saveChat?.(); } catch (e) {}
    }
}

/* Resolver ladder: custom field (TODO) -> generate -> first_mes fallback. */
async function generateOpening() {
    dbg('Improvising opening…');
    try {
        const view = await genOpeningView();
        const id = makeEmergentNode(view, { kind: 'opening' });
        const node = STORY.nodes[id];
        state = FRESH(); state.current = id; state.history = [id];
        persist();
        suppressChatChanged = true;
        await resetChatToOpening(node);
        persist();
        dbg('Opening written.');
        return true;
    } catch (e) { err('Opening failed: ' + (e?.message || e)); return false; }
}

/* Continue from a chosen emergent label — bounded to the PREVIOUS beat only. */
async function continueFrom(seedLabel, prevProse) {
    setGenerating(true);
    try {
        const view = await genContinuationView(seedLabel, prevProse);
        await goTo(makeEmergentNode(view, { kind: 'continuation', seed: { label: seedLabel, prevProse } }));
    } catch (e) { err('Could not parse the model output. Staying put.'); }
    finally { setGenerating(false); }
}

/* Reroll the current beat -> append a new variant, land on it. */
async function rerollCurrent() {
    const node = nodeById(state.current);
    if (!isRerollable(node) || !node.gen) return;
    setGenerating(true);
    try {
        const view = node.gen.kind === 'opening'
            ? await genOpeningView()
            : await genContinuationView(node.gen.seed.label, node.gen.seed.prevProse);
        addVariant(node, view);
        persist();
        if (node.gen.kind === 'opening') { suppressChatChanged = true; await resetChatToOpening(node); }
        else await updateCurrentReceipt();
        render();
    } catch (e) { err('Reroll failed: ' + (e?.message || e)); }
    finally { setGenerating(false); }
}

/* Swipe between existing variants of the current beat (ST-style ‹ 1/N ›). */
function swipeVariant(dir) {
    const node = nodeById(state.current);
    if (!isRerollable(node) || node.variants.length < 2) return;
    const n = node.variants.length;
    node.active = (node.active + dir + n) % n;
    persist();
    updateCurrentReceipt();
    render();
}

/* ----------------------------------------------------------------------------
 * COVER  — the book closed. (Visual design by sinnerconsort; CSS in style.css,
 * scoped under #palimpsest-cover. States: sealed -> opening -> opened, where
 * "opening" is the live loading screen tied to the real generation promise.)
 * -------------------------------------------------------------------------- */
const RUNES = ['ᚠ','ᚢ','ᚦ','ᚨ','ᚱ','ᚲ','ᚷ','ᚹ','ᚺ','ᚾ','ᛁ','ᛃ','ᛇ','ᛈ','ᛉ','ᛊ','ᛏ','ᛒ','ᛖ','ᛗ','ᛚ','ᛜ','ᛞ','ᛟ'];
const SVGNS = 'http://www.w3.org/2000/svg';
const COVER_STATUS = ['Light finds the keyhole…', 'Scraping the last telling away…', 'The wheel turns for a telling…', 'The dark behind the door gives way…'];
const COVER_SEALED = 'Locked — though no key was ever left behind.';
let coverStatusTimer = null;

function svgEl(t, a) { const e = document.createElementNS(SVGNS, t); for (const k in a) e.setAttribute(k, a[k]); return e; }
function buildWheel(svg, live) {
    const C = 150;
    const rot = svgEl('g', { class: 'rot' });
    [140, 132, 96, 60].forEach(r => rot.appendChild(svgEl('circle', { class: 'line', cx: C, cy: C, r })));
    for (let i = 0; i < 72; i++) { const a = i * Math.PI / 36, r2 = i % 6 === 0 ? 128 : 135;
        rot.appendChild(svgEl('line', { class: 'tick', x1: C + Math.cos(a) * 140, y1: C + Math.sin(a) * 140, x2: C + Math.cos(a) * r2, y2: C + Math.sin(a) * r2 })); }
    for (let i = 0; i < 24; i++) { const a = i * Math.PI / 12, len = i % 2 ? 96 : 128;
        rot.appendChild(svgEl('line', { class: 'line spoke', x1: C, y1: C, x2: C + Math.cos(a) * len, y2: C + Math.sin(a) * len })); }
    rot.appendChild(svgEl('path', { class: 'line', d: 'M ' + (C + 118) + ' ' + C + ' A 118 118 0 0 1 ' + (C - 70) + ' ' + (C + 95) }));
    rot.appendChild(svgEl('path', { class: 'line', d: 'M ' + (C - 118) + ' ' + C + ' A 118 118 0 0 1 ' + (C + 50) + ' ' + (C - 107) }));
    for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4 + .2; rot.appendChild(svgEl('circle', { class: 'node', cx: C + Math.cos(a) * 110, cy: C + Math.sin(a) * 110, r: 7 })); }
    svg.appendChild(rot);
    for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6 - Math.PI / 2; const g = svgEl('text', { class: 'glyph' + (i % 3 === 0 ? ' lit' : ''), x: C + Math.cos(a) * 119, y: C + Math.sin(a) * 119 }); g.textContent = RUNES[(i * 2) % RUNES.length]; svg.appendChild(g); }
    if (!live) return;
    svg.appendChild(svgEl('circle', { class: 'hubglow', cx: C, cy: C, r: 34 }));
    const heart = svgEl('g', { class: 'heart' });
    heart.appendChild(svgEl('circle', { class: 'bloom', cx: C, cy: C, r: 60, fill: 'url(#pmpBloom)' }));
    const rays = svgEl('g', { class: 'rays' });
    for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6, h = .09, r = 66;
        const p1 = [C + Math.cos(a - h) * r, C + Math.sin(a - h) * r], p2 = [C + Math.cos(a + h) * r, C + Math.sin(a + h) * r];
        rays.appendChild(svgEl('polygon', { class: 'ray', points: C + ',' + C + ' ' + p1[0] + ',' + p1[1] + ' ' + p2[0] + ',' + p2[1] })); }
    heart.appendChild(rays);
    heart.appendChild(svgEl('circle', { class: 'escut', cx: C, cy: C, r: 24 }));
    [[0,-24],[0,24],[-24,0],[24,0]].forEach(o => heart.appendChild(svgEl('circle', { class: 'rivet', cx: C + o[0], cy: C + o[1], r: 1.8 })));
    heart.appendChild(svgEl('circle', { class: 'wave', cx: C, cy: C, r: 24 }));
    heart.appendChild(svgEl('circle', { class: 'kh', cx: C, cy: C - 5, r: 7 }));
    heart.appendChild(svgEl('path', { class: 'kh', d: 'M ' + (C - 4) + ' ' + (C - 1) + ' L ' + (C - 6) + ' ' + (C + 16) + ' L ' + (C + 6) + ' ' + (C + 16) + ' L ' + (C + 4) + ' ' + (C - 1) + ' Z' }));
    svg.appendChild(heart);
}
function buildBleed(host) {
    // Random ghost-runes for now. HOOK: seed state.lastTelling here for true bleed.
    let h = '';
    for (let i = 0; i < 22; i++) { const x = Math.random() * 92 + 2, y = Math.random() * 92 + 2, r = (Math.random() * 60 - 30) | 0;
        const t = Array.from({ length: (Math.random() * 5 + 3) | 0 }, () => RUNES[(Math.random() * RUNES.length) | 0]).join('');
        h += '<span style="left:' + x + '%;top:' + y + '%;--r:' + r + 'deg">' + t + '</span>'; }
    host.innerHTML = h;
}
function coverMarkup() {
    return ''
        + '<div class="plate"><span class="corner c-tl">◆</span><span class="corner c-tr">◇</span><span class="corner c-bl">◇</span><span class="corner c-br">◆</span></div>'
        + '<div class="bleed" id="palimpsest-bleed"></div>'
        + '<div class="head"><div class="wordmark">PALIMPSEST</div><div class="subtitle">the same book, never the same telling</div></div>'
        + '<div class="stage"><div class="wheel">'
        +   '<svg class="ghostwheel" id="palimpsest-ghostwheel" viewBox="0 0 300 300" aria-hidden="true"></svg>'
        +   '<svg id="palimpsest-livewheel" viewBox="0 0 300 300" role="img" aria-label="A keyhole in the wheel of tellings">'
        +     '<defs><radialGradient id="pmpBloom"><stop offset="0%" stop-color="#dff4ff" stop-opacity="1"/><stop offset="40%" stop-color="#7fcfe6" stop-opacity=".5"/><stop offset="100%" stop-color="#7fcfe6" stop-opacity="0"/></radialGradient></defs>'
        +   '</svg>'
        + '</div></div>'
        + '<div class="foot"><div class="orn">◇&nbsp;&nbsp;✦&nbsp;&nbsp;◇</div><div class="flavor" id="palimpsest-flavor"></div>'
        +   '<button id="palimpsest-open" class="cover-open">❖ Open the book</button></div>';
}

function showCover() {
    clearInterval(coverStatusTimer);
    const cover = document.getElementById('palimpsest-cover');
    const frame = document.getElementById('palimpsest-frame');
    if (!cover) return;
    frame.style.display = 'none';
    cover.style.display = 'flex';
    cover.classList.remove('opening', 'opened');
    cover.innerHTML = coverMarkup();
    buildWheel(document.getElementById('palimpsest-livewheel'), true);
    buildWheel(document.getElementById('palimpsest-ghostwheel'), false);
    buildBleed(document.getElementById('palimpsest-bleed'));
    const flavor = document.getElementById('palimpsest-flavor');
    if (flavor) flavor.textContent = COVER_SEALED;
    document.getElementById('palimpsest-open')?.addEventListener('click', beginTelling);
}
function showStory() {
    clearInterval(coverStatusTimer);
    const cover = document.getElementById('palimpsest-cover');
    const frame = document.getElementById('palimpsest-frame');
    if (cover) cover.style.display = 'none';
    if (frame) frame.style.display = 'flex';
    activeTab = 'story'; render();
}

/* The cover's "Open the book": run the resolver while the keyhole animates. */
async function beginTelling() {
    const cover = document.getElementById('palimpsest-cover');
    const flavor = document.getElementById('palimpsest-flavor');
    if (!cover) return;
    cover.classList.remove('opened'); cover.classList.add('opening');
    let i = 0; if (flavor) flavor.textContent = COVER_STATUS[0];
    clearInterval(coverStatusTimer);
    coverStatusTimer = setInterval(() => { i = (i + 1) % COVER_STATUS.length; if (flavor) flavor.textContent = COVER_STATUS[i]; }, 1100);

    const ok = await generateOpening();          // the real wait IS the animation
    clearInterval(coverStatusTimer);
    if (!ok) { cover.classList.remove('opening'); if (flavor) flavor.textContent = COVER_SEALED; return; }
    cover.classList.remove('opening'); cover.classList.add('opened');
    if (flavor) flavor.textContent = 'A telling surfaces.';
    setTimeout(showStory, 1100);                 // let the keyhole unlock-flourish play, then turn the page
}

/* ----------------------------------------------------------------------------
 * RENDER
 * -------------------------------------------------------------------------- */
let activeTab = 'story';
const ORN = '<div class="palimpsest-orn">&gt;—&lt;&nbsp;&nbsp;&gt;—&lt;&nbsp;&nbsp;&gt;—&lt;</div>';

function statBar() {
    const v = state.vars;
    const cell = (l, val) => '<span class="palimpsest-stat">' + l + ' <b>[' + val + ']</b></span>';
    const cells = [];
    if (v.stamina != null)  cells.push(cell('STAMINA', v.stamina + '/5'));
    if (v.vitality != null) cells.push(cell('VITALITY', v.vitality + '/' + (v.vitalityMax ?? '?')));
    if (v.defense != null) {
        const mod = statusModifier('defense');
        cells.push(cell('DEFENSE', mod ? (v.defense + mod) + ' (' + (mod > 0 ? '+' : '') + mod + ')' : v.defense));
    }
    let html = '<div class="palimpsest-statbar">' + cells.join('') + '</div>';
    if (state.statuses && state.statuses.length) {
        const chips = state.statuses.map(id =>
            '<span style="display:inline-block;padding:2px 9px;margin:0 4px;border:1px solid #3a3a40;border-radius:11px;font-size:11px;letter-spacing:1.5px;color:#b9b6ab;">'
            + statusDef(id).label.toUpperCase() + '</span>').join('');
        html += '<div style="text-align:center;margin:-8px 0 18px;">' + chips + '</div>';
    }
    return html;
}

function storyView() {
    const node = nodeById(state.current) || nodeById(STORY.start);
    if (!node) return '<div class="palimpsest-empty">No story loaded.</div>';
    const view = activeView(node);
    const choices = view.choices.map((ch, i) => {
        const lock = lockReason(ch);
        return lock !== true
            ? '<div class="palimpsest-choice locked">« ' + ch.label + ' »<div class="palimpsest-lock">' + lock + '</div></div>'
            : '<div class="palimpsest-choice" data-i="' + i + '">« ' + ch.label + ' »</div>';
    }).join('');
    const swipe = isRerollable(node)
        ? '<div class="palimpsest-swipe">'
            + '<span class="palimpsest-swarrow" data-dir="-1">‹</span>'
            + '<span class="palimpsest-swn">' + ((node.active || 0) + 1) + ' / ' + node.variants.length + '</span>'
            + '<span class="palimpsest-swarrow" data-dir="1">›</span>'
            + '<span class="palimpsest-reroll" id="palimpsest-reroll" title="Reroll this page">↻</span>'
          + '</div>'
        : '';
    return statBar()
        + '<div class="palimpsest-loc">' + view.location + '</div>' + ORN
        + '<div class="palimpsest-prose">' + view.prose + '</div>'
        + (view.image ? '<img class="palimpsest-img" src="' + view.image + '">' : '')
        + swipe + ORN
        + '<div class="palimpsest-choices">' + choices + '</div>';
}
function journalView() {
    const rows = state.history.length
        ? state.history.map(id => '<div class="palimpsest-row">' + (nodeById(id)?.location || id) + '</div>').join('')
        : '<div class="palimpsest-empty">No pages turned yet.</div>';
    return '<div class="palimpsest-loc">Journal</div>' + ORN + '<div class="palimpsest-list">' + rows + '</div>';
}
function inventoryView() {
    const rows = state.inventory.length
        ? state.inventory.map(id => '<div class="palimpsest-row">' + itemName(id) + '</div>').join('')
        : '<div class="palimpsest-empty">Empty.</div>';
    return '<div class="palimpsest-loc">Inventory</div>' + ORN + '<div class="palimpsest-list">' + rows + '</div>';
}
function settingsView() {
    const SUITE = ['LexiconAPI', 'CodexAPI', 'ChroniclerAPI', 'FortunaAPI', 'VoiceAPI'];
    const present = n => !!(getCtx()?.[n] || window?.[n]);
    const suite = SUITE.map(n => { const on = present(n); const nm = n.replace('API', '');
        return '<div class="palimpsest-row" style="cursor:default">' + nm + ' <b style="color:' + (on ? '#7fae6e' : '#6a685f') + '">' + (on ? '✓ detected' : '— not present') + '</b></div>'; }).join('');
    const cur = getProfileId();
    const opts = ['<option value=""' + (cur ? '' : ' selected') + '>— use main chat connection —</option>']
        .concat(listProfiles().map(p => '<option value="' + p.id + '"' + (p.id === cur ? ' selected' : '') + '>' + (p.name || p.id) + '</option>')).join('');
    const f = getFields();
    const fieldRows = FIELD_DEFS.map(([k, label]) =>
        '<div class="palimpsest-row palimpsest-field" data-field="' + k + '">' + label
        + ' <b style="color:' + (f[k] ? '#7fae6e' : '#6a685f') + '">' + (f[k] ? '✓ shown' : '— hidden') + '</b></div>').join('');
    return '<div class="palimpsest-loc">Settings</div>' + ORN
        + '<div class="palimpsest-list">'
        + '<div class="palimpsest-cfg">'
        +   '<label>Generation profile</label>'
        +   '<select id="palimpsest-profile">' + opts + '</select>'
        +   '<div class="palimpsest-empty">Default uses your main chat connection. Give Palimpsest its own profile to escape tone/bias bleed from your chat preset.</div>'
        +   '<label>Token budget</label>'
        +   '<input id="palimpsest-tokens" type="number" min="500" max="8000" step="100" value="' + getTokenBudget() + '">'
        +   '<div class="palimpsest-empty">Reasoning models spend tokens on hidden thinking first — prefer a non-reasoning profile, or raise to 4000+ if pages get cut off.</div>'
        + '</div>'
        + '<div class="palimpsest-empty" style="margin-top:6px;">What Palimpsest reads from the card (tap to toggle):</div>'
        + fieldRows
        + '<div class="palimpsest-empty">First Message OFF → Palimpsest writes a fresh telling. ON → it opens faithfully FROM the card\'s scenario &amp; first message (turn it on when you want the card\'s intended start).</div>'
        + '<div class="palimpsest-row" id="palimpsest-newtelling">✦ Begin a new telling</div>'
        + '<div class="palimpsest-row" id="palimpsest-reload">⟳ Reload story.json</div>'
        + '<div class="palimpsest-empty">Story: ' + (STORY?.title || '—') + ' · v' + VER + '</div>'
        + '<div class="palimpsest-empty">Optional suite integrations — the shell runs without any.</div>'
        + suite
        + '<div class="palimpsest-row" id="palimpsest-reset">↺ Reset this story</div>'
        + '</div>';
}

function setGenerating(on) {
    const w = document.getElementById('palimpsest-writing');
    if (w) w.style.display = on ? 'block' : 'none';
}

function render() {
    const $body = document.getElementById('palimpsest-body'); if (!$body) return;
    $body.innerHTML = activeTab === 'journal' ? journalView()
        : activeTab === 'inventory' ? inventoryView()
        : activeTab === 'settings' ? settingsView() : storyView();
    $body.querySelectorAll('.palimpsest-choice[data-i]').forEach(el => el.addEventListener('click', () => {
        const ch = activeView(nodeById(state.current)).choices[Number(el.dataset.i)];
        if (ch.emergent) continueFrom(ch.label, activeView(nodeById(state.current))?.prose);
        else if (ch.goto) goTo(ch.goto, ch);
        else toastr.warning('No destination yet.', 'Palimpsest');
    }));
    $body.querySelectorAll('.palimpsest-swarrow').forEach(el => el.addEventListener('click', () => swipeVariant(Number(el.dataset.dir))));
    const reroll = document.getElementById('palimpsest-reroll');
    if (reroll) reroll.addEventListener('click', rerollCurrent);
    const newtelling = document.getElementById('palimpsest-newtelling');
    if (newtelling) newtelling.addEventListener('click', () => { showCover(); });
    const reset = document.getElementById('palimpsest-reset');    if (reset) reset.addEventListener('click', () => { state = FRESH(); persist(); showCover(); dbg('The book closes.'); });
    const reload = document.getElementById('palimpsest-reload');
    if (reload) reload.addEventListener('click', async () => { await loadStory(); loadState(); render(); dbg('Reloaded ' + (STORY?.title || 'story') + '.'); });
    const prof = document.getElementById('palimpsest-profile');
    if (prof) prof.addEventListener('change', () => { const b = settingsBag(); if (b) { b.profileId = prof.value; getCtx()?.saveSettingsDebounced?.(); } dbg(prof.value ? 'Using selected profile.' : 'Using main chat connection.'); });
    const toks = document.getElementById('palimpsest-tokens');
    if (toks) toks.addEventListener('change', () => { const b = settingsBag(); if (b) { b.tokenBudget = Math.max(500, parseInt(toks.value, 10) || 2000); getCtx()?.saveSettingsDebounced?.(); } });
    $body.querySelectorAll('.palimpsest-field').forEach(el => el.addEventListener('click', () => {
        const k = el.dataset.field; setField(k, !getFields()[k]); render();
    }));
    document.querySelectorAll('.palimpsest-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === activeTab));
}

/* ----------------------------------------------------------------------------
 * TAKEOVER + SHELL  (unchanged from v0.2.2 — inline-pinned, theme-immune)
 * -------------------------------------------------------------------------- */
const CHROME = ['#sheld', '#form_sheld', '#top-bar', '#top-settings-holder', '#leftNavDrawerIcon', '#rightNavDrawerIcon'];
let hiddenChrome = [];
function hideChrome() {
    hiddenChrome = [];
    CHROME.forEach(sel => { const el = document.querySelector(sel);
        if (el && el.style.display !== 'none') { hiddenChrome.push([el, el.style.display]); el.style.display = 'none'; } });
    document.body.classList.add('palimpsest-lock');
}
function restoreChrome() {
    hiddenChrome.forEach(([el, d]) => { el.style.display = d || ''; });
    hiddenChrome = []; document.body.classList.remove('palimpsest-lock');
}

function buildShell() {
    document.getElementById('palimpsest-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'palimpsest-overlay';
    overlay.style.cssText =
        'position:fixed;top:0;left:0;right:0;bottom:0;width:100vw;height:100vh;' +
        'z-index:' + (Z + 1) + ';background:#0c0c0e;color:#d6d4cc;' +
        'font-family:Georgia,"Times New Roman",serif;';
    const bar = 'flex:0 0 auto;display:flex;align-items:center;padding:14px 18px;' +
                'font-size:12px;letter-spacing:2.5px;text-transform:uppercase;color:#8a8880;';
    overlay.innerHTML =
        '<div id="palimpsest-frame" style="position:absolute;inset:0;display:flex;flex-direction:column;">' +
            '<div style="' + bar + 'justify-content:space-between;border-bottom:1px solid #1c1c20;">' +
                '<span>' + (STORY?.title || 'Palimpsest') + ' · v' + VER + '</span><span id="palimpsest-close" style="cursor:pointer;letter-spacing:0;">✕</span></div>' +
            '<div id="palimpsest-body" style="flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;' +
                'padding:26px 22px 40px;width:100%;max-width:680px;margin:0 auto;box-sizing:border-box;"></div>' +
            '<div id="palimpsest-writing" style="display:none;position:absolute;top:52px;left:0;right:0;text-align:center;' +
                'z-index:3;pointer-events:none;font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#7fcfe6;">❖ the book is writing…</div>' +
            '<div style="' + bar + 'justify-content:center;gap:28px;border-top:1px solid #1c1c20;">' +
                '<span class="palimpsest-tab" data-tab="journal" style="cursor:pointer;">JOURNAL</span>' +
                '<span class="palimpsest-tab" data-tab="inventory" style="cursor:pointer;">INVENTORY</span>' +
                '<span class="palimpsest-tab" data-tab="settings" style="cursor:pointer;">SETTINGS</span></div>' +
        '</div>' +
        '<div id="palimpsest-cover" style="display:none;"></div>';
    document.body.appendChild(overlay);
    document.getElementById('palimpsest-close')?.addEventListener('click', closeShell);
    overlay.querySelectorAll('.palimpsest-tab').forEach(t => t.addEventListener('click', () => {
        activeTab = (activeTab === t.dataset.tab) ? 'story' : t.dataset.tab; render();
    }));
}
function openShell() {
    try {
        dbg('opening…');
        buildShell(); loadState(); hideChrome();
        activeTab = 'story';
        document.getElementById('palimpsest-overlay').style.display = 'block';
        // A telling in progress -> resume it. Otherwise the book is closed -> cover.
        try { (state.history && state.history.length) ? showStory() : showCover(); }
        catch (e) { err('Render failed: ' + (e?.message || e)); }
    } catch (e) { err('Open failed: ' + (e?.message || e)); }
}
function closeShell() { const o = document.getElementById('palimpsest-overlay'); if (o) o.style.display = 'none'; restoreChrome(); }
function toggleShell() { const o = document.getElementById('palimpsest-overlay'); (o && o.style.display !== 'none') ? closeShell() : openShell(); }

function buildFAB() {
    document.getElementById('palimpsest-fab')?.remove();
    const fab = document.createElement('button');
    fab.id = 'palimpsest-fab'; fab.title = 'Open Palimpsest'; fab.style.zIndex = Z;
    fab.innerHTML = '<i class="fa-solid fa-book-open"></i>';
    document.body.appendChild(fab);
    fab.addEventListener('click', () => { dbg('FAB tapped'); toggleShell(); });
}
function buildWand() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('palimpsest-wand')) return;
    const item = document.createElement('div');
    item.id = 'palimpsest-wand'; item.className = 'list-group-item flex-container flexGap5 interactable'; item.tabIndex = 0;
    item.innerHTML = '<i class="fa-solid fa-book-open"></i><span>Palimpsest</span>';
    item.addEventListener('click', () => { dbg('wand tapped'); toggleShell(); });
    menu.appendChild(item);
}
function registerSlash(c) {
    try {
        if (c?.SlashCommandParser?.addCommandObject && c?.SlashCommand?.fromProps) {
            c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
                name: 'palimpsest', aliases: ['cyoa'], callback: () => { toggleShell(); return ''; }, helpString: 'Toggle Palimpsest' }));
            return 'modern';
        }
    } catch (e) {}
    try {
        if (typeof c?.registerSlashCommand === 'function') {
            c.registerSlashCommand('palimpsest', () => { toggleShell(); }, ['cyoa'], 'Toggle Palimpsest', true, true);
            return 'legacy';
        }
    } catch (e) {}
    return 'none';
}

/* Inject the cover's web fonts once (links, not @import — reliable on mobile). */
function injectFonts(){
    if (document.getElementById('palimpsest-fonts')) return;
    const l = document.createElement('link');
    l.id = 'palimpsest-fonts'; l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600&family=IM+Fell+English:ital@0;1&family=IM+Fell+English+SC&family=JetBrains+Mono:wght@300;400&display=swap';
    document.head.appendChild(l);
}

/* INIT */
jQuery(async () => {
    await loadStory();                               // story ready before first open
    try { injectFonts(); } catch (e) {}
    try { buildFAB(); } catch (e) { err('FAB build failed: ' + (e?.message || e)); }
    try { buildWand(); } catch (e) {}
    const c = getCtx();
    try {
        if (c?.eventSource?.on && c?.event_types?.CHAT_CHANGED) {
            c.eventSource.on(c.event_types.CHAT_CHANGED, () => {
                if (suppressChatChanged) { suppressChatChanged = false; return; }
                loadState();
                if (document.getElementById('palimpsest-overlay')?.style.display !== 'none') render();
            });
        }
    } catch (e) {}
    const slash = registerSlash(c);
    if (DEBUG) dbg('loaded v' + VER + ' (story: ' + (STORY?.title || 'fallback') + ', slash: ' + slash + ')');
    console.log('[palimpsest] ✅ loaded v' + VER + '; slash=' + slash);
});
