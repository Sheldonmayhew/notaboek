# Folio

A calm, block-style editor for plain `.md` and `.txt` files, on Windows and in the browser. Open a folder and your text files become clean, Notion-style pages. Nothing is imported: every page stays an ordinary file on your computer. Signing in is optional, and keeps your pages in step between devices.

## Run it

```bash
npm install
npm run dev
```

## Build the Windows app

```bash
npm run dist
```

The installer lands in `dist/`. It asks where new pages should go, with **Browse** opening a File Explorer folder picker. Installing lists Folio under "Open with" for `.md`, `.markdown` and `.txt` files without changing your default apps. To open them in Folio on a double-click, use **Open with > Choose another app > Always**. Windows may show its own app picker the first time you open a `.txt` file with anything other than its default app. The build isn't code-signed, so Windows SmartScreen will warn you the first time you run it.

## What it does

- **Blocks:** headings, bulleted, numbered and to-do lists, quotes, callouts, code with syntax highlighting, dividers and tables
- **Slash menu:** press `/` for every block type, and type to filter
- **Block handles:** hover to drag a block, turn it into another type, duplicate it or delete it
- **Selection toolbar:** bold, italic, strikethrough, inline code and links
- **Markdown shortcuts as you type:** `#`, `-`, `1.`, `[]`, `>`, ` ``` ` and `---`
- **Page styles:** default, serif and mono fonts, small text, full width, and light, dark or system themes
- **Fits any window:** text and the page grow with the space available, and in a small window the sidebar steps aside until you ask for it
- **Frontmatter as properties:** YAML at the top of a file shows as read-only rows under the title
- **Source view:** `Ctrl+/` shows and edits the raw file
- **Autosave:** changes are written shortly after you stop typing, and when you close the window
- **Tables:** hover a table for **+** bars that add a row or column at the end, and grips on each row and column for inserting or deleting in between. The right-click menu has the same actions, and Tab in the last cell adds a row
- **Selecting several pages:** `Ctrl+Click` adds a page or folder to the selection and `Shift+Click` selects a range, as in File Explorer
- **Moving pages:** drag pages onto a folder, or use **Move to…** in the right-click menu. Moving next to a file of the same name keeps both, by adding a number. The open page stays open and keeps saving
- **Default folder:** new pages go here when you don't have a folder open. It starts as whatever you chose in the installer, or `Documents\Folio`

| Shortcut | Action |
| --- | --- |
| `Ctrl+N` | New page |
| `Ctrl+O` | Open a file |
| `Ctrl+Shift+O` | Open a folder |
| `Ctrl+S` | Save now |
| `Ctrl+\` | Show or hide the sidebar |
| `Ctrl+=`, `Ctrl+-`, `Ctrl+0` | Zoom in, zoom out, reset zoom |
| `F11` | Full screen |
| `Ctrl+/` | Switch between page and source view |
| `Ctrl+Click` | Follow a link, or add a sidebar row to the selection |
| `Shift+Click` | Select a range of sidebar rows |
| `Delete` | With the sidebar focused, move the selection to the Recycle Bin |
| `Up`, `Down`, `Shift+Up`, `Shift+Down` | With the sidebar focused, move between rows or extend the selection |
| `Ctrl+Space`, `Ctrl+A`, `Esc` | With the sidebar focused, select a row, select all, or clear the selection |

## Where new pages go

With a folder open, a new page goes in that folder. Otherwise, including from the welcome screen and from the sample pages, it goes in your default folder, which then opens in the sidebar.

To see or change the default folder, use the welcome screen, or click the folder name at the top of the sidebar. **Show in File Explorer** opens it in Windows. Changing it doesn't move pages you've already made. Uninstalling Folio leaves the folder and your pages where they are.

Silent installs skip the question. If an administrator installs Folio for all users, only the person installing is asked, and everyone else starts with their own `Documents\Folio`.

## The web version and sync

The web version runs the same editor. With no account, pages stay in that browser. Signing in, on the web or from the sidebar on the desktop, keeps them in step with your other devices.

- **The desktop syncs one folder:** your default folder when you sign in. Your files stay ordinary files, and signing out leaves them all where they are.
- **Signing out of the web clears that browser,** so a shared computer keeps nothing. Your pages are still in your account.
- **Nothing is overwritten.** If two devices change the same page, both versions are kept, the second as `Notes (conflict from Web 2026-10-31).md`. An edit beats a deletion.
- **A page deleted on another device goes to the Recycle Bin** on the desktop.
- **Sync stops rather than guessing.** If most of the synced folder vanishes, as with an unplugged drive, Folio pauses and asks.
- **Bytes are kept exactly,** including encodings and line endings.

Sync runs a few seconds after a change, when a window comes to the front, and every five minutes while it's in front.

Limits: only text pages sync, not images beside them; pages over 4 MB stay on their device; each account has 100 MB; empty folders don't sync; a forgotten password can't be reset yet. Pages are stored unencrypted in the service's database, so whoever runs the service can read them.

## How your files stay safe

Folio treats the file on disk as the source of truth.

- **Opening never writes.** A file is only saved after you change it.
- **Only edited blocks are rewritten.** Every other block keeps its exact original text, so `*` bullets, `__bold__`, hard-wrapped lines, tables and raw HTML all survive. A whole list, quote or table counts as one block: editing one bullet keeps the list's markers and spacing, but can normalise other formatting in it, such as `__bold__` to `**bold**`.
- **Escapes are added only when needed.** `snake_case` stays `snake_case`.
- **File details are kept.** Line endings (CRLF or LF), byte order marks and encodings all stay as they were, including older Notepad encodings such as UTF-16 and Windows-1252. A Windows-1252 file moves to UTF-8 only if you add a character it can't hold, such as an emoji.
- **Saves are atomic where Windows allows it.** Folio writes a temporary file and swaps it in, so a crash can't leave a half-written page. If another program holds the file, or it has hard links, Folio writes over it directly and keeps the temporary copy until that succeeds.
- **Outside changes are detected.** If another program edits the open file, a clean page reloads. If you have unsaved edits, Folio stops and asks which version to keep.
- **Unsaved text is never dropped quietly.** If a save fails, or a conflict is unresolved, Folio won't switch pages, and closing the window asks first.
- **Deleting goes to the Recycle Bin.**

## How `.txt` files work

A `.txt` file is read as text with light structure: `#` headings, `-` lists, `[ ]` to-dos, `>` quotes and `---` dividers all become blocks, and web addresses become links. Line breaks and indentation stay where you put them, and nothing is ever escaped.

