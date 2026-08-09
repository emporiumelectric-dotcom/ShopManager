(function (root, factory) {
  "use strict";

  var files = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = files;
  }

  if (root) {
    root.EEShellFiles = files;
  }
})(
  typeof self !== "undefined" ? self : globalThis,
  function () {
    "use strict";

    return Object.freeze([
      "./index.html",
      "./manifest.json",
      "./icon-192.png",
      "./icon-512.png",
      "./icon-512-maskable.png",
      "./config-validation.js",
      "./shell-files.js",
      "./vendor/supabase-2.112.2.js"
    ]);
  }
);
