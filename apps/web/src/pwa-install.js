// Installing LeRoutier onto a device.
//
// LeRoutier is a progressive web app: there is no Play Store or App Store
// listing, and there is not going to be one. It installs from the browser,
// straight from leroutier.app, and afterwards it has its own icon and opens
// without browser chrome like any other app on the phone.
//
// That is a genuinely good deal for a Benin pilot — no store review, no 30 MB
// download over a metered connection, updates the moment we ship — but it has
// one rough edge: nobody knows it is possible unless the product says so. So
// this module exists to make the offer, and the assistant is where it is made.
//
// TWO PATHS, AND THE FIRST ONE IS MUCH BETTER.
//
// Chromium browsers fire `beforeinstallprompt` when a site qualifies, and hand
// you an event you can replay later to open the real install dialog. That
// event fires ONCE, early, usually before React has mounted — so it is
// captured here at module load and stashed. Import this module from main.jsx
// before anything else renders, or the event is simply gone.
//
// Safari on iOS has no such API. There the only route is Share → Add to Home
// Screen, performed by hand, so all we can do is describe it accurately.

/** @type {any} */
let deferred = null;
let installed = false;

const ua = () => (typeof navigator === 'undefined' ? '' : navigator.userAgent || '');

/**
 * iPadOS 13+ reports itself as a Mac. The touch-point count is the usual way
 * to tell an iPad from a MacBook, and it matters here because the two need
 * completely different instructions.
 */
const isIOS = () => /iPad|iPhone|iPod/.test(ua())
  || (/Macintosh/.test(ua()) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
const isAndroid = () => /Android/.test(ua());
// Chrome on iOS is Safari underneath and behaves like it for installs.
const isSafari = () => /Safari/.test(ua()) && !/Chrome|Chromium|Android|CriOS|FxiOS|Edg/.test(ua());
const isFirefox = () => /Firefox|FxiOS/.test(ua());

/** Already running from the home screen rather than inside a browser tab. */
export function isInstalled() {
  if (installed) return true;
  if (typeof window === 'undefined') return false;
  // `navigator.standalone` is the iOS Safari answer; display-mode is everyone else.
  return window.matchMedia?.('(display-mode: standalone)').matches === true
    || window.matchMedia?.('(display-mode: window-controls-overlay)').matches === true
    || /** @type {any} */ (window.navigator).standalone === true;
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', event => {
    // Chromium shows its own mini-infobar unless this is called. We suppress it
    // so the offer appears where we chose to make it, not over the search box.
    event.preventDefault();
    deferred = event;
  });
  window.addEventListener('appinstalled', () => { installed = true; deferred = null; });
}

/** Whether the native install dialog can be opened right now. */
export const canPrompt = () => deferred !== null && !isInstalled();

/**
 * Open the browser's real install dialog.
 *
 * Returns what actually happened rather than a boolean, because "the user said
 * no" and "this browser cannot do it" need different words from the assistant.
 * The event is single-use: once replayed, Chromium will not give it back, so
 * it is cleared whatever the outcome.
 *
 * @returns {Promise<'installed'|'dismissed'|'unavailable'>}
 */
export async function promptInstall() {
  if (!deferred) return 'unavailable';
  const event = deferred;
  deferred = null;
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    if (outcome === 'accepted') { installed = true; return 'installed'; }
    return 'dismissed';
  } catch {
    return 'unavailable';
  }
}

/**
 * How to install by hand, in this browser, on this device.
 *
 * On the confirmation step: the device really does ask, and on Android it may
 * say the app is coming from the browser rather than from a store. That notice
 * is accurate and it is worth explaining rather than waving away — a product
 * that teaches people to dismiss security prompts without reading them has
 * taught them something harmful. So the copy says what the prompt is, why it
 * appears, and that the source to check is leroutier.app.
 */
export function installSteps() {
  if (isInstalled()) {
    return { state: 'installed',
      text: 'LeRoutier est déjà installé sur cet appareil : vous l’utilisez en ce moment depuis l’écran d’accueil.' };
  }
  if (isIOS()) {
    return { state: 'manual', text: isSafari() || !/Chrome|CriOS|FxiOS/.test(ua())
      ? 'Sur iPhone et iPad : touchez le bouton Partager en bas de Safari (le carré avec une flèche vers le haut), '
        + 'faites défiler puis choisissez « Sur l’écran d’accueil », et validez avec « Ajouter ». '
        + 'LeRoutier apparaît ensuite comme une application, avec son icône.'
      : 'Sur iPhone et iPad, l’installation passe par Safari. Ouvrez leroutier.app dans Safari, '
        + 'touchez Partager (le carré avec une flèche), puis « Sur l’écran d’accueil ».' };
  }
  if (isAndroid()) {
    return { state: 'manual', text: isFirefox()
      ? 'Sur Android avec Firefox : ouvrez le menu (⋮), puis « Installer ». '
        + 'Avec Chrome, l’installation est proposée directement.'
      : 'Sur Android : ouvrez le menu de Chrome (les trois points ⋮ en haut à droite), puis touchez '
        + '« Installer l’application ». Votre téléphone demandera une confirmation et pourra préciser que '
        + 'l’application vient d’un site web et non d’une boutique : c’est normal, LeRoutier s’installe '
        + 'directement depuis leroutier.app. Vérifiez que l’adresse affichée est bien leroutier.app, puis confirmez. '
        + 'L’icône apparaît ensuite avec vos autres applications.' };
  }
  if (isFirefox()) {
    return { state: 'unsupported',
      text: 'Firefox sur ordinateur n’installe pas encore les applications web. Ouvrez leroutier.app dans '
        + 'Chrome ou Edge pour l’installer, ou continuez simplement dans cet onglet : le site fonctionne à l’identique.' };
  }
  return { state: 'manual',
    text: 'Sur ordinateur : cliquez sur l’icône d’installation dans la barre d’adresse (à droite de l’adresse), '
      + 'ou ouvrez le menu du navigateur puis « Installer LeRoutier ». '
      + 'L’application s’ouvre ensuite dans sa propre fenêtre, sans barre de navigateur.' };
}

/** One sentence on what installing buys, used above the button. */
export const INSTALL_VALUE = 'Installer LeRoutier ajoute son icône à votre appareil et l’ouvre en plein écran, '
  + 'sans passer par le navigateur. L’application reste la même et continue de fonctionner hors connexion '
  + 'pour ce qui a déjà été chargé.';
