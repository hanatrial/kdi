# Kendari Fulfillment Dashboard

A web app for tracking distributor purchase orders and delivery fulfillment, with data synced online via Firebase.

## Features

- **Stores** — manage your distributor/store list, with bulk paste import
- **New PO** — log a purchase order per store, upload the PO file (PDF/photo), auto-extract items from PDF text or paste a plain-text item list
- **Dashboard** — fulfillment % per PO (ordered vs. received), filterable by store/status
- **Distributor Sales** — cross-check what arrived at the store against a distributor's sales export (Excel/CSV), matched by barcode or fuzzy product-name matching with a remembered-alias system
- **Stock Check** — flag items that are out of stock (OOS) at the distributor, same matching approach

## Running it

No build step required. Hosted via GitHub Pages at https://hanatrial.github.io/kdi/, or open [index.html](index.html) directly in a browser. Data is stored in Firebase Firestore (project `dsbrdkdi`) and synced across devices. On first load, the app asks for a shared access passcode (app-level gate; Firestore rules are open since there's no user auth).

## Tech

Plain HTML/CSS/JS. Uses [pdf.js](https://mozilla.github.io/pdf.js/) (PDF text extraction), [Tesseract.js](https://tesseract.projectnaptha.com/) (OCR for photo POs), [SheetJS](https://sheetjs.com/) (Excel/CSV import) loaded from CDN on demand, and the [Firebase](https://firebase.google.com/) Firestore compat SDK for data storage.
