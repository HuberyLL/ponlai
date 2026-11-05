// Plays the game headless in node and writes what happened, so a designer can read days of play
// without a browser and a brain can be judged offline on the same island, the same day clock and
// the same record the page keeps. Pure CPU; Node 22.18+ strips the imported TypeScript.
//
//   node tools/play-game.mjs [--days 5] [--seed 1] [--hour 8] [--pieces 0] [--grow]
//     [--population 0] [--place kind[@x,z]]... [--script file.json] [--brain standin|<module>]
//     [--latency 90] [--thoughts] [--out dir]
//
//   --days N        game days to play (default 5; a fraction plays part of one)
//   --seed S        the game's seed (SimState.seed: the islanders, their lifespans, the catches)
//   --hour H        the whole hour the game starts at (default 8, the page's)
//   --pieces P      the island grown by P pieces (tools/game-fixture.mjs `inputAt`, land seed 1)
//   --grow          when the population reaches a step (Sim.growthDue), the next piece arrives at
//                   once, as the page's swap hands it back (Sim.addPiece of `inputAt( pieces + 1 )`)
//   --population N  N islanders more than the starting three (Sim.addIslander: drawn sex and age)
//   --place K[@x,z] a blueprint of kind K placed at the start (repeatable), at world metres x, z;
//                   without a point at the first open ground that takes it, outward from the
//                   island's middle (as verify-game's chests)
//   --script F      the leader's lines, JSON: [ { "at": "d1 08:30", "to": "all" | [ "v1" ],
//                   "words": "..." } ], said as Game.speak says them (below)
//   --brain B       `standin` (sim/standin.ts, the default), or a module's path: its `createBrain`
//                   or default export is called with the context below and returns a Brain (or a
//                   Promise of one)
//   --latency G     the game seconds an asynchronous thought takes (default 90: three real
//                   seconds at the day clock's default 2880 s a game day, where a real second is
//                   30 game seconds)
//   --thoughts      also write thoughts.jsonl: every thought, what the islander perceived and the
//                   brain's answer (calls, or why it failed), for judging a brain offline
//   --out DIR       where the outputs go (default artifacts/play/<UTC stamp>/, git-ignored)
//
// What it guarantees. The simulation runs as the page runs it (Game.update, Game.render): a tick
// at a time, the record (Chronicle.ts) looking once after every tick as the page's does once a
// frame, the leader's lines and the growth between ticks. With a brain that answers at once (the
// stand-in) the run is the simulation's own deterministic game: the same options write the same
// files byte for byte (nothing in them depends on the wall clock or the output folder). An
// asynchronous brain (a `think` that returns a Promise) never holds up the page's world, so
// headless the world runs on for --latency game seconds after a thought is asked and only then
// waits, however long the answer takes in real time, before it applies the answer and steps on:
// the timing of every answer is a function of the options, and a brain whose answers are a
// function of its perceptions plays a repeatable game too. An answer that comes sooner in real time
// still lands at its tick.
//
// Mirrored from Game.ts, which is not reachable headless (it builds the view and the interface):
// `speak` (the line goes into the record as the player's; for a brain that `hears`, each listener
// keeps it until its next thought takes it, and is asked for a thought at once, which Sim.think
// refuses while one is in flight), `takeHeard` / `hasHeard`, the record's first look before any
// tick (the starting islanders land; --population's land with them), blueprints placed after it
// (the record notes them as the player's, as from the build bar) and the growth. The record
// notes no skies: the weather is the page's own and nothing in the simulation depends on it. A
// change to how Game.ts feeds the record, hears or grows changes this copy too, until both take
// those parts from one headless module (a refactor to do: Game.ts holds them beside the view).
//
// The brain module's context: `heard( id )` and its Game name `takeHeard( id )` (the leader's
// words the islander heard since the last call, oldest first), `hasHeard( id )`, `islander( id )`
// (name, sex and age in years: perception never names the one it is for), `note( id, text )` (a
// line of the brain's own in the transcript, e.g. its reasoning) and `options` (this run's). A
// brain that keeps failing (MAX_FAILURES answers rejected in a row) ends the run with exit 1, its
// outputs written.
//
// Outputs, in the --out folder: transcript.md (day by day: the record's entries, the islanders'
// actions with their outcomes, consecutive alike ones merged, what they said, the brain's thoughts
// when it is asynchronous, needs every six game hours, and a table per day), timeline.json (each
// game hour, every islander's position, needs, bag and action), summary.json (per islander the
// share of time by activity, each need's lowest, mean and highest, each item's flows by the call
// that moved it, thoughts; the dead, the buildings and when they were placed and built, the
// island's stock, the growth, the record's entries by kind), record.json (the record as a save
// holds it) and, with --thoughts, thoughts.jsonl (a line per thought: who, when it was asked and
// answered, the perception and the calls). On stdout a short summary. Exit 0 when the run played
// through, 1 when it failed (a brain that kept failing, an error), 2 for a bad option. A long run
// (many days, a language-model brain) goes through tools/job.mjs.
//
// Generic: no need, item, option or building is named here. The needs are the body's own keys,
// the activities the calls under way, an item's flows the bag's changes put down to the call that
// made them, the buildings and the stock the state's: a new rule shows in the outputs without a
// change to the tool. Only what Game.ts does around the simulation is mirrored (above), and
// follows Game.ts.
import './qos.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { newGame } from '../src/game/sim/Sim.ts';
import { StandInBrain } from '../src/game/sim/standin.ts';
import { BUILDING_KINDS } from '../src/game/sim/buildings.ts';
import { Chronicle } from '../src/game/Chronicle.ts';
import { stockOf } from '../src/game/sim/stock.ts';
import { dayOf, hourOf } from '../src/game/sim/clock.ts';
import { ageOf } from '../src/game/sim/life.ts';
import { SECONDS_PER_GAME_DAY } from '../src/game/sim/types.ts';
import { inputAt } from './game-fixture.mjs';

