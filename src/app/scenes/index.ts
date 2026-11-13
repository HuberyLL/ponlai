// The test scenes by name: the `scene` option's values (Settings.ts) and what the scene page
// builds (ScenePage.ts). A new scene is a module beside this one, added here and to the option.
import type { TestScene } from './TestScene.ts';
import { ball } from './ball.ts';
import { empty } from './empty.ts';
import { plants } from './plants.ts';
import { sea } from './sea.ts';

export const SCENES: Readonly<Record<string, TestScene>> = { ball, empty, sea, plants };
