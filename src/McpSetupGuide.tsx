import { useRef, useState } from "react";
import { AgentIcon } from "./AgentIcon";
import { t, type Locale, type MessageKey } from "./i18n";

const agents = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    promptName: "ChatGPT / dot",
    docs: "https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt",
    notes: ["mcpChatgptCloud", "mcpChatgptLocal", "mcpChatgptSchedule"],
    executionDocs: "https://help.openai.com/en/articles/20001530-getting-started-with-your-dot",
  },
  {
    id: "claude",
    name: "Claude",
    promptName: "Claude / Claude Code",
    docs: "https://code.claude.com/docs/en/mcp",
    notes: ["mcpClaudeAuth", "mcpClaudeCloud", "mcpClaudeLocal"],
    executionDocs: "https://code.claude.com/docs/en/scheduled-tasks",
  },
  {
    id: "grok",
    name: "Grok",
    promptName: "Grok / Grok Bot / Grok Build",
    docs: "https://docs.x.ai/grok/connectors",
    notes: ["mcpGrokAuth", "mcpGrokCloud", "mcpGrokLocal", "mcpGrokSchedule"],
    executionDocs: null,
  },
  {
    id: "codex",
    name: "Codex",
    promptName: "Codex",
    docs: "https://developers.openai.com/codex/mcp",
    notes: ["mcpCodexAuth", "mcpCodexCloud", "mcpCodexLocal"],
    executionDocs: "https://developers.openai.com/codex/app/automations",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    promptName: "Gemini CLI",
    docs: "https://geminicli.com/docs/tools/mcp-server/",
    notes: ["mcpGeminiAuth", "mcpGeminiCloud", "mcpGeminiLocal", "mcpGeminiSchedule"],
    executionDocs: "https://geminicli.com/docs/cli/headless/",
  },
  {
    id: "cursor",
    name: "Cursor",
    promptName: "Cursor",
    docs: "https://cursor.com/docs/mcp",
    notes: ["mcpCursorAuth", "mcpCursorCloud", "mcpCursorLocal"],
    executionDocs: "https://cursor.com/docs/cloud-agent/automations",
  },
] as const;

