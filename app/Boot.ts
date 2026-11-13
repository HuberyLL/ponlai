// The page's entry: installs the page's settings, then loads the page by a dynamic import.
//
// The page's entry, the module index.html loads: it installs the page's settings (PageSettings.ts)
// and only then loads the page (main.ts). The page's modules read their settings as they load, and
// a bundle evaluates the shared chunks a chunk imports before that chunk's own code, so a module
// of the page that sits in a shared chunk would read them before an install made among the page's
// own imports. Loading the page by a dynamic import puts the whole of it after the install.
import './PageSettings.ts';

await import( './main.ts' );
