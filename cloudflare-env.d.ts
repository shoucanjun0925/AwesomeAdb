declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    DOWNLOADS_OWNER_EMAIL?: string;
    CONNECTORS?: import("./lib/connector-contract.mjs").ConnectorBinding;
  }
}
