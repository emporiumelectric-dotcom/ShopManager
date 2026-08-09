(function (root, factory) {
  "use strict";

  var api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.EEConfigValidation = api;
  }
})(
  typeof self !== "undefined" ? self : globalThis,
  function () {
    "use strict";

    var EXPECTED_HOST = "buzidwccluskdkccidev.supabase.co";
    var EXPECTED_REF = "buzidwccluskdkccidev";

    function invalid(error) {
      return { ok: false, error: error };
    }

    function decodeBase64Url(value) {
      if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error("invalid_base64url");
      }

      var normalized = value.replace(/-/g, "+").replace(/_/g, "/");
      while (normalized.length % 4) {
        normalized += "=";
      }

      if (typeof Buffer !== "undefined") {
        return Buffer.from(normalized, "base64").toString("utf8");
      }

      return atob(normalized);
    }

    function validateConfigBody(body, nowMs) {
      if (typeof body !== "string") {
        return invalid("body_not_text");
      }

      var config;
      try {
        config = JSON.parse(body);
      } catch (error) {
        return invalid("invalid_json");
      }

      if (body.indexOf("PLACEHOLDER") !== -1) {
        return invalid("placeholder_present");
      }

      if (!config || typeof config !== "object" || Array.isArray(config)) {
        return invalid("invalid_shape");
      }

      if (config.error === "config_unavailable") {
        return invalid("config_unavailable");
      }

      if (typeof config.url !== "string") {
        return invalid("invalid_url");
      }

      var parsedUrl;
      try {
        parsedUrl = new URL(config.url);
      } catch (error) {
        return invalid("invalid_url");
      }

      if (parsedUrl.protocol !== "https:") {
        return invalid("invalid_scheme");
      }

      if (parsedUrl.hostname !== EXPECTED_HOST) {
        return invalid("wrong_host");
      }

      if (typeof config.anonKey !== "string") {
        return invalid("invalid_anon_key");
      }

      var segments = config.anonKey.split(".");
      if (segments.length !== 3) {
        return invalid("invalid_anon_key");
      }

      var payload;
      try {
        payload = JSON.parse(decodeBase64Url(segments[1]));
      } catch (error) {
        return invalid("invalid_jwt_payload");
      }

      if (!payload || payload.role !== "anon") {
        return invalid("wrong_role");
      }

      if (payload.ref !== EXPECTED_REF) {
        return invalid("wrong_ref");
      }

      if (
        !Object.prototype.hasOwnProperty.call(payload, "exp") ||
        typeof payload.exp !== "number" ||
        !Number.isFinite(payload.exp)
      ) {
        return invalid("missing_expiry");
      }

      var effectiveNow = typeof nowMs === "number" ? nowMs : Date.now();
      if (payload.exp * 1000 <= effectiveNow) {
        return invalid("expired");
      }

      if (typeof config.generatedAt !== "string" || !config.generatedAt) {
        return invalid("invalid_generated_at");
      }

      return {
        ok: true,
        config: {
          url: config.url,
          anonKey: config.anonKey,
          generatedAt: config.generatedAt
        }
      };
    }

    return Object.freeze({
      validateConfigBody: validateConfigBody
    });
  }
);
