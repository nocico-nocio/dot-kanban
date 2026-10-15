import assert from "node:assert/strict";
import { rejectedRedirectSummary } from "../worker/oauth-diagnostics.ts";

assert.deepEqual(
  rejectedRedirectSummary([
    "https://chatgpt.com/connector/oauth/example?code=private&state=private#private",
    "http://example.test/callback?secret=private",
    "https://user:private@example.test/callback",
    "not a URL",
    null,
  ]),
  {
    count: 5,
    redirects: [
      {
        origin: "https://chatgpt.com",
        pathname: "/connector/oauth/example",
        path_truncated: false,
      },
      { kind: "non_https" },
      { kind: "userinfo_present" },
      { kind: "invalid_url" },
      { kind: "non_string" },
    ],
  },
);
assert.deepEqual(rejectedRedirectSummary("not an array"), {
  count: 0,
  redirects: [{ kind: "not_array" }],
});
const capped = rejectedRedirectSummary(Array(12).fill("https://chatgpt.com/" + "a".repeat(301)));
assert.equal(capped.count, 12);
assert.equal(capped.redirects.length, 8);
assert.equal(capped.redirects[0].pathname.length, 300);
assert.equal(capped.redirects[0].path_truncated, true);
console.log("OAuth redirect diagnostic sanitization passed");
