import type { QualityProfile } from './Quality.ts';

// What every registered definition declares. The renderer is extended at named points, each a
// registry its owner reads in the order registered and never by name: a kind of plant
// (vegetation/Registry.ts), a kind of local light (lighting/LocalLights.ts), a pass of the
// frame (post/ExtraPass.ts). A definition at any of them states three things, which a new effect
// forgot more than once and which showed only later (a capture that did not repeat, a frame time
// that crept, a grown page that differed from a fresh load): what governs its cost, how it stands
// in the test mode, and how it follows the land's growth. They are required fields, so leaving one
// out is a type error, and a registry refuses a definition without them (`checkDeclarations`: a
// definition from plain JavaScript, or one cast past the types).
//
// The declarations are statements, not hooks: the registries do not act on them. They say where
// to look (the knob to turn in a cost test, the switch the test mode holds the effect by, the
// follower that carries it through a growth); tools/render/verify-extensions.mjs registers definitions of
// its own at every point and checks that one without them is refused.
//
// This module imports types only, so the CPU-only tools can load it under plain node.

/** The quality knob that governs a definition's cost: a field of the quality table (Quality.ts,
 * which is closed: a new knob is a new field there), or 'none' when no tier changes it. */
export type CostKnob = keyof QualityProfile | 'none';

/** How a definition stands in the test mode (debug/TestMode.ts: a paused page whose frame repeats
 * exactly): 'stateless' when what it draws is a function of the scene alone, with no history;
 * otherwise whether the test mode freezes it or turns it off, by what (`by`: the switch or the
 * site), and when it is settled (`settled`: what the page's settled signal waits for, or that it
 * waits for nothing). */
export type TestModeStand = 'stateless' | { held: 'frozen' | 'off'; by: string; settled: string };

/** How a definition follows the land's growth: 'independent' when it does not depend on the land,
 * otherwise the follower that carries it through a growth (`follower`: what prepares its next
 * version and swaps it in, in the swap's frame). */
export type LandStand = 'independent' | { follower: string };

/** The three declarations of a registered definition. */
export interface Declarations {
	cost: CostKnob;
	testMode: TestModeStand;
	land: LandStand;
}

const text = ( value: unknown ): value is string => typeof value === 'string' && value !== '';

/** Refuses a definition that lacks one of the three declarations: throws, naming the registry
 * (`point`), the definition and what is missing. */
export function checkDeclarations( point: string, name: string, definition: Partial<Declarations> ): void {

	const missing: string[] = [];
	if ( ! text( definition.cost ) ) missing.push( 'cost (a quality knob, or \'none\')' );
	const t = definition.testMode;
	if ( t !== 'stateless' && ! ( typeof t === 'object' && t !== null && ( t.held === 'frozen' || t.held === 'off' ) && text( t.by ) && text( t.settled ) ) ) missing.push( 'testMode (\'stateless\', or { held, by, settled })' );
	const l = definition.land;
	if ( l !== 'independent' && ! ( typeof l === 'object' && l !== null && text( l.follower ) ) ) missing.push( 'land (\'independent\', or { follower })' );
	if ( missing.length ) throw new Error( `${ point }: '${ name }' is refused, it does not declare its ${ missing.join( ', its ' ) }` );

}
