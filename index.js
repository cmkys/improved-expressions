/**
 * Expressions Plus — multi-character, per-card sprite automation for SillyTavern.
 *
 * Data model: Card → Story Character → (Groups) → Expressions → Images.
 *
 * GROUPS organize action sequences (jumping_brace, jumping, jumping_in_air…).
 * A group is a disk subfolder <char>/<group>/. When an expression joins a
 * group, the group's prefix is stripped from its filenames (jumping_brace →
 * brace inside jumping/), and the full label is reconstructed automatically
 * for the AI (jumping_brace). Moving an expression out of a group — or
 * dissolving the group — restores the prefix in the filenames. Auto-sort
 * finds ungrouped expressions matching a group's prefix and pulls them in;
 * expressions already inside groups are never touched by it. Groups are
 * collapsed by default, renamable, and expressions can be dragged between
 * groups / out of groups.
 *
 * An ungrouped expression's images can come from two sources, combined:
 *  1. Suffix-named files in the character folder (casual.png, casual-1.png)
 *  2. A registered expression subfolder (<char>/casual/ — every image inside
 *     counts as "casual", whatever it's named)
 *
 * Tags: expressions and individual images can carry setting/outfit/mood
 * descriptions; images are grouped by effective tag into variant options for
 * the classifier ("Alice/casual", "Alice/casual.2 — beach"). Recent tags are
 * offered as one-click chips.
 *
 * Classification is event-driven (no polling), goes through a separate
 * OpenAI-compatible endpoint (never the main chat API), and expressions
 * without images are never sent — so empty setups can't error.
 */

import { eventSource, event_types, getRequestHeaders, saveSettingsDebounced, substituteParams } from '../../../../script.js';
import { getContext, extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { dragElement } from '../../../RossAscends-mods.js';
import { loadMovingUIState } from '../../../power-user.js';
import { getCharaFilename, debounce } from '../../../utils.js';
import { Popup } from '../../../popup.js';
import { classifyViaCustomEndpoint, testCustomEndpoint } from './custom-endpoint.js';

const MODULE_NAME = 'expressionsPlus';
const EXPORT_VERSION = 2;

// Resolve the template namespace from wherever this folder was actually installed,
// so renames of the extension folder don't break template loading.
const FOLDER_MATCH = /third-party\/([^/]+)\//.exec(import.meta.url);
const TEMPLATE_NAMESPACE = FOLDER_MATCH ? `third-party/${FOLDER_MATCH[1]}` : 'third-party/expressions-plus';

const DEFAULT_PROMPT_V1 = [
    'You are choosing which character sprite to display for a roleplay chat.',
    'Available sprites, one per line, in the form Character/expression:',
    '{{labels}}',
    'Based on the conversation, reply with exactly one entry from the list, copied verbatim (Character/expression). Output nothing else.',
].join('\n');

const DEFAULT_PROMPT = [
    'You are choosing which character sprite to display for a roleplay chat.',
    'Available sprites, one per line, in the form Character/expression:',
    '{{labels}}',
    'Some entries have a description after " — " telling you the setting, outfit, or mood that sprite depicts. Use those descriptions to pick the most fitting option for the current scene.',
    'Based on the conversation, reply with exactly one entry\'s Character/expression part, copied verbatim. Do not include the description. Output nothing else.',
].join('\n');

/**
 * @typedef {object} SpriteImage
 * @property {string} fileName - file name with extension
 * @property {string} title - file name without extension
 * @property {string} imageSrc - URL/path served by SillyTavern
 * @property {string} srcFolder - the folder this file actually lives in (needed for delete)
 * @property {string} srcLabel - the label the server assigned this file (needed for delete)
 * @property {boolean} [fromFolder=false] - true when sourced from an expression subfolder
 */

/**
 * @typedef {object} ExpressionEntry
 * @property {string} label - EFFECTIVE label (group prefix included), what the AI sees
 * @property {SpriteImage[]} files
 * @property {string} [tag] - expression-level setting/outfit/mood description
 * @property {boolean} [fromFolder=false] - true when any image comes from an expression subfolder
 * @property {string} [subfolder] - registered expression-subfolder name backing this entry, if any
 * @property {string} [group] - group this expression belongs to, if any
 * @property {string} [innerLabel] - label inside the group folder (prefix stripped)
 */

/**
 * @typedef {object} StoryCharacter
 * @property {string} name - display name the AI sees
 * @property {string} folder - sprite folder relative to /characters/
 * @property {string[]} subfolders - registered expression subfolder names
 * @property {string[]} groups - registered group subfolder names
 * @property {{[label: string]: string}} tags - per-expression descriptions (keyed by effective label)
 * @property {{[key: string]: string}} imageTags - per-image descriptions, keyed "effectiveLabel::title"
 */

/** In-memory cache: folder path → raw server-grouped entries */
let folderCache = {};
/** Prevents overlapping classifier calls */
let inApiCall = false;
/** The last prompt text we classified, to avoid duplicate calls */
let lastClassifiedText = null;
/** Currently displayed sprite (for reroll-if-same) */
let currentSprite = { char: null, label: null, src: null };
/** Session-only history of the last 5 tags entered (newest first) */
let sessionTagHistory = [];
/** Which expression panels are expanded, keyed "folder::effectiveLabel" */
let expandedExpressions = new Set();
/** Which group sections are expanded, keyed "folder::group::name" */
let expandedGroups = new Set();
/** Internal chip drag payload */
let currentDrag = null;

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
    def('stripCharName', true);
    def('prompt', DEFAULT_PROMPT);
    def('apiUrl', '');
    def('apiKey', '');
    def('apiModel', '');
    def('apiProxy', false);
    def('cards', {});

    // Migrate v1 default prompt to the tag-aware default (only if untouched).
    if (s.prompt === DEFAULT_PROMPT_V1) {
        s.prompt = DEFAULT_PROMPT;
        changed = true;
    }

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
 * Gets (and optionally creates) the stored data for the current card,
 * migrating older character entries to the current shape.
 * @param {boolean} [create=false]
 * @returns {{characters: StoryCharacter[]}|null}
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
    const card = s.cards[cardKey];
    if (!Array.isArray(card.characters)) card.characters = [];
    for (const ch of card.characters) {
        if (!Array.isArray(ch.subfolders)) ch.subfolders = [];
        if (!Array.isArray(ch.groups)) ch.groups = [];
        if (!ch.tags || typeof ch.tags !== 'object') ch.tags = {};
        if (!ch.imageTags || typeof ch.imageTags !== 'object') ch.imageTags = {};
    }
    return card;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
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

function subfolderPath(ch, sub) {
    return `${ch.folder}/${sub}`;
}

function imageTagKey(label, title) {
    return `${label}::${title}`;
}

/** Effective tag of one image: its own tag, falling back to the expression tag. */
function effectiveImageTag(ch, label, file, expressionTag) {
    return ch.imageTags[imageTagKey(label, file.title)] || expressionTag || '';
}

/**
 * Effective label of a group member: the group's prefix is added back unless
 * the inner name IS the group name (jumping.png inside jumping/ → "jumping").
 */
function effLabel(group, inner) {
    return inner === group ? group : `${group}_${inner}`;
}

/** Splits a sprite name into its group label ("casual-2" → "casual"). */
function groupLabelOf(spriteName) {
    let label = String(spriteName).split('.')[0];
    const dashNum = /^(.+)-(\d+)$/.exec(label);
    if (dashNum) label = dashNum[1];
    return sanitizeLabel(label);
}

/**
 * Returns the next free sprite name inside a group: the plain label if
 * unused, otherwise label-1, label-2, ... skipping taken numbers.
 * @param {string} label
 * @param {Set<string>} used - taken sprite names (without extension)
 * @returns {string}
 */
function nextGroupName(label, used) {
    if (!used.has(label)) return label;
    let i = 1;
    while (used.has(`${label}-${i}`)) i++;
    return `${label}-${i}`;
}

/**
 * Removes references to the character's name from a filename-derived string
 * to prevent redundant labels: for "Bob Stinger", "bob_happy" → "happy".
 * Works segment-wise so partial words are safe. Never returns an empty result.
 * @param {string} raw
 * @param {string} charName
 * @returns {string}
 */
function stripCharacterName(raw, charName) {
    const tokens = String(charName || '')
        .toLowerCase()
        .split(/[\s_\-.]+/)
        .filter(t => t.length >= 2);
    if (tokens.length === 0) return raw;

    const segments = String(raw).split(/[\s_\-.]+/).filter(Boolean);
    const kept = segments.filter(seg => !tokens.includes(seg.toLowerCase()));
    if (kept.length === 0) return raw; // don't produce an empty name
    return kept.join('_');
}

/** @param {Blob} blob @returns {Promise<string>} base64 (no data: prefix) */
function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(new Error('Could not read blob'));
        reader.readAsDataURL(blob);
    });
}

/** @param {string} b64 @param {string} name @param {string} mime @returns {File} */
function base64ToFile(b64, name, mime) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: mime || 'image/png' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Sprite folder scanning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads a sprite folder from the server and groups files by the label the
 * server assigned (which already applies the suffix convention).
 * @param {string} folder - folder path relative to /characters/
 * @returns {Promise<{label: string, files: SpriteImage[]}[]>}
 */
