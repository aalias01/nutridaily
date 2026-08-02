/* NutriChat deployment config.
 * Committed copy keeps googleClientId empty. At deploy, scripts/inject-client-id.js
 * may fill this from GOOGLE_CLIENT_ID. Forks: leave empty, or paste Client ID in Settings.
 */
window.NC_CONFIG = {
  googleClientId: ""
};