export function McpSetupGuide({ locale, endpoint }: { locale: Locale; endpoint: string }) {
  const [selected, setSelected] = useState(0);
  const [place, setPlace] = useState<"ask" | "cloud" | "local">("ask");
  const [copied, setCopied] = useState("");
  const [copyFailed, setCopyFailed] = useState(false);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const endpointInput = useRef<HTMLInputElement>(null);
  const agent = agents[selected];
  const installFile = locale === "en" ? "INSTALL.md" : `docs/INSTALL.${locale}.md`;
  const guideUrl = "https://github.com/nocico-nocio/dot-kanban";
  const placeKey: MessageKey =
    place === "cloud" ? "mcpWorkCloud" : place === "local" ? "mcpWorkLocal" : "mcpWorkAsk";
  const prompt = t(locale, "mcpSetupShort")
    .replace("{guide}", guideUrl)
    .replace("{file}", installFile)
    .replace("{agent}", agent.promptName)
    .replace("{url}", endpoint)
    .replace("{place}", t(locale, placeKey));
  const selectAgent = (index: number) => {
    setSelected(index);
    setPlace(agents[index].id === "gemini" ? "local" : "ask");
    setCopied("");
    setCopyFailed(false);
  };
  const copy = async (value: string, field: "url" | "prompt") => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      setCopyFailed(false);
    } catch {
      const input = field === "url" ? endpointInput.current : promptInput.current;
      input?.focus();
      input?.select();
      setCopyFailed(true);
    }
  };
  return (
    <section className="mcp-setup" aria-labelledby="mcp-setup-heading">
      <h3 id="mcp-setup-heading">{t(locale, "mcpSetupHeading")}</h3>
      <div className="mcp-setup-tabs" role="tablist" aria-label={t(locale, "mcpSetupHeading")}>
        {agents.map((item, index) => (
          <button
            key={item.id}
            id={`mcp-tab-${item.id}`}
            type="button"
            role="tab"
            aria-label={item.name}
            aria-selected={index === selected}
            aria-controls="mcp-setup-panel"
            tabIndex={index === selected ? 0 : -1}
            onClick={() => {
              selectAgent(index);
            }}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % agents.length
                  : event.key === "ArrowLeft"
                    ? (index + agents.length - 1) % agents.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? agents.length - 1
                        : null;
              if (next === null) return;
              event.preventDefault();
              selectAgent(next);
              document.getElementById(`mcp-tab-${agents[next].id}`)?.focus();
            }}
          >
            {item.id === "chatgpt" && (
              <small className="mcp-recommended">{t(locale, "recommended")}</small>
            )}
            <AgentIcon name={item.name} />
            <span>{item.name}</span>
          </button>
        ))}
      </div>
      <div id="mcp-setup-panel" role="tabpanel" aria-labelledby={`mcp-tab-${agent.id}`}>
        <p className="mcp-client-note">
          {agent.id === "chatgpt" ? (
            t(locale, "mcpRecommendReason")
          ) : agent.id === "claude" ? (
            <span aria-hidden="true">&nbsp;</span>
          ) : (
            <>
              {t(locale, "mcpDeveloperUnverified")}{" "}
              <a
                href="https://github.com/nocico-nocio/dot-kanban/issues/new"
                target="_blank"
                rel="noreferrer"
              >
                {t(locale, "reportConnectionIssue")} ↗
              </a>
            </>
          )}
        </p>
        <div className="mcp-endpoint">
          <input
            ref={endpointInput}
            aria-label={t(locale, "mcpUrl")}
            value={endpoint}
            readOnly
            onFocus={(event) => event.target.select()}
          />
          <button type="button" onClick={() => void copy(endpoint, "url")}>
            {t(locale, copied === endpoint ? "copied" : "copy")}
          </button>
        </div>
        <div className="mcp-execution">
          <label htmlFor="mcp-execution-place">{t(locale, "mcpExecutionPlace")}</label>
          <select
            id="mcp-execution-place"
            value={place}
            onChange={(event) => {
              setPlace(event.target.value as typeof place);
              setCopied("");
              setCopyFailed(false);
            }}
          >
            <option value="ask">{t(locale, "mcpExecutionAsk")}</option>
            <option value="cloud">{t(locale, "cloud")}</option>
            <option value="local">{t(locale, "mcpExecutionLocal")}</option>
          </select>
          <p>{t(locale, "mcpExecutionHint")}</p>
          <ul>
            {agent.notes.map((note) => (
              <li key={note}>{t(locale, note)}</li>
            ))}
          </ul>
          <p>{t(locale, "mcpSeparateEnvironments")}</p>
        </div>
        <div className="mcp-prompt-heading">
          <label htmlFor="mcp-setup-prompt">
            {t(locale, "mcpSetupPrompt").replace("{agent}", agent.name)}
          </label>
          <button type="button" onClick={() => void copy(prompt, "prompt")}>
            {t(locale, copied === prompt ? "copied" : "copyInstructions")}
          </button>
        </div>
        <textarea
          ref={promptInput}
          id="mcp-setup-prompt"
          className="mcp-setup-prompt"
          readOnly
          value={prompt}
          rows={7}
        />
        <div className="mcp-setup-footer">
          <div className="mcp-doc-links">
            <a href={agent.docs} target="_blank" rel="noreferrer">
              {t(locale, "officialSetupGuide")} ↗
            </a>
            {agent.executionDocs && (
              <a href={agent.executionDocs} target="_blank" rel="noreferrer">
                {t(locale, "mcpExecutionDocs")} ↗
              </a>
            )}
          </div>
          <span role="status">
            {copyFailed ? t(locale, "copyManually") : copied ? t(locale, "copied") : ""}
          </span>
        </div>
      </div>
    </section>
  );
}
