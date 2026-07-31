/**
 * Expressions Plus — multi-character, per-card sprite automation for SillyTavern.
 *
 * Key differences from the built-in Character Expressions extension:
 *  - Data model: Card → Story Character → Expressions. Everything is keyed to
 *    the character card, so nothing leaks into other cards' chats.
 *  - No default/pre-added expressions. Only what you upload or scan exists.
 *  - Event-driven: classification fires only on the triggers you enable
 *    (AI message / user message / swipe / edit). No 2-second polling loop.
 *  - Empty expressions (no images) are never sent to the LLM, so they can't
 *    cause classification errors.
 *  - Classification always goes through a separate OpenAI-compatible endpoint
 *    (URL + key), never the main chat API, so it can't interfere with
 *    generation and can use a fast/cheap model.
 *  - One LLM call picks both the character and the expression from a flat
 *    list of "Character/expression" options.
 *  - Full management UI: rename/delete characters and expressions, edit
 *    folders, bulk add by filename, drag & drop, and a Scan button that
 *    re-reads folders after you edit them on disk.
 */

import { eventSource, event_types, getRequestHeaders, saveSettingsDebounced, substituteParams } from '../../../../script.js';
import { getContext, extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { dragElement } from '../../../RossAscends-mods.js';
import { loadMovingUIState } from '../../../power-user.js';
import { getCharaFilename, debounce } from '../../../utils.js';
import { Popup } from '../../../popup.js';
import { classifyViaCustomEndpoint, testCustomEndpoint } from './custom-endpoint.js';

const MODULE_NAME = 'expressionsPlus';

// Resolve the template namespace from wherever this folder was actually installed,
// so renames of the extension folder don't break template loading.
const FOLDER_MATCH = /third-party\/([^/]+)\//.exec(import.meta.url);
const TEMPLATE_NAMESPACE = FOLDER_MATCH ? `third-party/${FOLDER_MATCH[1]}` : 'third-party/expressions-plus';

const DEFAULT_PROMPT = [
    'You are choosing which character sprite to display for a roleplay chat.',
    'Available sprites, one per line, in the form Character/expression:',
    '{{labels}}',
    'Based on the conversation, reply with exactly one entry from the list, copied verbatim (Character/expression). Output nothing else.',
].join('\n');

/**
 * @typedef {object} SpriteImage
 * @property {string} fileName - file name with extension
 * @property {string} title - file name without extension
 * @property {string} imageSrc - URL/path served by SillyTavern
 */

/**
 * @typedef {object} ExpressionEntry
 * @property {string} label
 * @property {SpriteImage[]} files
 */

/** In-memory cache: folder path → ExpressionEntry[] */
let folderCache = {};
/** Prevents overlapping classifier calls */
let inApiCall = false;
/** The last message text we classified, to avoid duplicate calls */
let lastClassifiedText = null;
/** Currently displayed sprite (for reroll-if-same) */
let currentSprite = { char: null, label: null, src: null };

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    const s = extension_settings[MODULE_NAME];
    let changed = false;
    const def = (key, value) => {
        if (s[key] === undefined) {
            s[key] = value;
            changed = true;
        }
    };
    def('enabled', true);
    def('onAiMessages', true);
    def('onUserMessages', false);
    def('onSwipe', true);
    def('historyDepth', 4);
    def('rerollIfSame', true);
    def('prompt', DEFAULT_PROMPT);
    def('apiUrl', '');
    def('apiKey', '');
    def('apiModel', '');
    def('apiProxy', false);
    def('cards', {});
    if (changed) saveSettingsDebounced();
    return s;
}

/**
 * The stable key for the currently open character card (avatar filename
 * without extension). In group chats, resolves from the last character message.
 * @returns {string|null}
 */
function getCardKey() {
    const context = getContext();
    if (context.groupId) {
        const lastCharMes = context.chat?.slice().reverse().find(x => !x.is_user && !x.is_system && x.original_avatar);
        if (lastCharMes?.original_avatar) {
            return String(lastCharMes.original_avatar).replace(/\.[^/.]+$/, '');
        }
        return null;
    }
    if (context.characterId === undefined) {
        return null;
    }
    return getCharaFilename() || null;
}

