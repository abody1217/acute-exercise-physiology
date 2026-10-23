# Acute Exercise Physiology

[View the presentation](https://abody1217.github.io/acute-exercise-physiology/) · [Open the editor](https://abody1217.github.io/acute-exercise-physiology/?edit=1)

## Edit the presentation

1. Click **Edit presentation**. Select an item on the slide or from **Slide items**.
2. Use **Text**, **Image**, or **Motion**, then click the matching **Apply** button. Bold and plain text segments can be edited separately to preserve formatting.
3. For images, choose PNG, JPEG, WebP, or GIF up to 10 MB. A similar aspect ratio fits the existing layout best.
4. For animations, choose an effect and set its duration and delay. **Original motion** keeps the original animation with adjustable timing. Some items share a containing animation group; the editor tells you when this applies. Use **Replay motion** to check the result.
5. Use **Undo** and **Redo** as needed. **Present** closes the editor and plays the current draft.

Edits save automatically in this browser. Reloading shows the published presentation; entering the editor restores your browser draft. **Reset all edits** restores this file’s published version. Use **Export changes** for a backup and **Import changes** to continue elsewhere.

## Update the shared link

1. Click **Download updated index.html**. If the browser adds a number to the filename, rename the downloaded file to `index.html`.
2. Click **Open GitHub upload** and sign in with an account that has edit access to this repository.
3. Upload the downloaded file to the repository root, replacing the existing `index.html`.
4. Commit the change to `main`. GitHub Pages rebuilds the presentation at the same link. Wait for deployment to complete, then refresh the presentation.

**No GitHub account?** You can still edit and download without signing in. Send the downloaded `index.html` to the presentation owner to upload. A GitHub account with repository access is required only for publishing.

The downloaded HTML includes the presentation, images, animations, and editor, and can be opened offline. Downloading alone does not update the shared link. Browser drafts are local to each browser and file version; they are not shared between people. Keep an exported backup before clearing browser data. GitHub’s web upload limit is 25 MB per file; the editor checks this before downloading.

## Maintain the editor

The delivered `index.html` is self-contained. `source/base.html` holds the original presentation, `editor/` holds the editor, and `tools/build.py` builds the bundle with stable slide-item IDs. Run `python3 tools/build.py` after changing editor sources. The build preserves saved edits already embedded in `index.html`; pull the latest repository version before rebuilding so client updates are retained. Do not reorder the original source elements without migrating their edit IDs.
