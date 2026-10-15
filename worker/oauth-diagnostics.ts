const MAX_RECORDED_REDIRECTS = 8;
const MAX_RECORDED_PATH_LENGTH = 300;

export function rejectedRedirectSummary(value: unknown) {
  if (!Array.isArray(value)) return { count: 0, redirects: [{ kind: "not_array" }] };

  return {
    count: value.length,
    redirects: value.slice(0, MAX_RECORDED_REDIRECTS).map((item: unknown) => {
      if (typeof item !== "string") return { kind: "non_string" };
      let url: URL;
      try {
        url = new URL(item);
      } catch {
        return { kind: "invalid_url" };
      }
      if (url.protocol !== "https:") return { kind: "non_https" };
      if (url.username || url.password) return { kind: "userinfo_present" };
      return {
        origin: url.origin,
        pathname: url.pathname.slice(0, MAX_RECORDED_PATH_LENGTH),
        path_truncated: url.pathname.length > MAX_RECORDED_PATH_LENGTH,
      };
    }),
  };
}
