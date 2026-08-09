"use strict";

const fs = require("fs");
const path = require("path");
const shellFiles = require("../shell-files.js");

const root = path.resolve(process.argv[2] || ".");

for (const relativePath of shellFiles) {
  const normalized = relativePath.replace(/^\.\//, "");
  const absolutePath = path.join(root, normalized);

  if (!fs.existsSync(absolutePath)) {
    throw new Error("Missing service-worker shell file: " + relativePath);
  }

  if (!fs.statSync(absolutePath).isFile()) {
    throw new Error("Shell path is not a file: " + relativePath);
  }
}

if (shellFiles.includes("./config.json")) {
  throw new Error("config.json must not be stored in the shell cache");
}