Everything else stays exactly as written. `__init__.py`, `2*3*4` and `**stars**` are shown and saved literally, because plain text has no way to store formatting. That's why the toolbar has no bold or italic in a `.txt` file. Use a `.md` file when you want formatting.

## Known limits

- One page is open at a time; there are no tabs yet.
- There's no search across files yet.
- Images display but can't be inserted from inside the app yet.
- Files over 8 MB won't open as pages.
- Underline isn't offered, because Markdown has no way to store it.
- Empty paragraphs aren't kept on save, because Markdown has no empty block.
- A list can't mix to-do items with plain bullets. Such a list displays as a normal bulleted list with its `[ ]` shown as text.
- There's no find (Ctrl+F) yet.
- Blocks are moved and duplicated with the mouse; the block handle has no keyboard route yet.
- Remote images in a Markdown file load when you open it, which tells that server you opened it. Images on network paths are never loaded.
- Saving swaps in a new file, so a file's Hidden attribute, custom permissions and creation date aren't kept.

## Web development

```bash
npm run web:local
```

This builds the web version and runs it at `http://localhost:8787` on a temporary in-memory database. `npm run test:sync` drives the desktop app and Chrome against it together.

On Vercel, the site needs `DATABASE_URL` (from the Neon integration) and `BETTER_AUTH_SECRET`. `npm run web:build` writes Vercel's prebuilt output, and `npm run db:migrate` updates the database.

## Project layout

- `src/shared/sync`: the sync engine, shared by the desktop app and the browser
- `server`: the API and accounts
- `web`: the browser's storage and its version of the desktop API
- `src/main`: the Electron process, covering file access, encodings, atomic saves and the folder watcher
- `src/preload`: the small API the window is allowed to use
- `src/renderer/src/doc`: parsing and saving, including the block-level source preservation
- `src/renderer/src/editor`: the editor, slash menu, block handle, toolbar and custom blocks
- `src/renderer/src/components`: the sidebar, top bar and welcome screen
- `test`: round-trip tests (`npm test`) and an end-to-end test that drives the real app (`npm run test:e2e`)