async function scanFolder(folder) {
    if (!folder) return [];
    try {
        const result = await fetch(`/api/sprites/get?name=${encodeURIComponent(folder)}`);
        /** @type {{label: string, path: string}[]} */
        const sprites = result.ok ? await result.json() : [];

        const grouped = [];
        for (const sprite of sprites) {
            if (!sprite?.label || !sprite?.path) continue;
            const fileName = sprite.path.split('/').pop().split('?')[0];
            const image = {
                fileName,
                title: withoutExtension(fileName),
                imageSrc: sprite.path,
                srcFolder: folder,
                srcLabel: sprite.label,
            };
            const existing = grouped.find(x => x.label === sprite.label);
            if (existing) existing.files.push(image);
            else grouped.push({ label: sprite.label, files: [image] });
        }

        folderCache[folder] = grouped;
        return grouped;
    } catch (err) {
        console.error('[expressions-plus] Failed to scan folder', folder, err);
        folderCache[folder] = [];
        return [];
    }
}

/** Re-scans a character's main folder, expression subfolders, and group folders. */
async function scanCharacter(ch) {
    await scanFolder(ch.folder);
    await Promise.all([
        ...ch.subfolders.map(sub => scanFolder(subfolderPath(ch, sub))),
        ...ch.groups.map(g => scanFolder(subfolderPath(ch, g))),
    ]);
}

/** Re-scans every registered character for the current card. */
async function scanAll() {
    const card = getCardData();
    if (!card) return;
    await Promise.all(card.characters.map(ch => scanCharacter(ch)));
}

/**
 * Builds the merged expression list for one character:
 * - main-folder suffix groups
 * - expression subfolders (all images inside = one label)
 * - group folders (each label inside = an expression with the group prefix
 *   added back to form the effective label)
 * @param {StoryCharacter} ch
 * @returns {ExpressionEntry[]}
 */