const HOUR = 3600;
// a sky for the record's look: with no game hours passed it notes none (see the header)
const SKY = 'fair';
// rejected answers in a row that end the run
const MAX_FAILURES = 10;
const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const USAGE = 'usage: node tools/play-game.mjs [--days 5] [--seed 1] [--hour 8] [--pieces 0] [--grow] [--population 0] [--place kind[@x,z]]... [--script file.json] [--brain standin|<module>] [--latency 90] [--thoughts] [--out dir] (see the header)';

function fail( message ) {

	console.error( `play-game: ${ message }\n${ USAGE }` );
	process.exit( 2 );

}

// ------------------------------------------------------------------ options

function parseOptions( argv ) {

	const o = { days: 5, seed: 1, hour: 8, pieces: 0, grow: false, population: 0, place: [], script: null, brain: 'standin', latency: 90, thoughts: false, out: null };
	const number = ( name, text, ok ) => {

		const x = Number( text );
		if ( text === undefined || text === '' || ! Number.isFinite( x ) || ! ok( x ) ) fail( `bad value for ${ name }: ${ text }` );
		return x;

	};
	const whole = ( x ) => Number.isInteger( x ) && x >= 0;
	for ( let i = 0; i < argv.length; i ++ ) {

		const arg = argv[ i ], value = () => argv[ ++ i ];
		switch ( arg ) {

			case '--days': o.days = number( arg, value(), ( x ) => x > 0 ); break;
			case '--seed': o.seed = number( arg, value(), whole ); break;
			case '--hour': o.hour = number( arg, value(), ( x ) => whole( x ) && x < 24 ); break;
			case '--pieces': o.pieces = number( arg, value(), whole ); break;
			case '--population': o.population = number( arg, value(), whole ); break;
			case '--latency': o.latency = number( arg, value(), whole ); break;
			case '--grow': o.grow = true; break;
			case '--thoughts': o.thoughts = true; break;
			case '--place': {

				const text = value() ?? '';
				const m = /^([a-z]+)(?:@(-?[\d.]+),(-?[\d.]+))?$/.exec( text );
				if ( ! m ) fail( `bad value for --place: ${ text } (kind or kind@x,z)` );
				if ( ! Object.hasOwn( BUILDING_KINDS, m[ 1 ] ) ) fail( `there is no building called ${ m[ 1 ] } (${ Object.keys( BUILDING_KINDS ).join( ', ' ) })` );
				o.place.push( { text, kind: m[ 1 ], at: m[ 2 ] === undefined ? null : { x: number( '--place x', m[ 2 ], () => true ), z: number( '--place z', m[ 3 ], () => true ) } } );
				break;

			}
			case '--script': o.script = value() ?? fail( '--script needs a file' ); break;
			case '--brain': o.brain = value() ?? fail( '--brain needs standin or a module' ); break;
			case '--out': o.out = value() ?? fail( '--out needs a folder' ); break;
			case '--help': case '-h': console.log( USAGE ); process.exit( 0 ); break;
			default: fail( `unknown option ${ arg }` );

		}

	}
	return o;

}

/** The leader's lines, by the tick each is said at (a line before the game's start is an error). */
function readScript( file, startHour ) {

	let lines;
	try {

		lines = JSON.parse( readFileSync( file, 'utf8' ) );

	} catch ( error ) {

		fail( `cannot read the script ${ file }: ${ error.message }` );

	}
	if ( ! Array.isArray( lines ) ) fail( 'the script is a JSON array of { at, to, words }' );
	return lines.map( ( line, n ) => {

		const m = /^d(\d+) (\d{1,2}):(\d{2})$/.exec( String( line?.at ) );
		if ( ! m || Number( m[ 2 ] ) > 23 || Number( m[ 3 ] ) > 59 ) fail( `script line ${ n + 1 }: "at" is "d<day> HH:MM"` );
		const tick = ( ( Number( m[ 1 ] ) - 1 ) * 24 + Number( m[ 2 ] ) - startHour ) * HOUR + Number( m[ 3 ] ) * 60;
		if ( tick < 0 ) fail( `script line ${ n + 1 }: ${ line.at } is before the game starts` );
		const to = line.to ?? 'all';
		if ( to !== 'all' && ! ( Array.isArray( to ) && to.length > 0 && to.every( ( id ) => typeof id === 'string' ) ) ) fail( `script line ${ n + 1 }: "to" is "all" or a list of ids` );
		if ( typeof line.words !== 'string' || line.words.trim() === '' ) fail( `script line ${ n + 1 }: no words` );
		return { tick, n, to, words: line.words };

	} ).sort( ( a, b ) => a.tick - b.tick || a.n - b.n );

}

