type ConsentDetails = {
  clientName: string;
  clientDomain?: string | null;
  redirectHost: string;
  redirectIsLoopback: boolean;
  scope: string[];
};

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const symbol = `<svg viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="112" fill="#143c31"/><path d="M303 120v120c-19-18-41-26-67-26-57 0-101 43-101 104s44 105 101 105c27 0 50-10 68-29v22h49V120h-50zm-60 253c-31 0-54-23-54-55s23-55 54-55 55 23 55 55-24 55-55 55z" fill="#d6f788"/><circle cx="388" cy="393" r="27" fill="#dc9f65"/></svg>`;
const linkIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 1)"/></svg>`;
const styles = `
:root{color-scheme:light;font-family:'Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif;color:#253d32;background:#f6f7f2;font-synthesis:none}
*{box-sizing:border-box}body{margin:0;padding:36px 20px;min-height:100vh;background:radial-gradient(ellipse at 50% 0,#e6eddf,transparent 65%)}
svg{display:block;width:100%;height:100%}.brand{display:flex;align-items:center;justify-content:center;gap:10px;font-size:17px;font-weight:700;letter-spacing:-.04em;margin:0 auto 28px}.brand svg{width:33px;height:33px}
main{width:min(100%,620px);margin:auto;background:#fff;border:1px solid #dce4d8;border-radius:22px;box-shadow:0 18px 60px #183c3010;overflow:hidden}
.intro{padding:34px 38px 26px;background:#fbfcf8;border-bottom:1px solid #e5ebe1}.connection{display:flex;align-items:center;gap:14px;margin-bottom:24px}.app-icon{width:54px;height:54px;flex:none}.client-icon{display:grid;place-items:center;border:1px solid #dbe5d7;border-radius:13px;background:white;color:#436750}.client-icon svg{width:26px;height:26px}.bridge{display:flex;align-items:center;gap:5px;color:#83997e}.bridge:before,.bridge:after{content:'';width:20px;height:1px;background:#c2d2bb}.bridge span{width:6px;height:6px;background:#8ba780;border-radius:50%}
.eyebrow{font-size:10px;letter-spacing:.18em;font-weight:700;color:#64795c;margin:0 0 10px}h1{font-size:26px;letter-spacing:-.04em;line-height:1.5;margin:0 0 10px}.intro p:last-child{font-size:13px;line-height:1.9;color:#627368;margin:0;overflow-wrap:anywhere}.intro strong{color:#253d32}
.content{padding:26px 38px 30px}.client-details{margin:0 0 26px;padding:0 0 22px;border-bottom:1px solid #e9ede5}.client-details div{display:grid;grid-template-columns:100px minmax(0,1fr);gap:14px;margin:9px 0;font-size:12px;line-height:1.7}dt{color:#69796d}dd{margin:0;overflow-wrap:anywhere;font-weight:600}.note{font-size:11px;color:#6b786d;line-height:1.8;margin:10px 0 0}.content>.note{margin:0 0 18px}.local-note{padding:10px 13px;background:#fff5e8;border-radius:8px;color:#76512b}
fieldset{min-width:0;margin:0;padding:0;border:0}legend{font-size:15px;font-weight:700;padding:0;margin:0 0 5px}.scope-hint{font-size:12px;line-height:1.8;color:#69796d;margin:0 0 15px}.scopes{list-style:none;margin:0;padding:0;display:grid;gap:9px}.scope{display:flex;align-items:flex-start;gap:12px;padding:16px;border:1px solid #e0e7db;border-radius:11px;cursor:pointer;transition:background .15s,border-color .15s}.scope:hover{background:#f8faf5;border-color:#a7bf9e}.scope:has(input:checked){background:#f6f9f1;border-color:#cadbc0}.scope input{width:18px;height:18px;flex:none;margin:3px 0 0;accent-color:#245b43;cursor:pointer}.scope-copy{min-width:0;flex:1}.scope-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;font-weight:700}.badge{font-size:10px;font-weight:500;line-height:1.6;padding:1px 6px;border:1px solid #d6e0cf;border-radius:4px;color:#5b6e51}.scope-description{display:block;margin-top:5px;font-size:11px;line-height:1.8;color:#65735f;overflow-wrap:anywhere}
.revoke-note{display:flex;gap:10px;margin:23px 0;color:#647260;font-size:11px;line-height:1.9}.revoke-note svg{width:17px;height:17px;flex:none;margin-top:3px}.actions{display:grid;grid-template-columns:1fr 1.6fr;gap:12px}button{font:inherit;font-size:13px;font-weight:700;min-height:48px;border:1px solid #d6dfd0;border-radius:9px;padding:12px 16px;background:#fff;color:#50614d;cursor:pointer;transition:background .15s,transform .15s}button:hover{background:#f1f5ec}button:active{transform:translateY(1px)}.approve{background:#1b5944;border-color:#1b5944;color:#fff}.approve:hover{background:#143f31}input:focus-visible,button:focus-visible{outline:3px solid #a5c784;outline-offset:4px}.footer{max-width:620px;margin:19px auto 0;text-align:center;font-size:10px;line-height:1.8;color:#70806a}.error-content{padding:36px}.error-content p{font-size:13px;line-height:1.9;color:#627368}
@media(max-width:520px){body{padding:24px 14px}.brand{margin-bottom:21px}main{border-radius:17px}.intro{padding:27px 23px 22px}.content{padding:22px 23px 25px}h1{font-size:23px}.scope{padding:14px 12px}.client-details div{grid-template-columns:100px minmax(0,1fr);gap:10px}.actions{grid-template-columns:1fr}.approve{grid-row:1}.footer{padding:0 12px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
`;

