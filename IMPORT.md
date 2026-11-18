# Format for importing notes

Make **one zip file** called `notes-import.zip` holding one Markdown file per note.

## Zip layout

```
notes-import.zip
├── grocery-list.md
├── summer-verse.md
└── 2024-03-hook-ideas.md
```

- Files go at the top of the zip (no folders), one `.md` file per note.
- **Filename**: lowercase letters, digits and hyphens only, e.g. `summer-verse.md`. Every name must be
  different. The filename is the note's ID, not its title.
- Encoding: UTF-8, with plain `\n` line endings.

## Each file

```markdown
---
title: "Summer verse"
tags: ["lyrics", "summer"]
created: 2024-05-02T21:10:00.000Z
updated: 2024-06-14T18:30:00.000Z
pinned: false
---

I keep it moving through the night
- [ ] finish the second verse
```

The header must be the first thing in the file, between two `---` lines, with these fields (`created` is optional):

| Field     | Format                                                                 |
|-----------|------------------------------------------------------------------------|
| `title`   | In double quotes. Escape any `"` inside it as `\"`.                    |
| `tags`    | A list in square brackets, each tag in double quotes: `["a", "b"]`. Use `[]` for no tags. Tags have no `#` and no spaces (use hyphens: `hook-ideas`). |
| `updated` | Date and time the note was last changed, in this form: `2024-06-14T18:30:00.000Z` (UTC). If unknown, use the date it was written at `T12:00:00.000Z`. |
| `created` | Optional: when the note was first written, same form as `updated`. If left out, `updated` is used. |
| `pinned`  | `true` or `false`.                                                     |

After the header, leave **one blank line**, then the note text exactly as it should appear.

## Note text

Plain text is fine. The app's formatting is Markdown, so these show formatted in the app:

- `**bold**`, `*italic*`, `~~strikethrough~~`
- `# Heading`, `## Smaller heading`
- `- item` for bullet lists, `- [ ] task` / `- [x] done` for checklists
- `> quote`

Don't use other Markdown (tables, images, HTML); it will show as plain text.

## Checklist before zipping

- [ ] One `.md` file per note, all at the top level of the zip
- [ ] Filenames are unique and use only `a-z`, `0-9` and `-`
- [ ] Every file starts with the `---` header and has `title`, `tags`, `updated` and `pinned`
- [ ] Titles and tags are in double quotes
- [ ] A blank line separates the header from the text
