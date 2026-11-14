import { KIND } from './CharacterMaterial.ts';
import type { ProportionName } from './Proportions.ts';
import type { PartSpec } from './Villagers.ts';

// The islanders' dress: modular parts repainted in the island's palette.
//
// The islanders' dress: modular parts (Ultimate Modular Characters by Quaternius, CC0) repainted
// in the island's palette (sRGB, as they should read in sunlight). The models are assets in public/
// (tools/repo/assets.mjs).

export const umc = ( name: string ) => `${ import.meta.env.BASE_URL }characters/quaternius/ultimate-modular-characters/${ name }.gltf`;

/** A look's colours: its parts are painted in them, and a stand-in figure wears them when the parts are missing. */
export interface LookColours { skin: string; hair: string; brows: string; shirt: string; trousers: string; shoes: string; soles: string }

/** A rig file (its skeleton and animation clips) and the parts dressed on it; `lit` figures take the
 * island's own light (FigureSurfaces.ts) instead of the kit figures' cel steps, `build` their
 * proportions unless the `islander` URL option names others; `ages`: its file holds the shape keys
 * of sex and age, so its figures take a body (FigureAge.ts), the build that of its adult man. */
export interface Look { base: string; parts: PartSpec[]; colours: LookColours; lit?: boolean; build?: ProportionName; ages?: boolean }

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

// The Hanming islanders: the people of 含明, west of Penglai, who "stitch birds' feathers into
// clothes, drink the dew and climb high all day for water" (拾遗记 卷十). A woven bamboo hat over
// the head, white feathers stitched into a short-sleeved top worn open over the bare chest and
// belly and into shorts to mid-thigh, bare arms and legs, straw sandals: little cloth, as on an
// island short of everything. No hair and no worked face, the brim's shade over it. Built in
// Blender on the kit's Farmer rig (its clips), with the Casual 2 head and the Beach outfit's bare
// body (its vest painted as skin), legs and sandalled feet; the top and shorts are a shell under
// rows of feather cards cut from a photograph, laid as a feather cloak's feathers are tied to its
// backing. Drawn in the island's light at about 6.5 heads (Proportions.ts `real`). A woman's top
// is closed in front and a little longer; the body is in two parts, so that she does not draw the
// trunk her top covers (where the body, skinned unlike the top, would show through it as the old
// stoop) and a man draws the chest and belly his open top shows. Children and the old wear their
// sex's dress, the hat made smaller for a child (FigureAge.ts).
export const hanming = ( name: string ) => `${ import.meta.env.BASE_URL }characters/hanming/${ name }.gltf`;

/** `shirt` and `trousers` are the feathers' white and `hair` the hat's straw (for stand-ins),
 * `shoes` the sandals. */
function hanmingLook( c: LookColours, hat: 'Dou' | 'Ruo' ): Look {

	const from = hanming( 'Hanming' );
	return { base: from, colours: c, lit: true, build: 'real', ages: true, parts: [
		{ from, part: 'Hanming_Head', paint: { Skin: [ c.skin, KIND.skin ], Brows: [ c.brows, KIND.hair ], Eye: [ '#2a1d18', KIND.cloth ] } },
		{ from, part: 'Hanming_Body', paint: { Skin: [ c.skin, KIND.skin ] } },
		{ from, part: 'Hanming_Chest', paint: { Skin: [ c.skin, KIND.skin ] }, sex: 'male' },
		{ from, part: 'Hanming_Legs', paint: { Skin: [ c.skin, KIND.skin ] } },
		{ from, part: 'Hanming_Feet', paint: { Skin: [ c.skin, KIND.skin ], Shoes: [ c.shoes, KIND.leather ] } },
		{ from, part: 'Hanming_Robe', paint: { Robe: [ c.shirt, KIND.cloth ] }, sex: 'male' },
		{ from, part: 'Hanming_Feathers', paint: {}, surface: 'feather', sex: 'male' },
		{ from, part: 'Hanming_RobeF', paint: { Robe: [ c.shirt, KIND.cloth ] }, sex: 'female' },
		{ from, part: 'Hanming_FeathersF', paint: {}, surface: 'feather', sex: 'female' },
		{ from, part: `Hanming_Hat${ hat }`, paint: {}, surface: 'weave' },
	] };

}

const hanmingColours = ( skin: string, brows: string ): LookColours => ( { skin, hair: '#c4a165', brows, shirt: '#d8d4cb', trousers: '#d8d4cb', shoes: '#8a6a45', soles: '#5a4632' } );

/** The scene's islander: the pointed bamboo hat (斗笠). */
export const HANMING = hanmingLook( hanmingColours( '#c99a78', '#3a2a20' ), 'Dou' );

/** The game's islanders: the pointed hat and the flat crowned one (箬笠), skins apart. */
export const HANMING_LOOKS: readonly Look[] = [
	HANMING,
	hanmingLook( hanmingColours( '#b9845f', '#2b1f18' ), 'Ruo' ),
	hanmingLook( hanmingColours( '#d6a986', '#4a3426' ), 'Dou' ),
	hanmingLook( hanmingColours( '#c48f6c', '#33261d' ), 'Ruo' ),
];