const options = parseOptions( process.argv.slice( 2 ) );
const script = options.script ? readScript( options.script, options.hour ) : [];
const realStart = performance.now();

// ------------------------------------------------------------------ the game

const sim = newGame( inputAt( options.pieces ), { seed: options.seed, startHour: options.hour, pieces: options.pieces } );
for ( let n = 0; n < options.population; n ++ ) sim.addIslander();
const record = new Chronicle();
// the record's first look, before any tick (Game.begin): the islanders land at the start
record.observe( sim, SKY, 0 );

const clockOf = ( tick ) => {

	const minutes = Math.floor( hourOf( { tick, startHour: options.hour } ) * 60 );
	return `${ String( Math.floor( minutes / 60 ) ).padStart( 2, '0' ) }:${ String( minutes % 60 ).padStart( 2, '0' ) }`;

};
const dayAt = ( tick ) => dayOf( { tick, startHour: options.hour } ) + 1;
const when = ( tick ) => `d${ dayAt( tick ) } ${ clockOf( tick ) }`;

// what the islanders are called in the outputs: by name, with the id where a name repeats
const people = new Map();
const label = ( id ) => {

	const v = people.get( id );
	if ( ! v ) return id;
	return [ ...people.values() ].some( ( o ) => o !== v && o.name === v.name ) ? `${ v.name } (${ id })` : v.name;

};
const meet = () => {

	for ( const v of sim.state.villagers ) if ( ! people.has( v.id ) ) people.set( v.id, { id: v.id, name: v.name, sex: v.sex, age: Math.floor( ageOf( v, sim.state.tick ) ) } );

};
meet();

/** A call in a few words, people by name: "go shore", "do give 小禾 fish 1". */
function describe( call ) {

	const args = call.args && typeof call.args === 'object' ? call.args : {};
	// a `do` reads as its option and place first: "do put chest1 fish 1"
	const keys = call.tool === 'do' ? [ 'action', 'place', ...Object.keys( args ).filter( ( k ) => k !== 'action' && k !== 'place' ) ] : Object.keys( args );
	const values = keys.map( ( k ) => args[ k ] ).filter( ( x ) => x !== undefined ).map( ( x ) => people.has( x ) ? label( x ) : typeof x === 'object' ? JSON.stringify( x ) : String( x ) );
	return [ call.tool, ...values ].join( ' ' );

}

// ------------------------------------------------------------------ the transcript's lines

const lines = [];
let seq = 0;
const push = ( tick, text ) => lines.push( { tick, seq: seq ++, text } );

// each islander's current run of alike actions: consecutive calls of the same words (a fishing
// spell, a night of waits, a refusal repeated) make one line with their outcomes tallied
const spells = new Map();
// the outcome each islander's last action left (Villager.last), as last logged: a new one that no
// tool call made is an action that ended
const lastSeen = new Map();

function flush( id ) {

	const s = spells.get( id );
	if ( ! s ) return;
	spells.delete( id );
	const span = clockOf( s.end ) !== clockOf( s.start ) ? `${ clockOf( s.start ) }–${ clockOf( s.end ) }` : clockOf( s.start );
	const outcomes = [ ...s.outcomes ].map( ( [ text, n ] ) => s.count > 1 && n > 1 ? `${ text } ×${ n }` : text ).join( ', ' );
	const tail = s.open ? `${ outcomes ? `${ outcomes }, ` : '' }under way at the end` : outcomes;
	push( s.start, `${ span } ${ label( id ) }: ${ s.text }${ s.count > 1 ? ` ×${ s.count }` : '' }${ s.refused ? ' refused: ' : ' → ' }${ tail }` );

}

function open( id, call, tick, refused ) {

	const text = describe( call ), key = `${ refused ? 'x ' : '' }${ text }`;
	const s = spells.get( id );
	if ( s && ! s.open && s.key === key ) {

		s.count ++;
		s.open = true;
		s.end = tick;
		return;

	}
	flush( id );
	spells.set( id, { key, text, refused, start: tick, end: tick, count: 1, open: true, outcomes: new Map() } );

}

function close( id, outcome, tick ) {

	const s = spells.get( id );
	if ( ! s?.open ) return;
	s.open = false;
	s.end = tick;
	s.outcomes.set( outcome, ( s.outcomes.get( outcome ) ?? 0 ) + 1 );

}

// ------------------------------------------------------------------ statistics

