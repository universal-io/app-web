/**
 * The one place this site names the macOS download.
 *
 * It is deliberately version-less. `tools/release.sh --promote` in app-mac
 * repoints this URL at whichever build has been verified, which is exactly so
 * that the site never has to be edited per release. Pinning a version here
 * turns every CTA into a link that goes stale the next time a build ships —
 * which is what happened once already: the hero pointed at 0.1.0/build-2 while
 * two later releases had been promoted, so the site handed out an old app.
 *
 * Every download CTA imports this. Adding a second literal anywhere reopens
 * that failure.
 */
export const MACOS_DOWNLOAD_URL = "https://dl.universal-io.com/Universal-IO.dmg";
