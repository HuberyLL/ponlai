import { lookup } from '../i18n/i18n.ts';
import { PALETTE } from '../Palette.ts';

// How the interface shows the body's needs: each need's icon and colour by its id.
//
// How the interface shows the body's needs (docs/design/ui.md, Islanders): each need's icon and colour,
// by the simulation's need id (sim/registry.ts NeedDef), for the tag's bars, the alerts over the
// head and the record's mark. A need without a look of its own here shows with the default, the
// 未绘 glyph (Icons.ts) in 缟, until art gives it one; its name is the catalogue's (i18n/zh-CN.json
// `need`, by id), else its id.

export interface NeedLook {
	/** its icon (IconArt.ts); null: not drawn yet */
	icon: string | null;
	/** its bar's colour (Palette.ts) */
	colour: string;
}

const LOOKS: Readonly<Record<string, NeedLook>> = {
	satiety: { icon: 'satiety', colour: PALETTE.hupo },
	hydration: { icon: 'drop', colour: PALETTE.tianshuibi },
};

const DEFAULT: NeedLook = { icon: null, colour: PALETTE.gao };

export const needLook = ( need: string ): NeedLook => ( Object.hasOwn( LOOKS, need ) ? LOOKS[ need ] : DEFAULT );
export const needName = ( need: string ): string => lookup( `need.${ need }`, need );