function getCharacterExpressions(ch) {
    /** @type {Map<string, ExpressionEntry>} */
    const map = new Map();
    const push = (label, file) => {
        let entry = map.get(label);
        if (!entry) {
            entry = { label, files: [], fromFolder: false, subfolder: undefined, group: undefined, innerLabel: undefined };
            map.set(label, entry);
        }
        entry.files.push(file);
        return entry;
    };

    for (const raw of folderCache[ch.folder] || []) {
        for (const file of raw.files) {
            push(raw.label, { ...file, fromFolder: false });
        }
    }

    for (const sub of ch.subfolders) {
        const path = subfolderPath(ch, sub);
        const label = sanitizeLabel(sub);
        if (!label) continue;
        for (const raw of folderCache[path] || []) {
            for (const file of raw.files) {
                const entry = push(label, { ...file, fromFolder: true });
                entry.fromFolder = true;
                entry.subfolder = sub;
            }
        }
        // Registered but empty/missing folder → stub, so the user can see and
        // unregister the registration. Never sent to the LLM.
        if (!map.has(label)) {
            map.set(label, { label, files: [], fromFolder: true, subfolder: sub, group: undefined, innerLabel: undefined });
        }
    }

    for (const g of ch.groups) {
        const path = subfolderPath(ch, g);
        for (const raw of folderCache[path] || []) {
            const inner = raw.label;
            const label = effLabel(g, inner);
            for (const file of raw.files) {
                const entry = push(label, { ...file, fromFolder: false });
                entry.group = g;
                entry.innerLabel = inner;
            }
        }
    }

    const entries = [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
    for (const entry of entries) {
        entry.tag = ch.tags[entry.label] || '';
        const anchor = entry.innerLabel ?? entry.label;
        entry.files.sort((a, b) => {
            if (a.title === anchor) return -1;
            if (b.title === anchor) return 1;
            return a.title.localeCompare(b.title);
        });
    }
    return entries;
}

/**
 * All selectable options for the current card, only from expressions that
 * have images. Effective (group-prefixed) labels are used, so the AI always
 * sees the full action name. Within an expression, images are grouped by
 * effective tag; multiple distinct tags split into variant options
 * ("Alice/casual", "Alice/casual.2").
 * @returns {{char: string, key: string, label: string, tag: string, files: SpriteImage[]}[]}
 */
function getOptions() {
    const card = getCardData();
    if (!card) return [];
    const options = [];
    for (const ch of card.characters) {
        for (const entry of getCharacterExpressions(ch)) {
            if (entry.files.length === 0) continue;

            /** @type {Map<string, SpriteImage[]>} */
            const byTag = new Map();
            for (const file of entry.files) {
                const tag = effectiveImageTag(ch, entry.label, file, entry.tag);
                if (!byTag.has(tag)) byTag.set(tag, []);
                byTag.get(tag).push(file);
            }

            if (byTag.size <= 1) {
                const tag = byTag.keys().next().value || '';
                options.push({ char: ch.name, key: entry.label, label: entry.label, tag, files: entry.files });
                continue;
            }

            const baseTag = entry.tag || '';
            const groups = [...byTag.entries()].sort((a, b) => {
                if (a[0] === baseTag) return -1;
                if (b[0] === baseTag) return 1;
                return a[0].localeCompare(b[0]);
            });
            groups.forEach(([tag, files], index) => {
                const key = index === 0 ? entry.label : `${entry.label}.${index + 1}`;
                options.push({ char: ch.name, key, label: entry.label, tag, files });
            });
        }
    }
    return options;
}

// ─────────────────────────────────────────────────────────────────────────────
// File operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Uploads one image file.
 * @param {string} folder - sprite folder (may be a subfolder/group path)
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
 * Deletes one sprite file from its actual source folder.
 * @param {string} folder
 * @param {string} label - the label the SERVER assigned this file
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
 * suffix convention, and optionally stripping the character's name
 * ("bob_happy.png" for Bob Stinger → "happy").
 * @param {string} fileName
 * @param {string} [charName]
 * @returns {{label: string, spriteName: string}}
 */
function labelFromFileName(fileName, charName = '') {
    const s = getSettings();
    const strip = (str) => (s.stripCharName && charName ? stripCharacterName(str, charName) : str);

    const base = withoutExtension(fileName);
    let label = base.split('.')[0];
    const dashNum = /^(.+)-(\d+)$/.exec(label);
    if (dashNum) label = dashNum[1];
    label = sanitizeLabel(strip(label));

    let spriteName = sanitizeLabel(strip(base.replace(/\./g, '_'))) || label;
    return { label, spriteName };
}

/**
 * Bulk uploads loose image files into a folder, labels derived from filenames
 * (character name stripped).
 * @param {StoryCharacter} ch
 * @param {string} folder
 * @param {File[]} files
 * @returns {Promise<{uploaded: number, failed: number}>}
 */
async function bulkUpload(ch, folder, files) {
    const list = Array.from(files || []).filter(f => f && f.type?.startsWith('image/'));
    let uploaded = 0, failed = 0;
    for (const file of list) {
        const { label, spriteName } = labelFromFileName(file.name, ch.name);
        if (!label) { failed++; continue; }
        const res = await uploadSpriteFile(folder, file, label, spriteName);
        res.ok ? uploaded++ : failed++;
        if (!res.ok) console.warn('[expressions-plus] Upload failed:', file.name, res.error);
    }
    return { uploaded, failed };
}

/**
 * Uploads a batch of images into an expression subfolder — every file counts
 * as that one expression; filenames (name-stripped) only need to be unique.
 * @param {StoryCharacter} ch
 * @param {string} subName
 * @param {File[]} files
 * @returns {Promise<{uploaded: number, failed: number}>}
 */
async function uploadIntoSubfolder(ch, subName, files) {
    const s = getSettings();
    const folder = subfolderPath(ch, subName);
    const label = sanitizeLabel(subName) || 'expression';
    const usedNames = new Set(
        (folderCache[folder] || []).flatMap(e => e.files.map(f => withoutExtension(f.fileName))),
    );
    let uploaded = 0, failed = 0, index = 0;
    for (const file of Array.from(files || [])) {
        if (!file?.type?.startsWith('image/')) { failed++; continue; }
        let base = withoutExtension(file.name).replace(/\./g, '_');
        if (s.stripCharName) base = stripCharacterName(base, ch.name);
        let spriteName = sanitizeLabel(base) || label;
        while (usedNames.has(spriteName)) {
            spriteName = `${label}_${++index}`;
        }
        usedNames.add(spriteName);
        const res = await uploadSpriteFile(folder, file, label, spriteName);
        res.ok ? uploaded++ : failed++;
        if (!res.ok) console.warn('[expressions-plus] Upload failed:', file.name, res.error);
    }
    return { uploaded, failed };
}

/**
 * Core move/rename primitive. Re-uploads every image of an expression into
 * destFolder as innerBase(-N) variants, deletes the originals, unregisters a
 * backing expression subfolder if any, and migrates the expression tag and
 * per-image tags from the old effective label to newEffLabel (an existing tag
 * on the target wins). Collision-safe: reserves every existing file name in
 * the destination AND the entry's own files, so nothing is overwritten
 * before its data has been copied. SillyTavern has no rename/move endpoint,
 * so this is fetch → re-upload → delete.
 * @param {StoryCharacter} ch
 * @param {ExpressionEntry} entry
 * @param {string} destFolder
 * @param {string} innerBase - base sprite name in the destination
 * @param {string} newEffLabel - effective label after the operation
 */
async function relocateExpression(ch, entry, destFolder, innerBase, newEffLabel) {
    /** @type {{oldTitle: string, newTitle: string}[]} */
    const titleMap = [];

    const used = new Set((folderCache[destFolder] || []).flatMap(e => e.files.map(f => withoutExtension(f.fileName))));
    for (const file of entry.files) used.add(withoutExtension(file.fileName));

    for (const file of entry.files) {
        const response = await fetch(file.imageSrc, { cache: 'no-cache' });
        if (!response.ok) throw new Error(`Could not read ${file.fileName}`);
        const blob = await response.blob();
        const ext = (file.fileName.split('.').pop() || 'png').toLowerCase();
        const spriteName = nextGroupName(innerBase, used);
        used.add(spriteName);
        const newFile = new File([blob], `${spriteName}.${ext}`, { type: blob.type || 'image/png' });
        const res = await uploadSpriteFile(destFolder, newFile, groupLabelOf(spriteName) || innerBase, spriteName);
        if (!res.ok) throw new Error(res.error || 'upload failed');
        titleMap.push({ oldTitle: file.title, newTitle: spriteName });
    }
    for (const file of entry.files) {
        await deleteSpriteFile(file.srcFolder, file.srcLabel, withoutExtension(file.fileName));
    }
    if (entry.subfolder) {
        ch.subfolders = ch.subfolders.filter(sub => sub !== entry.subfolder);
        delete folderCache[subfolderPath(ch, entry.subfolder)];
    }

    if (entry.label !== newEffLabel && ch.tags[entry.label]) {
        if (!ch.tags[newEffLabel]) ch.tags[newEffLabel] = ch.tags[entry.label];
        delete ch.tags[entry.label];
    }
    for (const { oldTitle, newTitle } of titleMap) {
        const oldKey = imageTagKey(entry.label, oldTitle);
        if (ch.imageTags[oldKey]) {
            const newKey = imageTagKey(newEffLabel, newTitle);
            if (newKey !== oldKey) {
                ch.imageTags[newKey] = ch.imageTags[oldKey];
                delete ch.imageTags[oldKey];
            }
        }
    }
    saveSettingsDebounced();
}

/**
 * Renames an expression in place (within its group if it has one, otherwise
 * in the main folder). If the new label already exists there, the images join
 * that group as the next free -N variants.
 * @param {StoryCharacter} ch
 * @param {ExpressionEntry} entry
 * @param {string} newName - inner name for grouped entries, full label otherwise
 * @returns {Promise<string>} the new effective label
 */
async function renameExpression(ch, entry, newName) {
    const destFolder = entry.group ? subfolderPath(ch, entry.group) : ch.folder;
    const newEff = entry.group ? effLabel(entry.group, newName) : newName;
    await relocateExpression(ch, entry, destFolder, newName, newEff);
    return newEff;
}

/**
 * Moves an expression into a group (stripping the group's prefix from its
 * filenames) or out to the main folder (restoring the full effective label
 * into the filenames).
 * @param {StoryCharacter} ch
 * @param {ExpressionEntry} entry
 * @param {string|null} targetGroup - null = main (ungrouped)
 * @returns {Promise<string|null>} new effective label, or null if it was a no-op
 */
async function moveExpressionToGroup(ch, entry, targetGroup) {
    if ((entry.group || null) === (targetGroup || null)) return null;

    let destFolder, innerBase, newEff;
    if (targetGroup) {
        if (entry.label === targetGroup) innerBase = targetGroup;
        else if (entry.label.startsWith(`${targetGroup}_`)) innerBase = entry.label.slice(targetGroup.length + 1);
        else innerBase = entry.label;
        destFolder = subfolderPath(ch, targetGroup);
        newEff = effLabel(targetGroup, innerBase);
    } else {
        destFolder = ch.folder;
        innerBase = entry.label; // effective label goes back into the filename
        newEff = entry.label;
    }

    await scanFolder(destFolder); // fresh collision data
    await relocateExpression(ch, entry, destFolder, innerBase, newEff);
    return newEff;
}

/**
 * Renames one image (variant) within its current container (group folder or
 * main folder). The new name decides its expression group there; if the name
 * is taken, the next free -N number in that group is used.
 * @param {StoryCharacter} ch
 * @param {ExpressionEntry} entry
 * @param {SpriteImage} file
 * @param {string} newSpriteName - sanitized new file name without extension
 * @returns {Promise<{newEff: string, finalName: string}>}
 */
async function renameImage(ch, entry, file, newSpriteName) {
    const destFolder = entry.group ? subfolderPath(ch, entry.group) : ch.folder;
    const innerLabel = groupLabelOf(newSpriteName);
    if (!innerLabel) throw new Error('Invalid name');
    const newEff = entry.group ? effLabel(entry.group, innerLabel) : innerLabel;

    const response = await fetch(file.imageSrc, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Could not read ${file.fileName}`);
    const blob = await response.blob();
    const ext = (file.fileName.split('.').pop() || 'png').toLowerCase();
    const newFile = new File([blob], `${newSpriteName}.${ext}`, { type: blob.type || 'image/png' });

    const res = await uploadSpriteFile(destFolder, newFile, innerLabel, newSpriteName);
    if (!res.ok) throw new Error(res.error || 'upload failed');

    await deleteSpriteFile(file.srcFolder, file.srcLabel, withoutExtension(file.fileName));

    const oldKey = imageTagKey(entry.label, file.title);
    if (ch.imageTags[oldKey]) {
        ch.imageTags[imageTagKey(newEff, newSpriteName)] = ch.imageTags[oldKey];
        delete ch.imageTags[oldKey];
    }
    saveSettingsDebounced();
    return { newEff, finalName: newSpriteName };
}

// ─────────────────────────────────────────────────────────────────────────────
// Group operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Auto-sort: moves every ungrouped, non-expression-folder expression whose
 * label matches a group (exact name or "<group>_" prefix; longest prefix
 * wins) into that group. Expressions already inside groups are untouched.
 * @param {StoryCharacter} ch
 * @returns {Promise<number>} how many were moved
 */
async function autoSortIntoGroups(ch) {
    if (ch.groups.length === 0) return 0;
    const byLength = [...ch.groups].sort((a, b) => b.length - a.length);
    const candidates = getCharacterExpressions(ch)
        .filter(e => !e.group && !e.fromFolder && e.files.length > 0);

    let moved = 0;
    for (const snapshot of candidates) {
        const g = byLength.find(x => snapshot.label === x || snapshot.label.startsWith(`${x}_`));
        if (!g) continue;
        // Re-resolve the entry fresh — earlier moves may have changed caches
        await scanFolder(ch.folder);
        const entry = getCharacterExpressions(ch).find(x => x.label === snapshot.label && !x.group);
        if (!entry || entry.files.length === 0) continue;
        try {
            await moveExpressionToGroup(ch, entry, g);
            moved++;
        } catch (err) {
            console.error('[expressions-plus] Auto-sort failed for', snapshot.label, err);
        }
    }
    return moved;
}

/**
 * Dissolves a group: every member returns to the main folder with the
 * group's prefix restored in its filenames, then the group is unregistered.
 * @param {StoryCharacter} ch
 * @param {string} g
 * @returns {Promise<number>} how many expressions were restored
 */
async function dissolveGroup(ch, g) {
    let restored = 0;
    // Loop until no members remain, resolving fresh each time
    for (;;) {
        await scanFolder(subfolderPath(ch, g));
        await scanFolder(ch.folder);
        const entry = getCharacterExpressions(ch).find(x => x.group === g && x.files.length > 0);
        if (!entry) break;
        await moveExpressionToGroup(ch, entry, null);
        restored++;
        if (restored > 500) break; // safety
    }
    ch.groups = ch.groups.filter(x => x !== g);
    delete folderCache[subfolderPath(ch, g)];
    saveSettingsDebounced();
    return restored;
}

/**
 * Renames a group: every member is re-homed into the new group folder (inner
 * names preserved; a bare "<old>" member becomes bare "<new>"), effective
 * labels and tags follow. Renaming onto an existing group merges into it.
 * @param {StoryCharacter} ch
 * @param {string} oldName
 * @param {string} newName
 * @returns {Promise<boolean>} true when merged into an existing group
 */
async function renameGroup(ch, oldName, newName) {
    const merging = ch.groups.includes(newName);
    if (!merging) ch.groups.push(newName);
    const destPath = subfolderPath(ch, newName);

    for (;;) {
        await scanFolder(subfolderPath(ch, oldName));
        await scanFolder(destPath);
        const entry = getCharacterExpressions(ch).find(x => x.group === oldName && x.files.length > 0);
        if (!entry) break;
        const inner = entry.innerLabel === oldName ? newName : entry.innerLabel;
        await relocateExpression(ch, entry, destPath, inner, effLabel(newName, inner));
    }

    ch.groups = ch.groups.filter(x => x !== oldName);
    delete folderCache[subfolderPath(ch, oldName)];
    saveSettingsDebounced();
    return merging;
}

// ─────────────────────────────────────────────────────────────────────────────
// Import / Export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Exports the current card's full setup (characters, images with data,
 * expression-subfolder and group structure, tags) into a downloadable .json
 * file that can be imported into any other card.
 */
async function exportCard() {
    const cardKey = getCardKey();
    const card = getCardData();
    if (!cardKey || !card || card.characters.length === 0) {
        toastr.warning('Nothing to export — open a chat and add at least one character.', 'Expressions Plus');
        return;
    }

    await scanAll();

    const toast = toastr.info('Collecting images…', 'Expressions Plus', { timeOut: 0, extendedTimeOut: 0 });
    let imageCount = 0;
    try {
        const characters = [];
        for (const ch of card.characters) {
            /** @type {{fileName: string, subfolder: string|null, group: string|null, mime: string, data: string}[]} */
            const images = [];

            const collect = async (folder, subfolder, group) => {
                for (const raw of folderCache[folder] || []) {
                    for (const file of raw.files) {
                        const response = await fetch(file.imageSrc, { cache: 'no-cache' });
                        if (!response.ok) {
                            console.warn('[expressions-plus] Skipping unreadable file on export:', file.imageSrc);
                            continue;
                        }
                        const blob = await response.blob();
                        images.push({
                            fileName: file.fileName,
                            subfolder,
                            group,
                            mime: blob.type || 'image/png',
                            data: await blobToBase64(blob),
                        });
                        imageCount++;
                    }
                }
            };

            await collect(ch.folder, null, null);
            for (const sub of ch.subfolders) {
                await collect(subfolderPath(ch, sub), sub, null);
            }
            for (const g of ch.groups) {
                await collect(subfolderPath(ch, g), null, g);
            }

            characters.push({
                name: ch.name,
                subfolders: [...ch.subfolders],
                groups: [...ch.groups],
                tags: { ...ch.tags },
                imageTags: { ...ch.imageTags },
                images,
            });
        }

        const payload = {
            format: 'expressions-plus-card',
            version: EXPORT_VERSION,
            exportedFrom: cardKey,
            exportedAt: new Date().toISOString(),
            characters,
        };

        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `expressions-plus_${sanitizeFolderPart(cardKey)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);

        toastr.clear(toast);
        toastr.success(`Exported ${card.characters.length} character(s), ${imageCount} image(s).`, 'Expressions Plus');
    } catch (err) {
        toastr.clear(toast);
        console.error('[expressions-plus] Export failed:', err);
        toastr.error(`Export failed: ${err.message}`, 'Expressions Plus');
    }
}

/**
 * Imports an exported setup into the CURRENT card. Characters are matched by
 * name and merged: missing images are uploaded (into their original
 * subfolder/group homes), subfolders and groups are registered, and tags are
 * merged (imported values win). Existing files are never overwritten.
 * @param {File} file - the exported .json file
 */
async function importCard(file) {
    const cardKey = getCardKey();
    if (!cardKey) {
        toastr.warning('Open a chat with a character first.', 'Expressions Plus');
        return;
    }

    let payload;
    try {
        payload = JSON.parse(await file.text());
    } catch {
        toastr.error('Not a valid export file.', 'Expressions Plus');
        return;
    }
    if (payload?.format !== 'expressions-plus-card' || !Array.isArray(payload.characters)) {
        toastr.error('Not an Expressions Plus export file.', 'Expressions Plus');
        return;
    }

    const card = getCardData(true);
    const toast = toastr.info('Importing…', 'Expressions Plus', { timeOut: 0, extendedTimeOut: 0 });
    let uploaded = 0, skipped = 0, failed = 0, newChars = 0;

    try {
        for (const incoming of payload.characters) {
            if (!incoming?.name || !Array.isArray(incoming.images)) continue;

            let ch = card.characters.find(x => x.name.toLowerCase() === String(incoming.name).toLowerCase());
            if (!ch) {
                ch = {
                    name: String(incoming.name),
                    folder: `${cardKey}/${sanitizeFolderPart(incoming.name)}`,
                    subfolders: [],
                    groups: [],
                    tags: {},
                    imageTags: {},
                };
                card.characters.push(ch);
                newChars++;
            }
            if (!Array.isArray(ch.groups)) ch.groups = [];

            for (const sub of incoming.subfolders || []) {
                const clean = sanitizeFolderPart(sub);
                if (clean && !ch.subfolders.includes(clean)) ch.subfolders.push(clean);
            }
            for (const g of incoming.groups || []) {
                const clean = sanitizeLabel(String(g).replace(/\s+/g, '_'));
                if (clean && !ch.groups.includes(clean)) ch.groups.push(clean);
            }

            await scanCharacter(ch);
            const titleCache = new Map();
            const hasTitle = (folder, title) => {
                if (!titleCache.has(folder)) {
                    titleCache.set(folder, new Set(
                        (folderCache[folder] || []).flatMap(e => e.files.map(f => withoutExtension(f.fileName))),
                    ));
                }
                return titleCache.get(folder).has(title);
            };

            for (const img of incoming.images) {
                if (!img?.fileName || !img?.data) { failed++; continue; }
                const sub = img.subfolder ? sanitizeFolderPart(img.subfolder) : null;
                const grp = img.group ? sanitizeLabel(String(img.group).replace(/\s+/g, '_')) : null;
                const destFolder = grp ? subfolderPath(ch, grp) : sub ? subfolderPath(ch, sub) : ch.folder;
                const title = withoutExtension(img.fileName);
                if (hasTitle(destFolder, title)) { skipped++; continue; }

                const label = sub ? (sanitizeLabel(sub) || 'expression') : groupLabelOf(title);
                if (!label) { failed++; continue; }

                let fileObj;
                try {
                    fileObj = base64ToFile(img.data, img.fileName, img.mime);
                } catch {
                    failed++;
                    continue;
                }
                const res = await uploadSpriteFile(destFolder, fileObj, label, title);
                if (res.ok) {
                    uploaded++;
                    titleCache.get(destFolder)?.add(title);
                } else {
                    failed++;
                    console.warn('[expressions-plus] Import upload failed:', img.fileName, res.error);
                }
            }

            Object.assign(ch.tags, incoming.tags || {});
            Object.assign(ch.imageTags, incoming.imageTags || {});
            await scanCharacter(ch);
        }

        saveSettingsDebounced();
        await renderTree();
        toastr.clear(toast);
        const parts = [`${uploaded} image(s) imported`];
        if (newChars) parts.push(`${newChars} character(s) created`);
        if (skipped) parts.push(`${skipped} already existed`);
        if (failed) parts.push(`${failed} failed`);
        toastr.success(parts.join(' · '), 'Expressions Plus');
    } catch (err) {
        toastr.clear(toast);
        console.error('[expressions-plus] Import failed:', err);
        toastr.error(`Import failed: ${err.message}`, 'Expressions Plus');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Drag & drop from the OS: loose files AND whole directories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts loose files and top-level directories (with all images inside,
 * recursively) from a DataTransfer, using the webkit entries API when
 * available so users can drop entire expression folders.
 * @param {DataTransfer} dataTransfer
 * @returns {Promise<{looseFiles: File[], folders: {name: string, files: File[]}[]}>}
 */
async function readDataTransfer(dataTransfer) {
    const looseFiles = [];
    const folders = [];

    const items = Array.from(dataTransfer?.items || []);
    const entries = items
        .map(item => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null));

    if (!entries.some(e => e)) {
        return { looseFiles: Array.from(dataTransfer?.files || []), folders };
    }

    const readFile = (fileEntry) => new Promise((resolve) => fileEntry.file(resolve, () => resolve(null)));
    const readDirAll = (dirEntry) => new Promise((resolve) => {
        const reader = dirEntry.createReader();
        const collected = [];
        const readBatch = () => reader.readEntries((batch) => {
            if (!batch.length) return resolve(collected);
            collected.push(...batch);
            readBatch();
        }, () => resolve(collected));
        readBatch();
    });
    const collectImages = async (dirEntry, sink) => {
        for (const child of await readDirAll(dirEntry)) {
            if (child.isFile) {
                const file = await readFile(child);
                if (file?.type?.startsWith('image/')) sink.push(file);
            } else if (child.isDirectory) {
                await collectImages(child, sink);
            }
        }
    };

    for (const entry of entries) {
        if (!entry) continue;
        if (entry.isFile) {
            const file = await readFile(entry);
            if (file) looseFiles.push(file);
        } else if (entry.isDirectory) {
            const files = [];
            await collectImages(entry, files);
            folders.push({ name: entry.name, files });
        }
    }

    return { looseFiles, folders };
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification
// ─────────────────────────────────────────────────────────────────────────────

function sampleText(text) {
    return substituteParams(String(text || '')).replace(/[*"]/g, '').trim();
}

/**
 * Builds the user prompt from recent chat messages.
 * @param {number} depth
 * @param {number|null} [endIndex=null] - chat index to anchor at (inclusive)
 * @returns {string|null}
 */
function buildUserPrompt(depth, endIndex = null) {
    const context = getContext();
    let chat = context.chat || [];
    if (endIndex !== null && Number.isFinite(endIndex)) {
        chat = chat.slice(0, endIndex + 1);
    }
    const usable = chat.filter(m => !m.is_system && m.mes && m.mes !== '...');
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
 * @param {string} raw
 * @param {ReturnType<typeof getOptions>} options
 * @returns {ReturnType<typeof getOptions>[number]|null}
 */
function parseResponse(raw, options) {
    let clean = String(raw || '').toLowerCase().replace(/["'`]/g, '').trim();
    if (!clean || options.length === 0) return null;

    clean = clean.split('—')[0].split(' - ')[0].trim();

    const keyed = options.map(o => ({ o, key: `${o.char}/${o.key}`.toLowerCase() }));

    const exact = keyed.find(k => k.key === clean);
    if (exact) return exact.o;

    keyed.sort((a, b) => b.key.length - a.key.length);
    const contained = keyed.find(k => clean.includes(k.key));
    if (contained) return contained.o;

    for (const k of keyed) {
        if (clean.includes(k.o.char.toLowerCase()) && clean.includes(k.o.key.toLowerCase())) {
            return k.o;
        }
    }

    const byKey = [...options].sort((a, b) => b.key.length - a.key.length);
    const keyOnly = byKey.find(o => clean.includes(o.key.toLowerCase()));
    if (keyOnly) return keyOnly;

    return null;
}

/**
 * Runs one classification pass and updates the displayed sprite.
 * @param {boolean} [force=false]
 * @param {object} [opts]
 * @param {number|null} [opts.endIndex=null]
 * @param {boolean} [opts.verbose=false]
 */
async function classify(force = false, { endIndex = null, verbose = false } = {}) {
    const s = getSettings();
    if (!s.enabled) {
        if (verbose) toastr.warning('Expressions Plus is disabled in settings.', 'Expressions Plus');
        return;
    }
    if (inApiCall) {
        console.debug('[expressions-plus] Classifier busy, skipping');
        return;
    }

    const card = getCardData();
    if (!card || card.characters.length === 0) {
        if (verbose) toastr.warning('No characters registered for this card yet.', 'Expressions Plus');
        return;
    }

    if (card.characters.some(ch => folderCache[ch.folder] === undefined)) {
        await scanAll();
    }

    const options = getOptions();
    if (options.length === 0) {
        if (verbose) toastr.warning('No expressions with images available.', 'Expressions Plus');
        return;
    }

    const userPrompt = buildUserPrompt(s.historyDepth, endIndex);
    if (!userPrompt) return;

    if (!force && userPrompt === lastClassifiedText) return;

    const labels = options
        .map(o => `${o.char}/${o.key}${o.tag ? ` — ${o.tag}` : ''}`)
        .join('\n');
    const systemPrompt = String(s.prompt || DEFAULT_PROMPT).replaceAll('{{labels}}', labels);

    try {
        inApiCall = true;
        const raw = await classifyViaCustomEndpoint({
            url: s.apiUrl,
            key: s.apiKey,
            model: s.apiModel,
            useProxy: !!s.apiProxy,
        }, systemPrompt, userPrompt);

        if (endIndex === null) {
            lastClassifiedText = userPrompt;
        }

        const option = parseResponse(raw, options);
        if (option) {
            console.debug(`[expressions-plus] Picked ${option.char}/${option.key} from reply:`, raw.trim().slice(0, 120));
            showSprite(option);
        } else {
            console.warn('[expressions-plus] Could not match classifier reply to any option:', raw);
            if (verbose) toastr.warning('The classifier\'s reply didn\'t match any option. See console.', 'Expressions Plus');
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
// Tag popup with session history
// ─────────────────────────────────────────────────────────────────────────────

/** Records a tag in the session history (newest first, deduped, max 5). */
function recordTag(tag) {
    if (!tag) return;
    sessionTagHistory = [tag, ...sessionTagHistory.filter(t => t !== tag)].slice(0, 5);
}

/**
 * Shows the tag input popup with clickable chips for recent tags.
 * @param {string} title
 * @param {string} description - HTML
 * @param {string} current
 * @returns {Promise<string|null>} trimmed tag ('' clears), or null when cancelled
 */
async function showTagPopup(title, description, current) {
    const history = sessionTagHistory.length
        ? `<div class="xp_tag_history_wrap"><small>Recent tags (click to use):</small><div class="xp_tag_history">${
            sessionTagHistory.map(t => `<div class="xp_tag_chip interactable" data-tag="${escapeHtml(t)}" tabindex="0">${escapeHtml(t)}</div>`).join('')
        }</div></div>`
        : '';
    const input = await Popup.show.input(title, `${description}${history}`, current || '');
    if (input === null || input === undefined) return null;
    return String(input).trim().replace(/\s+/g, ' ').slice(0, 200);
}

/** Delegated handler: clicking a history chip fills the popup's input. */
function bindTagChipDelegate() {
    $(document).on('click keydown', '.xp_tag_chip', function (e) {
        if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        const dlg = this.closest('dialog') || this.closest('.popup');
        if (!dlg) return;
        const input = dlg.querySelector('.popup-input')
            || dlg.querySelector('textarea')
            || dlg.querySelector('input[type="text"], input:not([type])');
        if (input) {
            input.value = $(this).data('tag');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus();
        }
    });
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
        $tree.append('<div class="xp_hint">No characters yet. Add one, then drop images — or whole expression folders — onto its block. Or use Import to bring a setup from another card.</div>');
        return;
    }

    for (const ch of card.characters) {
        $tree.append(buildCharacterBlock(cardKey, card, ch));
    }
}

/**
 * @param {string} cardKey
 * @param {{characters: StoryCharacter[]}} card
 * @param {StoryCharacter} ch
 */
function buildCharacterBlock(cardKey, card, ch) {
    const expressions = getCharacterExpressions(ch);
    const $block = $(`
        <div class="xp_char">
            <div class="xp_char_header">
                <i class="fa-solid fa-user"></i>
                <b class="xp_char_name">${escapeHtml(ch.name)}</b>
                <div class="xp_char_actions">
                    <div class="menu_button xp_btn interactable" data-act="add" title="Add images (each filename becomes an expression; the character's name is stripped from filenames)"><i class="fa-solid fa-file-circle-plus"></i></div>
                    <div class="menu_button xp_btn interactable" data-act="addfolder" title="Register an expression folder — every image inside <char>/<name>/ counts as that expression"><i class="fa-solid fa-folder-plus"></i></div>
                    <div class="menu_button xp_btn interactable" data-act="addgroup" title="Create a group for an action sequence (e.g. 'jumping'). Members lose the prefix in their filenames; the AI still sees the full name."><i class="fa-solid fa-object-group"></i></div>
                    <div class="menu_button xp_btn interactable" data-act="autosort" title="Auto-sort: move every ungrouped expression matching a group's name/prefix into that group. Expressions already in groups are untouched."><i class="fa-solid fa-wand-magic-sparkles"></i></div>
                    <div class="menu_button xp_btn interactable" data-act="rename" title="Rename character"><i class="fa-solid fa-pencil"></i></div>
                    <div class="menu_button xp_btn interactable" data-act="remove" title="Remove character from this card (image files stay on disk)"><i class="fa-solid fa-xmark"></i></div>
                </div>
            </div>
            <div class="xp_char_folder">
                <small>Folder</small>
                <input type="text" class="text_pole xp_folder_input" value="${escapeHtml(ch.folder)}" title="Sprite folder, relative to /characters/. Edit and press Enter." />
            </div>
            <div class="xp_groups"></div>
            <div class="xp_expr_grid"></div>
            <div class="xp_drop_hint"><i class="fa-solid fa-images"></i> Drop images or expression folders here</div>
        </div>
    `);

    // Group sections
    const $groups = $block.find('.xp_groups');
    for (const g of ch.groups) {
        $groups.append(buildGroupSection(ch, g, expressions.filter(e => e.group === g)));
    }

    // Ungrouped grid (also a drop target for pulling expressions OUT of groups)
    const $grid = $block.find('.xp_expr_grid');
    const ungrouped = expressions.filter(e => !e.group);
    if (ungrouped.length === 0) {
        $grid.append(`<div class="xp_hint">${ch.groups.length ? 'No ungrouped expressions. Drag one here to pull it out of a group (its prefix is restored).' : 'No expressions. Add images or folders, or fill the folder on disk and Scan.'}</div>`);
    }
    for (const entry of ungrouped) {
        const expandKey = `${ch.folder}::${entry.label}`;
        $grid.append(buildExpressionChip(ch, entry, expandKey));
        if (expandedExpressions.has(expandKey) && entry.files.length > 1) {
            $grid.append(buildExpressionDetail(ch, entry));
        }
    }
    wireInternalDropTarget(ch, $grid.get(0), null);

    // Header actions
    $block.find('[data-act="add"]').on('click', () => pickAndUpload(ch));
    $block.find('[data-act="addfolder"]').on('click', () => onAddSubfolder(ch));
    $block.find('[data-act="addgroup"]').on('click', () => onAddGroup(ch));
    $block.find('[data-act="autosort"]').on('click', () => onAutoSort(ch));
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
        for (const sub of ch.subfolders) delete folderCache[subfolderPath(ch, sub)];
        for (const g of ch.groups) delete folderCache[subfolderPath(ch, g)];
        saveSettingsDebounced();
        await renderTree();
    });

    // Folder edit
    const applyFolder = async (input) => {
        const value = String($(input).val()).trim().replace(/^\/+|\/+$/g, '');
        if (!value || value === ch.folder) return;
        delete folderCache[ch.folder];
        for (const sub of ch.subfolders) delete folderCache[subfolderPath(ch, sub)];
        for (const g of ch.groups) delete folderCache[subfolderPath(ch, g)];
        ch.folder = value;
        saveSettingsDebounced();
        await scanCharacter(ch);
        await renderTree();
    };
    $block.find('.xp_folder_input')
        .on('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); this.blur(); } })
        .on('blur', function () { applyFolder(this); });

    // OS drag & drop upload (files/folders). Ignore internal chip drags.
    const el = $block.get(0);
    const setActive = (on) => el.classList.toggle('xp_drop_active', on);
    const isInternal = (e) => currentDrag || Array.from(e.dataTransfer?.types || []).includes('text/xp-expr');
    el.addEventListener('dragover', (e) => { if (isInternal(e)) return; e.preventDefault(); e.stopPropagation(); setActive(true); });
    el.addEventListener('dragenter', (e) => { if (isInternal(e)) return; e.preventDefault(); e.stopPropagation(); setActive(true); });
    el.addEventListener('dragleave', (e) => { if (isInternal(e)) return; e.preventDefault(); e.stopPropagation(); setActive(false); });
    el.addEventListener('drop', async (e) => {
        if (isInternal(e)) return;
        e.preventDefault(); e.stopPropagation(); setActive(false);
        await handleDrop(ch, e.dataTransfer);
    });

    return $block;
}

/**
 * A collapsible group section. Collapsed by default; the whole section is a
 * drop target for moving expressions in.
 * @param {StoryCharacter} ch
 * @param {string} g
 * @param {ExpressionEntry[]} members
 */
function buildGroupSection(ch, g, members) {
    const key = `${ch.folder}::group::${g}`;
    const expanded = expandedGroups.has(key);
    const $section = $(`
        <div class="xp_group ${expanded ? 'xp_group_open' : ''}">
            <div class="xp_group_header interactable" title="Click to ${expanded ? 'collapse' : 'expand'}. Drag expressions onto this group to add them (the '${escapeHtml(g)}_' prefix is stripped from their filenames and added back for the AI).">
                <i class="fa-solid ${expanded ? 'fa-caret-down' : 'fa-caret-right'} xp_group_caret"></i>
                <i class="fa-solid fa-layer-group"></i>
                <b class="xp_group_name">${escapeHtml(g)}</b>
                <span class="xp_group_count">${members.length}</span>
                <span class="xp_group_sent">sent as ${escapeHtml(g)}_*</span>
                <div class="xp_group_actions">
                    <i class="xp_group_rename fa-solid fa-pencil" title="Rename group — every member's prefix follows. Renaming onto an existing group merges into it."></i>
                    <i class="xp_group_del fa-solid fa-xmark" title="Dissolve group — members return to the main list with the '${escapeHtml(g)}_' prefix restored in their filenames. No images are deleted."></i>
                </div>
            </div>
            <div class="xp_group_body" ${expanded ? '' : 'style="display:none;"'}></div>
        </div>
    `);

    const $body = $section.find('.xp_group_body');
    if (expanded) {
        if (members.length === 0) {
            $body.append('<div class="xp_hint">Empty group. Drag expressions here, or use Auto-sort to pull in everything named like this action.</div>');
        }
        for (const entry of members) {
            const expandKey = `${ch.folder}::${entry.label}`;
            $body.append(buildExpressionChip(ch, entry, expandKey, { displayName: entry.innerLabel ?? entry.label }));
            if (expandedExpressions.has(expandKey) && entry.files.length > 1) {
                $body.append(buildExpressionDetail(ch, entry));
            }
        }
    }

    $section.find('.xp_group_header').on('click', async (e) => {
        if ($(e.target).is('.xp_group_rename, .xp_group_del')) return;
        if (expandedGroups.has(key)) expandedGroups.delete(key);
        else expandedGroups.add(key);
        await renderTree();
    });
    $section.find('.xp_group_rename').on('click', async (e) => {
        e.stopPropagation();
        await onRenameGroup(ch, g);
    });
    $section.find('.xp_group_del').on('click', async (e) => {
        e.stopPropagation();
        await onDissolveGroup(ch, g, members.length);
    });

    wireInternalDropTarget(ch, $section.get(0), g);
    return $section;
}

/**
 * Makes an element accept internal expression-chip drags.
 * @param {StoryCharacter} ch
 * @param {HTMLElement} el
 * @param {string|null} targetGroup - null = ungrouped/main
 */
function wireInternalDropTarget(ch, el, targetGroup) {
    if (!el) return;
    const accepts = () => currentDrag && currentDrag.chFolder === ch.folder;
    el.addEventListener('dragover', (e) => {
        if (!accepts()) return;
        e.preventDefault(); e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('xp_drop_target');
    });
    el.addEventListener('dragleave', (e) => {
        e.stopPropagation();
        el.classList.remove('xp_drop_target');
    });
    el.addEventListener('drop', async (e) => {
        if (!accepts()) return;
        e.preventDefault(); e.stopPropagation();
        el.classList.remove('xp_drop_target');
        const label = currentDrag.label;
        currentDrag = null;
        document.body.classList.remove('xp_expr_dragging');
        const entry = getCharacterExpressions(ch).find(x => x.label === label);
        if (!entry || entry.files.length === 0) return;
        if ((entry.group || null) === (targetGroup || null)) return;
        try {
            const newEff = await moveExpressionToGroup(ch, entry, targetGroup);
            if (targetGroup) {
                toastr.success(`Moved into group "${targetGroup}" — sent to the AI as "${newEff}".`, 'Expressions Plus');
            } else {
                toastr.success(`Moved out of group — filenames restored to "${newEff}".`, 'Expressions Plus');
            }
        } catch (err) {
            console.error('[expressions-plus] Move failed:', err);
            toastr.error(`Move failed: ${err.message}`, 'Expressions Plus');
        }
        await scanCharacter(ch);
        await renderTree();
    });
}

/**
 * The compact chip for one expression. Single-image expressions display on
 * click; multi-image expressions toggle the expanded per-image panel.
 * Draggable into/between/out of groups.
 * @param {StoryCharacter} ch
 * @param {ExpressionEntry} entry
 * @param {string} expandKey
 * @param {{displayName?: string}} [opts]
 */
function buildExpressionChip(ch, entry, expandKey, { displayName } = {}) {
    const shown = displayName ?? entry.label;
    const thumb = entry.files[0]?.imageSrc || '';
    const hasImages = entry.files.length > 0;
    const multi = entry.files.length > 1;
    const expanded = multi && expandedExpressions.has(expandKey);
    const mixedTags = hasImages && entry.files.some(f => ch.imageTags[imageTagKey(entry.label, f.title)]);
    const sentAs = entry.group ? ` Sent to the AI as "${escapeHtml(entry.label)}".` : '';
    const chipTitle = !hasImages
        ? 'Registered folder with no images yet — not sent to the AI'
        : (multi ? 'Click to expand images; click again to collapse.' : 'Click to display this expression.') + sentAs + ' Drag onto a group to move it.';
    const $chip = $(`
        <div class="xp_expr interactable ${hasImages ? '' : 'xp_expr_empty'} ${expanded ? 'xp_expr_open' : ''}" title="${chipTitle}" draggable="${hasImages ? 'true' : 'false'}">
            ${hasImages ? `<img class="xp_expr_thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy" />` : '<div class="xp_expr_thumb xp_expr_thumb_empty"><i class="fa-solid fa-image"></i></div>'}
            <div class="xp_expr_text">
                <span class="xp_expr_label">${escapeHtml(shown)}</span>
                ${entry.tag ? `<small class="xp_expr_tag_text" title="${escapeHtml(entry.tag)}">${escapeHtml(entry.tag)}</small>` : ''}
            </div>
            ${multi ? `<span class="xp_expr_count">×${entry.files.length}</span>` : ''}
            ${mixedTags ? '<i class="xp_expr_mixed fa-solid fa-tags" title="Some images have their own tags — they are offered to the AI as separate variants"></i>' : ''}
            ${entry.fromFolder ? '<i class="xp_expr_folder fa-solid fa-folder" title="Backed by an expression folder — click to unregister it (keeps the files on disk)"></i>' : ''}
            <i class="xp_expr_tag_btn fa-solid fa-tag ${entry.tag ? 'xp_tagged' : ''}" title="${entry.tag ? 'Edit tag: ' + escapeHtml(entry.tag) : 'Tag this expression with its setting/outfit/mood — sent to the classifier for accuracy'}"></i>
            <i class="xp_expr_edit fa-solid fa-pencil" title="Rename expression (renames the files${entry.group ? ' inside the group; the group prefix is added automatically' : ''})"></i>
            <i class="xp_expr_del fa-solid fa-xmark" title="Delete expression and its image files"></i>
        </div>
    `);

    $chip.on('click', async (e) => {
        if ($(e.target).is('.xp_expr_edit, .xp_expr_del, .xp_expr_tag_btn, .xp_expr_folder')) return;
        if (!hasImages) return;
        if (!multi) {
            showSprite({ char: ch.name, label: entry.label, files: entry.files });
            return;
        }
        if (expandedExpressions.has(expandKey)) expandedExpressions.delete(expandKey);
        else expandedExpressions.add(expandKey);
        await renderTree();
    });
    $chip.on('dragstart', (e) => {
        if (!hasImages) return;
        currentDrag = { chFolder: ch.folder, label: entry.label };
        const dt = e.originalEvent.dataTransfer;
        dt.setData('text/xp-expr', entry.label);
        dt.effectAllowed = 'move';
        document.body.classList.add('xp_expr_dragging');
    });
    $chip.on('dragend', () => {
        currentDrag = null;
        document.body.classList.remove('xp_expr_dragging');
    });
    $chip.find('.xp_expr_tag_btn').on('click', async (e) => {
        e.stopPropagation();
        await onTagExpression(ch, entry);
    });
    $chip.find('.xp_expr_folder').on('click', async (e) => {
        e.stopPropagation();
        await onUnregisterSubfolder(ch, entry);
    });
    $chip.find('.xp_expr_edit').on('click', async (e) => {
        e.stopPropagation();
        if (!hasImages) return;
        await onRenameExpression(ch, entry);
    });
    $chip.find('.xp_expr_del').on('click', async (e) => {
        e.stopPropagation();
        await onDeleteExpression(ch, entry);
    });
    return $chip;
}

/**
 * The expanded panel listing every image of a multi-image expression.
 * @param {StoryCharacter} ch
 * @param {ExpressionEntry} entry
 */
function buildExpressionDetail(ch, entry) {
    const $detail = $('<div class="xp_expr_detail"></div>');
    const innerAnchor = entry.innerLabel ?? entry.label;
    for (const file of entry.files) {
        const ownTag = ch.imageTags[imageTagKey(entry.label, file.title)] || '';
        const inherited = !ownTag && entry.tag ? entry.tag : '';
        const $item = $(`
            <div class="xp_img_item interactable" title="Click to display this exact image">
                <img class="xp_img_thumb" src="${escapeHtml(file.imageSrc)}" alt="" loading="lazy" />
                <div class="xp_img_meta">
                    <span class="xp_img_title">${escapeHtml(file.title)}</span>
                    ${ownTag ? `<small class="xp_img_tag" title="${escapeHtml(ownTag)}">${escapeHtml(ownTag)}</small>` : ''}
                    ${inherited ? `<small class="xp_img_tag xp_img_tag_inherited" title="Inherited from the expression tag">${escapeHtml(inherited)}</small>` : ''}
                </div>
                <i class="xp_img_tag_btn fa-solid fa-tag ${ownTag ? 'xp_tagged' : ''}" title="${ownTag ? 'Edit this image\'s own tag' : 'Give this image its own tag (overrides the expression tag; images with different tags become separate options for the AI)'}"></i>
                <i class="xp_img_edit fa-solid fa-pencil" title="Rename this image. Keep the '${escapeHtml(innerAnchor)}' / '${escapeHtml(innerAnchor)}-N' pattern to stay in this group; any other name moves it to its own expression${entry.group ? ' within this group' : ''}."></i>
                <i class="xp_img_del fa-solid fa-xmark" title="Delete this image file"></i>
            </div>
        `);
        $item.on('click', (e) => {
            if ($(e.target).is('.xp_img_tag_btn, .xp_img_edit, .xp_img_del')) return;
            showSprite({ char: ch.name, label: entry.label, files: [file] });
        });
        $item.find('.xp_img_tag_btn').on('click', async (e) => {
            e.stopPropagation();
            await onTagImage(ch, entry, file);
        });
        $item.find('.xp_img_edit').on('click', async (e) => {
            e.stopPropagation();
            await onRenameImage(ch, entry, file);
        });
        $item.find('.xp_img_del').on('click', async (e) => {
            e.stopPropagation();
            const ok = await Popup.show.confirm('Delete image', `Delete <tt>${escapeHtml(file.fileName)}</tt> from <b>${escapeHtml(entry.label)}</b>? This removes the file from disk.`);
            if (!ok) return;
            await deleteSpriteFile(file.srcFolder, file.srcLabel, withoutExtension(file.fileName));
            delete ch.imageTags[imageTagKey(entry.label, file.title)];
            saveSettingsDebounced();
            await scanCharacter(ch);
            await renderTree();
        });
        $detail.append($item);
    }
    return $detail;
}

// ─────────────────────────────────────────────────────────────────────────────
// UI action handlers
// ─────────────────────────────────────────────────────────────────────────────

async function onRenameImage(ch, entry, file) {
    const anchor = entry.innerLabel ?? entry.label;
    const input = await Popup.show.input(
        'Rename image',
        `New name for <tt>${escapeHtml(file.title)}</tt>.<br><small>Spaces become underscores. Keep <tt>${escapeHtml(anchor)}</tt> or <tt>${escapeHtml(anchor)}-N</tt> to stay grouped under this expression. Any other name moves the image to its own (or another) expression${entry.group ? ` within the "${escapeHtml(entry.group)}" group (the prefix is added automatically for the AI)` : ''} — if that name is taken, the next free -N variant number is used and the image joins that group.</small>`,
        file.title,
    );
    if (!input) return;
    let newSpriteName = sanitizeLabel(String(input).replace(/\s+/g, '_'));
    if (!newSpriteName) {
        toastr.warning('Invalid name.', 'Expressions Plus');
        return;
    }
    if (newSpriteName === file.title) return;

    const destFolder = entry.group ? subfolderPath(ch, entry.group) : ch.folder;
    const destTitles = new Set((folderCache[destFolder] || []).flatMap(e => e.files.map(f => withoutExtension(f.fileName))));
    if (destTitles.has(newSpriteName)) {
        newSpriteName = nextGroupName(groupLabelOf(newSpriteName), destTitles);
    }

    try {
        const { newEff, finalName } = await renameImage(ch, entry, file, newSpriteName);
        if (newEff !== entry.label) {
            toastr.success(`Moved to expression "${newEff}" as ${finalName}.`, 'Expressions Plus');
        } else {
            toastr.success(`Renamed to ${finalName}.`, 'Expressions Plus');
        }
    } catch (err) {
        console.error('[expressions-plus] Image rename failed:', err);
        toastr.error(`Rename failed: ${err.message}`, 'Expressions Plus');
    }
    await scanCharacter(ch);
    await renderTree();
}

/** Opens a multi-file picker and uploads into the character's folder. */
function pickAndUpload(ch) {
    const input = document.getElementById('xp_file_input');
    if (!(input instanceof HTMLInputElement)) return;
    input.onchange = async () => {
        if (input.files?.length) {
            const toast = toastr.info(`Uploading ${input.files.length} file(s)…`, 'Expressions Plus', { timeOut: 0, extendedTimeOut: 0 });
            const { uploaded, failed } = await bulkUpload(ch, ch.folder, Array.from(input.files));
            toastr.clear(toast);
            reportUpload(ch, uploaded, failed);
            await scanCharacter(ch);
            await renderTree();
        }
        input.value = '';
    };
    input.click();
}

function reportUpload(ch, uploaded, failed) {
    if (uploaded) toastr.success(`${uploaded} image(s) added to ${ch.name}.`, 'Expressions Plus');
    if (failed) toastr.error(`${failed} file(s) failed. See console.`, 'Expressions Plus');
}

/**
 * OS drop: loose files and/or whole expression folders.
 * @param {StoryCharacter} ch
 * @param {DataTransfer} dataTransfer
 */
async function handleDrop(ch, dataTransfer) {
    const { looseFiles, folders } = await readDataTransfer(dataTransfer);
    if (!looseFiles.length && !folders.length) return;

    const total = looseFiles.length + folders.reduce((n, f) => n + f.files.length, 0);
    const toast = toastr.info(`Uploading ${total} file(s)…`, 'Expressions Plus', { timeOut: 0, extendedTimeOut: 0 });

    let uploaded = 0, failed = 0;

    if (looseFiles.length) {
        const res = await bulkUpload(ch, ch.folder, looseFiles);
        uploaded += res.uploaded;
        failed += res.failed;
    }

    for (const folder of folders) {
        const subName = sanitizeFolderPart(folder.name);
        if (!subName || !sanitizeLabel(subName)) { failed += folder.files.length; continue; }
        const res = await uploadIntoSubfolder(ch, subName, folder.files);
        uploaded += res.uploaded;
        failed += res.failed;
        if (res.uploaded > 0 && !ch.subfolders.includes(subName) && !ch.groups.includes(sanitizeLabel(subName))) {
            ch.subfolders.push(subName);
            saveSettingsDebounced();
        }
    }

    toastr.clear(toast);
    reportUpload(ch, uploaded, failed);
    if (folders.length && uploaded) {
        toastr.info(`Registered ${folders.length} expression folder(s).`, 'Expressions Plus');
    }
    await scanCharacter(ch);
    await renderTree();
}

/** Registers an expression subfolder that already exists (or will exist) on disk. */
async function onAddSubfolder(ch) {
    const input = await Popup.show.input(
        'Add expression folder',
        `Name of a subfolder inside <tt>${escapeHtml(ch.folder)}/</tt>. Every image inside it counts as one expression named after the folder. Create the folder on disk and drop images in it whenever you like — Scan picks up changes.`,
    );
    if (!input || !input.trim()) return;
    const subName = sanitizeFolderPart(input.trim());
    const label = sanitizeLabel(subName);
    if (!subName || !label) {
        toastr.warning('Invalid folder name.', 'Expressions Plus');
        return;
    }
    if (ch.subfolders.includes(subName)) {
        toastr.warning('That folder is already registered.', 'Expressions Plus');
        return;
    }
    if (ch.groups.includes(label)) {
        toastr.warning('That name is already used by a group.', 'Expressions Plus');
        return;
    }
    ch.subfolders.push(subName);
    saveSettingsDebounced();
    await scanFolder(subfolderPath(ch, subName));
    await renderTree();
    const count = (folderCache[subfolderPath(ch, subName)] || []).reduce((n, e) => n + e.files.length, 0);
    toastr.success(count > 0
        ? `Registered "${subName}" with ${count} image(s).`
        : `Registered "${subName}". Put images in ${ch.folder}/${subName}/ and hit Scan.`, 'Expressions Plus');
}

/** Creates a new (empty) group. */
async function onAddGroup(ch) {
    const input = await Popup.show.input(
        'Create group',
        'Name of the action this group holds (e.g. <tt>jumping</tt>). Drag expressions in — the <tt>jumping_</tt> prefix is stripped from their filenames and automatically added back when sent to the AI. Auto-sort pulls in every ungrouped expression matching the name.',
    );
    if (!input || !input.trim()) return;
    const g = sanitizeLabel(String(input).replace(/\s+/g, '_'));
    if (!g) {
        toastr.warning('Invalid group name.', 'Expressions Plus');
        return;
    }
    if (ch.groups.includes(g)) {
        toastr.warning('That group already exists.', 'Expressions Plus');
        return;
    }
    if (ch.subfolders.some(sub => sanitizeLabel(sub) === g)) {
        toastr.warning('That name is already used by an expression folder.', 'Expressions Plus');
        return;
    }
    ch.groups.push(g);
    saveSettingsDebounced();
    await scanFolder(subfolderPath(ch, g));
    await renderTree();
    toastr.success(`Group "${g}" created. Drag expressions in, or hit Auto-sort.`, 'Expressions Plus');
}

/** Runs auto-sort across all of the character's groups. */
async function onAutoSort(ch) {
    if (ch.groups.length === 0) {
        toastr.warning('Create a group first — auto-sort moves expressions into existing groups.', 'Expressions Plus');
        return;
    }
    const toast = toastr.info('Sorting…', 'Expressions Plus', { timeOut: 0, extendedTimeOut: 0 });
    let moved = 0;
    try {
        moved = await autoSortIntoGroups(ch);
    } finally {
        toastr.clear(toast);
    }
    await scanCharacter(ch);
    await renderTree();
    toastr.success(moved > 0
        ? `${moved} expression(s) sorted into groups.`
        : 'Nothing matched — ungrouped expressions must start with a group\'s name.', 'Expressions Plus');
}

/** Renames a group (merges when the target name already exists). */
async function onRenameGroup(ch, g) {
    const input = await Popup.show.input(
        'Rename group',
        `New name for group <tt>${escapeHtml(g)}</tt>.<br><small>Spaces become underscores. Every member's effective label changes from <tt>${escapeHtml(g)}_*</tt> to the new prefix (tags follow). Renaming onto an existing group merges the members into it.</small>`,
        g,
    );
    if (!input) return;
    const h = sanitizeLabel(String(input).replace(/\s+/g, '_'));
    if (!h) {
        toastr.warning('Invalid group name.', 'Expressions Plus');
        return;
    }
    if (h === g) return;
    if (ch.subfolders.some(sub => sanitizeLabel(sub) === h)) {
        toastr.warning('That name is already used by an expression folder.', 'Expressions Plus');
        return;
    }
    try {
        const merged = await renameGroup(ch, g, h);
        toastr.success(merged ? `Merged group "${g}" into "${h}".` : `Group renamed to "${h}".`, 'Expressions Plus');
    } catch (err) {
        console.error('[expressions-plus] Group rename failed:', err);
        toastr.error(`Group rename failed: ${err.message}`, 'Expressions Plus');
    }
    await scanCharacter(ch);
    await renderTree();
}

/** Dissolves a group, restoring prefixes into the member filenames. */
async function onDissolveGroup(ch, g, memberCount) {
    const ok = await Popup.show.confirm(
        'Dissolve group',
        memberCount > 0
            ? `Dissolve group <tt>${escapeHtml(g)}</tt>? Its ${memberCount} expression(s) return to the main list, and the <tt>${escapeHtml(g)}_</tt> prefix is restored in their filenames. No images are deleted.`
            : `Remove the empty group <tt>${escapeHtml(g)}</tt>?`,
    );
    if (!ok) return;
    const toast = toastr.info('Dissolving…', 'Expressions Plus', { timeOut: 0, extendedTimeOut: 0 });
    let restored = 0;
    try {
        restored = await dissolveGroup(ch, g);
    } catch (err) {
        console.error('[expressions-plus] Dissolve failed:', err);
        toastr.error(`Dissolve failed: ${err.message}`, 'Expressions Plus');
    } finally {
        toastr.clear(toast);
    }
    await scanCharacter(ch);
    await renderTree();
    if (restored > 0) {
        toastr.success(`Group dissolved — ${restored} expression(s) restored with their "${g}_" prefix.`, 'Expressions Plus');
    } else {
        toastr.success(`Group "${g}" removed.`, 'Expressions Plus');
    }
}

/** Unregisters an expression subfolder without touching the files on disk. */
async function onUnregisterSubfolder(ch, entry) {
    if (!entry.subfolder) return;
    const ok = await Popup.show.confirm(
        'Unregister expression folder',
        `Stop using the folder <tt>${escapeHtml(entry.subfolder)}</tt> for <b>${escapeHtml(ch.name)}</b>?<br><small>The image files stay on disk. Suffix-named files for "${escapeHtml(entry.label)}" in the main folder (if any) are unaffected.</small>`,
    );
    if (!ok) return;
    ch.subfolders = ch.subfolders.filter(s => s !== entry.subfolder);
    delete folderCache[subfolderPath(ch, entry.subfolder)];
    saveSettingsDebounced();
    await renderTree();
}

/** Sets or clears the expression-level tag. */
async function onTagExpression(ch, entry) {
    const tag = await showTagPopup(
        'Tag expression',
        `Short description for <tt>${escapeHtml(entry.label)}</tt> — the setting, outfit, or mood it depicts (e.g. "school cafeteria, lunch scene"). Applies to all its images unless an image has its own tag. Leave empty to remove.`,
        entry.tag || '',
    );
    if (tag === null) return;
    if (tag) {
        ch.tags[entry.label] = tag;
        recordTag(tag);
    } else {
        delete ch.tags[entry.label];
    }
    saveSettingsDebounced();
    await renderTree();
}

/** Sets or clears one image's own tag (overrides the expression tag). */
async function onTagImage(ch, entry, file) {
    const key = imageTagKey(entry.label, file.title);
    const tag = await showTagPopup(
        'Tag image',
        `Own tag for <tt>${escapeHtml(file.title)}</tt> (overrides the expression tag${entry.tag ? `: "${escapeHtml(entry.tag)}"` : ''}). Images of <tt>${escapeHtml(entry.label)}</tt> with different tags are offered to the AI as separate variants, so the tag decides which image pool is used. Leave empty to remove.`,
        ch.imageTags[key] || '',
    );
    if (tag === null) return;
    if (tag) {
        ch.imageTags[key] = tag;
        recordTag(tag);
    } else {
        delete ch.imageTags[key];
    }
    saveSettingsDebounced();
    await renderTree();
}

async function onRenameExpression(ch, entry) {
    const inGroup = !!entry.group;
    const currentName = inGroup ? (entry.innerLabel ?? entry.label) : entry.label;
    const fromFolderNote = entry.fromFolder
        ? ' Its images will be consolidated into the main character folder with suffix names, and the old folder unregistered.'
        : '';
    const groupNote = inGroup
        ? ` This expression is inside the "${escapeHtml(entry.group)}" group — the prefix is added automatically for the AI.`
        : '';
    const input = await Popup.show.input(
        'Rename expression',
        `New name for <tt>${escapeHtml(currentName)}</tt>. All ${entry.files.length} image file(s) will be renamed on disk.${fromFolderNote}${groupNote}<br><small>Spaces become underscores. If the name already exists${inGroup ? ' in this group' : ''}, these images join that expression as additional variants (next free -N numbers).</small>`,
        currentName,
    );
    if (!input) return;
    const newName = sanitizeLabel(String(input).replace(/\s+/g, '_'));
    if (!newName) {
        toastr.warning('Invalid expression name.', 'Expressions Plus');
        return;
    }
    if (newName === currentName) return;
    const newEffPreview = inGroup ? effLabel(entry.group, newName) : newName;
    const mergeTarget = getCharacterExpressions(ch).some(x => x.label === newEffPreview && x.files.length > 0);
    try {
        const newEff = await renameExpression(ch, entry, newName);
        toastr.success(mergeTarget
            ? `Merged ${entry.files.length} image(s) into existing expression "${newEff}".`
            : `Renamed to ${newEff}.`, 'Expressions Plus');
    } catch (err) {
        console.error('[expressions-plus] Rename failed:', err);
        toastr.error(`Rename failed: ${err.message}`, 'Expressions Plus');
    }
    await scanCharacter(ch);
    await renderTree();
}

async function onDeleteExpression(ch, entry) {
    if (entry.files.length === 0 && entry.subfolder) {
        await onUnregisterSubfolder(ch, entry);
        return;
    }
    const folderNote = entry.subfolder ? ' The expression folder will also be unregistered.' : '';
    const ok = await Popup.show.confirm(
        'Delete expression',
        `Delete <tt>${escapeHtml(entry.label)}</tt> and its ${entry.files.length} image file(s)? This removes the files from disk.${folderNote}`,
    );
    if (!ok) return;
    for (const file of entry.files) {
        await deleteSpriteFile(file.srcFolder, file.srcLabel, withoutExtension(file.fileName));
    }
    if (entry.subfolder) {
        ch.subfolders = ch.subfolders.filter(s => s !== entry.subfolder);
        delete folderCache[subfolderPath(ch, entry.subfolder)];
    }
    delete ch.tags[entry.label];
    for (const key of Object.keys(ch.imageTags)) {
        if (key.startsWith(`${entry.label}::`)) delete ch.imageTags[key];
    }
    saveSettingsDebounced();
    await scanCharacter(ch);
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
    const ch = { name: trimmed, folder, subfolders: [], groups: [], tags: {}, imageTags: {} };
    card.characters.push(ch);
    saveSettingsDebounced();
    await scanCharacter(ch);
    await renderTree();
    toastr.info(`Added ${trimmed}. Drop images or expression folders onto their block, or fill ${folder}/ on disk and Scan.`, 'Expressions Plus');
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-message regen button (in the message "..." menu)
// ─────────────────────────────────────────────────────────────────────────────

function addMessageButton() {
    const buttonHtml = `
        <div title="Regenerate expression sprite for this message" class="mes_button xp_mes_regen fa-solid fa-face-smile interactable" tabindex="0"></div>`;

    const $container = $('#message_template .mes_buttons .extraMesButtons');
    if ($container.length) {
        $container.prepend(buttonHtml);
    } else {
        $('#message_template .mes_buttons').prepend(buttonHtml);
        console.warn('[expressions-plus] .extraMesButtons not found in message template; button added to .mes_buttons instead.');
    }

    $(document).on('click', '.xp_mes_regen', async function () {
        const mesId = Number($(this).closest('.mes').attr('mesid'));
        if (!Number.isFinite(mesId)) return;
        lastClassifiedText = null;
        await classify(true, { endIndex: mesId, verbose: true });
    });
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
    $('#xp_strip_name').prop('checked', s.stripCharName).on('input', function () {
        s.stripCharName = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

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

    $('#xp_prompt').val(s.prompt).on('input', function () {
        s.prompt = String($(this).val());
        saveSettingsDebounced();
    });
    $('#xp_prompt_restore').on('click', function () {
        $('#xp_prompt').val(DEFAULT_PROMPT);
        s.prompt = DEFAULT_PROMPT;
        saveSettingsDebounced();
    });

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
        toastr.success(`Scan complete. ${total} option(s) with images available.`, 'Expressions Plus');
    });
    $('#xp_export').on('click', exportCard);
    $('#xp_import').on('click', () => {
        const input = document.getElementById('xp_import_input');
        if (!(input instanceof HTMLInputElement)) return;
        input.onchange = async () => {
            if (input.files?.[0]) await importCard(input.files[0]);
            input.value = '';
        };
        input.click();
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
        lastClassifiedText = null;
        classifyDebounced();
    };

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
        expandedExpressions = new Set();
        expandedGroups = new Set();
        await scanAll();
        await renderTree();
    });
}

(async function init() {
    getSettings();
    addSpriteHolder();
    bindTagChipDelegate();
    addMessageButton();
    await addSettingsPanel();
    bindEvents();
    await scanAll();
    await renderTree();
})();
