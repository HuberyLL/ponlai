// The app's entry: installs the app's settings, then loads the app by a dynamic import.
//
// The app's entry, the module index.html loads: it installs the app's settings (PageSettings.ts)
// and only then loads the app (main.ts). The app's modules read their settings as they load, and
// a bundle evaluates the shared chunks a chunk imports before that chunk's own code, so a module
// of the app that sits in a shared chunk would read them before an install made among the app's
// own imports. Loading the app by a dynamic import puts the whole of it after the install.
import './PageSettings.ts';

await import( './main.ts' );
