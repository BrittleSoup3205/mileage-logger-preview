(() => {
  "use strict";

  async function loadInspectionDatabase() {
    if (!("DecompressionStream" in window)) {
      throw new Error("This browser does not support the Phase 2A compressed development build.");
    }

    const response = await fetch("./.phase2/inspections.js.gz.b64", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Inspection database payload could not be loaded (${response.status}).`);
    }

    const encoded = (await response.text()).trim();
    const compressed = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const decompressedStream = new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    const source = await new Response(decompressedStream).text();

    // Development-branch loader. The decoded source is the checked Phase 2A inspections.js build.
    (0, eval)(source);
  }

  loadInspectionDatabase().catch((error) => {
    console.error("Phase 2A inspection database failed to load:", error);
    const target = document.getElementById("phase2LoadStatus");
    if (target) {
      target.textContent = `Inspection database failed to load: ${error.message}`;
      target.className = "gps-status bad";
    }
  });
})();