/**
 * Gets (and optionally creates) the stored data for the current card.
 * @param {boolean} [create=false]
 * @returns {{characters: {name: string, folder: string}[]}|null}
 */
function getCardData(create = false) {
    const cardKey = getCardKey();
    if (!cardKey) return null;
    const s = getSettings();
    if (!s.cards[cardKey]) {
        if (!create) return null;
        s.cards[cardKey] = { characters: [] };
        saveSettingsDebounced();
    }
    // Migrate any malformed entries defensively
    if (!Array.isArray(s.cards[cardKey].characters)) {
        s.cards[cardKey].characters = [];
    }
    return s.cards[cardKey];
}

// ─────────────────────────────────────────────────────────────────────────────
// Sprite folder scanning & manipulation
// ─────────────────────────────────────────────────────────────────────────────

function withoutExtension(fileName) {
    return String(fileName).replace(/\.[^/.]+$/, '');
}

function sanitizeLabel(raw) {
    return String(raw)
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^_+|_+$/g, '');
}

function sanitizeFolderPart(raw) {
    return String(raw).trim().replace(/[\\/:*?"<>|]/g, '_');
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Reads a sprite folder from the server and groups files into expressions.
 * The server already assigns the shared label for suffix-named files
 * (casual.png / casual-1.png / casual.beach.png → label "casual").
 * @param {string} folder - folder path relative to /characters/
 * @returns {Promise<ExpressionEntry[]>}
 */
async function scanFolder(folder) {
    if (!folder) return [];
    try {
        const result = await fetch(`/api/sprites/get?name=${encodeURIComponent(folder)}`);
        /** @type {{label: string, path: string}[]} */
        const sprites = result.ok ? await result.json() : [];

        /** @type {ExpressionEntry[]} */
        const grouped = [];
        for (const sprite of sprites) {
            if (!sprite?.label || !sprite?.path) continue;
            const fileName = sprite.path.split('/').pop().split('?')[0];
            const image = {
                fileName,
                title: withoutExtension(fileName),
                imageSrc: sprite.path,
            };
            const existing = grouped.find(x => x.label === sprite.label);
            if (existing) existing.files.push(image);
            else grouped.push({ label: sprite.label, files: [image] });
        }

        // Stable ordering: expressions alphabetically, main file first.
        grouped.sort((a, b) => a.label.localeCompare(b.label));
        for (const entry of grouped) {
            entry.files.sort((a, b) => {
                if (a.title === entry.label) return -1;
                if (b.title === entry.label) return 1;
                return a.title.localeCompare(b.title);
            });
        }

        folderCache[folder] = grouped;
        return grouped;
    } catch (err) {
        console.error('[expressions-plus] Failed to scan folder', folder, err);
        folderCache[folder] = [];
        return [];
    }
}

/** Re-scans every registered character folder for the current card. */
async function scanAll() {
    const card = getCardData();
    if (!card) return;
    await Promise.all(card.characters.map(ch => scanFolder(ch.folder)));
}

/**
 * All selectable options for the current card: only expressions that actually
 * have at least one image. This is what keeps empty expressions from ever
 * reaching (and erroring) the classifier.
 * @returns {{char: string, label: string, files: SpriteImage[]}[]}
 */
function getOptions() {
    const card = getCardData();
    if (!card) return [];
    const options = [];
    for (const ch of card.characters) {
        const expressions = folderCache[ch.folder] || [];
        for (const entry of expressions) {
            if (entry.files.length > 0) {
                options.push({ char: ch.name, label: entry.label, files: entry.files });
            }
        }
    }
    return options;
}

/**
 * Uploads one image file as (part of) an expression.
 * @param {string} folder - sprite folder
 * @param {File} file
 * @param {string} label - expression label
 * @param {string} spriteName - file name (without extension) to store as
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function uploadSpriteFile(folder, file, label, spriteName) {
    const formData = new FormData();
    formData.append('name', folder);
    formData.append('label', label);
    formData.append('avatar', file);
    formData.append('spriteName', spriteName);
    try {
        const result = await fetch('/api/sprites/upload', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
            body: formData,
            cache: 'no-cache',
        });
        if (!result.ok) {
            const text = await result.text().catch(() => '');
            return { ok: false, error: text || `status ${result.status}` };
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Deletes one sprite file.
 * @param {string} folder
 * @param {string} label
 * @param {string} spriteName - file name without extension
 */
async function deleteSpriteFile(folder, label, spriteName) {
    try {
        await fetch('/api/sprites/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name: folder, label, spriteName }),
        });
    } catch (err) {
        console.error('[expressions-plus] Delete failed', folder, spriteName, err);
    }
}

/**
 * Derives the expression label from a file name, mirroring the server's
 * suffix convention: everything after the first dot, or a trailing -N
 * numeric suffix, is treated as a variant marker.
 * "casual-1.png" → casual · "casual.beach.png" → casual · "school_uniform.png" → school_uniform
 * @param {string} fileName
 * @returns {{label: string, spriteName: string}}
 */
function labelFromFileName(fileName) {
    const base = withoutExtension(fileName);
    let label = base.split('.')[0];
    const dashNum = /^(.+)-(\d+)$/.exec(label);
    if (dashNum) label = dashNum[1];
    label = sanitizeLabel(label);
    const spriteName = sanitizeLabel(base.replace(/\./g, '_')) || label;
    return { label, spriteName };
}

/**
 * Bulk uploads image files into a character folder. Labels come from
 * filenames, so dropping casual.png + casual-1.png + angry.png creates
 * "casual" (2 images) and "angry" (1 image) in one go.
 * @param {string} folder
 * @param {FileList|File[]} files
 * @returns {Promise<{uploaded: number, failed: number}>}
 */
async function bulkUpload(folder, files) {
    const list = Array.from(files || []).filter(f => f && f.type?.startsWith('image/'));
    let uploaded = 0, failed = 0;
    for (const file of list) {
        const { label, spriteName } = labelFromFileName(file.name);
        if (!label) { failed++; continue; }
        const res = await uploadSpriteFile(folder, file, label, spriteName);
        res.ok ? uploaded++ : failed++;
        if (!res.ok) console.warn('[expressions-plus] Upload failed:', file.name, res.error);
    }
    return { uploaded, failed };
}

/**
 * Renames an expression by re-uploading each image under the new label and
 * deleting the originals (SillyTavern has no rename endpoint).
 * @param {string} folder
 * @param {ExpressionEntry} entry
 * @param {string} newLabel
 */
async function renameExpression(folder, entry, newLabel) {
    let index = 0;
    for (const file of entry.files) {
        const response = await fetch(file.imageSrc, { cache: 'no-cache' });
        if (!response.ok) throw new Error(`Could not read ${file.fileName}`);
        const blob = await response.blob();
        const ext = (file.fileName.split('.').pop() || 'png').toLowerCase();
        const spriteName = index === 0 ? newLabel : `${newLabel}-${index}`;
        const newFile = new File([blob], `${spriteName}.${ext}`, { type: blob.type || 'image/png' });
        const res = await uploadSpriteFile(folder, newFile, newLabel, spriteName);
        if (!res.ok) throw new Error(res.error || 'upload failed');
        index++;
    }
    for (const file of entry.files) {
        await deleteSpriteFile(folder, entry.label, withoutExtension(file.fileName));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification
// ─────────────────────────────────────────────────────────────────────────────

function sampleText(text) {
    return substituteParams(String(text || '')).replace(/[*"]/g, '').trim();
}

/**
 * Builds the user prompt from the most recent chat messages.
 * @param {number} depth
 * @returns {string|null} null when there is nothing to classify
 */
function buildUserPrompt(depth) {
    const context = getContext();
    const usable = (context.chat || []).filter(m => !m.is_system && m.mes && m.mes !== '...');
    if (usable.length === 0) return null;

    const slice = usable.slice(-Math.max(1, depth));
    if (slice.length === 1) {
        return sampleText(slice[0].mes);
    }
    const lines = slice.map(m => `${m.name}: ${sampleText(m.mes)}`);
    return 'Recent conversation:\n' + lines.join('\n') + '\n\nPick the sprite that fits the LAST message above.';
}

/**
 * Parses the classifier's reply into one of the available options.
 * Tolerant of extra words, quotes, wrong case, or the model answering with
 * only the expression name.
 * @param {string} raw
 * @param {ReturnType<typeof getOptions>} options
 * @returns {ReturnType<typeof getOptions>[number]|null}
 */
function parseResponse(raw, options) {
    const clean = String(raw || '').toLowerCase().replace(/["'`]/g, '').trim();
    if (!clean || options.length === 0) return null;

    const keyed = options.map(o => ({ o, key: `${o.char}/${o.label}`.toLowerCase() }));

    // 1. Exact match
    const exact = keyed.find(k => k.key === clean);
    if (exact) return exact.o;

    // 2. Reply contains a full "Character/expression" key (longest first,
    //    so "alice/casual_beach" wins over "alice/casual")
    keyed.sort((a, b) => b.key.length - a.key.length);
    const contained = keyed.find(k => clean.includes(k.key));
    if (contained) return contained.o;

    // 3. Character name and expression label both mentioned somewhere
    for (const k of keyed) {
        if (clean.includes(k.o.char.toLowerCase()) && clean.includes(k.o.label.toLowerCase())) {
            return k.o;
        }
    }

    // 4. Expression label alone (longest first to avoid substring collisions)
    const byLabel = [...options].sort((a, b) => b.label.length - a.label.length);
    const labelOnly = byLabel.find(o => clean.includes(o.label.toLowerCase()));
    if (labelOnly) return labelOnly;

    return null;
}

/**
 * Runs one classification pass over the latest chat state and updates the
 * displayed sprite. Silently no-ops when disabled, unconfigured, or when
 * there are no options — so an empty setup can never produce errors.
 * @param {boolean} [force=false] - classify even if the text hasn't changed
 */
async function classify(force = false) {
    const s = getSettings();
    if (!s.enabled) return;
    if (inApiCall) {
        console.debug('[expressions-plus] Classifier busy, skipping');
        return;
    }

    const card = getCardData();
    if (!card || card.characters.length === 0) return;

    // Make sure folders are scanned at least once
    if (card.characters.some(ch => folderCache[ch.folder] === undefined)) {
        await scanAll();
    }

    const options = getOptions();
    if (options.length === 0) return; // nothing with images → no API call, no error

    const userPrompt = buildUserPrompt(s.historyDepth);
    if (!userPrompt) return;

    if (!force && userPrompt === lastClassifiedText) return;

    const labels = options.map(o => `${o.char}/${o.label}`).join('\n');
    const systemPrompt = String(s.prompt || DEFAULT_PROMPT).replaceAll('{{labels}}', labels);

    try {
        inApiCall = true;
        const raw = await classifyViaCustomEndpoint({
            url: s.apiUrl,
            key: s.apiKey,
            model: s.apiModel,
            useProxy: !!s.apiProxy,
        }, systemPrompt, userPrompt);

        lastClassifiedText = userPrompt;

        const option = parseResponse(raw, options);
        if (option) {
            console.debug(`[expressions-plus] Picked ${option.char}/${option.label} from reply:`, raw.trim().slice(0, 120));
            showSprite(option);
        } else {
            console.warn('[expressions-plus] Could not match classifier reply to any option:', raw);
        }
    } catch (err) {
        console.error('[expressions-plus] Classification failed:', err);
        toastr.error(String(err.message || err), 'Expressions Plus', { timeOut: 4000, preventDuplicates: true });
    } finally {
        inApiCall = false;
    }
}

const classifyDebounced = debounce(() => classify(), 250);

// ─────────────────────────────────────────────────────────────────────────────
// Sprite display
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Displays a sprite for the given option, choosing among its images.
 * @param {{char: string, label: string, files: SpriteImage[]}} option
 */
function showSprite(option) {
    const s = getSettings();
    let pool = option.files;
    if (s.rerollIfSame && pool.length > 1 && currentSprite.src) {
        const filtered = pool.filter(f => f.imageSrc !== currentSprite.src);
        if (filtered.length > 0) pool = filtered;
    }
    const file = pool[Math.floor(Math.random() * pool.length)];
    if (!file) return;

    currentSprite = { char: option.char, label: option.label, src: file.imageSrc };

    const holder = document.getElementById('xp-holder');
    const img = document.getElementById('xp-image');
    if (!holder || !(img instanceof HTMLImageElement)) return;

    holder.style.display = '';
    img.title = `${option.char} · ${option.label}`;
    img.setAttribute('data-character', option.char);
    img.setAttribute('data-expression', option.label);

    if (img.src && img.src.endsWith(file.imageSrc)) return;

    // Preload, then crossfade via CSS opacity transition.
    const preload = new Image();
    preload.onload = () => {
        img.classList.add('xp-fading');
        requestAnimationFrame(() => {
            img.src = file.imageSrc;
            img.onload = () => img.classList.remove('xp-fading');
        });
    };
    preload.onerror = () => console.warn('[expressions-plus] Image failed to load:', file.imageSrc);
    preload.src = file.imageSrc;
}

function hideSprite() {
    currentSprite = { char: null, label: null, src: null };
    const holder = document.getElementById('xp-holder');
    const img = document.getElementById('xp-image');
    if (img instanceof HTMLImageElement) img.src = '';
    if (holder) holder.style.display = 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// Management UI (tree)
// ─────────────────────────────────────────────────────────────────────────────

async function renderTree() {
    const $tree = $('#xp_tree');
    if (!$tree.length) return;
    $tree.empty();

    const cardKey = getCardKey();
    $('#xp_card_name').text(cardKey ?? '—');

    if (!cardKey) {
        $tree.append('<div class="xp_hint">Open a chat with a character to manage its sprites.</div>');
        return;
    }

    const card = getCardData(true);

    if (card.characters.length === 0) {
        $tree.append('<div class="xp_hint">No characters yet. Add one, then drop images onto its block — each filename becomes an expression.</div>');
        return;
    }

    for (const ch of card.characters) {
        $tree.append(buildCharacterBlock(cardKey, card, ch));
    }
}

/**
 * @param {string} cardKey
 * @param {{characters: {name: string, folder: string}[]}} card
 * @param {{name: string, folder: string}} ch
 */
function buildCharacterBlock(cardKey, card, ch) {
    const expressions = folderCache[ch.folder] || [];
    const $block = $(`
        <div class="xp_char">
            <div class="xp_char_header">
                <i class="fa-solid fa-user"></i>
                <b class="xp_char_name">${escapeHtml(ch.name)}</b>
                <div class="xp_char_actions">
                    <div class="menu_button xp_btn interactable" data-act="add" title="Add images (each filename becomes an expression; suffixes like -1 group as variants)"><i class="fa-solid fa-file-circle-plus"></i></div>
                    <div class="menu_button xp_btn interactable" data-act="rename" title="Rename character"><i class="fa-solid fa-pencil"></i></div>
                    <div class="menu_button xp_btn interactable" data-act="remove" title="Remove character from this card (image files stay on disk)"><i class="fa-solid fa-xmark"></i></div>
                </div>
            </div>
            <div class="xp_char_folder">
                <small>Folder</small>
                <input type="text" class="text_pole xp_folder_input" value="${escapeHtml(ch.folder)}" title="Sprite folder, relative to /characters/. Edit and press Enter." />
            </div>
            <div class="xp_expr_grid"></div>
            <div class="xp_drop_hint"><i class="fa-solid fa-images"></i> Drop images here</div>
        </div>
    `);

    const $grid = $block.find('.xp_expr_grid');
    if (expressions.length === 0) {
        $grid.append('<div class="xp_hint">No expressions. Add images, or put files in the folder and Scan.</div>');
    }
    for (const entry of expressions) {
        const thumb = entry.files[0]?.imageSrc || '';
        const $chip = $(`
            <div class="xp_expr interactable" title="Click to display this expression">
                <img class="xp_expr_thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy" />
                <span class="xp_expr_label">${escapeHtml(entry.label)}</span>
                ${entry.files.length > 1 ? `<span class="xp_expr_count">×${entry.files.length}</span>` : ''}
                <i class="xp_expr_edit fa-solid fa-pencil" title="Rename expression (renames the files)"></i>
                <i class="xp_expr_del fa-solid fa-xmark" title="Delete expression and its image files"></i>
            </div>
        `);
        $chip.on('click', (e) => {
            if ($(e.target).is('.xp_expr_edit, .xp_expr_del')) return;
            showSprite({ char: ch.name, label: entry.label, files: entry.files });
        });
        $chip.find('.xp_expr_edit').on('click', async (e) => {
            e.stopPropagation();
            await onRenameExpression(ch, entry);
        });
        $chip.find('.xp_expr_del').on('click', async (e) => {
            e.stopPropagation();
            await onDeleteExpression(ch, entry);
        });
        $grid.append($chip);
    }

    // Header actions
    $block.find('[data-act="add"]').on('click', () => pickAndUpload(ch));
    $block.find('[data-act="rename"]').on('click', async () => {
        const newName = await Popup.show.input('Rename character', 'Display name used in the sprite list sent to the AI:', ch.name);
        if (!newName || newName.trim() === ch.name) return;
        ch.name = newName.trim();
        saveSettingsDebounced();
        await renderTree();
    });
    $block.find('[data-act="remove"]').on('click', async () => {
        const ok = await Popup.show.confirm('Remove character', `Remove <b>${escapeHtml(ch.name)}</b> from this card?<br><small>Image files are NOT deleted — you can re-add the character later and Scan to get everything back.</small>`);
        if (!ok) return;
        card.characters = card.characters.filter(x => x !== ch);
        delete folderCache[ch.folder];
        saveSettingsDebounced();
        await renderTree();
    });

    // Folder edit (Enter or blur applies)
    const applyFolder = async (input) => {
        const value = String($(input).val()).trim().replace(/^\/+|\/+$/g, '');
        if (!value || value === ch.folder) return;
        delete folderCache[ch.folder];
        ch.folder = value;
        saveSettingsDebounced();
        await scanFolder(ch.folder);
        await renderTree();
    };
    $block.find('.xp_folder_input')
        .on('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); this.blur(); } })
        .on('blur', function () { applyFolder(this); });

    // Drag & drop upload onto the whole block
    const el = $block.get(0);
    const setActive = (on) => el.classList.toggle('xp_drop_active', on);
    el.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); setActive(true); });
    el.addEventListener('dragenter', (e) => { e.preventDefault(); e.stopPropagation(); setActive(true); });
    el.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); setActive(false); });
    el.addEventListener('drop', async (e) => {
        e.preventDefault(); e.stopPropagation(); setActive(false);
        const files = e.dataTransfer?.files;
        if (files?.length) await handleUpload(ch, files);
    });

    return $block;
}

/** Opens a multi-file picker and uploads into the character's folder. */
function pickAndUpload(ch) {
    const input = document.getElementById('xp_file_input');
    if (!(input instanceof HTMLInputElement)) return;
    input.onchange = async () => {
        if (input.files?.length) await handleUpload(ch, input.files);
        input.value = '';
    };
    input.click();
}

async function handleUpload(ch, files) {
    const toast = toastr.info(`Uploading ${files.length} file(s)…`, 'Expressions Plus', { timeOut: 0, extendedTimeOut: 0 });
    const { uploaded, failed } = await bulkUpload(ch.folder, files);
    toastr.clear(toast);
    if (uploaded) toastr.success(`${uploaded} image(s) added to ${ch.name}.`, 'Expressions Plus');
    if (failed) toastr.error(`${failed} file(s) failed. See console.`, 'Expressions Plus');
    await scanFolder(ch.folder);
    await renderTree();
}

async function onRenameExpression(ch, entry) {
    const input = await Popup.show.input('Rename expression', `New name for <tt>${escapeHtml(entry.label)}</tt> (letters, numbers, dashes, underscores). All ${entry.files.length} image file(s) will be renamed on disk:`, entry.label);
    if (!input) return;
    const newLabel = sanitizeLabel(input);
    if (!newLabel) {
        toastr.warning('Invalid expression name.', 'Expressions Plus');
        return;
    }
    if (newLabel === entry.label) return;
    const existing = (folderCache[ch.folder] || []).some(x => x.label === newLabel);
    if (existing) {
        toastr.warning(`Expression "${newLabel}" already exists in this folder.`, 'Expressions Plus');
        return;
    }
    try {
        await renameExpression(ch.folder, entry, newLabel);
        toastr.success(`Renamed to ${newLabel}.`, 'Expressions Plus');
    } catch (err) {
        console.error('[expressions-plus] Rename failed:', err);
        toastr.error(`Rename failed: ${err.message}`, 'Expressions Plus');
    }
    await scanFolder(ch.folder);
    await renderTree();
}

async function onDeleteExpression(ch, entry) {
    const ok = await Popup.show.confirm('Delete expression', `Delete <tt>${escapeHtml(entry.label)}</tt> and its ${entry.files.length} image file(s)? This removes the files from disk.`);
    if (!ok) return;
    for (const file of entry.files) {
        await deleteSpriteFile(ch.folder, entry.label, withoutExtension(file.fileName));
    }
    await scanFolder(ch.folder);
    await renderTree();
}

async function onAddCharacter() {
    const cardKey = getCardKey();
    if (!cardKey) {
        toastr.warning('Open a chat with a character first.', 'Expressions Plus');
        return;
    }
    const card = getCardData(true);
    const name = await Popup.show.input('Add character', 'Name of the character in the story (as the AI should see it):');
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    if (card.characters.some(x => x.name.toLowerCase() === trimmed.toLowerCase())) {
        toastr.warning('A character with that name already exists on this card.', 'Expressions Plus');
        return;
    }
    const folder = `${cardKey}/${sanitizeFolderPart(trimmed)}`;
    card.characters.push({ name: trimmed, folder });
    saveSettingsDebounced();
    await scanFolder(folder);
    await renderTree();
    toastr.info(`Added ${trimmed}. Drop images onto their block, or fill ${folder}/ on disk and Scan.`, 'Expressions Plus');
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring
// ─────────────────────────────────────────────────────────────────────────────

function addSpriteHolder() {
    const html = `
        <div id="xp-wrapper">
            <div id="xp-holder" class="xp-holder" style="display:none;">
                <div id="xp-holderheader" class="fa-solid fa-grip drag-grabber"></div>
                <img id="xp-image" class="xp-image" alt="" />
            </div>
        </div>`;
    $('body').append(html);
    loadMovingUIState();
    dragElement($('#xp-holder'));
    $(document).on('dragstart', '#xp-image', (e) => { e.preventDefault(); return false; });
}

async function addSettingsPanel() {
    const template = await renderExtensionTemplateAsync(TEMPLATE_NAMESPACE, 'settings');
    $('#extensions_settings2').append(template);

    const s = getSettings();

    // General toggles
    $('#xp_enabled').prop('checked', s.enabled).on('input', function () {
        s.enabled = !!$(this).prop('checked');
        if (!s.enabled) hideSprite();
        saveSettingsDebounced();
    });
    $('#xp_on_ai').prop('checked', s.onAiMessages).on('input', function () {
        s.onAiMessages = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#xp_on_user').prop('checked', s.onUserMessages).on('input', function () {
        s.onUserMessages = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#xp_on_swipe').prop('checked', s.onSwipe).on('input', function () {
        s.onSwipe = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#xp_history_depth').val(s.historyDepth).on('input', function () {
        const value = parseInt(String($(this).val()), 10);
        s.historyDepth = Number.isFinite(value) && value >= 1 ? value : 1;
        saveSettingsDebounced();
    });
    $('#xp_reroll').prop('checked', s.rerollIfSame).on('input', function () {
        s.rerollIfSame = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    // Endpoint
    $('#xp_api_url').val(s.apiUrl).on('input', function () {
        s.apiUrl = String($(this).val()).trim();
        saveSettingsDebounced();
    });
    $('#xp_api_key').val(s.apiKey).on('input', function () {
        s.apiKey = String($(this).val());
        saveSettingsDebounced();
    });
    $('#xp_api_model').val(s.apiModel).on('input', function () {
        s.apiModel = String($(this).val()).trim();
        saveSettingsDebounced();
    });
    $('#xp_api_proxy').prop('checked', !!s.apiProxy).on('input', function () {
        s.apiProxy = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#xp_api_test').on('click', async function () {
        const $btn = $(this);
        $btn.addClass('disabled');
        const res = await testCustomEndpoint({ url: s.apiUrl, key: s.apiKey, model: s.apiModel, useProxy: !!s.apiProxy });
        $btn.removeClass('disabled');
        res.success ? toastr.success(res.message, 'Expressions Plus') : toastr.error(res.message, 'Expressions Plus');
    });

    // Prompt
    $('#xp_prompt').val(s.prompt).on('input', function () {
        s.prompt = String($(this).val());
        saveSettingsDebounced();
    });
    $('#xp_prompt_restore').on('click', function () {
        $('#xp_prompt').val(DEFAULT_PROMPT);
        s.prompt = DEFAULT_PROMPT;
        saveSettingsDebounced();
    });

    // Card management
    $('#xp_add_character').on('click', onAddCharacter);
    $('#xp_scan').on('click', async () => {
        const card = getCardData();
        if (!card) {
            toastr.warning('Open a chat with a character first.', 'Expressions Plus');
            return;
        }
        await scanAll();
        await renderTree();
        const total = getOptions().length;
        toastr.success(`Scan complete. ${total} expression(s) with images available.`, 'Expressions Plus');
    });

    await renderTree();
}

function bindEvents() {
    const s = getSettings();

    const onAiMessage = () => {
        if (!s.enabled || !s.onAiMessages) return;
        classifyDebounced();
    };
    const onUserMessage = () => {
        if (!s.enabled || !s.onUserMessages) return;
        classifyDebounced();
    };
    const onSwipeOrEdit = () => {
        if (!s.enabled || !s.onSwipe) return;
        lastClassifiedText = null; // text may be identical mid-swipe; force re-check
        classifyDebounced();
    };

    // Prefer post-render events (fire after streaming completes); fall back for older builds.
    const aiEvent = event_types.CHARACTER_MESSAGE_RENDERED || event_types.MESSAGE_RECEIVED;
    const userEvent = event_types.USER_MESSAGE_RENDERED || event_types.MESSAGE_SENT;

    eventSource.on(aiEvent, onAiMessage);
    eventSource.on(userEvent, onUserMessage);
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, onSwipeOrEdit);
    if (event_types.MESSAGE_EDITED) eventSource.on(event_types.MESSAGE_EDITED, onSwipeOrEdit);

    eventSource.on(event_types.CHAT_CHANGED, async () => {
        hideSprite();
        lastClassifiedText = null;
        folderCache = {};
        await scanAll();
        await renderTree();
    });
}

(async function init() {
    getSettings();
    addSpriteHolder();
    await addSettingsPanel();
    bindEvents();
    // Initial pass for an already-open chat
    await scanAll();
    await renderTree();
})();