// Nothing below names a need, an item, an option or a building: the needs are the body's own keys,
// the activities the calls under way, and an item's flows are the bag's changes, each put down to
// the call that made it (its tool, and a do's option: "do fish", "use", "do give") or, for what
// another's call brought, `received`; so new rules show here without a change to the tool.
const blank = () => ( { ticks: {}, needs: {}, samples: 0, items: {}, refused: 0, thoughts: 0 } );
const totals = new Map(), days = new Map();
function statsOf( id, day ) {

	if ( ! totals.has( id ) ) totals.set( id, blank() );
	if ( ! days.has( day ) ) days.set( day, new Map() );
	const today = days.get( day );
	if ( ! today.has( id ) ) today.set( id, blank() );
	return [ totals.get( id ), today.get( id ) ];

}
const bump = ( id, key, n = 1 ) => {

	for ( const s of statsOf( id, dayAt( sim.state.tick ) ) ) s[ key ] += n;

};

/** What a call is called in the item flows: its tool, and a do's option. */
const flowOf = ( call ) => call?.tool === 'do' ? `do ${ String( call.args?.action ) }` : String( call?.tool ?? 'other' );

// each islander's bag as last accounted: a change since is put down to the call that made it
const bags = new Map();
function account( v, flow ) {

	const before = bags.get( v.id ) ?? {}, now = v.bag;
	for ( const item of new Set( [ ...Object.keys( before ), ...Object.keys( now ) ] ) ) {

		const delta = ( now[ item ] ?? 0 ) - ( before[ item ] ?? 0 );
		if ( delta === 0 ) continue;
		for ( const s of statsOf( v.id, dayAt( sim.state.tick ) ) ) {

			const flows = s.items[ item ] ??= {};
			flows[ flow ] = ( flows[ flow ] ?? 0 ) + delta;

		}

	}
	bags.set( v.id, { ...now } );

}

/** What the body does this tick, for the share of time. */
function activity( v ) {

	const call = v.action?.call;
	if ( call?.tool === 'do' ) return String( call.args.action );
	if ( call ) return call.tool;
	if ( v.path ) return 'walk';
	return sim.thinking( v.id ) ? 'thinking' : 'idle';

}

const outcomeOf = ( result ) => result.ok ? result.value ?? 'done' : result.reason;

/** An action the tick ended (Villager.last changed outside a tool call): its outcome. */
function settle( v ) {

	if ( v.last === ( lastSeen.get( v.id ) ?? null ) ) return;
	lastSeen.set( v.id, v.last );
	const { call, result } = v.last;
	close( v.id, outcomeOf( result ), sim.state.tick );
	account( v, flowOf( call ) );

}

// the tools wrapped, to see each call as it is made (Game.ts hands the simulation the same five)
const tools = new Map();
for ( const [ name, handler ] of sim.tools ) {

	tools.set( name, ( body, args, s ) => {

		const tick = s.state.tick;
		if ( name === 'say' ) {

			const result = handler( body, args, s );
			if ( result.ok ) push( tick, `${ clockOf( tick ) } ${ label( body.id ) } says: ${ args.words }` );
			return result;

		}
		settle( body );
		const before = body.action;
		const result = handler( body, args, s );
		lastSeen.set( body.id, body.last );
		if ( ! result.ok ) {

			bump( body.id, 'refused' );
			// a refused call replaces nothing: beside an action under way it is a line of its own
			if ( before ) push( tick, `${ clockOf( tick ) } ${ label( body.id ) }: ${ describe( body.last.call ) } refused: ${ result.reason }` );
			else {

				open( body.id, body.last.call, tick, true );
				close( body.id, result.reason, tick );

			}
			return result;

		}
		if ( before ) close( body.id, 'replaced', tick );
		if ( body.action && body.action !== before ) {

			open( body.id, body.action.call, tick, false );
			return result;

		}
		// done at once (use, put, take, give, a go already there): what it moved is its own, and what
		// reached another's bag they received
		const call = body.last.call;
		open( body.id, call, tick, false );
		close( body.id, outcomeOf( result ), tick );
		account( body, flowOf( call ) );
		for ( const o of s.state.villagers ) if ( o !== body ) account( o, 'received' );
		return result;

	} );

}
sim.tools = tools;

// ------------------------------------------------------------------ the brain

// the leader's words each islander heard and no thought has taken yet (Game.ts `heard`)
const heard = new Map();
const takeHeard = ( id ) => {

	const words = heard.get( id ) ?? [];
	heard.delete( id );
	return words;

};
const context = {
	heard: takeHeard,
	takeHeard,
	hasHeard: ( id ) => ( heard.get( id )?.length ?? 0 ) > 0,
	islander: ( id ) => {

		const v = sim.villager( id );
		return v ? { id, name: v.name, sex: v.sex, age: Math.floor( ageOf( v, sim.state.tick ) ) } : null;

	},
	note: ( id, text ) => push( sim.state.tick, `${ clockOf( sim.state.tick ) } ${ label( id ) } (brain): ${ text }` ),
	options: { ...options, out: undefined },
};

