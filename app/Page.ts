// The page's own parts: what the GUI, camera views, frame, scene jump and diagnostics share.
//
// The page's own parts: what the island page's modules (the GUI, the camera views, its part of the
// frame, of the scene jump and of the diagnostics) build and share, on one object the entry
// (main.ts) creates beside the renderer's (RenderStages.ts) and the island's (IslandStages.ts). The
// frame, the scene jump and the handles themselves are the renderer's assembly's
// (render/index.ts `startScene`).
import type GUI from 'lil-gui';
import type { WeatherName, WindLevel, FrameStats, PipelineSettings, SceneFrame, Shared } from '../packages/render/index.ts';
import type { QualityTier } from '../packages/render/setup.ts';
import type { QualityDetector } from './QualityDetect.ts';
import type { Game } from '../packages/game/index.ts';
import type { IslandFraming } from '../packages/island/index.ts';
import type { CameraView } from './CameraViews.ts';
import type { QualityChoice, QualityLines } from './QualityDetect.ts';

export interface PageParts {
	ground: { soil: boolean };
	qualityChoice: QualityChoice;
	/** the scene's uniforms (render/index.ts `startScene` makes them from the page's look) */
	shared: Shared;
	reloadWithQuality: ( tier: QualityTier | null ) => void;
	GAME: boolean;
	game: Game | null;
	gui: GUI;
	S: PipelineSettings;
	cameraSettings: { mode: string };
	reviewView: { camera: CameraView };
	fovWidening: { on: boolean };
	applyOrbitLimit: () => void;
	unwidenFov: () => void;
	setCameraMode: ( mode: string ) => void;
	setCameraView: ( view: CameraView ) => void;
	framing: IslandFraming;
	environmentLook: { exposure: boolean };
	autoQuality: QualityLines;
	frameStats: FrameStats;
	/** the GUI's switches for the rain and the wet surfaces, which the frame reads */
	weatherEffects: { rain: boolean; wetness: boolean };
	weatherView: { preset: WeatherName; seconds: number };
	windView: { level: WindLevel; heading: number };
	shownWind: string;
	timeView: { preset: string };
	islanderF: GUI;
	hazeF: GUI;
	H: { near: number; far: number; growth: number; fogExtinction: number; albedo: number; anisotropy: number; gain: number; ambientFloor: number; ambientSoftness: number; blend: number; restFrames: number; jitter: boolean; tricubic: boolean; densityAA: boolean; sky: boolean; debug: number };
	/** sizes the canvas and the render to the window (the frame's sizing) */
	resize: () => void;
	/** the frame (render/index.ts `startScene`), from its setup on */
	frame: SceneFrame;
	/** a load that measures the GPU for its tier (QualityDetect.ts), or null */
	detector: QualityDetector | null;
}
