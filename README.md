# Expressions Plus

Multi-character, per-card sprite automation for SillyTavern. A rethink of the built-in Character Expressions extension aimed at multi-character cards, easy management, and speed.

## What's different from the built-in extension

- **Card → Character → Expressions.** Everything is keyed to the character card. Add as many story characters per card as you want; nothing leaks into other cards' chats.
- **No default expressions.** Only what you add exists.
- **Event-driven, no polling.** Classification fires only on the triggers you enable: AI message, user message, swipe/edit. There is no 2-second update loop.
- **One LLM call picks character + expression** from a flat `Character/expression` list.
- **Empty expressions can't cause errors.** Expressions with no images are simply never sent to the classifier; with zero images total, no API call happens at all.
- **Separate classifier endpoint.** Classification always goes to an OpenAI-compatible URL + key you configure (e.g. a fast/cheap model), never your main chat API — it can't interfere with generation.
- **Real management UI.** Rename or delete characters and expressions with one click, edit folder paths inline, bulk add sprites by dropping files (filename = expression), and re-Scan after editing folders on disk.

## Install

Copy this folder into:

```
<SillyTavern>/data/<your-user>/extensions/expressions-plus/
```

(or `public/scripts/extensions/third-party/expressions-plus/` on older installs), then reload SillyTavern. The panel appears in Extensions settings as **Expressions Plus**.

## Setup

1. Open a chat with a character card.
2. In the panel, set your **Classifier endpoint**: full `/chat/completions` URL, API key, and model name. Hit **Test connection**. If you get CORS errors in the browser console, enable `enableCorsProxy: true` in `config.yaml` and tick **Use CORS proxy**.
3. Click **Add character** and name a character that appears in the story (this is the name the AI sees). A folder is registered at `/characters/<card>/<character>/` in your user data directory.
4. Add images — two mechanisms, freely combined per expression:
   - **Suffix files** in the character folder: drag & drop image files onto the character's block (or use the **+file** button). Each filename becomes an expression label: `casual.png` → `casual`; `casual-1.png` and `casual.beach.png` join it as variants.
   - **Expression folders**: a subfolder like `casual/` where *every* image inside counts as `casual`, regardless of filename. Drop a whole folder from your OS onto a character block to upload and register it in one step. For folders you create directly on disk, click the folder-plus button once to register the name, then **Scan folders** picks up any changes forever after. If both a `casual/` folder and `casual*`-suffix files exist, their images are merged into one pool — one image is picked at random (with optional re-roll so the same image doesn't repeat).
   - Chips backed by a folder show a small folder icon; click it to unregister the folder without deleting any files.
5. **Tag expressions and images** (optional, recommended for scene-specific sprites): click the tag icon on a chip to describe the setting/outfit/mood — e.g. `school cafeteria, lunch scene`. Clicking a chip **expands** it to show every image inside; each image has its own tag button that overrides the expression tag. Images are grouped by effective tag when building the classifier's list: if all images share one tag, the expression is a single option; if tags differ, it splits into variants (`Alice/casual`, `Alice/casual.2 — beach`) so the model's choice decides which image pool is used. The last 5 tags you enter each session appear as one-click chips in the tag popup. Click a chip again to collapse it; clicking an image inside displays that exact image, and each image also has its own delete button.
6. **Filename cleanup**: uploads automatically strip the character's name from filenames to prevent redundant labels — for a character named Bob Stinger, `bob_happy.png` becomes the expression `happy` and `stinger-angry.png` becomes `angry` (whole segments only, so `bobble.png` is untouched). Toggleable in settings.
7. Chat. On each enabled trigger, the last N messages (configurable) are sent to your classifier with the option list, and the chosen character's sprite is displayed. Click any expression chip to force-display it.

## Extra features

- **Single-image expressions** display immediately on click; only multi-image expressions expand into the per-image panel.
- **Image (variant) renaming**: in the expanded panel, the pencil on an image renames it. Keeping the `label` / `label-N` pattern keeps it in the group; any other name moves it out into its own (or another) expression. Renaming an image that lives in an expression folder moves the file into the main character folder (SillyTavern has no move endpoint, so renames are re-upload + delete).
- **Export / Import**: the Export button saves the current card's entire setup — every character, all image files (embedded), expression-folder structure, and all tags — into one `.json` file. Open a different card and hit Import to merge it in: new characters are created under that card, missing images are uploaded, subfolders are registered, tags are restored, and files that already exist are skipped (nothing is overwritten).
- **Per-message regen**: every message's "..." menu has a smiley button that re-runs classification anchored at that message (using your configured history depth ending there) and re-rolls the sprite. Works on older messages too, so you can set the scene sprite for any point in the chat.

## Notes

- **Renaming an expression** re-uploads its images under the new name and deletes the old files (SillyTavern has no rename API), so it physically renames the files on disk.
- **Removing a character** only unregisters it — image files stay on disk. Re-add with the same folder and Scan to restore.
- **Deleting an expression** does delete its image files.
- The sprite window is draggable and resizable, same as the original extension.
- New character folders can't be auto-discovered (the sprites API can't list subfolders), which is why characters are registered once in the UI; after that, Scan picks up any disk changes inside their folders.