async function loadBrain( spec ) {

	if ( spec === 'standin' ) return new StandInBrain();
	let module;
	try {

		module = await import( pathToFileURL( path.resolve( spec ) ).href );

	} catch ( error ) {

		fail( `cannot load the brain ${ spec }: ${ error.message }` );

	}
	const make = module.createBrain ?? module.default;
	const brain = typeof make === 'function' ? await make( context ) : make;
	if ( typeof brain?.think !== 'function' ) fail( `${ spec } exports no brain: a createBrain or default function that returns one` );
	return brain;

}

// An answer rejected: the thought ends without acting, as on the page (Sim.think's promise
// rejects; the islander is asked again once it has nothing under way).
class BrainFailure extends Error {}
process.on( 'unhandledRejection', ( reason ) => {

	if ( reason instanceof BrainFailure ) return;
	throw reason;

} );

const inner = await loadBrain( options.brain );
// thoughts in flight, in the order asked (so in the order due: the latency is one for all), and
// every thought with what it perceived and answered (--thoughts)
const pending = [], thoughts = [];
let asked = 0, answered = 0, failed = 0, failures = 0;
// the brain in the islanders' slot: the inner brain's answers, an asynchronous one held to its tick
const brain = {
	hears: inner.hears ?? false,
	think( perception, who ) {

		asked ++;
		bump( who, 'thoughts' );
		const answer = inner.think( perception, who );
		if ( ! ( answer instanceof Promise ) ) {

			if ( options.thoughts ) thoughts.push( { who, asked: when( sim.state.tick ), perception, calls: answer } );
			return answer;

		}
		const entry = { who, asked: sim.state.tick, due: sim.state.tick + options.latency, answer, perception };
		// settled meanwhile (in real time) without counting as unhandled
		answer.catch( () => {} );
		const gate = new Promise( ( resolve, reject ) => {

			entry.resolve = resolve;
			entry.reject = reject;

		} );
		pending.push( entry );
		return gate;

	},
};
sim.brain = brain;

/** The thoughts due by now: wait for each answer, then let it act on the body at this tick. */
async function answerDue() {

	while ( pending.length > 0 && pending[ 0 ].due <= sim.state.tick && failures < MAX_FAILURES ) {

		const entry = pending.shift(), tick = sim.state.tick, span = `${ clockOf( entry.asked ) }–${ clockOf( tick ) }`;
		try {

			const calls = await entry.answer;
			if ( ! Array.isArray( calls ) ) throw new Error( `the answer is not a list of tool calls: ${ JSON.stringify( calls ) }` );
			answered ++;
			failures = 0;
			push( entry.asked, `${ span } ${ label( entry.who ) } thought → ${ calls.length ? calls.map( describe ).join( '; ' ) : 'nothing' }` );
			if ( options.thoughts ) thoughts.push( { who: entry.who, asked: when( entry.asked ), answered: when( tick ), perception: entry.perception, calls } );
			entry.resolve( calls );

		} catch ( error ) {

			failed ++;
			failures ++;
			push( entry.asked, `${ span } ${ label( entry.who ) } thought, and failed: ${ error?.message ?? error }` );
			if ( options.thoughts ) thoughts.push( { who: entry.who, asked: when( entry.asked ), answered: when( tick ), perception: entry.perception, failed: String( error?.message ?? error ) } );
			entry.reject( new BrainFailure( String( error?.message ?? error ) ) );

		}
		// Sim.think's continuation acts on the body before the world steps on
		await new Promise( ( resolve ) => setImmediate( resolve ) );

	}

}

/** The leader speaks (Game.speak): the record notes it; a brain that hears gets the words for each
 * listener's next thought, and is asked for one now. */
function speak( words, to ) {

	const text = words.trim();
	record.add( sim, { kind: 'said', who: 'player', to, text } );
	if ( ! brain.hears ) return;
	const listeners = to === 'all' ? sim.state.villagers.map( ( v ) => v.id ) : to;
	for ( const id of listeners ) {

		if ( ! heard.has( id ) ) heard.set( id, [] );
		heard.get( id ).push( text );

	}
	for ( const id of listeners ) sim.think( id );

}

// ------------------------------------------------------------------ the start

for ( const spec of options.place ) {

	const refusal = spec.at ? sim.placeBlueprint( spec.kind, spec.at.x, spec.at.z ) : placeAnywhere( spec.kind );
	if ( refusal ) fail( `--place ${ spec.text }: ${ refusal }` );
	const b = sim.state.buildings.at( - 1 );
	push( 0, `${ clockOf( 0 ) } [start] ${ b.id } placed at ${ b.x.toFixed( 2 ) }, ${ b.z.toFixed( 2 ) }` );

}
// blueprints placed after the first look: the player's, as from the build bar
record.observe( sim, SKY, 0 );

/** A blueprint at the first open ground that takes it, outward from the island's middle; null when
 * placed, else why not. */
