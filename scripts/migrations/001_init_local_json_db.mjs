export const id = "001_init_local_json_db";
export const version = 1;
export const description = "Create the local JSON database envelope and operational collections.";

const collections = [
  "markets",
  "funds",
  "stocks",
  "portfolios",
  "watchlist",
  "customFunds",
  "dcaPlans",
  "reports",
  "userPreferences",
  "auditEvents"
];

export function up(input, context) {
  const now = context.now;
  const db = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
  const existingData = db.data && typeof db.data === "object" && !Array.isArray(db.data) ? db.data : {};
  const data = { ...existingData };

  for (const key of collections) {
    if (!Array.isArray(data[key])) {
      data[key] = [];
    }
  }

  return {
    ...db,
    kind: "fundx.local-json-db",
    createdAt: typeof db.createdAt === "string" ? db.createdAt : now,
    migratedAt: now,
    meta: {
      app: "FundX",
      storage: "local-json",
      owner: "operations",
      description: "Operational local JSON store; application routes can migrate to this shape without changing the ops scripts.",
      ...(db.meta && typeof db.meta === "object" ? db.meta : {})
    },
    operational: {
      dataSources: {
        marketDataProvider: null,
        usMarketDataProvider: null
      },
      jobs: {},
      lastBackupAt: null,
      ...(db.operational && typeof db.operational === "object" ? db.operational : {})
    },
    data
  };
}
