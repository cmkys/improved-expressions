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
4. Add images:
   - Drag & drop image files onto the character's block (or use the **+file** button). Each filename becomes an expression label: `casual.png` → `casual`.
   - Multiple images per expression via suffixes: `casual.png`, `casual-1.png`, `casual.beach.png` are all the `casual` expression — one is picked at random (with optional re-roll so the same image doesn't repeat).
   - Or manage the folder directly on disk (add/rename/delete files, whole subfolders per character), then press **Scan folders**.
5. Chat. On each enabled trigger, the last N messages (configurable) are sent to your classifier with the option list, and the chosen character's sprite is displayed. Click any expression chip to force-display it.

## Notes

- **Renaming an expression** re-uploads its images under the new name and deletes the old files (SillyTavern has no rename API), so it physically renames the files on disk.
- **Removing a character** only unregisters it — image files stay on disk. Re-add with the same folder and Scan to restore.
- **Deleting an expression** does delete its image files.
- The sprite window is draggable and resizable, same as the original extension.
- New character folders can't be auto-discovered (the sprites API can't list subfolders), which is why characters are registered once in the UI; after that, Scan picks up any disk changes inside their folders.
