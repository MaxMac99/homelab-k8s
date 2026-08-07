// Application Layer
// User-facing applications and services
//
// AdGuard was removed in Phase 8. DNS now runs natively on brink-server and
// winkel-pi, one resolver per site, so it survives cluster rebuilds — which an
// in-cluster resolver cannot, since the cluster it lives in needs DNS to come
// up. Both routers hand out the native resolvers. See the `setup` repo,
// modules/system/site-dns.nix.

import "./paperless";
import "./homepage";
import "./unifi";
import "./homeassistant";
import "./mosquitto";
import "./timemachine";

export * from "./paperless";
export * from "./homepage";
export * from "./unifi";
export * from "./homeassistant";
export * from "./mosquitto";
export * from "./timemachine";
