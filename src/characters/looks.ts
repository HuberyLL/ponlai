import { KIND } from './CharacterMaterial.ts';
import type { PartSpec } from './Villagers.ts';

// The islanders' dress: modular parts (Ultimate Modular Characters by Quaternius, CC0) repainted
// in the island's palette (sRGB, as they should read in sunlight). The models are local,
// unversioned assets (artifacts/ is git-ignored) served by the dev server while the character
// art is still changing.

export const umc = ( name: string ) => `/artifacts/assets/quaternius/ultimate-modular-characters/${ name }.gltf`;

/** A look's colours: its parts are painted in them, and a stand-in figure wears them when the parts are missing. */
export interface LookColours { skin: string; hair: string; brows: string; shirt: string; trousers: string; shoes: string; soles: string }

/** A rig file (its skeleton and animation clips) and the parts dressed on it. */
export interface Look { base: string; parts: PartSpec[]; colours: LookColours }

// A plain islander while the basic look settles: bare head (so the pointed ears read), a linen
// shirt, plain trousers and leather shoes. The kit's pockets, trims and two-tone panels are
// painted over in one colour.
function islander( c: LookColours ): Look {

	return { base: umc( 'Farmer' ), colours: c, parts: [
		{ from: umc( 'Casual_2' ), part: 'Casual2_Head', paint: { Skin: [ c.skin, KIND.skin ], Skin_Darker: [ c.skin, KIND.skin ], Eyebrows: [ c.brows, KIND.hair ], Hair: [ c.hair, KIND.hair ], Eye: [ '#2a1d18', KIND.cloth ] } },
		{ from: umc( 'Adventurer' ), part: 'Adventurer_Body', paint: { Skin: [ c.skin, KIND.skin ], Green: [ c.shirt, KIND.cloth ], LightGreen: [ c.shirt, KIND.cloth ] }, hands: [ c.skin, KIND.skin ] },
		{ from: umc( 'Adventurer' ), part: 'Adventurer_Legs', paint: { Brown: [ c.trousers, KIND.cloth ], Brown2: [ c.trousers, KIND.cloth ] } },
		{ from: umc( 'Farmer' ), part: 'Farmer_Feet', paint: { Brown: [ c.shoes, KIND.leather ], Brown2: [ c.soles, KIND.leather ] } },
	] };

}

/** The scene's islander: an undyed linen shirt, muted warm brown trousers, dark leather shoes. */
export const ISLANDER = islander( { skin: '#e2a882', hair: '#5a3a26', brows: '#4a2f22', shirt: '#dccfae', trousers: '#634a36', shoes: '#4a3626', soles: '#2e241c' } );

/**
 * The game's islanders by look index (Villager.look): the scene's islander first, then the same
 * dress in other calm, earthy shades (oatmeal and flax linen, olive, slate and umber trousers)
 * with their own hair and skin, so they tell apart from the god view.
 */
export const ISLANDER_LOOKS: readonly Look[] = [
	ISLANDER,
	islander( { skin: '#c98e6a', hair: '#33261d', brows: '#2b1f18', shirt: '#cfbb94', trousers: '#5a5236', shoes: '#3f3024', soles: '#2a211a' } ),
	islander( { skin: '#e8b590', hair: '#7a4a2c', brows: '#5e3a24', shirt: '#e4dac2', trousers: '#4f4a40', shoes: '#4d3a2a', soles: '#2e241c' } ),
	islander( { skin: '#d49a74', hair: '#8a6440', brows: '#6a4a30', shirt: '#cdb58c', trousers: '#4a3528', shoes: '#3a2c22', soles: '#271f19' } ),
];
