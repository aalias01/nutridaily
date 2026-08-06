/* NutriDaily deployment config.
 * Committed copy keeps secrets empty. At deploy, scripts/inject-client-id.js
 * may fill this from GOOGLE_CLIENT_ID / DISCORD_WEBHOOK_URL / FEEDBACK_*.
 * Forks: leave empty, or set your own env / paste Client ID in Settings.
 */
window.ND_CONFIG = {
  googleClientId: "",
  feedbackEndpoint: "",
  feedbackMailto: "",
};