function placeAnywhere( kind ) {

	const grid = sim.grid, cells = [];
	for ( let k = 0; k < grid.open.length; k ++ ) if ( grid.region[ k ] === grid.main ) cells.push( k );
	cells.sort( ( a, b ) => Math.hypot( grid.centreX( a ), grid.centreZ( a ) ) - Math.hypot( grid.centreX( b ), grid.centreZ( b ) ) || a - b );
	for ( const k of cells ) if ( sim.placeBlueprint( kind, grid.centreX( k ), grid.centreZ( k ) ) === null ) return null;
	return `no open ground takes a ${ kind }`;

}

// ------------------------------------------------------------------ the run

const timeline = [];
const growth = [];
const end = Math.round( options.days * SECONDS_PER_GAME_DAY );
let line = 0, recorded = 0, gone = 0, ok = true;

/** Every hour: each islander's state (timeline.json); every six, their needs in the transcript. */
function sample() {

	const tick = sim.state.tick;
	timeline.push( { tick, day: dayAt( tick ), time: clockOf( tick ), islanders: sim.state.villagers.map( ( v ) => ( {
		id: v.id, x: round( v.pos.x, 2 ), z: round( v.pos.z, 2 ), needs: Object.fromEntries( Object.entries( v.needs ).map( ( [ k, x ] ) => [ k, round( x, 1 ) ] ) ),
		bag: { ...v.bag }, doing: v.action ? describe( v.action.call ) : v.path ? 'walk' : sim.thinking( v.id ) ? 'thinking' : null,
	} ) ) } );
	if ( ( options.hour * HOUR + tick ) % ( 6 * HOUR ) !== 0 ) return;
	const needs = sim.state.villagers.map( ( v ) => {

		const bag = Object.entries( v.bag ).map( ( [ item, n ] ) => `${ item } ${ n }` ).join( ', ' );
		return `${ label( v.id ) } ${ Object.entries( v.needs ).map( ( [ k, x ] ) => `${ k } ${ Math.round( x ) }` ).join( ', ' ) }${ bag ? ` (${ bag })` : '' }`;

	} );
	push( tick, `${ clockOf( tick ) } [needs] ${ needs.join( ' · ' ) }` );

}

function round( x, digits ) {

	return Number( x.toFixed( digits ) );

}

/** The record's new entries as transcript lines (an islander's words come from its `say`). */
function readRecord() {

	for ( ; recorded < record.entries.length; recorded ++ ) {

		const e = record.entries[ recorded ];
		const tick = ( ( e.day - 1 ) * 24 - options.hour ) * HOUR + e.minute * 60;
		const who = e.who === 'player' ? 'the player' : e.who === 'island' ? 'the island' : label( e.who );
		const to = e.to === 'all' ? 'everyone' : e.to?.map( label ).join( ', ' );
		const text = {
			landed: () => `${ who } landed`,
			died: () => `${ who } died at ${ e.text }`,
			said: () => e.who === 'player' ? `the player said to ${ to }: ${ e.text }` : null,
			gave: () => `${ who } gave ${ to } ${ e.count } ${ e.text }`,
			placed: () => `the player placed a ${ e.text } (${ e.subject })`,
			built: () => `${ e.subject } (${ e.text }) was built`,
			need: () => `${ who }'s ${ e.text } turned critical`,
		}[ e.kind ]?.() ?? ( e.kind === 'said' ? null : `${ e.kind } ${ JSON.stringify( e ) }` );
		if ( text ) push( Math.max( tick, 0 ), `${ String( Math.floor( e.minute / 60 ) ).padStart( 2, '0' ) }:${ String( e.minute % 60 ).padStart( 2, '0' ) } [record] ${ text }` );

	}

}

readRecord();
sample();
let lastDay = dayAt( 0 );
for ( ;; ) {

	// between frames: the leader's lines due, the answers due, a growth due (Game.update)
	while ( line < script.length && script[ line ].tick <= sim.state.tick ) speak( script[ line ].words, script[ line ++ ].to );
	readRecord();
	if ( pending.length ) await answerDue();
	if ( failures >= MAX_FAILURES ) {

		ok = false;
		console.error( `play-game: the brain failed ${ failures } times in a row at ${ when( sim.state.tick ) }: the run stops` );
		break;

	}
	if ( options.grow && sim.growthDue() ) {

		sim.addPiece( inputAt( sim.state.pieces + 1 ) );
		growth.push( { tick: sim.state.tick, at: when( sim.state.tick ), pieces: sim.state.pieces, population: sim.population() } );
		push( sim.state.tick, `${ clockOf( sim.state.tick ) } [island] the island grew by a piece: ${ sim.state.pieces } now, for ${ sim.population() } islanders` );

	}
	if ( sim.state.tick >= end ) break;
	sim.step( 1 );
	const tick = sim.state.tick;
	record.observe( sim, SKY, 0 );
	meet();
	for ( ; gone < sim.state.dead.length; gone ++ ) {

		const id = sim.state.dead[ gone ].id;
		close( id, 'died', tick );
		flush( id );

	}
	for ( const v of sim.state.villagers ) {

		settle( v );
		const kind = activity( v );
		for ( const s of statsOf( v.id, dayAt( tick ) ) ) {

			s.ticks[ kind ] = ( s.ticks[ kind ] ?? 0 ) + 1;
			for ( const [ need, value ] of Object.entries( v.needs ) ) {

				const n = s.needs[ need ] ??= { min: Infinity, max: - Infinity, sum: 0 };
				n.min = Math.min( n.min, value );
				n.max = Math.max( n.max, value );
				n.sum += value;

			}
			s.samples ++;

		}

	}
	readRecord();
	if ( tick % HOUR === 0 ) sample();
	if ( dayAt( tick ) !== lastDay ) {

		console.log( `day ${ lastDay } played` );
		lastDay = dayAt( tick );

	}

}
// what is under way at the end runs to the end
for ( const [ id, s ] of [ ...spells ] ) {

	if ( s.open ) s.end = sim.state.tick;
	flush( id );

}
readRecord();

