# OmniView

Vizualizator universal de imagini și video pentru Windows. Deschide formatele „ciudate" pe care Windows nu le suportă implicit — **fără** să ai nevoie de codecuri instalate în sistem (merge inclusiv pe edițiile Windows **N**, care nu au Media Feature Pack).

## Formate suportate

| Categorie | Formate | Cum |
|---|---|---|
| Imagini Apple/moderne | HEIC, HEIF | decodare software cu libheif (WASM) |
| Imagini next-gen | AVIF, WebP | decodare nativă Chromium |
| Imagini clasice | JPG, PNG, GIF, BMP, SVG, ICO, APNG | decodare nativă Chromium |
| Imagini pro | TIFF (.tif/.tiff) | decodare software (utif2) |
| Video modern | HEVC/H.265 (.hevc, .h265, .mov, .mp4, .mkv) | redare directă sau conversie automată cu ffmpeg inclus |
| Video clasic | MP4, MOV, MKV, WebM, AVI, WMV, TS/MTS/M2TS, MPG, 3GP | redare directă sau conversie automată |

## Funcții

- 📂 Deschide prin dialog, **drag & drop** sau dublu-click din Explorer (asociere de fișiere la instalare)
- 🔍 Zoom (rotița mouse-ului, centrat pe cursor), pan (tragere), fit / 1:1, rotire 90°
- ◀▶ Navigare prin toate fișierele media din același folder (săgeți stânga/dreapta)
- 💾 Conversie / salvare ca **PNG** sau **JPEG** (pentru orice imagine, inclusiv HEIC)
- 🎬 Video HEVC convertit automat în fundal cu bară de progres când sistemul nu-l poate reda
- ⌨️ Scurtături: `Ctrl+O` deschide · `Ctrl+S` salvează PNG · `←/→` navighează · `+/-` zoom · `0` fit · `1` 100% · `R` rotire · `F` fullscreen

## Instalare (utilizatori)

Descarcă ultimul installer din [Releases](../../releases) — `OmniView-Setup-x.x.x.exe` (installer) sau varianta `portable`.

## Dezvoltare

```bash
npm install
npm start          # pornește aplicația
npm run dist       # construiește installer + portable în release/
```

Cerințe: Node.js 20+.

## Release automat pe GitHub

Workflow-ul din `.github/workflows/release.yml` construiește automat installerul la fiecare tag de versiune:

```bash
git tag v1.0.0
git push origin v1.0.0
```

După câteva minute apare un Release nou cu executabilele atașate. Se poate rula și manual din tab-ul **Actions** (workflow_dispatch).

## Arhitectură pe scurt

- **Electron** — fereastra și UI (dark mode)
- **Main process** ([src/main.js](src/main.js)) — decodare HEIC/HEIF (`heic-decode`), TIFF (`utif2`), transcodare video (`ffmpeg-static`), dialoguri, asocieri de fișiere
- **Renderer** ([src/renderer](src/renderer)) — canvas pentru imaginile decodate software, `<img>`/`<video>` pentru formatele native, zoom/pan/rotire
- Videoclipurile pe care Chromium nu le poate reda sunt transcodate on-the-fly în H.264 într-un folder temporar (curățat la închidere), cu cache ca să nu se refacă conversia

## Licență

MIT
