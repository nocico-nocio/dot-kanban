import http from "node:http";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export async function startMockIdp() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const kid = randomUUID();
  const jwk = { ...(await exportJWK(publicKey)), kid, use: "sig", alg: "RS256" };
  const issuer = "http://127.0.0.1:9191";
  let certificateRequests = 0;
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/jwks" || req.url === "/cdn-cgi/access/certs") {
      certificateRequests++;
      res.end(JSON.stringify({ keys: [jwk] }));
    } else if (req.url === "/.well-known/oauth-authorization-server")
      res.end(
        JSON.stringify({
          issuer,
          jwks_uri: issuer + "/jwks",
          authorization_endpoint: issuer + "/authorize",
          token_endpoint: issuer + "/token",
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["tasks:read", "tasks:write"],
        }),
      );
    else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise((resolve) => server.listen(9191, "127.0.0.1", resolve));
  const token = async ({
    subject = "local-test-owner",
    audience = `${process.env.TEST_BASE_URL || "http://localhost:8787"}/mcp`,
    scope = "tasks:read tasks:write",
    expires = "10m",
    tokenIssuer = issuer,
    type,
    email = "owner@example.test",
  } = {}) => {
    const builder = new SignJWT({ scope, email, ...(type ? { type } : {}) })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(tokenIssuer)
      .setSubject(subject)
      .setAudience(audience)
      .setIssuedAt();
    return (expires ? builder.setExpirationTime(expires) : builder).sign(privateKey);
  };
  return {
    server,
    token,
    get certificateRequests() {
      return certificateRequests;
    },
  };
}
