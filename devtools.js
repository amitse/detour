/* Detour — DevTools bootstrap
 *
 * Runs in the devtools extension page on first open of DevTools. Its only
 * job is to register the "Detour" panel. The panel UI lives in panel.html
 * (which reuses popup.js). Detection of which surface is active happens
 * inside popup.js via the presence of chrome.devtools.
 */
chrome.devtools.panels.create(
  "Detour",
  "icons/icon-128.png",
  "panel.html"
);
