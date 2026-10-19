# Catalogue dependencies

- `import-url.js`: copied from EE-Lens `pc-catalogue-manager/import-url.js` at `0cd44f22037e4e2d3facf8e4c47449f8d7e115fb`. Only its inert extraction functions are called. The new authenticated catalogue endpoint handles page/image downloads; the old proxy functions in this copy are unused.
- `images.js`: copied from EE-Lens `pc-catalogue-manager/images.js` at `d836c22`. One local adjustment fills the canvas white before JPEG conversion, so transparent product photos retain a white background.
- `xlsx-0.20.3.min.js`: SheetJS CE 0.20.3, downloaded from the official `https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js`. SHA-256 `cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41`. License in `SHEETJS-LICENSE`. Loaded only when opening an Excel file.
- Supabase uses the existing pinned `../vendor/supabase-2.112.2.js` in ShopManager.

These are local assets; the catalogue does not depend on a third-party script CDN at runtime.
