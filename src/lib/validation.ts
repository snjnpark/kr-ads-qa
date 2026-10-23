import { z } from "zod";

// Configure before any schema is constructed so strict CSP never sees Zod's eval probe.
z.config({ jitless: true });

export { z };
