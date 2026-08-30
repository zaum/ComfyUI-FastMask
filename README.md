# ComfyUI-FastMask

Nagyon gyors, saját fejlesztésű maszk editor a ComfyUI-hoz – a gyári MaskEditor alternatívája, teljesen új, teljesítményközpontú architektúrával.

![status](https://img.shields.io/badge/status-beta-orange)

## Telepítés

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/zaum/ComfyUI-FastMask
```

ComfyUI újraindítás után keresd a **`FastMask Editor`** node-ot a `mask` kategóriában.

## Használat

A node egyben **képbetöltő is** (mint a gyári LoadImage):

1. A node `image` dropdownjában válaszd ki a képet a ComfyUI input mappából, vagy tölts fel képet közvetlenül a node-ra (a beépített **feltöltés** gombbal).
2. A node-on lévő **🖌 FastMask Editor** gombbal (vagy jobb klikk → *Open in FastMask Editor*) nyisd meg a full-screen editort.
3. Fess, majd **OK** – a maszk full felbontásban elmentődik a `ComfyUI/input/fastmask/` mappába, az editor újramegnyitásakor a korábbi maszk **visszatöltődik** és tovább szerkeszthető.
4. A node két outputot ad: `IMAGE` (a betöltött kép) és `MASK` (1.0 = maszkolt terület). A futtatás után a node-on megjelenik a kép előnézete.

## Funkciók

| Funkció | Parancs |
|---|---|
| Festés (kerek brush) | **Bal egérgomb** nyomva tartva |
| Törlés | **Jobb egérgomb** nyomva tartva |
| Brush méret | **Ctrl + bal gomb húzás** (függőlegesen), **Ctrl + görgő**, `[` / `]`, vagy a csúszka |
| Maszk blur | **Ctrl + bal gomb húzás** (vízszintesen) vagy a **Blur** csúszka – a maszk éle real time elmosódik a fekete-fehér nézetben; a csúszka a B/W előnézetben is látszik. Alapértelmezett: 0% (nincs blur) |
| Maszkolás/Törlés mód váltás | `X` vagy a gombok |
| Zoom | **Egérgörgő** (a kurzorhoz igazodva) |
| Pan | **Középső gomb húzás** vagy **Space** nyomva tartva |
| Zárt alakzat auto-kitöltés | alapból be – a zárt körvonal belső része magától kitöltődik; kapcsoló: `F` |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Y` vagy `Ctrl+Shift+Z` (mac: `⌘`) |
| Clear all | `Ctrl+Delete` vagy gomb |
| Show mask (fekete-fehér) | gomb **fölé állva (hover)** már előnézet; **kattintva rögzített** nézet, ilyenkor is szerkeszthető |
| Háló (hatch) színe | `C` vagy a gomb → színválasztó |
| Fit / teljes kép | `Ctrl+0` |
| OK / Cancel | `Enter` / `Esc` |

Minden gomb **hoverére kiírja a saját billentyűparancsát**. Mac-en a `Ctrl` helyett `⌘` jelenik meg.

## Miért gyorsabb, mint a gyári MaskEditor?

A gyári editor minden egérmozdulatnál nagyobb területet renderel újra, teljes képes snapshotokat tárol undo-hoz, és a maskadatokat JS tömbökben másolgatja. A FastMask ettől teljesen eltérő architektúrával készült:

- **Offscreen 2D canvas a maszk számára** – a festés natív, GPU-gyorsított canvas stroke-okkal történik; egy ecsetvonás nem hoz létre JS objektumokat.
- **Dirty-rectangle renderelés** – minden frame csak az érintett téglalapokat rajzolja újra, soha nem a teljes képet.
- **Egyetlen `requestAnimationFrame` loop**, ami csak akkor rajzol, ha történt változás (nincs folyamatos redraw).
- **Preview resolution + full-res export** – nagy képnél a szerkesztés egy 2048 px-es preview-n történik, a végleges maszk a **teljes eredeti felbontásban** készül el (az OK gombnál egyetlen `drawImage` + `getImageData` skálázással, `Uint8Array`/`ImageData` formában).
- **Zoom/pan = tiszta CSS transform** – nulla költségű navigáció, akár 32× nagyításnál is.
- **Tile-alapú undo/redo** – nem teljes képeket másol, hanem csak a vonás által ténylegesen érintett 256×256-os csempéket (lazy snapshot, max. 40 lépés).
- **Zárt alakzat kitöltése** – a vonás végpontja alapján detektált zárt körvonalat egyetlen `evenodd` scanline fill-lel tölti ki temp canvasen keresztül.
- **Real-time maszk blur** – a **Blur** csúszka (0–100%) a maszk széleit Gaussian-blurral lágyítja, ami a szerkesztés közben, a fekete-fehér nézetben élőben követi a változtatást, és a full-res exportnál is megmarad. Az egéren egy szaggatott belső kör mutatja a blur mértékét (0%-nál csak a külső kör látszik). A **Ctrl + bal gomb húzás** függőlegesen a brush méretet, vízszintesen a blurt változtatja.

## SAM szegmentáció – tervezett kiterjesztés (nem implementált)

Terv szerint a későbbiekben gyors, egyszerű SAM szegmentáció is bekerül:

- **Modell:** MobileSAM vagy FastSAM (ONNX formában) a böngészőben futtatva **onnxruntime-web + WebGPU backend**-mel (WebGPU híján WASM fallback). Így nem kell szerveroldali GPU-t foglalni, és nincs extra ComfyUI függőség.
- **Működés:** az objektum fölé vivendő kurzor pozíciójáról (box + point prompt) a modell ~50–100 ms alatt embedding-alapú maszkot ad; az élő előnézet a hálóval azonos overlay csatornán jelenne meg.
- **Aktiválás:** `Shift` nyomva tartva (alkalmi használat), **Caps Lock** (folyamatos mód), vagy UI kapcsoló. Kattintással / `Enter`-rel fogadnád el a felkínált maszkot, ami azonnal a maszk rétegbe komponálódna.
- **Gyorsaság:** az image embeddinget csak egyszer számolnád kép-/zoomváltásonként (cache-elve), a point promptok csak a lightweight mask decodert futtatják – ezért tud interaktív lenni.

Ez a funkció jelenleg **nem része** a csomagnak, a fenti a tervezett architektúra.

## Kompatibilitás

- ComfyUI frontend (latest), Windows / Linux / macOS
- A mentés a ComfyUI szabványos `/upload/image` API-ját használja, nincs szükség extra szerveroldali komponensre.

## License

MIT
