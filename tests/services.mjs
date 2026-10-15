import assert from "node:assert/strict";
import {
  settingsSchema,
  projectIcons,
  publicSettings,
  editableSettings,
} from "../worker/routing.ts";
import { readProjectIcon, validProjectIcon } from "../worker/project-icons.ts";

const legacy = { targets: [], agents: [], models: [], rules: [] };
assert.deepEqual(settingsSchema.parse(legacy).services, []);
const service = {
  id: "sample",
  name: "Sample",
  repository: "https://github.com/acme/sample",
  icon: "https://example.com/icon.svg",
};
assert.equal(settingsSchema.parse({ ...legacy, services: [service] }).services[0].name, "Sample");
for (const invalid of [
  { ...service, name: "" },
  { ...service, name: "x".repeat(121) },
  { ...service, icon: "javascript:alert(1)" },
  { ...service, icon: "data:image/svg+xml,test" },
  { ...service, repository: "https://user:password@github.com/acme/sample" },
])
  assert.equal(settingsSchema.safeParse({ ...legacy, services: [invalid] }).success, false);
assert.equal(
  settingsSchema.safeParse({
    ...legacy,
    services: [service, { ...service, id: "second", name: " sample " }],
  }).success,
  false,
);
assert.equal(
  settingsSchema.safeParse({ ...legacy, services: [service, { ...service, name: "Other" }] })
    .success,
  false,
);
const iconPath = "/api/service-icons/11111111-1111-4111-8111-111111111111";
for (const icon of [...projectIcons, iconPath])
  assert.equal(
    settingsSchema.safeParse({ ...legacy, services: [{ ...service, icon }] }).success,
    true,
  );
for (const icon of ["symbol:unknown", "//evil.test/icon", "/api/service-icons/../settings"])
  assert.equal(
    settingsSchema.safeParse({ ...legacy, services: [{ ...service, icon }] }).success,
    false,
  );
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK8sAAAAASUVORK5CYII=",
  "base64",
);
assert.equal(validProjectIcon(png), true);
assert.equal(
  validProjectIcon(new TextEncoder().encode("<svg><script>alert(1)</script></svg>")),
  false,
);
const oversized = Buffer.from(png);
oversized.writeUInt32BE(129, 16);
assert.equal(validProjectIcon(oversized), false);
assert.equal(validProjectIcon(new Uint8Array(97 * 1024)), false);
const upload = (body, type = "image/png") =>
  new Request("https://example.test/api/service-icons", {
    method: "POST",
    headers: { "content-type": type },
    body,
  });
assert.deepEqual(await readProjectIcon(upload(png)), new Uint8Array(png));
assert.equal(await readProjectIcon(upload(png, "image/svg+xml")), null);
assert.equal(await readProjectIcon(upload(new Uint8Array(97 * 1024))), null);
console.log(
  "PASS project presets, uploaded icon references, schema compatibility and bounded image upload validation",
);

const stored = settingsSchema.parse({
  ...legacy,
  services: [service],
  targets: [{ id: "device", label: "Device", kind: "device", enabled: true }].map((target) => ({
    ...target,
    id: "device-one",
  })),
  agents: [
    {
      id: "claude",
      label: "Claude",
      enabled: true,
      adapter: "claude_code",
      target_kinds: ["device"],
    },
  ],
});
assert.deepEqual(
  settingsSchema.parse(editableSettings(publicSettings(stored))),
  stored,
  "read-only connection metadata is excluded from saves",
);
