// The game's content: each module registers its definitions, in the order the core reads them.
//
// The game's content: each module registers its definitions (registry.ts) as it loads, in this
// order, which is the order the core reads them in (the needs in the body, the options at a
// place, the place kinds after the core's). Sim.ts imports this once; nothing else names a module
// here. A new resource is a module here: its need, its item and uses, the option at a place that
// gives it.
import './shore.ts';
import './food.ts';
import './water.ts';
import './build.ts';
import './chest.ts';
import './person.ts';
