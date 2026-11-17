# Notaboek

A calm, block-style editor for plain text files, on Windows and in the browser: Markdown (including R Markdown and Quarto), `.txt`, `.csv` and `.tsv` tables, and TaskPaper to-do lists. Open a folder and your text files become clean, Notion-style pages. Nothing is imported: every page stays an ordinary file on your computer.

## Run it

```bash
npm install
npm run dev
```

## Build the Windows app

```bash
npm run dist
```

The installer lands in `dist/`. It asks where new pages should go, with **Browse** opening a File Explorer folder picker. Installing lists Notaboek under "Open with" for every kind of file it opens (see [Which files open](#which-files-open)) without changing your default apps. To open them in Notaboek on a double-click, use **Open with > Choose another app > Always**, or choose Notaboek in **Settings > Apps > Default apps**. Windows may show its own app picker the first time you open a `.txt` file with anything other than its default app. The build isn't code-signed, so Windows SmartScreen will warn you the first time you run it.

## What it does

- **Tabs:** keep several pages open. Clicking a page opens it in the current tab; middle-click it, or use **Open in new tab** in the right-click menu, to keep what you're looking at. Each tab keeps its own undo history, scroll position and source view, and your tabs come back when you reopen the app
- **Find in page:** `Ctrl+F` highlights every match, including across bold text and links, and works in source view too
- **Search across files:** the box at the top of the sidebar, or `Ctrl+Shift+F`, looks through every page in the open folder. Clicking a result opens the page at that match
- **Images:** type `/image` to pick one, paste a screenshot, or drag one onto the page. An image from outside the folder is copied beside the page, and the page links to it with a relative path
- **Blocks:** headings, bulleted, numbered and to-do lists, quotes, callouts, code with syntax highlighting, dividers, tables and images
- **Slash menu:** press `/` for every block type, and type to filter
- **Block handles:** hover to drag a block, turn it into another type, duplicate it or delete it
- **Selection toolbar:** bold, italic, strikethrough, highlight, inline code and links
- **Highlighter:** select text and click the highlighter, or press `Ctrl+Shift+H`, to mark it in the last colour you used. The arrow beside it picks yellow, green, blue, pink or purple, or removes the highlight. Typing `==text==` highlights in yellow too
- **Markdown shortcuts as you type:** `#`, `-`, `1.`, `[]`, `>`, ` ``` ` and `---`
- **Page styles:** default, serif and mono fonts, small text, full width, and light, dark or system themes
- **Theme colours:** in the page's **…** menu, pick an accent colour (blue, purple, green, orange, pink or graphite) for links, checkboxes, toggles and selection, and a page colour (plain, paper, sepia, mist, sage or blush). Each has a light and a dark version, and the window's title bar follows the page
- **Print and export to PDF:** both are in the page's **…** menu, and `Ctrl+P` prints. Only the page goes on paper, on white whatever the theme, with highlights, code and callouts in colour and long code lines wrapped. A PDF is saved beside the page by default, on A4, or on Letter where that's the usual paper size
- **Fits any window:** text and the page grow with the space available, and in a small window the sidebar steps aside until you ask for it
- **Frontmatter as properties:** YAML at the top of a file shows as read-only rows under the title
- **Source view:** `Ctrl+/` shows and edits the raw file
- **Autosave:** changes are written shortly after you stop typing, and when you close the window
- **Tables:** hover a table for **+** bars that add a row or column at the end, and grips on each row and column for inserting or deleting in between. The right-click menu has the same actions, and Tab in the last cell adds a row
- **Selecting several pages:** `Ctrl+Click` adds a page or folder to the selection and `Shift+Click` selects a range, as in File Explorer
- **Moving pages:** drag pages onto a folder, or use **Move to…** in the right-click menu. Moving next to a file of the same name keeps both, by adding a number. The open page stays open and keeps saving
- **Default folder:** new pages go here when you don't have a folder open. It starts as whatever you chose in the installer, or `Documents\Notaboek`

| Shortcut | Action |
| --- | --- |
| `Ctrl+N` | New page |
| `Ctrl+O` | Open a file |
| `Ctrl+Shift+O` | Open a folder |
| `Ctrl+S` | Save now |
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close the tab |
| `Ctrl+Shift+T` | Reopen the last closed tab |
| `Ctrl+Tab`, `Ctrl+Shift+Tab` | Next or previous tab, also `Ctrl+PageDown` and `Ctrl+PageUp` |
| `Ctrl+1` to `Ctrl+8`, `Ctrl+9` | Go to that tab, or the last one |
| `Ctrl+F` | Find in page |
| `Enter`, `Shift+Enter` | In the find box, next or previous match, also `F3` and `Shift+F3` |
| `Ctrl+Shift+F` | Search across files |
| `Ctrl+\` | Show or hide the sidebar |
| `Ctrl+=`, `Ctrl+-`, `Ctrl+0` | Zoom in, zoom out, reset zoom |
| `F11` | Full screen |
| `Ctrl+/` | Switch between page and source view |
| `Ctrl+Shift+H` | Highlight the selection, or remove its highlight |
| `Ctrl+P` | Print the page |
| `Ctrl+Click` | Follow a link, or add a sidebar row to the selection |
| `Shift+Click` | Select a range of sidebar rows |
| `Delete` | With the sidebar focused, move the selection to the Recycle Bin |
| `Up`, `Down`, `Shift+Up`, `Shift+Down` | With the sidebar focused, move between rows or extend the selection |
| `Ctrl+Space`, `Ctrl+A`, `Esc` | With the sidebar focused, select a row, select all, or clear the selection |

In the web version the browser keeps `Ctrl+T`, `Ctrl+W` and the keys for moving between tabs for itself, so tabs there are opened and closed with the mouse.

## Where new pages go

With a folder open, a new page goes in that folder. Otherwise, including from the welcome screen and from the sample pages, it goes in your default folder, which then opens in the sidebar.

To see or change the default folder, use the welcome screen, or click the folder name at the top of the sidebar. **Show in File Explorer** opens it in Windows. Changing it doesn't move pages you've already made. Uninstalling Notaboek leaves the folder and your pages where they are.

Silent installs skip the question. If an administrator installs Notaboek for all users, only the person installing is asked, and everyone else starts with their own `Documents\Notaboek`.

## How your files stay safe

Notaboek treats the file on disk as the source of truth.

- **Opening never writes.** A file is only saved after you change it.
- **Only edited blocks are rewritten.** Every other block keeps its exact original text, so `*` bullets, `__bold__`, hard-wrapped lines, tables and raw HTML all survive. A whole list, quote or table counts as one block: editing one bullet keeps the list's markers and spacing, but can normalise other formatting in it, such as `__bold__` to `**bold**`.
- **Escapes are added only when needed.** `snake_case` stays `snake_case`.
- **File details are kept.** Line endings (CRLF or LF), byte order marks and encodings all stay as they were, including older Notepad encodings such as UTF-16 and Windows-1252. A Windows-1252 file moves to UTF-8 only if you add a character it can't hold, such as an emoji.
- **Saves are atomic where Windows allows it.** Notaboek writes a temporary file and swaps it in, so a crash can't leave a half-written page. If another program holds the file, or it has hard links, Notaboek writes over it directly and keeps the temporary copy until that succeeds.
- **Outside changes are detected.** If another program edits the open file, a clean page reloads. If you have unsaved edits, Notaboek stops and asks which version to keep.
- **Unsaved text is never dropped quietly.** If a save fails, or a conflict is unresolved, Notaboek won't switch pages, and closing the window asks first.
- **Deleting goes to the Recycle Bin.**

## How highlights are saved

A yellow highlight is written as `==text==`, the Markdown highlight that Obsidian, Typora and many other apps read. Other colours are written as `<mark style="background: #ccf0d1">text</mark>`, which keeps the colour in any app that shows HTML in Markdown. Notaboek also reads `<mark>text</mark>` as a yellow highlight. A `<mark>` it doesn't recognise, such as one with another colour, stays as raw HTML and is saved exactly as written.

Typed `==` that isn't meant as a highlight, such as `a == b`, is left alone, and is escaped as `\==` only where it would otherwise read as one.

## Which files open

| Kind | Extensions | Opens as |
| --- | --- | --- |
| Markdown | `.md`, `.markdown`, `.mdown`, `.mkd`, `.mkdn`, `.mdwn`, `.mdtext`, `.mdtxt` | A page with every block type |
| R Markdown and Quarto | `.rmd`, `.qmd` | A Markdown page. Code chunks such as ```` ```{r, echo=FALSE} ```` keep their options when you edit the code |
| Plain text | `.txt`, `.text` | Text with light structure (see below) |
| Tables | `.csv`, `.tsv` | One table |
| TaskPaper | `.taskpaper` | Projects, to-dos and notes |
| PDF | `.pdf` | The document as it is, to highlight and circle (desktop only) |
| Word | `.docx` | The document as it is, for small edits (desktop only) |

Any page can be opened, searched, synced and linked to from another page. PDFs and Word documents open and can be linked to, but aren't searched or synced.

## PDFs and Word documents

A PDF opens page by page, with a toolbar above it.

- **Highlight:** choose it, then drag across text. Dragging where there's no text, such as on a scanned page, highlights a box instead. With text already selected, clicking **Highlight** marks it straight away.
- **Circle:** choose it, then drag around what you want circled. Hold `Shift` for a round circle.
- Pick a colour from the swatches. Click a mark to select it, then press `Delete`, or pick a colour to change it. `Ctrl+Z` and `Ctrl+Y` undo and redo.
- Marks are saved into the PDF as ordinary highlight and circle annotations, so Acrobat, Edge and other readers show them too. Notaboek only changes the marks it made: notes and annotations from other programs are left as they are.
- A PDF that's signed or password-protected is shown but never changed.

A Word document opens as its pages look in Word: fonts, sizes, colours, spacing, lists, tables and pictures.

- Type to change text, in paragraphs and in table cells. `Enter` starts a new paragraph, continuing a list; on an empty list item it ends the list.
- Make text bold, italic, underlined or struck through from the toolbar or with `Ctrl+B`, `Ctrl+I`, `Ctrl+U` and `Ctrl+Shift+S`, and pick a paragraph style such as Heading 1 from the list.
- Pictures, fields such as a table of contents or page numbers, tracked changes, comments and content controls are shown and kept exactly as they are, but can't be edited. The toolbar says how many such parts a document has.
- Only the paragraphs you change are rewritten. Everything else, including headers, footers, footnotes and settings, goes back into the file untouched.

Both save as you go, like a page. Close the file in Word first: Word locks a document while it has it open.

## How `.csv` and `.tsv` files work

A `.csv` or `.tsv` file opens as one table, with its first row as the header. Edit cells, and use the **+** bars, the grips or the right-click menu to add and remove rows and columns. `Enter` in a cell starts a new line inside it, and `Tab` in the last cell adds a row.

- **Rows you don't touch keep their exact text,** including their quotes, spacing and line endings. An edited row is written in the file's own style: the same delimiter and line endings, and quotes around every value if the file used them throughout. Otherwise a value is quoted only when it holds the delimiter, a quote or a line break.
- **Semicolons are recognised.** Excel writes `;` between values where a comma is the decimal point, and Notaboek reads and writes those files that way, as well as Excel's `sep=;` first line.
- **Short rows are shown padded** with empty cells so the table is a grid. The padding is only written if you edit that row, and then no wider than the row was, or the header if that can't be told.
- **Empty rows added at the end aren't saved,** as with empty paragraphs. An empty file opens as a small empty table and stays empty until you type in it.
- Values are plain text, so there's no bold, links or formulas, and a formula is shown as the text it is.
- A file with more than 50,000 cells is too big to edit as a table, so it opens as plain text instead.

## How `.taskpaper` files work

A [TaskPaper](https://www.taskpaper.com/) file is read line by line. A line ending in a colon is a project, and shows as a heading. A line starting with `- ` is a task, and shows as a to-do. Anything else is a note. Tabs nest a line under the one above it, so a task's notes and subtasks sit inside it.

- **Ticking a task tags it `@done(date)`** with today's date, as TaskPaper does, and unticking removes the tag. Editing a finished task keeps its original date.
- **Other tags, such as `@today` or `@due(2026-12-01)`, stay in the text** and are shown in the accent colour.
- **Typing `- ` starts a task.** The slash menu and **Turn into** offer only what TaskPaper can store: a note, a project and a task.
- **New lines go under the project above them,** one tab deeper. A line you edit keeps the depth it had, and lines you don't touch keep their exact text.
- A note that starts with `- ` or ends with a colon reads back as a task or a project, because that's what those mean in TaskPaper.

## How `.txt` files work

A `.txt` file is read as text with light structure: `#` headings, `-` lists, `[ ]` to-dos, `>` quotes and `---` dividers all become blocks, and web addresses become links. Line breaks and indentation stay where you put them, and nothing is ever escaped.

Everything else stays exactly as written. `__init__.py`, `2*3*4` and `**stars**` are shown and saved literally, because plain text has no way to store formatting. That's why the toolbar has no bold, italic or highlighter in a `.txt` file. Use a `.md` file when you want formatting.

## Known limits

- Each open tab keeps a whole page in memory, so many very large pages open at once will use a lot of it.
- A page can only be open in one tab at a time.
- Find in page covers the text of the page, not its frontmatter or raw HTML.
- Search across files looks at the text as it's stored, so a phrase split by Markdown formatting, such as `some **bold** words`, is found by find in page but not by this search. It skips files over 8 MB and lists the first 200 pages.
- Images can only be added on the desktop, and not to `.txt`, `.csv`, `.tsv` or `.taskpaper` pages, or inside code blocks. They stay on that device, and moving a page doesn't bring its images along.
- Files over 8 MB won't open as pages.
- On pages over 256 KB, blocks out of view aren't drawn, so the scrollbar is an estimate. Spellcheck and the empty-line hints are off there.
- A long `.txt` paragraph is shown in pieces of 200 lines, so copying across two pieces adds a blank line. The file itself is unaffected.
- A file that's one enormous line, with no line breaks at all, stays slow, because a browser has to lay a line out whole.
- Underline isn't offered, because Markdown has no way to store it.
- Whether a `.csv` file uses commas or semicolons is worked out from its first 50 lines. A file with a single column, or one where every line could be read either way, can be guessed wrong. Rows you don't edit are saved exactly as they were either way.
- A table page has no sticky header row, so the header scrolls away in a long table.
- Theme colours are chosen from the presets; there's no custom colour picker yet.
- In the web version, **Export to PDF** opens the browser's print dialog, where you choose **Save as PDF**.
- Empty paragraphs aren't kept on save, because Markdown has no empty block.
- A list can't mix to-do items with plain bullets. Such a list displays as a normal bulleted list with its `[ ]` shown as text.
- Blocks are moved and duplicated with the mouse; the block handle has no keyboard route yet.
- In a Word document, rows and columns can't be added or removed, and a selection that would delete a whole table is ignored. Headers, footers and footnotes aren't shown. Old `.doc` files and documents saved in Word's "Strict" format don't open.
- Saving a PDF rewrites the whole file, so its revision history inside the file isn't kept. Find in page doesn't search PDFs yet.
- Remote images in a Markdown file load when you open it, which tells that server you opened it. Images on network paths are never loaded.
- Saving swaps in a new file, so a file's Hidden attribute, custom permissions and creation date aren't kept.

## Web development

```bash
npm run web:local
```

This builds the web version and runs it at `http://localhost:8787` on a temporary in-memory database. `npm run test:sync` drives the desktop app and Chrome against it together.

On Vercel, the site needs `DATABASE_URL` (from the Neon integration) and `BETTER_AUTH_SECRET`. `npm run web:build` writes Vercel's prebuilt output, and `npm run db:migrate` updates the database.

## Project layout

- `src/shared/sync`: the sync engine. The desktop app has no sign-in
- `server`: the API and accounts
- `web`: the browser's storage and its version of the desktop API
- `src/main`: the Electron process, covering file access, encodings, atomic saves and the folder watcher
- `src/preload`: the small API the window is allowed to use
- `src/renderer/src/doc`: parsing and saving, including the block-level source preservation
- `src/renderer/src/editor`: the editor, slash menu, block handle, toolbar and custom blocks
- `src/renderer/src/components`: the sidebar, top bar and welcome screen
- `test`: round-trip tests (`npm test`) and an end-to-end test that drives the real app (`npm run test:e2e`)
