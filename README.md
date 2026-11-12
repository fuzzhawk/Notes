# Notes

A minimal, black-themed notes app for Android, synced to this repository.

## Install on your phone

1. On the phone, open **https://github.com/fuzzhawk/Notes/releases/latest** and tap **Notes.apk**.
2. Open the downloaded file. Android asks once to allow installs from your browser or
   My Files — allow it, then tap **Install**.
3. To update later, download the newest Notes.apk the same way and install it over the old one.
   Your notes and audio stay on the phone.

Every push to this repository (except synced notes) rebuilds the APK with GitHub Actions
(`.github/workflows/android.yml`) and replaces that release.

## Features

Everything lives in the **☰ menu**:

- **Search** — searches titles, text and tags. Type `#tag` to search by tag.
- **Catalog** — a compact index of every note, grouped A–Z, by month, or by tag.
- **Tags** — every tag with its note count. Tap one to filter the list, tap ✎ to rename or remove it.
  Add tags in a note on the line under the title (space or comma adds the tag, tapping a tag removes it).
- **Rhyming dictionary** — works offline (about 43,000 common English words), with perfect rhymes grouped
  by syllable count and near rhymes. Opened from a note it looks up the word at the cursor, and tapping a
  rhyme inserts it. Words the offline list doesn't know are looked up online at Datamuse.
- **Text format** — font, size, line spacing, and the formatting toolbar on/off. The toolbar adds Markdown
  (bold, italic, strikethrough, headings, lists, checklists, quotes). The eye button in a note shows it
  formatted, and checklist boxes can be ticked there.
- **Audio player** — turn it on in the menu to get a one-line player at the top: play/pause,
  track picker (add audio files from the phone here), seek bar, and loop. Audio files are stored only on
  the phone; they aren't uploaded to GitHub.
- **Sync settings** — connect this repository (see below).
- With a note open, the menu also has **Pin** and **Delete**.

## GitHub sync

Notes are saved as Markdown files in `notes/`, one file per note, with the title, tags, pin and date at the
top. To turn sync on:

1. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)
   with access to **only this repository** and the permission **Contents: Read and write**.
2. In the app: ☰ → **Sync settings**, paste the token and tap **Save & sync**.

The app syncs when you open it, when you leave a note, and when it goes to the background; the ⟳ button
syncs right away. Notes still work offline and sync once you're back online. If a note was changed both
on the phone and elsewhere, both versions are kept (the phone's one becomes a "conflict copy").

## Project layout

- `web/` — the app (HTML/CSS/JS). It also runs in a browser: serve the folder and open `index.html`.
- `web/rhymes.txt` — the rhyme data, built by `npm install && npm run build:rhymes` from the
  [CMU Pronouncing Dictionary](http://www.speech.cs.cmu.edu/cgi-bin/cmudict) and SUBTLEX-US word frequencies.
- `android/` — a small Android app that shows `web/` in a full-screen WebView.
  Build locally with `cd android && ./gradlew assembleRelease` (needs the Android SDK).

## Signing key (so updates install over the old app)

Android only installs an update if it is signed with the same key as the installed app. The key is
not stored in the repository; the build reads it from two repository secrets
(Settings → Secrets and variables → Actions):

- `ANDROID_KEYSTORE` — the keystore file, base64-encoded
- `KEYSTORE_PASSWORD` — its password (the key alias is `notes`)

Make one on a computer with Java:

```sh
keytool -genkeypair -keystore notes.keystore -alias notes -keyalg RSA -keysize 2048 -validity 36500 -dname "CN=Notes"
base64 -w0 notes.keystore   # paste the output into ANDROID_KEYSTORE
```

Without these secrets each build is signed with a new temporary key, so you have to uninstall the old
app before installing a new build. Uninstalling deletes what's stored on the phone, so sync your notes
first; audio files would need to be added again.
