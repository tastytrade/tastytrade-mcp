/**
 * Static `tastytrade://symbology-reference` resource.
 *
 * Bundles the API overview doc (auth, headers, parameter conventions, OCC
 * option symbol format, futures + futures-option symbology). Agents do not
 * reliably know tastytrade's symbology from training data, so bundling it
 * makes the material first-class and versioned alongside the server.
 */

import { readVendoredDoc } from "./vendored-docs.js";

export const SYMBOLOGY_REFERENCE_MD =
  "# tastytrade Symbology + API Reference\n\n" +
  "This document bundles the api-overview from tastytrade-llms-txt-docs. It covers authentication, request " +
  "headers, JSON conventions (kebab-case keys, except market-data which is camelCase), API versioning, OCC " +
  "option symbol format, futures + futures-options symbology, and pagination semantics. Read this before " +
  "constructing instrument symbols or interpreting API responses.\n\n" +
  "---\n\n" +
  readVendoredDoc("api-overview.md");
