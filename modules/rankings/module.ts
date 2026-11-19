import { defineModule } from "@aihot/contracts/modules";
export const rankings = defineModule({ name: "rankings", pages: [{ path: "rankings", file: "web/page.tsx" }], adminPages: [{ path: "admin/radar", file: "web/admin.tsx" }], apiPaths: [/^\/api\/site\/rankings(?:\/|$)/] });
