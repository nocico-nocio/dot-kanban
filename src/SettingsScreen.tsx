import packageInfo from "../package.json" with { type: "json" };
import { locales, t, type Locale } from "./i18n";
import authorIcon from "./assets/author.png";
import githubIcon from "./assets/github.svg";

export function SettingsScreen({
  locale,
  onLocaleChange,
}: {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
}) {
  return (
    <section className="settings-page about-settings">
      <header className="settings-head">
        <h1>{t(locale, "settings")}</h1>
      </header>
      <section className="setting-group general-settings" aria-labelledby="general-heading">
        <h2 id="general-heading">{t(locale, "general")}</h2>
        <div className="setting-language-row">
          <label htmlFor="settings-language">{t(locale, "language")}</label>
          <select
            id="settings-language"
            value={locale}
            onChange={(event) => onLocaleChange(event.target.value as Locale)}
          >
            {locales.map((value) => (
              <option key={value} value={value}>
                {
                  {
                    en: "English",
                    ja: "日本語",
                    ko: "한국어",
                    "zh-TW": "繁體中文",
                    "zh-CN": "简体中文",
                  }[value]
                }
              </option>
            ))}
          </select>
        </div>
      </section>
      <section className="setting-group" aria-labelledby="version-heading">
        <h2 id="version-heading">{t(locale, "appVersion")}</h2>
        <p>{packageInfo.version.replace(/\.0$/, "")}</p>
      </section>
      <section className="setting-group author-settings" aria-labelledby="author-heading">
        <h2 id="author-heading">Author</h2>
        <div className="author-profile">
          <img className="author-avatar" src={authorIcon} alt="のっち" width="80" height="80" />
          <div>
            <h3>
              <a
                className="author-name-link"
                href="https://mi-te.me/sano"
                target="_blank"
                rel="noopener noreferrer"
              >
                のっち
                <svg
                  viewBox="0 0 24 24"
                  width="17"
                  height="17"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" />
                </svg>
              </a>
            </h3>
          </div>
        </div>
        <div className="about-links">
          <a
            href="https://github.com/nocico-nocio/dot-kanban"
            target="_blank"
            rel="noopener noreferrer"
          >
            <img src={githubIcon} alt="" width="18" height="18" />
            <span>https://github.com/nocico-nocio/dot-kanban</span>
          </a>
        </div>
      </section>
      <section className="setting-group user-message" aria-labelledby="message-heading">
        <h2 id="message-heading">{t(locale, "userMessageHeading")}</h2>
        <p className="user-message-body">{t(locale, "userMessageBody")}</p>
        <p>{t(locale, "userMessageFeedback")}</p>
        <a
          href="https://github.com/nocico-nocio/dot-kanban/issues"
          target="_blank"
          rel="noopener noreferrer"
        >
          {t(locale, "sendFeedback")} <span aria-hidden="true">↗</span>
        </a>
      </section>
    </section>
  );
}
