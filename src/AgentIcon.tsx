import type { McpConnection } from "../worker/connections";
import chatgpt from "./assets/agents/chatgpt.svg";
import claude from "./assets/agents/claude.svg";
import grok from "./assets/agents/grok.svg";
import codex from "./assets/agents/codex.svg";
import gemini from "./assets/agents/gemini.svg";
import cursor from "./assets/agents/cursor.svg";

const logos = { chatgpt, claude, grok, codex, gemini, cursor };

export function AgentIcon({ connection, name }: { connection?: McpConnection; name?: string }) {
  const label = connection?.client_name || name || "MCP";
  const identity = `${label} ${connection?.client_id || ""}`.toLowerCase();
  const kind = /claude|anthropic/.test(identity)
    ? "claude"
    : /grok|x\.ai/.test(identity)
      ? "grok"
      : /codex/.test(identity)
        ? "codex"
        : /gemini/.test(identity)
          ? "gemini"
          : /cursor/.test(identity)
            ? "cursor"
            : /chatgpt|openai|\bdot\b/.test(identity)
              ? "chatgpt"
              : "mcp";
  return (
    <span className={`agent-icon agent-icon-${kind}`} role="img" aria-label={label}>
      {kind !== "mcp" ? (
        <img src={logos[kind]} alt="" aria-hidden="true" />
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <rect x="4" y="6" width="16" height="14" rx="4" />
          <path d="M12 3v3M8 11v2M16 11v2M9 17h6" />
        </svg>
      )}
    </span>
  );
}