// ------------------------------------------------------------------ outputs

const out = path.resolve( options.out ?? path.join( ROOT, 'artifacts', 'play', new Date().toISOString().replace( /[-:]/g, '' ).replace( /\..*/, '' ) ) );
mkdirSync( out, { recursive: true } );

const share = ( s ) => {

	const all = Object.values( s.ticks ).reduce( ( a, b ) => a + b, 0 ) || 1;
	return Object.fromEntries( Object.entries( s.ticks ).sort( ( a, b ) => b[ 1 ] - a[ 1 ] || ( a[ 0 ] < b[ 0 ] ? - 1 : 1 ) ).map( ( [ k, n ] ) => [ k, round( n / all, 3 ) ] ) );

};
const shareText = ( s ) => Object.entries( share( s ) ).filter( ( [ , x ] ) => x >= 0.01 ).map( ( [ k, x ] ) => `${ k } ${ Math.round( x * 100 ) } %` ).join( ', ' );
// each need's lowest, mean and highest; each item's flows by call, gains first
const needsOf = ( s ) => Object.fromEntries( Object.entries( s.needs ).map( ( [ k, n ] ) => [ k, { min: round( n.min, 1 ), mean: round( n.sum / s.samples, 1 ), max: round( n.max, 1 ) } ] ) );
const needsText = ( s, mean = false ) => Object.entries( s.needs ).map( ( [ k, n ] ) => `${ k } ${ Math.round( n.min ) }–${ Math.round( n.max ) }${ mean ? ` (mean ${ Math.round( n.sum / s.samples ) })` : '' }` ).join( ', ' );
const flowsText = ( s ) => Object.entries( s.items ).map( ( [ item, flows ] ) => `${ item } ${ Object.entries( flows ).sort( ( a, b ) => b[ 1 ] - a[ 1 ] ).map( ( [ f, n ] ) => `${ n > 0 ? '+' : '' }${ n } ${ f }` ).join( ', ' ) }` ).join( '; ' ) || 'no items';
const entryAt = ( kind, subject ) => {

	const e = record.entries.find( ( r ) => r.kind === kind && r.subject === subject );
	return e ? `d${ e.day } ${ String( Math.floor( e.minute / 60 ) ).padStart( 2, '0' ) }:${ String( e.minute % 60 ).padStart( 2, '0' ) }` : null;

};
const kinds = {};
for ( const e of record.entries ) kinds[ e.kind ] = ( kinds[ e.kind ] ?? 0 ) + 1;
const islanders = [ ...people.values() ].map( ( p ) => {

	const s = totals.get( p.id ) ?? blank(), v = sim.villager( p.id ), dead = sim.state.dead.find( ( d ) => d.id === p.id );
	return {
		id: p.id, name: p.name, sex: p.sex, ageAtStart: p.age, alive: Boolean( v ),
		died: dead ? when( dead.died ) : null,
		time: share( s ),
		needs: needsOf( s ),
		items: s.items,
		bag: v ? { ...v.bag } : null,
		thoughts: s.thoughts, refused: s.refused,
	};

} );
const buildings = sim.state.buildings.map( ( b ) => ( { id: b.id, kind: b.kind, x: round( b.x, 2 ), z: round( b.z, 2 ), placed: entryAt( 'placed', b.id ), built: entryAt( 'built', b.id ), progress: round( Math.min( 1, b.worked / BUILDING_KINDS[ b.kind ].work ), 3 ), items: { ...b.items } } ) );
const summary = {
	options: context.options,
	end: when( sim.state.tick ),
	completed: ok,
	population: sim.population(),
	pieces: sim.state.pieces,
	islanders,
	deaths: sim.state.dead.map( ( d ) => ( { id: d.id, name: d.name, at: when( d.died ), age: Math.floor( ( d.died - d.born ) / SECONDS_PER_GAME_DAY ) } ) ),
	buildings,
	stock: stockOf( sim.state ),
	growth,
	thoughts: { asked, answered, failed, inFlight: pending.length },
	record: kinds,
};
writeFileSync( path.join( out, 'summary.json' ), JSON.stringify( summary, null, '\t' ) + '\n' );
writeFileSync( path.join( out, 'timeline.json' ), JSON.stringify( { start: { seed: options.seed, hour: options.hour, pieces: options.pieces }, hours: timeline } ) + '\n' );
writeFileSync( path.join( out, 'record.json' ), JSON.stringify( record.save(), null, '\t' ) + '\n' );
if ( options.thoughts ) writeFileSync( path.join( out, 'thoughts.jsonl' ), thoughts.map( ( t ) => JSON.stringify( t ) + '\n' ).join( '' ) );

