"use strict";

const fs = require("fs");
const path = require("path");
const { validateConfigBody } = require("../config-validation.js");

const outputPath = process.argv[2];
if (!outputPath) {
  throw new Error("Usage: node scripts/build-config.cjs OUTPUT_PATH");
}

const templatePath = path.join(__dirname, "..", "config.template.json");
const config = JSON.parse(fs.readFileSync(templatePath, "utf8"));

config.url = process.env.SUPABASE_URL || "";
config.anonKey = process.env.SUPABASE_ANON_KEY || "";
config.generatedAt = new Date().toISOString();

const body = JSON.stringify(config, null, 2) + "\n";
const validation = validateConfigBody(body);

if (!validation.ok) {
  throw new Error(
    "Generated configuration failed validation: " + validation.error
  );
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, body, { encoding: "utf8", flag: "wx" });
