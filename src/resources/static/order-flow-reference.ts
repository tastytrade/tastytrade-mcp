/**
 * Static `tastytrade://order-flow-reference` resource.
 *
 * Bundles the order-flow doc — order lifecycle, status transitions, fill
 * vs. cancel semantics, complex-order relationships.
 */

import { readVendoredDoc } from "./vendored-docs.js";

export const ORDER_FLOW_REFERENCE_MD =
  "# tastytrade Order Flow Reference\n\n" +
  "This document bundles the order-flow guide from tastytrade-llms-txt-docs. It covers the order lifecycle " +
  "(Received → Routed → Live → Filled / Cancelled / Expired / Rejected), partial-fill semantics, " +
  "complex-order relationships (OTO / OCO / OTOCO / PAIRS), and tag-based component tracking. " +
  "Read this when explaining order responses or building OTOCO-style strategies.\n\n" +
  "---\n\n" +
  readVendoredDoc("order-flow.md");
