/**
 * Pure HTML shell for the WebDAV sync UI (tooltip + panel).
 *
 * The extension host (terminal/html.ts via sync/markup.ts) passes a
 * localized string dict; tests pass their own so the runtime modules never
 * depend on vscode. Icons come from the DOM-free Lucide serializer.
 */
import { SYNC_ICONS } from "./icons";

export interface SyncShellStrings {
  tipDismiss: string;
  actSyncNow: string;
  panelTitle: string;
  panelAria: string;
  closeTitle: string;
  navGeneral: string;
  navServer: string;
  unconfiguredBanner: string;
  unconfiguredGo: string;
  saveBtnHint: string;
  navItems: string;
  navConflict: string;
  navHistory: string;
  navLog: string;
  fUrl: string;
  fUrlHint: string;
  fUser: string;
  fPass: string;
  passSetBadge: string;
  fBasePath: string;
  fRateLimit: string;
  fRateLimitUnlimited: string;
  fRateLimitRequests: string;
  fRateLimitPer: string;
  fRateLimitMinutes: string;
  fRateLimitHint: string;
  fHttp: string;
  fHttpHint: string;
  fSelfSigned: string;
  fSelfSignedHint: string;
  fShowIcon: string;
  fShowIconHint: string;
  panelIntro: string;
  autoSync: string;
  chevTitle: string;
  fStartup: string;
  fStartupHint: string;
  fLocal: string;
  fLocalHint: string;
  fPoll: string;
  fPollHint: string;
  pollInterval: string;
  pollUnit: string;
  testBtn: string;
  saveBtn: string;
  itemsTitle: string;
  addPlaceholder: string;
  addBtn: string;
  itemsHintPrefix: string;
  itemsHintLink: string;
  itemsHintSuffix: string;
  excludeTitle: string;
  excludePlaceholder: string;
  excludeAddBtn: string;
  excludeHint: string;
  hTime: string;
  hTrigger: string;
  hResult: string;
  hSummary: string;
  histClear: string;
}