// the transcript, day by day
const command = [ 'node tools/play-game.mjs', `--days ${ options.days }`, `--seed ${ options.seed }`, `--hour ${ options.hour }`, `--pieces ${ options.pieces }`,
	options.grow ? '--grow' : '', options.population ? `--population ${ options.population }` : '', ...options.place.map( ( p ) => `--place ${ p.text }` ),
	options.script ? `--script ${ options.script }` : '', `--brain ${ options.brain }`, `--latency ${ options.latency }` ].filter( Boolean ).join( ' ' );
const md = [
	`# Play: ${ options.days } game day${ options.days === 1 ? '' : 's' }, seed ${ options.seed }, ${ options.brain === 'standin' ? 'the stand-in brain' : `brain ${ options.brain }` }`,
	'',
	`\`${ command }\``,
	'',
	`Islanders: ${ [ ...people.values() ].map( ( p ) => `${ label( p.id ) } (${ p.id }, ${ p.sex === 'male' ? 'man' : 'woman' }, ${ p.age })` ).join( ', ' ) }.`,
	'',
	'Lines: `[record]` the record\'s entries (沧海录); `[needs]` every six game hours, each need and the bag; the other lines are the islanders\' actions from start to end, consecutive alike ones merged (×n) with their outcomes, their words (`says`) and, for an asynchronous brain, its thoughts from asked to answered.',
];
lines.sort( ( a, b ) => a.tick - b.tick || a.seq - b.seq );
const lastShown = Math.max( dayAt( Math.max( sim.state.tick - 1, 0 ) ), lines.length ? dayAt( lines.at( - 1 ).tick ) : 0 );
const dayRow = ( id, s ) => `| ${ label( id ) } | ${ needsText( s ) } | ${ flowsText( s ) } | ${ shareText( s ) } |`;
let at = 0;
for ( let day = dayAt( 0 ); day <= lastShown; day ++ ) {

	md.push( '', `## Day ${ day }`, '' );
	for ( ; at < lines.length && dayAt( lines[ at ].tick ) <= day; at ++ ) md.push( `- ${ lines[ at ].text }` );
	const today = days.get( day );
	if ( ! today ) continue;
	md.push( '', '| islander | needs, lowest–highest | items, by the call that moved them | time |', '|---|---|---|---|' );
	for ( const id of people.keys() ) if ( today.has( id ) ) md.push( dayRow( id, today.get( id ) ) );

}
md.push( '', '## At the end', '', `${ when( sim.state.tick ) }: ${ sim.population() } islanders, ${ sim.state.pieces } pieces. Stock: ${ JSON.stringify( summary.stock ) }.` );
for ( const b of buildings ) md.push( `- ${ b.id }: placed ${ b.placed ?? 'before the record' }, ${ b.built ? `built ${ b.built }` : `${ Math.round( b.progress * 100 ) } % built` }, holds ${ JSON.stringify( b.items ) }` );
writeFileSync( path.join( out, 'transcript.md' ), md.join( '\n' ) + '\n' );

// ------------------------------------------------------------------ stdout

const rel = path.relative( process.cwd(), out ).startsWith( '..' ) ? out : path.relative( process.cwd(), out ) || '.';
console.log( `play-game: ${ summary.end }, ${ sim.population() } islanders, ${ sim.state.pieces } pieces, ${ ( ( performance.now() - realStart ) / 1000 ).toFixed( 1 ) } s -> ${ rel }/` );
for ( const p of islanders ) {

	const s = totals.get( p.id ) ?? blank();
	console.log( `  ${ label( p.id ) } ${ p.id }${ p.alive ? '' : ` (died ${ p.died })` }: ${ shareText( s ) }; ${ needsText( s, true ) }; ${ flowsText( s ) }` );

}
console.log( `  deaths: ${ summary.deaths.length ? summary.deaths.map( ( d ) => `${ d.name } ${ d.at }` ).join( ', ' ) : 'none' }; stock ${ JSON.stringify( summary.stock ) }; buildings: ${ buildings.length ? buildings.map( ( b ) => `${ b.id } ${ b.built ? `built ${ b.built }` : `${ Math.round( b.progress * 100 ) } %` }` ).join( ', ' ) : 'none' }${ growth.length ? `; grew ${ growth.length } piece(s)` : '' }${ asked && pending.length + answered + failed ? `; thoughts answered ${ answered }, failed ${ failed }` : '' }` );
process.exit( ok ? 0 : 1 );
