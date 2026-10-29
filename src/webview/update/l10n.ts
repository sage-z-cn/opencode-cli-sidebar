/**
 * OpenCode self-update UI strings.
 *
 * Evaluated on the extension host (same pattern as terminal/toolbar.ts) and
 * injected into the webview document as `window.__OC_UPDATE_L10N__` by
 * terminal/html.ts. The webview module reads it with English fallbacks.
 *
 * NOTE: zh-CN translations for these keys must be added to
 * l10n/bundle.l10n.zh-cn.json (host packaging owns that file).
 */
import { l10n } from "../../i18n";

export const openCodeUpdateL10nStrings: Record<string, string> = {
  // Pill (version entry) states
  updateLabel: l10n.t('Install OpenCode'),
  viewProgressLabel: l10n.t('View install progress'),
  updateAvailableTooltip: l10n.t(
    'OpenCode update available: latest {0}',
  ),
  updatingTooltip: l10n.t('Installing OpenCode, click to view progress'),
  failedRetryTooltip: l10n.t('Update did not finish. Click to try again'),
  pillChangelogTooltip: l10n.t("View the current version's changelog"),
  installLabel: l10n.t('Install'),
  installTooltip: l10n.t(
    'OpenCode CLI is not installed. Click to choose an install method.',
  ),

  // Missing-CLI install confirmation dialog
  installPromptTitle: l10n.t('Install OpenCode CLI'),
  installPromptBody: l10n.t(
    'OpenCode CLI was not found on this machine. Install it now?',
  ),
  notNowLabel: l10n.t('Not now'),
  redetectLabel: l10n.t('Re-detect'),
  redetectFailed: l10n.t(
    'OpenCode CLI still not detected. Re-detect or choose an install method.',
  ),

  // Update dialog: release notes step
  changelogLabel: l10n.t('Changelog'),
  changelogSend: l10n.t('Send to OpenCode'),
  changelogSentLabel: l10n.t('Sent'),
  changelogSendPrompt: l10n.t(
    'The above is the OpenCode {0} changelog. Please summarize it.',
  ),
  changelogLoading: l10n.t('Fetching changelog…'),
  changelogFailed: l10n.t('Changelog is unavailable for this version.'),
  changelogOpenInBrowser: l10n.t('Open in browser'),
  changelogCheck: l10n.t('Check for new version'),
  changelogUpToDate: l10n.t('Already on the latest version.'),
  changelogCheckFailed: l10n.t('Check failed. Try again later.'),
  versionDelta: l10n.t('Current {0}, new {1}'),
  notesUnavailable: l10n.t(
    'Release notes are unavailable for this version. You can still update.',
  ),
  updateNotesCta: l10n.t('Update to {0}'),
  latestLabel: l10n.t('latest'),

  // Update dialog: method step
  installPopoverTitle: l10n.t('Install OpenCode CLI'),
  updatePopoverTitle: l10n.t('Update OpenCode CLI to {0}'),
  backToNotes: l10n.t('Release notes'),
  hintConfirm: l10n.t('Enter to confirm'),
  cancelLabel: l10n.t('Cancel'),
  methodDetected: l10n.t('Detected install method'),
  methodLastUsed: l10n.t('Last used'),

  // Method one-line explanations
  descCurl: l10n.t('Download and run the official install script'),
  descNpm: l10n.t('Install via the npm global package'),
  descPnpm: l10n.t('Install via the pnpm global package'),
  descBun: l10n.t('Install via the bun global package'),
  descYarn: l10n.t('Install via the yarn global package'),
  descVp: l10n.t('Install via the vp tool'),
  descBrew: l10n.t('Install via Homebrew'),
  descScoop: l10n.t('Install via Scoop'),
  descChoco: l10n.t('Install via Chocolatey'),

  // Update dialog: progress step
  installProgressTitle: l10n.t('Installing OpenCode'),
  updateProgressTitle: l10n.t('Updating OpenCode to {0}'),
  updateProgressPlainTitle: l10n.t('Updating OpenCode'),
  stepPrepareTarget: l10n.t('Resolve latest version'),
  stepPrepareLocal: l10n.t('Read installed version'),
  stepExecute: l10n.t('Downloading and installing'),
  stepReshim: l10n.t('Sync nvm shim'),
  stepVerify: l10n.t('Verify version'),
  stepRemediateTrust: l10n.t('Apply nvm trust setting'),
  stepRemediateReshim: l10n.t('Run nvm reshim'),
  stepInstalling: l10n.t('Install OpenCode CLI'),
  minimize: l10n.t('Minimize'),
  abortUpdate: l10n.t('Abort update'),
  abortConfirm: l10n.t('Click again to abort'),
  outputTitle: l10n.t('Output'),

  // Update dialog: result step
  successTitle: l10n.t('OpenCode {0} installed.'),
  successMessage: l10n.t('Restart the terminal now?'),
  sessionAutoStarted: l10n.t('OpenCode session started automatically.'),
  restartNow: l10n.t('Restart now'),
  resultRetry: l10n.t('Retry'),
  resultClose: l10n.t('Close'),
  updateFailedTitle: l10n.t('Update did not finish'),
  blockedTitle: l10n.t('npm install blocked by nvm security policy'),
  abandonUpdate: l10n.t('Abandon install'),
  remediateFailed: l10n.t(
    'Automatic fix did not succeed. Run the following commands in the terminal, then start the install again.',
  ),
  abandonedHint: l10n.t('Install abandoned'),

  // Copy feedback
  copy: l10n.t('Copy'),
  copied: l10n.t('Copied'),
  copyFailed: l10n.t('Copy failed'),

  // Manual check transients
  checkingUpdates: l10n.t('Checking for updates…'),

  // Misc
  closeLabel: l10n.t('Close'),
};
