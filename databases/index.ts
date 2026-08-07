// Database Layer
// Shared database instances: PostgreSQL (CloudNativePG), Redis
//
// MongoDB was removed in Phase 8. It held a 50 Gi PVC with zero consumers:
// UniFi was its only user and moved to the MongoDB bundled inside UniFi OS
// Server (see apps/unifi.ts).

import "./postgresql";
import "./redis";

export * from "./postgresql";
export * from "./redis";