function page(title: string, content: string) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} | dot カンバン</title><style>${styles}</style></head><body><header class="brand">${symbol}<span>dot カンバン</span></header><main>${content}</main><footer class="footer">dot カンバン · アプリの接続</footer></body></html>`;
}

export function renderConsentPage(details: ConsentDetails, handle: string) {
  const descriptions: Record<string, [string, string]> = {
    "tasks:read": [
      "タスクと履歴を読み取る",
      "実行依頼の内容・進捗・履歴を確認します。接続に必要な権限です。",
    ],
    "tasks:write": [
      "タスクを登録し、着手・進捗を更新する",
      "依頼の登録、実行依頼への着手、状態の変更や進捗・成果の記録を行います。",
    ],
    offline_access: ["接続を維持する", "次回以降も、再認証せずに許可した操作を利用できます。"],
  };
  const scopes = details.scope
    .map((scope) => {
      const [title, description] = descriptions[scope] ?? [
        scope,
        "このアプリが要求している追加の権限です。",
      ];
      const required = scope === "tasks:read";
      return `<li><label class="scope"><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked${required ? " required" : ""}><span class="scope-copy"><span class="scope-title">${escapeHtml(title)}<span class="badge">${required ? "必須" : "任意"}</span></span><span class="scope-description">${escapeHtml(description)}</span></span></label></li>`;
    })
    .join("");
  return page(
    "接続の確認",
    `<section class="intro"><div class="connection" aria-hidden="true"><div class="app-icon">${symbol}</div><div class="bridge"><span></span></div><div class="app-icon client-icon">${linkIcon}</div></div><p class="eyebrow">APP CONNECTION</p><h1>dot カンバンと接続しますか？</h1><p><strong>${escapeHtml(details.clientName)}</strong> がアクセスを求めています。<br>接続するアプリと、許可する操作をご確認ください。</p></section><div class="content"><dl class="client-details"><div><dt>接続するアプリ</dt><dd>${escapeHtml(details.clientName)}</dd></div>${details.clientDomain ? `<div><dt>提供元</dt><dd>${escapeHtml(details.clientDomain)}</dd></div>` : ""}<div><dt>接続後の転送先</dt><dd>${escapeHtml(details.redirectHost)}</dd></div></dl>${!details.clientDomain ? '<p class="note">接続アプリの名前は自己申告です。転送先もあわせてご確認ください。</p>' : ""}${details.redirectIsLoopback ? '<p class="note local-note">この端末上のアプリに認可情報が渡ります。</p>' : ""}<form method="post"><fieldset><legend>許可する操作</legend><p class="scope-hint">任意の操作は、チェックを外して制限できます。</p><ul class="scopes">${scopes}</ul></fieldset><input type="hidden" name="handle" value="${escapeHtml(handle)}"><p class="revoke-note">${linkIcon}<span>接続はいつでも解除できます。<br>設定の「MCP 接続」から管理してください。</span></p><div class="actions"><button type="submit" name="decision" value="deny" formnovalidate>キャンセル</button><button class="approve" type="submit" name="decision" value="approve">接続を許可する <span aria-hidden="true">→</span></button></div></form></div>`,
  );
}

export function renderConsentError(message: string) {
  return page(
    "接続を確認できませんでした",
    `<section class="error-content"><p class="eyebrow">APP CONNECTION</p><h1>接続を確認できませんでした</h1><p>${escapeHtml(message)}</p></section>`,
  );
}
