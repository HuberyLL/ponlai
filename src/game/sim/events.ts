import type { ActionCall, ActionResult, EntityId, Items, Needs, Outcome } from './types.ts';

// What happened, said once: the rule that makes a change others show or keep emits it as an event,
// at the tick it happened (Sim.emit), and nothing else writes it down. The session takes the events
// in the order they came (Sim.take) and hands each to its listeners (../Session.ts `listen`): the
// record (../Chronicle.ts), the interface's speech (../ui/People.ts) and the play tool
// (tools/play-game.mjs) read this one stream, never the state, for what happened (they may still
// sample the state for what is, as the needs' bars do). So a second line said within a frame is a
// second event, and every event carries its own tick, not the time someone looked.
//
// An event holds what it is about by value (ids, words, counts), so it reads the same once the
// state has moved on (the one who said it died, the chest was emptied). Events are not saved: the
// session hands them on before it saves (Session.save), so a loaded game starts with none, and a
// game's events are a function of its state's path like the state itself.
//
// Every call of an action ends in one outcome of a few, the categories the interface can show
// whatever the action (types.ts Outcome):
//
// - done: it did what it set out to (its result is ok: arrived, caught nothing, built, gave);
// - failed: it ran and could not (no way any more, a full bag at the catch);
// - interrupted: something it needs stopped holding while it was under way (its place gone, the
//   islander no longer at it, the one followed dead, the islander dead), checked every tick in one
//   place (actions.ts `holds`);
// - refused: it never began, and changed nothing: arguments the tool does not take (the entrance,
//   agent.ts `act`, schema.ts), a rule's no (nothing here offers that), an islander no longer on
//   the island (a late answer);
// - replaced: the islander began another action instead. Only here: the next thought perceives the
//   new action's outcome (Villager.last), not this one. The new one replaces it once it has begun
//   (a refused call replaces nothing), so an instant one's own events (a `gave`) come before this,
//   at the same tick.
//
// Speech is the mind's (actions.ts `say`): a `say` said is its `said` event alone, with no outcome
// event; one refused (blank words, a late answer) is a refused outcome like any call's.

export type SimEvent =
	/** an islander came to the island (Sim.addIslander: a new game's at its start) */
	| { kind: 'landed'; tick: number; who: EntityId }
	/** an islander died, at an age in whole years */
	| { kind: 'died'; tick: number; who: EntityId; age: number }
	/** words said: an islander's `say` (heard within earshot, people.ts), or the player's to some
	 * islanders or to everyone (Session.speak) */
	| { kind: 'said'; tick: number; who: EntityId | 'player'; words: string; to?: EntityId[] | 'all' }
	/** a hand-over (people.ts `give`) */
	| { kind: 'gave'; tick: number; who: EntityId; to: EntityId; item: string; count: number }
	/** the player placed a building's blueprint (Sim.placeBlueprint) */
	| { kind: 'placed'; tick: number; building: string; of: string }
	/** a building's work is done (buildings.ts `build`) */
	| { kind: 'built'; tick: number; building: string; of: string }
	/** a need fell to CRITICAL_NEED (needs.ts) */
	| { kind: 'need'; tick: number; who: EntityId; need: keyof Needs }
	/** the island grew by a piece (Sim.addPiece): the pieces now, for the population then */
	| { kind: 'grew'; tick: number; pieces: number; population: number }
	/** an action with duration began (an instant one has only its outcome) */
	| { kind: 'began'; tick: number; who: EntityId; call: ActionCall }
	/** a call ended: how (the header), its result, and what it moved between bags, by islander (an
	 * instant action's, or a timed one's at its finish; absent when nothing moved) */
	| { kind: 'outcome'; tick: number; who: EntityId; call: ActionCall; outcome: Outcome; result: ActionResult; moved?: Record<EntityId, Items> };

/** An event's kind. */
export type SimEventKind = SimEvent[ 'kind' ];