export function renderSyncShell(d: SyncShellStrings): string {
  return `
<div class="dav-tip hidden" id="dav-sync-tip" role="tooltip">
  <span class="dav-tip-ic" id="dav-sync-tip-ic"></span>
  <span class="dav-tip-text" id="dav-sync-tip-text"></span>
  <button type="button" class="dav-tip-close" id="dav-sync-tip-close" aria-label="${d.tipDismiss}">${SYNC_ICONS.close}</button>
</div>
<div class="dav-overlay hidden" id="dav-overlay">
  <div class="dav-modal" id="dav-modal" role="dialog" aria-modal="true" aria-label="${d.panelAria}">
    <div class="dav-header">
      <div class="dav-title-wrap">
        <h1 class="dav-title">${d.panelTitle}</h1>
        <div class="dav-sub-row">
          <span class="dav-sub" id="dav-sub-mode">${d.panelIntro}</span>
          <span class="dav-sub" id="dav-sub-pending" hidden></span>
          <span class="dav-sub dav-sub--error" id="dav-sub-conflict" hidden></span>
          <span class="dav-sub dav-sub--error" id="dav-sub-paused" hidden></span>
          <span class="dav-sub dav-sub--warn" id="dav-sub-auth" hidden></span>
          <span class="dav-sub" id="dav-sub-leader" hidden></span>
        </div>
      </div>
      <div class="dav-header-actions">
        <button type="button" class="dav-icon-btn" id="dav-modal-close" title="${d.closeTitle}" aria-label="${d.closeTitle}">${SYNC_ICONS.panelClose}</button>
      </div>
    </div>
    <div class="dav-error hidden" id="dav-error" role="alert"><span id="dav-error-text"></span></div>
    <div class="dav-main">
      <nav class="dav-nav" id="dav-nav" aria-label="${d.panelTitle}">
        <button type="button" class="dav-nav-item is-on" data-pane="general">${d.navGeneral}</button>
        <button type="button" class="dav-nav-item" data-pane="server">${d.navServer}</button>
        <button type="button" class="dav-nav-item" data-pane="items">${d.navItems}</button>
        <button type="button" class="dav-nav-item" data-pane="conflict">${d.navConflict}<span class="dav-nav-count hidden" id="dav-nav-conflict-count"></span></button>
        <button type="button" class="dav-nav-item" data-pane="history">${d.navHistory}</button>
        <button type="button" class="dav-nav-item" data-pane="log">${d.navLog}</button>
      </nav>
      <div class="dav-body" id="dav-body">
        <div class="dav-pane is-on" data-pane="general" id="dav-pane-general">
          <div class="dav-banner dav-banner--warn hidden" id="dav-unconfigured-banner" role="status">
            <span>${d.unconfiguredBanner}</span>
            <button type="button" class="dav-btn dav-btn--secondary" id="dav-unconfigured-go">${d.unconfiguredGo} ›</button>
          </div>
          <div class="dav-banner dav-banner--warn hidden" id="dav-auth-banner" role="status">
            <span id="dav-auth-banner-text"></span>
            <button type="button" class="dav-btn dav-btn--secondary" id="dav-auth-go"></button>
          </div>
          <div class="dav-master-row">
            <label class="dav-check"><input type="checkbox" id="dav-f-master" aria-label="${d.autoSync}"><span>${d.autoSync}</span></label>
            <button type="button" class="dav-sub-chev" id="dav-sub-toggle" aria-expanded="true" title="${d.chevTitle}">
              ${SYNC_ICONS.chevron}
            </button>
          </div>
          <div class="dav-sub-settings" id="dav-auto-group">
            <div class="dav-sub-body" id="dav-sub-body">
              <label class="dav-check"><input type="checkbox" id="dav-f-startup"><span>${d.fStartup}<span class="dav-hint">${d.fStartupHint}</span></span></label>
              <label class="dav-check"><input type="checkbox" id="dav-f-local"><span>${d.fLocal}<span class="dav-hint">${d.fLocalHint}</span></span></label>
              <label class="dav-check"><input type="checkbox" id="dav-f-poll"><span>${d.fPoll}<span class="dav-hint">${d.fPollHint}</span></span></label>
              <div class="dav-poll-row">
                <label class="dav-poll-label" for="dav-f-interval">${d.pollInterval}</label>
                <input type="number" id="dav-f-interval" value="30" min="1" step="1">
                <span class="dav-poll-unit">${d.pollUnit}</span>
              </div>
            </div>
          </div>
          <label class="dav-check dav-block-gap"><input type="checkbox" id="dav-f-showicon"><span>${d.fShowIcon}<span class="dav-hint">${d.fShowIconHint}</span></span></label>
        </div>
        <div class="dav-pane" data-pane="server" id="dav-pane-server">
          <div class="dav-field">
            <label for="dav-f-url">${d.fUrl}</label>
            <input type="text" id="dav-f-url" spellcheck="false" autocomplete="off">
            <div class="dav-hint">${d.fUrlHint}</div>
          </div>
          <div class="dav-field">
            <label for="dav-f-user">${d.fUser}</label>
            <input type="text" id="dav-f-user" spellcheck="false" autocomplete="off">
          </div>
          <div class="dav-field">
            <label for="dav-f-pass">${d.fPass}</label>
            <div class="dav-pass-row">
              <input type="password" id="dav-f-pass" autocomplete="new-password">
              <span class="dav-pw-set hidden" id="dav-f-passbadge">${d.passSetBadge}</span>
            </div>
          </div>
          <div class="dav-field">
            <label for="dav-f-basepath">${d.fBasePath}</label>
            <input type="text" id="dav-f-basepath" spellcheck="false" autocomplete="off">
          </div>
          <div class="dav-ratelimit-row">
            <label for="dav-f-ratelimit-req">${d.fRateLimit}</label>
            <input type="number" id="dav-f-ratelimit-req" min="0" step="1" placeholder="${d.fRateLimitUnlimited}">
            <span class="dav-ratelimit-unit">${d.fRateLimitRequests}</span>
            <span class="dav-ratelimit-unit">${d.fRateLimitPer}</span>
            <input type="number" id="dav-f-ratelimit-window" min="1" step="1" value="30">
            <span class="dav-ratelimit-unit">${d.fRateLimitMinutes}</span>
          </div>
          <div class="dav-hint">${d.fRateLimitHint}</div>
          <label class="dav-check"><input type="checkbox" id="dav-f-http"><span>${d.fHttp}<span class="dav-hint">${d.fHttpHint}</span></span></label>
          <label class="dav-check"><input type="checkbox" id="dav-f-selfsigned"><span>${d.fSelfSigned}<span class="dav-hint">${d.fSelfSignedHint}</span></span></label>
          <div class="dav-form-actions">
            <span class="dav-test-result" id="dav-test-result"></span>
            <button type="button" class="dav-btn dav-btn--secondary" id="dav-btn-test">${d.testBtn}</button>
            <button type="button" class="dav-btn" id="dav-btn-save" title="${d.saveBtnHint}">${d.saveBtn}</button>
          </div>
        </div>
        <div class="dav-pane" data-pane="items" id="dav-pane-items">
          <section class="dav-item-group">
            <div class="dav-item-head">
              <span class="dav-item-head-label">${d.itemsTitle}</span>
              <span class="dav-item-head-hint">${d.itemsHintPrefix} <button type="button" class="dav-link" id="dav-open-config-dir">${d.itemsHintLink}</button>${d.itemsHintSuffix}</span>
            </div>
            <div id="dav-items-list"></div>
            <div class="dav-add">
              <div class="dav-add-row">
                <input type="text" id="dav-item-add-input" placeholder="${d.addPlaceholder}" spellcheck="false" autocomplete="off">
                <button type="button" class="dav-btn dav-btn--secondary" id="dav-item-add-btn">${d.addBtn}</button>
              </div>
              <div class="dav-add-error hidden" id="dav-item-add-error" role="alert"></div>
            </div>
          </section>
          <section class="dav-item-group">
            <div class="dav-item-head">
              <span class="dav-item-head-label">${d.excludeTitle}</span>
              <span class="dav-item-head-hint">${d.excludeHint}</span>
            </div>
            <div id="dav-exclude-list"></div>
            <div class="dav-add">
              <div class="dav-add-row">
                <input type="text" id="dav-exclude-add-input" placeholder="${d.excludePlaceholder}" spellcheck="false" autocomplete="off">
                <button type="button" class="dav-btn dav-btn--secondary" id="dav-exclude-add-btn">${d.excludeAddBtn}</button>
              </div>
              <div class="dav-add-error hidden" id="dav-exclude-add-error" role="alert"></div>
            </div>
          </section>
        </div>
        <div class="dav-pane" data-pane="conflict" id="dav-pane-conflict">
          <div class="dav-conflict-bar hidden" id="dav-conflict-bar">
            <label class="dav-conflict-all">
              <input type="checkbox" id="dav-conflict-all">
              <span id="dav-conflict-all-label"></span>
            </label>
            <span class="dav-conflict-sel" id="dav-conflict-sel"></span>
            <span class="dav-conflict-bar-spacer"></span>
            <button type="button" class="dav-btn dav-btn--secondary" id="dav-conflict-keep" disabled></button>
            <button type="button" class="dav-btn dav-btn--secondary" id="dav-conflict-use" disabled></button>
          </div>
          <div id="dav-conflict-list"></div>
        </div>
        <div class="dav-pane" data-pane="history" id="dav-pane-history">
          <div class="dav-hist-top">
            <div class="dav-hist-grid dav-hist-head">
              <span>${d.hTime}</span><span>${d.hTrigger}</span><span>${d.hResult}</span><span>${d.hSummary}</span>
            </div>
            <button type="button" class="dav-hist-clear" id="dav-hist-clear" title="${d.histClear}" aria-label="${d.histClear}">${SYNC_ICONS.trash}</button>
          </div>
          <div id="dav-hist-list"></div>
        </div>
        <div class="dav-pane" data-pane="log" id="dav-pane-log">
          <pre class="dav-log-pre" id="dav-log-pre"></pre>
          <div class="dav-empty hidden" id="dav-log-empty"></div>
        </div>
      </div>
    </div>
    <div class="dav-footer">
      <span class="dav-foot-st" id="dav-foot-st"></span>
      <button type="button" class="dav-btn" id="dav-foot-sync">${d.actSyncNow}</button>
    </div>
  </div>
</div>`;
}
