"use strict";

const fs = require("fs");
const { validateConfigBody } = require("../config-validation.js");

const filePath = process.argv[2];
if (!filePath) {
  throw new Error("Usage: node scripts/validate-config-file.cjs FILE");
}

const result = validateConfigBody(fs.readFileSync(filePath, "utf8"));

if (!result.ok) {
  throw new Error("Configuration failed validation: " + result.error);
}
