/* NutriDaily deployment config.
 * Committed copy keeps googleClientId empty. At deploy, scripts/inject-client-id.js
 * may fill this from GOOGLE_CLIENT_ID. Forks: leave empty, or paste Client ID under
 * Settings → Advanced. The diary works fully without Drive when this is empty.
 */
window.ND_CONFIG = {
  googleClientId: "",
};
