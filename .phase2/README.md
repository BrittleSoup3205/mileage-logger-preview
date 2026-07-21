# Phase 2A Development Payload

`inspections.js.gz.b64` is the compressed, source-controlled Phase 2A inspection database build used by `inspections-loader.js` on the isolated preview page.

The preview is intentionally isolated from `index.html` so the working mileage application remains unchanged during testing. After browser testing is complete, the decoded inspection source will be integrated directly into the main application and this temporary development payload will be removed.
