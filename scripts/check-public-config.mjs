import { readFileSync } from "node:fs";

const readJsonc = (path) => JSON.parse(readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, ""));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const configs = ["wrangler.jsonc", "wrangler.events.example.jsonc"].map(readJsonc);
const example = readFileSync(".dev.vars.example", "utf8");

if (pkg.devDependencies?.wrangler !== "4.149.0") throw new Error("Wrangler version must be pinned");
if (pkg.scripts?.["db:migrate:remote"] !== "wrangler d1 migrations apply DB --remote")
  throw new Error("Migration must target DB binding");
if (!pkg.scripts?.deploy?.includes("db:migrate:remote"))
  throw new Error("Deploy must apply migrations first");
for (const config of configs) {
  if (
    config.workers_dev !== true ||
    config.d1_databases?.length !== 1 ||
    config.d1_databases[0].binding !== "DB" ||
    config.d1_databases[0].migrations_dir !== "migrations" ||
    !config.d1_databases[0].database_name ||
    !config.d1_databases[0].database_id ||
    config.kv_namespaces?.length !== 1 ||
    config.kv_namespaces[0].binding !== "OAUTH_KV" ||
    !config.kv_namespaces[0].id ||
    config.account_id ||
    config.route ||
    config.routes
  )
    throw new Error("Public Wrangler configuration is incomplete");
  if (Object.keys(config.vars || {}).some((key) => /TOKEN|SECRET|KEY|PASSWORD/i.test(key)))
    throw new Error("Secret found in vars");
}
if (configs[0].containers || configs[0].triggers?.crons || configs[0].vars?.EVENTS_ENABLED)
  throw new Error("Standard configuration must not enable Events");
if (
  !configs[1].containers?.length ||
  !configs[1].triggers?.crons?.length ||
  configs[1].vars?.EVENTS_ENABLED !== "true"
)
  throw new Error("Optional Events configuration is incomplete");
for (const line of example.split(/\r?\n/)) {
  if (!line || line.startsWith("#")) continue;
  if (!/^[A-Z][A-Z0-9_]*=$/.test(line))
    throw new Error("Environment example must contain names only");
}
console.log("Public configuration OK");
