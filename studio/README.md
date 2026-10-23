# Presentation Studio

Private presentation library, HTML editing, and browser previews for PowerPoint and PDF.

The studio runs at `/studio/` beside the existing public presentation. Sign in with an invited email and password. The owner can upload presentations and manage Team access. Editors can open the library, present files, and save HTML changes online. All members share this one workspace.

## Supported files

| Format | Upload and present | Editing |
|---|---|---|
| HTML | Self-contained `deck-stage` presentations, including the supplied animated presentation | Text, replacement images, animation presets and timing; saves online |
| PowerPoint `.pptx` | Browser slide previews plus original-file download | Edit the original in PowerPoint, then upload the revised file |
| PDF | Browser page previews plus original-file download | Edit the source document, then upload a new PDF |

Files are limited to 40 MB and 500 slides/pages. PowerPoint previews may differ from PowerPoint itself; native animations, transitions, embedded video, and all font/layout details are not guaranteed. Original downloads remain unchanged. PDF pages are fixed. HTML must include its required images/scripts/styles; ordinary webpages and unrelated slide frameworks are not supported by the HTML editor.

## Daily use

1. The owner selects **Add presentation**, chooses HTML, PowerPoint, or PDF, and gives it a title.
2. In **Team access**, the owner adds the client's email as an **Editor** and privately shares the generated invitation link. No email is sent automatically.
3. The client opens that link once, chooses a password, and signs in at the studio URL thereafter.
4. For HTML, select **Edit**, select text or an image on a slide, and use the editor panel. Changes save after a short pause; **Save to cloud** saves immediately. Wait for **All changes saved** before closing.
5. Select **Present** for the presentation view. Original files and HTML/changes backups can be downloaded from their relevant controls.

If two people save the same presentation at once, the older tab stops saving. Download a changes backup, then choose **Load cloud version**. It deliberately does not overwrite the newer saved version. An offline or failed save leaves the current edits in the open tab; save again after reconnecting.

If an invitation expires or a client forgets their password, the owner can generate a fresh invitation link for that member. Invitation links grant account access and must be shared only with the intended person.

The existing public presentation URL remains a separate published copy. Changes in the private studio are visible to signed-in studio members; they do not automatically rewrite that public copy.

## Build and deployment

```sh
cd studio
npm ci
npm test
npm run build
```

GitHub Pages serves `index.html`, `config.json`, and `assets/` directly. The build bundles the browser SDK, PDF/PPTX renderers, and the existing HTML editor. `config.json` holds only the public Supabase URL and publishable key. Never place a secret or service-role key there. Backend migrations, access rules, and invitation setup are documented in `../supabase/README.md`.

Uploaded HTML runs in an opaque sandbox iframe without access to the parent session. The parent validates editor messages and performs authenticated uploads/saves. Original files and replacement images use private Supabase Storage buckets. Database policies enforce verified membership; hiding UI buttons is not the authorization boundary.
